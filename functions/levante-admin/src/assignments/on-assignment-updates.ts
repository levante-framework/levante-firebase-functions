/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  CollectionReference,
  DocumentReference,
  FieldPath,
  FieldValue,
  Transaction,
  getFirestore,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import _isEmpty from "lodash-es/isEmpty";
import _reduce from "lodash-es/reduce";
import _without from "lodash-es/without";
import {
  DocumentCreatedEvent,
  DocumentDeletedEvent,
  DocumentUpdatedEvent,
} from "../utils/utils.js";

type Status = "assigned" | "started" | "completed";

/**
 * Increment (or decrement) the completion status of each org in an org list.
 *
 * Completion stats are stored in a collection under each Firestore
 * administration document. Within that collection, there is a document for each
 * assigned organization as well as a document called "total" for all assignees.
 *
 * Each of those documents has fields for each assessment/task as well as a
 * field called "assignment" for the assignment as a whole. Then each of those
 * fields is itself a map with the fields "assigned", "started", "completed".
 * The values are the number of students who have attained each respective
 * status.
 *
 * This function increments a single status given a list of taskIds and
 * organizations.
 *
 * @param {string[]} orgList - List of org IDs that will have their status updated.
 * @param {Status} status - The status to update: "assigned", "started", or "completed".
 * @param {string[]} taskIds - The task IDs that will have their status updated.
 * @param {CollectionReference} completionCollectionRef - The Firestore collection to update.
 * @param {Transaction} transaction - Firestore transaction to use.
 * @param {number} incrementBy - The amount to increment the total by. Defaults
 *                               to 1. Set to -1 to decrement.
 * @param {boolean} updateAssignmentTotal - Whether or not to update the
 *                              assignment total. Defaults to true. Set to false to disable.
 */
const incrementCompletionStatus = async (
  orgList: string[],
  status: Status,
  taskIds: string[],
  completionCollectionRef: CollectionReference,
  transaction: Transaction,
  incrementBy = 1,
  updateAssignmentTotal = true
) => {
  const transactionActions: {
    updateMethod: string;
    docRef: DocumentReference;
    fieldPath: FieldPath;
    value: FieldValue;
    data: { [key: string]: unknown };
  }[] = [];
  for (const org of orgList) {
    const completionDocRef = completionCollectionRef.doc(org);
    const completionDocSnap = await completionDocRef.get();
    const updateMethod = completionDocSnap.exists ? "update" : "set";

    if (updateAssignmentTotal) {
      const orgFieldPath = new FieldPath("assignment", status);
      transactionActions.push({
        updateMethod,
        docRef: completionDocRef,
        fieldPath: orgFieldPath,
        value: FieldValue.increment(incrementBy),
        data: {
          assignment: { [status]: FieldValue.increment(incrementBy) },
          ...(updateMethod === "set"
            ? {
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
              }
            : { updatedAt: FieldValue.serverTimestamp() }),
        },
      });
    }
    for (const taskId of taskIds) {
      const orgFieldPath = new FieldPath(taskId, status);
      transactionActions.push({
        updateMethod,
        docRef: completionDocRef,
        fieldPath: orgFieldPath,
        value: FieldValue.increment(incrementBy),
        data: {
          [taskId]: { [status]: FieldValue.increment(incrementBy) },
          ...(updateMethod === "set"
            ? {
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp(),
              }
            : { updatedAt: FieldValue.serverTimestamp() }),
        },
      });
    }
  }

  for (const action of transactionActions) {
    if (action.updateMethod === "update") {
      transaction.update(
        action.docRef,
        action.fieldPath,
        action.value,
        "updatedAt",
        FieldValue.serverTimestamp()
      );
    } else if (action.updateMethod === "set") {
      transaction.set(action.docRef, action.data, { merge: true });
    }
  }
};

/**
 * Event handler for when a new assignment document is created.
 *
 * This function:
 *   1. Updates the list of assignments in the parent user document.
 *   2. Increments the "assigned" status of each organization in the assigning
 *   orgs in the administration stats document.
 *
 * @param {DocumentCreatedEvent} event - The event object containing the Firestore document snapshot.
 * @returns A Promise that resolves when the transaction is completed.
 */
