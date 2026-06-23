import * as fs from "fs";
import * as path from "path";
import { type DocumentSnapshot, type Firestore } from "firebase-admin/firestore";
import yargs from "yargs";
import { initAdmin } from "./utils/init-admin.js";
import { getOpenAdministrations } from "./utils/get-open-assignments.js";

type SurveyProgressStatus = "assigned" | "started" | "completed";

type SurveyUserType = "student" | "teacher" | "caregiver";

const SURVEY_TASK_BY_USER_TYPE: Record<SurveyUserType, string> = {
  student: "child-survey",
  teacher: "teacher-survey",
  caregiver: "caregiver-survey",
};

const SURVEY_TASK_IDS = Object.values(SURVEY_TASK_BY_USER_TYPE);

const SURVEY_USER_TYPES = Object.keys(
  SURVEY_TASK_BY_USER_TYPE
) as SurveyUserType[];

const CSV_COLUMNS = [
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

interface CorruptedSurveyProgressRow {
  siteId: string;
  siteName: string;
  uid: string;
  administrationId: string;
  taskId: string;
  surveyResponsesStatus: SurveyProgressStatus;
  assessmentStatus: SurveyProgressStatus;
  progressStatus: SurveyProgressStatus;
  isCorrupted: boolean;
}

type SurveyResponseDoc = {
  completed?: boolean;
  general?: { isComplete?: boolean };
  specific?: { isComplete?: boolean }[];
};

type AssessmentRow = {
  taskId?: string;
  startedOn?: unknown;
  completedOn?: unknown;
};

function toCsvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function rowToCsvLine(row: CorruptedSurveyProgressRow): string {
  return CSV_COLUMNS.map((col) => toCsvCell(row[col])).join(",");
}

function normalizeSurveyUserType(userType: string): SurveyUserType | null {
  const normalized = userType.trim().toLowerCase();
  if (normalized === "student") return "student";
  if (normalized === "teacher") return "teacher";
  if (normalized === "caregiver" || normalized === "parent") return "caregiver";
  return null;
}

function userTypeMatchesRequested(
  docUserType: unknown,
  requested: SurveyUserType
): boolean {
  const normalized = normalizeSurveyUserType(
    typeof docUserType === "string" ? docUserType : ""
  );
  return normalized === requested;
}

function findAssessmentRow(
  assessments: AssessmentRow[],
  taskId: string
): AssessmentRow | undefined {
  return assessments.find((row) => row.taskId === taskId);
}

function assessmentStatusFromRow(
  assessment: AssessmentRow | undefined
): SurveyProgressStatus {
  if (!assessment) {
    return "assigned";
  }
  if (assessment.completedOn) {
    return "completed";
  }
  if (assessment.startedOn) {
    return "started";
  }
  return "assigned";
}

function progressStatusFromAssignment(
  progress: Record<string, unknown> | undefined,
  progressKey: string
): SurveyProgressStatus {
  const value = progress?.[progressKey];
  if (value === "assigned" || value === "started" || value === "completed") {
    return value;
  }
  return "assigned";
}

function allSpecificEntriesComplete(
  specific: { isComplete?: boolean }[] | undefined
): boolean {
  if (!Array.isArray(specific) || specific.length === 0) {
    return false;
  }
  return specific.every((entry) => entry.isComplete === true);
}

function teacherHasClasses(userData: Record<string, unknown>): boolean {
  const classes = userData.classes as { current?: string[] } | undefined;
  return Array.isArray(classes?.current) && classes.current.length > 0;
}

function caregiverHasLinkedChildren(userData: Record<string, unknown>): boolean {
  return (
    Array.isArray(userData.childIds) &&
    (userData.childIds as string[]).length > 0
  );
}

/** Adult surveys use `administrationId`; child-survey runs use `assignmentId` (same value). */
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

function surveyResponsesStatusForStudent(
  responseSnap: DocumentSnapshot | null
): SurveyProgressStatus {
  if (!responseSnap?.exists) {
    return "assigned";
  }
  const data = responseSnap.data() as SurveyResponseDoc;
  if (data.completed === true) {
    return "completed";
  }
  return "started";
}

function surveyResponsesStatusForAdult(
  responseSnap: DocumentSnapshot | null,
  userType: SurveyUserType,
  userData: Record<string, unknown>
): SurveyProgressStatus {
  if (!responseSnap?.exists) {
    return "assigned";
  }

  const data = responseSnap.data() as SurveyResponseDoc;
  const generalComplete = data.general?.isComplete === true;

  if (userType === "teacher") {
    if (!teacherHasClasses(userData)) {
      return generalComplete ? "completed" : "started";
    }
    if (generalComplete && allSpecificEntriesComplete(data.specific)) {
      return "completed";
    }
    return "started";
  }

  if (!caregiverHasLinkedChildren(userData)) {
    return generalComplete ? "completed" : "started";
  }
  if (generalComplete && allSpecificEntriesComplete(data.specific)) {
    return "completed";
  }
  return "started";
}

function buildRow(args: {
  siteId: string;
  siteName: string;
  uid: string;
  administrationId: string;
  userType: SurveyUserType;
  taskId: string;
  userData: Record<string, unknown>;
  assignmentData: Record<string, unknown>;
  responseSnap: DocumentSnapshot | null;
}): CorruptedSurveyProgressRow {
  const {
    siteId,
    siteName,
    uid,
    administrationId,
    userType,
    taskId,
    userData,
    assignmentData,
    responseSnap,
  } = args;

  const assessments = Array.isArray(assignmentData.assessments)
    ? (assignmentData.assessments as AssessmentRow[])
    : [];
  const progress = (assignmentData.progress ?? {}) as Record<string, unknown>;
  const progressKey = taskId.replace(/-/g, "_");

  const assessmentStatus = assessmentStatusFromRow(
    findAssessmentRow(assessments, taskId)
  );
  const progressStatus = progressStatusFromAssignment(progress, progressKey);
  const surveyResponsesStatus =
    userType === "student"
      ? surveyResponsesStatusForStudent(responseSnap)
      : surveyResponsesStatusForAdult(responseSnap, userType, userData);

  const isCorrupted = !(
    surveyResponsesStatus === assessmentStatus &&
    assessmentStatus === progressStatus
  );

  return {
    siteId,
    siteName,
    uid,
    administrationId,
    taskId,
    surveyResponsesStatus,
    assessmentStatus,
    progressStatus,
    isCorrupted,
  };
}

/** Firestore `getAll` is limited to 10 document refs per call. */
const FIRESTORE_GET_ALL_BATCH_SIZE = 10;

/** Parallel subcollection reads (avoids collection group index). */
const SURVEY_RESPONSE_READ_CONCURRENCY = 25;

async function loadUserDataByUid(
  db: Firestore,
  uids: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const uniqueUids = [...new Set(uids)];
  const byUid = new Map<string, Record<string, unknown>>();

  for (let i = 0; i < uniqueUids.length; i += FIRESTORE_GET_ALL_BATCH_SIZE) {
    const chunk = uniqueUids.slice(i, i + FIRESTORE_GET_ALL_BATCH_SIZE);
    const refs = chunk.map((uid) => db.collection("users").doc(uid));
    const snaps = await db.getAll(...refs);
    for (const snap of snaps) {
      if (snap.exists) {
        byUid.set(snap.id, snap.data() ?? {});
      }
    }
  }

  return byUid;
}

/**
 * Loads survey response docs per user subcollection (no collection group index).
 * Matches `administrationId` (adult surveys) or `assignmentId` (child-survey runs).
 */
async function loadSurveyResponsesByUid(
  db: Firestore,
  uids: string[],
  administrationId: string,
  taskIdByUid?: Map<string, string>
): Promise<Map<string, DocumentSnapshot>> {
  const uniqueUids = [...new Set(uids)];
  const byUid = new Map<string, DocumentSnapshot>();

  for (let i = 0; i < uniqueUids.length; i += SURVEY_RESPONSE_READ_CONCURRENCY) {
    const chunk = uniqueUids.slice(i, i + SURVEY_RESPONSE_READ_CONCURRENCY);
    await Promise.all(
      chunk.map(async (uid) => {
        const snap = await db
          .collection("users")
          .doc(uid)
          .collection("surveyResponses")
          .get();
        const taskId = taskIdByUid?.get(uid);
        const match = snap.docs.find((doc) =>
          surveyResponseMatchesAdministration(
            doc.data(),
            administrationId,
            taskId
          )
        );
        if (match) {
          byUid.set(uid, match);
        }
      })
    );
  }

  return byUid;
}

async function getSiteName(
  db: Firestore,
  cache: Map<string, string>,
  siteId: string
): Promise<string> {
  if (!siteId) {
    return "";
  }
  if (cache.has(siteId)) {
    return cache.get(siteId) as string;
  }

  const siteDoc = await db.collection("districts").doc(siteId).get();
  if (!siteDoc.exists) {
    const fallback = `MISSING_SITE(${siteId})`;
    cache.set(siteId, fallback);
    return fallback;
  }

  const siteData = siteDoc.data();
  const siteName =
    typeof siteData?.name === "string" && siteData.name.trim().length > 0
      ? siteData.name.trim()
      : `UNNAMED_SITE(${siteId})`;
  cache.set(siteId, siteName);
  return siteName;
}

async function scanAdministration(args: {
  db: Firestore;
  administrationId: string;
  siteId: string;
  siteName: string;
  surveyUserTypes: SurveyUserType[];
}): Promise<CorruptedSurveyProgressRow[]> {
  const { db, administrationId, siteId, siteName, surveyUserTypes } = args;

  const assignmentSnap = await db
    .collectionGroup("assignments")
    .where("id", "==", administrationId)
    .get();

  const uids = assignmentSnap.docs
    .map((doc) => doc.ref.parent.parent?.id)
    .filter((uid): uid is string => !!uid);

  const userDataByUid = await loadUserDataByUid(db, uids);
  const taskIdByUid = new Map<string, string>();
  for (const uid of uids) {
    const userData = userDataByUid.get(uid);
    if (!userData) {
      continue;
    }
    for (const userType of surveyUserTypes) {
      if (userTypeMatchesRequested(userData.userType, userType)) {
        taskIdByUid.set(uid, SURVEY_TASK_BY_USER_TYPE[userType]);
        break;
      }
    }
  }
  const surveyResponsesByUid = await loadSurveyResponsesByUid(
    db,
    uids,
    administrationId,
    taskIdByUid
  );
  const rows: CorruptedSurveyProgressRow[] = [];

  for (const assignmentDoc of assignmentSnap.docs) {
    const uid = assignmentDoc.ref.parent.parent?.id;
    if (!uid) {
      continue;
    }

    const userData = userDataByUid.get(uid);
    if (!userData) {
      continue;
    }

    const assignmentData = assignmentDoc.data();
    const assessments = Array.isArray(assignmentData.assessments)
      ? (assignmentData.assessments as AssessmentRow[])
      : [];
    const responseSnap = surveyResponsesByUid.get(uid) ?? null;

    for (const userType of surveyUserTypes) {
      if (!userTypeMatchesRequested(userData.userType, userType)) {
        continue;
      }

      const taskId = SURVEY_TASK_BY_USER_TYPE[userType];
      if (!findAssessmentRow(assessments, taskId)) {
        continue;
      }

      rows.push(
        buildRow({
          siteId,
          siteName,
          uid,
          administrationId,
          userType,
          taskId,
          userData,
          assignmentData,
          responseSnap,
        })
      );
    }
  }

  return rows;
}

async function scanOpenAdministrations(
  db: Firestore,
  siteId?: string
): Promise<{
  rows: CorruptedSurveyProgressRow[];
  administrationCount: number;
}> {
  const openAdmins = await getOpenAdministrations({
    db,
    siteId,
    taskIds: SURVEY_TASK_IDS,
    taskIdsMatch: "any",
  });
  console.log(
    `Open administrations with survey task(s): ${openAdmins.length}`
  );

  const siteNameCache = new Map<string, string>();
  const rows: CorruptedSurveyProgressRow[] = [];

  let adminIndex = 0;
  for (const admin of openAdmins) {
    adminIndex += 1;
    const assessments = admin.assessments as AssessmentRow[];

    const surveyUserTypes = SURVEY_USER_TYPES.filter((userType) =>
      findAssessmentRow(assessments, SURVEY_TASK_BY_USER_TYPE[userType])
    );

    const adminSiteName = await getSiteName(db, siteNameCache, admin.siteId);

    console.log(
      `[${adminIndex}/${openAdmins.length}] ${admin.id} — scanning ${surveyUserTypes.join(", ")}...`
    );

    const adminRows = await scanAdministration({
      db,
      administrationId: admin.id,
      siteId: admin.siteId,
      siteName: adminSiteName,
      surveyUserTypes,
    });
    rows.push(...adminRows);

    const corruptedInAdmin = adminRows.filter((row) => row.isCorrupted).length;
    console.log(
      `  ${adminRows.length} user row(s), ${corruptedInAdmin} corrupted`
    );
  }

  return {
    rows,
    administrationCount: openAdmins.length,
  };
}

function writeCsv(rows: CorruptedSurveyProgressRow[], outputFile: string): string {
  const outPath = path.resolve(process.cwd(), outputFile);
  fs.writeFileSync(
    outPath,
    [CSV_COLUMNS.join(","), ...rows.map(rowToCsvLine)].join("\n") + "\n",
    "utf8"
  );
  return outPath;
}

/** surveyResponses should be the source of truth; it must not trail assignment progress. */
function surveyResponsesBehindOtherStatuses(
  row: CorruptedSurveyProgressRow
): boolean {
  if (row.surveyResponsesStatus === "completed") {
    return false;
  }
  return (
    row.assessmentStatus === "completed" ||
    row.progressStatus === "completed"
  );
}

function printSurveyResponsesBehindReport(
  rows: CorruptedSurveyProgressRow[]
): void {
  const behind = rows
    .filter(surveyResponsesBehindOtherStatuses)
    .sort((a, b) =>
      a.uid.localeCompare(b.uid) || a.taskId.localeCompare(b.taskId)
    );

  console.log("\n" + "=".repeat(60));
  console.log("SURVEY RESPONSES BEHIND ASSIGNMENT (anomaly)");
  console.log("=".repeat(60));
  console.log(
    "surveyResponses is assigned or started, but assessment or progress is completed"
  );
  console.log(`Rows: ${behind.length}`);
  if (behind.length > 0) {
    console.table(
      behind.map((row) => ({
        uid: row.uid,
        taskId: row.taskId,
      }))
    );
  }
  console.log("=".repeat(60));
}

interface CliArgs {
  environment: "dev" | "prod";
  envFile: string;
  siteId?: string;
  outputFile: string;
  corruptedOnly: boolean;
}

const argv = yargs(process.argv.slice(2))
  .scriptName("identify-corrupted-survey-progress")
  .usage(
    "$0 [options]\n\nScans all open administrations with child-survey, teacher-survey," +
      " or caregiver-survey, compares surveyResponses to assignment progress per user," +
      " and writes corrupted-survey-progress-by-user.csv."
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
    siteId: {
      alias: "s",
      description: "Only include open administrations for this site (district id)",
      type: "string",
    },
    outputFile: {
      alias: "o",
      type: "string",
      default: "corrupted-survey-progress-by-user.csv",
    },
    corruptedOnly: {
      description: "Only include rows where isCorrupted is true",
      type: "boolean",
      default: false,
    },
  })
  .help("help")
  .alias("help", "h")
  .strict().argv as CliArgs;

