import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import {
  GetTasksParamsSchema,
  type GetTasksResult,
} from "@levante-framework/levante-zod";
import {
  assertCanReadTasks,
  isNotArchived,
  requireAuthUid,
  serializeTask,
  throwSchemaError,
} from "./task-management-utils.js";

export const getTasks = onCall(async (req): Promise<GetTasksResult> => {
  const uid = requireAuthUid(req.auth?.uid);

  const parsed = GetTasksParamsSchema.safeParse(req.data ?? {});
  if (!parsed.success) throwSchemaError(parsed.error);

  const userRecord = await getAuth().getUser(uid);
  assertCanReadTasks(userRecord.customClaims);

  // Always return non-archived tasks. Missing `archived` is treated as false
  // until migration backfills the field on legacy docs.
  const snap = await getFirestore().collection("tasks").get();
  const tasks = snap.docs
    .filter((doc) => isNotArchived(doc.data()))
    .map(serializeTask);

  return { tasks };
});
