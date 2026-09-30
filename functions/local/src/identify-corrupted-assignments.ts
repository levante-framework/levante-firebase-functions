import * as fs from "fs";
import * as path from "path";
import type { Firestore } from "firebase-admin/firestore";
import yargs from "yargs";
import { initAdmin } from "./utils/init-admin.js";
import {
  expectedAssignmentCompleted,
  rebuildAssignmentProgress,
  recordsEqual,
  sortedProgressKeys,
  validateAssignmentAssessments,
} from "./utils/assignment-progress.js";

const CSV_COLUMNS = [
  "uid",
  "administrationId",
  "assignmentPath",
  "assessmentCount",
  "currentCompleted",
  "expectedCompleted",
  "missingProgressKeys",
  "staleProgressKeys",
  "progressMismatch",
  "completedMismatch",
  "prematureCompleted",
  "isCorrupted",
  "repairable",
  "reason",
  "currentProgressJson",
  "expectedProgressJson",
] as const;

type ReportRow = Record<
  (typeof CSV_COLUMNS)[number],
  string | number | boolean
>;

function toCsvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function rowToCsv(row: ReportRow): string {
  return CSV_COLUMNS.map((column) => toCsvCell(row[column])).join(",");
}

function asProgress(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function buildRow(doc: FirebaseFirestore.QueryDocumentSnapshot): ReportRow {
  const data = doc.data();
  const uid = doc.ref.parent.parent?.id ?? "";
  const administrationId =
    typeof data.id === "string" && data.id.length > 0 ? data.id : doc.id;
  const validation = validateAssignmentAssessments(data.assessments);
  const rawProgress = asProgress(data.progress);
  const currentProgress = rawProgress ?? {};
  const expectedProgress = rebuildAssignmentProgress(
    validation.assessments,
    currentProgress
  );
  const currentKeys = new Set(sortedProgressKeys(currentProgress));
  const expectedKeys = new Set(sortedProgressKeys(expectedProgress));
  const missingProgressKeys = [...expectedKeys]
    .filter((key) => !currentKeys.has(key))
    .sort();
  const staleProgressKeys = [...currentKeys]
    .filter((key) => !expectedKeys.has(key))
    .sort();
  const expectedCompleted = expectedAssignmentCompleted(validation.assessments);
  const currentCompleted = data.completed === true;
  const progressMismatch =
    rawProgress === null || !recordsEqual(currentProgress, expectedProgress);
  const completedMismatch = currentCompleted !== expectedCompleted;
  const isCorrupted =
    validation.repairable && (progressMismatch || completedMismatch);

  return {
    uid,
    administrationId,
    assignmentPath: doc.ref.path,
    assessmentCount: validation.assessments.length,
    currentCompleted,
    expectedCompleted,
    missingProgressKeys: missingProgressKeys.join(";"),
    staleProgressKeys: staleProgressKeys.join(";"),
    progressMismatch,
    completedMismatch,
    prematureCompleted: currentCompleted && !expectedCompleted,
    isCorrupted,
    repairable: validation.repairable,
    reason: validation.reason,
    currentProgressJson: JSON.stringify(currentProgress),
    expectedProgressJson: JSON.stringify(expectedProgress),
  };
}

async function scanAssignments(
  db: Firestore,
  administrationId?: string,
  testSize?: number
): Promise<ReportRow[]> {
  let query = db
    .collectionGroup("assignments")
    .select("id", "assessments", "progress", "completed");

  if (administrationId) {
    query = query.where("id", "==", administrationId);
  }
  if (testSize) {
    query = query.limit(testSize);
  }

  const snapshot = await query.get();
  return snapshot.docs.map(buildRow);
}

function writeCsv(rows: ReportRow[], outputFile: string): string {
  const outputPath = path.resolve(process.cwd(), outputFile);
  fs.writeFileSync(
    outputPath,
    [CSV_COLUMNS.join(","), ...rows.map(rowToCsv)].join("\n") + "\n",
    "utf8"
  );
  return outputPath;
}

interface CliArgs {
  environment: "dev" | "prod";
  envFile: string;
  administrationId?: string;
  outputFile: string;
  corruptedOnly: boolean;
  testSize?: number;
}

const argv = yargs(process.argv.slice(2))
  .scriptName("identify-corrupted-assignments")
  .usage(
    "$0 [options]\n\nScans every user assignment, including closed assignments," +
      " and reports progress/completed values that disagree with assessments."
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
    administrationId: {
      alias: "a",
      description: "Optionally restrict the scan to one administration",
      type: "string",
    },
    outputFile: {
      alias: "o",
      type: "string",
      default: "corrupted-assignments.csv",
    },
    corruptedOnly: {
      description: "Write only corrupted or manual-review rows to the report",
      type: "boolean",
      default: true,
    },
    testSize: {
      alias: "t",
      description: "Maximum assignment documents to scan",
      type: "number",
    },
  })
  .help("help")
  .alias("help", "h")
  .strict().argv as CliArgs;

async function main(): Promise<void> {
  console.log(`identify-corrupted-assignments (${argv.environment})`);
  console.log("Scope: all user assignments (open and closed)");
  if (argv.administrationId) {
    console.log(`Administration filter: ${argv.administrationId}`);
  }

  const { db } = await initAdmin({
    environment: argv.environment,
    envFile: argv.envFile,
    appName: "identify-corrupted-assignments",
  });

  const rows = await scanAssignments(
    db,
    argv.administrationId?.trim(),
    argv.testSize
  );
  const corrupted = rows.filter((row) => row.isCorrupted === true);
  const premature = rows.filter((row) => row.prematureCompleted === true);
  const manualReview = rows.filter((row) => row.repairable === false);
  const outputRows = argv.corruptedOnly
    ? rows.filter((row) => row.isCorrupted === true || row.repairable === false)
    : rows;
  const outputPath = writeCsv(outputRows, argv.outputFile);

  console.log("\n" + "=".repeat(60));
  console.log("CORRUPTED ASSIGNMENT REPORT");
  console.log("=".repeat(60));
  console.log(`Assignments scanned          : ${rows.length}`);
  console.log(`Corrupted assignments        : ${corrupted.length}`);
  console.log(`Prematurely completed        : ${premature.length}`);
  console.log(`Require manual review        : ${manualReview.length}`);
  console.log(`Rows written                 : ${outputRows.length}`);
  console.log(`Report                       : ${outputPath}`);
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Fatal script error:", error);
  process.exit(1);
});
