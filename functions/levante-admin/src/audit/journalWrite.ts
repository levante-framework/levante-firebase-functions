import { createHash } from "crypto";
import { logger } from "firebase-functions/v2";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import {
  BigQueryJournalWriter,
  getMetadataAccessToken,
  getProjectId,
} from "./bigqueryClient.js";
import { redactJournalPayload } from "./redact.js";
import {
  AUDIT_DLQ_TOPIC,
  MAX_JOURNAL_PAYLOAD_BYTES,
  type AuditDocumentSnapshot,
  type AuditFirestoreEvent,
  type AuditMeta,
  type DeadLetterMessage,
  type DeadLetterPublisher,
  type JournalOperation,
  type JournalRow,
  type JournalWriter,
} from "./types.js";

type HandlerDependencies = {
  journalWriter: JournalWriter;
  deadLetterPublisher: DeadLetterPublisher;
  logger: {
    error(message: string, data?: Record<string, unknown>): void;
  };
};

type FetchLike = typeof fetch;
type TokenProvider = () => Promise<string>;

class PubSubDeadLetterPublisher implements DeadLetterPublisher {
  private readonly fetchImpl: FetchLike;
  private readonly getAccessToken: TokenProvider;
  private readonly projectId?: string;

  constructor({
    fetchImpl = fetch,
    getAccessToken = () => getMetadataAccessToken(fetchImpl),
    projectId,
  }: {
    fetchImpl?: FetchLike;
    getAccessToken?: TokenProvider;
    projectId?: string;
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.getAccessToken = getAccessToken;
    this.projectId = projectId;
  }

  async publish(message: DeadLetterMessage): Promise<void> {
    const accessToken = await this.getAccessToken();
    const projectId = this.projectId ?? getProjectId();
    const url = new URL(
      `https://pubsub.googleapis.com/v1/projects/${projectId}/topics/${AUDIT_DLQ_TOPIC}:publish`
    );
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messages: [
          {
            data: Buffer.from(JSON.stringify(message)).toString("base64"),
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Pub/Sub DLQ publish failed with ${
          response.status
        }: ${await response.text()}`
      );
    }
  }
}

const journalWriter = new BigQueryJournalWriter();
const deadLetterPublisher = new PubSubDeadLetterPublisher();

export const classifyOperation = (
  before: AuditDocumentSnapshot,
  after: AuditDocumentSnapshot
): JournalOperation => {
  if (!before.exists && after.exists) return "create";
  if (before.exists && !after.exists) return "delete";
  return "update";
};

const valueToString = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

export const extractAuditMeta = (
  beforeData: Record<string, unknown> | null,
  afterData: Record<string, unknown> | null
): AuditMeta => {
  const afterAudit = (afterData?._audit ?? null) as Record<
    string,
    unknown
  > | null;
  const beforeAudit = (beforeData?._audit ?? null) as Record<
    string,
    unknown
  > | null;

  return {
    actor:
      valueToString(afterAudit?.actor) ?? valueToString(beforeAudit?.actor),
    request_id:
      valueToString(afterAudit?.request_id) ??
      valueToString(beforeAudit?.request_id),
  };
};

const normalizeForJson = (value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (value instanceof Date) return value.toISOString();
  if (typeof (value as { toDate?: unknown })?.toDate === "function") {
    try {
      return (value as { toDate: () => Date }).toDate().toISOString();
    } catch {
      return value;
    }
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nestedValue]) => [key, normalizeForJson(nestedValue)])
    );
  }
  return value;
};

export const stableJsonStringify = (value: unknown): string =>
  JSON.stringify(normalizeForJson(value));

const byteLength = (value: string | null): number =>
  value ? Buffer.byteLength(value, "utf8") : 0;

const snapshotData = (
  snapshot: AuditDocumentSnapshot
): Record<string, unknown> | null =>
  snapshot.exists ? redactJournalPayload(snapshot.data() ?? {}) : null;

export const buildJournalRow = (event: AuditFirestoreEvent): JournalRow => {
  if (!event.data) {
    throw new Error("Firestore event did not include document change data");
  }

  const { before, after } = event.data;
  const beforeData = snapshotData(before);
  const afterData = snapshotData(after);
  const beforeJson = beforeData ? stableJsonStringify(beforeData) : null;
  const afterJson = afterData ? stableJsonStringify(afterData) : null;
  const payloadBytes = byteLength(afterJson ?? beforeJson);
  const payloadMaterial = stableJsonStringify({
    before: beforeJson,
    after: afterJson,
  });
  const payloadTruncated = payloadBytes > MAX_JOURNAL_PAYLOAD_BYTES;
  const auditMeta = extractAuditMeta(beforeData, afterData);

  return {
    event_id: event.id,
    commit_timestamp: new Date(event.time ?? Date.now()).toISOString(),
    ingest_timestamp: new Date().toISOString(),
    resource_path: getResourcePath(event),
    operation: classifyOperation(before, after),
    actor: auditMeta.actor,
    request_id: auditMeta.request_id,
    before_json: payloadTruncated ? null : beforeJson,
    after_json: payloadTruncated ? null : afterJson,
    payload_bytes: payloadBytes,
    payload_truncated: payloadTruncated,
    payload_sha256: payloadTruncated
      ? createHash("sha256").update(payloadMaterial).digest("hex")
      : null,
  };
};

const getResourcePath = (event: AuditFirestoreEvent): string =>
  event.document ?? event.params?.document ?? "unknown";

const rawEventForDlq = (event: AuditFirestoreEvent): unknown => ({
  id: event.id,
  time: event.time,
  document: event.document,
  params: event.params,
  before: event.data?.before.exists
    ? normalizeForJson(event.data.before.data() ?? {})
    : null,
  after: event.data?.after.exists
    ? normalizeForJson(event.data.after.data() ?? {})
    : null,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const handleJournalWrite = async (
  event: AuditFirestoreEvent,
  dependencies: HandlerDependencies
): Promise<void> => {
  const resourcePath = getResourcePath(event);

  try {
    const row = buildJournalRow(event);
    await dependencies.journalWriter.insert(row);
  } catch (error) {
    const message = errorMessage(error);

    dependencies.logger.error("Firestore audit journal write failed", {
      component: "audit.journalWrite",
      event_id: event.id,
      resource_path: resourcePath,
      error_message: message,
      project_id: process.env.GCLOUD_PROJECT ?? null,
    });

    try {
      await dependencies.deadLetterPublisher.publish({
        event_id: event.id,
        resource_path: resourcePath,
        error_message: message,
        raw_event: rawEventForDlq(event),
      });
    } catch (dlqError) {
      dependencies.logger.error("Firestore audit journal DLQ publish failed", {
        component: "audit.journalWrite",
        event_id: event.id,
        resource_path: resourcePath,
        error_message: errorMessage(dlqError),
        project_id: process.env.GCLOUD_PROJECT ?? null,
      });
    }
  }
};

export const journalWrite = onDocumentWritten(
  {
    database: "(default)",
    document: "{document=**}",
    memory: "512MiB",
    retry: false,
  },
  async (event) => {
    await handleJournalWrite(event as AuditFirestoreEvent, {
      journalWriter,
      deadLetterPublisher,
      logger,
    });
  }
);
