import { onCall, HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import type { Firestore, Transaction } from "firebase-admin/firestore";
import {
  updateAssignedAssessment,
  getAssignmentDoc,
  getAssignmentDocRef,
} from "../utils/assignment.js";
import type {
  IUserData,
  IAssignedAssessment,
  IExtendedAssignedAssessment,
  IOrgsList,
  IAssessment,
  IAdministration,
} from "../interfaces.js";
import _get from "lodash-es/get.js";
import _nth from "lodash-es/nth.js";

const emptyOrg = () => {
  return {
    current: [],
    all: [],
    dates: {},
  };
};

/**
 * Gets user data from the admin database
 */
async function getMyData(
  db: Firestore,
  targetUid: string,
  transaction?: Transaction
): Promise<{ userData: IUserData; assessmentPid: string }> {
  const userDocRef = db.collection("users").doc(targetUid);

  let userDocSnap;
  if (transaction) {
    userDocSnap = await transaction.get(userDocRef);
  } else {
    userDocSnap = await userDocRef.get();
  }

  let userData: IUserData;

  if (userDocSnap.exists) {
    userData = userDocSnap.data() as IUserData;
  } else {
    userData = {
      userType: "guest",
      districts: emptyOrg(),
      schools: emptyOrg(),
      classes: emptyOrg(),
      families: emptyOrg(),
      groups: emptyOrg(),
      archived: false,
      testData: false,
      demoData: false,
      studentData: {},
      birthMonth: 0,
      birthYear: 0,
    } as IUserData;
  }

  let assessmentPid: string | undefined = _get(userData, "assessmentPid");

  if (!assessmentPid) {
    assessmentPid = `user-${targetUid}`;
  }

  return { userData, assessmentPid };
}

/**
 * Marks an assignment as started
 */
async function startAssignment(
  db: Firestore,
  administrationId: string,
  targetUid: string,
  transaction: Transaction
): Promise<void> {
  const assignmentDocRef = getAssignmentDocRef(db, targetUid, administrationId);
  transaction.update(assignmentDocRef, { started: true });
}

/**
 * Interface for the data returned to firekit
 */
interface StartTaskResult {
  success: boolean;
  taskInfo: {
    variantName: string;
    variantParams: { [x: string]: unknown };
    variantId: string;
  };
  assigningOrgs: IOrgsList;
  readOrgs: IOrgsList;
  userData: IUserData;
  assessmentPid: string;
}

/**
 * Cloud Function to start a task in an assignment
 * This function prepares the task for starting and returns the necessary data for firekit (client)
 */
export const startTask = onCall(async (request): Promise<StartTaskResult> => {
  const db = getFirestore();
  try {
    // Validate authentication
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const { administrationId, taskId, targetUid } = request.data;

    if (!administrationId || !taskId) {
      throw new HttpsError(
        "invalid-argument",
        "administrationId and taskId are required"
      );
    }

    // Use the authenticated user's UID, or the provided targetUid if specified
    const uid = targetUid || request.auth.uid;

    if (!uid) {
      throw new HttpsError("invalid-argument", "Could not determine user ID");
    }

    // Run everything in a transaction to ensure consistency
    const result = await db.runTransaction(async (transaction) => {
      // DO ALL READS FIRST
      // Get the assignment document to check if it exists and get assessment info
      const assignmentDocSnap = await getAssignmentDoc(
        db,
        uid,
        administrationId,
        transaction
      );

      if (!assignmentDocSnap.exists) {
        throw new HttpsError(
          "not-found",
          `Could not find assignment for user ${uid} with administration id ${administrationId}`
        );
      }

      const assignmentData = assignmentDocSnap.data()!;

      // Get the assessments from the assignment document
      const assignedAssessments =
        assignmentData.assessments as IExtendedAssignedAssessment[];

      // Find the specific assessment (task) we're trying to start
      const thisAssignedAssessment = assignedAssessments.find(
        (a) => a.taskId === taskId
      );

      if (!thisAssignedAssessment) {
        throw new HttpsError(
          "not-found",
          `Could not find assessment with taskId ${taskId} in user assignment ${administrationId} for user ${uid}`
        );
      }

      // Get the administration document to access the assessment metadata
      const administrationDocRef = db
        .collection("administrations")
        .doc(administrationId);
      const administrationDocSnap = await transaction.get(administrationDocRef);

      if (!administrationDocSnap.exists) {
        throw new HttpsError(
          "not-found",
          `Could not find administration with id ${administrationId}`
        );
      }

      const administrationData =
        administrationDocSnap.data() as IAdministration;

      // Find the assessment definition in the administration to get metadata
      const assessmentDefinition = administrationData.assessments.find(
        (a: IAssessment) => a.taskId === taskId
      );

      if (!assessmentDefinition) {
        throw new HttpsError(
          "not-found",
          `Could not find assessment definition with taskId ${taskId} in administration ${administrationId}`
        );
      }

      // Get user data
      const { userData, assessmentPid } = await getMyData(db, uid, transaction);

      // Get assignment metadata
      const assigningOrgs = assignmentData.assigningOrgs as IOrgsList;
      const readOrgs = assignmentData.readOrgs as IOrgsList;

      // NOW DO ALL WRITES
      // Update the assessment with startedOn timestamp
      const assessmentUpdateData = {
        startedOn: new Date(),
      };

      await updateAssignedAssessment(
        db,
        uid,
        administrationId,
        taskId,
        assessmentUpdateData,
        transaction
      );

      // If this is the first assessment to be started in this assignment, mark the assignment as started
      if (
        !assignedAssessments.some((a: IExtendedAssignedAssessment) =>
          Boolean(a.startedOn)
        )
      ) {
        await startAssignment(db, administrationId, uid, transaction);
      }

      // Prepare the task information for firekit using the assessment definition from administration
      const taskInfo = {
        variantName: assessmentDefinition.variantName,
        variantParams: assessmentDefinition.params || {},
        variantId: assessmentDefinition.variantId,
      };

      return {
        success: true,
        taskInfo,
        assigningOrgs,
        readOrgs,
        userData,
        assessmentPid,
      };
    });

    return result;
  } catch (error) {
    logger.error("Failed to start task", {
      error,
      administrationId: request.data?.administrationId,
      taskId: request.data?.taskId,
      targetUid: request.data?.targetUid,
      callerUid: request.auth?.uid,
    });

    if (error instanceof HttpsError) {
      throw error;
    }

    throw new HttpsError(
      "internal",
      `Failed to start task: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
});
