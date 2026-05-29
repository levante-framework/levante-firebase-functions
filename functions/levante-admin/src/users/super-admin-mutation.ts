import { logger } from "firebase-functions/v2";
import { HttpsError } from "firebase-functions/v2/https";
import type { UserRecord } from "firebase-admin/auth";
import { ROLES } from "../utils/constants.js";
import { sanitizeRoles } from "../utils/role-helpers.js";
import { _createAdministratorWithRoles } from "./create-administrator.js";
import type {
  AdministratorNameInput,
  AdministratorRoleDefinition,
} from "./create-administrator.js";
import {
  loadAdministratorContext,
  updateAdministratorRoles,
} from "./update-administrator.js";
import {
  buildPermissionsUserFromAuthRecord,
} from "../utils/permission-helpers.js";

const assertSuperAdminRolesOnly = (roles: ReturnType<typeof sanitizeRoles>) => {
  const invalid = roles.filter((r) => r.role !== ROLES.SUPER_ADMIN);
  if (invalid.length > 0) {
    throw new HttpsError(
      "invalid-argument",
      "Every role must use role super_admin"
    );
  }
};

export const createUpdateSuperAdmin = async (params: {
  requesterAdminUid: string;
  requesterRecord: UserRecord;
  email?: string;
  name?: { first: string; middle?: string; last: string };
  roles: unknown[];
  isTestData?: boolean;
  adminUid?: string;
}) => {
  const {
    requesterAdminUid,
    requesterRecord,
    email,
    name,
    roles,
    isTestData = false,
    adminUid: adminUidRaw,
  } = params;

  const customClaims = (requesterRecord.customClaims ?? {}) as Record<
    string,
    unknown
  >;
  if (customClaims.useNewPermissions !== true) {
    throw new HttpsError(
      "permission-denied",
      "New permission system must be enabled"
    );
  }

  const sanitizedRoles = sanitizeRoles(roles as AdministratorRoleDefinition[]);
  if (sanitizedRoles.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "A non-empty roles array is required"
    );
  }
  assertSuperAdminRolesOnly(sanitizedRoles);

  const requestingUser = buildPermissionsUserFromAuthRecord(requesterRecord);
  const requesterIsSuperAdmin = requestingUser.roles.some(
    (role) => role.role === ROLES.SUPER_ADMIN,
  );
  if (!requesterIsSuperAdmin) {
    throw new HttpsError(
      "permission-denied",
      "You do not have permission to create or update super administrators"
    );
  }

  const adminUid = typeof adminUidRaw === "string" ? adminUidRaw.trim() : "";

  logger.info("super-admin-mutation: validated input", {
    requesterAdminUid,
    roleCount: sanitizedRoles.length,
    isCreate: adminUid.length === 0,
    targetAdminUid: adminUid.length > 0 ? adminUid : undefined,
  });

  if (adminUid.length === 0) {
    if (!email || typeof email !== "string") {
      throw new HttpsError("invalid-argument", "A valid email is required");
    }
    if (!name?.first || !name?.last) {
      throw new HttpsError(
        "invalid-argument",
        "A valid name with first and last is required"
      );
    }
    logger.info("super-admin-mutation: creating super administrator", {
      requesterAdminUid,
      email,
      isTestData,
    });
    return _createAdministratorWithRoles({
      email,
      name: name as AdministratorNameInput,
      roles: sanitizedRoles,
      isTestData,
      requesterAdminUid,
    });
  }

  logger.info("super-admin-mutation: updating super administrator roles", {
    requesterAdminUid,
    targetAdminUid: adminUid,
  });
  const context = await loadAdministratorContext(adminUid);
  return updateAdministratorRoles({
    context,
    updatedRoles: sanitizedRoles,
  });
};
