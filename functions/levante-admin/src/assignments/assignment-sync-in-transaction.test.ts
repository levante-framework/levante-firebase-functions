import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { Transaction } from "firebase-admin/firestore";

class FieldPath {
  segments: string[];
  constructor(...segments: string[]) {
    this.segments = segments;
  }
}

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: vi.fn(),
  FieldPath,
  FieldValue: {
    arrayUnion: vi.fn((v: string) => ({ __arrayUnion: v })),
    arrayRemove: vi.fn((v: string) => ({ __arrayRemove: v })),
    delete: vi.fn(() => ({ __delete: true })),
  },
}));

const {
  syncOnAssignmentCreated,
  syncOnAssignmentDeleted,
  syncOnAssignmentUpdated,
} = await import("./assignment-sync-in-transaction.js");

// Fake db/transaction/statsBuffer. The user ref is tagged with its path so
// transaction.update calls can be checked, and recordIncrements is a spy.
function setup() {
  const db = {
    collection: vi.fn(() => ({
      doc: vi.fn((uid: string) => ({ path: `users/${uid}`, id: uid })),
    })),
  } as never;
  const transaction = { update: vi.fn() } as unknown as Transaction;
  const statsBuffer = { recordIncrements: vi.fn(), flush: vi.fn() };
  return { db, transaction, statsBuffer };
}

const segmentsOf = (fp: unknown) => (fp as FieldPath).segments;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncOnAssignmentCreated", () => {
  it("stamps the assigned date/list on the user doc and increments assigned stats", async () => {
    const { db, transaction, statsBuffer } = setup();
    const dateAssigned = new Date("2026-01-02T03:04:05Z");

    await syncOnAssignmentCreated(
      db,
      transaction,
      "user1",
      "admin1",
      {
        assigningOrgs: { districts: ["site1"], schools: [] },
        assessments: [{ taskId: "taskA" }, { taskId: "taskB" }],
        dateAssigned,
      },
      statsBuffer
    );

    const update = transaction.update as unknown as Mock;
    expect(update).toHaveBeenCalledTimes(1);
    const args = update.mock.calls[0];
    expect(args[0]).toEqual({ path: "users/user1", id: "user1" });
    expect(segmentsOf(args[1])).toEqual(["assignmentsAssigned", "admin1"]);
    expect(args[2]).toBe(dateAssigned);
    expect(segmentsOf(args[3])).toEqual(["assignments", "assigned"]);
    expect(args[4]).toEqual({ __arrayUnion: "admin1" });

    expect(statsBuffer.recordIncrements).toHaveBeenCalledTimes(1);
    expect(statsBuffer.recordIncrements).toHaveBeenCalledWith(
      ["site1", "total"],
      "assigned",
      ["taskA", "taskB"],
      1,
      true
    );
  });

  it("defaults the assigned date to now when none is provided", async () => {
    const { db, transaction, statsBuffer } = setup();

    await syncOnAssignmentCreated(
      db,
      transaction,
      "user1",
      "admin1",
      { assigningOrgs: { districts: ["site1"] }, assessments: [] },
      statsBuffer
    );

    const args = (transaction.update as unknown as Mock).mock.calls[0];
    expect(args[2]).toBeInstanceOf(Date);
  });
});

describe("syncOnAssignmentDeleted", () => {
  it("removes the user doc fields and decrements assigned/started/completed stats", async () => {
    const { db, transaction, statsBuffer } = setup();

    await syncOnAssignmentDeleted(
      db,
      transaction,
      "user1",
      "admin1",
      {
        assigningOrgs: { districts: ["site1"] },
        assessments: [
          { taskId: "taskA", startedOn: new Date(), completedOn: new Date() },
          { taskId: "taskB" },
        ],
        completed: true,
      },
      statsBuffer
    );

    const record = statsBuffer.recordIncrements;
    expect(record).toHaveBeenCalledWith(
      ["site1", "total"],
      "assigned",
      ["taskA", "taskB"],
      -1,
      true
    );
    expect(record).toHaveBeenCalledWith(
      ["site1", "total"],
      "started",
      ["taskA"],
      -1,
      true
    );
    expect(record).toHaveBeenCalledWith(
      ["site1", "total"],
      "completed",
      ["taskA"],
      -1,
      true
    );

    const update = transaction.update as unknown as Mock;
    expect(update).toHaveBeenCalledTimes(1);
    const args = update.mock.calls[0];
    expect(segmentsOf(args[1])).toEqual(["assignmentsAssigned", "admin1"]);
    expect(args[2]).toEqual({ __delete: true });
    expect(segmentsOf(args[3])).toEqual(["assignmentsStarted", "admin1"]);
    expect(segmentsOf(args[5])).toEqual(["assignmentsCompleted", "admin1"]);
    expect(segmentsOf(args[7])).toEqual(["assignments", "assigned"]);
    expect(args[8]).toEqual({ __arrayRemove: "admin1" });
    expect(segmentsOf(args[9])).toEqual(["assignments", "started"]);
    expect(segmentsOf(args[11])).toEqual(["assignments", "completed"]);
  });

  it("only decrements assigned stats when nothing was started or completed", async () => {
    const { db, transaction, statsBuffer } = setup();

    await syncOnAssignmentDeleted(
      db,
      transaction,
      "user1",
      "admin1",
      {
        assigningOrgs: { districts: ["site1"] },
        assessments: [{ taskId: "taskA" }],
      },
      statsBuffer
    );

    expect(statsBuffer.recordIncrements).toHaveBeenCalledTimes(1);
    expect(statsBuffer.recordIncrements).toHaveBeenCalledWith(
      ["site1", "total"],
      "assigned",
      ["taskA"],
      -1,
      true
    );
  });
});

