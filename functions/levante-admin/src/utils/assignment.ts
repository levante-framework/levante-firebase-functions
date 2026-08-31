import { Firestore, Transaction } from "firebase-admin/firestore";
import { DocumentSnapshot } from "firebase-admin/firestore";
import type { IExtendedAssignedAssessment } from "../interfaces.js";

export function getAssignmentDocRef(
  db: Firestore,
  userId: string,
  administrationId: string
) {
  return db
    .collection("users")
    .doc(userId)
    .collection("assignments")
    .doc(administrationId);
}

export async function getAssignmentDoc(
  db: Firestore,
  roarUid: string,
  administrationId: string,
  transaction?: Transaction
): Promise<DocumentSnapshot> {
  const docRef = getAssignmentDocRef(db, roarUid, administrationId);

  if (transaction) {
    return await transaction.get(docRef);
  }
  return await docRef.get();
}

export async function updateAssignedAssessment(
  db: Firestore,
  roarUid: string,
  administrationId: string,
  taskId: string,
  updates: { [key: string]: unknown },
  transaction: Transaction
): Promise<void> {
  const docSnap = await getAssignmentDoc(
    db,
    roarUid,
    administrationId,
    transaction
  );

  if (docSnap.exists) {
    const data = docSnap.data();
    const assessments: IExtendedAssignedAssessment[] = data?.assessments || [];
    const assessmentIdx = assessments.findIndex((a) => a.taskId === taskId);

    if (assessmentIdx >= 0) {
      const oldAssessmentInfo = assessments[assessmentIdx];
      const newAssessmentInfo = {
        ...oldAssessmentInfo,
        ...updates,
      };
      assessments[assessmentIdx] = newAssessmentInfo;
      const docRef = getAssignmentDocRef(db, roarUid, administrationId);
      transaction.update(docRef, { assessments });
    }
  }
}

/**
 * Returns true if the assignment should be shown to the user.
 * Hide "pending" and "failed" assignments; show "complete" and legacy (no syncStatus).
 */
export function isVisibleAssignment(
  assignmentData: { syncStatus?: string } | null | undefined
): boolean {
  if (!assignmentData) return false;
  const status = assignmentData.syncStatus;
  return status !== "pending" && status !== "failed";
}

export type AssignmentProgressStatus = "assigned" | "started" | "completed";

const PROGRESS_STATUS_RANK: Record<AssignmentProgressStatus, number> = {
  assigned: 0,
  started: 1,
  completed: 2,
};

export function progressKeyFromTaskId(taskId: string): string {
  return taskId.replace(/-/g, "_");
}

function isProgressStatus(value: unknown): value is AssignmentProgressStatus {
  return value === "assigned" || value === "started" || value === "completed";
}

function progressStatusFromAssessment(assessment: {
  completedOn?: unknown;
  startedOn?: unknown;
  runId?: unknown;
}): AssignmentProgressStatus {
  if (assessment.completedOn) return "completed";
  if (assessment.startedOn || assessment.runId) return "started";
  return "assigned";
}

function mergeProgressStatus(
  existing: unknown,
  derived: AssignmentProgressStatus
): AssignmentProgressStatus {
  if (!isProgressStatus(existing)) return derived;
  return PROGRESS_STATUS_RANK[existing] >= PROGRESS_STATUS_RANK[derived]
    ? existing
    : derived;
}

/**
 * Rebuilds `progress` from the current assessments.
 * Keeps existing assigned/started/completed values when they are at least as
 * far along as the assessment timestamps; adds missing keys; drops stale ones.
 */
export function rebuildAssignmentProgress(
  assessments: Array<{
    taskId?: string;
    completedOn?: unknown;
    startedOn?: unknown;
    runId?: unknown;
  }>,
  existingProgress: Record<string, unknown> = {}
): Record<string, AssignmentProgressStatus> {
  const next: Record<string, AssignmentProgressStatus> = {};

  for (const assessment of assessments) {
    if (!assessment.taskId) continue;
    const key = progressKeyFromTaskId(assessment.taskId);
    next[key] = mergeProgressStatus(
      existingProgress[key],
      progressStatusFromAssessment(assessment)
    );
  }

  return next;
}

/**
 * Checks if all assessments in an assignment are completed
 *
 * Note: When checking if all assessments are completed, we need to consider the current task
 * as already completed, even though its completedOn timestamp will be set in the transaction
 * and won't be reflected in the document snapshot we're examining.
 */
export function shouldCompleteAssignment(
  docSnap: DocumentSnapshot,
  currentTaskId: string
): boolean {
  const data = docSnap.data();
  const assessments: IExtendedAssignedAssessment[] = data?.assessments || [];

  return assessments.every((a: IExtendedAssignedAssessment) => {
    return Boolean(a.completedOn) || a.optional || a.taskId === currentTaskId;
  });
}
