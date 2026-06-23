import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";

export interface UpsertTaskData {
  id: string;
  name: string;
}

export const upsertTaskHandler = async (
  callerUid: string,
  data: UpsertTaskData
): Promise<{ id: string; created: boolean }> => {
  const { id, name, ...rest } = data;

  if (!id || typeof id !== "string" || id.trim().length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "id is required and must be a non-empty string."
    );
  }
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "name is required and must be a non-empty string."
    );
  }

  const taskId = id.trim();
  const db = getFirestore();
  const taskRef = db.collection("tasks").doc(taskId);
  const taskSnap = await taskRef.get();

  const payload = {
    name: name.trim(),
    lastUpdated: FieldValue.serverTimestamp(),
    ...rest, // free flowing for now until we have a schema
  };

  if (taskSnap.exists) {
    await taskRef.update(payload);
    logger.info("Task updated.", { callerUid, taskId });
    return { id: taskId, created: false };
  }

  await taskRef.set(payload);
  logger.info("Task created.", { callerUid, taskId });
  return { id: taskId, created: true };
};
