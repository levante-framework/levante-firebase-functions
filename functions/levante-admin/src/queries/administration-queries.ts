import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import _without from "lodash-es/without.js";
import _uniq from "lodash-es/uniq.js";
import { getAdministrationsForAdministrator } from "../administrations/administration-utils.js";
import { getOrgsBySite } from "./org-queries.js";

export const getAdministrationsPage = async ({
  uid,
  selectedDistrictId,
  fetchTestData = false,
  orderBy,
}: {
  uid: string;
  selectedDistrictId?: string | null;
  fetchTestData?: boolean;
  orderBy?: any[];
}) => {
  const idsOnly = false;
  const administrations = await getAdministrationsForAdministrator({
    adminUid: uid,
    testData: fetchTestData,
    idsOnly,
  });

  const administrationData = administrations.map((a) => {
    const assignedOrgs = {
      districts: a.districts ?? [],
      schools: a.schools ?? [],
      classes: a.classes ?? [],
      groups: a.groups ?? [],
      families: a.families ?? [],
    };
    return {
      id: a.id,
      name: a.name,
      publicName: a.publicName,
      dates: {
        start: a.dateOpened,
        end: a.dateClosed,
        created: a.dateCreated,
      },
      assessments: a.assessments,
      assignedOrgs,
      testData: a.testData ?? false,
      creatorName: a.creatorName,
    };
  });

  const db = getFirestore();
  const statsRefs = administrationData.map((admin) =>
    db.doc(`administrations/${admin.id}/stats/total`)
  );
  const statsDocs = await db.getAll(...statsRefs);
  const statsByAdminId = new Map(
    statsDocs.map((doc) => [doc.ref.parent.parent?.id, doc.data()])
  );

  let mapped = administrationData.map((admin) => ({
    ...admin,
    stats: { total: statsByAdminId.get(admin.id) },
  }));

  const siteId =
    selectedDistrictId && selectedDistrictId !== "any"
      ? selectedDistrictId
      : null;
  if (siteId) {
    const orgs = await getOrgsBySite({ uid, siteId });
    const orgIds = _uniq([siteId, ...orgs.map((org) => org.id)]);
    mapped = mapped.filter((admin) => {
      const assigned = admin.assignedOrgs;
      return orgIds.some(
        (orgId) =>
          assigned.districts.includes(orgId) ||
          assigned.schools.includes(orgId) ||
          assigned.classes.includes(orgId) ||
          assigned.groups.includes(orgId)
      );
    });
  }

  const orderField = orderBy?.[0]?.field?.fieldPath ?? "name";
  const orderDirection = orderBy?.[0]?.direction ?? "ASCENDING";
  const sortedAdministrations = _without(mapped, undefined)
    .filter((a) => a[orderField] !== undefined)
    .sort((a: any, b: any) => {
      if (orderDirection === "ASCENDING") return 2 * +(a[orderField] > b[orderField]) - 1;
      if (orderDirection === "DESCENDING") return 2 * +(b[orderField] > a[orderField]) - 1;
      return 0;
    });

  return { administrations: mapped, sortedAdministrations };
};

export const getAdminsBySite = async ({
  siteId,
}: {
  siteId: string;
}) => {
  const db = getFirestore();
  const adminSnapshot = await db
    .collection("users")
    .where("userType", "==", "admin")
    .select("email", "name", "roles", "adminOrgs", "createdAt")
    .get();

  const admins = adminSnapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  if (siteId === "any") return admins;

  const allowedSiteRoles = new Set([
    "admin",
    "site_admin",
    "research_assistant",
  ]);

  return admins.filter((admin) => {
    const roles = Array.isArray(admin.roles) ? admin.roles : [];
    return roles.some((role) => {
      const roleSiteId = role?.siteId;
      const roleName = role?.role;
      if (!roleSiteId || !roleName) return false;
      return roleSiteId === siteId && allowedSiteRoles.has(roleName);
    });
  });
};

export const validateAdministrationQueryInput = ({
  uid,
}: {
  uid?: string;
}) => {
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }
};
