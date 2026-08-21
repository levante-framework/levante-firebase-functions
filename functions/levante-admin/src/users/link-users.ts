import { createHash } from "node:crypto";
import {
  LinkUsersParamsSchema,
  type LinkUsersResult,
} from "@levante-framework/levante-zod";
import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import { getAuth } from "firebase-admin/auth";
import {
  type DocumentReference,
  FieldValue,
  getFirestore,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import _chunk from "lodash-es/chunk.js";
import {
  buildPermissionsUserFromAuthRecord,
  ensurePermissionsLoaded,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";

/**
 * Compute the deterministic idHash for a user: the sha256 of the site-scoped
 * external id, used to detect tampering and backfill missing hashes.
 */
export function expectedIdHash(siteId: string, externalId: string): string {
  return createHash("sha256").update(`${siteId}-${externalId}`).digest("hex");
}

/**
 * Pick the child's shared label index: keep the child's current index if it
 * already exceeds every caregiver's last minted index, otherwise mint the next
 * one above the highest caregiver index so it never collides.
 */
export function nextChildLabelIndex(
  existing: number | undefined,
  lastMinted: Array<number | undefined>
): number {
  const maxLast = Math.max(-1, ...lastMinted.map((n) => n ?? -1));
  return existing !== undefined && existing > maxLast ? existing : maxLast + 1;
}

/**
 * Split requested caregivers into those newly linked to the child versus those
 * already linked. `caregiverUids` is the deduped union of existing + new
 * caregivers to load so a minted label never lowers an existing caregiver's
 * `lastChildLabelIndex`. When nothing new is linked (e.g. a teacher-only link),
 * both arrays are empty and no caregiver docs are touched.
 */
export function resolveCaregiverLinks(
  existing: string[],
  requested: string[]
): { newCaregiverUids: string[]; caregiverUids: string[] } {
  const newCaregiverUids = [
    ...new Set(requested.filter((uid) => !existing.includes(uid))),
  ];
  const caregiverUids =
    newCaregiverUids.length === 0
      ? []
      : [...new Set([...existing, ...newCaregiverUids])];
  return { newCaregiverUids, caregiverUids };
}

/**
 * Callable that links children to their caregivers and teachers within a site.
 * Validates the caller's permission and that every user exists, belongs to the
 * site, and has a matching idHash (backfilling missing ones), then updates each
 * child's caregiver/teacher links and keeps the shared childLabelIndex in sync.
 */
export const linkUsers = onCall(async (req): Promise<LinkUsersResult> => {
  const uid = req.auth?.uid;
  if (!uid)
    throw new HttpsError("unauthenticated", "User must be authenticated");

  const parsed = LinkUsersParamsSchema.safeParse(req.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Invalid input", {
      code: "schema",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
  }
  const { siteId, users } = parsed.data;

  const auth = getAuth();
  const userRecord = await auth.getUser(uid);
  // Legacy permissions
  // TODO: remove after migration
  if (userRecord.customClaims?.useNewPermissions !== true) {
    logger.warn("Permission denied for linking users: legacy permissions", {
      requestingUid: uid,
      siteId,
    });
    throw new HttpsError(
      "permission-denied",
      "New permission system must be enabled to link users"
    );
  }
  await ensurePermissionsLoaded();
  const user = buildPermissionsUserFromAuthRecord(userRecord);

  if (
    !filterSitesByPermission(user, [siteId], {
      resource: RESOURCES.USERS,
      action: ACTIONS.CREATE, // NB: if you can create users, you can link them
    }).length
  ) {
    logger.warn("Permission denied for linking users", {
      requestingUid: uid,
      siteId,
    });
    throw new HttpsError(
      "permission-denied",
      `You do not have permission to link users in site ${siteId}`
    );
  }

  const db = getFirestore();
  const usersRef = db.collection("users");
  const userSnaps = await db.getAll(...users.map((u) => usersRef.doc(u.uid)));

  // Validate all users exist
  const nonExistentUsers = userSnaps.filter((snap) => !snap.exists);
  if (nonExistentUsers.length > 0) {
    throw new HttpsError("not-found", "Users not found", {
      code: "users",
      uids: nonExistentUsers.map((snap) => snap.id),
    });
  }

  // Validate all users belong to the site
  const usersNotInSite: string[] = [];
  for (const snap of userSnaps) {
    const userDistricts = snap.data()?.districts?.current ?? [];
    if (!userDistricts.includes(siteId)) {
      usersNotInSite.push(snap.id);
    }
  }
  if (usersNotInSite.length > 0) {
    throw new HttpsError(
      "invalid-argument",
      "Users not belonging to site found",
      {
        code: "users-site-mismatch",
        siteId,
        uids: usersNotInSite,
      }
    );
  }

  // Validate ID hashes (backfill if missing)
  const uidToId: Record<string, string> = {};
  const idToUid: Record<string, string> = {};
  for (const user of users) {
    uidToId[user.uid] = user.id;
    idToUid[user.id] = user.uid;
  }
  const usersIdHashMismatch: string[] = [];
  const idHashBackfills: { ref: DocumentReference; idHash: string }[] = [];

  for (const snap of userSnaps) {
    const { idHash } = snap.data() ?? {};
    const hash = expectedIdHash(siteId, uidToId[snap.id]);

    if (idHash) {
      if (idHash !== hash) {
        usersIdHashMismatch.push(snap.id);
      }
    } else {
      idHashBackfills.push({ ref: snap.ref, idHash: hash });
    }
  }

  if (usersIdHashMismatch.length > 0) {
    throw new HttpsError(
      "invalid-argument",
      "Users with ID hash mismatch found",
      {
        code: "id-hash-mismatch",
        uids: usersIdHashMismatch,
      }
    );
  }

  for (const chunk of _chunk(idHashBackfills, 500)) {
    const batch = db.batch();
    for (const { ref, idHash } of chunk) {
      batch.update(ref, { idHash });
    }
    await batch.commit();
  }

  // Link children to caregivers and teachers
  for (const user of users) {
    if (user.userType !== "child") continue;

    const requestedCaregiverUids = user.caregiverId.map((id) => idToUid[id]);
    const requestedTeacherUids = user.teacherId.map((id) => idToUid[id]);

    try {
      await db.runTransaction(async (transaction) => {
        // Collect child doc
        const childRef = usersRef.doc(user.uid);
        const childSnap = await transaction.get(childRef);
        if (!childSnap.exists) {
          throw new HttpsError("not-found", "Users not found", {
            code: "users",
            uids: [user.uid],
          });
        }
        const childDoc = childSnap.data() ?? {};

        // A new caregiver mints a shared childLabelIndex; when that
        // happens every caregiver on the child (existing + new) is bumped
        // to that index. A teacher-only link mints nothing, so no
        // caregiver docs are touched.
        const { newCaregiverUids, caregiverUids } = resolveCaregiverLinks(
          childDoc.parentIds ?? [],
          requestedCaregiverUids
        );
        const caregiverSnaps =
          caregiverUids.length === 0
            ? []
            : await transaction.getAll(
                ...caregiverUids.map((uid) => usersRef.doc(uid))
              );
        const missingCaregivers = caregiverSnaps.filter((s) => !s.exists);
        if (missingCaregivers.length > 0) {
          throw new HttpsError("not-found", "Users not found", {
            code: "users",
            uids: missingCaregivers.map((s) => s.id),
          });
        }

        // Collect teacher docs
        const teacherSnaps =
          requestedTeacherUids.length === 0
            ? []
            : await transaction.getAll(
                ...requestedTeacherUids.map((uid) => usersRef.doc(uid))
              );
        const missingTeachers = teacherSnaps.filter((s) => !s.exists);
        if (missingTeachers.length > 0) {
          throw new HttpsError("not-found", "Users not found", {
            code: "users",
            uids: missingTeachers.map((s) => s.id),
          });
        }

        const childLabelIndex = nextChildLabelIndex(
          childDoc.childLabelIndex as number | undefined,
          caregiverSnaps.map(
            (s) => s.data()?.lastChildLabelIndex as number | undefined
          )
        );

        // Update child document
        const childUpdate: Record<string, unknown> = {};
        if (requestedCaregiverUids.length > 0) {
          childUpdate.parentIds = FieldValue.arrayUnion(
            ...requestedCaregiverUids
          );
        }
        if (requestedTeacherUids.length > 0) {
          childUpdate.teacherIds = FieldValue.arrayUnion(
            ...requestedTeacherUids
          );
        }
        if (newCaregiverUids.length > 0) {
          childUpdate.childLabelIndex = childLabelIndex;
        }
        if (Object.keys(childUpdate).length > 0) {
          transaction.update(childRef, childUpdate);
        }

        // Bump every caregiver on the child to the minted label
        for (const snap of caregiverSnaps) {
          transaction.update(snap.ref, {
            childIds: FieldValue.arrayUnion(user.uid),
            lastChildLabelIndex: childLabelIndex,
          });
        }

        // Update teacher documents
        for (const snap of teacherSnaps) {
          transaction.update(snap.ref, {
            childIds: FieldValue.arrayUnion(user.uid),
          });
        }
      });
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.error("Linking transaction failed", { uid: user.uid }, error);
      throw new HttpsError("internal", "Failed to link users", {
        code: "link",
        uid: user.uid,
      });
    }
  }

  return {};
});