export const syncAssignmentCreatedEventHandler = async (
  event: DocumentCreatedEvent
) => {
  const roarUid = event.params.roarUid;
  const assignmentUid = event.params.assignmentUid;
  const snapshot = event.data;
  if (!snapshot) {
    return;
  }
  const assignmentData = snapshot.data();

  const db = getFirestore();

  logger.info(
    `Starting sync for new assignment: users/${roarUid}/assignments/${assignmentUid}`
  );

  await db
    .runTransaction(
      async (transaction) => {
        // Update the list of assignments in the user document.
        const userDocRef = db.collection("users").doc(roarUid);
        const fieldPathDate = new FieldPath(
          "assignmentsAssigned",
          assignmentUid
        );
        const fieldPathList = new FieldPath("assignments", "assigned");
        const dateAssigned = assignmentData.dateAssigned || new Date();

        transaction.update(
          userDocRef,
          fieldPathDate,
          dateAssigned,
          fieldPathList,
          FieldValue.arrayUnion(assignmentUid)
        );

        return userDocRef.path;
      },
      { maxAttempts: 1000 }
    )
    .then((userDocPath) => {
      logger.info(`Successfully updated user document: ${userDocPath}`);
    })
    .catch((error) => {
      logger.error(`Error updating user document: ${error}`);
    });

  // This function only gets called when an assignment is created. Since the
  // assignments are not created with any started or completed assessments, we
  // only need to update/increment the "assigned" status.
  await db.runTransaction(async (transaction) => {
    // Update the "assigned" counter for each assigning org and for the total
    // This data is stored in completionDocRef
    const completionCollectionRef = db
      .collection("administrations")
      .doc(assignmentUid)
      .collection("stats");
    const assigningOrgs = assignmentData.assigningOrgs || {};
    const orgList = _reduce(
      assigningOrgs,
      (acc: string[], value: string[]) => {
        acc.push(...value);
        return acc;
      },
      []
    );
    orgList.push("total");

    // Get all assessment taskIds
    const taskIds = assignmentData.assessments.map((a) => a.taskId);

    await incrementCompletionStatus(
      orgList,
      "assigned",
      taskIds,
      completionCollectionRef,
      transaction,
      1,
      true
    );
  });
};

/**
 * Event handler for when an existing assignment document is deleted.
 *
 * This function:
 *   1. Decrements the "assigned" status of each organization in the assigning
 *   orgs in the administration stats document.
 *   2. Decrements the "started" status of each organization in the assigning
 *   orgs in the administration stats document, but only if the deleted
 *   assignment had already been started.
 *   3. Decrements the "completed" status of each organization in the assigning
 *   orgs in the administration stats document, but only if the deleted
 *   assignment had already been completed.
 *   4. Updates the list of assignments in the parent user document.
 *
 * @param {DocumentDeletedEvent} event - The event object containing the Firestore document snapshot.
 * @returns A Promise that resolves when the transaction is completed.
 */
