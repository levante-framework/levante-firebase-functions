import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { ORG_TYPE_TO_COLLECTION } from "../orgs/constants.js";
import { assertSiteAccess } from "../utils/offline-permissions.js";

/**
 * The schools and cohorts an offline device can be scoped to for one administration.
 * A device is provisioned for one school or one cohort (not a whole site), so the
 * launcher asks for this list right after the proctor picks an administration.
 *
 * If the administration targets specific schools/cohorts, only those are offered;
 * otherwise every unarchived school and cohort under the administration's sites.
 */

export type OfflineScopeType = "school" | "cohort";

export interface OfflineScope {
  orgType: OfflineScopeType;
  orgId: string;
  name: string;
  siteId: string;
}

interface ListScopesRequest {
  administrationId: string;
}

export const listOfflineScopes = onCall(async (request) => {
  const db = getFirestore();
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }
  const { administrationId } = (request.data ?? {}) as Partial<ListScopesRequest>;
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
    `list scopes for administration ${administrationId}`
  );

  const scopes: OfflineScope[] = [
    ...(await loadScopes(db, "school", sites, (admin.schools ?? []) as string[])),
    ...(await loadScopes(db, "cohort", sites, (admin.groups ?? []) as string[])),
  ];
  scopes.sort((a, b) => a.orgType.localeCompare(b.orgType) || a.name.localeCompare(b.name));

  return { status: "ok", administrationId, siteIds: sites, scopes };
});

async function loadScopes(
  db: FirebaseFirestore.Firestore,
  orgType: OfflineScopeType,
  sites: string[],
  targeted: string[]
): Promise<OfflineScope[]> {
  const collection = ORG_TYPE_TO_COLLECTION[orgType];
  const siteField = orgType === "cohort" ? "parentOrgId" : "districtId";
  const docs: FirebaseFirestore.DocumentSnapshot[] = [];
  if (targeted.length > 0) {
    const snaps = await Promise.all(targeted.map((id) => db.collection(collection).doc(id).get()));
    docs.push(...snaps.filter((s) => s.exists));
  } else {
    for (const site of sites) {
      const snap = await db.collection(collection).where(siteField, "==", site).get();
      docs.push(...snap.docs);
    }
  }
  return docs
    .filter((d) => d.get("archived") !== true)
    .map((d) => ({
      orgType,
      orgId: d.id,
      name: String(d.get("name") ?? d.id),
      siteId: String(d.get(siteField) ?? ""),
    }))
    .filter((s) => sites.includes(s.siteId));
}
