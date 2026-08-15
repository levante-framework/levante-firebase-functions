import { describe, expect, it, vi } from "vitest";
import {
  BigQueryAuditJournalReader,
  BigQueryJournalWriter,
  buildAuditJournalQuery,
} from "./bigqueryClient.js";
import {
  AUDIT_DATASET,
  AUDIT_WRITES_TABLE,
  type JournalRow,
  type RequiredAuditJournalQueryParams,
} from "./types.js";

const row: JournalRow = {
  event_id: "event-1",
  commit_timestamp: "2026-08-14T12:00:00.000Z",
  ingest_timestamp: "2026-08-14T12:00:01.000Z",
  resource_path: "users/test-user",
  operation: "create",
  actor: "user-1",
  request_id: "request-1",
  before_json: null,
  after_json: '{"ok":true}',
  payload_bytes: 11,
  payload_truncated: false,
  payload_sha256: null,
};

const queryParams: RequiredAuditJournalQueryParams = {
  startTime: "2026-08-14T00:00:00.000Z",
  endTime: "2026-08-15T00:00:00.000Z",
  resourcePath: null,
  resourcePathPrefix: "users/",
  operation: "update",
  actor: "admin-user",
  requestId: null,
  payloadTruncated: false,
  includePayloads: false,
  limit: 25,
  pageToken: null,
};

describe("BigQueryJournalWriter", () => {
  it("streams rows with event_id as the insertId", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
    } as Response);

    await new BigQueryJournalWriter({
      fetchImpl,
      getAccessToken: async () => "token-1",
      projectId: "test-project",
    }).insert(row);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe(
      `https://bigquery.googleapis.com/bigquery/v2/projects/test-project/datasets/${AUDIT_DATASET}/tables/${AUDIT_WRITES_TABLE}/insertAll`
    );
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer token-1",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      rows: [{ insertId: "event-1", json: row }],
    });
  });
});

describe("BigQueryAuditJournalReader", () => {
  it("builds a bounded parameterized audit query", () => {
    const { query, queryParameters } = buildAuditJournalQuery(
      "test-project",
      queryParams
    );

    expect(query).toContain("`test-project.levante_audit.writes_journal`");
    expect(query).toContain("STARTS_WITH(resource_path, @resourcePathPrefix)");
    expect(query).toContain("operation = @operation");
    expect(query).toContain("payload_truncated = @payloadTruncated");
    expect(query).toContain("CAST(NULL AS STRING) AS before_json");
    expect(query).toContain("LIMIT @limit");
    expect(queryParameters).toEqual(
      expect.arrayContaining([
        {
          name: "resourcePathPrefix",
          parameterType: { type: "STRING" },
          parameterValue: { value: "users/" },
        },
        {
          name: "payloadTruncated",
          parameterType: { type: "BOOL" },
          parameterValue: { value: "false" },
        },
      ])
    );
  });

  it("executes the query and maps rows", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue({
      ok: true,
      json: async () => ({
        jobComplete: true,
        pageToken: "next-page",
        schema: {
          fields: [
            { name: "event_id" },
            { name: "commit_timestamp" },
            { name: "ingest_timestamp" },
            { name: "resource_path" },
            { name: "operation" },
            { name: "actor" },
            { name: "request_id" },
            { name: "before_json" },
            { name: "after_json" },
            { name: "payload_bytes" },
            { name: "payload_truncated" },
            { name: "payload_sha256" },
          ],
        },
        rows: [
          {
            f: [
              { v: "event-1" },
              { v: "2026-08-14T00:00:00Z" },
              { v: "2026-08-14T00:00:01Z" },
              { v: "users/test-user" },
              { v: "update" },
              { v: "admin-user" },
              { v: "request-1" },
              { v: null },
              { v: '{"ok":true}' },
              { v: "11" },
              { v: "false" },
              { v: null },
            ],
          },
        ],
      }),
    } as Response);

    const result = await new BigQueryAuditJournalReader({
      fetchImpl,
      getAccessToken: async () => "token-1",
      projectId: "test-project",
    }).query({ ...queryParams, pageToken: "page-1" });

    expect(result).toEqual({
      nextPageToken: "next-page",
      rows: [
        {
          event_id: "event-1",
          commit_timestamp: "2026-08-14T00:00:00Z",
          ingest_timestamp: "2026-08-14T00:00:01Z",
          operation: "update",
          resource_path: "users/test-user",
          actor: "admin-user",
          request_id: "request-1",
          before_json: null,
          after_json: '{"ok":true}',
          payload_bytes: 11,
          payload_truncated: false,
          payload_sha256: null,
        },
      ],
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(String(init?.body))).toMatchObject({
      useLegacySql: false,
      parameterMode: "NAMED",
      maxResults: 25,
      pageToken: "page-1",
    });
  });
});
