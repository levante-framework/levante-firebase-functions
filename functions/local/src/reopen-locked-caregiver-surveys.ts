/**
 * Reopens caregiver survey assignments locked complete before later child
 * links (issue #155).
 *
 * Scans administrations that are still open and include caregiver-survey.
 * A caregiver assignment is reopened when:
 * - its own date window is still open
 * - it is marked complete and the caregiver survey has completedOn
 * - at least one current `childIds` entry has no completed child-specific
 *   survey (`surveyResponses.specific`, matched on `childId`)
 *
 * Completed specific surveys for children who are no longer linked do not
 * count. Caregivers with no linked children are left complete.
 *
 * Writes use the same assignment, user-doc, and administration-stats updates
 * as linking a new child. Dry run by default; pass --apply to persist.
 *
 * Usage (from functions/local):
 *   npm run reopen-locked-caregiver-surveys
 *   npm run reopen-locked-caregiver-surveys -- -e prod
 *   npm run reopen-locked-caregiver-surveys -- -e prod -s SITE_ID --apply
 */

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteApp, getApps } from "firebase-admin/app";
import type {
  DocumentReference,
  Firestore,
  Transaction,
} from "firebase-admin/firestore";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { syncAssignmentProgress } from "../../levante-admin/src/assignments/assignment-sync-in-transaction.js";
import {
  buildReopenedCaregiverSurveyUpdates,
  isCompleteOpenCaregiverSurvey,
  linkedChildIds,
  unfinishedLinkedChildIds,
  type Assignment,
  type ChildSpecificSurvey,
} from "../../levante-admin/src/users/reopen-caregiver-survey-assignments.js";
import { getOpenAdministrations } from "./utils/get-open-assignments.js";
import { initAdmin } from "./utils/init-admin.js";

const CAREGIVER_SURVEY = "caregiver-survey";
const READ_CONCURRENCY = 25;
const GET_ALL_BATCH = 10;

const CSV_COLUMNS = [
  "siteId",
  "uid",
  "administrationId",
  "childCount",
  "completedSpecificCount",
  "unfinishedChildIds",
  "status",
  "message",
] as const;

type RowStatus = "dry-run" | "reopened" | "skipped" | "error";

interface Candidate {
  siteId: string;
  uid: string;
  administrationId: string;
  childCount: number;
  completedSpecificCount: number;
  unfinishedChildIds: string[];
}

interface ResultRow extends Candidate {
  status: RowStatus;
  message: string;
}

class SkipCandidate extends Error {}

function isCaregiver(userType: unknown): boolean {
  if (typeof userType !== "string") return false;
  const normalized = userType.trim().toLowerCase();
  return normalized === "parent" || normalized === "caregiver";
}

function userUidFromAssignment(ref: DocumentReference): string | undefined {
  const userRef = ref.parent.parent;
  if (!userRef || userRef.parent.id !== "users") return undefined;
  return userRef.id;
}

function specificEntries(
  data: Record<string, unknown> | undefined
): ChildSpecificSurvey[] | undefined {
  const specific = data?.specific;
  return Array.isArray(specific)
    ? (specific as ChildSpecificSurvey[])
    : undefined;
}