describe("syncOnAssignmentUpdated", () => {
  it("records a newly started task and stamps the started date on the user doc", async () => {
    const { db, transaction, statsBuffer } = setup();

    await syncOnAssignmentUpdated(
      db,
      transaction,
      "user1",
      "admin1",
      {
        assigningOrgs: { districts: ["site1"] },
        assessments: [{ taskId: "taskA" }],
        started: false,
      },
      {
        assigningOrgs: { districts: ["site1"] },
        assessments: [{ taskId: "taskA", startedOn: new Date() }],
        started: true,
      },
      statsBuffer
    );

    expect(statsBuffer.recordIncrements).toHaveBeenCalledTimes(1);
    expect(statsBuffer.recordIncrements).toHaveBeenCalledWith(
      ["site1", "total"],
      "started",
      ["taskA"],
      1,
      true
    );

    const update = transaction.update as unknown as Mock;
    expect(update).toHaveBeenCalledTimes(1);
    const args = update.mock.calls[0];
    expect(segmentsOf(args[1])).toEqual(["assignmentsStarted", "admin1"]);
    expect(args[2]).toBeInstanceOf(Date);
    expect(segmentsOf(args[3])).toEqual(["assignments", "started"]);
    expect(args[4]).toEqual({ __arrayUnion: "admin1" });
  });

  it("moves assigned stats from a removed org to an added org when orgs change", async () => {
    const { db, transaction, statsBuffer } = setup();

    await syncOnAssignmentUpdated(
      db,
      transaction,
      "user1",
      "admin1",
      {
        assigningOrgs: { districts: ["site1"] },
        assessments: [{ taskId: "taskA" }],
      },
      {
        assigningOrgs: { districts: ["site2"] },
        assessments: [{ taskId: "taskA" }],
      },
      statsBuffer
    );

    expect(statsBuffer.recordIncrements).toHaveBeenCalledWith(
      ["site1"],
      "assigned",
      ["taskA"],
      -1,
      true
    );
    expect(statsBuffer.recordIncrements).toHaveBeenCalledWith(
      ["site2"],
      "assigned",
      ["taskA"],
      1,
      true
    );
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it("increments per-task assigned stats when a task is added to a kept assignment", async () => {
    const { db, transaction, statsBuffer } = setup();

    await syncOnAssignmentUpdated(
      db,
      transaction,
      "user1",
      "admin1",
      {
        assigningOrgs: { districts: ["site1"] },
        assessments: [{ taskId: "taskA" }],
      },
      {
        assigningOrgs: { districts: ["site1"] },
        assessments: [{ taskId: "taskA" }, { taskId: "taskB" }],
      },
      statsBuffer
    );

    // Orgs are unchanged, so only the newly-added task's assigned count moves,
    // and the assignment-level total is left alone (updateAssignmentTotal false).
    expect(statsBuffer.recordIncrements).toHaveBeenCalledTimes(1);
    expect(statsBuffer.recordIncrements).toHaveBeenCalledWith(
      ["site1", "total"],
      "assigned",
      ["taskB"],
      1,
      false
    );
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it("decrements per-task assigned stats when a task is dropped from a kept assignment", async () => {
    const { db, transaction, statsBuffer } = setup();

    await syncOnAssignmentUpdated(
      db,
      transaction,
      "user1",
      "admin1",
      {
        assigningOrgs: { districts: ["site1"] },
        assessments: [{ taskId: "taskA" }, { taskId: "taskB" }],
      },
      {
        assigningOrgs: { districts: ["site1"] },
        assessments: [{ taskId: "taskA" }],
      },
      statsBuffer
    );

    expect(statsBuffer.recordIncrements).toHaveBeenCalledTimes(1);
    expect(statsBuffer.recordIncrements).toHaveBeenCalledWith(
      ["site1", "total"],
      "assigned",
      ["taskB"],
      -1,
      false
    );
    expect(transaction.update).not.toHaveBeenCalled();
  });
});
