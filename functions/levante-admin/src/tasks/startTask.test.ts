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

const { startTask } = await import("./startTask.js");

const administration = {
  assessments: [
    {
      taskId: "egma-math",
      variantName: "default",
      variantId: "variant-1",
      params: {},
    },
  ],
};

const snap = (data: unknown) => ({
  exists: true,
  data: () => data,
});

function installReads(assignment: Record<string, unknown>) {
  transaction.get.mockImplementation(async (ref: { path: string }) => {
    if (ref.path === "users/user1/assignments/admin1") return snap(assignment);
    if (ref.path === "administrations/admin1") return snap(administration);
    if (ref.path === "users/user1") return snap({ userType: "student" });
    throw new Error(`unexpected read ${ref.path}`);
  });
}

const segmentsOf = (fieldPath: { segments: string[] }) => fieldPath.segments;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startTask", () => {
  it("stamps assignmentsStarted on the user doc when the assignment starts", async () => {
    installReads({
      assessments: [{ taskId: "egma-math" }],
      assigningOrgs: { districts: ["site1"] },
      readOrgs: { districts: ["site1"] },
      started: false,
      completed: false,
    });

    const result = await startTask.run({
      auth: { uid: "user1" },
      data: { administrationId: "admin1", taskId: "egma-math" },
    } as never);

    expect(result.success).toBe(true);
    const userUpdate = transaction.update.mock.calls.find(
      (call) => call[0].path === "users/user1"
    );
    expect(userUpdate).toBeDefined();
    expect(segmentsOf(userUpdate[1])).toEqual(["assignmentsStarted", "admin1"]);
    expect(segmentsOf(userUpdate[3])).toEqual(["assignments", "started"]);
    expect(transaction.set.mock.calls.map((call) => call[0].path)).toEqual(
      expect.arrayContaining([
        "administrations/admin1/stats/site1",
        "administrations/admin1/stats/total",
      ])
    );
  });

  it("does not rewrite assignmentsStarted when the assignment was already started", async () => {
    installReads({
      assessments: [{ taskId: "egma-math", startedOn: new Date() }],
      assigningOrgs: { districts: ["site1"] },
      readOrgs: { districts: ["site1"] },
      started: true,
      completed: false,
    });

    await startTask.run({
      auth: { uid: "user1" },
      data: { administrationId: "admin1", taskId: "egma-math" },
    } as never);

    expect(
      transaction.update.mock.calls.some(
        (call) => call[0].path === "users/user1"
      )
    ).toBe(false);
  });
});
