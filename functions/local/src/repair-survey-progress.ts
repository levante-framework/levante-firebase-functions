import * as fs from "fs";
import * as path from "path";
import {
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from "firebase-admin/firestore";
import yargs from "yargs";
import Papa from "papaparse";
import { initAdmin } from "./utils/init-admin.js";

type SurveyProgressStatus = "assigned" | "started" | "completed";

const REQUIRED_CSV_COLUMNS = [
  "siteId",
  "siteName",
  "uid",
  "administrationId",
  "taskId",
  "surveyResponsesStatus",
  "assessmentStatus",
  "progressStatus",
  "isCorrupted",
] as const;

interface RepairCsvRow {
  siteId: string;
  siteName: string;
  uid: string;
  administrationId: string;
  taskId: string;
  surveyResponsesStatus: SurveyProgressStatus;
  assessmentStatus: SurveyProgressStatus;
  progressStatus: SurveyProgressStatus;
  isCorrupted: string;
}

type AssessmentRow = Record<string, unknown> & {
  taskId?: string;
  startedOn?: unknown;
  completedOn?: unknown;
};

function parseCsv(inputFile: string): RepairCsvRow[] {
  const resolvedPath = path.resolve(process.cwd(), inputFile);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Input file not found: ${resolvedPath}`);
  }

  const content = fs.readFileSync(resolvedPath, "utf8");
  const parsed = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    throw new Error(
      `CSV parse error: ${parsed.errors.map((e) => e.message).join("; ")}`
    );
  }

  const headers = parsed.meta.fields ?? [];
  const expected = [...REQUIRED_CSV_COLUMNS];
  const missing = expected.filter((col) => !headers.includes(col));
  const extra = headers.filter(
    (col) => !expected.includes(col as (typeof expected)[number])
  );

  if (missing.length > 0 || extra.length > 0 || headers.length !== expected.length) {
    throw new Error(
      `Invalid CSV columns. Expected exactly: ${expected.join(", ")}. ` +
        `Got: ${headers.join(", ")}.` +
        (missing.length ? ` Missing: ${missing.join(", ")}.` : "") +
        (extra.length ? ` Unexpected: ${extra.join(", ")}.` : "")
    );
  }

  return parsed.data.map((raw) => ({
    siteId: (raw.siteId ?? "").trim(),
    siteName: (raw.siteName ?? "").trim(),
    uid: (raw.uid ?? "").trim(),
    administrationId: (raw.administrationId ?? "").trim(),
    taskId: (raw.taskId ?? "").trim(),
    surveyResponsesStatus: (raw.surveyResponsesStatus ?? "").trim() as SurveyProgressStatus,
    assessmentStatus: (raw.assessmentStatus ?? "").trim() as SurveyProgressStatus,
    progressStatus: (raw.progressStatus ?? "").trim() as SurveyProgressStatus,
    isCorrupted: (raw.isCorrupted ?? "").trim(),
  }));
}

function isValidStatus(value: string): value is SurveyProgressStatus {
  return value === "assigned" || value === "started" || value === "completed";
}

function toDate(value: unknown, label: string): Date {
  if (value instanceof Timestamp) {
    return value.toDate();
  }
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "object" && value && "toDate" in value) {
    const d = (value as { toDate: () => Date }).toDate();
    if (d instanceof Date && !Number.isNaN(d.getTime())) {
      return d;
    }
  }
  throw new Error(`Invalid ${label} on surveyResponses document`);
}

function taskIdToProgressKey(taskId: string): string {
  return taskId.replace(/-/g, "_");
}

function surveyResponseMatchesAdministration(
  data: Record<string, unknown>,
  administrationId: string,
  taskId?: string
): boolean {
  const matchesAdmin =
    data.administrationId === administrationId ||
    data.assignmentId === administrationId;
  if (!matchesAdmin) {
    return false;
  }
  if (taskId && typeof data.taskId === "string") {
    return data.taskId === taskId;
  }
  return true;
}

async function getSurveyResponse(
  db: Firestore,
  uid: string,
  administrationId: string,
  taskId: string
): Promise<DocumentSnapshot | null> {
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("surveyResponses")
    .get();

  const match = snap.docs.find((doc) =>
    surveyResponseMatchesAdministration(
      doc.data(),
      administrationId,
      taskId
    )
  );
  return match ?? null;
}

function applyAssessmentStatus(
  assessment: AssessmentRow,
  targetStatus: SurveyProgressStatus,
  surveySnap: DocumentSnapshot | null
): AssessmentRow {
  const next: AssessmentRow = { ...assessment };

// don't think this ever occurs; target status is only ever assigned or completed; but just in case.
  if (targetStatus === "assigned") {
    delete next.startedOn;
    delete next.completedOn;
    return next;
  }

  if (!surveySnap?.exists) {
    throw new Error(
      "surveyResponses document required when surveyResponsesStatus is started or completed"
    );
  }

  const surveyData = surveySnap.data() ?? {};
  const startedAt = surveyData.createdAt ?? surveyData.timeStarted;
  if (!startedAt) {
    throw new Error("surveyResponses createdAt/timeStarted is missing");
  }

  next.startedOn = toDate(startedAt, "createdAt/timeStarted");

  if (targetStatus === "completed") {
    const completedAt =
      surveyData.updatedAt ??
      surveyData.timeFinished ??
      startedAt;
    next.completedOn = toDate(completedAt, "updatedAt/timeFinished");
  } else {
    delete next.completedOn;
  }

  return next;
}

async function repairRow(
  db: Firestore,
  row: RepairCsvRow,
  dryRun: boolean
): Promise<{ status: "repaired" | "skipped" | "error"; message: string }> {
  if (!row.uid || !row.administrationId || !row.taskId) {
    return { status: "error", message: "missing uid, administrationId, or taskId" };
  }

  if (!isValidStatus(row.surveyResponsesStatus)) {
    return {
      status: "error",
      message: `invalid surveyResponsesStatus: ${row.surveyResponsesStatus}`,
    };
  }

  const assignmentRef = db
    .collection("users")
    .doc(row.uid)
    .collection("assignments")
    .doc(row.administrationId);

  const assignmentSnap = await assignmentRef.get();
  if (!assignmentSnap.exists) {
    return { status: "error", message: "assignment document not found" };
  }

  const assignmentData = assignmentSnap.data() ?? {};
  const assessments = Array.isArray(assignmentData.assessments)
    ? ([...assignmentData.assessments] as AssessmentRow[])
    : [];
  const assessmentIdx = assessments.findIndex((a) => a.taskId === row.taskId);
  if (assessmentIdx < 0) {
    return {
      status: "error",
      message: `assignment has no assessment row for taskId ${row.taskId}`,
    };
  }

  const targetStatus = row.surveyResponsesStatus;
  const needsAssessment = row.assessmentStatus !== targetStatus;
  const needsProgress = row.progressStatus !== targetStatus;

  if (!needsAssessment && !needsProgress) {
    return {
      status: "skipped",
      message: "assessmentStatus and progressStatus already match surveyResponsesStatus",
    };
  }

  const updates: Record<string, unknown> = {};
  const changedParts: string[] = [];

  if (needsAssessment) {
    const surveySnap = await getSurveyResponse(
      db,
      row.uid,
      row.administrationId,
      row.taskId
    );
    assessments[assessmentIdx] = applyAssessmentStatus(
      assessments[assessmentIdx],
      targetStatus,
      surveySnap
    );
    updates.assessments = assessments;
    changedParts.push("assessment");
  }

  if (needsProgress) {
    const progressKey = taskIdToProgressKey(row.taskId);
    updates.progress = {
      ...((assignmentData.progress ?? {}) as Record<string, unknown>),
      [progressKey]: targetStatus,
    };
    changedParts.push(`progress.${progressKey}`);
  }

  if (dryRun) {
    return {
      status: "repaired",
      message: `dry-run: would update ${changedParts.join(", ")} to ${targetStatus}`,
    };
  }

  await assignmentRef.update(updates);

  return {
    status: "repaired",
    message: `updated ${changedParts.join(", ")} to ${targetStatus}`,
  };
}

interface CliArgs {
  environment: "dev" | "prod";
  envFile: string;
  inputFile: string;
  dryRun: boolean;
  testSize?: number;
}

const argv = yargs(process.argv.slice(2))
  .scriptName("repair-survey-progress")
  .usage(
    "$0 [options]\n\nReads corrupted-survey-progress CSV from identify-corrupted-survey-progress," +
      " and aligns assignment assessments + progress to surveyResponsesStatus."
  )
  .options({
    environment: {
      alias: ["e", "env"],
      choices: ["dev", "prod"] as const,
      default: "dev" as const,
    },
    envFile: {
      alias: ["f", "env-file"],
      type: "string",
      default: ".env.local",
    },
    inputFile: {
      alias: "i",
      description: "CSV from identify-corrupted-survey-progress",
      type: "string",
      demandOption: true,
    },
    dryRun: {
      alias: "d",
      description: "Log changes without writing to Firestore",
      type: "boolean",
      default: true,
    },
    testSize: {
      alias: "t",
      description: "Max corrupted rows to process",
      type: "number",
    },
  })
  .help("help")
  .alias("help", "h")
  .strict().argv as CliArgs;

async function main(): Promise<void> {
  console.log(`repair-survey-progress (${argv.environment})`);
  console.log(`Input: ${argv.inputFile}`);
  console.log(`Dry run: ${argv.dryRun}`);

  const allRows = parseCsv(argv.inputFile);
  let corruptedRows = allRows.filter(
    (row) => row.isCorrupted.toLowerCase() === "true"
  );

  if (argv.testSize) {
    corruptedRows = corruptedRows.slice(0, argv.testSize);
  }

  console.log(`CSV rows: ${allRows.length}, corrupted to repair: ${corruptedRows.length}`);

  if (corruptedRows.length === 0) {
    console.log("No corrupted rows to repair.");
    return;
  }

  const { db } = await initAdmin({
    environment: argv.environment,
    envFile: argv.envFile,
    appName: "repair-survey-progress",
  });

  let repaired = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < corruptedRows.length; i += 1) {
    const row = corruptedRows[i];
    const result = await repairRow(db, row, argv.dryRun);

    if (result.status === "repaired") {
      repaired += 1;
    } else if (result.status === "skipped") {
      skipped += 1;
    } else {
      errors += 1;
      console.error(
        `[${i + 1}/${corruptedRows.length}] ${row.uid} ${row.administrationId} ${row.taskId}: ${result.message}`
      );
    }

    if ((i + 1) % 50 === 0 || i === corruptedRows.length - 1) {
      console.log(`[${i + 1}/${corruptedRows.length}] processed...`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("REPAIR SUMMARY");
  console.log("=".repeat(60));
  console.log(`Corrupted rows processed : ${corruptedRows.length}`);
  console.log(`Repaired                 : ${repaired}`);
  console.log(`Skipped (already ok)   : ${skipped}`);
  console.log(`Errors                   : ${errors}`);
  if (argv.dryRun) {
    console.log("Dry run enabled — no Firestore writes were made.");
    console.log("Re-run with --dryRun=false to apply changes.");
  }
  console.log("=".repeat(60));
}

main().catch((err) => {
  console.error("Fatal script error:", err);
  process.exit(1);
});
