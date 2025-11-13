import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import _chunk from "lodash-es/chunk.js";
import _difference from "lodash-es/difference.js";
import _fromPairs from "lodash-es/fromPairs.js";
import _get from "lodash-es/get.js";
import _isEmpty from "lodash-es/isEmpty.js";
import _isEqual from "lodash-es/isEqual.js";
import _map from "lodash-es/map.js";
import _pick from "lodash-es/pick.js";
import _reduce from "lodash-es/reduce.js";
import _toPairs from "lodash-es/toPairs.js";
import type { IAdministration, IOrgsList } from "../interfaces.js";
import { ORG_NAMES } from "../interfaces.js";
import {
  processModifiedAdministration,
  processNewAdministration,
  processRemovedAdministration,
  processUserAddedOrgs,
} from "../administrations/sync-administrations.js";
import { type DocumentWrittenEvent, MAX_TRANSACTIONS } from "../utils/utils.js";
import { processUserRemovedOrgs } from "../administrations/administration-utils.js";
import { getUsersFromOrgs } from "../orgs/org-utils.js";
import {
  addAssignmentToUsers,
  updateAssignmentForUsers,
  rollbackAssignmentCreation,
} from "./assignment-utils.js";
import {
  summarizeIdListForLog,
  summarizeOrgsForLog,
} from "../utils/logging.js";
import { updateAdministrationStatsForOrgChunk } from "./on-assignment-updates.js";

/**
 * Sync globally defined adminstrations with user-specific assignments.
 *
 * Administrations are globally defined, while assignments are specific to each
 * user. This function determines all assigned users and syncs the globally
 * defined adminstration data with their local assignment data.
 *
 * It also checks to see that the list of assigned orgs is exhaustive. By
 * "exhaustive," we mean that any organization in the administration's org list
 * must have each of its dependent organizations explicitly listed in the same
 * administration's org list. For example, if district1 is in the ``districts``
 * list and district1 contains schools A and B. Then schools A and B should also
 * be in the ``schools`` list of the administration. Likewise if school A
 * contains classes alpha and beta, then classes alpha and beta should also be
 * in the administration's ``classes`` list. This function ensures that org lists
 * are exhaustive.
 *
 * Because this function both writes to and is triggered by changes to the
 * administration document, we check to prevent infinite loops where document
 * change -> function trigger -> document change, and so on.
 *
 * @param {DocumentWrittenEvent} event - The event that triggered this function.
 */
export const syncAssignmentsOnAdministrationUpdateEventHandler = async (
  event: DocumentWrittenEvent
) => {
  const db = getFirestore();
  const administrationId = event.params.administrationId;
  const prevData = event.data?.before.data();
  const currData = event.data?.after.data();
  const administrationDocRef = db
    .collection("administrations")
    .doc(administrationId);
  let prevOrgs: IOrgsList = {};

  if (currData === undefined) {
    // In this case, the document was deleted.
    // So grab all of the previous orgs remove the assignments for their users.
    if (prevData === undefined) {
      // This is weird, we should never get here.
      return Promise.resolve({ status: "ok" });
    }
    prevOrgs = _pick(prevData, ORG_NAMES);

    const createdBy = _get(prevData, "createdBy");
    if (createdBy) {
      const creatorDocRef = db.collection("users").doc(createdBy);
      const fieldPath = new FieldPath("adminData", "administrationsCreated");
      await creatorDocRef.update(
        fieldPath,
        FieldValue.arrayRemove(administrationId)
      );
    }
    return processRemovedAdministration(administrationId, prevOrgs);
  }

  if (prevData === undefined) {
    console.log("new administration", administrationId);
    // In this case, the document was created.
    // So grab any orgs and assign all of those orgs' users to the administration.
    return processNewAdministration(
      administrationId,
      administrationDocRef,
      currData as IAdministration
    );
  }

  // If we get here, then the document was modified.
  return processModifiedAdministration(
    administrationId,
    administrationDocRef,
    prevData as IAdministration,
    currData as IAdministration
  );
};