export const syncAssignmentDeletedEventHandler = async (
  event: DocumentDeletedEvent
) => {
  const roarUid = event.params.roarUid;
  const assignmentUid = event.params.assignmentUid;

  const db = getFirestore();

  await db.runTransaction(
    async (transaction) => {
      const snap = event.data;
      const prevData = snap?.data();
      if (prevData) {
        const completionCollectionRef = db
          .collection("administrations")
          .doc(assignmentUid)
          .collection("stats");

        const assigningOrgs = prevData.assigningOrgs || {};
        const orgList = _reduce(
          assigningOrgs,
          (acc: string[], value: string[]) => {
            acc.push(...value);
            return acc;
          },
          []
        );
        orgList.push("total");

        // This assignment has been deleted. By definition, it was "assigned",
        // so we must decrement the "assigned" counter.
        // Get all assessment taskIds
        const taskIds = prevData.assessments.map((a) => a.taskId);
        // Decrement the "assigned" counter for each assigning org and for the total
        await incrementCompletionStatus(
          orgList,
          "assigned",
          taskIds,
          completionCollectionRef,
          transaction,
          -1, // Decrement
          true // Update the assignment total as well
        );

        // Perhaps only certain assessments were previously counted as
        // started. So only decrement the "started" counter for started tasks.
        // Now decrement the "started" counter for each started task.
        const startedTasks = prevData.assessments
          .filter((a) => a.startedOn)
          .map((a) => a.taskId);
        if (startedTasks.length > 0) {
          await incrementCompletionStatus(
            orgList,
            "started",
            startedTasks, // only started tasks
            completionCollectionRef,
            transaction,
            -1, // Decrement
            // If startedTasks.length > 0, then the assignment was, by
            // definition, started. So we have to decrement the assignment
            // total as well.
            true
          );
        }

        // Similarly, only decrement the "completed" counter for previously completed tasks.
        const completedTasks = prevData.assessments
          .filter((a) => a.completedOn)
          .map((a) => a.taskId);
        if (completedTasks.length > 0) {
          await incrementCompletionStatus(
            orgList,
            "completed",
            completedTasks, // only completed tasks
            completionCollectionRef,
            transaction,
            -1, // Decrement
            // Even if completedTasks.length > 0, the assignment might not
            // have been counted as completed, since that would require all
            // required tasks to be completed. So we only update the
            // assignment total as well if the previous doc data indicated
            // that the assignment was completed.
            prevData["completed"]
          );
        }
      }

      const userDocRef = db.collection("users").doc(roarUid);
      const fieldPath = {
        assignedDate: new FieldPath("assignmentsAssigned", assignmentUid),
        startedDate: new FieldPath("assignmentsStarted", assignmentUid),
        completedDate: new FieldPath("assignmentsCompleted", assignmentUid),
        assignedList: new FieldPath("assignments", "assigned"),
        startedList: new FieldPath("assignments", "started"),
        completedList: new FieldPath("assignments", "completed"),
      };

      transaction.update(
        userDocRef,
        fieldPath.assignedDate,
        FieldValue.delete(),
        fieldPath.startedDate,
        FieldValue.delete(),
        fieldPath.completedDate,
        FieldValue.delete(),
        fieldPath.assignedList,
        FieldValue.arrayRemove(assignmentUid),
        fieldPath.startedList,
        FieldValue.arrayRemove(assignmentUid),
        fieldPath.completedList,
        FieldValue.arrayRemove(assignmentUid)
      );

      return transaction;
    },
    { maxAttempts: 1000 }
  );
};

/**
 * Event handler for when an existing assignment document is updated.
 *
 * This function:
 *   1. If appropriate, increments/decrements the "assigned" status of each assigning organization
 *   in the administration stats document.
 *   2. If appropriate, increments/decrements the "started" status of each assigning organization
 *   in the administration stats document.
 *   3. If appropriate, increments/decrements the "completed" status of each assigning organization
 *   in the administration stats document.
 *   4. Updates the list of assignments in the parent user document.
 *
 * @param {DocumentUpdatedEvent} event - The event object containing the Firestore document snapshot.
 * @returns A Promise that resolves when the transaction is completed.
 */
