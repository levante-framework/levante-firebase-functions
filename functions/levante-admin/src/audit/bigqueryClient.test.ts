import { describe, expect, it, vi } from "vitest";
import { BigQueryJournalWriter } from "./bigqueryClient.js";
import { AUDIT_DATASET, AUDIT_WRITES_TABLE, type JournalRow } from "./types.js";

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
