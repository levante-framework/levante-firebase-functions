import { getAuth } from "firebase-admin/auth";
import { HttpsError } from "firebase-functions/v2/https";
import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import {
  ensurePermissionsLoaded,
  buildPermissionsUserFromAuthRecord,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";

export async function assertCallerMayCreateUsers(params: {
  requestingUid: string;
  siteId?: string;
}): Promise<void> {
  const auth = getAuth();
  const userRecord = await auth.getUser(params.requestingUid);
  const customClaims: Record<string, unknown> = userRecord.customClaims || {};
  const useNewPermissions = customClaims.useNewPermissions === true;

  if (!useNewPermissions) {
    return;
  }

  await ensurePermissionsLoaded();
  const user = buildPermissionsUserFromAuthRecord(userRecord);
  const siteId = params.siteId;

  if (!siteId) {
    throw new HttpsError(
      "invalid-argument",
      "A siteId (or districtId) is required to create users"
    );
  }

  const allowed =
    filterSitesByPermission(user, [siteId], {
      resource: RESOURCES.USERS,
      action: ACTIONS.CREATE,
    }).length > 0;

  if (!allowed) {
    throw new HttpsError(
      "permission-denied",
      `You do not have permission to create users in site ${siteId}`
    );
  }
}
