import { DocumentReference, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import _chunk from "lodash/chunk";
import _difference from "lodash/difference";
import _fromPairs from "lodash/fromPairs";
import _map from "lodash/map";
import _pick from "lodash/pick";
import _reduce from "lodash/reduce";
import {
  addAssignmentToUsers,
  removeAssignmentFromUsers,
  removeOrgsFromAssignments,
  updateAssignmentForUsers,
} from "../assignments/assignment-utils";
import { IAdministration, IOrgsList, ORG_NAMES } from "../interfaces";
import {
  chunkOrgs,
  getExhaustiveOrgs,
  getOnlyExistingOrgs,
  getUsersFromOrgs,
} from "../orgs/org-utils";
import { MAX_TRANSACTIONS } from "../utils/utils";
import { standardizeAdministrationOrgs } from "./administration-utils";

/**
 * Manually process a new administration - called directly from upsertAdministration
 * This replaces the triggered processNewAdministration function
 */
export const manualProcessNewAdministration = async (
  administrationId: string,
  administrationDocRef: DocumentReference,
  currData: IAdministration
) => {
  logger.info("Manually processing new administration", { administrationId });

  const { minimalOrgs } = await standardizeAdministrationOrgs({
    administrationId,
    administrationDocRef,
    currData,
    copyToSubCollections: true,
    forceCopy: true,
  });

  // Process org chunks directly instead of enqueueing tasks
  const orgChunks = chunkOrgs(minimalOrgs, 100);

  for (const orgChunk of orgChunks) {
    logger.debug("Processing org chunk manually", {
      orgChunk,
      administrationId,
    });

    await manualUpdateAssignmentsForOrgChunk({
      administrationId,
      administrationData: currData,
      orgChunk,
      mode: "add",
    });
  }

  logger.info("Completed manual processing of new administration", {
    administrationId,
  });

  return { status: "ok" };
};

/**
 * Manually process a modified administration - called directly from upsertAdministration
 * This replaces the triggered processModifiedAdministration function
 */
export const manualProcessModifiedAdministration = async (
  administrationId: string,
  administrationDocRef: DocumentReference,
  prevData: IAdministration,
  currData: IAdministration
) => {
  const db = getFirestore();
  const prevOrgs: IOrgsList = _pick(prevData, ORG_NAMES);
  const currOrgs: IOrgsList = _pick(currData, ORG_NAMES);

  logger.info("Manually processing modified administration", {
    administrationId,
    currOrgs,
    prevOrgs,
  });

  // Remove users from removed orgs
  const removedOrgs = _fromPairs(
    _map(Object.entries(currOrgs), ([key, value]) => [
      key,
      _difference(prevOrgs[key], value),
    ])
  ) as IOrgsList;

  const numRemovedOrgs = _reduce(
    removedOrgs,
    (sum, value) => (value ? sum + value.length : sum),
    0
  );

  if (numRemovedOrgs > 0) {
    logger.debug("Removing users from removed orgs", { removedOrgs });

    let remainingUsersToRemove: string[] = [];
    let removedExhaustiveOrgs: IOrgsList = {};

    // Run the first transaction to get the user list
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
      const usersToRemove = await getUsersFromOrgs({
        orgs: removedExhaustiveOrgs,
        transaction,
        includeArchived: true,
      });

      if (usersToRemove.length !== 0) {
        if (usersToRemove.length <= MAX_TRANSACTIONS) {
          return removeOrgsFromAssignments(
            usersToRemove,
            [administrationId],
            removedExhaustiveOrgs,
            transaction
          );
        } else {
          remainingUsersToRemove = usersToRemove;
          return Promise.resolve(usersToRemove.length);
        }
      } else {
        return Promise.resolve(0);
      }
    });

    // Process remaining users in chunks
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

  // Update/add remaining users
  const { minimalOrgs } = await standardizeAdministrationOrgs({
    administrationId,
    administrationDocRef,
    currData,
    copyToSubCollections: true,
    forceCopy: true,
  });

  // Process org chunks directly instead of enqueueing tasks
  const orgChunks = chunkOrgs(minimalOrgs, 100);

  for (const orgChunk of orgChunks) {
    logger.debug("Processing org chunk manually", {
      orgChunk,
      administrationId,
    });

    await manualUpdateAssignmentsForOrgChunk({
      administrationId,
      administrationData: currData,
      orgChunk,
      mode: "update",
    });
  }

  logger.info("Completed manual processing of modified administration", {
    administrationId,
  });

  return { status: "ok" };
};

/**
 * Manually process a removed administration - called directly from upsertAdministration
 * This replaces the triggered processRemovedAdministration function
 */
export const manualProcessRemovedAdministration = async (
  administrationId: string,
  prevOrgs: IOrgsList
) => {
  const db = getFirestore();

  logger.info("Manually processing removed administration", {
    administrationId,
  });

  let remainingUsers: string[] = [];

  // Run the first transaction to get the user list
  await db.runTransaction(async (transaction) => {
    const prevUsers = await getUsersFromOrgs({
      orgs: prevOrgs,
      transaction,
      includeArchived: true,
    });

    if (prevUsers.length <= MAX_TRANSACTIONS) {
      return removeAssignmentFromUsers(
        prevUsers,
        administrationId,
        transaction
      );
    } else {
      remainingUsers = prevUsers;
      return Promise.resolve(prevUsers.length);
    }
  });

  // Process remaining users in chunks
  for (const _userChunk of _chunk(remainingUsers, MAX_TRANSACTIONS)) {
    await db.runTransaction(async (transaction) => {
      return removeAssignmentFromUsers(
        _userChunk,
        administrationId,
        transaction
      );
    });
  }

  logger.info("Completed manual processing of removed administration", {
    administrationId,
  });

  return { status: "ok" };
};

/**
 * Manually update assignments for org chunk - replaces the task queue function
 */
export const manualUpdateAssignmentsForOrgChunk = async ({
  administrationId,
  administrationData,
  orgChunk,
  mode = "update",
}: {
  administrationId: string;
  administrationData: IAdministration;
  orgChunk: IOrgsList;
  mode: "update" | "add";
}) => {
  if (!["update", "add"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Expected 'update' or 'add'.`);
  }

  const db = getFirestore();
  let remainingUsers: string[] = [];

  // Run the first transaction to get the user list
  await db.runTransaction(async (transaction) => {
    const usersToUpdate = await getUsersFromOrgs({
      orgs: orgChunk,
      transaction,
      includeArchived: false,
    });

    logger.debug("Updating assignments for users", {
      usersToUpdate: usersToUpdate.length,
      administrationId,
      mode,
    });

    if (usersToUpdate.length !== 0) {
      if (usersToUpdate.length <= MAX_TRANSACTIONS) {
        if (mode === "update") {
          return updateAssignmentForUsers(
            usersToUpdate,
            administrationId,
            administrationData,
            transaction
          );
        } else {
          return addAssignmentToUsers(
            usersToUpdate,
            administrationId,
            administrationData,
            transaction
          );
        }
      } else {
        remainingUsers = usersToUpdate;
        return Promise.resolve(usersToUpdate.length);
      }
    } else {
      return Promise.resolve(0);
    }
  });

  // Process remaining users in chunks
  for (const _userChunk of _chunk(remainingUsers, MAX_TRANSACTIONS)) {
    await db.runTransaction(async (transaction) => {
      if (mode === "update") {
        return updateAssignmentForUsers(
          _userChunk,
          administrationId,
          administrationData,
          transaction
        );
      } else {
        return addAssignmentToUsers(
          _userChunk,
          administrationId,
          administrationData,
          transaction
        );
      }
    });
  }
};
