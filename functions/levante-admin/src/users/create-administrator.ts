import { getAuth } from "firebase-admin/auth";
import type { UserRecord } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import _uniqBy from "lodash-es/uniqBy.js";
import { v4 as uuidv4 } from "uuid";
import type { IOrgsList } from "../interfaces.js";
import { HttpsError } from "firebase-functions/v2/https";
import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import {
  ensurePermissionsLoaded,
  buildPermissionsUserFromAuthRecord,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";

export interface AdministratorRoleDefinition {
  siteId: string;
  role: string;
  siteName: string;
}

export interface CreateAdministratorWithRolesInput {
  email: string;
  name: string;
  roles: AdministratorRoleDefinition[];
  isTestData?: boolean;
  requesterAdminUid: string;
}

const GROUP_TYPES: Array<keyof IOrgsList> = [
  "districts",
  "schools",
  "classes",
  "groups",
];

const ADMINISTRATOR_STATUS_ACTIVE = "active";

const buildGroupStructure = (groupIds?: string[]) => {
  if (!groupIds || groupIds.length === 0) {
    return {
      current: [],
      all: [],
      dates: {},
    };
  }

  const now = new Date();
  const dates = Object.fromEntries(groupIds.map((groupId) => [groupId, { from: now }]));

  return {
    current: groupIds,
    all: groupIds,
    dates,
  };
};


export const sanitizeRoles = (roles: AdministratorRoleDefinition[]) => {
  if (!Array.isArray(roles)) {
    return [];
  }

  const cleaned = roles
    .filter((role) => role && typeof role === "object")
    .map((role) => ({
      siteId: String(role.siteId ?? "").trim(),
      role: String(role.role ?? "").trim(),
      siteName: String(role.siteName ?? "").trim(),
    }))
    .filter(
      (role) => role.siteId.length > 0 && role.role.length > 0 && role.siteName.length > 0
    );

  return _uniqBy(cleaned, (role) => `${role.siteId}::${role.role}`);
};

export const _createAdministratorWithRoles = async ({
  email,
  name,
  roles,
  isTestData = false,
  requesterAdminUid,
}: CreateAdministratorWithRolesInput) => {
  if (!email || typeof email !== "string") {
    throw new HttpsError("invalid-argument", "A valid email is required");
  }

  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new HttpsError("invalid-argument", "A display name is required");
  }

  const sanitizedRoles = sanitizeRoles(roles);
  if (sanitizedRoles.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "At least one valid role must be provided"
    );
  }

  const auth = getAuth();
  const db = getFirestore();

  const displayName = name.trim();

  let adminUid: string;

  const createdUser = await auth.createUser({
    email,
    emailVerified: false,
    disabled: false,
    displayName,
    password: uuidv4(),
  });
  adminUid = createdUser.uid;
  

  logger.debug("Creating administrator with roles", {
    requesterAdminUid,
    newAdminUid: adminUid,
    roles: sanitizedRoles,
  });

  const newClaims: Record<string, unknown> = {
    roles: sanitizedRoles,
    useNewPermissions: true,
    adminUid,
  };

  await auth.setCustomUserClaims(adminUid, newClaims);


  const adminDocData: Record<string, unknown> = {
    userType: "admin",
    archived: false,
    email,
    name,
    roles: sanitizedRoles,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    testData: isTestData,
  };

  for (const orgType of GROUP_TYPES) {
    adminDocData[orgType] = buildGroupStructure();
  }

  const adminUserDocRef = db.collection("users").doc(adminUid);
  await adminUserDocRef.set(adminDocData);

  // update the district docs with new administrator data
  for (const role of sanitizedRoles) {
    const districtDocRef = db.collection("districts").doc(role.siteId);
    await districtDocRef.update({
      administrators: FieldValue.arrayUnion({adminUid, name, status: "active", role: role.role}),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  return {
    status: "ok" as const,
    adminUid,
  };
};



const mutateAdministratorRoles = async ({
  adminUid,
  requesterAdminUid,
  nextRoles,
  allowEmptyRoles = false,
}: {
  adminUid: string;
  requesterAdminUid: string;
  nextRoles: AdministratorRoleDefinition[];
  allowEmptyRoles?: boolean;
}) => {
  if (!adminUid || typeof adminUid !== "string") {
    throw new HttpsError("invalid-argument", "A valid adminUid is required");
  }

  if (!Array.isArray(nextRoles)) {
    throw new HttpsError("invalid-argument", "Roles must be provided as an array");
  }

  const sanitizedNextRoles = sanitizeRoles(nextRoles);

  if (!allowEmptyRoles && sanitizedNextRoles.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "A non-empty roles array is required"
    );
  }

  const auth = getAuth();
  const db = getFirestore();

  let requesterRecord: UserRecord;
  try {
    requesterRecord = await auth.getUser(requesterAdminUid);
  } catch {
    throw new HttpsError("permission-denied", "Unable to load requesting administrator");
  }

  const requesterClaims: Record<string, unknown> = (requesterRecord.customClaims as Record<string, unknown>) ?? {};
  if (requesterClaims.useNewPermissions !== true) {
    throw new HttpsError(
      "permission-denied",
      "New permission system must be enabled to manage administrators with roles"
    );
  }

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

  await ensurePermissionsLoaded();
  const requestingUser = buildPermissionsUserFromAuthRecord(requesterRecord);

  const uniqueNextSiteIds = Array.from(
    new Set(sanitizedNextRoles.map((role) => role.siteId))
  );
  const uniquePreviousSiteIds = Array.from(
    new Set(previousRoles.map((role) => role.siteId))
  );
  const allSiteIds = Array.from(
    new Set([...uniquePreviousSiteIds, ...uniqueNextSiteIds])
  );

  const sitesRemoved: string[] = [];
  const sitesWithChanges = new Set<string>();

  for (const siteId of allSiteIds) {
    const prevRolesForSite = previousRoles
      .filter((role) => role.siteId === siteId)
      .map((role) => role.role)
      .sort()
      .join("|");
    const nextRolesForSite = sanitizedNextRoles
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
      : uniqueNextSiteIds;

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
      roles: sanitizedNextRoles,
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
    for (const role of sanitizedNextRoles) {
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

      const administrators = Array.isArray(districtSnapshot.data()?.administrators)
        ? (districtSnapshot.data()!.administrators as Array<Record<string, unknown>>)
        : [];

      const filteredAdministrators = administrators.filter(
        (entry) => entry?.adminUid !== adminUid
      );

      const rolesForSite = sanitizedNextRoles.filter(
        (role) => role.siteId === siteId
      );

      const updatedAdministrators = [...filteredAdministrators];

      for (const role of rolesForSite) {
        updatedAdministrators.push({
          adminUid,
          name: adminData.name,
          status: ADMINISTRATOR_STATUS_ACTIVE,
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
    roles: sanitizedNextRoles,
    useNewPermissions: true,
    adminUid,
  };

  await auth.setCustomUserClaims(adminUid, updatedClaims);

  return {
    status: "ok" as const,
    adminUid,
    roles: sanitizedNextRoles,
    removedSiteIds: sitesRemoved,
  };
};

export const _updateAdministratorWithRoles = async ({
  adminUid,
  roles,
  requesterAdminUid,
}: {
  adminUid: string;
  roles: AdministratorRoleDefinition[];
  requesterAdminUid: string;
}) => {
  return await mutateAdministratorRoles({
    adminUid,
    requesterAdminUid,
    nextRoles: roles,
    allowEmptyRoles: false,
  });
};

export const _removeAdministratorFromSite = async ({
  adminUid,
  siteId,
  requesterAdminUid,
}: {
  adminUid: string;
  siteId: string;
  requesterAdminUid: string;
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
    nextRoles: remainingRoles,
    allowEmptyRoles: true,
  });
};