async function main(): Promise<void> {
  console.log(`identify-corrupted-survey-progress (${argv.environment})`);
  console.log(`Survey tasks: ${SURVEY_TASK_IDS.join(", ")}`);
  if (argv.siteId) {
    console.log(`Site filter: ${argv.siteId}`);
  }

  const { db } = await initAdmin({
    environment: argv.environment,
    envFile: argv.envFile,
    appName: "identify-corrupted-survey-progress",
  });

  const { rows, administrationCount } = await scanOpenAdministrations(
    db,
    argv.siteId?.trim()
  );

  const outputRows = argv.corruptedOnly
    ? rows.filter((row) => row.isCorrupted)
    : rows;

  const outPath = writeCsv(outputRows, argv.outputFile);
  const corruptedCount = rows.filter((row) => row.isCorrupted).length;

  console.log("\n" + "=".repeat(60));
  console.log("IDENTIFY CORRUPTED SURVEY PROGRESS");
  console.log("=".repeat(60));
  console.log(`Administrations scanned: ${administrationCount}`);
  console.log(`Users scanned          : ${rows.length}`);
  console.log(`Corrupted rows         : ${corruptedCount}`);
  console.log(`Rows written to CSV    : ${outputRows.length}`);
  console.log(`Report                 : ${outPath}`);
  console.log("=".repeat(60));

  printSurveyResponsesBehindReport(rows);
}

main().catch((err) => {
  console.error("Fatal script error:", err);
  process.exit(1);
});
