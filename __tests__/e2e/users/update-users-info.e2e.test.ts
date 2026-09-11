import type {
  UpdateUsersInfoParams,
  UpdateUsersInfoResult,
} from "@levante-framework/levante-zod";
import type { HttpsCallable } from "firebase/functions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
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

// Seeds a `users/{uid}` doc with the flags the handler validates and updates.
async function seedUser(
  uid: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await adminDb.doc(`users/${uid}`).set({
    userType: "teacher",
    email: `${uid}@example.com`,
    archived: false,
    disabled: false,
    districts: { current: [SITE] },
    ...extra,
  });
}

describe("updateUsersInfo (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let updateUsersInfo: HttpsCallable<UpdateUsersInfoParams, UpdateUsersInfoResult>;

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()]);
    await seedSystemPermissions();
    client = getClient();
    updateUsersInfo = client.call<UpdateUsersInfoParams, UpdateUsersInfoResult>(
      "updateUsersInfo"
    );
  });

  afterEach(() => client.cleanup());

  it("rejects unauthenticated callers", async () => {
    await expect(
      updateUsersInfo({ users: [{ uid: "u-1", archived: true }] })
    ).rejects.toMatchObject({ code: "functions/unauthenticated" });
  });

  it("rejects invalid input with a per-field details payload", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);

    await expect(
      // @ts-expect-error intentionally missing uid
      updateUsersInfo({ users: [{ archived: true }] })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "users.0.uid",
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
    await seedUser("u-1");
    await expect(
      updateUsersInfo({ users: [{ uid: "u-1", archived: true }] })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("returns not-found for a user that does not exist", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await expect(
      updateUsersInfo({ users: [{ uid: "missing", archived: true }] })
    ).rejects.toMatchObject({
      code: "functions/not-found",
      details: { code: "users", uids: ["missing"] },
    });
  });

  it("rejects when the caller lacks update access to a target user's site", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    // Belongs to a site the SITE admin cannot update.
    await seedUser("u-cross", { districts: { current: [SITE, OTHER_SITE] } });

    await expect(
      updateUsersInfo({ users: [{ uid: "u-cross", disabled: true }] })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });

    const doc = await adminDb.doc("users/u-cross").get();
    expect(doc.get("disabled")).toBe(false);
  });

  it("rejects when the target has no site membership", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedUser("u-orphan", { districts: { current: [] } });

    await expect(
      updateUsersInfo({ users: [{ uid: "u-orphan", disabled: true }] })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });

    const doc = await adminDb.doc("users/u-orphan").get();
    expect(doc.get("disabled")).toBe(false);
  });

  it("updates archived and disabled flags for authorized users", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await Promise.all([seedUser("u-1"), seedUser("u-2")]);

    const { data } = await updateUsersInfo({
      users: [
        { uid: "u-1", archived: true, disabled: true },
        { uid: "u-2", archived: true },
      ],
    });

    expect(data).toEqual({
      users: [
        { uid: "u-1", archived: true, disabled: true },
        { uid: "u-2", archived: true },
      ],
    });

    const u1 = await adminDb.doc("users/u-1").get();
    expect(u1.get("archived")).toBe(true);
    expect(u1.get("disabled")).toBe(true);
    expect(u1.get("updatedAt")).toBeDefined();

    const u2 = await adminDb.doc("users/u-2").get();
    expect(u2.get("archived")).toBe(true);
  });

  it("leaves omitted flags untouched", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedUser("u-1", { archived: false, disabled: true });

    await updateUsersInfo({ users: [{ uid: "u-1", archived: true }] });

    const u1 = await adminDb.doc("users/u-1").get();
    expect(u1.get("archived")).toBe(true);
    // disabled was not in the payload, so it stays as seeded.
    expect(u1.get("disabled")).toBe(true);
  });
});
