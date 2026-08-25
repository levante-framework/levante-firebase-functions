export const AUDIT_DATASET = "levante_audit";
export const AUDIT_WRITES_TABLE = "writes_journal";
export const AUDIT_DLQ_TOPIC = "levante-audit-journal-dlq";
export const MAX_JOURNAL_PAYLOAD_BYTES = 256 * 1024;

export type JournalOperation = "create" | "update" | "delete";

export type AuditMeta = {
  actor: string | null;
  request_id: string | null;
};

export type JournalRow = {
  event_id: string;
  commit_timestamp: string;
  ingest_timestamp: string;
  resource_path: string;
  operation: JournalOperation;
  actor: string | null;
  request_id: string | null;
  before_json: string | null;
  after_json: string | null;
  payload_bytes: number;
  payload_truncated: boolean;
  payload_sha256: string | null;
};

export type AuditJournalQueryParams = {
  startTime?: string;
  endTime?: string;
  resourcePath?: string;
  resourcePathPrefix?: string;
  operation?: JournalOperation;
  actor?: string;
  requestId?: string;
  payloadTruncated?: boolean;
  includePayloads?: boolean;
  limit?: number;
  pageToken?: string;
};

export type AuditJournalQueryResult = {
  rows: JournalRow[];
  nextPageToken?: string;
};

export type AuditJournalReader = {
  query(
    params: RequiredAuditJournalQueryParams
  ): Promise<AuditJournalQueryResult>;
};

export type RequiredAuditJournalQueryParams = {
  startTime: string;
  endTime: string;
  resourcePath: string | null;
  resourcePathPrefix: string | null;
  operation: JournalOperation | null;
  actor: string | null;
  requestId: string | null;
  payloadTruncated: boolean | null;
  includePayloads: boolean;
  limit: number;
  pageToken: string | null;
};

export type DeadLetterMessage = {
  event_id: string;
  resource_path: string;
  error_message: string;
  raw_event: unknown;
};

export type JournalWriter = {
  insert(row: JournalRow): Promise<void>;
};

export type DeadLetterPublisher = {
  publish(message: DeadLetterMessage): Promise<void>;
};

export type AuditLogger = {
  error(message: string, data?: Record<string, unknown>): void;
};

export type AuditDocumentSnapshot = {
  exists: boolean;
  data(): Record<string, unknown> | undefined;
};

export type AuditDocumentChange = {
  before: AuditDocumentSnapshot;
  after: AuditDocumentSnapshot;
};

export type AuditFirestoreEvent = {
  id: string;
  time?: string;
  document?: string;
  data?: AuditDocumentChange;
  params?: Record<string, string>;
};
