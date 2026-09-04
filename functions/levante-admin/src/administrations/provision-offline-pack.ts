import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import { FieldPath, FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { ORG_TYPE_TO_COLLECTION } from "../orgs/constants.js";
import { resolveSiteId } from "../orgs/helpers/resolve-site-id.js";
import { isVisibleAssignment } from "../utils/assignment.js";
import { parseDeviceInfo, touchDevice } from "../utils/offline-devices.js";
import { assertSiteAccess } from "../utils/offline-permissions.js";
import type { OfflineScopeType } from "./list-offline-scopes.js";

/**
 * Everything an offline launcher needs to assess one administration's children
 * without a network: the task list with the params pinned on the administration, and
 * the roster of children who hold an assignment for it (with the birth data core-tasks
 * needs, the subset of tasks assigned to each, and each child's progress as of now so a
 * second device knows what a first one already collected). Assets are fetched by the
 * device itself from the public bucket.
 *
 * A device is scoped to one school or one cohort of the administration; without a
 * scope the roster is every child in the administration's sites (small sites, or a
 * site with no schools/cohorts yet).
 *
 * Identity is never minted here: children come only from existing user documents, so
 * runs synced later attribute to the same uids the online platform uses.
 */

interface ProvisionRequest {
  administrationId: string;
  scope?: { orgType: OfflineScopeType; orgId: string } | null;
  device?: { deviceId: string; platform?: string; appBuild?: string } | null;
}

type ProgressState = "assigned" | "started" | "completed";

const MAX_CHILDREN = 2000;
const CONCURRENCY = 20;

export const provisionOfflinePack = onCall(async (request) => {
  const db = getFirestore();
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }
  const body = (request.data ?? {}) as Partial<ProvisionRequest>;
  const administrationId = body.administrationId;
  if (!administrationId || typeof administrationId !== "string") {
    throw new HttpsError("invalid-argument", "administrationId is required");
  }

  const adminSnap = await db.collection("administrations").doc(administrationId).get();
  if (!adminSnap.exists) {
    throw new HttpsError("not-found", `Administration ${administrationId} not found`);
  }
  const admin = adminSnap.data() ?? {};
  const sites = (admin.districts ?? []) as string[];
  await assertSiteAccess(
    request.auth.uid,
    sites,
    { resource: RESOURCES.ASSIGNMENTS, action: ACTIONS.READ },
    `provision administration ${administrationId}`
  );

  const scope = await resolveScope(db, body.scope, sites);

  const assessments = (admin.assessments ?? []) as Array<{
    taskId: string;
    variantId?: string;
    variantName?: string;
    params?: Record<string, unknown>;
  }>;
  if (assessments.length === 0) {
    throw new HttpsError("failed-precondition", "Administration has no assessments");
  }
  const tasks = assessments.map((a) => ({
    taskId: a.taskId,
    variantId: a.variantId ?? null,
    variantName: a.variantName ?? null,
    variantParams: a.params ?? {},
  }));
  const locale = String(tasks.find((t) => typeof t.variantParams.language === "string")?.variantParams.language ?? "en-US");

  // Roster: students in the scope (or the administration's sites) who hold a visible
  // assignment for it.
  const candidates = new Map<string, FirebaseFirestore.DocumentData>();
  const memberships: Array<{ field: string; orgId: string }> = scope
    ? [{ field: ORG_TYPE_TO_COLLECTION[scope.orgType], orgId: scope.orgId }]
    : sites.map((site) => ({ field: "districts", orgId: site }));
  for (const { field, orgId } of memberships) {
    const snap = await db
      .collection("users")
      .where(new FieldPath(field, "current"), "array-contains", orgId)
      .limit(MAX_CHILDREN)
      .get();
    for (const doc of snap.docs) {
      const data = doc.data();
      if (data.userType && data.userType !== "student") continue;
      candidates.set(doc.id, data);
    }
  }

  const children: Array<{
    localId: string;
    uid: string;
    displayName: string;
    assessmentPid: string | null;
    birthMonth: number | null;
    birthYear: number | null;
    taskIds: string[];
    progress: Record<string, ProgressState>;
  }> = [];
  const uids = [...candidates.keys()];
  for (let i = 0; i < uids.length; i += CONCURRENCY) {
    await Promise.all(
      uids.slice(i, i + CONCURRENCY).map(async (uid) => {
        const assignment = await db.collection("users").doc(uid).collection("assignments").doc(administrationId).get();
        if (!assignment.exists || !isVisibleAssignment(assignment.data())) return;
        const data = candidates.get(uid)!;
        const name = (data.name ?? {}) as { first?: string; last?: string };
        const assigned = (assignment.get("assessments") ?? []) as Array<{ taskId: string; completedOn?: unknown }>;
        children.push({
          localId: uid,
          uid,
          // Minimal PII on the device: first name plus last initial, else the participant id.
          displayName: name.first ? `${name.first} ${name.last?.[0] ?? ""}`.trim() : (data.assessmentPid ?? uid),
          assessmentPid: data.assessmentPid ?? null,
          birthMonth: typeof data.birthMonth === "number" ? data.birthMonth : null,
          birthYear: typeof data.birthYear === "number" ? data.birthYear : null,
          taskIds: assigned.map((a) => a.taskId),
          progress: progressOf(assigned, (assignment.get("progress") ?? {}) as Record<string, string>),
        });
      })
    );
  }
  children.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const dateClosed = admin.dateClosed instanceof Timestamp ? admin.dateClosed.toDate().toISOString() : null;
  const packId = scope ? `${administrationId}-${scope.orgType}-${scope.orgId}-${locale}` : `${administrationId}-${locale}`;
  const pack = {
    packId,
    administrationId,
    name: String(admin.publicName ?? admin.name ?? administrationId),
    siteId: scope?.siteId ?? sites[0] ?? null,
    scope,
    locale,
    dateClosed,
    tasks,
    children,
    serverNowMs: Date.now(),
  };

  const device = parseDeviceInfo(body.device);
  if (device) {
    await touchDevice(db, device, {
      siteId: pack.siteId,
      administrationId,
      packId,
      scope,
      locale,
      childCount: children.length,
      taskIds: tasks.map((t) => t.taskId),
      provisionedAt: FieldValue.serverTimestamp(),
      provisionedBy: request.auth.uid,
    });
  }

  logger.info(request.auth.uid, "provisioned offline pack", {
    administrationId,
    scope,
    locale,
    tasks: tasks.length,
    children: children.length,
    deviceId: device?.deviceId ?? null,
  });
  return { status: "ok", pack };
});

