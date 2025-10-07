import retry from "async-retry";
import { logger } from "firebase-functions/v2";
import { updateBestRunAndCompletion } from "./update-best-run-and-completion.js";
import { selectCategoryScore } from "./select-category-score.js";
import { type DocumentWrittenEvent } from "../utils/utils.js";

/**
 * Compute the best run for a given task in a given assignment.
 * Also compute the categoryScore for each run.
 *
 * This function triggers on every change to a run document.
 * From the document path, it retrieves the user's roarUid.
 * From the document data itself, it retrieves the assignmentId and taskId.
 *
 * Because this function both writes to and is triggered by changes to the
 * run document, we check to prevent infinite loops where document
 * change -> function trigger -> document change, and so on.
 *
 * @param {DocumentWrittenEvent} event - The onDocumentWritten event.
 */
export const syncOnRunDocUpdateEventHandler = async (
  event: DocumentWrittenEvent
) => {
  const roarUid = event.params.roarUid;
  const runId = event.params.runId;
  const prevData = event.data?.before.data();
  const currData = event.data?.after.data();

  if (currData === undefined) {
    if (prevData === undefined) {
      // This is weird, we should never get here.
      // This would mean that the run document was deleted, but also created.
      return Promise.resolve({ status: "ok" });
    }

    // In this case, the document was deleted.
    // We still want to determine the best run. (e.g., what if the deleted run
    // was the previous best run and now we have to assign a new one?)
    // So we retrieve the taskId and assignmentId from the previous data.
    const taskId = prevData.taskId;
    const assignmentId = prevData.assignmentId;
    await retry(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (bail) => {
        await updateBestRunAndCompletion({
          roarUid,
          assignmentId,
          taskId,
        });
      },
      {
        retries: 3,
      }
    );

    // Do not update the categoryScore because the run was deleted.
    return Promise.resolve({ status: "ok" });
  }

  const taskId = currData.taskId;
  const assignmentId = currData.assignmentId;
  if (prevData === undefined) {
    // In this case, the document was created.
    await retry(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (bail) => {
        await updateBestRunAndCompletion({
          roarUid,
          assignmentId,
          taskId,
        });
      },
      {
        retries: 3,
      }
    );

    // It is unlikely that the scores will be defined for a run that has just
    // been created. However, we compute the categoryScore for this run just
    // in case.
    const compositeScores = currData.scores?.computed?.composite;
    if (compositeScores) {
      await selectCategoryScore({ roarUid, runId });
    }

    return Promise.resolve({ status: "ok" });
  }

  // Skip updates where cloudSyncTimestamp field changed to avoid infinite loops
  const skipUpdate =
    prevData?.cloudSyncTimestamp &&
    currData?.cloudSyncTimestamp &&
    prevData.cloudSyncTimestamp !== currData.cloudSyncTimestamp;
  if (skipUpdate) {
    logger.debug(
      `No changes to run document /users/${roarUid}/runs/${runId}, skipping update`
    );
    return Promise.resolve({ status: "ok" });
  }

  await retry(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    async (bail) => {
      await updateBestRunAndCompletion({
        roarUid,
        assignmentId,
        taskId,
      });
    },
    {
      retries: 3,
    }
  );

  const compositeScores = currData.scores?.computed?.composite;
  if (compositeScores) {
    await selectCategoryScore({ roarUid, runId });
  }

  return Promise.resolve({ status: "ok" });
};
