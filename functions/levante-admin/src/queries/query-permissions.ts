import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  ACTIONS,
  RESOURCES,
  type PermissionResource,
} from "@levante-framework/permissions-core";
import {
  ensurePermissionsLoaded,
  buildPermissionsUserFromAuthRecord,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";

type ClaimsOrgMap = {
  districts?: string[];
  schools?: string[];
  classes?: string[];
  groups?: string[];
};

export const getUserClaims = async (uid: string) => {
  const db = getFirestore();
  const claimsRef = db.collection("userClaims").doc(uid);
  const claimsDoc = await claimsRef.get();
  if (!claimsDoc.exists) {
    throw new HttpsError("permission-denied", "User claims not found.");
  }
  return claimsDoc.data()?.claims ?? {};
};

const resolveSiteIdForOrg = async (
  orgType: string,
  orgId: string
): Promise<string> => {
  if (orgType === "districts") return orgId;

  const db = getFirestore();
  const orgDoc = await db.collection(orgType).doc(orgId).get();
  if (!orgDoc.exists) {
    throw new HttpsError("not-found", `Org ${orgType}/${orgId} not found.`);
  }
  const data = orgDoc.data() ?? {};

  if (orgType === "schools" || orgType === "classes") {
    const districtId = data.districtId as string | undefined;
    if (!districtId) {
      throw new HttpsError(
        "invalid-argument",
        `Org ${orgType}/${orgId} has no districtId.`
      );
    }
    return districtId;
  }

  if (orgType === "groups") {
    const parentOrgId = data.parentOrgId as string | undefined;
    const parentOrgType = data.parentOrgType as string | undefined;
    if (!parentOrgId) {
      throw new HttpsError(
        "invalid-argument",
        `Group ${orgId} has no parentOrgId.`
      );
    }
    if (!parentOrgType || parentOrgType === "district") return parentOrgId;
    return resolveSiteIdForOrg(parentOrgType, parentOrgId);
  }

  throw new HttpsError(
    "invalid-argument",
    `Unsupported orgType for site resolution: ${orgType}`
  );
};

const adminHasSiteAccess = async (adminOrgs: ClaimsOrgMap, siteId: string) => {
  if ((adminOrgs.districts ?? []).includes(siteId)) return true;

  const db = getFirestore();
  const schoolIds = adminOrgs.schools ?? [];
  const classIds = adminOrgs.classes ?? [];
  const groupIds = adminOrgs.groups ?? [];

  const schoolChecks = schoolIds.map((id) => db.collection("schools").doc(id).get());
  const classChecks = classIds.map((id) => db.collection("classes").doc(id).get());
  const groupChecks = groupIds.map((id) => db.collection("groups").doc(id).get());

  const [schoolDocs, classDocs, groupDocs] = await Promise.all([
    Promise.all(schoolChecks),
    Promise.all(classChecks),
    Promise.all(groupChecks),
  ]);

  const hasSchool = schoolDocs.some(
    (doc) => doc.exists && doc.data()?.districtId === siteId
  );
  const hasClass = classDocs.some(
    (doc) => doc.exists && doc.data()?.districtId === siteId
  );
  const hasGroup = groupDocs.some((doc) => {
    if (!doc.exists) return false;
    const data = doc.data() ?? {};
    if (data.parentOrgType === "district") return data.parentOrgId === siteId;
    return false;
  });

  return hasSchool || hasClass || hasGroup;
};

export const assertCanReadSite = async ({
  uid,
  siteId,
  resource = RESOURCES.USERS as PermissionResource,
}: {
  uid: string;
  siteId: string;
  resource?: PermissionResource;
}) => {
  const auth = getAuth();
  const userRecord = await auth.getUser(uid);
  const customClaims = (userRecord.customClaims as Record<string, unknown>) || {};
  const useNewPermissions = customClaims.useNewPermissions === true;

  if (useNewPermissions) {
    await ensurePermissionsLoaded();
    const user = buildPermissionsUserFromAuthRecord(userRecord);
    const allowed = filterSitesByPermission(user, [siteId], {
      resource,
      action: ACTIONS.READ,
    });
    if (allowed.length === 0) {
      throw new HttpsError(
        "permission-denied",
        `You do not have permission to read resource ${resource} in site ${siteId}`
      );
    }
    return;
  }

  const claims = await getUserClaims(uid);
  if (claims?.super_admin === true) return;

  const adminOrgs = (claims?.adminOrgs ?? {}) as ClaimsOrgMap;
  const hasAccess = await adminHasSiteAccess(adminOrgs, siteId);
  if (!hasAccess) {
    throw new HttpsError(
      "permission-denied",
      `You do not have permission to read site ${siteId}`
    );
  }
};

export const getSiteIdForOrg = async (orgType: string, orgId: string) =>
  resolveSiteIdForOrg(orgType, orgId);
