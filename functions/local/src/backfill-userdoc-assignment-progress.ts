/**
 * Backfills user-doc assignment progress missed before the inline sync in
 * levante-firebase-functions#160.
 *
 * `startTask`, `completeTask`, and run completion set `started` / `completed`
 * on `users/{uid}/assignments/{administrationId}` and did not write the user
 * document. Survey saves did both, so those rows already have the stamps.
 *
 * For each assignment whose flag is true:
 * - missing `assignmentsStarted.{id}` is set from the earliest assessment
 *   `startedOn` (then `dateAssigned`, then `dateOpened`)
 * - missing `assignmentsCompleted.{id}` is set from the latest assessment
 *   `completedOn` (then the started date above)
 * - a missing `assignments.started` / `assignments.completed` entry is added
 * - existing dates are not overwritten
 *
 * Administration stats are incremented only when both the date and the list
 * entry were missing (the flag flip never landed). Per-task stats are
 * replayed for non-survey tasks. Survey task stats stay put, because
 * `saveSurveyResponses` already counted them. The assignment-level total is
 * still incremented once for that missing flip.
 *
 * Dry run by default.
 *
 * Usage (from functions/local):
 *   npm run backfill-userdoc-assignment-progress
 *   npm run backfill-userdoc-assignment-progress -- -e prod --uid USER_ID
 *   npm run backfill-userdoc-assignment-progress -- -e prod --apply
 */

import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deleteApp, getApps } from "firebase-admin/app";
import type {
  DocumentReference,
  Firestore,
  Transaction,
} from "firebase-admin/firestore";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { AdminStatsBufferRegistry } from "../../levante-admin/src/assignments/admin-stats-buffer.js";
import { recordAssignmentUpdatedStats } from "../../levante-admin/src/assignments/assignment-sync-in-transaction.js";
import { initAdmin } from "./utils/init-admin.js";

const USER_PAGE_SIZE = 300;
const ASSIGNMENT_READ_CONCURRENCY = 20;
const APPLY_CHUNK = 20;

const CSV_COLUMNS = [
  "uid",
  "administrationId",
  "setStartedAt",
  "setCompletedAt",
  "addStarted",
  "addCompleted",
  "statsStarted",
  "statsCompleted",
  "status",
  "message",
] as const;

type RowStatus = "dry-run" | "repaired" | "skipped" | "error";

interface AssessmentRow {
  taskId?: string;
  startedOn?: unknown;
  completedOn?: unknown;
}

interface AssignmentProgress {
  id: string;
  started: boolean;
  completed: boolean;
  assessments: AssessmentRow[];
  assigningOrgs?: unknown;
  dateAssigned?: unknown;
  dateOpened?: unknown;
}

interface UserProgressMaps {
  startedIds: string[];
  completedIds: string[];
  startedAt: Record<string, unknown>;
  completedAt: Record<string, unknown>;
}

interface Gap {
  uid: string;
  administrationId: string;
  setStartedAt: string;
  setCompletedAt: string;
  addStarted: boolean;
  addCompleted: boolean;
  statsStarted: boolean;
  statsCompleted: boolean;
  assignment: AssignmentProgress;
}

interface ResultRow extends Gap {
  status: RowStatus;
  message: string;
}

function isSurveyTask(taskId: string | undefined): boolean {
  return !!taskId && taskId.toLowerCase().includes("survey");
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (
    value &&
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate: unknown }).toDate === "function"
  ) {
    const date = (value as { toDate: () => Date }).toDate();
    if (date instanceof Date && !Number.isNaN(date.getTime())) return date;
  }
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function pickDate(dates: Date[], which: "earliest" | "latest"): Date | null {
  if (dates.length === 0) return null;
  return dates.reduce((best, date) =>
    which === "earliest"
      ? date < best
        ? date
        : best
      : date > best
      ? date
      : best
  );
}

function firstDate(values: unknown[]): Date | null {
  for (const value of values) {
    const date = toDate(value);
    if (date) return date;
  }
  return null;
}

function stringIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function mapHas(map: Record<string, unknown>, id: string): boolean {
  const value = map[id];
  return value !== undefined && value !== null;
}

function userProgressMaps(
  data: Record<string, unknown> | undefined
): UserProgressMaps {
  const assignments = asRecord(data?.assignments);
  return {
    startedIds: stringIds(assignments.started),
    completedIds: stringIds(assignments.completed),
    startedAt: asRecord(data?.assignmentsStarted),
    completedAt: asRecord(data?.assignmentsCompleted),
  };
}

function orgIds(assigningOrgs: unknown): string[] {
  if (!assigningOrgs || typeof assigningOrgs !== "object") return [];
  const source = assigningOrgs as Record<string, unknown>;
  const ids: string[] = [];
  for (const key of ["districts", "schools", "classes", "groups"]) {
    ids.push(...stringIds(source[key]));
  }
  ids.push("total");
  return ids;
}

function assignmentProgress(
  id: string,
  data: Record<string, unknown> | undefined
): AssignmentProgress | null {
  if (!data) return null;
  const assessments = Array.isArray(data.assessments)
    ? (data.assessments as AssessmentRow[])
    : [];
  return {
    id,
    started: data.started === true,
    completed: data.completed === true,
    assessments,
    assigningOrgs: data.assigningOrgs,
    dateAssigned: data.dateAssigned,
    dateOpened: data.dateOpened,
  };
}

function timestampFor(
  assignment: AssignmentProgress,
  field: "startedOn" | "completedOn",
  which: "earliest" | "latest",
  fallbacks: unknown[]
): Date | null {
  const dates = assignment.assessments
    .map((assessment) => toDate(assessment[field]))
    .filter((date): date is Date => date !== null);
  return pickDate(dates, which) ?? firstDate(fallbacks);
}

/**
 * Differences between one assignment's flags and the user-doc copy.
 * `statsStarted` / `statsCompleted` are true only when both the date and the
 * list entry are absent.
 */
export function gapsForAssignment(
  uid: string,
  assignment: AssignmentProgress,
  maps: UserProgressMaps
): Gap | null {
  const id = assignment.id;
  const startedOnList = maps.startedIds.includes(id);
  const completedOnList = maps.completedIds.includes(id);
  const hasStartedAt = mapHas(maps.startedAt, id);
  const hasCompletedAt = mapHas(maps.completedAt, id);

  const addStarted = assignment.started && !startedOnList;
  const addCompleted = assignment.completed && !completedOnList;
  const needsStartedAt = assignment.started && !hasStartedAt;
  const needsCompletedAt = assignment.completed && !hasCompletedAt;
  if (!addStarted && !addCompleted && !needsStartedAt && !needsCompletedAt) {
    return null;
  }

  const startedAt = needsStartedAt
    ? timestampFor(assignment, "startedOn", "earliest", [
        assignment.dateAssigned,
        assignment.dateOpened,
      ])
    : null;
  const completedAt = needsCompletedAt
    ? timestampFor(assignment, "completedOn", "latest", [
        startedAt,
        assignment.dateAssigned,
        assignment.dateOpened,
      ])
    : null;

  return {
    uid,
    administrationId: id,
    setStartedAt: startedAt ? startedAt.toISOString() : "",
    setCompletedAt: completedAt ? completedAt.toISOString() : "",
    addStarted,
    addCompleted,
    statsStarted: assignment.started && !hasStartedAt && !startedOnList,
    statsCompleted: assignment.completed && !hasCompletedAt && !completedOnList,
    assignment,
  };
}

function toCsvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
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

function levanteFieldTools(): {
  arrayUnion: (...ids: string[]) => unknown;
  fieldPath: (...segments: string[]) => unknown;
} {
  const require = createRequire(levanteAdminPackageJson());
  const { FieldPath, FieldValue } = require("firebase-admin/firestore") as {
    FieldPath: new (...segments: string[]) => unknown;
    FieldValue: { arrayUnion: (...ids: string[]) => unknown };
  };
  return {
    arrayUnion: (...ids) => FieldValue.arrayUnion(...ids),
    fieldPath: (...segments) => new FieldPath(...segments),
  };
}

