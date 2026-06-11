import { createHash } from "crypto";
import bcrypt from "bcrypt";
import { getAuth, type Auth, type UserImportRecord } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import type {
  DocumentSnapshot,
  Firestore,
  QuerySnapshot,
} from "firebase-admin/firestore";
import { getFunctions } from "firebase-admin/functions";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import _chunk from "lodash-es/chunk.js";
import {
  CreateUsersParamsSchema,
  type CreateUsersParams,
  type CreateUsersResult,
} from "@levante-framework/levante-zod";
import { ACTIONS, RESOURCES, ROLES } from "@levante-framework/permissions-core";
import type { OrgAssociationMap, User } from "../firestore-schema.js";
import { processUserAddedOrgs } from "../administrations/sync-administrations.js";
import { fetchSyncStatusCounts } from "../sites/site-utils.js";
import {
  buildPermissionsUserFromAuthRecord,
  ensurePermissionsLoaded,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";
import {
  buildRoleClaimsStructure,
  type RoleDefinition,
} from "../utils/role-helpers.js";
import { getFunctionUrl, isEmulated } from "../utils/utils.js";
import { LEVANTE_TO_ROAR_USERTYPE } from "./user-utils.js";

/** Aggregates all fields needed to create a new user */
interface NewUserRecord {
  birthMonth?: number;
  birthYear?: number;
  classes: OrgAssociationMap;
  cohorts: OrgAssociationMap;
  customClaims: {
    adminUid: string;
    roarUid: string;
    rolesSet: string[];
    siteNames: Record<string, string>;
    siteRoles: Record<string, string[]>;
    useNewPermissions: boolean;
  };
  email: string;
  id: string;
  idHash: string;
  password: string;
  passwordHash: Buffer;
  roles: { role: string; siteId: string; siteName: string }[];
  schools: OrgAssociationMap;
  sites: OrgAssociationMap;
  uid: string;
  userType: "caregiver" | "child" | "teacher";
}

const MAX_RETRIES = 3;

/** Builds an OrgAssociationMap for a user */
function buildOrgField(orgIds: string[]): OrgAssociationMap {
  return {
    current: orgIds,
    all: orgIds,
    dates: Object.fromEntries(
      orgIds.map((id) => [id, { from: Timestamp.now(), to: null }])
    ),
  };
}

/** Creates Firebase Auth users */
export async function createAuthUsers(
  auth: Auth,
  users: NewUserRecord[],
  currentRetry = 0
) {
  try {
    // Auth emulator sign-in only accepts passwords created via createUser/updateUser
    // (fakeHash format). importUsers with BCRYPT passwordHash imports successfully but
    // signInWithEmailAndPassword fails; production uses bulk importUsers below.
    if (isEmulated()) {
      const results: Array<
        | { success: true; uid: string }
        | { success: false; error: unknown; user: NewUserRecord }
      > = [];
      for (const user of users) {
        try {
          const userRecord = await auth.createUser({
            uid: user.uid,
            disabled: false,
            displayName: "",
            email: user.email,
            emailVerified: false,
            password: user.password,
          });
          await auth.setCustomUserClaims(userRecord.uid, user.customClaims);
          results.push({ success: true, uid: userRecord.uid });
        } catch (error: unknown) {
          logger.error("Failed to create user in emulator", {
            email: user.email,
            error,
          });
          results.push({ success: false, error, user });
        }
      }

      const failures = results.filter((r) => !r.success);
      const failedUsers = failures.map((r) => r.user);

      if (failures.length === 0) return;

      if (currentRetry >= MAX_RETRIES) {
        logger.error("Maximum retries exceeded creating emulator users", {
          failedUsers: failedUsers.map((u) => u.email),
          maxRetries: MAX_RETRIES,
        });
        throw new Error(
          `Maximum retries (${MAX_RETRIES}) exceeded. Failed to create ${failedUsers.length} users.`
        );
      }

      logger.warn("Retrying failed emulator user creations", {
        failedCount: failedUsers.length,
        maxRetries: MAX_RETRIES,
        retryCount: currentRetry + 1,
      });
      await createAuthUsers(auth, failedUsers, currentRetry + 1);
    } else {
      const failedUsers: NewUserRecord[] = [];
      // NB: importUsers can only import up to 1000 users at a time
      for (const chunk of _chunk(users, 1000)) {
        const result = await auth.importUsers(
          chunk.map(
            (user: NewUserRecord): UserImportRecord => ({
              uid: user.uid,
              email: user.email,
              emailVerified: false,
              displayName: "",
              disabled: false,
              customClaims: user.customClaims,
              passwordHash: user.passwordHash,
            })
          ),
          {
            hash: {
              algorithm: "BCRYPT",
            },
          }
        );

        if (result.failureCount > 0) {
          result.errors.forEach((error) => {
            failedUsers.push(chunk[error.index]);
          });
        }
      }

      if (failedUsers.length > 0 && currentRetry < MAX_RETRIES) {
        await createAuthUsers(auth, failedUsers, currentRetry + 1);
      } else if (failedUsers.length > 0 && currentRetry >= MAX_RETRIES) {
        logger.error("Maximum retries exceeded importing users", {
          failedCount: failedUsers.length,
          maxRetries: MAX_RETRIES,
        });
        throw new Error(
          `Maximum retries (${MAX_RETRIES}) exceeded. Failed to create all users.`
        );
      }
    }
  } catch (error: unknown) {
    logger.error("An error occurred while creating Auth users", {
      attempt: currentRetry,
      error,
    });
    throw new Error(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Creates Firestore userClaims docs
 * TODO: remove this after permissions migration is complete
 */
export async function createUserClaimsDocs(
  db: Firestore,
  users: NewUserRecord[],
  currentRetry = 0
) {
  const results = await Promise.allSettled(
    users.map((user) => {
      return db
        .collection("userClaims")
        .doc(user.uid)
        .set({
          claims: {
            ...user.customClaims,
          },
        });
    })
  );

  const failedUsers: NewUserRecord[] = results
    .map((result, i) => (result.status === "rejected" ? users[i] : null))
    .filter((e) => e !== null);
  const failedCount = failedUsers.length;

  if (failedCount === 0) return;

  if (currentRetry >= MAX_RETRIES) {
    logger.error("Maximum retries exceeded creating userClaims docs", {
      failedCount,
      maxRetries: MAX_RETRIES,
    });
    throw new Error(
      `Maximum retries (${MAX_RETRIES}) exceeded. Failed to create ${failedCount} userClaims docs.`
    );
  }

  logger.warn("Retrying failed userClaims docs creation", {
    attempt: currentRetry + 1,
    failedCount,
    maxRetries: MAX_RETRIES,
  });
  await createUserClaimsDocs(db, failedUsers, currentRetry + 1);
}

/** Creates Firestore users docs */
export async function createUsersDocs(
  db: Firestore,
  users: NewUserRecord[],
  currentRetry = 0
) {
  const results = await Promise.allSettled(
    users.map((user) => {
      const data: User = {
        archived: false,
        ...(user.birthMonth !== undefined && { birthMonth: user.birthMonth }),
        ...(user.birthYear !== undefined && { birthYear: user.birthYear }),
        classes: user.classes,
        createdAt: FieldValue.serverTimestamp() as unknown as Timestamp,
        disabled: false,
        displayName: "",
        districts: user.sites,
        email: user.email,
        groups: user.cohorts,
        idHash: user.idHash,
        roles: user.roles,
        schools: user.schools,
        syncStatus: "pending",
        uid: user.uid,
        userType: LEVANTE_TO_ROAR_USERTYPE[user.userType],
        username: user.email.split("@")[0],
        updatedAt: FieldValue.serverTimestamp() as unknown as Timestamp,
      };
      return db.collection("users").doc(user.uid).set(data);
    })
  );

  const failedUsers = results
    .map((result, i) => (result.status === "rejected" ? users[i] : null))
    .filter((e) => e !== null);
  const failedCount = failedUsers.length;

  if (failedCount === 0) return;

  if (currentRetry >= MAX_RETRIES) {
    logger.error("Maximum retries exceeded creating users docs", {
      failedCount,
      maxRetries: MAX_RETRIES,
    });
    throw new Error(
      `Maximum retries (${MAX_RETRIES}) exceeded. Failed to create ${failedCount} users docs.`
    );
  }

  logger.warn("Retrying failed users docs creation", {
    attempt: currentRetry + 1,
    failedCount,
    maxRetries: MAX_RETRIES,
  });
  await createUsersDocs(db, failedUsers, currentRetry + 1);
}

/** Ensures all orgs exist and belong to site */
export async function ensureOrgsExistInSite(
  db: Firestore,
  siteId: string,
  users: CreateUsersParams["users"]
): Promise<void> {
  const idToOrgKey = new Map<string, string>();
  const schoolIds = new Set(users.flatMap((u) => u.orgIds.schools));
  for (const schoolId of schoolIds) idToOrgKey.set(schoolId, "schools");
  const classIds = new Set(users.flatMap((u) => u.orgIds.classes));
  for (const classId of classIds) idToOrgKey.set(classId, "classes");
  const cohortIds = new Set(users.flatMap((u) => u.orgIds.cohorts));
  for (const cohortId of cohortIds) idToOrgKey.set(cohortId, "cohorts");

  // Get all org snapshots
  const refs = [
    ...Array.from(schoolIds).map((schoolId) =>
      db.collection("schools").doc(schoolId)
    ),
    ...Array.from(classIds).map((classId) =>
      db.collection("classes").doc(classId)
    ),
    ...Array.from(cohortIds).map((cohortId) =>
      db.collection("groups").doc(cohortId)
    ),
  ];
  const snaps = await db.getAll(...refs);

  // Check if any orgs don't exist
  const missing = snaps.filter((snap) => !snap.exists);
  if (missing.length > 0) {
    const orgIds: Record<string, string[]> = {
      schools: [],
      classes: [],
      cohorts: [],
    };
    missing.forEach((snap) =>
      orgIds[idToOrgKey.get(snap.ref.id)!].push(snap.ref.id)
    );
    logger.warn("Orgs not found", { orgIds });
    throw new HttpsError("not-found", "Orgs not found", { orgIds });
  }

  // Check if any orgs don't belong to site
  const unrelated = snaps.filter(
    (snap) =>
      snap.data()!.districtId !== siteId && snap.data()!.parentOrgId !== siteId
  );
  if (unrelated.length > 0) {
    const orgIds: Record<string, string[]> = {
      schools: [],
      classes: [],
      cohorts: [],
    };
    unrelated.forEach((snap) =>
      orgIds[idToOrgKey.get(snap.ref.id)!].push(snap.ref.id)
    );
    logger.warn("Orgs not belonging to site found", { siteId, orgIds });
    throw new HttpsError(
      "invalid-argument",
      "Orgs not belonging to site found",
      { siteId, orgIds }
    );
  }
}

/** Generates a specified number of unique email addresses */
export async function generateEmails(n: number, auth: Auth): Promise<string[]> {
  const emails = new Set<string>();
  while (emails.size < n) {
    const newEmails = new Set<string>();
    while (newEmails.size < n - emails.size) {
      const email = `${generateRandomString()}@levante.com`;
      if (!emails.has(email)) newEmails.add(email);
    }

    try {
      const validEmails = await validateEmails([...newEmails], auth);
      for (const email of validEmails) emails.add(email);
    } catch (error) {
      logger.error("Error validating emails", { error });
      throw error;
    }
  }

  logger.debug("Generated emails", {
    count: emails.size,
  });
  return Array.from(emails);
}

/** Generates a random string of specified length */
export function generateRandomString(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const charsLength = chars.length;

  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * charsLength));
  }

  return result;
}

/** Looks up users by their lab-specific ID hashes */
export async function lookupUsersByHashes(
  db: Firestore,
  hashes: string[]
): Promise<Map<string, DocumentSnapshot>> {
  // Lookup users in chunks of 30 (i.e., maximum for Firestore where-in queries)
  const users: DocumentSnapshot[] = (
    await Promise.all(
      _chunk(hashes, 30).map((batch: string[]) =>
        db.collection("users").where("idHash", "in", batch).get()
      )
    )
  ).flatMap((s: QuerySnapshot) => s.docs);

  // Check for duplicate hashes (since Firestore can't enforce uniqueness)
  const hashToUser: Map<string, DocumentSnapshot> = new Map();
  const dupeHashes: Set<string> = new Set();
  for (const user of users) {
    const hash = user.get("idHash") as string;
    if (hashToUser.has(hash)) {
      dupeHashes.add(hash);
    } else {
      hashToUser.set(hash, user);
    }
  }
  if (dupeHashes.size > 0) {
    const message = "Multiple users exist with the same ID hash";
    const hashes = Array.from(dupeHashes);
    logger.error(message, { hashes });
    throw new HttpsError("internal", message, { hashes });
  }

  return hashToUser;
}

/** Best-effort rollback of Auth and Firestore users */
export async function rollbackUsers(auth: Auth, db: Firestore, uids: string[]) {
  if (uids.length === 0) return;

  // auth.deleteUsers accepts at most 1000 UIDs per call.
  for (const chunk of _chunk(uids, 1000)) {
    await auth.deleteUsers(chunk).catch((error) => {
      logger.error("Failed to roll back Auth users", { uids: chunk, error });
    });
  }

  // Each user is 2 deletes and a batch caps at 500 ops, so 250 users per batch.
  for (const chunk of _chunk(uids, 250)) {
    const batch = db.batch();
    for (const uid of chunk) {
      batch.delete(db.collection("userClaims").doc(uid));
      batch.delete(db.collection("users").doc(uid));
    }
    await batch.commit().catch((error) => {
      logger.error("Failed to roll back Firestore user docs", {
        uids: chunk,
        error,
      });
    });
  }
}

/** Checks emails against Firebase Auth, filtering out those that are already registered */
export async function validateEmails(
  emails: string[],
  auth: Auth
): Promise<string[]> {
  const existingEmails = new Set<string>();
  for (const chunk of _chunk(emails, 100)) {
    const result = await auth.getUsers(chunk.map((email) => ({ email })));
    for (const user of result.users) {
      if (user.email) existingEmails.add(user.email);
    }
  }

  const validEmails = emails.filter((email) => !existingEmails.has(email));

  logger.debug("Validated emails", {
    validCount: validEmails.length,
    invalidCount: existingEmails.size,
  });
  return validEmails;
}

export const createUsers = onCall(async (req): Promise<CreateUsersResult> => {
  const uid = req.auth?.uid;
  if (!uid)
    throw new HttpsError("unauthenticated", "User must be authenticated");

  const parsed = CreateUsersParamsSchema.safeParse(req.data);
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
  const { siteId, users } = parsed.data;

  const auth = getAuth();
  const userRecord = await auth.getUser(uid);
  // Legacy permissions
  // TODO: remove after migration
  if (userRecord.customClaims?.useNewPermissions !== true) {
    logger.warn("Permission denied for creating users: legacy permissions", {
      requestingUid: uid,
      siteId,
    });
    throw new HttpsError(
      "permission-denied",
      "New permission system must be enabled to view site overview"
    );
  }
  await ensurePermissionsLoaded();
  const user = buildPermissionsUserFromAuthRecord(userRecord);
  if (
    !filterSitesByPermission(user, [siteId], {
      resource: RESOURCES.USERS,
      action: ACTIONS.CREATE,
    }).length
  ) {
    logger.warn("Permission denied for creating users", {
      requestingUid: uid,
      siteId,
    });
    throw new HttpsError(
      "permission-denied",
      `You do not have permission to create users in site ${siteId}`
    );
  }

  const db = getFirestore();

  const syncStatus = await fetchSyncStatusCounts(db, siteId);
  if (syncStatus.assignments.pending > 0 || syncStatus.users.pending > 0) {
    throw new HttpsError(
      "failed-precondition",
      "Site is not ready to create users"
    );
  }

  // Get existing users by their ID hashes
  const idToHash: Record<string, string> = {};
  for (const user of users) {
    idToHash[user.id] = createHash("sha256")
      .update(`${siteId}-${user.id}`)
      .digest("hex");
  }
  const hashToUser = await lookupUsersByHashes(db, Object.values(idToHash));
  const existingUsers = users.filter((user) =>
    hashToUser.has(idToHash[user.id])
  );
  if (existingUsers.length > 0) {
    logger.warn("Existing users found", {
      hashes: existingUsers.map((u) => idToHash[u.id]),
    });
    throw new HttpsError("already-exists", "Users already exist", {
      users: existingUsers,
    });
  }

  await ensureOrgsExistInSite(db, siteId, users);

  // Prepare user data for Auth and Firestore
  const newEmails = await generateEmails(users.length, auth);
  // TODO: siteName is used to populate auth claims, but it's not necessary.
  // Remove this once we clean up the auth claims shape.
  const siteDoc = await db.collection("districts").doc(siteId).get();
  const siteName = (siteDoc.data()?.name as string) ?? "";

  const newUserRecords: NewUserRecord[] = [];
  for (let i = 0; i < users.length; i++) {
    const ref = db.collection("users").doc();

    const roles: RoleDefinition[] = [
      {
        siteId,
        role: ROLES.PARTICIPANT,
        siteName,
      },
    ];
    const roleClaims = buildRoleClaimsStructure(roles);
    const stringPassword = generateRandomString();

    const user = users[i];
    newUserRecords.push({
      ...(user.userType === "child" && { birthMonth: user.month }),
      ...(user.userType === "child" && { birthYear: user.year }),
      classes: buildOrgField(user.orgIds.classes),
      cohorts: buildOrgField(user.orgIds.cohorts),
      customClaims: {
        adminUid: ref.id,
        roarUid: ref.id,
        rolesSet: roleClaims.rolesSet,
        siteNames: roleClaims.siteNames,
        siteRoles: roleClaims.siteRoles,
        useNewPermissions: true,
      },
      email: newEmails[i],
      id: user.id,
      idHash: idToHash[user.id],
      password: stringPassword,
      passwordHash: Buffer.from(await bcrypt.hash(stringPassword, 1)),
      roles,
      schools: buildOrgField(user.orgIds.schools),
      sites: buildOrgField([siteId]),
      uid: ref.id,
      userType: user.userType,
    });
  }

  // Create Auth, userClaims, and users docs
  try {
    await createAuthUsers(auth, newUserRecords);
    await createUserClaimsDocs(db, newUserRecords);
    await createUsersDocs(db, newUserRecords);
  } catch (error) {
    await rollbackUsers(
      auth,
      db,
      newUserRecords.map((u) => u.uid)
    );
    throw error;
  }

  // Enqueue tasks to sync assignments to created users
  const taskName = "syncCreatedUsersTask";
  const queue = getFunctions().taskQueue(taskName);
  const targetUri = await getFunctionUrl(taskName);
  await Promise.all(
    newUserRecords.map((u) =>
      queue.enqueue(
        {
          uid: u.uid,
          addedOrgs: {
            sites: u.sites.current,
            schools: u.schools.current,
            classes: u.classes.current,
            cohorts: u.cohorts.current,
          },
        },
        { dispatchDeadlineSeconds: 60 * 30, uri: targetUri }
      )
    )
  );

  // Return created users
  return {
    users: newUserRecords.map((u) => ({
      id: u.id,
      email: u.email,
      password: u.password,
      uid: u.uid,
    })),
  };
});

export const syncCreatedUsersTask = onTaskDispatched<{
  uid: string;
  addedOrgs: {
    sites: string[];
    schools: string[];
    classes: string[];
    cohorts: string[];
  };
}>(
  {
    retryConfig: {
      maxAttempts: 5,
      minBackoffSeconds: 60,
    },
    rateLimits: {
      maxConcurrentDispatches: 10,
    },
    memory: "256MiB",
    timeoutSeconds: 60,
  },
  async (request) => {
    const { uid, addedOrgs } = request.data;
    const db = getFirestore();
    const userRef = db.collection("users").doc(uid);
    try {
      await processUserAddedOrgs(uid, {
        districts: addedOrgs.sites,
        schools: addedOrgs.schools,
        classes: addedOrgs.classes,
        groups: addedOrgs.cohorts,
      });
      await userRef.update({
        syncStatus: "complete",
        updatedAt: FieldValue.serverTimestamp(),
      });
    } catch (error) {
      logger.error("Failed to sync user orgs", { uid, error });
      await userRef.update({
        syncStatus: "failed",
        updatedAt: FieldValue.serverTimestamp(),
      });
      throw error;
    }
  }
);
