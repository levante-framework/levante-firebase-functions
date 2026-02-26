import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";

export type VariantParamValue = boolean | number | string;

export interface UpsertVariantData {
  taskId: string;
  variantId?: string;
  name: string;
  params: Record<string, VariantParamValue>;
  registered: boolean;
}

function isVariantParamValue(v: unknown): v is VariantParamValue {
  return (
    typeof v === "boolean" || typeof v === "number" || typeof v === "string"
  );
}

function validateParams(
  params: unknown
): asserts params is Record<string, VariantParamValue> {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new HttpsError(
      "invalid-argument",
      "params must be an object with boolean, number, or string values"
    );
  }
  for (const [key, value] of Object.entries(params)) {
    if (typeof key !== "string" || key.length === 0) {
      throw new HttpsError("invalid-argument", "params keys must be non-empty strings");
    }
    if (!isVariantParamValue(value)) {
      throw new HttpsError(
        "invalid-argument",
        `params.${key} must be a boolean, number, or string`
      );
    }
  }
}

export const upsertVariantHandler = async (
  callerUid: string,
  data: UpsertVariantData
): Promise<{ taskId: string; variantId: string }> => {
  const db = getFirestore();
  const { taskId, variantId, name, params, registered } = data;

  if (!taskId || typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new HttpsError("invalid-argument", "taskId is required and must be a non-empty string.");
  }
  if (!name || typeof name !== "string" || name.trim().length === 0) {
    throw new HttpsError("invalid-argument", "name is required and must be a non-empty string.");
  }
  if (typeof registered !== "boolean") {
    throw new HttpsError("invalid-argument", "registered must be a boolean.");
  }
  validateParams(params);

  const taskRef = db.collection("tasks").doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    throw new HttpsError("not-found", `Task ${taskId} not found.`);
  }

  const variantPayload = {
    name: name.trim(),
    params,
    registered,
    lastUpdated: FieldValue.serverTimestamp(),
  };

  if (variantId && typeof variantId === "string" && variantId.trim().length > 0) {
    const variantRef = taskRef.collection("variants").doc(variantId.trim());
    const variantSnap = await variantRef.get();
    if (!variantSnap.exists) {
      throw new HttpsError("not-found", `Variant ${variantId} not found for task ${taskId}.`);
    }
    await variantRef.update(variantPayload);
    logger.info("Variant updated.", { callerUid, taskId, variantId: variantRef.id });
    return { taskId, variantId: variantRef.id };
  }

  const variantRef = taskRef.collection("variants").doc();
  await variantRef.set(variantPayload);
  logger.info("Variant created.", { callerUid, taskId, variantId: variantRef.id });
  return { taskId, variantId: variantRef.id };
};
