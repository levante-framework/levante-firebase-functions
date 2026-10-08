import {
  getFirestore,
  FieldValue,
  Timestamp,
  Filter,
} from "firebase-admin/firestore";
import type {
  DocumentReference,
  Transaction,
  Firestore,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { getFunctions } from "firebase-admin/functions";
import _chunk from "lodash-es/chunk.js";
import _difference from "lodash-es/difference.js";
import _fromPairs from "lodash-es/fromPairs.js";
import _isEqual from "lodash-es/isEqual.js";
import _map from "lodash-es/map.js";
import _pick from "lodash-es/pick.js";
import _uniqBy from "lodash-es/uniqBy.js";
import _without from "lodash-es/without.js";
import _reduce from "lodash-es/reduce.js";
import type { IAdministration, IOrgsList } from "../interfaces.js";
import { ORG_NAMES } from "../interfaces.js";
import {
  getExhaustiveOrgs,
  getOnlyExistingOrgs,
  getUsersFromOrgs,
} from "../orgs/org-utils.js";
import type { UpdateAction } from "../utils/transactions.js";
import {
  removeAssignmentFromUsers,
  updateAssignmentsForUserFromAdministrations,
} from "../assignments/assignment-utils.js";
import { AdminStatsBufferRegistry } from "../assignments/admin-stats-buffer.js";
import {
  getAdministrationsFromOrgs,
  standardizeAdministrationOrgs,
} from "./administration-utils.js";
import {
  summarizeIdListForLog,
  summarizeOrgsForLog,
} from "../utils/logging.js";
import {
  getFunctionUrl,
  MAX_TRANSACTIONS,
  parseTimestamp,
} from "../utils/utils.js";

export const processRemovedAdministration = async (
  administrationId: string,
  prevOrgs: IOrgsList
) => {
  const db = getFirestore();

  logger.debug("processRemovedAdministration", {
    administrationId,
    prevOrgSummary: summarizeOrgsForLog(prevOrgs),
  });

  // Get all of the previous users and remove their assignments.  The
  // maximum number of docs we can remove in a single transaction is
  // ``MAX_TRANSACTIONS``. The number of affected users is potentially
  // larger. So we loop through chunks of the userIds and remove them in
  // separate transactions if necessary.

  // ``remainingUsers`` is a placeholder in the event that the number of
  // affected users is greater than the maximum number of docs we can remove
  // in a single transaction.
  let remainingUsers: string[] = [];

  // Run the first transaction to get the user list
  await db.runTransaction(async (transaction) => {
    const prevUsers = await getUsersFromOrgs({
      orgs: prevOrgs,
      transaction,
      includeArchived: true, // `includeArchived` is true to remove assignments even from archived users
      includeDisabled: true, // `includeDisabled` is true to remove assignments even from disabled users
    });

    if (prevUsers.length <= MAX_TRANSACTIONS) {
      const statsRegistry = new AdminStatsBufferRegistry(db);
      await removeAssignmentFromUsers(
        prevUsers,
        administrationId,
        transaction,
        statsRegistry
      );
      statsRegistry.flush(transaction);
      return;
    } else {
      // Otherwise, just save for the next loop over user chunks.
      remainingUsers = prevUsers;
      return Promise.resolve(prevUsers.length);
    }
  });

  // If remainingUsers.length === 0, then these chunks will be of zero length
  // and the entire loop below is a no-op.
  for (const _userChunk of _chunk(remainingUsers, MAX_TRANSACTIONS)) {
    await db.runTransaction(async (transaction) => {
      const statsRegistry = new AdminStatsBufferRegistry(db);
      await removeAssignmentFromUsers(
        _userChunk,
        administrationId,
        transaction,
        statsRegistry
      );
      statsRegistry.flush(transaction);
    });
  }

  return Promise.resolve({ status: "ok" });
};

export async function enqueueAddUpdateTasksForAdministration(
  administrationId: string,
  administrationDocRef: DocumentReference,
  currData: IAdministration,
  prevData: IAdministration | undefined
): Promise<{ status: "ok" }> {
  const db = getFirestore();
  const { minimalOrgs } = await standardizeAdministrationOrgs({
    administrationId,
    administrationDocRef,
    currData,
    copyToSubCollections: true,
    forceCopy: true,
  });

  const usersToUpdate = await db.runTransaction(async (transaction) => {
    return getUsersFromOrgs({
      orgs: minimalOrgs,
      transaction,
      includeArchived: false,
      includeDisabled: false,
    });
  });

  const userChunks = _chunk(usersToUpdate, MAX_TRANSACTIONS);
  if (userChunks.length === 0) {
    const completeUpdate: Record<string, unknown> = {
      syncStatus: "complete",
      syncChunksTotal: 0,
      syncChunksCompleted: 0,
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (prevData) {
      completeUpdate._syncRollback = FieldValue.delete();
    }
    await administrationDocRef.update(completeUpdate);
    return { status: "ok" };
  }

  await administrationDocRef.update({
    syncStatus: "pending",
    syncChunksTotal: userChunks.length,
    syncChunksCompleted: 0,
    ...(prevData ? { _syncRollback: prevData } : {}),
    updatedAt: FieldValue.serverTimestamp(),
  });

  const taskName = "updateAssignmentsForOrgChunk";
  const queue = getFunctions().taskQueue(taskName);
  const targetUri = await getFunctionUrl(taskName);
  const enqueues: Promise<void>[] = [];

  for (const userIds of userChunks) {
    logger.debug("Enqueueing task for user chunk", {
      administrationId,
      targetUri,
      taskName,
      userCount: userIds.length,
    });
    enqueues.push(
      queue.enqueue(
        {
          administrationData: currData,
          administrationId,
          userIds,
          mode: prevData ? "update" : "add",
        },
        {
          dispatchDeadlineSeconds: 60 * 30,
          uri: targetUri,
        }
      )
    );
  }

  await Promise.all(enqueues);
  return { status: "ok" };
}

export const processNewAdministration = async (
  administrationId: string,
  administrationDocRef: DocumentReference,
  currData: IAdministration
) => {
  return enqueueAddUpdateTasksForAdministration(
    administrationId,
    administrationDocRef,
    currData,
    undefined
  );
};

export const processModifiedAdministration = async (
  administrationId: string,
  administrationDocRef: DocumentReference,
  prevData: IAdministration,
  currData: IAdministration
) => {
  const db = getFirestore();
  const prevOrgs: IOrgsList = _pick(prevData, ORG_NAMES);
  const currOrgs: IOrgsList = _pick(currData, ORG_NAMES);

  logger.debug(`Processing modified administration ${administrationId}`, {
    currOrgSummary: summarizeOrgsForLog(currOrgs),
    prevOrgSummary: summarizeOrgsForLog(prevOrgs),
  });

  //        +--------------+
  // -------| Remove users |---------
  //        +--------------+
  // If any orgs were removed, remove those users.
  const removedOrgs = _fromPairs(
    _map(Object.entries(currOrgs), ([key, value]) => [
      key,
      _difference(prevOrgs[key], value),
    ])
  ) as IOrgsList;

  logger.debug(
    `Detected these removed orgs for updated administration ${administrationId}`,
    {
      removedOrgSummary: summarizeOrgsForLog(removedOrgs),
    }
  );

  const numRemovedOrgs = _reduce(
    removedOrgs,
    (sum, value) => (value ? sum + value.length : sum),
    0
  );

  // ``remainingUsersToRemove`` is a placeholder in the event that the number of
  // affected users is greater than the maximum number of docs we can remove
  // in a single transaction.
  //
  // ``removedExhaustiveOrgs`` is the exhaustive list of orgs that were removed.
  // This is used to get the users to remove.
  let remainingUsersToRemove: string[] = [];
  let removedExhaustiveOrgs: IOrgsList = {};

  if (numRemovedOrgs > 0) {
    await db.runTransaction(async (transaction) => {
      const removedExistingOrgs = await getOnlyExistingOrgs(
        removedOrgs,
        transaction
      );
      removedExhaustiveOrgs = await getExhaustiveOrgs({
        orgs: removedExistingOrgs,
        transaction,
        includeArchived: true,
      });
      remainingUsersToRemove = await getUsersFromOrgs({
        orgs: removedExhaustiveOrgs,
        transaction,
        includeArchived: true,
        includeDisabled: true,
      });
      return remainingUsersToRemove.length;
    });

    logger.debug(`Removing assignment ${administrationId} from users`, {
      userSummary: summarizeIdListForLog(remainingUsersToRemove),
    });

    if (remainingUsersToRemove.length > 0) {
      const removalChunks = _chunk(
        remainingUsersToRemove,
        MAX_TRANSACTIONS
      ) as string[][];
      const taskName = "updateAssignmentsForOrgChunk";
      const queue = getFunctions().taskQueue(taskName);
      const targetUri = await getFunctionUrl(taskName);
      const enqueues: Promise<void>[] = [];

      for (let i = 0; i < removalChunks.length; i++) {
        const userIds = removalChunks[i];
        const isLastRemovalChunk = i === removalChunks.length - 1;
        logger.debug("Enqueueing removal task for user chunk", {
          administrationId,
          taskName,
          userCount: userIds.length,
          isLastRemovalChunk,
        });
        enqueues.push(
          queue.enqueue(
            {
              mode: "remove",
              administrationId,
              userIds,
              removedExhaustiveOrgs,
              ...(isLastRemovalChunk
                ? { isLastRemovalChunk: true, currData, prevData }
                : {}),
            },
            {
              dispatchDeadlineSeconds: 60 * 30,
              uri: targetUri,
            }
          )
        );
      }
      await Promise.all(enqueues);
      return { status: "ok" };
    }
  }

  return enqueueAddUpdateTasksForAdministration(
    administrationId,
    administrationDocRef,
    currData,
    prevData
  );
};

export const processUserAddedOrgs = async (
  roarUid: string,
  addedOrgs: IOrgsList
) => {
  logger.debug("Detected added orgs", {
    userId: roarUid,
    addedOrgSummary: summarizeOrgsForLog(addedOrgs),
  });
  const db = getFirestore();
  await db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(db.collection("users").doc(roarUid));
    if (!userDoc.exists) return;

    const userData = userDoc.data() as
      | { archived?: boolean; disabled?: boolean }
      | undefined;

    if (userData?.archived === true || userData?.disabled === true) {
      logger.debug("Skipping assignment sync for inactive user", {
        userId: roarUid,
        archived: userData.archived === true,
        disabled: userData.disabled === true,
      });

      return;
    }

    const statsRegistry = new AdminStatsBufferRegistry(db);
    const addedExhaustiveOrgs = await getExhaustiveOrgs({
      orgs: addedOrgs,
      transaction,
      includeArchived: false, // `includeArchived` is false to avoid assignments to archived orgs
    });

    const { administrations } = await getAdministrationsFromOrgs({
      orgs: addedExhaustiveOrgs,
      transaction,
      restrictToOpenAdministrations: true, // Restrict to open administrations so that the user does not get an assignment to a closed administration.
    });

    const administrationsWithData: Array<{
      administrationId: string;
      administrationData: IAdministration;
    }> = [];
    for (const administrationId of administrations) {
      const administrationRef = db
        .collection("administrations")
        .doc(administrationId);
      const administrationDoc = await transaction.get(administrationRef);
      if (administrationDoc.exists) {
        const administrationData = administrationDoc.data() as IAdministration;
        const dateClosed = parseTimestamp(administrationData.dateClosed);
        if (Number.isNaN(dateClosed.getTime()) || dateClosed <= new Date()) {
          continue;
        }
        administrationsWithData.push({ administrationId, administrationData });
      }
    }

    await updateAssignmentsForUserFromAdministrations(
      roarUid,
      administrationsWithData,
      transaction,
      statsRegistry
    );
    statsRegistry.flush(transaction);
  });
};

