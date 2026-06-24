import { createHash } from "crypto";
import type {
  CreateUsersParams,
  CreateUsersResult,
} from "@levante-framework/levante-zod";
import type { HttpsCallable } from "firebase/functions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  adminAuth,
  adminDb,
  clearAuth,
  clearFirestore,
  getClient,
  seedSystemPermissions,
  signInAs,
} from "../app";

const SITE = "site-1";
const OTHER_SITE = "site-2";

const SITE_ADMIN_CLAIMS = {
  useNewPermissions: true,
  siteRoles: { [SITE]: ["site_admin"] },
};

const idHashFor = (id: string) =>
  createHash("sha256").update(`${SITE}-${id}`).digest("hex");

// orgIds must satisfy the schema refinement: schools AND classes, or cohorts.
const teacher = (
  id: string,
  orgIds: Partial<CreateUsersParams["users"][number]["orgIds"]> = {}
): CreateUsersParams["users"][number] => ({
  id,
  userType: "teacher",
  orgIds: {
    schools: ["school-a"],
    classes: ["class-1"],
    cohorts: [],
    ...orgIds,
  },
});

// Polls until `fn` returns a defined value or the timeout elapses.
async function waitFor<T>(
  fn: () => Promise<T | undefined>,
  { timeoutMs = 15000, intervalMs = 250 } = {}
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = await fn();
    if (result !== undefined) return result;
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// Seeds the site doc plus a school and class that belong to it, so the happy
// path passes `ensureOrgsExistInSite`.
async function seedSite() {
  const batch = adminDb.batch();
  batch.set(adminDb.doc(`districts/${SITE}`), { name: "Site 1" });
  batch.set(adminDb.doc("schools/school-a"), {
    name: "School A",
    districtId: SITE,
    archived: false,
  });
  batch.set(adminDb.doc("classes/class-1"), {
    name: "Class 1",
    districtId: SITE,
    schoolId: "school-a",
    archived: false,
  });
  await batch.commit();
}

describe("createUsers (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let createUsers: HttpsCallable<CreateUsersParams, CreateUsersResult>;

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()]);
    await seedSystemPermissions();
    client = getClient();
    createUsers = client.call<CreateUsersParams, CreateUsersResult>(
      "createUsers"
    );
  });

  afterEach(() => client.cleanup());

  it("rejects unauthenticated callers", async () => {
    await expect(
      createUsers({ siteId: SITE, users: [teacher("ext-1")] })
    ).rejects.toMatchObject({ code: "functions/unauthenticated" });
  });

  it("rejects invalid input with a per-field details payload", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await expect(
      // @ts-expect-error intentionally missing users
      createUsers({ siteId: SITE })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "users",
            message: expect.any(String),
          }),
        ]),
      },
    });
  });

  it("rejects callers who have not been migrated to the new permission system", async () => {
    await signInAs(client, "u-legacy", {
      siteRoles: { [SITE]: ["site_admin"] },
    });
    await expect(
      createUsers({ siteId: SITE, users: [teacher("ext-1")] })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects callers without create access to the requested site", async () => {
    await signInAs(client, "u-other", {
      useNewPermissions: true,
      siteRoles: { [OTHER_SITE]: ["site_admin"] },
    });
    await expect(
      createUsers({ siteId: SITE, users: [teacher("ext-1")] })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects when the site has pending sync work", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await adminDb.doc("users/u-pending").set({
      archived: false,
      disabled: false,
      districts: { current: [SITE] },
      syncStatus: "pending",
    });

    await expect(
      createUsers({ siteId: SITE, users: [teacher("ext-1")] })
    ).rejects.toMatchObject({
      code: "functions/failed-precondition",
      details: { code: "sync-pending" },
    });
  });

  it("rejects when a user with the same external id already exists", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await adminDb.doc("users/u-existing").set({
      archived: false,
      disabled: false,
      districts: { current: [SITE] },
      email: "existing@example.com",
      idHash: idHashFor("ext-1"),
      syncStatus: "complete",
    });

    await expect(
      createUsers({ siteId: SITE, users: [teacher("ext-1")] })
    ).rejects.toMatchObject({
      code: "functions/already-exists",
      details: {
        code: "users",
        users: [
          { id: "ext-1", email: "existing@example.com", uid: "u-existing" },
        ],
      },
    });
  });

  it("rejects when a referenced org does not exist", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedSite();

    await expect(
      createUsers({
        siteId: SITE,
        users: [
          teacher("ext-1", {
            schools: ["missing-school"],
            classes: ["class-1"],
          }),
        ],
      })
    ).rejects.toMatchObject({
      code: "functions/not-found",
      details: {
        code: "orgs",
        orgIds: expect.objectContaining({ schools: ["missing-school"] }),
      },
    });
  });

  it("creates Auth, claims, and Firestore docs and returns credentials", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedSite();

    const { data } = await createUsers({
      siteId: SITE,
      users: [teacher("ext-1")],
    });

    expect(data.users).toHaveLength(1);
    const created = data.users[0];
    expect(created).toMatchObject({
      id: "ext-1",
      email: expect.any(String),
      password: expect.any(String),
      uid: expect.any(String),
    });

    const userSnap = await adminDb.doc(`users/${created.uid}`).get();
    expect(userSnap.exists).toBe(true);
    expect(userSnap.get("userType")).toBe("teacher");
    expect(userSnap.get("districts").current).toContain(SITE);
    expect(userSnap.get("schools").current).toContain("school-a");
    expect(userSnap.get("classes").current).toContain("class-1");

    const claimsSnap = await adminDb.doc(`userClaims/${created.uid}`).get();
    expect(claimsSnap.exists).toBe(true);

    const authUser = await adminAuth.getUser(created.uid);
    expect(authUser.email).toBe(created.email);
  });
});

describe("syncCreatedUsersTask (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let createUsers: HttpsCallable<CreateUsersParams, CreateUsersResult>;

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()]);
    await seedSystemPermissions();
    client = getClient();
    createUsers = client.call<CreateUsersParams, CreateUsersResult>(
      "createUsers"
    );
  });

  afterEach(() => client.cleanup());

  it("flips a created user's syncStatus to complete via the enqueued task", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedSite();

    const { data } = await createUsers({
      siteId: SITE,
      users: [teacher("ext-1")],
    });
    const { uid } = data.users[0];

    const status = await waitFor(async () => {
      const snap = await adminDb.doc(`users/${uid}`).get();
      const value = snap.get("syncStatus");
      return value === "complete" || value === "failed" ? value : undefined;
    });

    expect(status).toBe("complete");
  });
});
