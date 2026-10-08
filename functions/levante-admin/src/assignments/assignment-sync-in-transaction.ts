/**
 * Assignment sync logic to be executed within Firestore transactions.
 * Replaces event-driven onDocumentCreated/Updated/Deleted triggers with
 * atomic, inline sync that fails with the calling transaction.
 */
import type { Transaction } from "firebase-admin/firestore";
import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import _reduce from "lodash-es/reduce.js";
import _without from "lodash-es/without.js";
import type { IOrgsList } from "../interfaces.js";
import {
  AdminStatsBufferRegistry,
  type AdminStatsBuffer,
} from "./admin-stats-buffer.js";

interface AssignmentData {
  assigningOrgs?: IOrgsList;
  assessments?: Array<{
    taskId: string;
    startedOn?: Date | unknown;
    completedOn?: unknown;
  }>;
  dateAssigned?: Date;
  started?: boolean;
  completed?: boolean;
}

const getOrgList = (assigningOrgs: IOrgsList | undefined): string[] => {
  if (!assigningOrgs) return [];
  const list = _reduce(
    assigningOrgs,
    (acc: string[], value: string[]) => {
      acc.push(...(value ?? []));
      return acc;
    },
    []
  );
  list.push("total");
  return list;
};

/**
 * Sync user doc and stats when a new assignment is created.
 * Call this within the same transaction that creates the assignment.
 */
export const syncOnAssignmentCreated = async (
  db: ReturnType<typeof getFirestore>,
  transaction: Transaction,
  roarUid: string,
  assignmentUid: string,
  assignmentData: AssignmentData,
  statsBuffer: AdminStatsBuffer
) => {
  const userDocRef = db.collection("users").doc(roarUid);
  const fieldPathDate = new FieldPath("assignmentsAssigned", assignmentUid);
  const fieldPathList = new FieldPath("assignments", "assigned");
  const dateAssigned = assignmentData.dateAssigned || new Date();

  transaction.update(
    userDocRef,
    fieldPathDate,
    dateAssigned,
    fieldPathList,
    FieldValue.arrayUnion(assignmentUid)
  );

  const orgList = getOrgList(assignmentData.assigningOrgs);
  const taskIds = (assignmentData.assessments ?? []).map((a) => a.taskId);

  statsBuffer.recordIncrements(orgList, "assigned", taskIds, 1, true);
};

/**
 * Sync user doc and stats when an assignment is deleted.
 * Call this within the same transaction that deletes the assignment.
 */
export const syncOnAssignmentDeleted = async (
  db: ReturnType<typeof getFirestore>,
  transaction: Transaction,
  roarUid: string,
  assignmentUid: string,
  prevData: AssignmentData,
  statsBuffer: AdminStatsBuffer
) => {
  const orgList = getOrgList(prevData.assigningOrgs);
  const taskIds = (prevData.assessments ?? []).map((a) => a.taskId);

  statsBuffer.recordIncrements(orgList, "assigned", taskIds, -1, true);

  const startedTasks = (prevData.assessments ?? [])
    .filter((a) => a.startedOn)
    .map((a) => a.taskId);
  if (startedTasks.length > 0) {
    statsBuffer.recordIncrements(orgList, "started", startedTasks, -1, true);
  }

  const completedTasks = (prevData.assessments ?? [])
    .filter((a) => a.completedOn)
    .map((a) => a.taskId);
  if (completedTasks.length > 0) {
    statsBuffer.recordIncrements(
      orgList,
      "completed",
      completedTasks,
      -1,
      !!prevData.completed
    );
  }

  const userDocRef = db.collection("users").doc(roarUid);
  const fieldPaths = {
    assignedDate: new FieldPath("assignmentsAssigned", assignmentUid),
    startedDate: new FieldPath("assignmentsStarted", assignmentUid),
    completedDate: new FieldPath("assignmentsCompleted", assignmentUid),
    assignedList: new FieldPath("assignments", "assigned"),
    startedList: new FieldPath("assignments", "started"),
    completedList: new FieldPath("assignments", "completed"),
  };

  transaction.update(
    userDocRef,
    fieldPaths.assignedDate,
    FieldValue.delete(),
    fieldPaths.startedDate,
    FieldValue.delete(),
    fieldPaths.completedDate,
    FieldValue.delete(),
    fieldPaths.assignedList,
    FieldValue.arrayRemove(assignmentUid),
    fieldPaths.startedList,
    FieldValue.arrayRemove(assignmentUid),
    fieldPaths.completedList,
    FieldValue.arrayRemove(assignmentUid)
  );
};

