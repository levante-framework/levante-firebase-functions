import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import { FieldPath, Timestamp, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { isVisibleAssignment } from "../utils/assignment.js";
import { assertSiteAccess } from "../utils/offline-permissions.js";

/**
 * Everything an offline launcher needs to assess one administration's children
 * without a network: the task list with the params pinned on the administration, and
 * the roster of children who hold an assignment for it (with the birth data core-tasks
 * needs and the subset of tasks assigned to each). Assets are fetched by the device
 * itself from the public bucket.
 *
 * Identity is never minted here: children come only from existing user documents, so
 * runs synced later attribute to the same uids the online platform uses.
 */

interface ProvisionRequest {
  administrationId: string;
}

const MAX_CHILDREN = 2000;
const CONCURRENCY = 20;

export const provisionOfflinePack = onCall(async (request) => {
  const db = getFirestore();
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }
  const { administrationId } = (request.data ?? {}) as Partial<ProvisionRequest>;
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

  // Roster: students in the administration's sites who hold a visible assignment for it.
  const candidates = new Map<string, FirebaseFirestore.DocumentData>();
  for (const site of sites) {
    const snap = await db
      .collection("users")
      .where(new FieldPath("districts", "current"), "array-contains", site)
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
  }> = [];
  const uids = [...candidates.keys()];
  for (let i = 0; i < uids.length; i += CONCURRENCY) {
    await Promise.all(
      uids.slice(i, i + CONCURRENCY).map(async (uid) => {
        const assignment = await db.collection("users").doc(uid).collection("assignments").doc(administrationId).get();
        if (!assignment.exists || !isVisibleAssignment(assignment.data())) return;
        const data = candidates.get(uid)!;
        const name = (data.name ?? {}) as { first?: string; last?: string };
        const assigned = ((assignment.get("assessments") ?? []) as Array<{ taskId: string }>).map((a) => a.taskId);
        children.push({
          localId: uid,
          uid,
          // Minimal PII on the device: first name plus last initial, else the participant id.
          displayName: name.first ? `${name.first} ${name.last?.[0] ?? ""}`.trim() : (data.assessmentPid ?? uid),
          assessmentPid: data.assessmentPid ?? null,
          birthMonth: typeof data.birthMonth === "number" ? data.birthMonth : null,
          birthYear: typeof data.birthYear === "number" ? data.birthYear : null,
          taskIds: assigned,
        });
      })
    );
  }
  children.sort((a, b) => a.displayName.localeCompare(b.displayName));

  const dateClosed = admin.dateClosed instanceof Timestamp ? admin.dateClosed.toDate().toISOString() : null;
  const pack = {
    packId: `${administrationId}-${locale}`,
    administrationId,
    name: String(admin.publicName ?? admin.name ?? administrationId),
    locale,
    dateClosed,
    tasks,
    children,
    serverNowMs: Date.now(),
  };

  logger.info(request.auth.uid, "provisioned offline pack", {
    administrationId,
    locale,
    tasks: tasks.length,
    children: children.length,
  });
  return { status: "ok", pack };
});
