import { getAuth, type Auth } from "firebase-admin/auth";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { BigQueryAuditJournalReader } from "./bigqueryClient.js";
import {
  type AuditJournalQueryParams,
  type AuditJournalQueryResult,
  type AuditJournalReader,
  type JournalOperation,
  type RequiredAuditJournalQueryParams,
} from "./types.js";

const DEFAULT_LOOKBACK_HOURS = 24;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const VALID_OPERATIONS = new Set<JournalOperation>([
  "create",
  "update",
  "delete",
]);

type AuthReader = Pick<Auth, "getUser">;

const auditJournalReader = new BigQueryAuditJournalReader();

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const optionalString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;

const optionalBoolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const dateString = (value: unknown, fallback: Date, field: string): string => {
  const raw = optionalString(value);
  if (!raw) return fallback.toISOString();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpsError("invalid-argument", `${field} must be a valid date`);
  }
  return parsed.toISOString();
};

const limitValue = (value: unknown): number => {
  if (value === undefined || value === null) return DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new HttpsError("invalid-argument", "limit must be an integer");
  }
  if (value < 1) return 1;
  return Math.min(value, MAX_LIMIT);
};

const operationValue = (value: unknown): JournalOperation | null => {
  const operation = optionalString(value);
  if (!operation) return null;
  if (!VALID_OPERATIONS.has(operation as JournalOperation)) {
    throw new HttpsError(
      "invalid-argument",
      "operation must be create, update, or delete"
    );
  }
  return operation as JournalOperation;
};

export const normalizeAuditJournalQueryParams = (
  data: unknown,
  now = new Date()
): RequiredAuditJournalQueryParams => {
  const input = asRecord(data);
  const defaultStart = new Date(
    now.getTime() - DEFAULT_LOOKBACK_HOURS * 60 * 60 * 1000
  );
  const startTime = dateString(input.startTime, defaultStart, "startTime");
  const endTime = dateString(input.endTime, now, "endTime");

  if (new Date(startTime).getTime() > new Date(endTime).getTime()) {
    throw new HttpsError(
      "invalid-argument",
      "startTime must be before endTime"
    );
  }

  return {
    startTime,
    endTime,
    resourcePath: optionalString(input.resourcePath),
    resourcePathPrefix: optionalString(input.resourcePathPrefix),
    operation: operationValue(input.operation),
    actor: optionalString(input.actor),
    requestId: optionalString(input.requestId),
    payloadTruncated: optionalBoolean(input.payloadTruncated),
    includePayloads: input.includePayloads === true,
    limit: limitValue(input.limit),
    pageToken: optionalString(input.pageToken),
  };
};

export const hasSuperAdminClaim = (
  customClaims: Record<string, unknown>
): boolean => {
  if (customClaims.super_admin === true) return true;

  const rolesSet = customClaims.rolesSet;
  if (Array.isArray(rolesSet) && rolesSet.includes("super_admin")) {
    return true;
  }

  const roles = customClaims.roles;
  if (
    Array.isArray(roles) &&
    roles.some((role) => asRecord(role).role === "super_admin")
  ) {
    return true;
  }

  const siteRoles = customClaims.siteRoles;
  return Object.values(asRecord(siteRoles)).some(
    (rolesForSite) =>
      Array.isArray(rolesForSite) && rolesForSite.includes("super_admin")
  );
};

export const getAuditJournalRowsHandler = async ({
  requesterUid,
  data,
  auth = getAuth(),
  reader = auditJournalReader,
}: {
  requesterUid: string;
  data: unknown;
  auth?: AuthReader;
  reader?: AuditJournalReader;
}): Promise<AuditJournalQueryResult> => {
  const requester = await auth.getUser(requesterUid);
  const customClaims = asRecord(requester.customClaims);

  if (!hasSuperAdminClaim(customClaims)) {
    throw new HttpsError(
      "permission-denied",
      "You do not have permission to read the audit journal"
    );
  }

  return reader.query(normalizeAuditJournalQueryParams(data));
};

export const getAuditJournalRows = onCall(
  { memory: "512MiB", timeoutSeconds: 60 },
  async (request): Promise<AuditJournalQueryResult> => {
    const requesterUid = request.auth?.uid;
    if (!requesterUid) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    return getAuditJournalRowsHandler({
      requesterUid,
      data: request.data,
    });
  }
);
