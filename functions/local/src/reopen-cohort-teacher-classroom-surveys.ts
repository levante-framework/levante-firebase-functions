/**
 * Reopens teacher-survey assignments that locked after the general section
 * alone, before cohort-only teachers got a generic classroom survey part
 * (levante-firebase-functions#143 / levante-dashboard#1086).
 *
 * Before that change, a teacher in a cohort with no class finished the survey
 * after `general.isComplete`. The assignment flipped to `completed: true` and
 * dropped out of the participant current list. After the change, those teachers
 * also need a `specific` entry with `classId: "generic"`.
 *
 * Match when:
 * - the user is a teacher with `groups.current` and no `classes.current`
 * - the assignment is still open by date
 * - the assignment is `completed: true`
 * - the teacher-survey assessment has `completedOn`
 * - `surveyResponses.general.isComplete` is true
 * - there is no completed generic classroom entry in `surveyResponses.specific`
 *
 * Apply clears the assignment completion and the survey assessment
 * `completedOn`, sets progress back to `started`, and removes the user-doc
 * completed stamp. General survey answers are left alone. The same
 * transaction decrements administration stats through
 * `recordAssignmentUpdatedStats`, matching the caregiver reopener.
 *
 * Dry run by default.
 *
 * Usage (from functions/local):
 *   npm run reopen-cohort-teacher-classroom-surveys
 *   npm run reopen-cohort-teacher-classroom-surveys -- -e prod
 *   npm run reopen-cohort-teacher-classroom-surveys -- -e prod --apply
 */

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deleteApp } from "firebase-admin/app";
import {
  FieldValue,
  type DocumentData,
  type DocumentSnapshot,
  type Firestore,
  type QueryDocumentSnapshot,
  type Timestamp,
} from "firebase-admin/firestore";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { AdminStatsBufferRegistry } from "../../levante-admin/src/assignments/admin-stats-buffer.js";
import { recordAssignmentUpdatedStats } from "../../levante-admin/src/assignments/assignment-sync-in-transaction.js";
import { initAdmin } from "./utils/init-admin.js";

export const GENERIC_TEACHER_CLASSROOM_ID = "generic";
export const TEACHER_SURVEY_TASK_ID = "teacher-survey";

const USER_PAGE_SIZE = 200;
const APPLY_CHUNK = 20;

type RowStatus = "would-repair" | "repaired" | "skipped" | "error";

export interface TeacherSurveyGap {
  uid: string;
  administrationId: string;
  taskId: string;
  surveyResponsePath: string;
  generalComplete: boolean;
  specificCount: number;
  hasGenericComplete: boolean;
}

interface ResultRow extends TeacherSurveyGap {
  status: RowStatus;
  message: string;
}

interface AssessmentRow {
  taskId?: string;
  completedOn?: unknown;
  startedOn?: unknown;
  optional?: boolean;
  [key: string]: unknown;
}

interface SurveyResponseDoc {
  administrationId?: unknown;
  assignmentId?: unknown;
  taskId?: unknown;
  general?: { isComplete?: boolean };
  specific?: Array<{ classId?: unknown; isComplete?: boolean }>;
}

const CSV_COLUMNS = [
  "uid",
  "administrationId",
  "taskId",
  "surveyResponsePath",
  "generalComplete",
  "specificCount",
  "hasGenericComplete",
  "status",
  "message",
] as const;

export function isCohortOnlyTeacher(userData: DocumentData): boolean {
  if (userData.userType !== "teacher") return false;
  const classIds = (userData.classes as { current?: unknown } | undefined)
    ?.current;
  const cohortIds = (userData.groups as { current?: unknown } | undefined)
    ?.current;
  const hasClasses = Array.isArray(classIds) && classIds.length > 0;
  const hasCohorts = Array.isArray(cohortIds) && cohortIds.length > 0;
  return !hasClasses && hasCohorts;
}

export function isAssignmentOpen(
  data: DocumentData,
  now: Date = new Date()
): boolean {
  const opened = toDate(data.dateOpened);
  const closed = toDate(data.dateClosed);
  if (!opened || !closed) return false;
  return opened <= now && closed >= now;
}

function toDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Timestamp).toDate === "function"
  ) {
    const date = (value as Timestamp).toDate();
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function findTeacherSurveyAssessment(
  assessments: AssessmentRow[]
): AssessmentRow | undefined {
  return assessments.find(
    (assessment) =>
      assessment.taskId?.toLowerCase() === TEACHER_SURVEY_TASK_ID
  );
}

function progressKeyFromTaskId(taskId: string): string {
  return taskId.replace(/-/g, "_");
}

function surveyResponseMatchesAdministration(
  data: SurveyResponseDoc,
  administrationId: string
): boolean {
  return (
    data.administrationId === administrationId ||
    data.assignmentId === administrationId
  );
}

function hasCompletedGenericClassroom(
  specific: SurveyResponseDoc["specific"]
): boolean {
  if (!Array.isArray(specific)) return false;
  return specific.some(
    (entry) =>
      String(entry.classId) === GENERIC_TEACHER_CLASSROOM_ID &&
      entry.isComplete === true
  );
}

/**
 * Returns a gap when this open, completed teacher-survey assignment finished
 * on the general section alone and still needs the generic classroom part.
 */
export function gapForTeacherAssignment(args: {
  uid: string;
  assignmentId: string;
  assignmentData: DocumentData;
  surveyResponseSnap: DocumentSnapshot | null;
  now?: Date;
}): TeacherSurveyGap | null {
  const {
    uid,
    assignmentId,
    assignmentData,
    surveyResponseSnap,
    now = new Date(),
  } = args;

  if (!isAssignmentOpen(assignmentData, now)) return null;
  if (assignmentData.completed !== true) return null;

  const assessments = Array.isArray(assignmentData.assessments)
    ? (assignmentData.assessments as AssessmentRow[])
    : [];
  const surveyAssessment = findTeacherSurveyAssessment(assessments);
  if (!surveyAssessment?.taskId || !surveyAssessment.completedOn) return null;

  if (!surveyResponseSnap?.exists) return null;
  const responseData = surveyResponseSnap.data() as SurveyResponseDoc;
  if (!surveyResponseMatchesAdministration(responseData, assignmentId)) {
    return null;
  }

  const generalComplete = responseData.general?.isComplete === true;
  if (!generalComplete) return null;

  const specific = responseData.specific;
  const genericComplete = hasCompletedGenericClassroom(specific);
  if (genericComplete) return null;

  return {
    uid,
    administrationId: assignmentId,
    taskId: surveyAssessment.taskId,
    surveyResponsePath: surveyResponseSnap.ref.path,
    generalComplete,
    specificCount: Array.isArray(specific) ? specific.length : 0,
    hasGenericComplete: genericComplete,
  };
}

export function buildReopenedTeacherSurveyUpdates(
  assignmentData: DocumentData
): {
  completed: false;
  assessments: AssessmentRow[];
  progress: Record<string, unknown>;
} | null {
  const assessments = Array.isArray(assignmentData.assessments)
    ? (assignmentData.assessments as AssessmentRow[])
    : [];
  const surveyIndex = assessments.findIndex(
    (assessment) =>
      assessment.taskId?.toLowerCase() === TEACHER_SURVEY_TASK_ID
  );
  if (surveyIndex === -1) return null;

  const surveyAssessment = assessments[surveyIndex];
  if (!surveyAssessment?.taskId || !surveyAssessment.completedOn) return null;

  const reopenedAssessments = assessments.map((assessment, index) => {
    if (index !== surveyIndex) return assessment;
    const next = { ...assessment };
    delete next.completedOn;
    return next;
  });

  return {
    completed: false,
    assessments: reopenedAssessments,
    progress: {
      ...((assignmentData.progress ?? {}) as Record<string, unknown>),
      [progressKeyFromTaskId(surveyAssessment.taskId)]: "started",
    },
  };
}

function toCsvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function writeCsv(rows: ResultRow[], outputFile: string): string {
  const lines = [
    CSV_COLUMNS.join(","),
    ...rows.map((row) =>
      [
        row.uid,
        row.administrationId,
        row.taskId,
        row.surveyResponsePath,
        row.generalComplete,
        row.specificCount,
        row.hasGenericComplete,
        row.status,
        row.message,
      ]
        .map(toCsvCell)
        .join(",")
    ),
  ];
  const resolved = resolve(process.cwd(), outputFile);
  writeFileSync(resolved, `${lines.join("\n")}\n`, "utf8");
  return resolved;
}

async function loadMatchingSurveyResponse(
  db: Firestore,
  uid: string,
  administrationId: string
): Promise<DocumentSnapshot | null> {
  const snap = await db
    .collection("users")
    .doc(uid)
    .collection("surveyResponses")
    .get();
  const match = snap.docs.find((doc) =>
    surveyResponseMatchesAdministration(
      doc.data() as SurveyResponseDoc,
      administrationId
    )
  );
  return match ?? null;
}

async function gapsForTeacher(
  db: Firestore,
  teacherDoc: QueryDocumentSnapshot,
  now: Date
): Promise<TeacherSurveyGap[]> {
  const uid = teacherDoc.id;
  if (!isCohortOnlyTeacher(teacherDoc.data())) return [];

  const assignmentSnaps = await db
    .collection("users")
    .doc(uid)
    .collection("assignments")
    .get();

  const gaps: TeacherSurveyGap[] = [];
  for (const assignmentSnap of assignmentSnaps.docs) {
    const assignmentData = assignmentSnap.data();
    if (!isAssignmentOpen(assignmentData, now)) continue;
    if (assignmentData.completed !== true) continue;

    const surveyResponseSnap = await loadMatchingSurveyResponse(
      db,
      uid,
      assignmentSnap.id
    );
    const gap = gapForTeacherAssignment({
      uid,
      assignmentId: assignmentSnap.id,
      assignmentData,
      surveyResponseSnap,
      now,
    });
    if (gap) gaps.push(gap);
  }
  return gaps;
}

async function scanGaps(
  db: Firestore,
  now: Date
): Promise<{ gaps: TeacherSurveyGap[]; teachersScanned: number }> {
  const gaps: TeacherSurveyGap[] = [];
  let teachersScanned = 0;
  let last: QueryDocumentSnapshot | undefined;
  while (true) {
    let query = db
      .collection("users")
      .where("userType", "==", "teacher")
      .orderBy("__name__")
      .limit(USER_PAGE_SIZE);
    if (last) query = query.startAfter(last);

    const page = await query.get();
    if (page.empty) break;

    for (const doc of page.docs) {
      teachersScanned += 1;
      gaps.push(...(await gapsForTeacher(db, doc, now)));
    }

    console.log(
      `Scanned ${teachersScanned} teachers, ${gaps.length} assignment gap(s) so far`
    );
    if (page.size < USER_PAGE_SIZE) break;
    last = page.docs[page.docs.length - 1];
  }

  return { gaps, teachersScanned };
}

async function repairTeacher(
  db: Firestore,
  uid: string,
  gaps: TeacherSurveyGap[]
): Promise<Map<string, { status: RowStatus; message: string }>> {
  const outcome = new Map<string, { status: RowStatus; message: string }>();
  const userRef = db.collection("users").doc(uid);

  for (let offset = 0; offset < gaps.length; offset += APPLY_CHUNK) {
    const chunk = gaps.slice(offset, offset + APPLY_CHUNK);
    try {
      const appliedIds = await db.runTransaction(async (transaction) => {
        const userSnap = await transaction.get(userRef);
        if (!userSnap.exists) {
          throw new Error(`User ${uid} missing during apply`);
        }
        if (!isCohortOnlyTeacher(userSnap.data() as DocumentData)) {
          throw new Error("teacher is no longer cohort-only");
        }

        const reads: Array<{
          gap: TeacherSurveyGap;
          assignmentSnap: DocumentSnapshot;
          surveySnap: DocumentSnapshot;
        }> = [];

        for (const gap of chunk) {
          const assignmentSnap = await transaction.get(
            userRef.collection("assignments").doc(gap.administrationId)
          );
          const surveySnap = await transaction.get(
            db.doc(gap.surveyResponsePath)
          );
          reads.push({ gap, assignmentSnap, surveySnap });
        }

        const statsRegistry = new AdminStatsBufferRegistry(db);
        const completedIds: string[] = [];
        for (const { gap, assignmentSnap, surveySnap } of reads) {
          if (!assignmentSnap.exists) continue;

          const prevData = assignmentSnap.data() as DocumentData;
          const fresh = gapForTeacherAssignment({
            uid,
            assignmentId: gap.administrationId,
            assignmentData: prevData,
            surveyResponseSnap: surveySnap,
          });
          if (!fresh) continue;

          const updates = buildReopenedTeacherSurveyUpdates(prevData);
          if (!updates) continue;

          recordAssignmentUpdatedStats(
            prevData as Parameters<typeof recordAssignmentUpdatedStats>[0],
            {
              ...prevData,
              ...updates,
            } as Parameters<typeof recordAssignmentUpdatedStats>[1],
            statsRegistry.forAdministration(gap.administrationId)
          );

          transaction.update(assignmentSnap.ref, {
            completed: updates.completed,
            assessments: updates.assessments,
            progress: updates.progress,
          });
          completedIds.push(gap.administrationId);
        }

        if (completedIds.length > 0) {
          const userUpdate: Record<string, unknown> = {
            "assignments.completed": FieldValue.arrayRemove(...completedIds),
          };
          for (const id of completedIds) {
            userUpdate[`assignmentsCompleted.${id}`] = FieldValue.delete();
          }
          transaction.update(userRef, userUpdate);
        }

        statsRegistry.flush(transaction);
        return completedIds;
      });

      const applied = new Set(appliedIds);
      for (const gap of chunk) {
        if (applied.has(gap.administrationId)) {
          outcome.set(gap.administrationId, {
            status: "repaired",
            message: "reopened teacher survey for generic classroom part",
          });
        } else {
          outcome.set(gap.administrationId, {
            status: "skipped",
            message: "no longer matched at apply time",
          });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const gap of chunk) {
        outcome.set(gap.administrationId, { status: "error", message });
      }
    }
  }

  return outcome;
}

async function main(): Promise<void> {
  const argv = yargs(hideBin(process.argv))
    .scriptName("reopen-cohort-teacher-classroom-surveys")
    .usage(
      "$0 [options]\n\nFinds open teacher-survey assignments completed on the" +
        " general section alone for cohort-only teachers, and reopens them for" +
        " the generic classroom part."
    )
    .options({
      env: {
        alias: ["e", "environment"],
        description: "Environment to run against",
        choices: ["dev", "prod"] as const,
        default: "dev" as const,
      },
      envFile: {
        alias: ["f", "env-file"],
        type: "string",
        default: ".env.local",
      },
      apply: {
        alias: "a",
        description: "Apply the reopen (omit for a dry run)",
        type: "boolean",
        default: false,
      },
      outputFile: {
        alias: "o",
        type: "string",
        default: "reopen-cohort-teacher-classroom-surveys.csv",
      },
    })
    .help("help")
    .alias("help", "h")
    .strict()
    .parseSync() as {
    env: "dev" | "prod";
    envFile: string;
    apply: boolean;
    outputFile: string;
  };

  const { app, db } = await initAdmin({
    environment: argv.env,
    envFile: argv.envFile,
    appName: "reopen-cohort-teacher-classroom-surveys",
  });

  try {
    console.log(`reopen-cohort-teacher-classroom-surveys (${argv.env})`);
    console.log(`Dry run: ${!argv.apply}`);

    const { gaps, teachersScanned } = await scanGaps(db, new Date());

    const rows: ResultRow[] = [];
    if (!argv.apply) {
      for (const gap of gaps) {
        rows.push({
          ...gap,
          status: "would-repair",
          message: "would reopen teacher survey for generic classroom part",
        });
      }
    } else {
      const byUid = new Map<string, TeacherSurveyGap[]>();
      for (const gap of gaps) {
        const list = byUid.get(gap.uid) ?? [];
        list.push(gap);
        byUid.set(gap.uid, list);
      }

      for (const [uid, userGaps] of byUid) {
        const outcome = await repairTeacher(db, uid, userGaps);
        for (const gap of userGaps) {
          const result = outcome.get(gap.administrationId) ?? {
            status: "error" as const,
            message: "missing apply outcome",
          };
          rows.push({ ...gap, ...result });
        }
      }
    }

    const csvPath = writeCsv(rows, argv.outputFile);
    const repaired = rows.filter((row) => row.status === "repaired").length;
    const wouldRepair = rows.filter(
      (row) => row.status === "would-repair"
    ).length;
    const skipped = rows.filter((row) => row.status === "skipped").length;
    const errors = rows.filter((row) => row.status === "error").length;

    console.log("=".repeat(60));
    console.log(`Teachers scanned         : ${teachersScanned}`);
    console.log(`Assignments matched      : ${gaps.length}`);
    if (argv.apply) {
      console.log(`Repaired                 : ${repaired}`);
      console.log(`Skipped                  : ${skipped}`);
      console.log(`Errors                   : ${errors}`);
    } else {
      console.log(`Would repair             : ${wouldRepair}`);
    }
    console.log(`CSV                      : ${csvPath}`);
    console.log("=".repeat(60));
  } finally {
    await deleteApp(app);
  }
}

const scriptPath = fileURLToPath(import.meta.url);
const isDirectRun = process.argv.some((arg) => {
  try {
    return resolve(arg) === scriptPath;
  } catch {
    return false;
  }
});

if (isDirectRun) {
  await main();
}
