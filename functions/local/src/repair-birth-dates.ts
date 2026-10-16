/**
 * Repairs invalid `birthMonth` / `birthYear` on child `users` docs.
 *
 * Queries only child users (`userType == "student"`, the ROAR value for child).
 * A birth date is valid when both fields are integers in range: month 1-12 and
 * year MIN_YEAR..MAX_YEAR. Any child failing that is flagged, and flagged as
 * repairable when each bad value coerces to a valid integer — an integer-valued
 * number, or a whole-digit string like "2015" (fractions and non-numeric
 * strings are not coerced).
 *
 * When any user is flagged, writes a timestamped CSV next to this script with
 * one row per flagged user: stored month/year and their JS types, `createdAt`,
 * the repaired month/year ("null" when not coercible), and `action` (`repair`
 * or `skip`). The CSV is written on a dry run too; a clean run writes nothing.
 *
 * Only repairable docs are written back, in batches of BATCH_SIZE. Runs as a
 * dry run by default; pass --apply to persist. Credentials come from `initAdmin`,
 * which reads a service-account JSON path from LEVANTE_ADMIN_{DEV,PROD}_FIREBASE_CREDENTIALS
 * (in your shell or a local/repo-root env file); set that before running.
 *
 * Usage (from functions/local):
 *   npm run repair-birth-dates                # dry run against dev
 *   npm run repair-birth-dates -- --apply     # apply against dev
 *   npm run repair-birth-dates -- -e prod     # dry run against prod
 *   npm run repair-birth-dates -- -e prod -a  # apply against prod
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteApp } from "firebase-admin/app";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { initAdmin } from "./utils/init-admin.js";

const BATCH_SIZE = 500;
const MIN_YEAR = 2004;
const MAX_YEAR = new Date().getFullYear() - 2;

function isValidBirthMonth(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 12
  );
}

function isValidBirthYear(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_YEAR &&
    value <= MAX_YEAR
  );
}

function repairNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }
  // Whole digit strings only. parseInt would truncate "8.5" and "2015abc".
  if (typeof value !== "string" || !/^[+-]?\d+$/.test(value.trim())) {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

const argv = yargs(hideBin(process.argv))
  .options({
    env: {
      alias: "e",
      description: "Environment to run against",
      choices: ["dev", "prod"] as const,
      default: "dev" as const,
    },
    apply: {
      alias: "a",
      description: "Apply the repairs (omit for a dry run)",
      type: "boolean",
      default: false,
    },
  })
  .help("help")
  .alias("help", "h")
  .parseSync() as { env: "dev" | "prod"; apply: boolean };
const { apply, env } = argv;

const projectId =
  env === "dev" ? "hs-levante-admin-dev" : "hs-levante-admin-prod";
const { app, db } = await initAdmin({ environment: env });

const flagged: Array<{
  uid: string;
  birthMonth: unknown;
  birthYear: unknown;
  createdAt: unknown;
  repairedBirthMonth: number | null;
  repairedBirthYear: number | null;
  action: "repair" | "skip";
}> = [];
const pendingUpdates: Array<{
  ref: FirebaseFirestore.DocumentReference;
  update: { birthMonth: number; birthYear: number };
}> = [];
let totalScanned = 0;
let totalValid = 0;
let totalInvalid = 0;
let totalRepaired = 0;

let lastDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
while (true) {
  let query = db
    .collection("users")
    .where("userType", "==", "student")
    .select("birthMonth", "birthYear", "createdAt")
    .orderBy("__name__")
    .limit(BATCH_SIZE);
  if (lastDoc) query = query.startAfter(lastDoc);

  const snap = await query.get();
  if (snap.empty) break;

  for (const doc of snap.docs) {
    const birthMonth = doc.get("birthMonth");
    const birthYear = doc.get("birthYear");
    const createdAt = doc.get("createdAt");

    totalScanned++;
    if (isValidBirthMonth(birthMonth) && isValidBirthYear(birthYear)) {
      totalValid++;
      continue;
    }
    totalInvalid++;

    const repairedBirthMonth = repairNumber(birthMonth);
    const repairedBirthYear = repairNumber(birthYear);
    const canRepair =
      isValidBirthMonth(repairedBirthMonth) &&
      isValidBirthYear(repairedBirthYear);
    flagged.push({
      uid: doc.id,
      birthMonth,
      birthYear,
      createdAt: createdAt?.toDate?.().toISOString() ?? createdAt ?? null,
      repairedBirthMonth,
      repairedBirthYear,
      action: canRepair ? "repair" : "skip",
    });
    if (canRepair) {
      totalRepaired++;
      pendingUpdates.push({
        ref: doc.ref,
        update: {
          birthMonth: repairedBirthMonth!,
          birthYear: repairedBirthYear!,
        },
      });
    }
  }

  if (snap.size < BATCH_SIZE) break;
  lastDoc = snap.docs[snap.docs.length - 1];
}

if (flagged.length > 0) {
  const runTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const csvPath = join(
    dirname(fileURLToPath(import.meta.url)),
    `repair-birth-dates_${runTimestamp}.csv`
  );
  const header = [
    "uid",
    "birthMonth",
    "typeofBirthMonth",
    "birthYear",
    "typeofBirthYear",
    "createdAt",
    "repairedBirthMonth",
    "repairedBirthYear",
    "action",
  ];
  const rows = flagged.map((row) =>
    [
      row.uid,
      row.birthMonth,
      row.birthMonth === null ? "null" : typeof row.birthMonth,
      row.birthYear,
      row.birthYear === null ? "null" : typeof row.birthYear,
      row.createdAt,
      row.repairedBirthMonth,
      row.repairedBirthYear,
      row.action,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",")
  );
  writeFileSync(csvPath, [header.join(","), ...rows].join("\n") + "\n");
  console.log(`\nWrote ${rows.length} rows to ${csvPath}`);
}

if (apply) {
  for (let i = 0; i < pendingUpdates.length; i += BATCH_SIZE) {
    const writeBatch = db.batch();
    for (const { ref, update } of pendingUpdates.slice(i, i + BATCH_SIZE)) {
      writeBatch.update(ref, update);
    }
    await writeBatch.commit();
  }
}

console.log(`\nProject: ${projectId}  (${apply ? "APPLY" : "DRY RUN"})`);
console.log(`Users scanned: ${totalScanned}`);
console.log(`Users with valid birth-dates: ${totalValid}`);
console.log(`Users with invalid birth-dates: ${totalInvalid}`);
console.log(
  `Users ${apply ? "repaired" : "that would be repaired"}: ${totalRepaired}`
);

await deleteApp(app);
