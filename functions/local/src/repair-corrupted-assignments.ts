import * as fs from "fs";
import * as path from "path";
import type { Firestore } from "firebase-admin/firestore";
import Papa from "papaparse";
import yargs from "yargs";
import { initAdmin } from "./utils/init-admin.js";
import {
  expectedAssignmentCompleted,
  rebuildAssignmentProgress,
  recordsEqual,
  validateAssignmentAssessments,
} from "./utils/assignment-progress.js";

const REQUIRED_COLUMNS = [
  "uid",
  "administrationId",
  "isCorrupted",
  "repairable",
] as const;

type InputRow = {
  uid: string;
  administrationId: string;
  isCorrupted: string;
  repairable: string;
};

type RepairResult = InputRow & {
  status: "repaired" | "skipped" | "error";
  message: string;
};

function parseBoolean(value: string): boolean {
  return value.trim().toLowerCase() === "true";
}

function parseInput(inputFile: string): InputRow[] {
  const inputPath = path.resolve(process.cwd(), inputFile);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input file not found: ${inputPath}`);
  }

  const parsed = Papa.parse<Record<string, string>>(
    fs.readFileSync(inputPath, "utf8"),
    { header: true, skipEmptyLines: true }
  );
  if (parsed.errors.length > 0) {
    throw new Error(
      `CSV parse error: ${parsed.errors
        .map((error) => error.message)
        .join("; ")}`
    );
  }

  const headers = parsed.meta.fields ?? [];
  const missing = REQUIRED_COLUMNS.filter(
    (column) => !headers.includes(column)
  );
  if (missing.length > 0) {
    throw new Error(`Missing required CSV columns: ${missing.join(", ")}`);
  }

  return parsed.data.map((row) => ({
    uid: (row.uid ?? "").trim(),
    administrationId: (row.administrationId ?? "").trim(),
    isCorrupted: (row.isCorrupted ?? "").trim(),
    repairable: (row.repairable ?? "").trim(),
  }));
}

function asProgress(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

async function repairAssignment(
  db: Firestore,
  row: InputRow,
  dryRun: boolean
): Promise<RepairResult> {
  const base = { ...row };
  if (!row.uid || !row.administrationId) {
    return {
      ...base,
      status: "error",
      message: "missing uid or administrationId",
    };
  }
  if (!parseBoolean(row.isCorrupted)) {
    return {
      ...base,
      status: "skipped",
      message: "report row is not marked corrupted",
    };
  }
  if (!parseBoolean(row.repairable)) {
    return {
      ...base,
      status: "error",
      message: "report row requires manual review",
    };
  }

  const assignmentRef = db
    .collection("users")
    .doc(row.uid)
    .collection("assignments")
    .doc(row.administrationId);

  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(assignmentRef);
    if (!snapshot.exists) {
      return {
        ...base,
        status: "error" as const,
        message: "assignment document not found",
      };
    }

    const data = snapshot.data() ?? {};
    const validation = validateAssignmentAssessments(data.assessments);
    if (!validation.repairable) {
      return {
        ...base,
        status: "error" as const,
        message: `current assignment requires manual review: ${validation.reason}`,
      };
    }

    const rawProgress = asProgress(data.progress);
    const currentProgress = rawProgress ?? {};
    const expectedProgress = rebuildAssignmentProgress(
      validation.assessments,
      currentProgress
    );
    const expectedCompleted = expectedAssignmentCompleted(
      validation.assessments
    );
    const progressMismatch =
      rawProgress === null || !recordsEqual(currentProgress, expectedProgress);
    const completedMismatch = (data.completed === true) !== expectedCompleted;

    if (!progressMismatch && !completedMismatch) {
      return {
        ...base,
        status: "skipped" as const,
        message: "assignment is no longer corrupted",
      };
    }

    const updates: FirebaseFirestore.UpdateData<FirebaseFirestore.DocumentData> =
      {};
    const changed: string[] = [];
    if (progressMismatch) {
      updates.progress = expectedProgress;
      changed.push("progress");
    }
    if (completedMismatch) {
      updates.completed = expectedCompleted;
      changed.push(`completed=${expectedCompleted}`);
    }

    if (!dryRun) {
      transaction.update(assignmentRef, updates);
    }

    return {
      ...base,
      status: "repaired" as const,
      message: `${dryRun ? "dry-run: would update" : "updated"} ${changed.join(
        ", "
      )}`,
    };
  });
}

function writeResults(results: RepairResult[], outputFile: string): string {
  const outputPath = path.resolve(process.cwd(), outputFile);
  fs.writeFileSync(
    outputPath,
    Papa.unparse(results, { newline: "\n" }) + "\n",
    "utf8"
  );
  return outputPath;
}

interface CliArgs {
  environment: "dev" | "prod";
  envFile: string;
  inputFile: string;
  outputFile: string;
  dryRun: boolean;
  testSize?: number;
}

const argv = yargs(process.argv.slice(2))
  .scriptName("repair-corrupted-assignments")
  .usage(
    "$0 [options]\n\nRevalidates rows from identify-corrupted-assignments" +
      " against current Firestore state, then repairs progress and completed."
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
      description: "CSV produced by identify-corrupted-assignments",
      type: "string",
      demandOption: true,
    },
    outputFile: {
      alias: "o",
      description: "CSV audit log of repair results",
      type: "string",
      default: "corrupted-assignment-repair-results.csv",
    },
    dryRun: {
      alias: "d",
      description: "Report changes without writing to Firestore",
      type: "boolean",
      default: true,
    },
    testSize: {
      alias: "t",
      description: "Maximum corrupted rows to process",
      type: "number",
    },
  })
  .help("help")
  .alias("help", "h")
  .strict().argv as CliArgs;

async function main(): Promise<void> {
  console.log(`repair-corrupted-assignments (${argv.environment})`);
  console.log(`Input: ${argv.inputFile}`);
  console.log(`Dry run: ${argv.dryRun}`);

  let rows = parseInput(argv.inputFile).filter(
    (row) => parseBoolean(row.isCorrupted) || !parseBoolean(row.repairable)
  );
  if (argv.testSize) {
    rows = rows.slice(0, argv.testSize);
  }

  const { db } = await initAdmin({
    environment: argv.environment,
    envFile: argv.envFile,
    appName: "repair-corrupted-assignments",
  });

  const results: RepairResult[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const result = await repairAssignment(db, rows[index], argv.dryRun);
    results.push(result);
    if (
      result.status === "error" ||
      (index + 1) % 50 === 0 ||
      index === rows.length - 1
    ) {
      console.log(
        `[${index + 1}/${rows.length}] ${rowLabel(rows[index])}: ${
          result.message
        }`
      );
    }
  }

  const outputPath = writeResults(results, argv.outputFile);
  const repaired = results.filter((row) => row.status === "repaired").length;
  const skipped = results.filter((row) => row.status === "skipped").length;
  const errors = results.filter((row) => row.status === "error").length;

  console.log("\n" + "=".repeat(60));
  console.log("CORRUPTED ASSIGNMENT REPAIR");
  console.log("=".repeat(60));
  console.log(`Rows processed : ${results.length}`);
  console.log(`Repaired       : ${repaired}`);
  console.log(`Skipped        : ${skipped}`);
  console.log(`Errors         : ${errors}`);
  console.log(`Audit report   : ${outputPath}`);
  if (argv.dryRun) {
    console.log("Dry run enabled — no Firestore writes were made.");
    console.log("Re-run with --dryRun=false to apply changes.");
  }
  console.log("=".repeat(60));
}

function rowLabel(row: InputRow): string {
  return `${row.uid}/${row.administrationId}`;
}

main().catch((error) => {
  console.error("Fatal script error:", error);
  process.exit(1);
});
