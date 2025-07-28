import { Firestore, Transaction } from "firebase-admin/firestore";
import { DocumentSnapshot } from "firebase-admin/firestore";
import { IExtendedAssignedAssessment } from "../interfaces";

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
