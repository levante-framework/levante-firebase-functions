import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { v4 as uuidv4 } from "uuid";
import type { IOrgsList } from "../interfaces.js";
import { HttpsError } from "firebase-functions/v2/https";
import { ADMINISTRATOR_STATUS } from "../utils/constants.js";
import {
  buildRoleClaimsStructure,
  sanitizeRoles,
  type RoleDefinition,
} from "../utils/role-helpers.js";

export type AdministratorRoleDefinition = RoleDefinition;

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

  const roleClaims = buildRoleClaimsStructure(sanitizedRoles);

  const newClaims: Record<string, unknown> = {
    ...roleClaims,
    useNewPermissions: true,
    adminUid,
  };

  await auth.setCustomUserClaims(adminUid, newClaims);

  const adminDocData: Record<string, unknown> = {
    userType: "admin",
    archived: false,
    email,
    name,
    roles: roleClaims.roles,
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
      administrators: FieldValue.arrayUnion({
        adminUid,
        name,
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
