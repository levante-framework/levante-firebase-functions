import type {
  UpsertTaskParams,
  UpsertTaskResult,
} from "@levante-framework/levante-zod";
import type { HttpsCallable } from "firebase/functions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adminDb,
  clearAuth,
  clearFirestore,
  getClient,
  signInAs,
} from "../app";

// Tasks are written by super_admins only; task writes are claim-based and do
// not consult the permission matrix, so no system/permissions seed is needed.
const SUPER_ADMIN_CLAIMS = { super_admin: true };

const baseTask: UpsertTaskParams = {
  archived: false,
  description: "Early grade math",
  image: "https://example.com/egma.png",
  name: "Egma Math",
  registered: true,
  validUserTypes: ["child", "caregiver"],
};

describe("upsertTask (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let upsertTask: HttpsCallable<UpsertTaskParams, UpsertTaskResult>;

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()]);
    client = getClient();
    upsertTask = client.call<UpsertTaskParams, UpsertTaskResult>("upsertTask");
  });

  afterEach(() => client.cleanup());

  it("rejects unauthenticated callers", async () => {
    await expect(upsertTask(baseTask)).rejects.toMatchObject({
      code: "functions/unauthenticated",
    });
  });

  it("rejects callers without write-task permission", async () => {
    await signInAs(client, "u-admin", { admin: true });
    await expect(upsertTask(baseTask)).rejects.toMatchObject({
      code: "functions/permission-denied",
    });
  });

  it("rejects invalid input with a per-field details payload", async () => {
    await signInAs(client, "u-super", SUPER_ADMIN_CLAIMS);
    await expect(
      // @ts-expect-error intentionally missing required fields
      upsertTask({})
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "name",
            message: expect.any(String),
          }),
        ]),
      },
    });
  });

  it("creates a task, deriving the id from name and storing ROAR user types", async () => {
    await signInAs(client, "u-super", SUPER_ADMIN_CLAIMS);

    const { data } = await upsertTask(baseTask);

    expect(data.task).toMatchObject({
      id: "egma-math",
      archived: false,
      description: "Early grade math",
      image: "https://example.com/egma.png",
      name: "Egma Math",
      registered: true,
      // Wire format uses LEVANTE names, order preserved.
      validUserTypes: ["child", "caregiver"],
    });

    // Firestore stores the legacy ROAR names.
    const stored = (await adminDb.doc("tasks/egma-math").get()).data();
    expect(stored?.validUserTypes).toEqual(["student", "parent"]);
    expect(stored?.registered).toBe(true);
    expect(stored?.createdBy).toBe("u-super");
  });

  it("rejects creating a task whose derived id already exists", async () => {
    await signInAs(client, "u-super", SUPER_ADMIN_CLAIMS);
    await upsertTask(baseTask);

    await expect(upsertTask(baseTask)).rejects.toMatchObject({
      code: "functions/already-exists",
      details: { code: "task", taskId: "egma-math" },
    });
  });

  it("updates an existing task by id and re-translates user types", async () => {
    await signInAs(client, "u-super", SUPER_ADMIN_CLAIMS);
    await upsertTask(baseTask);

    const { data } = await upsertTask({
      ...baseTask,
      id: "egma-math",
      registered: false,
      validUserTypes: ["teacher"],
    });

    expect(data.task).toMatchObject({
      id: "egma-math",
      registered: false,
      validUserTypes: ["teacher"],
    });

    const stored = (await adminDb.doc("tasks/egma-math").get()).data();
    expect(stored?.validUserTypes).toEqual(["teacher"]);
    expect(stored?.registered).toBe(false);
    expect(stored?.updatedBy).toBe("u-super");
  });

  it("rejects updating a task id that does not exist", async () => {
    await signInAs(client, "u-super", SUPER_ADMIN_CLAIMS);

    await expect(
      upsertTask({ ...baseTask, id: "does-not-exist" })
    ).rejects.toMatchObject({
      code: "functions/not-found",
      details: { code: "task", taskId: "does-not-exist" },
    });
  });
});
