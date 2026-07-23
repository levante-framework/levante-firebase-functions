import type {
  DocumentData,
  DocumentSnapshot,
  QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
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

  const rolesFromClaims = extractRolesFromClaims(claims);
  if (rolesFromClaims.some((role) => TASK_READ_ROLES.has(role.role))) return;

  const rolesSet = claims.rolesSet;
  if (
    Array.isArray(rolesSet) &&
    rolesSet.some((role) => TASK_READ_ROLES.has(normalizeRoleKey(role)))
  ) {
    return;
  }

  throw new HttpsError(
    "permission-denied",
    "You do not have permission to read tasks"
  );
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
  const now = FieldValue.serverTimestamp();

  await revisionsRef.add({
    archived: data.archived === true,
    createdAt: data.createdAt ?? now,
    ...(typeof data.createdBy === "string" ? { createdBy: data.createdBy } : {}),
    name: typeof data.name === "string" ? data.name : "",
    params: data.params ?? {},
    registered,
    updatedAt: now,
    ...(typeof data.updatedBy === "string" ? { updatedBy: data.updatedBy } : {}),
  });

  return registered;
}

export function serializeTask(snap: DocumentSnapshot) {
  const data = snap.data() ?? {};
  return {
    id: snap.id,
    archived: data.archived === true,
    createdAt: requireIsoString(data, "createdAt", "updatedAt", "lastUpdated"),
    ...(typeof data.createdBy === "string" ? { createdBy: data.createdBy } : {}),
    description: typeof data.description === "string" ? data.description : "",
    image: typeof data.image === "string" ? data.image : "",
    name: typeof data.name === "string" ? data.name : "",
    updatedAt: requireIsoString(data, "updatedAt", "lastUpdated", "createdAt"),
    ...(typeof data.updatedBy === "string" ? { updatedBy: data.updatedBy } : {}),
  };
}

export function serializeTaskVariant(
  snap: DocumentSnapshot,
  taskId: string,
  registered: boolean
) {
  const data = snap.data() ?? {};
  return {
    id: snap.id,
    taskId,
    archived: data.archived === true,
    createdAt: requireIsoString(data, "createdAt", "updatedAt", "lastUpdated"),
    ...(typeof data.createdBy === "string" ? { createdBy: data.createdBy } : {}),
    name: typeof data.name === "string" ? data.name : "",
    params: stripNullParams(data.params),
    registered,
    updatedAt: requireIsoString(data, "updatedAt", "lastUpdated", "createdAt"),
    ...(typeof data.updatedBy === "string" ? { updatedBy: data.updatedBy } : {}),
  };
}

export function serializeVariantParamSpec(snap: DocumentSnapshot) {
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
