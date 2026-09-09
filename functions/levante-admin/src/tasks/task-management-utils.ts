import type {
  DocumentData,
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { HttpsError } from "firebase-functions/v2/https";
import type {
  SerializedTask,
  SerializedTaskVariant,
  SerializedTaskVariantRevision,
  SerializedVariantParamSpec,
} from "@levante-framework/levante-zod";
import { ROLES } from "../utils/constants.js";
import {
  extractRolesFromClaims,
  normalizeRoleKey,
} from "../utils/role-helpers.js";

const TASK_READ_ROLES = new Set([
  ROLES.SUPER_ADMIN,
  ROLES.SITE_ADMIN,
  ROLES.ADMIN,
  ROLES.RESEARCH_ASSISTANT,
]);

type SchemaIssueSource = {
  issues: Array<{ path: PropertyKey[]; message: string }>;
};

function callerHasRole(
  claims: Record<string, unknown>,
  allowed: Set<string>
): boolean {
  const rolesFromClaims = extractRolesFromClaims(claims);
  if (rolesFromClaims.some((role) => allowed.has(role.role))) return true;

  const rolesSet = claims.rolesSet;
  if (
    Array.isArray(rolesSet) &&
    rolesSet.some((role) => allowed.has(normalizeRoleKey(role)))
  ) {
    return true;
  }

  return false;
}

/** True when archived is explicitly false or missing (pre-migration docs). */
export function isNotArchived(data: DocumentData): boolean {
  return data.archived !== true;
}

export function throwSchemaError(error: SchemaIssueSource): never {
  throw new HttpsError("invalid-argument", "Invalid input", {
    code: "schema",
    issues: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  });
}

export function requireAuthUid(uid: string | undefined): string {
  if (!uid) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }
  return uid;
}

/**
 * Task catalog reads are universal (not site-scoped). Allowed for every
 * admin-style role; participants are denied.
 */
export function assertCanReadTasks(
  claims: Record<string, unknown> | undefined
): void {
  if (!claims) {
    throw new HttpsError(
      "permission-denied",
      "You do not have permission to read tasks"
    );
  }

  if (claims.super_admin === true || claims.admin === true) return;
  if (callerHasRole(claims, TASK_READ_ROLES)) return;

  throw new HttpsError(
    "permission-denied",
    "You do not have permission to read tasks"
  );
}

/** Task catalog writes are super_admin-only and not site-scoped. */
export function assertCanWriteTasks(
  claims: Record<string, unknown> | undefined
): void {
  if (!claims) {
    throw new HttpsError(
      "permission-denied",
      "You do not have permission to write tasks"
    );
  }

  if (claims.super_admin === true) return;
  if (callerHasRole(claims, new Set([ROLES.SUPER_ADMIN]))) return;

  throw new HttpsError(
    "permission-denied",
    "You do not have permission to write tasks"
  );
}

/** Semantic Firestore doc id from a display name, e.g. "Matrix Reasoning" → "matrix-reasoning". */
export function semanticIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) {
    throw new HttpsError(
      "invalid-argument",
      "Could not derive a document id from name",
      {
        code: "schema",
        issues: [{ path: "name", message: "Name must yield a non-empty id" }],
      }
    );
  }
  return slug;
}

export function toIsoString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (
    typeof value === "object" &&
    "toDate" in value &&
    typeof (value as { toDate: unknown }).toDate === "function"
  ) {
    return (value as Timestamp).toDate().toISOString();
  }
  return undefined;
}

function requireIsoString(data: DocumentData, ...keys: string[]): string {
  for (const key of keys) {
    const iso = toIsoString(data[key]);
    if (iso) return iso;
  }
  return new Date(0).toISOString();
}

/** Drop null/undefined and non-primitive param values for the wire format. */
export function stripNullParams(
  params: unknown
): Record<string, boolean | number | string> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return {};
  }

  const out: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    if (
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "string"
    ) {
      out[key] = value;
    }
  }
  return out;
}

export type VariantParams = Record<string, boolean | number | string>;

/**
 * Rejects null/undefined and non-primitive values on write.
 * Returns a cleaned params object for storage/comparison.
 */
export function assertWritableParams(params: unknown): VariantParams {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new HttpsError("invalid-argument", "Invalid input", {
      code: "schema",
      issues: [
        {
          path: "params",
          message: "Params must be an object of boolean, number, or string",
        },
      ],
    });
  }

  const issues: Array<{ path: string; message: string }> = [];
  const out: VariantParams = {};

  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) {
      issues.push({
        path: `params.${key}`,
        message: "Null/undefined param values are not allowed",
      });
      continue;
    }
    if (
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "string"
    ) {
      out[key] = value;
    } else {
      issues.push({
        path: `params.${key}`,
        message: "Param value must be boolean, number, or string",
      });
    }
  }

  if (issues.length > 0) {
    throw new HttpsError("invalid-argument", "Invalid input", {
      code: "schema",
      issues,
    });
  }

  return out;
}

