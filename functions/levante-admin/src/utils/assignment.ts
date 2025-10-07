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