/**
 * Atomically resyncs a user's assignments and persists a user-doc field change
 * in a single transaction.
 *
 * Used when a field that assignment conditions depend on (e.g. birthMonth/
 * birthYear) changes: the assignment evaluation must see the new value, but
 * Firestore forbids writing then re-reading the same doc in a transaction.
 * `userDataOverride` sidesteps this by evaluating conditions against the
 * request's new values instead of the stored doc. Enumerating administrations
 * from the user's current orgs (not just existing assignment docs) makes the
 * resync correct in both directions: newly eligible administrations get created
 * and newly ineligible assignments get reduced or deleted.
 *
 * Read-before-write ordering holds: all reads (orgs, administration docs, and
 * the user-doc reads in the assignment read phase) complete before any write,
 * including the field-change write appended at the end.
 *
 * @param {string} uid - The user to resync.
 * @param {IOrgsList} currentOrgs - The user's current org membership.
 * @param {Record<string, unknown>} userDocUpdate - The field change to persist on the user doc.
 * @param {Record<string, unknown>} userDataOverride - Condition inputs to evaluate against (e.g. new birthMonth/birthYear).
 */
export const syncAssignmentsForUserFieldChange = async (
  uid: string,
  currentOrgs: IOrgsList,
  userDocUpdate: Record<string, unknown>,
  userDataOverride: Record<string, unknown>
) => {
  const db = getFirestore();
  await db.runTransaction(async (transaction) => {
    const statsRegistry = new AdminStatsBufferRegistry(db);
    const exhaustiveOrgs = await getExhaustiveOrgs({
      orgs: currentOrgs,
      transaction,
      includeArchived: false,
    });

    const { administrations } = await getAdministrationsFromOrgs({
      orgs: exhaustiveOrgs,
      transaction,
      restrictToOpenAdministrations: true,
    });

    const administrationsWithData: Array<{
      administrationId: string;
      administrationData: IAdministration;
    }> = [];
    for (const administrationId of administrations) {
      const administrationRef = db
        .collection("administrations")
        .doc(administrationId);
      const administrationDoc = await transaction.get(administrationRef);
      if (administrationDoc.exists) {
        const administrationData = administrationDoc.data() as IAdministration;
        const dateClosed = parseTimestamp(administrationData.dateClosed);
        if (Number.isNaN(dateClosed.getTime()) || dateClosed <= new Date()) {
          continue;
        }
        administrationsWithData.push({ administrationId, administrationData });
      }
    }

    await updateAssignmentsForUserFromAdministrations(
      uid,
      administrationsWithData,
      transaction,
      statsRegistry,
      userDataOverride
    );
    transaction.update(db.collection("users").doc(uid), userDocUpdate);
    statsRegistry.flush(transaction);
  });
};

