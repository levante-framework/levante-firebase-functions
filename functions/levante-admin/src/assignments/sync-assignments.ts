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
  processUserAddedOrgs,
} from "../administrations/sync-administrations.js";
import { MAX_TRANSACTIONS } from "../utils/utils.js";
import { processUserRemovedOrgs } from "../administrations/administration-utils.js";
import { getUsersFromOrgs } from "../orgs/org-utils.js";
import {
  addAssignmentToUsers,
  updateAssignmentForUsers,
} from "./assignment-utils.js";
import {
  summarizeIdListForLog,
  summarizeOrgsForLog,
} from "../utils/logging.js";

export const syncAssignmentsForUserOrgChange = async ({
  roarUid,
  prevData,
  currData,
  userTypes = ["student", "parent", "teacher"],
}: {
  roarUid: string;
  prevData: Record<string, unknown> | undefined;
  currData: Record<string, unknown> | undefined;
  userTypes?: string[];
}) => {
  if (!prevData || !currData) return;
  const prevOrgs = _pick(prevData, ORG_NAMES);
  const currOrgs = _pick(currData, ORG_NAMES);

  if (userTypes.includes((currData?.userType as string) ?? "")) {
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
}) => {
  if (!["update", "add"].includes(mode)) {
    throw new Error(`Invalid mode: ${mode}. Expected 'update' or 'add'.`);
  }

  const db = getFirestore();

  // Get all of the current users and update their assignments. The
  // maximum number of docs we can update in a single transaction is
  // ``MAX_TRANSACTIONS``. The number of affected users is potentially
  // larger. So we loop through chunks of the userIds and update them in
  // separate transactions if necessary.

  // ``remainingUsers`` is a placeholder in the event that the number of
  // affected users is greater than the maximum number of docs we can update
  // in a single transaction.
  let remainingUsers: string[] = [];

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