function toCsvCell(value: unknown): string {
  const text = Array.isArray(value)
    ? value.join("|")
    : value == null
    ? ""
    : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(rows: ResultRow[], outputFile: string): string {
  const outPath = resolve(process.cwd(), outputFile);
  const lines = [
    CSV_COLUMNS.join(","),
    ...rows.map((row) =>
      CSV_COLUMNS.map((column) => toCsvCell(row[column])).join(",")
    ),
  ];
  writeFileSync(outPath, lines.join("\n") + "\n", "utf8");
  return outPath;
}

async function loadUsersByUid(
  db: Firestore,
  uids: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const byUid = new Map<string, Record<string, unknown>>();
  const unique = [...new Set(uids)];
  for (let i = 0; i < unique.length; i += GET_ALL_BATCH) {
    const chunk = unique.slice(i, i + GET_ALL_BATCH);
    const snaps = await db.getAll(
      ...chunk.map((uid) => db.collection("users").doc(uid))
    );
    for (const snap of snaps) {
      if (snap.exists) byUid.set(snap.id, snap.data() ?? {});
    }
  }
  return byUid;
}

async function loadSurveyResponse(
  db: Firestore,
  uid: string,
  administrationId: string
): Promise<Record<string, unknown> | undefined> {
  const col = db.collection("users").doc(uid).collection("surveyResponses");
  const byAdmin = await col
    .where("administrationId", "==", administrationId)
    .limit(1)
    .get();
  if (!byAdmin.empty) return byAdmin.docs[0].data();
  const byAssignment = await col
    .where("assignmentId", "==", administrationId)
    .limit(1)
    .get();
  return byAssignment.empty ? undefined : byAssignment.docs[0].data();
}

async function readSurveyInTransaction(
  transaction: Transaction,
  userRef: DocumentReference,
  administrationId: string
): Promise<Record<string, unknown> | undefined> {
  const col = userRef.collection("surveyResponses");
  const byAdmin = await transaction.get(
    col.where("administrationId", "==", administrationId).limit(1)
  );
  if (!byAdmin.empty) return byAdmin.docs[0].data();
  const byAssignment = await transaction.get(
    col.where("assignmentId", "==", administrationId).limit(1)
  );
  return byAssignment.empty ? undefined : byAssignment.docs[0].data();
}

async function findCandidates(
  db: Firestore,
  siteId: string | undefined,
  now: Date
): Promise<{
  candidates: Candidate[];
  administrationCount: number;
  lockedAssignments: number;
}> {
  const openAdmins = await getOpenAdministrations({
    db,
    siteId,
    taskIds: [CAREGIVER_SURVEY],
    taskIdsMatch: "any",
  });
  console.log(
    `Open administrations with ${CAREGIVER_SURVEY}: ${openAdmins.length}`
  );

  const candidates: Candidate[] = [];
  let lockedAssignments = 0;

  let adminIndex = 0;
  for (const admin of openAdmins) {
    adminIndex += 1;
    const assignmentSnap = await db
      .collectionGroup("assignments")
      .where("id", "==", admin.id)
      .get();

    const idMismatches = assignmentSnap.docs.filter(
      (doc) =>
        !!userUidFromAssignment(doc.ref) &&
        doc.id !== admin.id &&
        isCompleteOpenCaregiverSurvey(doc.data() as Assignment, now)
    );
    if (idMismatches.length > 0) {
      console.warn(
        `${admin.id}: skipped ${idMismatches.length} assignment(s) whose document id does not match the administration id`
      );
    }

    const locked = assignmentSnap.docs.filter((doc) => {
      if (!userUidFromAssignment(doc.ref)) return false;
      if (doc.id !== admin.id) return false;
      return isCompleteOpenCaregiverSurvey(doc.data() as Assignment, now);
    });

    const users = await loadUsersByUid(
      db,
      locked
        .map((doc) => userUidFromAssignment(doc.ref))
        .filter((uid): uid is string => !!uid)
    );

    const caregiverDocs = locked.filter((doc) => {
      const uid = userUidFromAssignment(doc.ref);
      return !!uid && isCaregiver(users.get(uid)?.userType);
    });
    lockedAssignments += caregiverDocs.length;

    const needsSurvey: { uid: string; childIds: unknown }[] = [];
    for (const doc of caregiverDocs) {
      const uid = userUidFromAssignment(doc.ref) as string;
      const childIds = users.get(uid)?.childIds;
      if (linkedChildIds(childIds).length === 0) continue;
      needsSurvey.push({ uid, childIds });
    }

    const found: Candidate[] = [];
    for (let i = 0; i < needsSurvey.length; i += READ_CONCURRENCY) {
      const chunk = needsSurvey.slice(i, i + READ_CONCURRENCY);
      const loaded = await Promise.all(
        chunk.map(async (item) => {
          const response = await loadSurveyResponse(db, item.uid, admin.id);
          const unfinished = unfinishedLinkedChildIds(
            specificEntries(response),
            item.childIds
          );
          return { ...item, unfinished };
        })
      );
      for (const row of loaded) {
        if (row.unfinished.length === 0) continue;
        const childCount = linkedChildIds(row.childIds).length;
        found.push({
          siteId: admin.siteId,
          uid: row.uid,
          administrationId: admin.id,
          childCount,
          completedSpecificCount: childCount - row.unfinished.length,
          unfinishedChildIds: row.unfinished,
        });
      }
    }
    candidates.push(...found);
    console.log(
      `[${adminIndex}/${openAdmins.length}] ${admin.id} — ` +
        `${caregiverDocs.length} complete, ${found.length} to reopen`
    );
  }

  return {
    candidates,
    administrationCount: openAdmins.length,
    lockedAssignments,
  };
}

function levanteAdminPackageJson(): string {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../levante-admin/package.json"
  );
}

function levanteAdminFirestore(): Firestore {
  const require = createRequire(levanteAdminPackageJson());
  const { getFirestore } = require("firebase-admin/firestore") as {
    getFirestore: () => Firestore;
  };
  return getFirestore();
}

async function deleteLevanteAdminApps(): Promise<void> {
  const require = createRequire(levanteAdminPackageJson());
  const adminApp = require("firebase-admin/app") as {
    getApps: () => { name: string }[];
    deleteApp: (app: unknown) => Promise<void>;
  };
  await Promise.all(adminApp.getApps().map((app) => adminApp.deleteApp(app)));
}

