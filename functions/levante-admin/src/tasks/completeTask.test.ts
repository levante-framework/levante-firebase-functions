import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, transaction } = vi.hoisted(() => {
  const node = (path: string) => ({
    path,
    collection: (name: string) => node(`${path}/${name}`),
    doc: (id: string) => node(`${path}/${id}`),
    where: () => ({ kind: "query" as const, path }),
  });
  const transaction = {
    get: vi.fn(),
    update: vi.fn(),
    set: vi.fn(),
  };
  const db = {
    collection: (name: string) => node(name),
    runTransaction: (fn: (tx: typeof transaction) => Promise<unknown>) =>
      fn(transaction),
  };
  return { db, transaction };
});

vi.mock("firebase-admin/firestore", async () => {
  const actual = await vi.importActual<
    typeof import("firebase-admin/firestore")
  >("firebase-admin/firestore");
  return { ...actual, getFirestore: () => db };
});

const { completeTask } = await import("./completeTask.js");

const snap = (data: unknown) => ({
  exists: true,
  data: () => data,
});

const segmentsOf = (fieldPath: { segments: string[] }) => fieldPath.segments;

const runsSnapshot = (runs: Array<{ timeStarted?: Date }>) => ({
  empty: runs.length === 0,
  docs: runs.map((run) => ({ data: () => run })),
});

function installReads(
  assignment: Record<string, unknown>,
  runs?: Array<{ timeStarted?: Date }>
) {
  transaction.get.mockImplementation(
    async (ref: { path: string; kind?: string }) => {
      if (ref.kind === "query") {
        if (!runs) throw new Error("runs should not be read");
        return runsSnapshot(runs);
      }
      if (ref.path === "users/user1/assignments/admin1")
        return snap(assignment);
      throw new Error(`unexpected read ${ref.path}`);
    }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("completeTask", () => {
  it("stamps started and completed on the user doc when the assignment finishes", async () => {
    installReads(
      {
        assessments: [{ taskId: "egma-math" }],
        assigningOrgs: { districts: ["site1"] },
        started: false,
        completed: false,
      },
      [{ timeStarted: new Date("2026-01-01T00:00:00Z") }]
    );

    const result = await completeTask.run({
      auth: { uid: "user1" },
      data: {
        administrationId: "admin1",
        taskId: "egma-math",
        userId: "user1",
      },
    } as never);

    expect(result).toEqual({
      success: true,
      message: "Task completed successfully",
    });
    const userUpdate = transaction.update.mock.calls.find(
      (call) => call[0].path === "users/user1"
    );
    expect(segmentsOf(userUpdate[1])).toEqual(["assignmentsStarted", "admin1"]);
    expect(segmentsOf(userUpdate[3])).toEqual(["assignments", "started"]);
    expect(segmentsOf(userUpdate[5])).toEqual([
      "assignmentsCompleted",
      "admin1",
    ]);
    expect(segmentsOf(userUpdate[7])).toEqual(["assignments", "completed"]);
    expect(transaction.update).toHaveBeenCalledTimes(3);
  });

  it("backfills startedOn from the earliest run and increments both stats", async () => {
    const earlier = new Date("2026-01-01T00:00:00Z");
    const later = new Date("2026-01-02T00:00:00Z");
    installReads(
      {
        assessments: [{ taskId: "egma-math" }],
        assigningOrgs: { districts: ["site1"] },
        started: false,
        completed: false,
      },
      [{}, { timeStarted: later }, { timeStarted: earlier }]
    );

    await completeTask.run({
      auth: { uid: "user1" },
      data: {
        administrationId: "admin1",
        taskId: "egma-math",
        userId: "user1",
      },
    } as never);

    const assessmentUpdate = transaction.update.mock.calls.find((call) =>
      Array.isArray(call[1].assessments)
    );
    expect(assessmentUpdate[1].assessments[0].startedOn).toBe(earlier);
    expect(assessmentUpdate[1].assessments[0].completedOn).toBeInstanceOf(Date);

    const siteStats = transaction.set.mock.calls.find(
      (call) => call[0].path === "administrations/admin1/stats/site1"
    );
    expect(siteStats[1].assignment.started).toBeDefined();
    expect(siteStats[1].assignment.completed).toBeDefined();
    expect(siteStats[1]["egma-math"].started).toBeDefined();
    expect(siteStats[1]["egma-math"].completed).toBeDefined();
  });

  it("rejects completion when the task has no started run", async () => {
    installReads(
      {
        assessments: [{ taskId: "egma-math" }],
        assigningOrgs: { districts: ["site1"] },
        started: false,
        completed: false,
      },
      []
    );

    await expect(
      completeTask.run({
        auth: { uid: "user1" },
        data: {
          administrationId: "admin1",
          taskId: "egma-math",
          userId: "user1",
        },
      } as never)
    ).rejects.toMatchObject({ code: "failed-precondition" });
    expect(transaction.update).not.toHaveBeenCalled();
    expect(transaction.set).not.toHaveBeenCalled();
  });

  it("rejects completion when matching runs have no timeStarted", async () => {
    installReads(
      {
        assessments: [{ taskId: "egma-math" }],
        assigningOrgs: { districts: ["site1"] },
        started: false,
        completed: false,
      },
      [{}]
    );

    await expect(
      completeTask.run({
        auth: { uid: "user1" },
        data: {
          administrationId: "admin1",
          taskId: "egma-math",
          userId: "user1",
        },
      } as never)
    ).rejects.toMatchObject({ code: "failed-precondition" });
    expect(transaction.update).not.toHaveBeenCalled();
  });

  it("stamps only completion when the assignment was already started", async () => {
    const startedOn = new Date("2026-01-01T00:00:00Z");
    installReads({
      assessments: [{ taskId: "egma-math", startedOn }],
      assigningOrgs: { districts: ["site1"] },
      started: true,
      completed: false,
    });

    await completeTask.run({
      auth: { uid: "user1" },
      data: {
        administrationId: "admin1",
        taskId: "egma-math",
        userId: "user1",
      },
    } as never);

    const userUpdate = transaction.update.mock.calls.find(
      (call) => call[0].path === "users/user1"
    );
    expect(segmentsOf(userUpdate[1])).toEqual([
      "assignmentsCompleted",
      "admin1",
    ]);
    expect(segmentsOf(userUpdate[3])).toEqual(["assignments", "completed"]);
    expect(userUpdate).toHaveLength(5);

    const assessmentUpdate = transaction.update.mock.calls.find((call) =>
      Array.isArray(call[1].assessments)
    );
    expect(assessmentUpdate[1].assessments[0].startedOn).toBe(startedOn);
    expect(assessmentUpdate[1].assessments[0].completedOn).toBeInstanceOf(Date);

    const siteStats = transaction.set.mock.calls.find(
      (call) => call[0].path === "administrations/admin1/stats/site1"
    );
    expect(siteStats[1].assignment.started).toBeUndefined();
    expect(siteStats[1].assignment.completed).toBeDefined();
    expect(siteStats[1]["egma-math"].started).toBeUndefined();
    expect(siteStats[1]["egma-math"].completed).toBeDefined();
  });
});