async function deleteLevanteAdminApps(): Promise<void> {
  const require = createRequire(levanteAdminPackageJson());
  const adminApp = require("firebase-admin/app") as {
    getApps: () => unknown[];
    deleteApp: (app: unknown) => Promise<void>;
  };
  await Promise.all(adminApp.getApps().map((app) => adminApp.deleteApp(app)));
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }
  const workers = Math.min(limit, items.length);
  if (workers === 0) return results;
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function userMightHaveAssignments(
  data: Record<string, unknown> | undefined
): boolean {
  const maps = userProgressMaps(data);
  const assigned = stringIds(asRecord(data?.assignments).assigned);
  return (
    assigned.length > 0 ||
    maps.startedIds.length > 0 ||
    maps.completedIds.length > 0 ||
    Object.keys(maps.startedAt).length > 0 ||
    Object.keys(maps.completedAt).length > 0
  );
}

async function gapsForUser(
  db: Firestore,
  uid: string,
  userData: Record<string, unknown> | undefined
): Promise<Gap[]> {
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("assignments")
    .get();
  const maps = userProgressMaps(userData);
  const gaps: Gap[] = [];
  for (const doc of snap.docs) {
    const assignment = assignmentProgress(doc.id, doc.data());
    if (!assignment) continue;
    if (!assignment.started && !assignment.completed) continue;
    const gap = gapsForAssignment(uid, assignment, maps);
    if (gap) gaps.push(gap);
  }
  return gaps;
}

async function findGaps(
  db: Firestore,
  uid?: string
): Promise<{ gaps: Gap[]; usersScanned: number }> {
  if (uid) {
    const snap = await db.collection("users").doc(uid).get();
    const gaps = snap.exists ? await gapsForUser(db, snap.id, snap.data()) : [];
    return { gaps, usersScanned: snap.exists ? 1 : 0 };
  }

  const gaps: Gap[] = [];
  let usersScanned = 0;
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null;

  while (true) {
    let query = db
      .collection("users")
      .orderBy("__name__")
      .limit(USER_PAGE_SIZE)
      .select("assignments", "assignmentsStarted", "assignmentsCompleted");
    if (last) query = query.startAfter(last);
    const page = await query.get();
    if (page.empty) break;

    const withAssignments = page.docs.filter((doc) =>
      userMightHaveAssignments(doc.data())
    );
    const pageGaps = await mapPool(
      withAssignments,
      ASSIGNMENT_READ_CONCURRENCY,
      (doc) => gapsForUser(db, doc.id, doc.data())
    );
    for (const userGaps of pageGaps) gaps.push(...userGaps);

    usersScanned += page.size;
    console.log(
      `Scanned ${usersScanned} users, ${gaps.length} assignment gap(s) so far`
    );
    if (page.size < USER_PAGE_SIZE) break;
    last = page.docs[page.docs.length - 1];
  }

  return { gaps, usersScanned };
}

function hideTaskProgress(
  assessments: AssessmentRow[],
  hide: { started: boolean; completed: boolean }
): AssessmentRow[] {
  return assessments.map((assessment) => {
    if (isSurveyTask(assessment.taskId)) return assessment;
    const next = { ...assessment };
    if (hide.started) delete next.startedOn;
    if (hide.completed) delete next.completedOn;
    return next;
  });
}

function nonSurveyTasks(
  assessments: AssessmentRow[],
  field: "startedOn" | "completedOn"
): AssessmentRow[] {
  return assessments.filter(
    (assessment) =>
      !isSurveyTask(assessment.taskId) && Boolean(assessment[field])
  );
}

/**
 * Replays the missed flag flip onto administration stats. Survey tasks are
 * left on the previous snapshot so their counts are not added again.
 */