/** Deep equality of params bags: same keys and same values (order-independent). */
export function paramsEqual(a: VariantParams, b: VariantParams): boolean {
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (a[aKeys[i]] !== b[bKeys[i]]) return false;
  }
  return true;
}

type ParamSpecType = "boolean" | "number" | "string" | "unknown";

/**
 * Ensures every param key exists in a non-archived variantParamSpec and the
 * value type matches the spec (`unknown` accepts boolean|number|string).
 */
export async function assertParamsAllowedBySpecs(
  db: Firestore,
  params: VariantParams
): Promise<void> {
  const specsSnap = await db.collection("variantParamSpecs").get();
  const specsByName = new Map<string, ParamSpecType>();
  for (const doc of specsSnap.docs) {
    const data = doc.data();
    if (!isNotArchived(data)) continue;
    const type = data.type;
    if (
      type === "boolean" ||
      type === "number" ||
      type === "string" ||
      type === "unknown"
    ) {
      specsByName.set(doc.id, type);
      if (typeof data.name === "string" && data.name !== doc.id) {
        specsByName.set(data.name, type);
      }
    }
  }

  const issues: Array<{ path: string; message: string }> = [];
  for (const [key, value] of Object.entries(params)) {
    const specType = specsByName.get(key);
    if (!specType) {
      issues.push({
        path: `params.${key}`,
        message: `Param "${key}" is not defined in variantParamSpecs`,
      });
      continue;
    }
    const valueType = typeof value;
    if (specType === "unknown") continue;
    if (valueType !== specType) {
      issues.push({
        path: `params.${key}`,
        message: `Param "${key}" must be of type ${specType}`,
      });
    }
  }

  if (issues.length > 0) {
    throw new HttpsError("invalid-argument", "Invalid input", {
      code: "schema",
      issues,
    });
  }
}

/** Finds a sibling variant under the same task with an identical params bag. */
export async function findVariantWithSameParams(
  taskRef: DocumentReference,
  params: VariantParams
): Promise<DocumentSnapshot | null> {
  const variantsSnap = await taskRef.collection("variants").get();
  for (const doc of variantsSnap.docs) {
    if (!isNotArchived(doc.data())) continue;
    const existing = stripNullParams(doc.data().params);
    if (paramsEqual(existing, params)) return doc;
  }
  return null;
}

export async function writeVariantRevision(
  variantSnap: DocumentSnapshot | QueryDocumentSnapshot,
  fields: {
    archived: boolean;
    registered: boolean;
    updatedBy: string;
  }
): Promise<void> {
  const data = variantSnap.data() ?? {};
  const now = FieldValue.serverTimestamp();
  await variantSnap.ref.collection("revisions").add({
    archived: fields.archived,
    createdAt: now,
    ...(typeof data.createdBy === "string"
      ? { createdBy: data.createdBy }
      : {}),
    name: typeof data.name === "string" ? data.name : "",
    params: data.params ?? {},
    registered: fields.registered,
    updatedAt: now,
    updatedBy: fields.updatedBy,
  });
}

/**
 * Returns `registered` from the latest revision under the variant.
 * If no revisions exist, creates one from the variant's current fields.
 */
export async function resolveRegisteredFromLatestRevision(
  variantSnap: DocumentSnapshot | QueryDocumentSnapshot
): Promise<boolean> {
  const revisionsRef = variantSnap.ref.collection("revisions");
  const latestSnap = await revisionsRef
    .orderBy("updatedAt", "desc")
    .limit(1)
    .get();

  if (!latestSnap.empty) {
    return latestSnap.docs[0].data().registered === true;
  }

  const data = variantSnap.data() ?? {};
  const registered = data.registered === true;
  await writeVariantRevision(variantSnap, {
    archived: data.archived === true,
    registered,
    updatedBy:
      typeof data.updatedBy === "string"
        ? data.updatedBy
        : typeof data.createdBy === "string"
        ? data.createdBy
        : "system",
  });

  return registered;
}

