import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  UpsertTaskParamsSchema,
  type UpsertTaskResult,
} from "@levante-framework/levante-zod";
import {
  assertCanWriteTasks,
  requireAuthUid,
  semanticIdFromName,
  serializeTask,
  throwSchemaError,
} from "./task-management-utils.js";

export const upsertTask = onCall(async (req): Promise<UpsertTaskResult> => {
  const uid = requireAuthUid(req.auth?.uid);

  const parsed = UpsertTaskParamsSchema.safeParse(req.data ?? {});
  if (!parsed.success) throwSchemaError(parsed.error);

  const { archived, description, image, name, id } = parsed.data;

  const userRecord = await getAuth().getUser(uid);
  assertCanWriteTasks(userRecord.customClaims);

  const db = getFirestore();
  const now = FieldValue.serverTimestamp();

  if (id) {
    const taskRef = db.collection("tasks").doc(id);
    const existing = await taskRef.get();
    if (!existing.exists) {
      throw new HttpsError("not-found", `Task ${id} not found`, {
        code: "task",
        taskId: id,
      });
    }

    await taskRef.update({
      archived,
      description,
      image,
      name,
      updatedAt: now,
      updatedBy: uid,
    });

    const updated = await taskRef.get();
    return { task: serializeTask(updated) };
  }

  const taskId = semanticIdFromName(name);
  const taskRef = db.collection("tasks").doc(taskId);
  const existing = await taskRef.get();
  if (existing.exists) {
    throw new HttpsError(
      "already-exists",
      `Task ${taskId} already exists`,
      {
        code: "task",
        taskId,
      }
    );
  }

  await taskRef.set({
    archived,
    createdAt: now,
    createdBy: uid,
    description,
    image,
    name,
    updatedAt: now,
    updatedBy: uid,
  });

  const created = await taskRef.get();
  return { task: serializeTask(created) };
});
