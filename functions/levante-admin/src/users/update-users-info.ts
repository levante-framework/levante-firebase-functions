import {
  type UpdateUsersInfoParams,
  UpdateUsersInfoParamsSchema,
  type UpdateUsersInfoResult,
} from "@levante-framework/levante-zod";
import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import _chunk from "lodash-es/chunk.js";
import type { User } from "../firestore-schema.js";
import {
  buildPermissionsUserFromAuthRecord,
  ensurePermissionsLoaded,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";

/**
 * Callable that updates the `archived`, `disabled`, `birthMonth`, and
 * `birthYear` fields on user docs. The caller must have USERS/UPDATE permission
 * on every site each target user belongs to. Each field is optional per user;
 * any field omitted from the request is left untouched.
 */
export const updateUsersInfo = onCall(
  async (req): Promise<UpdateUsersInfoResult> => {
    const uid = req.auth?.uid;
    if (!uid)
      throw new HttpsError("unauthenticated", "User must be authenticated");

    const parsed = UpdateUsersInfoParamsSchema.safeParse(req.data);
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", "Invalid input", {
        code: "schema",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const { users } = parsed.data;

    const userRecord = await getAuth().getUser(uid);
    // Legacy permissions
    // TODO: remove after migration
    if (userRecord.customClaims?.useNewPermissions !== true) {
      logger.warn(
        "Permission denied for updating user info: legacy permissions",
        { requestingUid: uid }
      );
      throw new HttpsError(
        "permission-denied",
        "New permission system must be enabled to update user info"
      );
    }

    const db = getFirestore();
    const usersRef = db.collection("users");
    const snaps = await db.getAll(...users.map((u) => usersRef.doc(u.uid)));

    const missing = snaps.filter((snap) => !snap.exists);
    if (missing.length > 0) {
      throw new HttpsError("not-found", "Users not found", {
        code: "users",
        uids: missing.map((snap) => snap.id),
      });
    }

    await ensurePermissionsLoaded();
    const permissionsUser = buildPermissionsUserFromAuthRecord(userRecord);

    const requestedSites = [
      ...new Set(
        snaps.flatMap((snap) => snap.data()?.districts?.current ?? [])
      ),
    ];
    const allowedSites = new Set(
      filterSitesByPermission(permissionsUser, requestedSites, {
        resource: RESOURCES.USERS,
        action: ACTIONS.UPDATE,
      })
    );
    const unauthorized = snaps.filter((snap) => {
      const sites: string[] = snap.data()?.districts?.current ?? [];
      return (
        sites.length === 0 || sites.some((siteId) => !allowedSites.has(siteId))
      );
    });
    if (unauthorized.length > 0) {
      logger.warn("Permission denied for updating user info", {
        requestingUid: uid,
        uids: unauthorized.map((snap) => snap.id),
      });
      throw new HttpsError(
        "permission-denied",
        "You do not have permission to update the requested users"
      );
    }

    const dataByUid = new Map(
      snaps.map((snap) => [snap.id, snap.data() as Partial<User>])
    );
    const nonChildBirthFieldUids = users
      .filter(
        (user) =>
          (user.birthMonth !== undefined || user.birthYear !== undefined) &&
          dataByUid.get(user.uid)?.userType !== "student"
      )
      .map((user) => user.uid);
    if (nonChildBirthFieldUids.length > 0) {
      throw new HttpsError(
        "invalid-argument",
        "birthMonth and birthYear can only be set for child users",
        {
          code: "child-only-fields",
          uids: nonChildBirthFieldUids,
        }
      );
    }

    for (const chunk of _chunk(
      users,
      500
    ) as UpdateUsersInfoParams["users"][]) {
      const batch = db.batch();
      for (const user of chunk) {
        const existing = dataByUid.get(user.uid);
        const update: Record<string, unknown> = {};
        if (user.archived !== undefined) update.archived = user.archived;
        if (user.disabled !== undefined) update.disabled = user.disabled;
        let birthChanged = false;
        if (
          user.birthMonth !== undefined &&
          user.birthMonth !== existing?.birthMonth
        ) {
          update.birthMonth = user.birthMonth;
          birthChanged = true;
        }
        if (
          user.birthYear !== undefined &&
          user.birthYear !== existing?.birthYear
        ) {
          update.birthYear = user.birthYear;
          birthChanged = true;
        }
        if (birthChanged) {
          update.birthDateUpdatedAt = FieldValue.serverTimestamp();
        }
        if (Object.keys(update).length === 0) continue;
        update.updatedAt = FieldValue.serverTimestamp();
        batch.update(usersRef.doc(user.uid), update);
      }
      await batch.commit();
    }

    return { users };
  }
);
