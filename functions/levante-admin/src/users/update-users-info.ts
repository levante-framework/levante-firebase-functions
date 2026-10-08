import {
  UpdateUsersInfoParamsSchema,
  type UpdateUsersInfoResult,
} from "@levante-framework/levante-zod";
import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import _chunk from "lodash-es/chunk.js";
import _pick from "lodash-es/pick.js";
import type { User } from "../firestore-schema.js";
import type { IOrgsList } from "../interfaces.js";
import { ORG_NAMES } from "../interfaces.js";
import { syncAssignmentsForUserFieldChange } from "../administrations/sync-administrations.js";
import {
  buildPermissionsUserFromAuthRecord,
  ensurePermissionsLoaded,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";

/**
 * Callable that updates the `archived`, `disabled`, `birthMonth`, and
 * `birthYear` fields on user docs. The caller must have USERS/UPDATE permission
 * on every site each target user belongs to. Each field is optional per user;
 * any field omitted from the request is left untouched. `birthMonth`/`birthYear`
 * may only be set on child (student) users.
 *
 * Users with only `archived`/`disabled` changes are committed together via a
 * batch. Children whose birth fields change are handled one transaction each via
 * `syncAssignmentsForUserFieldChange`, which atomically persists the field change
 * and resyncs the child's open-administration assignments against the new birth
 * values. A child whose resync transaction fails is logged and dropped from the
 * returned `users`, leaving the rest of the request unaffected.
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

    // Users with only archived/disabled changes commit via a plain batch. Users
    // whose birth fields change need their assignments resynced atomically with
    // the field write (see syncAssignmentsForUserFieldChange), so they are
    // handled one transaction per user.
    const batchUpdates: Array<{
      uid: string;
      update: Record<string, unknown>;
    }> = [];
    const birthSyncTargets: Array<{
      uid: string;
      update: Record<string, unknown>;
      currentOrgs: IOrgsList;
      userDataOverride: Record<string, unknown>;
    }> = [];

    for (const user of users) {
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

      if (birthChanged) {
        const orgData = _pick(existing, ORG_NAMES) as Record<
          string,
          { current?: string[] } | undefined
        >;
        const currentOrgs: IOrgsList = {};
        for (const orgName of ORG_NAMES) {
          currentOrgs[orgName as keyof IOrgsList] =
            orgData[orgName]?.current ?? [];
        }
        birthSyncTargets.push({
          uid: user.uid,
          update,
          currentOrgs,
          // Derive from request + existing values (not a re-read of the doc) so
          // transaction retries evaluate conditions deterministically.
          userDataOverride: {
            birthMonth: user.birthMonth ?? existing?.birthMonth,
            birthYear: user.birthYear ?? existing?.birthYear,
          },
        });
      } else {
        batchUpdates.push({ uid: user.uid, update });
      }
    }

    for (const chunk of _chunk(batchUpdates, 500)) {
      const batch = db.batch();
      for (const { uid: targetUid, update } of chunk) {
        batch.update(usersRef.doc(targetUid), update);
      }
      await batch.commit();
    }

    const failedUids = new Set<string>();
    for (const target of birthSyncTargets) {
      try {
        await syncAssignmentsForUserFieldChange(
          target.uid,
          target.currentOrgs,
          target.update,
          target.userDataOverride
        );
      } catch (err) {
        logger.error("Failed to resync assignments for birth-date change", {
          uid: target.uid,
          error: err instanceof Error ? err.message : String(err),
        });
        failedUids.add(target.uid);
      }
    }

    return { users: users.filter((u) => !failedUids.has(u.uid)) };
  }
);