export const syncAssignmentsOnUserUpdateEventHandler = async ({
  event,
  userTypes = ["student"],
}: {
  event: DocumentWrittenEvent;
  userTypes: string[];
}) => {
  const roarUid = event.params.roarUid;
  const prevData = event.data?.before.data();
  const currData = event.data?.after.data();

  const prevOrgs = _pick(prevData, ORG_NAMES);
  const currOrgs = _pick(currData, ORG_NAMES);

  if (userTypes.includes(currData?.userType)) {
    // The orgs data structure for users is different than for administrations.
    // Each org is an object with fields `all`, `current`, and `dates`.
    // We are only concerned with the `current` orgs.
    // So we extract those and save to the variables `prevOrgLists` and `currOrgLists`.
    const prevOrgLists = _fromPairs(
      _map(_toPairs(prevOrgs), ([orgName, orgObj]) => [
        orgName,
        orgObj.current ?? [],
      ])
    );
    const currOrgLists = _fromPairs(
      _map(_toPairs(currOrgs), ([orgName, orgObj]) => [
        orgName,
        orgObj.current ?? [],
      ])
    );

    logger.debug(`user ${roarUid} changed`, {
      prevOrgSummary: summarizeOrgsForLog(prevOrgLists),
      currOrgSummary: summarizeOrgsForLog(currOrgLists),
    });

    if (!_isEmpty(currOrgLists) && !_isEqual(prevOrgs, currOrgs)) {
      const removedOrgs = _fromPairs(
        _map(Object.entries(prevOrgLists), ([key, value]) => [
          key,
          _difference(value, currOrgLists[key]),
        ])
      ) as IOrgsList;

      const numRemovedOrgs = _reduce(
        removedOrgs,
        (sum, value) => (value ? sum + value.length : sum),
        0
      );

      if (numRemovedOrgs > 0) {
        await processUserRemovedOrgs(roarUid, removedOrgs);
      }

      const addedOrgs = _fromPairs(
        _map(Object.entries(currOrgLists), ([key, value]) => [
          key,
          _difference(value, prevOrgLists[key]),
        ])
      ) as IOrgsList;

      const numAddedOrgs = _reduce(
        addedOrgs,
        (sum, value) => (value ? sum + value.length : sum),
        0
      );

      if (numAddedOrgs > 0) {
        await processUserAddedOrgs(roarUid, addedOrgs);
      }
    }
  }
};

export const updateAssignmentsForOrgChunkHandler = async ({
  administrationId,
  administrationData,
  orgChunk,
  mode = "update",
}: {
  administrationId: string;
  administrationData: IAdministration;
  orgChunk: IOrgsList;
  mode: "update" | "add";
}): Promise<{ success: boolean; userIds: string[]; error?: Error }> => {
  if (!["update", "add"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Expected 'update' or 'add'.`);
  }

  const db = getFirestore();
  const createdUserIds: string[] = [];

  try {
    // Get all of the current users and update their assignments. The
    // maximum number of docs we can update in a single transaction is
    // ``MAX_TRANSACTIONS``. The number of affected users is potentially
    // larger. So we loop through chunks of the userIds and update them in
    // separate transactions if necessary.

    // ``remainingUsers`` is a placeholder in the event that the number of
    // affected users is greater than the maximum number of docs we can update
    // in a single transaction.
    let remainingUsers: string[] = [];
    let totalUsersAssigned = 0;

    // Run the first transaction to get the user list
    await db.runTransaction(async (transaction) => {
      const usersToUpdate = await getUsersFromOrgs({
        orgs: orgChunk,
        transaction,
        includeArchived: false, // Do not assign updated assignment to archived users
      });

      logger.info(`Updating assignment ${administrationId} for users`, {
        orgChunkSummary: summarizeOrgsForLog(orgChunk),
        userSummary: summarizeIdListForLog(usersToUpdate),
      });

      if (usersToUpdate.length !== 0) {
        if (usersToUpdate.length <= MAX_TRANSACTIONS) {
          // If the number of users is small enough, update them in this transaction.
          if (mode === "update") {
            return updateAssignmentForUsers(
              usersToUpdate,
              administrationId,
              administrationData,
              transaction
            );
          } else {
            console.log("adding assignments to users");
            totalUsersAssigned = usersToUpdate.length;
            createdUserIds.push(...usersToUpdate);
            return addAssignmentToUsers(
              usersToUpdate,
              administrationId,
              administrationData,
              transaction
            );
          }
        } else {
          // Otherwise, just save for the next loop over user chunks.
          remainingUsers = usersToUpdate;
          return Promise.resolve(usersToUpdate.length);
        }
      } else {
        return Promise.resolve(0);
      }
    });

    // If remainingUsersToRemove.length === 0, then these chunks will be of zero length
    // and the entire loop below is a no-op.
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
          totalUsersAssigned += _userChunk.length;
          createdUserIds.push(..._userChunk);
          return addAssignmentToUsers(
            _userChunk,
            administrationId,
            administrationData,
            transaction
          );
        }
      });
    }

    // Update administration stats synchronously for immediate visibility
    // Only update stats when adding new assignments (not when updating)
    if (mode === "add" && totalUsersAssigned > 0) {
      await updateAdministrationStatsForOrgChunk(
        administrationId,
        orgChunk,
        administrationData,
        totalUsersAssigned
      );
    }

    return { success: true, userIds: createdUserIds };
  } catch (error: any) {
    logger.error("Error creating assignments for org chunk", {
      error,
      administrationId,
      orgChunkSummary: summarizeOrgsForLog(orgChunk),
      createdUserIds,
    });

    // Rollback all created assignments if any failed
    if (mode === "add" && createdUserIds.length > 0) {
      try {
        await rollbackAssignmentCreation(
          createdUserIds,
          administrationId,
          orgChunk,
          administrationData
        );
      } catch (rollbackError: any) {
        logger.error("Error during rollback of assignment creation", {
          rollbackError,
          administrationId,
          userIds: createdUserIds,
        });
      }
    }

    return { success: false, userIds: createdUserIds, error };
  }
};
