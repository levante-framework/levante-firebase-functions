import { createHash } from "crypto";
import type {
  LinkUsersParams,
  LinkUsersResult,
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

const idHashFor = (id: string) =>
  createHash("sha256").update(`${SITE}-${id}`).digest("hex");

type LinkUser = LinkUsersParams["users"][number];

const caregiverRow = (id: string, uid: string): LinkUser => ({
  id,
  uid,
  userType: "caregiver",
});

const teacherRow = (id: string, uid: string): LinkUser => ({
  id,
  uid,
  userType: "teacher",
});

const childRow = (
  id: string,
  uid: string,
  links: { caregiverId?: string[]; teacherId?: string[] } = {}
): LinkUser => ({
  id,
  uid,
  userType: "child",
  caregiverId: links.caregiverId ?? [],
  teacherId: links.teacherId ?? [],
});

// Seeds a `users/{uid}` doc that passes the handler's existence, site, and
// idHash validation. `extra` overrides link/label fields per test.
async function seedUser(
  uid: string,
  externalId: string,
  extra: Record<string, unknown> = {}
) {
  await adminDb.doc(`users/${uid}`).set({
    archived: false,
    disabled: false,
    districts: { current: [SITE] },
    idHash: idHashFor(externalId),
    ...extra,
  });
}

describe("linkUsers (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let linkUsers: HttpsCallable<LinkUsersParams, LinkUsersResult>;

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()]);
    await seedSystemPermissions();
    client = getClient();
    linkUsers = client.call<LinkUsersParams, LinkUsersResult>("linkUsers");
  });

  afterEach(() => client.cleanup());

  it("rejects unauthenticated callers", async () => {
    await expect(
      linkUsers({
        siteId: SITE,
        users: [
          teacherRow("t1", "t1-uid"),
          childRow("ch1", "ch1-uid", { teacherId: ["t1"] }),
        ],
      })
    ).rejects.toMatchObject({ code: "functions/unauthenticated" });
  });

  it("rejects callers without create access to the requested site", async () => {
    await signInAs(client, "u-other", {
      useNewPermissions: true,
      siteRoles: { [OTHER_SITE]: ["site_admin"] },
    });
    await expect(
      linkUsers({
        siteId: SITE,
        users: [
          teacherRow("t1", "t1-uid"),
          childRow("ch1", "ch1-uid", { teacherId: ["t1"] }),
        ],
      })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("links a child to a new caregiver and teacher, minting label 0", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await Promise.all([
      seedUser("cg1-uid", "cg1"),
      seedUser("t1-uid", "t1"),
      seedUser("ch1-uid", "ch1"),
    ]);

    await linkUsers({
      siteId: SITE,
      users: [
        caregiverRow("cg1", "cg1-uid"),
        teacherRow("t1", "t1-uid"),
        childRow("ch1", "ch1-uid", {
          caregiverId: ["cg1"],
          teacherId: ["t1"],
        }),
      ],
    });

    const child = await adminDb.doc("users/ch1-uid").get();
    expect(child.get("parentIds")).toContain("cg1-uid");
    expect(child.get("teacherIds")).toContain("t1-uid");
    expect(child.get("childLabelIndex")).toBe(0);

    const caregiver = await adminDb.doc("users/cg1-uid").get();
    expect(caregiver.get("childIds")).toContain("ch1-uid");
    expect(caregiver.get("lastChildLabelIndex")).toBe(0);

    const teacher = await adminDb.doc("users/t1-uid").get();
    expect(teacher.get("childIds")).toContain("ch1-uid");
    // Teachers are never assigned a child label.
    expect(teacher.get("lastChildLabelIndex")).toBeUndefined();
  });

  it("leaves an existing caregiver and the child label untouched on a teacher-only link", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await Promise.all([
      seedUser("cg1-uid", "cg1", {
        childIds: ["ch1-uid"],
        lastChildLabelIndex: 5,
      }),
      seedUser("t1-uid", "t1"),
      seedUser("ch1-uid", "ch1", {
        parentIds: ["cg1-uid"],
        childLabelIndex: 5,
      }),
    ]);

    await linkUsers({
      siteId: SITE,
      users: [
        teacherRow("t1", "t1-uid"),
        childRow("ch1", "ch1-uid", { teacherId: ["t1"] }),
      ],
    });

    const caregiver = await adminDb.doc("users/cg1-uid").get();
    expect(caregiver.get("lastChildLabelIndex")).toBe(5);

    const child = await adminDb.doc("users/ch1-uid").get();
    expect(child.get("childLabelIndex")).toBe(5);
    expect(child.get("teacherIds")).toContain("t1-uid");

    const teacher = await adminDb.doc("users/t1-uid").get();
    expect(teacher.get("childIds")).toContain("ch1-uid");
  });

  it("bumps a previously linked caregiver when a new caregiver mints a label", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await Promise.all([
      seedUser("cg1-uid", "cg1", {
        childIds: ["ch1-uid"],
        lastChildLabelIndex: 3,
      }),
      seedUser("cg2-uid", "cg2"),
      seedUser("ch1-uid", "ch1", {
        parentIds: ["cg1-uid"],
        childLabelIndex: 3,
      }),
    ]);

    await linkUsers({
      siteId: SITE,
      users: [
        caregiverRow("cg2", "cg2-uid"),
        childRow("ch1", "ch1-uid", { caregiverId: ["cg2"] }),
      ],
    });

    // existing (3) is not > maxLast (3), so a fresh label 4 is minted.
    const child = await adminDb.doc("users/ch1-uid").get();
    expect(child.get("childLabelIndex")).toBe(4);
    expect(child.get("parentIds")).toEqual(
      expect.arrayContaining(["cg1-uid", "cg2-uid"])
    );

    const existingCaregiver = await adminDb.doc("users/cg1-uid").get();
    expect(existingCaregiver.get("lastChildLabelIndex")).toBe(4);

    const newCaregiver = await adminDb.doc("users/cg2-uid").get();
    expect(newCaregiver.get("lastChildLabelIndex")).toBe(4);
    expect(newCaregiver.get("childIds")).toContain("ch1-uid");
  });

  it("rejects when a referenced user does not exist", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    // The child exists but the referenced caregiver doc was never created.
    await seedUser("ch1-uid", "ch1");

    await expect(
      linkUsers({
        siteId: SITE,
        users: [
          caregiverRow("cg1", "cg1-uid"),
          childRow("ch1", "ch1-uid", { caregiverId: ["cg1"] }),
        ],
      })
    ).rejects.toMatchObject({
      code: "functions/not-found",
      details: { code: "users", uids: expect.arrayContaining(["cg1-uid"]) },
    });
  });

  it("rejects when a referenced user does not belong to the site", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedUser("t1-uid", "t1");
    await seedUser("ch1-uid", "ch1", { districts: { current: [OTHER_SITE] } });

    await expect(
      linkUsers({
        siteId: SITE,
        users: [
          teacherRow("t1", "t1-uid"),
          childRow("ch1", "ch1-uid", { teacherId: ["t1"] }),
        ],
      })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "users-site-mismatch",
        uids: expect.arrayContaining(["ch1-uid"]),
      },
    });
  });

  it("rejects when a stored idHash does not match the expected hash", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedUser("t1-uid", "t1");
    await seedUser("ch1-uid", "ch1", { idHash: "tampered-hash" });

    await expect(
      linkUsers({
        siteId: SITE,
        users: [
          teacherRow("t1", "t1-uid"),
          childRow("ch1", "ch1-uid", { teacherId: ["t1"] }),
        ],
      })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "id-hash-mismatch",
        uids: expect.arrayContaining(["ch1-uid"]),
      },
    });
  });
});
