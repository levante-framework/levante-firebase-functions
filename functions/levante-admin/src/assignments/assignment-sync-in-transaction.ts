/**
 * Assignment sync logic to be executed within Firestore transactions.
 * Replaces event-driven onDocumentCreated/Updated/Deleted triggers with
 * atomic, inline sync that fails with the calling transaction.
 */
import { logger } from "firebase-functions/v2";
import type {
  CollectionReference,
  Firestore,
  Transaction,
} from "firebase-admin/firestore";
import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import _reduce from "lodash-es/reduce.js";
import _without from "lodash-es/without.js";
import type { IOrgsList } from "../interfaces.js";

type Status = "assigned" | "started" | "completed";

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

type OrgDelta = {
  assignment: Partial<Record<Status, number>>;
  tasks: Map<string, Partial<Record<Status, number>>>;
};

export type AdminStatsBuffer = {
  recordIncrements: (
    orgList: string[],
    status: Status,
    taskIds: string[],
    incrementBy: number,
    updateAssignmentTotal: boolean
  ) => void;
  flush: (transaction: Transaction) => void;
};

export function createAdminStatsBuffer(
  completionCollectionRef: CollectionReference
): AdminStatsBuffer {
  const byOrg = new Map<string, OrgDelta>();

  const getOrgDelta = (org: string): OrgDelta => {
    let d = byOrg.get(org);
    if (!d) {
      d = { assignment: {}, tasks: new Map() };
      byOrg.set(org, d);
    }
    return d;
  };

  return {
    recordIncrements(
      orgList: string[],
      status: Status,
      taskIds: string[],
      incrementBy: number,
      updateAssignmentTotal: boolean
    ) {
      for (const org of orgList) {
        const orgDelta = getOrgDelta(org);
        if (updateAssignmentTotal) {
          orgDelta.assignment[status] =
            (orgDelta.assignment[status] ?? 0) + incrementBy;
        }
        for (const taskId of taskIds) {
          let taskDelta = orgDelta.tasks.get(taskId);
          if (!taskDelta) {
            taskDelta = {};
            orgDelta.tasks.set(taskId, taskDelta);
          }
          taskDelta[status] = (taskDelta[status] ?? 0) + incrementBy;
        }
      }
    },

    flush(transaction: Transaction) {
      for (const [org, delta] of byOrg) {
        const data: Record<string, unknown> = {};
        let hasIncrement = false;

        const assignmentPayload: Record<string, unknown> = {};
        for (const s of ["assigned", "started", "completed"] as const) {
          const n = delta.assignment[s];
          if (n !== undefined && n !== 0) {
            assignmentPayload[s] = FieldValue.increment(n);
            hasIncrement = true;
          }
        }
        if (Object.keys(assignmentPayload).length > 0) {
          data.assignment = assignmentPayload;
        }

        for (const [taskId, taskDelta] of delta.tasks) {
          const taskPayload: Record<string, unknown> = {};
          for (const s of ["assigned", "started", "completed"] as const) {
            const n = taskDelta[s];
            if (n !== undefined && n !== 0) {
              taskPayload[s] = FieldValue.increment(n);
              hasIncrement = true;
            }
          }
          if (Object.keys(taskPayload).length > 0) {
            data[taskId] = taskPayload;
          }
        }

        if (!hasIncrement) {
          continue;
        }

        data.updatedAt = FieldValue.serverTimestamp();
        const completionDocRef = completionCollectionRef.doc(org);
        const topLevelKeys = Object.keys(data);
        const taskKeyCount = [...delta.tasks.keys()].filter((tid) => {
          const td = delta.tasks.get(tid);
          return (
            td && Object.values(td).some((v) => v !== undefined && v !== 0)
          );
        }).length;
        const estimatedTransforms =
          1 +
          Object.keys(assignmentPayload).length +
          [...delta.tasks.values()].reduce(
            (acc, td) =>
              acc +
              (["assigned", "started", "completed"] as const).filter(
                (s) => td[s] !== undefined && td[s] !== 0
              ).length,
            0
          );
        if (org === "total" || taskKeyCount >= 200) {
          logger.info(
            "DIAG_STATS_MERGE: transaction.set merge on completion doc",
            {
              completionDocPath: completionDocRef.path,
              org,
              aggregatedFlush: true,
              taskKeyCount,
              topLevelFieldCount: topLevelKeys.length,
              estimatedFieldTransformsLowerBound: estimatedTransforms,
              firestoreFieldTransformLimit: 500,
            }
          );
        }

        transaction.set(completionDocRef, data, { merge: true });
      }
    },
  };
}

export class AdminStatsBufferRegistry {
  private readonly db: Firestore;
  private readonly map = new Map<string, AdminStatsBuffer>();

  constructor(db: Firestore) {
    this.db = db;
  }

  forAdministration(administrationId: string): AdminStatsBuffer {
    let b = this.map.get(administrationId);
    if (!b) {
      b = createAdminStatsBuffer(
        this.db
          .collection("administrations")
          .doc(administrationId)
          .collection("stats")
      );
      this.map.set(administrationId, b);
    }
    return b;
  }

  flush(transaction: Transaction): void {
    for (const b of this.map.values()) {
      b.flush(transaction);
    }
  }
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
  unchangedOrgs.push("total");

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