async function reopenCandidate(
  db: Firestore,
  candidate: Candidate,
  now: Date
): Promise<void> {
  const userRef = db.collection("users").doc(candidate.uid);
  const assignmentRef = userRef
    .collection("assignments")
    .doc(candidate.administrationId);

  await db.runTransaction(async (transaction) => {
    const assignmentSnap = await transaction.get(assignmentRef);
    const userSnap = await transaction.get(userRef);
    if (!assignmentSnap.exists || !userSnap.exists) {
      throw new SkipCandidate("assignment or user no longer exists");
    }
    if (!isCaregiver(userSnap.get("userType"))) {
      throw new SkipCandidate("user is not a caregiver");
    }

    const prev = assignmentSnap.data() as Assignment;
    if (!isCompleteOpenCaregiverSurvey(prev, now)) {
      throw new SkipCandidate("assignment is no longer a locked open survey");
    }

    const response = await readSurveyInTransaction(
      transaction,
      userRef,
      candidate.administrationId
    );
    const unfinished = unfinishedLinkedChildIds(
      specificEntries(response),
      userSnap.get("childIds")
    );
    if (unfinished.length === 0) {
      throw new SkipCandidate(
        "every linked child already has a completed specific survey"
      );
    }

    const updates = buildReopenedCaregiverSurveyUpdates(prev, now);
    if (!updates) {
      throw new SkipCandidate("caregiver survey could not be reopened");
    }

    const curr = { ...prev, ...updates };
    transaction.update(assignmentRef, {
      completed: updates.completed,
      assessments: updates.assessments,
      progress: updates.progress,
    });
    await syncAssignmentProgress(
      db as never,
      transaction as never,
      candidate.uid,
      candidate.administrationId,
      prev as never,
      curr as never
    );
  });
}

const argv = yargs(hideBin(process.argv))
  .scriptName("reopen-locked-caregiver-surveys")
  .options({
    env: {
      alias: "e",
      description: "Environment to run against",
      choices: ["dev", "prod"] as const,
      default: "dev" as const,
    },
    envFile: {
      alias: "f",
      description: "Env file passed to initAdmin",
      type: "string",
      default: ".env.local",
    },
    siteId: {
      alias: "s",
      description:
        "Only include open administrations for this site (district id)",
      type: "string",
    },
    apply: {
      alias: "a",
      description: "Reopen the matching assignments (omit for a dry run)",
      type: "boolean",
      default: false,
    },
    outputFile: {
      alias: "o",
      description: "CSV path for matching assignments",
      type: "string",
      default: "reopen-locked-caregiver-surveys.csv",
    },
  })
  .strict()
  .help("help")
  .alias("help", "h")
  .parseSync();

async function main(): Promise<void> {
  const now = new Date();
  const siteId = argv.siteId?.trim() || undefined;
  console.log(
    `reopen-locked-caregiver-surveys (${argv.env}, ${
      argv.apply ? "APPLY" : "DRY RUN"
    })`
  );
  if (siteId) console.log(`Site filter: ${siteId}`);

  const { db } = await initAdmin({
    environment: argv.env,
    envFile: argv.envFile,
    appName: "reopen-locked-caregiver-surveys",
    alsoInitializeDefaultApp: argv.apply,
  });

  const { candidates, administrationCount, lockedAssignments } =
    await findCandidates(db, siteId, now);

  const rows: ResultRow[] = candidates.map((candidate) => ({
    ...candidate,
    status: "dry-run",
    message: "",
  }));

  if (argv.apply && rows.length > 0) writeCsv(rows, argv.outputFile);

  if (argv.apply) {
    const writeDb = levanteAdminFirestore();
    for (const row of rows) {
      try {
        await reopenCandidate(writeDb, row, now);
        row.status = "reopened";
      } catch (error) {
        if (error instanceof SkipCandidate) {
          row.status = "skipped";
          row.message = error.message;
          continue;
        }
        row.status = "error";
        row.message = error instanceof Error ? error.message : String(error);
        console.error(
          `Failed ${row.uid} ${row.administrationId}: ${row.message}`
        );
      }
    }
  }

  const outPath = rows.length > 0 ? writeCsv(rows, argv.outputFile) : undefined;
  const reopened = rows.filter((row) => row.status === "reopened").length;
  const skipped = rows.filter((row) => row.status === "skipped").length;
  const errors = rows.filter((row) => row.status === "error").length;

  console.log("\n" + "=".repeat(60));
  console.log("REOPEN LOCKED CAREGIVER SURVEYS");
  console.log("=".repeat(60));
  console.log(`Administrations scanned : ${administrationCount}`);
  console.log(`Locked complete surveys : ${lockedAssignments}`);
  console.log(`Missing a child survey  : ${candidates.length}`);
  if (argv.apply) {
    console.log(`Reopened                : ${reopened}`);
    console.log(`Skipped                 : ${skipped}`);
    console.log(`Errors                  : ${errors}`);
  } else {
    console.log(`Would reopen            : ${candidates.length}`);
  }
  console.log(`Report                  : ${outPath ?? "(no matching rows)"}`);
  console.log("=".repeat(60));

  if (errors > 0) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error("Fatal script error:", error);
  process.exitCode = 1;
} finally {
  await Promise.all(getApps().map((app) => deleteApp(app)));
  if (argv.apply) {
    try {
      await deleteLevanteAdminApps();
    } catch (error) {
      console.error("Failed to close levante-admin app:", error);
    }
  }
}
