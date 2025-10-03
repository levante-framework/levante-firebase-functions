import { logger } from "firebase-functions/v2";
import {
  getFirestore,
  Timestamp,
  Filter,
  FieldPath,
} from "firebase-admin/firestore";
import { summarizeRunsForLog } from "../utils/logging";

export const updateBestRunAndCompletion = async ({
  roarUid,
  assignmentId,
  taskId,
}: {
  roarUid: string;
  assignmentId: string;
  taskId: string;
}) => {
  const db = getFirestore();

  const { bestRunId, completed, allRunIds, completedOn, startedOn } = await db
    .runTransaction(
      async (transaction) => {
        const runsCollection = db
          .collection("users")
          .doc(roarUid)
          .collection("runs");
        const runsQuery = runsCollection.where(
          Filter.and(
            Filter.where("taskId", "==", taskId),
            Filter.where("assignmentId", "==", assignmentId)
          )
        );

        const runs = await transaction
          .get(runsQuery)
          .then((querySnapshot) => {
            if (querySnapshot.empty) {
              return [];
            }

            return querySnapshot.docs.map((doc) => ({
              id: doc.id,
              data: doc.data(),
              ref: doc.ref,
            }));
          });

        const runSummary = summarizeRunsForLog(
          runs.map(({ id, data }) => ({ id, data }))
        );

        if (runs.length === 0) {
          logger.warn(
            `Assignment at users/${roarUid}/assignments/${assignmentId} does not contain runs for task ${taskId}`,
            {
              roarUid,
              assignmentId,
              taskId,
              runSummary,
            }
          );
          return {
            bestRunId: null,
            completed: false,
            allRunIds: [],
            completedOn: null,
            startedOn: null,
            runSummary,
          };
        }

        if (runs.length === 1) {
          transaction.update(runs[0].ref, {
            bestRun: true,
            cloudSyncTimestamp: new Date().getTime(),
          });
          return {
            bestRunId: runs[0].id,
            completed: runs[0].data.completed,
            allRunIds: [runs[0].id],
            completedOn: runs[0].data.timeFinished,
            startedOn: runs[0].data.timeStarted,
            runSummary,
          };
        }

        // Initialize bestRun as the first run. If the user has at least completed
        // one test trial, then this will be overwritten below.
        let bestRun = runs[0].id;
        let timeStarted: Timestamp | null = null;
        let timeFinished: Timestamp | null = null;

        let lowestThetaSE = Number.MAX_VALUE;
        let largestNumAttempted = 0;
        let earliestTimeStarted = Timestamp.now();
        let foundCompletedRun = false;
        let adaptiveTest = false;
        const allRunIds: string[] = [];

        for (const run of runs) {
          if (run.data.completed) {
            // Select the earliest completed run.
            foundCompletedRun = true;
            if (
              run.data.timeStarted.valueOf() < earliestTimeStarted.valueOf()
            ) {
              bestRun = run.id;
              timeStarted = run.data.timeStarted;
              timeFinished = run.data.timeFinished;
              earliestTimeStarted = run.data.timeStarted;
            }
          }

          if (!foundCompletedRun) {
            // We have not found a completed run yet. Select the run with the
            // lowest thetaSE (first) or the largest number of attempted (backup).
            const scores = run.data.scores?.raw?.composite?.test;
            if (scores) {
              const thetaSE = scores.thetaSE;
              const numAttempted = scores.numAttempted;
              if (thetaSE && thetaSE < lowestThetaSE) {
                bestRun = run.id;
                timeStarted = run.data.timeStarted;
                timeFinished = run.data.timeFinished;
                lowestThetaSE = thetaSE;
                adaptiveTest = true;
              }

              if (
                !adaptiveTest &&
                numAttempted &&
                numAttempted > largestNumAttempted
              ) {
                bestRun = run.id;
                timeStarted = run.data.timeStarted;
                timeFinished = run.data.timeFinished;
                largestNumAttempted = numAttempted;
              }
            }
          }
          allRunIds.push(run.id);
        }

        // Now we have determined the best run. Iterate through the run document
        // refs again and update the bestRun boolean flag.
        for (const run of runs) {
          transaction.update(run.ref, {
            bestRun: run.id === bestRun,
            cloudSyncTimestamp: new Date().getTime(),
          });
        }

        return {
          bestRunId: bestRun,
          completed: foundCompletedRun,
          allRunIds: allRunIds,
          completedOn: timeFinished,
          startedOn: timeStarted,
          runSummary,
        };
      },
      { maxAttempts: 1000 }
    )
    .catch((error) => {
      logger.error("Error in updateBestRunAndCompletion transaction:", {
        error,
        roarUid,
        assignmentId,
        taskId,
      });
      throw error;
    });

  if (bestRunId) {
    const assignmentDocRef = db
      .collection("users")
      .doc(roarUid)
      .collection("assignments")
      .doc(assignmentId);

    await db
      .runTransaction(
        async (transaction) => {
          const assignmentData = await transaction.get(assignmentDocRef);
          if (!assignmentData.exists) {
            logger.warn(
              `Could not find assignment document users/${roarUid}/assignments/${assignmentId}`
            );
            return;
          }

          const data = assignmentData.data();
          if (!data) {
            logger.warn(
              `Assignment document users/${roarUid}/assignments/${assignmentId} has no data`
            );
            return;
          }

          const { assessments = [], progress = {} } = data;
          const assessmentIdx = assessments.findIndex(
            (a) => a.taskId === taskId
          );

          if (assessmentIdx === -1) {
            logger.warn(
              `Assignment at users/${roarUid}/assignments/${assignmentId} ` +
                `does not contain the task ${taskId}`
            );
            return;
          }

          assessments[assessmentIdx].runId = bestRunId;
          assessments[assessmentIdx].allRunIds = allRunIds;

          if (completedOn) {
            assessments[assessmentIdx].completedOn = completedOn;
          }

          if (startedOn) {
            assessments[assessmentIdx].startedOn = startedOn;
          }

          const progressFieldPath = new FieldPath(
            "progress",
            taskId.replace(/-/g, "_")
          );
          const progressValue = completed ? "completed" : "started";

          // We should also determine whether this assignment is complete by looking
          // at all of the values in the progress object. But first, we should update
          // the progress for this taskId.
          progress[taskId] = progressValue;
          const isAssignmentCompleted = Object.values(progress).every(
            (value) => value === "completed"
          );

          return transaction.update(
            assignmentDocRef,
            "assessments",
            assessments,
            progressFieldPath,
            progressValue,
            "started",
            true,
            "completed",
            isAssignmentCompleted,
            "cloudSyncTimestamp",
            new Date().getTime()
          );
        },
        { maxAttempts: 1000 }
      )
      .catch((error) => {
        logger.error("Error in updateBestRunAndCompletion transaction:", {
          error,
          roarUid,
          assignmentId,
          taskId,
        });
        throw error;
      });
  }
};
