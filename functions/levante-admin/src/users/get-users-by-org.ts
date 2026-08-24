import {
  GetUsersByOrgParamsSchema,
  type GetUsersByOrgResult,
} from "@levante-framework/levante-zod";
import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import { getAuth } from "firebase-admin/auth";
import { FieldPath, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { ORG_TYPE_TO_COLLECTION } from "../orgs/constants.js";
import { resolveSiteId } from "../orgs/helpers/resolve-site-id.js";
import {
  buildPermissionsUserFromAuthRecord,
  ensurePermissionsLoaded,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";
import { ROAR_TO_LEVANTE_USERTYPE } from "./user-utils.js";

export const getUsersByOrg = onCall(
  async (req): Promise<GetUsersByOrgResult> => {
    const uid = req.auth?.uid;
    if (!uid)
      throw new HttpsError("unauthenticated", "User must be authenticated");

    const parsed = GetUsersByOrgParamsSchema.safeParse(req.data);
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", "Invalid request parameters", {
        code: "schema",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const { orgType, orgId } = parsed.data;

    const auth = getAuth();
    const userRecord = await auth.getUser(uid);
    // Legacy permissions
    // TODO: remove after migration
    if (userRecord.customClaims?.useNewPermissions !== true) {
      logger.warn(
        "Permission denied for getting users by org: legacy permissions",
        {
          requestingUid: uid,
        }
      );
      throw new HttpsError(
        "permission-denied",
        "New permission system must be enabled to get users by org"
      );
    }

    const db = getFirestore();
    const siteId = await resolveSiteId(db, orgType, orgId);

    await ensurePermissionsLoaded();
    const user = buildPermissionsUserFromAuthRecord(userRecord);
    const allowed =
      filterSitesByPermission(user, [siteId], {
        resource: RESOURCES.USERS,
        action: ACTIONS.READ,
      }).length > 0;
    if (!allowed) {
      logger.warn("Permission denied for getting users by org", {
        requestingUid: uid,
        orgType,
        orgId,
        siteId,
      });
      throw new HttpsError(
        "permission-denied",
        `You do not have permission to read users in ${orgType} ${orgId}`
      );
    }

    const usersSnap = await db
      .collection("users")
      .where(
        new FieldPath(ORG_TYPE_TO_COLLECTION[orgType], "current"),
        "array-contains",
        orgId
      )
      .where("archived", "==", false)
      .where("disabled", "==", false)
      .select("email", "userType", "childLabelIndex")
      .get();

    const users: GetUsersByOrgResult["users"] = [];
    const invalidUsers: { uid: string; [key: string]: unknown }[] = [];
    for (const doc of usersSnap.docs) {
      const roarUserType = doc.get("userType");
      const userType = ROAR_TO_LEVANTE_USERTYPE[roarUserType];
      const email = doc.get("email");
      const childLabelIndex = doc.get("childLabelIndex");

      if (!userType || typeof email !== "string") {
        invalidUsers.push({ uid: doc.id, userType: roarUserType, email });
        continue;
      }

      users.push({
        uid: doc.id,
        email,
        userType,
        ...(typeof childLabelIndex === "number" ? { childLabelIndex } : {}),
      });
    }
    if (invalidUsers.length > 0) {
      logger.warn("Skipped invalid user docs", {
        orgType,
        orgId,
        users: invalidUsers,
      });
    }

    return { users };
  }
);
