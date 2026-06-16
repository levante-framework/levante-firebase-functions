import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  GetSyncStatusParamsSchema,
  type GetSyncStatusResult,
} from "@levante-framework/levante-zod";
import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import {
  buildPermissionsUserFromAuthRecord,
  bulkCheckForSite,
  ensurePermissionsLoaded,
} from "../utils/permission-helpers.js";
import { fetchSyncStatusCounts } from "./site-utils.js";

export const getSyncStatus = onCall(
  async (req): Promise<GetSyncStatusResult> => {
    const uid = req.auth?.uid;
    if (!uid)
      throw new HttpsError("unauthenticated", "User must be authenticated");

    const parsed = GetSyncStatusParamsSchema.safeParse(req.data);
    if (!parsed.success) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid input",
        parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        }))
      );
    }
    const { siteId } = parsed.data;

    const userRecord = await getAuth().getUser(uid);
    // Legacy permissions
    // TODO: remove after migration
    if (userRecord.customClaims?.useNewPermissions !== true) {
      logger.warn("Permission denied for sync status: legacy permissions", {
        requestingUid: uid,
        siteId,
      });
      throw new HttpsError(
        "permission-denied",
        "New permission system must be enabled to view sync status"
      );
    }
    await ensurePermissionsLoaded();
    const user = buildPermissionsUserFromAuthRecord(userRecord);
    const checks = bulkCheckForSite(user, siteId, [
      { resource: RESOURCES.USERS, action: ACTIONS.READ },
      { resource: RESOURCES.ASSIGNMENTS, action: ACTIONS.READ },
    ]);
    const denied = checks.filter((c) => !c.allowed);
    if (denied.length > 0) {
      logger.warn("Permission denied for assignment/user sync status", {
        requestingUid: uid,
        siteId,
        denied: denied.map((c) => ({
          resource: c.resource,
          action: c.action,
          subResource: c.subResource,
        })),
      });
      throw new HttpsError(
        "permission-denied",
        `You do not have permission to view site ${siteId}`
      );
    }

    const db = getFirestore();
    const result = await fetchSyncStatusCounts(db, siteId);

    return result;
  }
);
