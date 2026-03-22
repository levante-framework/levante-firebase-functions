import { HttpsError } from "firebase-functions/v2/https";
import type { UserRecord } from "firebase-admin/auth";
import {
  ACTIONS,
  RESOURCES,
  ROLES,
  ADMIN_SUB_RESOURCES,
} from "@levante-framework/permissions-core";
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
  ensurePermissionsLoaded,
  getPermissionService,
} from "../utils/permission-helpers.js";

const assertSuperAdminRolesOnly = (
  roles: ReturnType<typeof sanitizeRoles>
) => {
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
  await ensurePermissionsLoaded();

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

  const sanitizedRoles = sanitizeRoles(
    roles as AdministratorRoleDefinition[]
  );
  if (sanitizedRoles.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "A non-empty roles array is required"
    );
  }
  assertSuperAdminRolesOnly(sanitizedRoles);

  const requestingUser = buildPermissionsUserFromAuthRecord(requesterRecord);
  const permissionsService = getPermissionService();
  const subResource = ADMIN_SUB_RESOURCES.SUPER_ADMIN;

  const adminUid =
    typeof adminUidRaw === "string" ? adminUidRaw.trim() : "";

  if (adminUid.length === 0) {
    const allowed = permissionsService.canPerformGlobalAction(
      requestingUser,
      RESOURCES.ADMINS,
      ACTIONS.CREATE,
      subResource
    );
    if (!allowed) {
      throw new HttpsError(
        "permission-denied",
        "You do not have permission to create super administrators"
      );
    }
    if (!email || typeof email !== "string") {
      throw new HttpsError("invalid-argument", "A valid email is required");
    }
    if (!name?.first || !name?.last) {
      throw new HttpsError(
        "invalid-argument",
        "A valid name with first and last is required"
      );
    }
    return _createAdministratorWithRoles({
      email,
      name: name as AdministratorNameInput,
      roles: sanitizedRoles,
      isTestData,
      requesterAdminUid,
    });
  }

  const allowed = permissionsService.canPerformGlobalAction(
    requestingUser,
    RESOURCES.ADMINS,
    ACTIONS.UPDATE,
    subResource
  );
  if (!allowed) {
    throw new HttpsError(
      "permission-denied",
      "You do not have permission to update super administrators"
    );
  }

  const context = await loadAdministratorContext(adminUid);
  return updateAdministratorRoles({
    context,
    updatedRoles: sanitizedRoles,
  });
};
