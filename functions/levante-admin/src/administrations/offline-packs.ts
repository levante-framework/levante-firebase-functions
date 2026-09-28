import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { assertSiteAccess } from "../utils/offline-permissions.js";
import type { OfflineScopeType } from "./list-offline-scopes.js";

const COLLECTION = "offlinePacks";

export interface PreparedOfflinePack {
  packId: string;
  administrationId: string;
  assignmentName: string;
  orgType: OfflineScopeType;
  orgId: string;
  orgName: string;
  siteId: string;
  siteName: string;
}

interface SaveRequest {
  administrationId?: string;
  assignmentName?: string;
  orgType?: OfflineScopeType;
  orgId?: string;
  orgName?: string;
  siteId?: string;
  siteName?: string;
}

function isScopeType(value: unknown): value is OfflineScopeType {
  return value === "school" || value === "class" || value === "cohort";
}

function packIdOf(administrationId: string, orgType: string, orgId: string) {
  return `${administrationId}_${orgType}_${orgId}`;
}

/**
 * Remember a wizard-prepared offline pack: one assignment plus the cohort or
 * classroom whose children go on the tablet. Tablets list these instead of
 * every administration the researcher can see.
 */
export const saveOfflinePack = onCall(async (request) => {
  const db = getFirestore();
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }
  const body = (request.data ?? {}) as SaveRequest;
  const administrationId = body.administrationId;
  const orgId = body.orgId;
  const orgType = body.orgType;
  const siteId = body.siteId;
  if (
    !administrationId ||
    !orgId ||
    !siteId ||
    !isScopeType(orgType) ||
    typeof administrationId !== "string" ||
    typeof orgId !== "string" ||
    typeof siteId !== "string"
  ) {
    throw new HttpsError(
      "invalid-argument",
      "administrationId, orgType, orgId, and siteId are required"
    );
  }

  const adminSnap = await db
    .collection("administrations")
    .doc(administrationId)
    .get();
  if (!adminSnap.exists) {
    throw new HttpsError(
      "not-found",
      `Administration ${administrationId} not found`
    );
  }
  const sites = (adminSnap.get("districts") ?? []) as string[];
  if (!sites.includes(siteId)) {
    throw new HttpsError(
      "failed-precondition",
      "That site is not on this assignment"
    );
  }
  await assertSiteAccess(
    request.auth.uid,
    [siteId],
    { resource: RESOURCES.ASSIGNMENTS, action: ACTIONS.READ },
    `save offline pack for administration ${administrationId}`
  );

  const packId = packIdOf(administrationId, orgType, orgId);
  const assignmentName = String(
    body.assignmentName ||
      adminSnap.get("publicName") ||
      adminSnap.get("name") ||
      administrationId
  );
  const orgName = String(body.orgName || orgId);
  const siteName = String(body.siteName || siteId);
  await db.collection(COLLECTION).doc(packId).set({
    administrationId,
    assignmentName,
    orgType,
    orgId,
    orgName,
    siteId,
    siteName,
    updatedAt: FieldValue.serverTimestamp(),
    updatedBy: request.auth.uid,
  });

  return {
    status: "ok",
    pack: {
      packId,
      administrationId,
      assignmentName,
      orgType,
      orgId,
      orgName,
      siteId,
      siteName,
    } satisfies PreparedOfflinePack,
  };
});

export const listOfflinePacks = onCall(async (request) => {
  const db = getFirestore();
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }
  const snap = await db.collection(COLLECTION).limit(200).get();
  const packs: PreparedOfflinePack[] = [];
  const allowedSites = new Set<string>();
  const deniedSites = new Set<string>();

  for (const doc of snap.docs) {
    const siteId = String(doc.get("siteId") ?? "");
    const orgType = doc.get("orgType");
    if (!siteId || !isScopeType(orgType)) continue;
    if (deniedSites.has(siteId)) continue;
    if (!allowedSites.has(siteId)) {
      try {
        await assertSiteAccess(
          request.auth.uid,
          [siteId],
          { resource: RESOURCES.ASSIGNMENTS, action: ACTIONS.READ },
          `list offline packs for site ${siteId}`
        );
        allowedSites.add(siteId);
      } catch {
        deniedSites.add(siteId);
        continue;
      }
    }
    packs.push({
      packId: doc.id,
      administrationId: String(doc.get("administrationId") ?? ""),
      assignmentName: String(doc.get("assignmentName") ?? doc.id),
      orgType,
      orgId: String(doc.get("orgId") ?? ""),
      orgName: String(doc.get("orgName") ?? doc.get("orgId") ?? ""),
      siteId,
      siteName: String(doc.get("siteName") ?? siteId),
    });
  }

  packs.sort(
    (a, b) =>
      a.assignmentName.localeCompare(b.assignmentName) ||
      a.orgName.localeCompare(b.orgName)
  );
  return { status: "ok", packs };
});
