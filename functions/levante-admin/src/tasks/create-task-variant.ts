import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  CreateTaskVariantParamsSchema,
  type CreateTaskVariantResult,
} from "@levante-framework/levante-zod";
import {
  assertCanWriteTasks,
  assertParamsAllowedBySpecs,
  assertWritableParams,
  findVariantWithSameParams,
  requireAuthUid,
  resolveAttributionEmails,
  serializeTaskVariant,
  throwSchemaError,
  writeVariantRevision,
} from "./task-management-utils.js";

export const createTaskVariant = onCall(
  async (req): Promise<CreateTaskVariantResult> => {
    const uid = requireAuthUid(req.auth?.uid);

    const parsed = CreateTaskVariantParamsSchema.safeParse(req.data ?? {});
    if (!parsed.success) throwSchemaError(parsed.error);

    const { name, params: rawParams, registered, taskId } = parsed.data;

    const userRecord = await getAuth().getUser(uid);
    assertCanWriteTasks(userRecord.customClaims);

    const params = assertWritableParams(rawParams);
    const db = getFirestore();

    await assertParamsAllowedBySpecs(db, params);

    const taskRef = db.collection("tasks").doc(taskId);
    const taskSnap = await taskRef.get();
    if (!taskSnap.exists) {
      throw new HttpsError("not-found", `Task ${taskId} not found`, {
        code: "task",
        taskId,
      });
    }

    const duplicate = await findVariantWithSameParams(taskRef, params);
    if (duplicate) {
      throw new HttpsError(
        "already-exists",
        "A variant with the same params already exists for this task",
        {
          code: "params",
          params,
        }
      );
    }

    const now = FieldValue.serverTimestamp();
    const variantRef = taskRef.collection("variants").doc();
    await variantRef.set({
      archived: false,
      createdAt: now,
      createdBy: uid,
      name,
      params,
      registered,
      updatedAt: now,
      updatedBy: uid,
    });

    const created = await variantRef.get();
    await writeVariantRevision(created, {
      archived: false,
      registered,
      updatedBy: uid,
    });

    return {
      variant: (
        await resolveAttributionEmails([
          serializeTaskVariant(created, taskId, registered),
        ])
      )[0],
    };
  }
);
