import {
  getFirestore,
  Timestamp,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import _chunk from "lodash-es/chunk.js";
import type { IOrgsList } from "../interfaces.js";
import { getAssignmentDocRef } from "../utils/assignment.js";
import { getUsersFromOrgs } from "../orgs/org-utils.js";

export type OrgCollectionKey = keyof Pick<
  IOrgsList,
  "districts" | "schools" | "classes" | "groups"
>;

export type AssignmentRollupStatus =
  | "notStarted"
  | "started"
  | "completed"
  | "notAssigned";

export interface TaskProgressBreakdown {
  taskId: string;
  variantId: string;
  variantName: string;
  counts: {
    notAssigned: number;
    notStarted: number;
    started: number;
    completed: number;
  };
  userIds: {
    notAssigned: string[];
    notStarted: string[];
    started: string[];
    completed: string[];
  };
}

export interface TaskProgressSummaryRow {
  taskId: string;
  variantId: string;
  variantName: string;
  notAssigned: number;
  notStarted: number;
  started: number;
  completed: number;
}

export interface UserAdministrationProgressRow {
  userId: string;
  email: string | null;
  userType: string;
  role: string | null;
  status: AssignmentRollupStatus;
  startedAt: string | null;
  completedAt: string | null;
}

export interface GetAdministrationOrgProgressResult {
  administrationId: string;
  orgId: string;
  orgType: OrgCollectionKey;
  taskProgress: TaskProgressBreakdown[];
  taskSummary: TaskProgressSummaryRow[];
  users: UserAdministrationProgressRow[];
}

function toIso(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value && "toDate" in value) {
    const d = (value as { toDate: () => Date }).toDate();
    return d instanceof Date && !Number.isNaN(d.getTime())
      ? d.toISOString()
      : null;
  }
  if (typeof value === "string" || typeof value === "number") {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

async function resolveOrgType(
  db: Firestore,
  orgId: string
): Promise<OrgCollectionKey> {
  const checks: { type: OrgCollectionKey; collection: string }[] = [
    { type: "districts", collection: "districts" },
    { type: "schools", collection: "schools" },
    { type: "classes", collection: "classes" },
    { type: "groups", collection: "groups" },
  ];
  for (const { type, collection } of checks) {
    const snap = await db.collection(collection).doc(orgId).get();
    if (snap.exists) return type;
  }
  throw new HttpsError(
    "not-found",
    "No organization found for orgId in districts, schools, classes, or groups"
  );
}

function pickRoleForSite(
  roles: { siteId: string; role: string }[] | undefined,
  siteId: string | undefined
): string | null {
  if (!roles?.length) return null;
  if (siteId) {
    const match = roles.find((r) => r.siteId === siteId);
    if (match) return match.role;
  }
  return roles[0]?.role ?? null;
}

type AssessmentRow = {
  taskId: string;
  optional?: boolean;
  startedOn?: unknown;
  completedOn?: unknown;
  runId?: string;
};

function missingAnyAssessmentRow(
  taskDefinitions: { taskId: string }[],
  assessments: AssessmentRow[]
): boolean {
  return taskDefinitions.some(
    (def) => !assessments.some((a) => a.taskId === def.taskId)
  );
}

function classifyTaskForUser(
  assessments: AssessmentRow[],
  taskId: string
): "notAssigned" | "notStarted" | "started" | "completed" {
  const a = assessments.find((x) => x.taskId === taskId);
  if (!a) return "notAssigned";
  if (a.completedOn) return "completed";
  if (a.startedOn || a.runId) return "started";
  return "notStarted";
}

async function chunkedGetAll(
  db: Firestore,
  refs: DocumentReference[]
): Promise<DocumentSnapshot[]> {
  const snapshots: DocumentSnapshot[] = [];
  for (const part of _chunk(refs, 10)) {
    const got = await db.getAll(...part);
    snapshots.push(...got);
  }
  return snapshots;
}

async function assertCallerMayAccessAdministration(
  db: Firestore,
  requestingUid: string,
  siteId: string | undefined
) {
  const userSnap = await db.collection("users").doc(requestingUid).get();
  if (!userSnap.exists) {
    throw new HttpsError("permission-denied", "User profile not found");
  }

  const userData = userSnap.data() as {
    userType?: string;
    archived?: boolean;
    roles?: { siteId: string; role: string; siteName?: string }[];
  };

  if (userData.archived) {
    throw new HttpsError("permission-denied", "Account is archived");
  }

  if (userData.userType !== "admin") {
    throw new HttpsError(
      "permission-denied",
      "Only administrators may access this function"
    );
  }

  const roles = userData.roles ?? [];
  if (roles.some((r) => r.role === "super_admin")) {
    return;
  }

  if (!siteId) {
    throw new HttpsError(
      "failed-precondition",
      "Administration is missing siteId; cannot verify site access"
    );
  }

  const assignedToSite = roles.some((r) => r.siteId === siteId);
  if (!assignedToSite) {
    throw new HttpsError(
      "permission-denied",
      "You do not have access to administrations for this site"
    );
  }
}

export async function getAdministrationOrgProgressHandler(
  requestingUid: string,
  data: {
    administrationId: string;
    orgId: string;
    orgType?: OrgCollectionKey;
  }
): Promise<GetAdministrationOrgProgressResult> {
  const { administrationId, orgId } = data;
  if (!administrationId || typeof administrationId !== "string") {
    throw new HttpsError(
      "invalid-argument",
      "administrationId is required and must be a string"
    );
  }
  if (!orgId || typeof orgId !== "string") {
    throw new HttpsError(
      "invalid-argument",
      "orgId is required and must be a string"
    );
  }

  const db = getFirestore();
  let orgType: OrgCollectionKey;
  if (data.orgType) {
    const orgSnap = await db.collection(data.orgType).doc(orgId).get();
    if (!orgSnap.exists) {
      throw new HttpsError(
        "not-found",
        `Organization ${orgId} was not found in ${data.orgType}`
      );
    }
    orgType = data.orgType;
  } else {
    orgType = await resolveOrgType(db, orgId);
  }

  const adminSnap = await db
    .collection("administrations")
    .doc(administrationId)
    .get();
  if (!adminSnap.exists) {
    throw new HttpsError("not-found", "Administration not found");
  }

  const adminData = adminSnap.data() as {
    siteId?: string;
    assessments?: {
      taskId: string;
      variantId: string;
      variantName: string;
    }[];
  };

  await assertCallerMayAccessAdministration(db, requestingUid, adminData.siteId);

  const taskDefinitions = adminData.assessments ?? [];
  if (taskDefinitions.length === 0) {
    logger.warn("Administration has no assessments", { administrationId });
  }

  const orgs: IOrgsList = { [orgType]: [orgId] };
  const userIds = await db.runTransaction(async (transaction) => {
    return getUsersFromOrgs({
      orgs,
      transaction,
      userTypes: ["student", "parent", "teacher"],
      includeArchived: false,
    });
  });

  const assignmentRefs = userIds.map((uid) =>
    getAssignmentDocRef(db, uid, administrationId)
  );
  const userRefs = userIds.map((uid) => db.collection("users").doc(uid));

  const [assignmentSnaps, userSnaps] = await Promise.all([
    chunkedGetAll(db, assignmentRefs),
    chunkedGetAll(db, userRefs),
  ]);

  const assignmentByUserId = new Map<string, DocumentSnapshot>();
  for (let i = 0; i < userIds.length; i++) {
    assignmentByUserId.set(userIds[i]!, assignmentSnaps[i]!);
  }
  const userById = new Map(userSnaps.map((s) => [s.id, s]));

  const assignedUserIds = userIds.filter((uid) =>
    assignmentByUserId.get(uid)?.exists
  );

  const taskProgress: TaskProgressBreakdown[] = taskDefinitions.map(
    (def) => ({
      taskId: def.taskId,
      variantId: def.variantId,
      variantName: def.variantName,
      counts: {
        notAssigned: 0,
        notStarted: 0,
        started: 0,
        completed: 0,
      },
      userIds: {
        notAssigned: [] as string[],
        notStarted: [] as string[],
        started: [] as string[],
        completed: [] as string[],
      },
    })
  );

  const users: UserAdministrationProgressRow[] = [];

  for (const uid of assignedUserIds) {
    const userSnap = userById.get(uid);
    const userData = userSnap?.data();
    const email =
      typeof userData?.email === "string" ? userData.email : null;
    const userType = (userData?.userType as string) || "unknown";
    const role = pickRoleForSite(
      userData?.roles as { siteId: string; role: string }[] | undefined,
      adminData.siteId
    );

    const assignmentSnap = assignmentByUserId.get(uid)!;
    const assignmentData = assignmentSnap.data() ?? {};
    const assessments = (assignmentData.assessments || []) as AssessmentRow[];

    let rollup: AssignmentRollupStatus = "notStarted";
    let startedAt: string | null = null;
    let completedAt: string | null = null;

    const startedOns = assessments
      .map((a) => toIso(a.startedOn))
      .filter((x): x is string => Boolean(x));
    const completedOns = assessments
      .map((a) => toIso(a.completedOn))
      .filter((x): x is string => Boolean(x));

    if (startedOns.length > 0) {
      startedAt = startedOns.sort()[0]!;
    }
    if (completedOns.length > 0) {
      completedAt = completedOns.sort().at(-1)!;
    }

    if (assignmentData.completed === true) {
      rollup = "completed";
    } else if (
      assignmentData.started === true ||
      assessments.some((a) => a.startedOn || a.runId)
    ) {
      rollup = "started";
    } else if (missingAnyAssessmentRow(taskDefinitions, assessments)) {
      rollup = "notAssigned";
    }

    users.push({
      userId: uid,
      email,
      userType,
      role,
      status: rollup,
      startedAt,
      completedAt,
    });

    for (let i = 0; i < taskDefinitions.length; i++) {
      const def = taskDefinitions[i]!;
      const row = taskProgress[i]!;
      const cell = classifyTaskForUser(assessments, def.taskId);
      row.counts[cell] += 1;
      row.userIds[cell].push(uid);
    }
  }

  const taskSummary: TaskProgressSummaryRow[] = taskProgress.map((t) => ({
    taskId: t.taskId,
    variantId: t.variantId,
    variantName: t.variantName,
    notAssigned: t.counts.notAssigned,
    notStarted: t.counts.notStarted,
    started: t.counts.started,
    completed: t.counts.completed,
  }));

  return {
    administrationId,
    orgId,
    orgType,
    taskProgress,
    taskSummary,
    users,
  };
}