function recordMissedStats(registry: AdminStatsBufferRegistry, gap: Gap): void {
  if (!gap.statsStarted && !gap.statsCompleted) return;

  const currAssessments = gap.assignment.assessments.map((assessment) => ({
    taskId: assessment.taskId ?? "",
    startedOn: assessment.startedOn,
    completedOn: assessment.completedOn,
  }));
  const prevAssessments = hideTaskProgress(gap.assignment.assessments, {
    started: gap.statsStarted,
    completed: gap.statsCompleted,
  }).map((assessment) => ({
    taskId: assessment.taskId ?? "",
    startedOn: assessment.startedOn,
    completedOn: assessment.completedOn,
  }));

  const buffer = registry.forAdministration(gap.administrationId);
  recordAssignmentUpdatedStats(
    {
      assigningOrgs: gap.assignment.assigningOrgs as never,
      assessments: prevAssessments,
      started: gap.statsStarted ? false : gap.assignment.started,
      completed: gap.statsCompleted ? false : gap.assignment.completed,
    },
    {
      assigningOrgs: gap.assignment.assigningOrgs as never,
      assessments: currAssessments,
      started: gap.assignment.started,
      completed: gap.assignment.completed,
    },
    buffer
  );

  const orgs = orgIds(gap.assignment.assigningOrgs);
  if (
    gap.statsStarted &&
    nonSurveyTasks(gap.assignment.assessments, "startedOn").length === 0
  ) {
    buffer.recordIncrements(orgs, "started", [], 1, true);
  }
  if (
    gap.statsCompleted &&
    nonSurveyTasks(gap.assignment.assessments, "completedOn").length === 0
  ) {
    buffer.recordIncrements(orgs, "completed", [], 1, true);
  }
}

