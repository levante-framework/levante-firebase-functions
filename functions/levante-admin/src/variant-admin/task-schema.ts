import { getFirestore, FieldValue, type Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import type { VariantParamValue } from "./upsert-variant.js";

const SCHEMAS_SUBCOLLECTION = "schemas";
const PARAM_TYPES = ["string", "number", "boolean"] as const;
export type ParamType = (typeof PARAM_TYPES)[number];

export interface ParamDefinition {
  type: ParamType;
  required?: boolean;
}

export interface TaskSchemaDoc {
  paramDefinitions: Record<string, ParamDefinition>;
  version: number;
  createdAt: Timestamp;
  createdBy: string;
}

export interface TaskSchemaSnapshot extends TaskSchemaDoc {
  schemaId: string;
}

export interface UpsertTaskSchemaData {
  taskId: string;
  paramDefinitions: Record<string, ParamDefinition>;
}

export interface ValidateParamsResult {
  valid: boolean;
  errors: string[];
}

function validateParamDefinitionKey(key: string): void {
  if (typeof key !== "string" || key.trim().length === 0) {
    throw new HttpsError("invalid-argument", "paramDefinitions keys must be non-empty strings.");
  }
}

function validateParamDefinition(def: unknown): asserts def is ParamDefinition {
  if (def === null || typeof def !== "object" || Array.isArray(def)) {
    throw new HttpsError(
      "invalid-argument",
      "Each paramDefinition must be an object { type, required? }."
    );
  }
  const d = def as Record<string, unknown>;
  if (!PARAM_TYPES.includes(d.type as ParamType)) {
    throw new HttpsError(
      "invalid-argument",
      `paramDefinition.type must be one of: ${PARAM_TYPES.join(", ")}.`
    );
  }
  if ("required" in d && typeof d.required !== "boolean") {
    throw new HttpsError("invalid-argument", "paramDefinition.required must be a boolean when present.");
  }
}

function validateParamDefinitions(
  paramDefinitions: unknown
): asserts paramDefinitions is Record<string, ParamDefinition> {
  if (
    paramDefinitions === null ||
    typeof paramDefinitions !== "object" ||
    Array.isArray(paramDefinitions)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "paramDefinitions must be an object mapping param keys to { type, required? }."
    );
  }
  for (const [key, def] of Object.entries(paramDefinitions)) {
    validateParamDefinitionKey(key);
    validateParamDefinition(def);
  }
}

export function validateParamsAgainstSchema(
  params: Record<string, VariantParamValue>,
  paramDefinitions: Record<string, ParamDefinition>
): ValidateParamsResult {
  const errors: string[] = [];
  for (const [key, def] of Object.entries(paramDefinitions)) {
    const value = params[key];
    if (value === undefined) {
      if (def.required) {
        errors.push(`Missing required param: ${key}`);
      }
      continue;
    }
    const actualType = typeof value as "string" | "number" | "boolean";
    if (actualType !== def.type) {
      errors.push(`Param ${key}: expected ${def.type}, got ${actualType}`);
    }
  }
  for (const key of Object.keys(params)) {
    if (!(key in paramDefinitions)) {
      errors.push(`Unknown param: ${key}`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export const getTaskSchemasHandler = async (
  callerUid: string,
  taskId: string
): Promise<TaskSchemaSnapshot[]> => {

  if (!taskId || typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new HttpsError("invalid-argument", "taskId is required and must be a non-empty string.");
  }

  const db = getFirestore();
  const taskRef = db.collection("tasks").doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    throw new HttpsError("not-found", `Task ${taskId} not found.`);
  }

  const snapshot = await taskRef
    .collection(SCHEMAS_SUBCOLLECTION)
    .orderBy("version", "desc")
    .get();

  return snapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      schemaId: doc.id,
      paramDefinitions: data.paramDefinitions ?? {},
      version: data.version ?? 0,
      createdAt: data.createdAt,
      createdBy: data.createdBy ?? "",
    } as TaskSchemaSnapshot;
  });
};

export const upsertTaskSchemaHandler = async (
  callerUid: string,
  data: UpsertTaskSchemaData
): Promise<{ taskId: string; schemaId: string; version: number }> => {

  const { taskId, paramDefinitions } = data;
  if (!taskId || typeof taskId !== "string" || taskId.trim().length === 0) {
    throw new HttpsError("invalid-argument", "taskId is required and must be a non-empty string.");
  }
  validateParamDefinitions(paramDefinitions);

  const db = getFirestore();
  const taskRef = db.collection("tasks").doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    throw new HttpsError("not-found", `Task ${taskId} not found.`);
  }

  const schemasSnap = await taskRef
    .collection(SCHEMAS_SUBCOLLECTION)
    .orderBy("version", "desc")
    .limit(1)
    .get();

  const nextVersion = schemasSnap.empty
    ? 1
    : (schemasSnap.docs[0].data().version as number) + 1;

  const schemaRef = taskRef.collection(SCHEMAS_SUBCOLLECTION).doc();
  await schemaRef.set({
    paramDefinitions,
    version: nextVersion,
    createdAt: FieldValue.serverTimestamp(),
    createdBy: callerUid,
  });

  logger.info("Task schema created.", {
    callerUid,
    taskId,
    schemaId: schemaRef.id,
    version: nextVersion,
  });

  return { taskId, schemaId: schemaRef.id, version: nextVersion };
};
