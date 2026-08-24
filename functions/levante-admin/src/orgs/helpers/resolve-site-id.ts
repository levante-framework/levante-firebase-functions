import type { Firestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { ORG_TYPE_TO_COLLECTION } from "../constants.js";

/** Resolves the id of the site that owns the given org. */
export async function resolveSiteId(
  db: Firestore,
  orgType: "site" | "school" | "class" | "cohort",
  orgId: string
): Promise<string> {
  if (orgType === "site") return orgId;

  const snap = await db
    .collection(ORG_TYPE_TO_COLLECTION[orgType])
    .doc(orgId)
    .get();
  if (!snap.exists) {
    throw new HttpsError("not-found", `Org not found`, {
      code: "org",
      orgType,
      orgId,
    });
  }
  const doc = snap.data() ?? {};

  const siteId = orgType === "cohort" ? doc.parentOrgId : doc.districtId;
  if (typeof siteId !== "string") {
    throw new HttpsError("internal", "Org has no site", {
      code: "org-site-missing",
      orgType,
      orgId,
      siteId,
    });
  }

  return siteId;
}