async function repairUser(
  db: Firestore,
  uid: string,
  gaps: Gap[]
): Promise<Map<string, { status: RowStatus; message: string }>> {
  const outcome = new Map<string, { status: RowStatus; message: string }>();
  const userRef = db.collection("users").doc(uid);
  const { arrayUnion, fieldPath } = levanteFieldTools();

  for (let offset = 0; offset < gaps.length; offset += APPLY_CHUNK) {
    const chunk = gaps.slice(offset, offset + APPLY_CHUNK);
    try {
      const applied = await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        const assignmentSnaps = [];
        for (const gap of chunk) {
          assignmentSnaps.push(
            await transaction.get(
              userRef.collection("assignments").doc(gap.administrationId)
            )
          );
        }

        const maps = userProgressMaps(userSnap.data());
        const fresh: Gap[] = [];
        for (const snap of assignmentSnaps) {
          const assignment = assignmentProgress(snap.id, snap.data());
          if (!assignment) continue;
          const gap = gapsForAssignment(uid, assignment, maps);
          if (gap) fresh.push(gap);
        }

        if (fresh.length === 0) return fresh;

        const updateArgs: unknown[] = [];
        const startedIds = fresh
          .filter((gap) => gap.addStarted)
          .map((gap) => gap.administrationId);
        const completedIds = fresh
          .filter((gap) => gap.addCompleted)
          .map((gap) => gap.administrationId);
        if (startedIds.length > 0) {
          updateArgs.push(
            fieldPath("assignments", "started"),
            arrayUnion(...startedIds)
          );
        }
        if (completedIds.length > 0) {
          updateArgs.push(
            fieldPath("assignments", "completed"),
            arrayUnion(...completedIds)
          );
        }
        for (const gap of fresh) {
          if (gap.setStartedAt) {
            updateArgs.push(
              fieldPath("assignmentsStarted", gap.administrationId),
              new Date(gap.setStartedAt)
            );
          }
          if (gap.setCompletedAt) {
            updateArgs.push(
              fieldPath("assignmentsCompleted", gap.administrationId),
              new Date(gap.setCompletedAt)
            );
          }
        }

        if (updateArgs.length > 0) {
          const update = transaction.update.bind(transaction) as (
            ref: DocumentReference,
            field: unknown,
            value: unknown,
            ...rest: unknown[]
          ) => Transaction;
          update(userRef, updateArgs[0], updateArgs[1], ...updateArgs.slice(2));
        }

        const registry = new AdminStatsBufferRegistry(db);
        for (const gap of fresh) recordMissedStats(registry, gap);
        registry.flush(transaction);
        return fresh;
      });

      const appliedIds = new Set(applied.map((gap) => gap.administrationId));
      for (const gap of chunk) {
        outcome.set(
          gap.administrationId,
          appliedIds.has(gap.administrationId)
            ? { status: "repaired", message: "" }
            : {
                status: "skipped",
                message: "user doc already matched the assignment",
              }
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const gap of chunk) {
        outcome.set(gap.administrationId, { status: "error", message });
      }
      console.error(`Failed ${uid}: ${message}`);
    }
  }

  return outcome;
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectRun) {
  const argv = yargs(hideBin(process.argv))
    .scriptName("backfill-userdoc-assignment-progress")
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
      uid: {
        description: "Only repair this user",
        type: "string",
      },
      apply: {
        alias: "a",
        description: "Write the backfill (omit for a dry run)",
        type: "boolean",
        default: false,
      },
      outputFile: {
        alias: "o",
        description: "CSV path for assignments that need a backfill",
        type: "string",
        default: "userdoc-assignment-backfill.csv",
      },
    })
    .strict()
    .help("help")
    .alias("help", "h")
    .parseSync();

  function csvRow(gap: Gap, status: RowStatus, message: string): ResultRow {
    return { ...gap, status, message };
  }

  async function main(): Promise<void> {
    const uid = argv.uid?.trim() || undefined;
    console.log(
      `backfill-userdoc-assignment-progress (${argv.env}, ${
        argv.apply ? "APPLY" : "DRY RUN"
      })`
    );
    if (uid) console.log(`User filter: ${uid}`);

    const { db } = await initAdmin({
      environment: argv.env,
      envFile: argv.envFile,
      appName: "backfill-userdoc-assignment-progress",
      alsoInitializeDefaultApp: argv.apply,
    });

    const { gaps, usersScanned } = await findGaps(db, uid);
    const rows: ResultRow[] = gaps.map((gap) => csvRow(gap, "dry-run", ""));
    if (argv.apply && rows.length > 0) writeCsv(rows, argv.outputFile);

    if (argv.apply) {
      const writeDb = levanteAdminFirestore();
      const byUid = new Map<string, Gap[]>();
      for (const gap of gaps) {
        const list = byUid.get(gap.uid) ?? [];
        list.push(gap);
        byUid.set(gap.uid, list);
      }

      let done = 0;
      for (const [userId, userGaps] of byUid) {
        const outcome = await repairUser(writeDb, userId, userGaps);
        for (const row of rows) {
          if (row.uid !== userId) continue;
          const result = outcome.get(row.administrationId);
          if (!result) continue;
          row.status = result.status;
          row.message = result.message;
        }
        done += 1;
        if (done % 25 === 0 || done === byUid.size) {
          console.log(`Repaired ${done}/${byUid.size} users`);
        }
      }
    }

    const outPath =
      rows.length > 0 ? writeCsv(rows, argv.outputFile) : undefined;
    const count = (status: RowStatus) =>
      rows.filter((row) => row.status === status).length;

    console.log("\n" + "=".repeat(60));
    console.log("USER DOC ASSIGNMENT BACKFILL");
    console.log("=".repeat(60));
    console.log(`Users scanned            : ${usersScanned}`);
    console.log(`Assignments behind       : ${gaps.length}`);
    console.log(
      `Missing started copy     : ${
        gaps.filter((gap) => gap.addStarted || gap.setStartedAt).length
      }`
    );
    console.log(
      `Missing completed copy   : ${
        gaps.filter((gap) => gap.addCompleted || gap.setCompletedAt).length
      }`
    );
    if (argv.apply) {
      console.log(`Repaired                 : ${count("repaired")}`);
      console.log(`Skipped                  : ${count("skipped")}`);
      console.log(`Errors                   : ${count("error")}`);
    } else {
      console.log(`Would repair             : ${gaps.length}`);
    }
    console.log(
      `Report                   : ${outPath ?? "(no matching rows)"}`
    );
    console.log("=".repeat(60));

    if (count("error") > 0) process.exitCode = 1;
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
}
