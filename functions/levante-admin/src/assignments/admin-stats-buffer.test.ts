import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { Transaction } from "firebase-admin/firestore";

vi.mock("firebase-admin/firestore", () => ({
  FieldValue: {
    increment: vi.fn((n: number) => ({ __increment: n })),
    serverTimestamp: vi.fn(() => "SERVER_TS"),
  },
}));

vi.mock("firebase-functions/v2", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const { createAdminStatsBuffer, AdminStatsBufferRegistry } = await import(
  "./admin-stats-buffer.js"
);

type FakeDocRef = { id: string; path: string };

// A fake stats subcollection whose doc() returns a ref tagged with the org id,
// so tests can match transaction.set calls back to the org they wrote.
const makeStatsCollection = () => ({
  doc: vi.fn((org: string): FakeDocRef => ({ id: org, path: `stats/${org}` })),
});

const makeTransaction = () => ({ set: vi.fn() } as unknown as Transaction);

// Returns the data object written for a given org, or undefined if not written.
function writtenFor(set: Mock, orgId: string) {
  const call = set.mock.calls.find((c) => c[0].id === orgId);
  return call?.[1] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createAdminStatsBuffer", () => {
  it("writes merged increments per org for the assignment total and each task", () => {
    const buffer = createAdminStatsBuffer(makeStatsCollection() as never);
    buffer.recordIncrements(["site1", "total"], "assigned", ["taskA"], 1, true);

    const tx = makeTransaction();
    buffer.flush(tx);

    const set = tx.set as unknown as Mock;
    expect(set).toHaveBeenCalledTimes(2);

    const site1 = writtenFor(set, "site1")!;
    expect(site1.assignment).toEqual({ assigned: { __increment: 1 } });
    expect(site1.taskA).toEqual({ assigned: { __increment: 1 } });
    expect(site1.updatedAt).toBe("SERVER_TS");

    const site1Call = set.mock.calls.find((c) => c[0].id === "site1")!;
    expect(site1Call[2]).toEqual({ merge: true });
    expect(writtenFor(set, "total")).toBeDefined();
  });

  it("accumulates repeated increments for the same org, status, and task", () => {
    const buffer = createAdminStatsBuffer(makeStatsCollection() as never);
    buffer.recordIncrements(["site1"], "started", ["taskA"], 1, true);
    buffer.recordIncrements(["site1"], "started", ["taskA"], 2, true);

    const tx = makeTransaction();
    buffer.flush(tx);

    const site1 = writtenFor(tx.set as unknown as Mock, "site1")!;
    expect(site1.assignment).toEqual({ started: { __increment: 3 } });
    expect(site1.taskA).toEqual({ started: { __increment: 3 } });
  });

  it("skips orgs whose net increment is zero", () => {
    const buffer = createAdminStatsBuffer(makeStatsCollection() as never);
    buffer.recordIncrements(["site1"], "assigned", [], 1, true);
    buffer.recordIncrements(["site1"], "assigned", [], -1, true);

    const tx = makeTransaction();
    buffer.flush(tx);

    expect(tx.set).not.toHaveBeenCalled();
  });

  it("omits the assignment total when updateAssignmentTotal is false", () => {
    const buffer = createAdminStatsBuffer(makeStatsCollection() as never);
    buffer.recordIncrements(["site1"], "assigned", ["taskA"], 1, false);

    const tx = makeTransaction();
    buffer.flush(tx);

    const site1 = writtenFor(tx.set as unknown as Mock, "site1")!;
    expect(site1.assignment).toBeUndefined();
    expect(site1.taskA).toEqual({ assigned: { __increment: 1 } });
  });
});

describe("AdminStatsBufferRegistry", () => {
  const makeDb = () => {
    const statsCollection = makeStatsCollection();
    const adminDoc = { collection: vi.fn(() => statsCollection) };
    const adminsCollection = { doc: vi.fn(() => adminDoc) };
    const db = { collection: vi.fn(() => adminsCollection) };
    return { db, adminsCollection, adminDoc, statsCollection };
  };

  it("memoizes one buffer per administration and targets its stats subcollection", () => {
    const { db, adminsCollection, adminDoc } = makeDb();
    const registry = new AdminStatsBufferRegistry(db as never);

    const first = registry.forAdministration("A1");
    const second = registry.forAdministration("A1");

    expect(first).toBe(second);
    expect(db.collection).toHaveBeenCalledTimes(1);
    expect(db.collection).toHaveBeenCalledWith("administrations");
    expect(adminsCollection.doc).toHaveBeenCalledWith("A1");
    expect(adminDoc.collection).toHaveBeenCalledWith("stats");

    expect(registry.forAdministration("A2")).not.toBe(first);
  });

  it("flushes every administration buffer", () => {
    const { db, statsCollection } = makeDb();
    const registry = new AdminStatsBufferRegistry(db as never);

    registry
      .forAdministration("A1")
      .recordIncrements(["site1"], "assigned", [], 1, true);

    const tx = makeTransaction();
    registry.flush(tx);

    expect(statsCollection.doc).toHaveBeenCalledWith("site1");
    expect(tx.set).toHaveBeenCalledTimes(1);
  });
});
