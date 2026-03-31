import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import {
  shouldCompleteAssignment,
  getAssignmentDocRef,
  getAssignmentDoc,
} from "./utils/assignment.js";
import {
  AdminStatsBufferRegistry,
  syncOnAssignmentUpdated,
} from "./assignments/assignment-sync-in-transaction.js";

type Response = {
  responseTime: string;
  responseValue: string;
};

interface SurveyData {
  pageNo: number;
  isGeneral: boolean;
  isComplete: boolean;
  isEntireSurveyCompleted: boolean;
  specificId: string;
  responses: Record<string, Response>;
  userType: string;
}

interface SurveyResponsesInput {
  surveyResponses: {
    administrationId: string;
    surveyData: SurveyData;
  };
}

export async function writeSurveyResponses(
  requesterUid: string,
  data: SurveyResponsesInput
) {
  const db = getFirestore();

  // write or update survey responses as subcollection of user document
  const userRef = db.collection("users").doc(requesterUid);
  const surveyResponsesCollection = userRef.collection("surveyResponses");

  const returnObj = {
    success: false,
    message: "Error writing survey responses",
  };

  const { administrationId, surveyData } = data.surveyResponses;

  // Check if administrationId is undefined or null
  if (administrationId == null) {
    throw new Error("administrationId is undefined or null");
  }

  try {
    const {
      pageNo,
      isGeneral,
      isComplete,
      isEntireSurveyCompleted,
      specificId,
      responses,
      userType,
    } = surveyData as SurveyData;

    // format responses time from ISO string to date object
    const responsesWithTimestamps = Object.fromEntries(
      Object.entries(responses).map(([key, value]) => {
        // questions that were not answered will have a null value
        if (!value) {
          return [key, null];
        }
        return [key, { ...value, responseTime: new Date(value.responseTime) }];
      })
    );

    // Use a transaction to ensure atomicity between survey responses and assignment updates
    await db.runTransaction(async (transaction) => {
      const statsRegistry = new AdminStatsBufferRegistry(db);
      // Check if the survey response document already exists
      const existingDocQuery = surveyResponsesCollection
        .where("administrationId", "==", administrationId)
        .limit(1);

      const existingDocSnapshot = await transaction.get(existingDocQuery);

      const surveyRef = existingDocSnapshot.empty
        ? surveyResponsesCollection.doc()
        : existingDocSnapshot.docs[0].ref;

      const existingSurveyDoc = existingDocSnapshot.empty
        ? await transaction.get(surveyRef)
        : existingDocSnapshot.docs[0];

      const isNewDocument = existingDocSnapshot.empty;
      const existingData: any = existingSurveyDoc.data() || {};

      // Read assignment document
      const assignmentRef = getAssignmentDocRef(
        db,
        requesterUid,
        administrationId
      );
      const assignmentDoc = await getAssignmentDoc(
        db,
        requesterUid,
        administrationId,
        transaction
      );

      // ALL WRITES AFTER - Process the data and perform writes

      // Prepare survey response update data
      let updateData: any = {
        administrationId,
        pageNo,
        updatedAt: FieldValue.serverTimestamp(),
      };

      if (isNewDocument) {
        updateData.createdAt = FieldValue.serverTimestamp();
      }

      // Update general data
      if (isGeneral) {
        updateData.general = {
          isComplete: isComplete,
          responses: isComplete
            ? responsesWithTimestamps // Overwrite all responses if the survey is complete
            : {
                ...existingData.general?.responses,
                ...responsesWithTimestamps,
              }, // Merge new responses with existing ones
        };
      }

      // Update specific data for parent and teacher user types
      if ((userType === "parent" || userType === "teacher") && !isGeneral) {
        const idKey = userType === "parent" ? "childId" : "classId";

        let specificData = existingData.specific || [];

        const specificIndex = specificData.findIndex(
          (item) => item[idKey] === specificId
        );
        if (specificIndex !== -1) {
          specificData[specificIndex] = {
            ...specificData[specificIndex],
            [idKey]: specificId,
            isComplete,
            responses: isComplete
              ? responsesWithTimestamps // Overwrite all responses if the survey is complete
              : {
                  ...specificData[specificIndex].responses,
                  ...responsesWithTimestamps,
                }, // Merge new responses with existing ones
          };
        } else {
          specificData.push({
            [idKey]: specificId,
            isComplete,
            responses: responsesWithTimestamps,
          });
        }

        updateData.specific = specificData;
      }

      // Update assignment document assessments if it exists
      if (assignmentDoc.exists) {
        const assignmentData = assignmentDoc.data();
        const assessments = assignmentData?.assessments || [];

        // Find the survey assessment
        const surveyAssessmentIndex = assessments.findIndex(
          (assessment) => assessment.taskId === "survey"
        );

        if (surveyAssessmentIndex !== -1) {
          const surveyAssessment = assessments[surveyAssessmentIndex];

          // Create a copy of the assessments array to modify
          const updatedAssessments = [...assessments];
          const updatedSurveyAssessment = {
            ...updatedAssessments[surveyAssessmentIndex],
          };

          let hasAssessmentChanges = false;
          const updates: any = {};

          // Add startedOn timestamp if this is the first survey submission
          if (isNewDocument && !updatedSurveyAssessment.startedOn) {
            updatedSurveyAssessment.startedOn = new Date();
            hasAssessmentChanges = true;
          }

          // Add completedOn timestamp if entire survey is complete
          if (isEntireSurveyCompleted) {
            updatedSurveyAssessment.completedOn = new Date();
            hasAssessmentChanges = true;

            // Update the progress object properly
            const currentProgress = assignmentData?.progress || {};
            const updatedProgress = { ...currentProgress, survey: "completed" };
            updates.progress = updatedProgress;

            // Check if assignment should be completed
            if (shouldCompleteAssignment(assignmentDoc, "survey")) {
              updates.completed = true;
            }
          }

          // Update the assessment in the array if there were changes
          if (hasAssessmentChanges) {
            updatedAssessments[surveyAssessmentIndex] = updatedSurveyAssessment;
            updates.assessments = updatedAssessments;
          }

          // Apply updates if any exist
          if (Object.keys(updates).length > 0) {
            const prevData = assignmentData;
            if (!prevData) {
              throw new Error("Assignment data is missing");
            }
            const currData = { ...prevData, ...updates };
            await syncOnAssignmentUpdated(
              db,
              transaction,
              requesterUid,
              administrationId,
              prevData,
              currData,
              statsRegistry.forAdministration(administrationId)
            );
            transaction.set(assignmentRef, updates, { merge: true });
          }
        }
      } else {
        throw new Error(
          `Assignment document does not exist for ${administrationId}`
        );
      }

      // Write survey responses
      transaction.set(surveyRef, updateData, { merge: true });
      statsRegistry.flush(transaction);
    });

    returnObj.success = true;
    returnObj.message = "Survey responses written successfully";
  } catch (error) {
    logger.error("Error writing survey responses in transaction", {
      error,
      administrationId,
      requesterUid,
    });
    throw new Error(`Error writing survey responses: ${error}`);
  }

  return returnObj;
}
