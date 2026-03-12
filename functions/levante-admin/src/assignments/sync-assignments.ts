import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
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
  enqueueAddUpdateTasksForAdministration,
  processUserAddedOrgs,
} from "../administrations/sync-administrations.js";
import { MAX_TRANSACTIONS } from "../utils/utils.js";
import { processUserRemovedOrgs } from "../administrations/administration-utils.js";
import {
  addAssignmentToUsers,
  removeOrgsFromAssignments,
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

const BATCH_SIZE = 500;

const updateAssignmentDocsSyncStatus = async (
  db: ReturnType<typeof getFirestore>,
  administrationId: string,
  syncStatus: "complete" | "failed"
) => {
  const queryLabel = "collectionGroup(assignments).where(id)==administrationId";
  logger.info("INDEX_QUERY: about to run", {
    indexQueryLabel: queryLabel,
    administrationId,
    syncStatus,
  });
  const snapshot = await db
    .collectionGroup("assignments")
    .where("id", "==", administrationId)
    .get();
  if (snapshot.empty) return;
  for (let i = 0; i < snapshot.docs.length; i += BATCH_SIZE) {
    const batch = db.batch();
    const chunk = snapshot.docs.slice(i, i + BATCH_SIZE);
    for (const doc of chunk) {
      batch.update(doc.ref, {
        syncStatus,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }
    await batch.commit();
  }
  logger.debug(
    `Updated ${snapshot.size} assignment(s) to syncStatus=${syncStatus}`,
    {
      administrationId,
    }
  );
};

const recordChunkSuccess = async (
  db: ReturnType<typeof getFirestore>,
  administrationId: string
) => {
  const adminRef = db.collection("administrations").doc(administrationId);
  const result = await db.runTransaction(async (transaction) => {
    const doc = await transaction.get(adminRef);
    const data = doc.data();
    const completed = ((data?.syncChunksCompleted as number) ?? 0) + 1;
    const total = (data?.syncChunksTotal as number) ?? 0;
    transaction.update(adminRef, {
      syncChunksCompleted: completed,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { completed, total };
  });
  if (result.completed >= result.total) {
    await adminRef.update({
      syncStatus: "complete",
      _syncRollback: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.info("INDEX_QUERY: about to call updateAssignmentDocsSyncStatus", {
      indexQueryLabel: "recordChunkSuccess.beforeUpdateSyncStatus",
      administrationId,
    });
    await updateAssignmentDocsSyncStatus(db, administrationId, "complete");
  }
};

const RESTORE_MESSAGE = " Restored to previous state.";

const recordChunkFailure = async (
  db: ReturnType<typeof getFirestore>,
  administrationId: string,
  error: Error,
  mode: "update" | "add" | "remove"
) => {
  const adminRef = db.collection("administrations").doc(administrationId);
  if (mode === "update") {
    const doc = await adminRef.get();
    const rollback = doc.data()?._syncRollback as
      | Record<string, unknown>
      | undefined;
    if (rollback) {
      await adminRef.update({
        ...rollback,
        syncStatus: "failed",
        syncErrorMessage: `${error.message}${RESTORE_MESSAGE}`,
        _syncRollback: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      await updateAssignmentDocsSyncStatus(db, administrationId, "failed");
      return;
    }
  }
  await adminRef.update({
    syncStatus: "failed",
    syncErrorMessage: error.message,
    updatedAt: FieldValue.serverTimestamp(),
  });
  await updateAssignmentDocsSyncStatus(db, administrationId, "failed");
};

type AddUpdatePayload = {
  administrationId: string;
  administrationData: IAdministration;
  userIds: string[];
  mode: "update" | "add";
};

type RemovePayload = {
  mode: "remove";
  administrationId: string;
  userIds: string[];
  removedExhaustiveOrgs: IOrgsList;
  isLastRemovalChunk?: boolean;
  currData?: IAdministration;
  prevData?: IAdministration;
};

export const updateAssignmentsForOrgChunkHandler = async (
  payload: AddUpdatePayload | RemovePayload
) => {
  const { administrationId, userIds, mode } = payload;
  const db = getFirestore();
  try {
    if (userIds.length > MAX_TRANSACTIONS) {
      throw new Error(
        `userIds length (${userIds.length}) exceeds MAX_TRANSACTIONS (${MAX_TRANSACTIONS})`
      );
    }

    if (mode === "remove") {
      const { removedExhaustiveOrgs, isLastRemovalChunk, currData, prevData } =
        payload;
      await db.runTransaction(async (transaction) => {
        return removeOrgsFromAssignments(
          userIds,
          [administrationId],
          removedExhaustiveOrgs,
          transaction
        );
      });
      if (isLastRemovalChunk && currData && prevData) {
        const adminRef = db.collection("administrations").doc(administrationId);
        await enqueueAddUpdateTasksForAdministration(
          administrationId,
          adminRef,
          currData,
          prevData
        );
      }
      return;
    }

    const { administrationData } = payload as AddUpdatePayload;
    if (!["update", "add"].includes(mode)) {
      throw new Error(`Invalid mode: ${mode}. Expected 'update' or 'add'.`);
    }

    logger.info("INDEX_QUERY: about to run transaction (add/update users)", {
      indexQueryLabel: "chunkTransaction",
      administrationId,
      mode,
      userIdCount: userIds.length,
    });
    await db.runTransaction(async (transaction) => {
      if (mode === "update") {
        return updateAssignmentForUsers(
          userIds,
          administrationId,
          administrationData,
          transaction
        );
      }
      return addAssignmentToUsers(
        userIds,
        administrationId,
        administrationData,
        transaction
      );
    });

    logger.info("INDEX_QUERY: transaction done, calling recordChunkSuccess", {
      indexQueryLabel: "beforeRecordChunkSuccess",
      administrationId,
    });
    await recordChunkSuccess(db, administrationId);
  } catch (error) {
    await recordChunkFailure(
      db,
      administrationId,
      error instanceof Error ? error : new Error(String(error)),
      mode
    );
    throw error;
  }
};
