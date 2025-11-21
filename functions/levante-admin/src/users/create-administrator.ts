import { getAuth } from "firebase-admin/auth";
import type { UserRecord } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { v4 as uuidv4 } from "uuid";
import type { IOrgsList } from "../interfaces.js";
import { HttpsError } from "firebase-functions/v2/https";
import { ADMINISTRATOR_STATUS } from "../utils/constants.js";
import {
  buildRoleClaimsStructure,
  sanitizeRoles,
  mergeRoleClaimsIntoClaims,
  type RoleDefinition,
} from "../utils/role-helpers.js";

export type AdministratorRoleDefinition = RoleDefinition;

export interface AdministratorNameInput {
  first: string;
  middle: string;
  last: string;
}

export interface CreateAdministratorWithRolesInput {
  email: string;
  name: AdministratorNameInput;
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

const buildGroupStructure = (groupIds?: string[]) => {
  if (!groupIds || groupIds.length === 0) {
    return {
      current: [],
      all: [],
      dates: {},
    };
  }

  const now = new Date();
  const dates = Object.fromEntries(
    groupIds.map((groupId) => [groupId, { from: now }])
  );

  return {
    current: groupIds,
    all: groupIds,
    dates,
  };
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

  if (!name.first) {
    throw new HttpsError("invalid-argument", "A valid name is required");
  }

  const trimmedName = {
    first: name.first.trim(),
    middle: name.middle?.trim(),
    last: name.last.trim(),
  };

  if (trimmedName.first.length === 0 || trimmedName.last.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "First and last name values are required"
    );
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

  const displayName = [trimmedName.first, trimmedName.middle, trimmedName.last]
    .filter(Boolean)
    .join(" ");
  logger.info("displayName: ", displayName);

  let adminUid: string;
  let roleClaims: ReturnType<typeof buildRoleClaimsStructure>;

  let existingUserRecord: UserRecord | null = null;
  try {
    existingUserRecord = await auth.getUserByEmail(email);
  } catch (error) {
    const errorCode = (error as { code?: string }).code;
    if (errorCode !== "auth/user-not-found") {
      logger.error("Error fetching user by email", { email, error });
      throw new HttpsError("internal", "Unable to look up existing user");
    }
  }

  const isExistingUser = Boolean(existingUserRecord);

  if (isExistingUser && existingUserRecord) {
    adminUid = existingUserRecord.uid;

    logger.debug("Appending roles to existing administrator", {
      requesterAdminUid,
      existingAdminUid: adminUid,
      roles: sanitizedRoles,
    });

    const currentClaims =
      (existingUserRecord.customClaims as Record<string, unknown>) ?? {};
    const { claims: normalizedClaims } =
      mergeRoleClaimsIntoClaims(currentClaims);

    const mergedRoleDefinitions = sanitizeRoles([
      ...normalizedClaims.roles,
      ...sanitizedRoles,
    ]);

    roleClaims = buildRoleClaimsStructure(mergedRoleDefinitions);

    const updatedClaims: Record<string, unknown> = {
      ...normalizedClaims,
      ...roleClaims,
      roles: roleClaims.roles,
      useNewPermissions: true,
      adminUid,
    };

    await auth.setCustomUserClaims(adminUid, updatedClaims);
  } else {
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

    roleClaims = buildRoleClaimsStructure(sanitizedRoles);

    const newClaims: Record<string, unknown> = {
      ...roleClaims,
      useNewPermissions: true,
      adminUid,
    };

    await auth.setCustomUserClaims(adminUid, newClaims);
  }

  logger.info("roleClaims: ", roleClaims);

  const adminUserDocRef = db.collection("users").doc(adminUid);

  if (isExistingUser) {
    const adminDocUpdates: Record<string, unknown> = {
      roles: roleClaims.roles,
      updatedAt: FieldValue.serverTimestamp(),
    };

    await adminUserDocRef.set(adminDocUpdates, { merge: true });
  } else {
    const adminDocData: Record<string, unknown> = {
      userType: "admin",
      archived: false,
      email,
      name: trimmedName,
      roles: roleClaims.roles,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      testData: isTestData,
    };

    for (const orgType of GROUP_TYPES) {
      adminDocData[orgType] = buildGroupStructure();
    }

    await adminUserDocRef.set(adminDocData);

    const userClaimsDocRef = db.collection("userClaims").doc(adminUid);
    await userClaimsDocRef.set({
      claims: {
        useNewPermissions: true,
        adminUid,
      },
    });
  }

  // update the district docs with new administrator data
  for (const role of sanitizedRoles) {
    const districtDocRef = db.collection("districts").doc(role.siteId);
    await districtDocRef.update({
      administrators: FieldValue.arrayUnion({
        adminUid,
        name: displayName,
        status: ADMINISTRATOR_STATUS.ACTIVE,
        role: role.role,
      }),
      updatedAt: FieldValue.serverTimestamp(),
    });
  }

  return {
    status: "ok" as const,
    adminUid,
  };
};
