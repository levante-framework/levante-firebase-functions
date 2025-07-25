import { getFirestore, FieldValue } from "firebase-admin/firestore";

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
  const assignmentsCollection = userRef.collection("assignments");

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
      const assignmentRef = assignmentsCollection.doc(administrationId);
      const assignmentDoc = await transaction.get(assignmentRef);

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
      console.log(
        `[DEBUG] Assignment document exists: ${assignmentDoc.exists}`
      );

      if (assignmentDoc.exists) {
        const assignmentData = assignmentDoc.data();
        const assessments = assignmentData?.assessments || [];

        console.log(`[DEBUG] Assignment ID: ${administrationId}`);
        console.log(`[DEBUG] User ID: ${requesterUid}`);
        console.log(`[DEBUG] Assignment path: ${assignmentRef.path}`);
        console.log(`[DEBUG] Number of assessments: ${assessments.length}`);
        console.log(
          `[DEBUG] Assessment taskIds:`,
          assessments.map((a) => a.taskId)
        );
        console.log(`[DEBUG] isNewDocument: ${isNewDocument}`);
        console.log(
          `[DEBUG] isEntireSurveyCompleted: ${isEntireSurveyCompleted}`
        );

        // Find the survey assessment
        const surveyAssessmentIndex = assessments.findIndex(
          (assessment) => assessment.taskId === "survey"
        );

        console.log(
          `[DEBUG] Survey assessment index: ${surveyAssessmentIndex}`
        );

        if (surveyAssessmentIndex !== -1) {
          const surveyAssessment = assessments[surveyAssessmentIndex];
          console.log(
            `[DEBUG] Current survey assessment:`,
            JSON.stringify(surveyAssessment, null, 2)
          );
          console.log(
            `[DEBUG] Current survey assessment startedOn: ${surveyAssessment.startedOn}`
          );
          console.log(
            `[DEBUG] Current survey assessment completedOn: ${surveyAssessment.completedOn}`
          );

          // Build update operations separately to ensure they work
          const updates: any = {};

          // Handle timestamps separately using dot notation to avoid array issues
          if (isNewDocument && !assessments[surveyAssessmentIndex].startedOn) {
            updates[`assessments.${surveyAssessmentIndex}.startedOn`] =
              FieldValue.serverTimestamp();
            console.log(
              `[DEBUG] Adding startedOn timestamp for index ${surveyAssessmentIndex}`
            );
          } else {
            console.log(
              `[DEBUG] NOT adding startedOn - isNewDocument: ${isNewDocument}, existing startedOn: ${assessments[surveyAssessmentIndex].startedOn}`
            );
          }

          if (isEntireSurveyCompleted) {
            updates[`assessments.${surveyAssessmentIndex}.completedOn`] =
              FieldValue.serverTimestamp();
            updates["progress.survey"] = "completed";
            console.log(
              `[DEBUG] Adding completedOn timestamp and setting progress.survey to completed for index ${surveyAssessmentIndex}`
            );
          } else {
            console.log(
              `[DEBUG] NOT adding completedOn - isEntireSurveyCompleted: ${isEntireSurveyCompleted}`
            );
          }

          console.log(`[DEBUG] Update object keys:`, Object.keys(updates));
          console.log(`[DEBUG] Update object:`, updates);

          // Apply updates if any exist
          if (Object.keys(updates).length > 0) {
            console.log(
              `[DEBUG] Applying ${
                Object.keys(updates).length
              } updates to assignment document`
            );
            transaction.update(assignmentRef, updates);
          } else {
            console.log(`[DEBUG] No updates to apply`);
          }
        } else {
          console.log(
            `[DEBUG] Survey assessment NOT found in assessments array`
          );
          console.log(
            `[DEBUG] Available taskIds:`,
            assessments.map((a) => a.taskId)
          );
        }

        // Also log current progress state
        console.log(
          `[DEBUG] Current progress object:`,
          JSON.stringify(assignmentData?.progress, null, 2)
        );
      } else {
        console.log(
          `[DEBUG] Assignment document does not exist for ${administrationId}`
        );
      }

      // Write survey responses
      transaction.set(surveyRef, updateData, { merge: true });
    });

    returnObj.success = true;
    returnObj.message = "Survey responses written successfully";
  } catch (error) {
    throw new Error(`Error writing survey responses: ${error}`);
  }

  return returnObj;
}