/**
 * Update assigned orgs in all administrations that are assigned to a certain
 * org.
 *
 * @param {string} input.queryOrgType - Query for administrations assigned to
 *                                      this org type
 * @param {string} input.queryOrgId - Query for administrations assigned to this
 *                                    org ID
 * @param {string[]} input.districtsToRemove - The districts to unassign from
 *                                             the returned administrations
 * @param {string[]} input.schoolsToRemove - The districts to unassign from the
 *                                           returned administrations
 * @param {string[]} input.classesToRemove - The districts to unassign from the
 *                                           returned administrations
 * @param {string[]} input.groupsToRemove - The districts to unassign from the
 *                                          returned administrations
 * @param {string[]} input.familiesToRemove - The districts to unassign from the
 *                                            returned administrations
 * @param {Transaction} input.transaction - The transaction to use
 * @param {Firestore} input.db - The Firestore instance to use
 */
export const updateOrgsInAdministration = async ({
  queryOrgType,
  queryOrgId,
  districtsToRemove = [],
  schoolsToRemove = [],
  classesToRemove = [],
  groupsToRemove = [],
  familiesToRemove = [],
  restrictToOpenAdministrations = true,
  transaction,
  db = getFirestore(),
}: {
  queryOrgType: string;
  queryOrgId: string;
  districtsToRemove?: string[];
  schoolsToRemove?: string[];
  classesToRemove?: string[];
  groupsToRemove?: string[];
  familiesToRemove?: string[];
  restrictToOpenAdministrations?: boolean;
  transaction: Transaction;
  db?: Firestore;
}) => {
  const filterComponents = [
    Filter.where("orgType", "==", queryOrgType),
    Filter.where("orgId", "==", queryOrgId),
  ];

  if (restrictToOpenAdministrations) {
    filterComponents.push(Filter.where("dateClosed", ">", new Date()));
  }

  const administrationQuery = db
    .collectionGroup("assignedOrgs")
    .where(Filter.and(...filterComponents));

  const querySnapshot = await transaction.get(administrationQuery);

  // The querySnapshot.docs will correspond to the documents in each
  // administration's assignedOrgs subcollection. We need to get the
  // administration documents, which are the "grandparent" document reference
  // for each of these documents.
  // There will potentially be duplicates so we need to get uniq values by the
  // ref.path parameter.
  const administrationDocRefs = _without(
    _uniqBy(
      querySnapshot.docs.map((doc) => doc.ref.parent.parent),
      (ref: DocumentReference | null) => ref?.path?.toString()
    ),
    undefined,
    null
  ) as DocumentReference[];

  const updateActions: UpdateAction[] = [];

  for (const doc of administrationDocRefs) {
    updateActions.push({
      docRef: doc,
      fieldPath: "lastUpdated",
      fieldValue: Timestamp.fromDate(new Date()),
    });

    for (const [orgType, orgsToRemove] of Object.entries({
      districts: districtsToRemove,
      schools: schoolsToRemove,
      classes: classesToRemove,
      groups: groupsToRemove,
      families: familiesToRemove,
    })) {
      if (orgsToRemove.length) {
        updateActions.push({
          docRef: doc,
          fieldPath: orgType,
          fieldValue: FieldValue.arrayRemove(...orgsToRemove),
        });
      }
    }
  }

  return updateActions;
};
