/**
 * Assignment sync logic to be executed within Firestore transactions.
 * Replaces event-driven onDocumentCreated/Updated/Deleted triggers with
 * atomic, inline sync that fails with the calling transaction.
 */
import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import type {
  CollectionReference,
  Transaction,
} from "firebase-admin/firestore";
import _reduce from "lodash-es/reduce.js";
import _without from "lodash-es/without.js";
import type { IOrgsList } from "../interfaces.js";

type Status = "assigned" | "started" | "completed";

interface AssignmentData {
  assigningOrgs?: IOrgsList;
  assessments?: Array<{
    taskId: string;
    startedOn?: Date | unknown;
    completedOn?: Date | unknown;
  }>;
  dateAssigned?: Date;
  started?: boolean;
  completed?: boolean;
}

const incrementCompletionStatus = (
  orgList: string[],
  status: Status,
  taskIds: string[],
  completionCollectionRef: CollectionReference,
  transaction: Transaction,
  incrementBy: number,
  updateAssignmentTotal: boolean
) => {
  for (const org of orgList) {
    const completionDocRef = completionCollectionRef.doc(org);
    const data: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };
    if (updateAssignmentTotal) {
      data.assignment = { [status]: FieldValue.increment(incrementBy) };
    }
    for (const taskId of taskIds) {
      data[taskId] = { [status]: FieldValue.increment(incrementBy) };
    }
    transaction.set(completionDocRef, data, { merge: true });
  }
};

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
  assignmentData: AssignmentData
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

  const completionCollectionRef = db
    .collection("administrations")
    .doc(assignmentUid)
    .collection("stats");
  const orgList = getOrgList(assignmentData.assigningOrgs);
  const taskIds = (assignmentData.assessments ?? []).map((a) => a.taskId);

  await incrementCompletionStatus(
    orgList,
    "assigned",
    taskIds,
    completionCollectionRef,
    transaction,
    1,
    true
  );
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
  prevData: AssignmentData
) => {
  const completionCollectionRef = db
    .collection("administrations")
    .doc(assignmentUid)
    .collection("stats");
  const orgList = getOrgList(prevData.assigningOrgs);
  const taskIds = (prevData.assessments ?? []).map((a) => a.taskId);

  await incrementCompletionStatus(
    orgList,
    "assigned",
    taskIds,
    completionCollectionRef,
    transaction,
    -1,
    true
  );

  const startedTasks = (prevData.assessments ?? [])
    .filter((a) => a.startedOn)
    .map((a) => a.taskId);
  if (startedTasks.length > 0) {
    await incrementCompletionStatus(
      orgList,
      "started",
      startedTasks,
      completionCollectionRef,
      transaction,
      -1,
      true
    );
  }

  const completedTasks = (prevData.assessments ?? [])
    .filter((a) => a.completedOn)
    .map((a) => a.taskId);
  if (completedTasks.length > 0) {
    await incrementCompletionStatus(
      orgList,
      "completed",
      completedTasks,
      completionCollectionRef,
      transaction,
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
  currData: AssignmentData
) => {
  const userDocRef = db.collection("users").doc(roarUid);
  const assignmentStatusFieldPaths = {
    startedDate: new FieldPath("assignmentsStarted", assignmentUid),
    completedDate: new FieldPath("assignmentsCompleted", assignmentUid),
    startedList: new FieldPath("assignments", "started"),
    completedList: new FieldPath("assignments", "completed"),
  };

  const completionCollectionRef = db
    .collection("administrations")
    .doc(assignmentUid)
    .collection("stats");

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
  unchangedOrgs.push("total");

  if (removedOrgs.length > 0) {
    await incrementCompletionStatus(
      removedOrgs,
      "assigned",
      prevTaskIds,
      completionCollectionRef,
      transaction,
      -1,
      true
    );
    if (prevStartedTasks.length > 0) {
      await incrementCompletionStatus(
        removedOrgs,
        "started",
        prevStartedTasks,
        completionCollectionRef,
        transaction,
        -1,
        true
      );
    }
    if (prevCompletedTasks.length > 0) {
      await incrementCompletionStatus(
        removedOrgs,
        "completed",
        prevCompletedTasks,
        completionCollectionRef,
        transaction,
        -1,
        !!prevData.completed
      );
    }
  }

  if (addedOrgs.length > 0) {
    await incrementCompletionStatus(
      addedOrgs,
      "assigned",
      currTaskIds,
      completionCollectionRef,
      transaction,
      1,
      true
    );
    if (currStartedTasks.length > 0) {
      await incrementCompletionStatus(
        addedOrgs,
        "started",
        currStartedTasks,
        completionCollectionRef,
        transaction,
        1,
        true
      );
    }
    if (currCompletedTasks.length > 0) {
      await incrementCompletionStatus(
        addedOrgs,
        "completed",
        currCompletedTasks,
        completionCollectionRef,
        transaction,
        1,
        !!currData.completed
      );
    }
  }

  const addedStartedTasks = _without(currStartedTasks, ...prevStartedTasks);
  if (addedStartedTasks.length > 0) {
    await incrementCompletionStatus(
      unchangedOrgs,
      "started",
      addedStartedTasks,
      completionCollectionRef,
      transaction,
      1,
      !!currData.started && !prevData.started
    );
  }
  const removedStartedTasks = _without(prevStartedTasks, ...currStartedTasks);
  if (removedStartedTasks.length > 0) {
    await incrementCompletionStatus(
      unchangedOrgs,
      "started",
      removedStartedTasks,
      completionCollectionRef,
      transaction,
      -1,
      !currData.started && !!prevData.started
    );
  }

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
      1,
      !!currData.completed && !prevData.completed
    );
  }
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
      -1,
      !currData.completed && !!prevData.completed
    );
  }

  for (const status of ["started", "completed"] as const) {
    const prevVal = prevData[status];
    const currVal = currData[status];
    const dateKey = `${status}Date` as const;
    const listKey = `${status}List` as const;
    if (!prevVal && currVal) {
      transaction.update(
        userDocRef,
        assignmentStatusFieldPaths[dateKey],
        new Date(),
        assignmentStatusFieldPaths[listKey],
        FieldValue.arrayUnion(assignmentUid)
      );
    }
    if (prevVal && !currVal) {
      transaction.update(
        userDocRef,
        assignmentStatusFieldPaths[dateKey],
        FieldValue.delete(),
        assignmentStatusFieldPaths[listKey],
        FieldValue.arrayRemove(assignmentUid)
      );
    }
  }
};