export function serializeTask(snap: DocumentSnapshot): SerializedTask {
  const data = snap.data() ?? {};
  return {
    id: snap.id,
    archived: data.archived === true,
    createdAt: requireIsoString(data, "createdAt", "updatedAt", "lastUpdated"),
    ...(typeof data.createdBy === "string"
      ? { createdBy: data.createdBy }
      : {}),
    description: typeof data.description === "string" ? data.description : "",
    image: typeof data.image === "string" ? data.image : "",
    name: typeof data.name === "string" ? data.name : "",
    updatedAt: requireIsoString(data, "updatedAt", "lastUpdated", "createdAt"),
    ...(typeof data.updatedBy === "string"
      ? { updatedBy: data.updatedBy }
      : {}),
  };
}

export function serializeTaskVariant(
  snap: DocumentSnapshot,
  taskId: string,
  registered: boolean
): SerializedTaskVariant & { displayName: string } {
  const data = snap.data() ?? {};
  return {
    id: snap.id,
    taskId,
    archived: data.archived === true,
    createdAt: requireIsoString(data, "createdAt", "updatedAt", "lastUpdated"),
    ...(typeof data.createdBy === "string"
      ? { createdBy: data.createdBy }
      : {}),
    displayName:
      typeof data.displayName === "string"
        ? data.displayName
        : typeof data.name === "string"
        ? data.name
        : "",
    name: typeof data.name === "string" ? data.name : "",
    params: stripNullParams(data.params),
    registered,
    updatedAt: requireIsoString(data, "updatedAt", "lastUpdated", "createdAt"),
    ...(typeof data.updatedBy === "string"
      ? { updatedBy: data.updatedBy }
      : {}),
  };
}

export function serializeTaskVariantRevision(
  snap: DocumentSnapshot
): SerializedTaskVariantRevision {
  const data = snap.data() ?? {};
  return {
    id: snap.id,
    archived: data.archived === true,
    registered: data.registered === true,
    updatedAt: requireIsoString(data, "updatedAt", "createdAt"),
    updatedBy: typeof data.updatedBy === "string" ? data.updatedBy : "",
  };
}

type AttributionFields = {
  createdBy?: string;
  updatedBy?: string;
};

/**
 * Resolve Auth UIDs in `createdBy` / `updatedBy` to emails for the wire format.
 * Falls back to the original value when the user/email cannot be resolved.
 */
export async function resolveAttributionEmails<T extends AttributionFields>(
  items: T[]
): Promise<T[]> {
  const uids = new Set<string>();
  for (const item of items) {
    if (item.createdBy) uids.add(item.createdBy);
    if (item.updatedBy) uids.add(item.updatedBy);
  }
  if (uids.size === 0) return items;

  const emailByUid = new Map<string, string>();
  const identifiers = [...uids].map((uid) => ({ uid }));
  // getUsers accepts at most 100 identifiers per call.
  for (let i = 0; i < identifiers.length; i += 100) {
    const chunk = identifiers.slice(i, i + 100);
    const result = await getAuth().getUsers(chunk);
    for (const user of result.users) {
      if (user.email) emailByUid.set(user.uid, user.email);
    }
  }

  return items.map((item) => ({
    ...item,
    ...(item.createdBy
      ? { createdBy: emailByUid.get(item.createdBy) ?? item.createdBy }
      : {}),
    ...(item.updatedBy
      ? { updatedBy: emailByUid.get(item.updatedBy) ?? item.updatedBy }
      : {}),
  }));
}

export function serializeVariantParamSpec(
  snap: DocumentSnapshot
): SerializedVariantParamSpec {
  const data = snap.data() ?? {};
  const type = data.type;
  return {
    id: snap.id,
    archived: data.archived === true,
    createdAt: requireIsoString(data, "createdAt", "updatedAt"),
    createdBy: typeof data.createdBy === "string" ? data.createdBy : "",
    description: typeof data.description === "string" ? data.description : "",
    name: typeof data.name === "string" ? data.name : "",
    type:
      type === "boolean" ||
      type === "number" ||
      type === "string" ||
      type === "unknown"
        ? type
        : "unknown",
    updatedAt: requireIsoString(data, "updatedAt", "createdAt"),
    updatedBy: typeof data.updatedBy === "string" ? data.updatedBy : "",
  };
}

/** Extract taskId from `tasks/{taskId}/variants/{variantId}` paths. */
export function taskIdFromVariantPath(path: string): string | undefined {
  const parts = path.split("/");
  const tasksIdx = parts.indexOf("tasks");
  const variantsIdx = parts.indexOf("variants");
  if (tasksIdx >= 0 && variantsIdx === tasksIdx + 2) {
    return parts[tasksIdx + 1];
  }
  return undefined;
}
