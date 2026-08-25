import { beforeEach, describe, expect, it, vi } from "vitest";
import { adminDb, clearFirestore } from "../app";
import { handleJournalWrite } from "../../../functions/levante-admin/src/audit/journalWrite.js";
import type {
  AuditFirestoreEvent,
  AuditDocumentSnapshot,
  DeadLetterMessage,
  JournalRow,
} from "../../../functions/levante-admin/src/audit/types.js";

const asAuditSnapshot = (
  snapshot: FirebaseFirestore.DocumentSnapshot
): AuditDocumentSnapshot => snapshot as unknown as AuditDocumentSnapshot;

const eventFor = (
  id: string,
  before: FirebaseFirestore.DocumentSnapshot,
  after: FirebaseFirestore.DocumentSnapshot
): AuditFirestoreEvent => ({
  id,
  time: "2026-08-14T12:00:00.000Z",
  document: "users/test-user",
  data: {
    before: asAuditSnapshot(before),
    after: asAuditSnapshot(after),
  },
});

describe("journalWrite emulator-backed snapshots", () => {
  beforeEach(async () => {
    await clearFirestore();
  });

  it("builds expected rows for create, update, and delete snapshots", async () => {
    const rows: JournalRow[] = [];
    const publish = vi.fn<(_: DeadLetterMessage) => Promise<void>>();
    const dependencies = {
      journalWriter: {
        insert: async (row: JournalRow) => {
          rows.push(row);
        },
      },
      deadLetterPublisher: { publish },
      logger: { error: vi.fn() },
    };
    const ref = adminDb.doc("users/test-user");

    const beforeCreate = await ref.get();
    await ref.set({
      displayName: "Test User",
      _audit: { actor: "tester", request_id: "request-create" },
    });
    const afterCreate = await ref.get();
    await handleJournalWrite(
      eventFor("event-create", beforeCreate, afterCreate),
      dependencies
    );

    const beforeUpdate = await ref.get();
    await ref.update({
      displayName: "Updated Test User",
      _audit: { actor: "tester", request_id: "request-update" },
    });
    const afterUpdate = await ref.get();
    await handleJournalWrite(
      eventFor("event-update", beforeUpdate, afterUpdate),
      dependencies
    );

    const beforeDelete = await ref.get();
    await ref.delete();
    const afterDelete = await ref.get();
    await handleJournalWrite(
      eventFor("event-delete", beforeDelete, afterDelete),
      dependencies
    );

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.operation)).toEqual([
      "create",
      "update",
      "delete",
    ]);
    expect(rows.map((row) => row.resource_path)).toEqual([
      "users/test-user",
      "users/test-user",
      "users/test-user",
    ]);
    expect(rows.map((row) => row.request_id)).toEqual([
      "request-create",
      "request-update",
      "request-update",
    ]);
    expect(rows[0].before_json).toBeNull();
    expect(JSON.parse(rows[0].after_json ?? "{}")).toMatchObject({
      displayName: "Test User",
    });
    expect(rows[2].after_json).toBeNull();
    expect(JSON.parse(rows[2].before_json ?? "{}")).toMatchObject({
      displayName: "Updated Test User",
    });
    expect(publish).not.toHaveBeenCalled();
  });
});
