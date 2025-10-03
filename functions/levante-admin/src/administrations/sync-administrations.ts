import {
  DocumentReference,
  getFirestore,
  Filter,
  Transaction,
  FieldValue,
  Firestore,
  Timestamp,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { getFunctions } from "firebase-admin/functions";
import _chunk from "lodash/chunk";
import _difference from "lodash/difference";
import _forEach from "lodash/forEach";
import _fromPairs from "lodash/fromPairs";
import _isEqual from "lodash/isEqual";
import _map from "lodash/map";
import _pick from "lodash/pick";
import _uniqBy from "lodash/uniqBy";
import _without from "lodash/without";
import _reduce from "lodash/reduce";
import { IAdministration, IOrgsList, ORG_NAMES } from "../interfaces";
import {
  chunkOrgs,
  getExhaustiveOrgs,
  getOnlyExistingOrgs,
  getUsersFromOrgs,
} from "../orgs/org-utils";
import { UpdateAction } from "../utils/transactions";
import {
  removeAssignmentFromUsers,
  removeOrgsFromAssignments,
  updateAssignmentForUser,
  // updateAssignmentForUsers,
} from "../assignments/assignment-utils";
import {
  getAdministrationsFromOrgs,
  standardizeAdministrationOrgs,
} from "./administration-utils";
import {
  summarizeIdListForLog,
  summarizeOrgsForLog,
} from "../utils/logging";
import { getFunctionUrl, MAX_TRANSACTIONS } from "../utils/utils";

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
    });

    if (prevUsers.length <= MAX_TRANSACTIONS) {
      // If the number of users is small enough, remove them in this transaction.
      return removeAssignmentFromUsers(
        prevUsers,
        administrationId,
        transaction
      );
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
      return removeAssignmentFromUsers(
        _userChunk,
        administrationId,
        transaction
      );
    });
  }

  return Promise.resolve({ status: "ok" });
};

export const processNewAdministration = async (
  administrationId: string,
  administrationDocRef: DocumentReference,
  currData: IAdministration
) => {
  const { minimalOrgs } = await standardizeAdministrationOrgs({
    administrationId,
    administrationDocRef,
    currData,
    copyToSubCollections: true,
    forceCopy: true,
  });

  const taskName = "updateAssignmentsForOrgChunk";
  const queue = getFunctions().taskQueue(taskName);
  const targetUri = await getFunctionUrl(taskName);
  const enqueues: Promise<void>[] = [];

  for (const orgChunk of chunkOrgs(minimalOrgs, 100)) {
    logger.debug("Enqueueing task for org chunk", {
      administrationId,
      targetUri,
      taskName,
      orgChunkSummary: summarizeOrgsForLog(orgChunk),
    });

    enqueues.push(
      queue.enqueue(
        {
          administrationData: currData,
          administrationId,
          orgChunk,
          mode: "add",
        },
        {
          dispatchDeadlineSeconds: 60 * 30, // 30 minutes
          uri: targetUri,
        }
      )
    );
  }

  await Promise.all(enqueues);

  return Promise.resolve({ status: "ok" });
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

  // Skip removal transaction if no orgs were removed to avoid empty transaction errors.
  if (numRemovedOrgs > 0) {
    // Run the first transaction to get the user list
    await db.runTransaction(async (transaction) => {
      const removedExistingOrgs = await getOnlyExistingOrgs(
        removedOrgs,
        transaction
      );
      removedExhaustiveOrgs = await getExhaustiveOrgs({
        orgs: removedExistingOrgs,
        transaction,
        includeArchived: true, // `includeArchived` is true to remove assignments even from archived orgs
      });
      const usersToRemove = await getUsersFromOrgs({
        orgs: removedExhaustiveOrgs,
        transaction,
        includeArchived: true, // remove assignments even from archived users
      });

      logger.debug(`Removing assignment ${administrationId} from users`, {
        userSummary: summarizeIdListForLog(usersToRemove),
      });

      if (usersToRemove.length !== 0) {
        if (usersToRemove.length <= MAX_TRANSACTIONS) {
          // If the number of users is small enough, remove them in this transaction.
          return removeOrgsFromAssignments(
            usersToRemove,
            [administrationId],
            removedExhaustiveOrgs,
            transaction
          );
        } else {
          // Otherwise, just save for the next loop over user chunks.
          remainingUsersToRemove = usersToRemove;
          return Promise.resolve(usersToRemove.length);
        }
      } else {
        return Promise.resolve(0);
      }
    });

    // If remainingUsersToRemove.length === 0, then these chunks will be of zero length
    // and the entire loop below is a no-op.
    for (const _userChunk of _chunk(remainingUsersToRemove, MAX_TRANSACTIONS)) {
      await db.runTransaction(async (transaction) => {
        return removeOrgsFromAssignments(
          _userChunk,
          [administrationId],
          removedExhaustiveOrgs,
          transaction
        );
      });
    }
  }

  //        +-------------------------------+
  // -------| Update or add remaining users |---------
  //        +-------------------------------+

  const { minimalOrgs } = await standardizeAdministrationOrgs({
    administrationId,
    administrationDocRef,
    currData,
    copyToSubCollections: true,
    forceCopy: true,
  });

  const taskName = "updateAssignmentsForOrgChunk";
  const queue = getFunctions().taskQueue(taskName);
  const targetUri = await getFunctionUrl(taskName);
  const enqueues: Promise<void>[] = [];

  for (const orgChunk of chunkOrgs(minimalOrgs, 100)) {
    logger.debug("Enqueueing task for org chunk", {
      administrationId,
      targetUri,
      taskName,
      orgChunkSummary: summarizeOrgsForLog(orgChunk),
    });
    enqueues.push(
      queue.enqueue(
        {
          administrationData: currData,
          administrationId,
          orgChunk,
          mode: "update",
        },
        {
          dispatchDeadlineSeconds: 60 * 30, // 30 minutes
          uri: targetUri,
        }
      )
    );
  }

  await Promise.all(enqueues);
  return Promise.resolve({ status: "ok" });
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

    const assignments = await Promise.all(
      _map(administrations, async (administrationId) => {
        const administrationRef = db
          .collection("administrations")
          .doc(administrationId);
        const administrationDoc = await transaction.get(administrationRef);
        if (administrationDoc.exists) {
          const administrationData =
            administrationDoc.data() as IAdministration;
          // Get administrationData using transaction.get()
          return updateAssignmentForUser(
            roarUid,
            administrationId,
            administrationData,
            transaction
          );
        } else {
          return [undefined, undefined];
        }
      })
    );

    _forEach(assignments, ([assignmentRef, assignmentData]) => {
      if (assignmentRef && assignmentData) {
        transaction.set(assignmentRef, assignmentData, { merge: true });
      } else if (assignmentRef) {
        transaction.delete(assignmentRef);
      } else {
        transaction;
      }
    });
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
