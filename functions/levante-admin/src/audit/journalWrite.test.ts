import { describe, expect, it, vi } from "vitest";
import {
  buildJournalRow,
  classifyOperation,
  extractAuditMeta,
  handleJournalWrite,
} from "./journalWrite.js";
import {
  MAX_JOURNAL_PAYLOAD_BYTES,
  type AuditDocumentSnapshot,
  type AuditFirestoreEvent,
  type DeadLetterMessage,
  type JournalRow,
} from "./types.js";

const snapshot = (
  exists: boolean,
  data?: Record<string, unknown>
): AuditDocumentSnapshot => ({
  exists,
  data: () => data,
});

const eventFor = (
  before: AuditDocumentSnapshot,
  after: AuditDocumentSnapshot,
  overrides: Partial<AuditFirestoreEvent> = {}
): AuditFirestoreEvent => ({
  id: "event-1",
  time: "2026-08-14T12:00:00.000Z",
  document: "users/test-user",
  data: { before, after },
  ...overrides,
});

describe("journalWrite helpers", () => {
  it("classifies create, update, and delete events", () => {
    expect(classifyOperation(snapshot(false), snapshot(true, {}))).toBe(
      "create"
    );
    expect(classifyOperation(snapshot(true, {}), snapshot(true, {}))).toBe(
      "update"
    );
    expect(classifyOperation(snapshot(true, {}), snapshot(false))).toBe(
      "delete"
    );
  });

  it("extracts actor and request_id from after data first", () => {
    expect(
      extractAuditMeta(
        { _audit: { actor: "before-actor", request_id: "before-request" } },
        { _audit: { actor: "after-actor", request_id: "after-request" } }
      )
    ).toEqual({ actor: "after-actor", request_id: "after-request" });
  });

  it("falls back to before audit metadata for deletes", () => {
    expect(
      extractAuditMeta(
        { _audit: { actor: "before-actor", request_id: "before-request" } },
        null
      )
    ).toEqual({ actor: "before-actor", request_id: "before-request" });
  });

  it("builds a row for an update event", () => {
    const row = buildJournalRow(
      eventFor(
        snapshot(true, { status: "before" }),
        snapshot(true, {
          status: "after",
          _audit: { actor: "user-1", request_id: "request-1" },
        })
      )
    );

    expect(row).toMatchObject({
      event_id: "event-1",
      commit_timestamp: "2026-08-14T12:00:00.000Z",
      resource_path: "users/test-user",
      operation: "update",
      actor: "user-1",
      request_id: "request-1",
      payload_truncated: false,
      payload_sha256: null,
    });
    expect(JSON.parse(row.after_json ?? "{}")).toEqual({
      _audit: { actor: "user-1", request_id: "request-1" },
      status: "after",
    });
  });

  it("truncates payloads over 256 KiB and sets a stable hash", () => {
    const largePayload = "x".repeat(MAX_JOURNAL_PAYLOAD_BYTES + 1);
    const event = eventFor(snapshot(false), snapshot(true, { largePayload }), {
      id: "large-event",
    });
    const firstRow = buildJournalRow(event);
    const secondRow = buildJournalRow(event);

    expect(firstRow.payload_truncated).toBe(true);
    expect(firstRow.before_json).toBeNull();
    expect(firstRow.after_json).toBeNull();
    expect(firstRow.payload_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(firstRow.payload_sha256).toBe(secondRow.payload_sha256);
    expect(firstRow.payload_bytes).toBeGreaterThan(MAX_JOURNAL_PAYLOAD_BYTES);
  });

  it("publishes to the DLQ and does not throw when BigQuery insert fails", async () => {
    const insert = vi
      .fn<(_: JournalRow) => Promise<void>>()
      .mockRejectedValue(new Error("insert failed"));
    const publish = vi
      .fn<(_: DeadLetterMessage) => Promise<void>>()
      .mockResolvedValue(undefined);
    const logError = vi.fn();

    await expect(
      handleJournalWrite(
        eventFor(snapshot(false), snapshot(true, { ok: true })),
        {
          journalWriter: { insert },
          deadLetterPublisher: { publish },
          logger: { error: logError },
        }
      )
    ).resolves.toBeUndefined();

    expect(insert).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: "event-1",
        resource_path: "users/test-user",
        error_message: "insert failed",
      })
    );
    expect(logError).toHaveBeenCalledWith(
      "Firestore audit journal write failed",
      expect.objectContaining({
        component: "audit.journalWrite",
        event_id: "event-1",
      })
    );
  });
});
