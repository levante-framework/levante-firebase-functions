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

const { updateBestRunAndCompletion } = await import(
  "./update-best-run-and-completion.js"
);

const snap = (data: unknown) => ({
  exists: true,
  data: () => data,
});

const segmentsOf = (fieldPath: { segments: string[] }) => fieldPath.segments;

const finishedRun = {
  id: "run1",
  ref: { path: "users/user1/runs/run1" },
  data: () => ({
    completed: true,
    timeStarted: new Date("2026-01-01T00:00:00Z"),
    timeFinished: new Date("2026-01-01T00:10:00Z"),
  }),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("updateBestRunAndCompletion", () => {
  it("stamps started and completed on the user doc from a finished run", async () => {
    transaction.get.mockImplementation(
      async (ref: { path: string; kind?: string }) => {
        if (ref.kind === "query") {
          return { empty: false, docs: [finishedRun] };
        }
        if (ref.path === "users/user1/assignments/admin1") {
          return snap({
            assessments: [{ taskId: "egma-math" }],
            assigningOrgs: { districts: ["site1"] },
            progress: {},
            started: false,
            completed: false,
          });
        }
        throw new Error(`unexpected read ${ref.path}`);
      }
    );

    await updateBestRunAndCompletion({
      roarUid: "user1",
      assignmentId: "admin1",
      taskId: "egma-math",
    });

    const userUpdate = transaction.update.mock.calls.find(
      (call) => call[0].path === "users/user1"
    );
    expect(segmentsOf(userUpdate[1])).toEqual(["assignmentsStarted", "admin1"]);
    expect(segmentsOf(userUpdate[5])).toEqual([
      "assignmentsCompleted",
      "admin1",
    ]);
    expect(transaction.set.mock.calls.map((call) => call[0].path)).toEqual(
      expect.arrayContaining([
        "administrations/admin1/stats/site1",
        "administrations/admin1/stats/total",
      ])
    );
  });

  it("does not rewrite user progress fields when they are already recorded", async () => {
    const startedOn = new Date("2026-01-01T00:00:00Z");
    const completedOn = new Date("2026-01-01T00:10:00Z");
    transaction.get.mockImplementation(
      async (ref: { path: string; kind?: string }) => {
        if (ref.kind === "query") {
          return { empty: false, docs: [finishedRun] };
        }
        if (ref.path === "users/user1/assignments/admin1") {
          return snap({
            assessments: [{ taskId: "egma-math", startedOn, completedOn }],
            assigningOrgs: { districts: ["site1"] },
            progress: { egma_math: "completed" },
            started: true,
            completed: true,
          });
        }
        throw new Error(`unexpected read ${ref.path}`);
      }
    );

    await updateBestRunAndCompletion({
      roarUid: "user1",
      assignmentId: "admin1",
      taskId: "egma-math",
    });

    expect(
      transaction.update.mock.calls.some(
        (call) => call[0].path === "users/user1"
      )
    ).toBe(false);
  });
});
