import { beforeEach, describe, expect, it, vi } from "vitest";

const { db, transaction } = vi.hoisted(() => {
  const node = (path: string) => ({
    path,
    collection: (name: string) => node(`${path}/${name}`),
    doc: (id: string) => node(`${path}/${id}`),
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe("completeTask", () => {
  it("stamps started and completed on the user doc when the assignment finishes", async () => {
    transaction.get.mockImplementation(async (ref: { path: string }) => {
      if (ref.path === "users/user1/assignments/admin1") {
        return snap({
          assessments: [{ taskId: "egma-math" }],
          assigningOrgs: { districts: ["site1"] },
          started: false,
          completed: false,
        });
      }
      throw new Error(`unexpected read ${ref.path}`);
    });

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

  it("stamps only completion when the assignment was already started", async () => {
    transaction.get.mockImplementation(async (ref: { path: string }) => {
      if (ref.path === "users/user1/assignments/admin1") {
        return snap({
          assessments: [{ taskId: "egma-math", startedOn: new Date() }],
          assigningOrgs: { districts: ["site1"] },
          started: true,
          completed: false,
        });
      }
      throw new Error(`unexpected read ${ref.path}`);
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
  });
});