export const syncAssignmentUpdatedEventHandler = async (
  event: DocumentUpdatedEvent
) => {
  const roarUid = event.params.roarUid;
  const assignmentUid = event.params.assignmentUid;
  const snapshot = event.data;
  if (!snapshot) {
    return;
  }

  const prevData = snapshot.before.data();
  const currData = snapshot.after.data();

  const db = getFirestore();

  await db.runTransaction(
    async (transaction) => {
      // Update the list of assignments in the user document.
      const userDocRef = db.collection("users").doc(roarUid);
      const assignmentStatusFieldPaths = {
        startedDate: new FieldPath("assignmentsStarted", assignmentUid),
        completedDate: new FieldPath("assignmentsCompleted", assignmentUid),
        startedList: new FieldPath("assignments", "started"),
        completedList: new FieldPath("assignments", "completed"),
      };

      // Update the stats counters.
      const completionCollectionRef = db
        .collection("administrations")
        .doc(assignmentUid)
        .collection("stats");

      // Compute the current and previous assigned organizations
      const assigningOrgs = currData.assigningOrgs || {};
      const prevAssigningOrgs = prevData?.assigningOrgs || {};
      const orgList = _reduce(
        assigningOrgs,
        (acc: string[], value: string[]) => {
          acc.push(...value);
          return acc;
        },
        []
      );
      const prevOrgList = _reduce(
        prevAssigningOrgs,
        (acc: string[], value: string[]) => {
          acc.push(...value);
          return acc;
        },
        []
      );

      //    +-------------------------------------+
      // ---| Decrement counters for removed orgs |---
      //    +-------------------------------------+

      // This function will run for all document updates. If a document update
      // removes orgs, we only need to decrement the status counters for those
      // orgs for the assessments in prevData.
      // Get all previous assessment taskIds
      const prevTaskIds = prevData.assessments.map((a) => a.taskId);
      const removedOrgs = _without(prevOrgList, ...orgList);
      await incrementCompletionStatus(
        removedOrgs,
        "assigned",
        prevTaskIds,
        completionCollectionRef,
        transaction,
        -1, // Decrement
        true // Update the assignment total as well
      );

      // Now decrement the "started" counter for each previously started task.
      const prevStartedTasks = prevData.assessments
        .filter((a) => a.startedOn)
        .map((a) => a.taskId);
      if (prevStartedTasks.length > 0) {
        await incrementCompletionStatus(
          removedOrgs,
          "started",
          prevStartedTasks, // only started tasks
          completionCollectionRef,
          transaction,
          -1, // Decrement
          // If prevStartedTasks.length > 0, then the assignment was, by
          // definition, started. So we have to decrement the assignment
          // total as well.
          true
        );
      }

      // Now decrement the "completed" counter for each previously completed task.
      const prevCompletedTasks = prevData.assessments
        .filter((a) => a.completedOn)
        .map((a) => a.taskId);
      if (prevCompletedTasks.length > 0) {
        await incrementCompletionStatus(
          removedOrgs,
          "completed",
          prevCompletedTasks, // only completed tasks
          completionCollectionRef,
          transaction,
          -1, // Decrement
          // Even if completedTasks.length > 0, the assignment might not
          // have been counted as completed, since that would require all
          // required tasks to be completed. So we only update the
          // assignment total as well if the previous doc data indicated
          // that the assignment was completed.
          prevData["completed"]
        );
      }

      //    +-------------------------------------+
      // ---|  Increment counters for added orgs  |---
      //    +-------------------------------------+

      // Perhaps organizations were added in this document update. If so, we
      // only need to update the status counters for the assessments that are
      // in the currData.

      // Now increment the "assigned" counter for each added org and for the total
      const addedOrgs = _without(orgList, ...prevOrgList);
      const currTaskIds = currData.assessments.map((a) => a.taskId);
      await incrementCompletionStatus(
        addedOrgs,
        "assigned",
        currTaskIds,
        completionCollectionRef,
        transaction,
        1,
        true
      );
      // Now increment the "started" counter for each started task.
      const currStartedTasks = currData.assessments
        .filter((a) => a.startedOn)
        .map((a) => a.taskId);
      if (currStartedTasks.length > 0) {
        await incrementCompletionStatus(
          addedOrgs,
          "started",
          currStartedTasks, // only started tasks
          completionCollectionRef,
          transaction,
          1, // Increment
          // If currStartedTasks.length > 0, then the assignment was, by
          // definition, started. So we have to decrement the assignment
          // total as well.
          true
        );
      }

      // Now increment the "completed" counter for each completed task.
      const currCompletedTasks = currData.assessments
        .filter((a) => a.completedOn)
        .map((a) => a.taskId);
      if (currCompletedTasks.length > 0) {
        await incrementCompletionStatus(
          addedOrgs,
          "completed",
          currCompletedTasks, // only completed tasks
          completionCollectionRef,
          transaction,
          1, // Increment
          // Even if currCompletedTasks.length > 0, the assignment might not
          // be complete, since that would require all required tasks to be
          // completed. So we only update the assignment total as well if the
          // current doc data indicates that the assignment was completed.
          currData["completed"]
        );
      }
      // We have now updated the removed and added orgs. We now need to update
      // any changed statuses for the orgs that didn't change
      const unchangedOrgs = _without(orgList, ...addedOrgs);

      // Add the "total" org to the list of orgs so that it will be updated
      // for any changes to assessments.
      unchangedOrgs.push("total");

      // We don't need to increment the "assigned" counter for the unchanged orgs.

      // If any tasks changed status to started, we need to increment the
      // "started" counter.
      const addedStartedTasks = _without(currStartedTasks, ...prevStartedTasks);
      if (addedStartedTasks.length > 0) {
        await incrementCompletionStatus(
          unchangedOrgs,
          "started",
          addedStartedTasks,
          completionCollectionRef,
          transaction,
          1, // Increment
          currData["started"] && !prevData["started"]
        );
      }
      // If any tasks changed status to unstarted (unlikely), we need to
      // decrement the "started" counter.
      const removedStartedTasks = _without(
        prevStartedTasks,
        ...currStartedTasks
      );
      if (removedStartedTasks.length > 0) {
        await incrementCompletionStatus(
          unchangedOrgs,
          "started",
          removedStartedTasks,
          completionCollectionRef,
          transaction,
          -1, // Decrement
          !currData["started"] && prevData["started"]
        );
      }

      // If any tasks changed status to completed, we need to increment the
      // "completed" counter.
      const addedCompletedTasks = _without(
        currCompletedTasks,
        ...prevCompletedTasks
      );
      if (addedCompletedTasks.length > 0) {
        await incrementCompletionStatus(
          unchangedOrgs,
          "completed",
          addedCompletedTasks,
          completionCollectionRef,
          transaction,
          1, // Increment
          currData["completed"] && !prevData["completed"]
        );
      }
      // If any tasks changed status to uncompleted (unlikely), we need to
      // decrement the "completed" counter.
      const removedCompletedTasks = _without(
        prevCompletedTasks,
        ...currCompletedTasks
      );
      if (removedCompletedTasks.length > 0) {
        await incrementCompletionStatus(
          unchangedOrgs,
          "completed",
          removedCompletedTasks,
          completionCollectionRef,
          transaction,
          -1, // Decrement
          !currData["completed"] && prevData["completed"]
        );
      }

      for (const status of ["started", "completed"]) {
        if (!prevData[status] && currData[status]) {
          transaction.update(
            userDocRef,
            assignmentStatusFieldPaths[`${status}Date`],
            new Date(),
            assignmentStatusFieldPaths[`${status}List`],
            FieldValue.arrayUnion(assignmentUid)
          );
        }

        if (prevData[status] && !currData[status]) {
          transaction.update(
            userDocRef,
            assignmentStatusFieldPaths[`${status}Date`],
            FieldValue.delete(),
            assignmentStatusFieldPaths[`${status}List`],
            FieldValue.arrayRemove(assignmentUid)
          );
        }
      }

      return transaction;
    },
    { maxAttempts: 1000 }
  );

  // Skip updates where cloudSyncTimestamp field changed to avoid infinite loops
  const skipRunDocUpdates =
    prevData?.cloudSyncTimestamp !== currData?.cloudSyncTimestamp;

  if (skipRunDocUpdates) {
    logger.debug(
      "No changes to assignment document " +
        `/users/${roarUid}/assignments/${assignmentUid}, skipping update`
    );
    return;
  } else {
    logger.debug(
      "Changes detected in assignment document " +
        `/users/${roarUid}/assignments/${assignmentUid}, updating runs`
    );
  }
};
