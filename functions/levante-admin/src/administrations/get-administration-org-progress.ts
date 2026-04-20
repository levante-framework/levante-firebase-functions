import { getAuth } from "firebase-admin/auth";
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
import { getAdministrationsForAdministrator } from "./administration-utils.js";
import {
  ACTIONS,
  RESOURCES,
} from "@levante-framework/permissions-core";
import {
  ensurePermissionsLoaded,
  buildPermissionsUserFromAuthRecord,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";

export type OrgCollectionKey = keyof Pick<
  IOrgsList,
  "districts" | "schools" | "classes" | "groups"
>;

export type AssignmentRollupStatus = "notStarted" | "started" | "completed";

export interface TaskProgressBreakdown {
  taskId: string;
  variantId: string;
  variantName: string;
  counts: {
    notStarted: number;
    started: number;
    completed: number;
  };
  userIds: {
    notStarted: string[];
    started: string[];
    completed: string[];
  };
}

export interface TaskProgressSummaryRow {
  taskId: string;
  variantId: string;
  variantName: string;
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
  requestingUid: string,
  administrationId: string,
  siteId: string | undefined
) {
  const auth = getAuth();
  const userRecord = await auth.getUser(requestingUid);
  const customClaims: Record<string, unknown> = userRecord.customClaims || {};
  const useNewPermissions = customClaims.useNewPermissions === true;

  if (useNewPermissions) {
    await ensurePermissionsLoaded();
    const user = buildPermissionsUserFromAuthRecord(userRecord);
    if (!siteId) {
      throw new HttpsError(
        "failed-precondition",
        "Administration is missing siteId; cannot verify permissions"
      );
    }
    const allowed =
      filterSitesByPermission(user, [siteId], {
        resource: RESOURCES.ASSIGNMENTS,
        action: ACTIONS.UPDATE,
      }).length > 0;
    if (!allowed) {
      throw new HttpsError(
        "permission-denied",
        `You do not have permission to view administration progress for site ${siteId}`
      );
    }
  } else {
    let administrationIds: string[];
    try {
      administrationIds = (await getAdministrationsForAdministrator({
        adminUid: requestingUid,
        restrictToOpenAdministrations: false,
        idsOnly: true,
      })) as string[];
    } catch {
      throw new HttpsError(
        "permission-denied",
        "You do not have access to this administration"
      );
    }
    if (!administrationIds.includes(administrationId)) {
      throw new HttpsError(
        "permission-denied",
        "You do not have access to this administration"
      );
    }
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

  await assertCallerMayAccessAdministration(
    requestingUid,
    administrationId,
    adminData.siteId
  );

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

  const assignmentByUserId = new Map(
    assignmentSnaps.map((s) => [s.id, s])
  );
  const userById = new Map(userSnaps.map((s) => [s.id, s]));

  const taskProgress: TaskProgressBreakdown[] = taskDefinitions.map(
    (def) => ({
      taskId: def.taskId,
      variantId: def.variantId,
      variantName: def.variantName,
      counts: { notStarted: 0, started: 0, completed: 0 },
      userIds: { notStarted: [] as string[], started: [] as string[], completed: [] as string[] },
    })
  );

  const users: UserAdministrationProgressRow[] = [];

  for (const uid of userIds) {
    const userSnap = userById.get(uid);
    const userData = userSnap?.data();
    const email =
      typeof userData?.email === "string" ? userData.email : null;
    const userType = (userData?.userType as string) || "unknown";
    const role = pickRoleForSite(
      userData?.roles as { siteId: string; role: string }[] | undefined,
      adminData.siteId
    );

    const assignmentSnap = assignmentByUserId.get(uid);
    const assignmentData = assignmentSnap?.exists ? assignmentSnap.data() : null;
    const assessments = (assignmentData?.assessments || []) as AssessmentRow[];

    let rollup: AssignmentRollupStatus = "notStarted";
    let startedAt: string | null = null;
    let completedAt: string | null = null;

    if (assignmentData) {
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
      }
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
      const a = assessments.find((x) => x.taskId === def.taskId);
      let cell: "notStarted" | "started" | "completed" = "notStarted";
      if (a?.completedOn) {
        cell = "completed";
      } else if (a?.startedOn || a?.runId) {
        cell = "started";
      }
      row.counts[cell] += 1;
      row.userIds[cell].push(uid);
    }
  }

  const taskSummary: TaskProgressSummaryRow[] = taskProgress.map((t) => ({
    taskId: t.taskId,
    variantId: t.variantId,
    variantName: t.variantName,
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
