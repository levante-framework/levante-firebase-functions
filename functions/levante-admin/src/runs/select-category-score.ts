import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import _cloneDeep from "lodash-es/cloneDeep";
import _get from "lodash-es/get";
import _set from "lodash-es/set";

export const selectCategoryScore = async ({
  roarUid,
  runId,
}: {
  roarUid: string;
  runId: string;
}) => {
  const db = getFirestore();

  // Because the transaction below can be retried so many times, we store the
  // log message so that it only gets logged once, upon successful completion of
  // the transaction.
  let loggerMessage: string | undefined;

  await db
    .runTransaction(
      async (transaction) => {
        const runDoc = db
          .collection("users")
          .doc(roarUid)
          .collection("runs")
          .doc(runId);

        const runData = await transaction
          .get(runDoc)
          .then((documentSnapshot) => {
            if (documentSnapshot.exists) {
              return documentSnapshot.data();
            }
            return null;
          });

        if (runData) {
          const scores = runData.scores;
          const taskId = runData.taskId;
          const schoolLevel = runData.userData?.schoolLevel;

          if (schoolLevel && scores && taskId) {
            const lowSchoolLevels = ["early-childhood", "elementary"];
            const isCategoryLow = lowSchoolLevels.includes(schoolLevel);

            let categoryScoreKey = "";

            if (taskId === "swr") {
              categoryScoreKey = isCategoryLow ? "wjPercentile" : "roarScore";
            } else if (taskId === "sre") {
              categoryScoreKey = isCategoryLow
                ? "tosrecPercentile"
                : "sreScore";
            } else if (taskId === "pa") {
              categoryScoreKey = isCategoryLow ? "percentile" : "roarScore";
            } else {
              return;
            }

            const categoryScore = _get(
              scores,
              `computed.composite.${categoryScoreKey}`
            );

            if (categoryScore !== undefined) {
              const updatedScores = _cloneDeep(scores);
              _set(
                updatedScores,
                "computed.composite.categoryScore",
                categoryScore
              );

              loggerMessage = `Updated ${runDoc.path} with category score from ${categoryScoreKey}`;

              return transaction.update(runDoc, {
                scores: updatedScores,
                cloudSyncTimestamp: new Date().getTime(),
              });
            } else {
              loggerMessage = `Category score unavailable for ${runDoc.path}`;
            }
          } else {
            loggerMessage = `schoolLevel, scores, or taskId missing from run ${runDoc.path}`;
          }
        } else {
          loggerMessage = `runData missing for run ${runDoc.path}`;
        }

        return null;
      },
      { maxAttempts: 1000 }
    )
    .catch((error) => {
      logger.error("Error in selectCategoryScore transaction:", {
        error,
        roarUid,
        runId,
      });
      throw error;
    });

  if (loggerMessage) {
    logger.debug(loggerMessage);
  }
};