/**
 * Sync user doc and stats when an assignment is updated.
 * Call this within the same transaction that updates the assignment.
 */
export const syncOnAssignmentUpdated = async (
  db: ReturnType<typeof getFirestore>,
  transaction: Transaction,
  roarUid: string,
  assignmentUid: string,
  prevData: AssignmentData,
  currData: AssignmentData,
  statsBuffer: AdminStatsBuffer
) => {
  const userDocRef = db.collection("users").doc(roarUid);
  const assignmentStatusFieldPaths = {
    startedDate: new FieldPath("assignmentsStarted", assignmentUid),
    completedDate: new FieldPath("assignmentsCompleted", assignmentUid),
    startedList: new FieldPath("assignments", "started"),
    completedList: new FieldPath("assignments", "completed"),
  };

  const orgList = getOrgList(currData.assigningOrgs);
  const prevOrgList = getOrgList(prevData.assigningOrgs);
  const prevTaskIds = (prevData.assessments ?? []).map((a) => a.taskId);
  const currTaskIds = (currData.assessments ?? []).map((a) => a.taskId);
  const prevStartedTasks = (prevData.assessments ?? [])
    .filter((a) => a.startedOn)
    .map((a) => a.taskId);
  const currStartedTasks = (currData.assessments ?? [])
    .filter((a) => a.startedOn)
    .map((a) => a.taskId);
  const prevCompletedTasks = (prevData.assessments ?? [])
    .filter((a) => a.completedOn)
    .map((a) => a.taskId);
  const currCompletedTasks = (currData.assessments ?? [])
    .filter((a) => a.completedOn)
    .map((a) => a.taskId);

  const removedOrgs = _without(prevOrgList, ...orgList);
  const addedOrgs = _without(orgList, ...prevOrgList);
  const unchangedOrgs = _without(orgList, ...addedOrgs);

  if (removedOrgs.length > 0) {
    statsBuffer.recordIncrements(
      removedOrgs,
      "assigned",
      prevTaskIds,
      -1,
      true
    );
    if (prevStartedTasks.length > 0) {
      statsBuffer.recordIncrements(
        removedOrgs,
        "started",
        prevStartedTasks,
        -1,
        true
      );
    }
    if (prevCompletedTasks.length > 0) {
      statsBuffer.recordIncrements(
        removedOrgs,
        "completed",
        prevCompletedTasks,
        -1,
        !!prevData.completed
      );
    }
  }

  if (addedOrgs.length > 0) {
    statsBuffer.recordIncrements(addedOrgs, "assigned", currTaskIds, 1, true);
    if (currStartedTasks.length > 0) {
      statsBuffer.recordIncrements(
        addedOrgs,
        "started",
        currStartedTasks,
        1,
        true
      );
    }
    if (currCompletedTasks.length > 0) {
      statsBuffer.recordIncrements(
        addedOrgs,
        "completed",
        currCompletedTasks,
        1,
        !!currData.completed
      );
    }
  }

  // Tasks added to or removed from a kept assignment (e.g. an age condition
  // newly qualifies/disqualifies a not-yet-started assessment) change per-task
  // `assigned` counts but not the assignment-level total, since the assignment
  // itself persists. updateAssignmentTotal is false here for that reason.
  const addedAssignedTasks = _without(currTaskIds, ...prevTaskIds);
  if (addedAssignedTasks.length > 0) {
    statsBuffer.recordIncrements(
      unchangedOrgs,
      "assigned",
      addedAssignedTasks,
      1,
      false
    );
  }
  const removedAssignedTasks = _without(prevTaskIds, ...currTaskIds);
  if (removedAssignedTasks.length > 0) {
    statsBuffer.recordIncrements(
      unchangedOrgs,
      "assigned",
      removedAssignedTasks,
      -1,
      false
    );
  }

  const addedStartedTasks = _without(currStartedTasks, ...prevStartedTasks);
  if (addedStartedTasks.length > 0) {
    statsBuffer.recordIncrements(
      unchangedOrgs,
      "started",
      addedStartedTasks,
      1,
      !!currData.started && !prevData.started
    );
  }
  const removedStartedTasks = _without(prevStartedTasks, ...currStartedTasks);
  if (removedStartedTasks.length > 0) {
    statsBuffer.recordIncrements(
      unchangedOrgs,
      "started",
      removedStartedTasks,
      -1,
      !currData.started && !!prevData.started
    );
  }

  const addedCompletedTasks = _without(
    currCompletedTasks,
    ...prevCompletedTasks
  );
  if (addedCompletedTasks.length > 0) {
    statsBuffer.recordIncrements(
      unchangedOrgs,
      "completed",
      addedCompletedTasks,
      1,
      !!currData.completed && !prevData.completed
    );
  }
  const removedCompletedTasks = _without(
    prevCompletedTasks,
    ...currCompletedTasks
  );
  if (removedCompletedTasks.length > 0) {
    statsBuffer.recordIncrements(
      unchangedOrgs,
      "completed",
      removedCompletedTasks,
      -1,
      !currData.completed && !!prevData.completed
    );
  }

  // A finish can flip both flags. Write them together so the user doc is
  // updated once in this transaction.
  const userDocUpdates: unknown[] = [];
  for (const status of ["started", "completed"] as const) {
    const prevVal = prevData[status];
    const currVal = currData[status];
    const dateKey = `${status}Date` as const;
    const listKey = `${status}List` as const;
    if (!prevVal && currVal) {
      userDocUpdates.push(
        assignmentStatusFieldPaths[dateKey],
        new Date(),
        assignmentStatusFieldPaths[listKey],
        FieldValue.arrayUnion(assignmentUid)
      );
    }
    if (prevVal && !currVal) {
      userDocUpdates.push(
        assignmentStatusFieldPaths[dateKey],
        FieldValue.delete(),
        assignmentStatusFieldPaths[listKey],
        FieldValue.arrayRemove(assignmentUid)
      );
    }
  }
  if (userDocUpdates.length > 0) {
    const update = transaction.update.bind(transaction) as (
      ref: typeof userDocRef,
      field: FieldPath,
      value: unknown,
      ...rest: unknown[]
    ) => ReturnType<Transaction["update"]>;
    update(
      userDocRef,
      userDocUpdates[0] as FieldPath,
      userDocUpdates[1],
      ...userDocUpdates.slice(2)
    );
  }
};

/**
 * Record an assignment progress change on the user doc and administration
 * stats. Call this inside the same transaction that writes the assignment.
 */
export const syncAssignmentProgress = async (
  db: ReturnType<typeof getFirestore>,
  transaction: Transaction,
  roarUid: string,
  assignmentUid: string,
  prevData: AssignmentData,
  currData: AssignmentData
) => {
  const statsRegistry = new AdminStatsBufferRegistry(db);
  await syncOnAssignmentUpdated(
    db,
    transaction,
    roarUid,
    assignmentUid,
    prevData,
    currData,
    statsRegistry.forAdministration(assignmentUid)
  );
  statsRegistry.flush(transaction);
};
