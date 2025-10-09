import { getAuth } from "firebase-admin/auth";
import type { UserRecord } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  ACTIONS,
  RESOURCES,
  type User as PermUser,
} from "@levante-framework/permissions-core";
import {
  ensurePermissionsLoaded,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";
import {
  sanitizeRoles,
  type AdministratorRoleDefinition,
} from "./create-administrator.js";
import { ADMINISTRATOR_STATUS } from "../utils/constants.js";



const mutateAdministratorRoles = async ({
  adminUid,
  requesterAdminUid,
  updatedRoles,
  requestingUser,
}: {
  adminUid: string;
  requesterAdminUid: string;
  updatedRoles: AdministratorRoleDefinition[];
  requestingUser: PermUser;
}) => {
  const auth = getAuth();
  const db = getFirestore();

  let targetRecord: UserRecord;
  try {
    targetRecord = await auth.getUser(adminUid);
  } catch {
    throw new HttpsError("not-found", "Administrator auth record not found");
  }

  const adminDocRef = db.collection("users").doc(adminUid);
  const adminDocSnapshot = await adminDocRef.get();

  if (!adminDocSnapshot.exists) {
    throw new HttpsError("not-found", "Administrator user document not found");
  }

  const adminData = adminDocSnapshot.data() as Record<string, unknown>;
  const previousRoles = sanitizeRoles(
    Array.isArray(adminData?.roles)
      ? (adminData.roles as AdministratorRoleDefinition[])
      : []
  );

  const uniqueUpdatedSiteIds = Array.from(
    new Set(updatedRoles.map((role) => role.siteId))
  );
  const uniquePreviousSiteIds = Array.from(
    new Set(previousRoles.map((role) => role.siteId))
  );
  const allSiteIds = Array.from(
    new Set([...uniquePreviousSiteIds, ...uniqueUpdatedSiteIds])
  );

  const sitesRemoved: string[] = [];
  const sitesWithChanges = new Set<string>();

  for (const siteId of allSiteIds) {
    const prevRolesForSite = previousRoles
      .filter((role) => role.siteId === siteId)
      .map((role) => role.role)
      .sort()
      .join("|");
    const nextRolesForSite = updatedRoles
      .filter((role) => role.siteId === siteId)
      .map((role) => role.role)
      .sort()
      .join("|");

    if (prevRolesForSite !== nextRolesForSite) {
      if (nextRolesForSite.length === 0) {
        sitesRemoved.push(siteId);
      } else {
        sitesWithChanges.add(siteId);
      }
    }
  }

  const sitesRequiringUpdatePermissions =
    sitesWithChanges.size > 0
      ? Array.from(sitesWithChanges)
      : uniqueUpdatedSiteIds;

  if (sitesRequiringUpdatePermissions.length > 0) {
    const allowedUpdateSites = filterSitesByPermission(
      requestingUser,
      sitesRequiringUpdatePermissions,
      {
        resource: RESOURCES.ADMINS,
        action: ACTIONS.UPDATE,
        subResource: "admin",
      }
    );

    if (allowedUpdateSites.length !== sitesRequiringUpdatePermissions.length) {
      const deniedSites = sitesRequiringUpdatePermissions.filter(
        (siteId) => !allowedUpdateSites.includes(siteId)
      );
      throw new HttpsError(
        "permission-denied",
        `You do not have permission to update administrators in sites: ${deniedSites.join(
          ", "
        )}`
      );
    }
  }

  if (sitesRemoved.length > 0) {
    const allowedDeleteSites = filterSitesByPermission(
      requestingUser,
      sitesRemoved,
      {
        resource: RESOURCES.ADMINS,
        action: ACTIONS.DELETE,
        subResource: "admin",
      }
    );

    if (allowedDeleteSites.length !== sitesRemoved.length) {
      const deniedSites = sitesRemoved.filter(
        (siteId) => !allowedDeleteSites.includes(siteId)
      );
      throw new HttpsError(
        "permission-denied",
        `You do not have permission to remove administrators from sites: ${deniedSites.join(
          ", "
        )}`
      );
    }
  }

  await db.runTransaction(async (transaction) => {
    const adminDoc = await transaction.get(adminDocRef);
    if (!adminDoc.exists) {
      throw new HttpsError("not-found", "Administrator user document not found");
    }

    transaction.update(adminDocRef, {
      roles: sanitizedUpdatedRoles,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const currentRoles = sanitizeRoles(
      Array.isArray(adminDoc.data()?.roles)
        ? (adminDoc.data()!.roles as AdministratorRoleDefinition[])
        : []
    );

    const siteIdsToProcess = new Set<string>();
    for (const role of currentRoles) {
      siteIdsToProcess.add(role.siteId);
    }
    for (const role of sanitizedUpdatedRoles) {
      siteIdsToProcess.add(role.siteId);
    }

    for (const siteId of siteIdsToProcess) {
      if (!siteId) {
        continue;
      }

      const districtDocRef = db.collection("districts").doc(siteId);
      const districtSnapshot = await transaction.get(districtDocRef);

      if (!districtSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          `District document ${siteId} not found`
        );
      }

      const administrators = Array.isArray(
        districtSnapshot.data()?.administrators
      )
        ? (districtSnapshot.data()!.administrators as Array<
            Record<string, unknown>
          >)
        : [];

      const filteredAdministrators = administrators.filter(
        (entry) => entry?.adminUid !== adminUid
      );

      const rolesForSite = sanitizedUpdatedRoles.filter(
        (role) => role.siteId === siteId
      );

      const updatedAdministrators = [...filteredAdministrators];

      for (const role of rolesForSite) {
        updatedAdministrators.push({
          adminUid,
          name: adminData.name,
          status: ADMINISTRATOR_STATUS.ACTIVE, // Todo update status depending on if removing or adding
          role: role.role,
        });
      }

      transaction.update(districtDocRef, {
        administrators: updatedAdministrators,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
  });

  const existingClaims: Record<string, unknown> =
    (targetRecord.customClaims as Record<string, unknown>) ?? {};
  const updatedClaims = {
    ...existingClaims,
    roles: sanitizedUpdatedRoles,
    useNewPermissions: true,
    adminUid,
  };

  await auth.setCustomUserClaims(adminUid, updatedClaims);

  return {
    status: "ok" as const,
    adminUid,
    roles: sanitizedUpdatedRoles,
    removedSiteIds: sitesRemoved,
  };
};

export const _updateAdministratorWithRoles = async ({
  adminUid,
  roles,
  requesterAdminUid,
  requestingUser,
}: {
  adminUid: string;
  roles: AdministratorRoleDefinition[];
  requesterAdminUid: string;
  requestingUser: PermUser;
}) => {
  return await mutateAdministratorRoles({
    adminUid,
    requesterAdminUid,
    updatedRoles: roles,
    allowEmptyRoles: false,
    requestingUser,
  });
};

export const _removeAdministratorFromSite = async ({
  adminUid,
  siteId,
  requesterAdminUid,
  requestingUser,
}: {
  adminUid: string;
  siteId: string;
  requesterAdminUid: string;
  requestingUser: PermUser;
}) => {
  if (!siteId || typeof siteId !== "string") {
    throw new HttpsError("invalid-argument", "A valid siteId is required");
  }

  const db = getFirestore();
  const adminDocRef = db.collection("users").doc(adminUid);
  const adminSnapshot = await adminDocRef.get();

  if (!adminSnapshot.exists) {
    throw new HttpsError("not-found", "Administrator user document not found");
  }

  const existingRoles = sanitizeRoles(
    Array.isArray(adminSnapshot.data()?.roles)
      ? (adminSnapshot.data()!.roles as AdministratorRoleDefinition[])
      : []
  );

  const remainingRoles = existingRoles.filter((role) => role.siteId !== siteId);

  if (remainingRoles.length === existingRoles.length) {
    throw new HttpsError(
      "not-found",
      `Administrator ${adminUid} is not assigned to site ${siteId}`
    );
  }

  return await mutateAdministratorRoles({
    adminUid,
    requesterAdminUid,
    updatedRoles: remainingRoles,
    allowEmptyRoles: true,
    requestingUser,
  });
};
