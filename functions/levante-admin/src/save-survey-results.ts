import { getFirestore } from "firebase-admin/firestore";

type Response = {
  responseTime: string;
  responseValue: string;
};

interface SurveyData {
  pageNo: number;
  isGeneral: boolean;
  isComplete: boolean;
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
    const existingResponseQuery = await surveyResponsesCollection
      .where("administrationId", "==", administrationId)
      .limit(1)
      .get();

    let surveyRef;
    let isNewDocument = false;
    if (existingResponseQuery.empty) {
      surveyRef = surveyResponsesCollection.doc();
      isNewDocument = true;
    } else {
      surveyRef = existingResponseQuery.docs[0].ref;
    }

    const { pageNo, isGeneral, isComplete, specificId, responses, userType } =
      surveyData as SurveyData;

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

    let updateData: any = {
      administrationId,
      pageNo,
      updatedAt: new Date(),
    };

    if (isNewDocument) {
      updateData.createdAt = new Date();
    }

    // Fetch existing data
    const existingData = (await surveyRef.get()).data() || {};

    // Update general data
    if (isGeneral) {
      updateData.general = {
        isComplete: isComplete,
        responses: isComplete
          ? responsesWithTimestamps // Overwrite all responses if the survey is complete
          : { ...existingData.general?.responses, ...responsesWithTimestamps }, // Merge new responses with existing ones
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

    await surveyRef.set(updateData, { merge: true });

    returnObj.success = true;
    returnObj.message = "Survey responses written successfully";
  } catch (error) {
    throw new Error(`Error writing survey responses: ${error}`);
  }

  return returnObj;
}
