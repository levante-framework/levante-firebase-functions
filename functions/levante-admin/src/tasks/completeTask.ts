import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  getFirestore,
  Transaction,
  DocumentSnapshot,
  Firestore,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { IExtendedAssignedAssessment } from "../interfaces.js";
import {
  getAssignmentDoc,
  getAssignmentDocRef,
  shouldCompleteAssignment,
} from "../utils/assignment.js";

// Initialize Firestore
const db = getFirestore();

/**
 * Updates an assigned assessment with the provided updates
 */
function updateAssignedTaskInTransaction(
  docSnap: DocumentSnapshot,
  taskId: string,
  updates: { [key: string]: unknown },
  docRef: FirebaseFirestore.DocumentReference,
  transaction: Transaction
): void {
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
      transaction.update(docRef, { assessments });
    }
  }
}

/**
 * Cloud Function to complete a task in an assignment
 * Marks a task in the current assignment as completed and checks if the entire assignment is now complete
 */
export const completeTask = onCall(async (request) => {
  try {
    // Validate authentication
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const { administrationId, taskId, userId } = request.data;

    if (!administrationId || !taskId) {
      throw new HttpsError(
        "invalid-argument",
        "administrationId and taskId are required"
      );
    }

    if (!userId) {
      throw new HttpsError("not-found", "Could not determine user ID");
    }

    // Run the completion logic in a transaction
    await db.runTransaction(async (transaction) => {
      // DO ALL READS FIRST
      // Get the user's assignment document
      const assignmentDoc = await getAssignmentDoc(
        db,
        userId,
        administrationId,
        transaction
      );

      if (!assignmentDoc.exists) {
        throw new HttpsError(
          "not-found",
          `Assignment ${administrationId} not found for user`
        );
      }

      // Check if assignment should be completed after this task
      const shouldComplete = shouldCompleteAssignment(assignmentDoc, taskId);

      // NOW DO ALL WRITES
      const docRef = getAssignmentDocRef(db, userId, administrationId);

      // Update this assessment's `completedOn` timestamp
      updateAssignedTaskInTransaction(
        assignmentDoc,
        taskId,
        { completedOn: new Date() },
        docRef,
        transaction
      );

      // Mark assignment as complete if all assessments are now completed
      if (shouldComplete) {
        transaction.update(docRef, { completed: true });
      }
    });

    return { success: true, message: "Task completed successfully" };
  } catch (error) {
    logger.error("Failed to complete task", {
      error,
      administrationId: request.data?.administrationId,
      taskId: request.data?.taskId,
      userId: request.data?.userId,
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError(
      "internal",
      `Failed to complete task: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
});