async function resolveScope(
  db: FirebaseFirestore.Firestore,
  scope: ProvisionRequest["scope"],
  sites: string[]
): Promise<{ orgType: OfflineScopeType; orgId: string; name: string; siteId: string } | null> {
  if (!scope) return null;
  if ((scope.orgType !== "school" && scope.orgType !== "cohort") || typeof scope.orgId !== "string" || !scope.orgId) {
    throw new HttpsError("invalid-argument", "scope must be {orgType: 'school' | 'cohort', orgId}");
  }
  const siteId = await resolveSiteId(db, scope.orgType, scope.orgId);
  if (!sites.includes(siteId)) {
    throw new HttpsError("failed-precondition", `${scope.orgType} ${scope.orgId} does not belong to this administration's site`);
  }
  const org = await db.collection(ORG_TYPE_TO_COLLECTION[scope.orgType]).doc(scope.orgId).get();
  return { orgType: scope.orgType, orgId: scope.orgId, name: String(org.get("name") ?? scope.orgId), siteId };
}

// The assignment's progress map is keyed by task id with underscores (and, from some
// writers, hyphens); a task with a completedOn stamp is completed regardless.
function progressOf(
  assigned: Array<{ taskId: string; completedOn?: unknown }>,
  progress: Record<string, string>
): Record<string, ProgressState> {
  const out: Record<string, ProgressState> = {};
  for (const a of assigned) {
    const raw = progress[a.taskId.replace(/-/g, "_")] ?? progress[a.taskId];
    out[a.taskId] = a.completedOn || raw === "completed" ? "completed" : raw === "started" ? "started" : "assigned";
  }
  return out;
}
