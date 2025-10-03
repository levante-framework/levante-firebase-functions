import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import {
  shouldCompleteAssignment,
  getAssignmentDocRef,
  getAssignmentDoc,
} from "./utils/assignment";

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

export async function writeSurveyResponses(requesterUid, data) {
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
    // First, check if survey response already exists
    const existingResponseQuery = await surveyResponsesCollection
      .where("administrationId", "==", administrationId)
      .limit(1)
      .get();

    let surveyRef: FirebaseFirestore.DocumentReference;
    let isNewDocument = false;
    if (existingResponseQuery.empty) {
      surveyRef = surveyResponsesCollection.doc();
      isNewDocument = true;
    } else {
      surveyRef = existingResponseQuery.docs[0].ref;
    }

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
      // ALL READS FIRST - Firestore requires all reads before any writes

      // Read existing survey data if document exists
      let existingData: any = {};
      if (!isNewDocument) {
        const existingDoc = await transaction.get(surveyRef);
        if (existingDoc.exists) {
          existingData = existingDoc.data() || {};
        }
      }

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
