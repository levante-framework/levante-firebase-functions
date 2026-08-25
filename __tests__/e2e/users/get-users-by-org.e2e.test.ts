import type {
  GetUsersByOrgParams,
  GetUsersByOrgResult,
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
const SCHOOL = "school-a";
const CLASS = "class-1";
const COHORT = "cohort-1";

const SITE_ADMIN_CLAIMS = {
  useNewPermissions: true,
  siteRoles: { [SITE]: ["site_admin"] },
};

describe("getUsersByOrg (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let getUsersByOrg: HttpsCallable<GetUsersByOrgParams, GetUsersByOrgResult>;

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()]);
    await seedSystemPermissions();
    client = getClient();
    getUsersByOrg = client.call<GetUsersByOrgParams, GetUsersByOrgResult>(
      "getUsersByOrg"
    );
  });

  afterEach(() => client.cleanup());

  it("rejects unauthenticated callers", async () => {
    await expect(
      getUsersByOrg({ orgType: "site", orgId: SITE })
    ).rejects.toMatchObject({ code: "functions/unauthenticated" });
  });

  it("rejects invalid input with a per-field details payload", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);

    await expect(
      // @ts-expect-error intentionally missing orgId
      getUsersByOrg({ orgType: "site" })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "orgId",
            message: expect.any(String),
          }),
        ]),
      },
    });

    await expect(
      // @ts-expect-error intentionally invalid orgType
      getUsersByOrg({ orgType: "planet", orgId: SITE })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "orgType",
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
      getUsersByOrg({ orgType: "site", orgId: SITE })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects migrated callers with no site roles", async () => {
    await signInAs(client, "u-no-roles", { useNewPermissions: true });
    await expect(
      getUsersByOrg({ orgType: "site", orgId: SITE })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("rejects callers without read access to the org's site", async () => {
    await signInAs(client, "u-other", {
      useNewPermissions: true,
      siteRoles: { [OTHER_SITE]: ["site_admin"] },
    });
    await seedFixture();

    await expect(
      getUsersByOrg({ orgType: "site", orgId: SITE })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
    // Permission is enforced on the resolved site, so a school owned by SITE
    // is also off-limits to an OTHER_SITE admin.
    await expect(
      getUsersByOrg({ orgType: "school", orgId: SCHOOL })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("returns not-found for an org that does not exist", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await expect(
      getUsersByOrg({ orgType: "school", orgId: "missing" })
    ).rejects.toMatchObject({
      code: "functions/not-found",
      details: { code: "org", id: "missing", type: "school" },
    });
  });

  it("returns an empty list for a site with no matching users", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    const { data } = await getUsersByOrg({ orgType: "site", orgId: SITE });
    expect(data).toEqual({ users: [] });
  });

  it("returns site members (including archived/disabled), mapping ROAR user types and excluding off-site/invalid docs", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedFixture();

    const { data } = await getUsersByOrg({ orgType: "site", orgId: SITE });

    expect(data.users).toEqual(
      expect.arrayContaining([
        { uid: "u-teacher", email: "teacher@example.com", userType: "teacher" },
        {
          uid: "u-child",
          email: "child@example.com",
          userType: "child",
          childLabelIndex: 3,
        },
        {
          uid: "u-caregiver",
          email: "caregiver@example.com",
          userType: "caregiver",
        },
        { uid: "u-site-admin", email: "admin@example.com", userType: "admin" },
        // archived and disabled users are no longer filtered out
        {
          uid: "u-archived",
          email: "archived@example.com",
          userType: "teacher",
        },
        {
          uid: "u-disabled",
          email: "disabled@example.com",
          userType: "teacher",
        },
      ])
    );
    expect(data.users).toHaveLength(6);
  });

  it("returns members of a school by resolving its owning site", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedFixture();

    const { data } = await getUsersByOrg({ orgType: "school", orgId: SCHOOL });

    expect(data.users.map((u) => u.uid).sort()).toEqual([
      "u-archived",
      "u-child",
      "u-disabled",
      "u-teacher",
    ]);
  });

  it("returns members of a class by resolving its owning site", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedFixture();

    const { data } = await getUsersByOrg({ orgType: "class", orgId: CLASS });

    expect(data.users.map((u) => u.uid).sort()).toEqual([
      "u-archived",
      "u-child",
      "u-disabled",
      "u-teacher",
    ]);
  });

  it("returns members of a cohort, resolving its site from the groups collection", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedFixture();

    const { data } = await getUsersByOrg({ orgType: "cohort", orgId: COHORT });

    expect(data.users.map((u) => u.uid).sort()).toEqual([
      "u-archived",
      "u-caregiver",
      "u-child",
      "u-disabled",
      "u-teacher",
    ]);
  });
});

// Seeds one site with a mix of valid, excluded, and invalid user docs plus the
// org docs needed to resolve non-site org types to their owning site.
async function seedFixture() {
  const batch = adminDb.batch();

  batch.set(adminDb.doc(`schools/${SCHOOL}`), {
    name: "School A",
    districtId: SITE,
    archived: false,
  });
  batch.set(adminDb.doc(`classes/${CLASS}`), {
    name: "Class 1",
    districtId: SITE,
    schoolId: SCHOOL,
    archived: false,
  });
  batch.set(adminDb.doc(`groups/${COHORT}`), {
    name: "Cohort 1",
    parentOrgId: SITE,
    parentOrgType: "districts",
    archived: false,
  });

  // Valid members of the site.
  batch.set(adminDb.doc("users/u-teacher"), {
    userType: "teacher",
    email: "teacher@example.com",
    archived: false,
    disabled: false,
    districts: { current: [SITE] },
    schools: { current: [SCHOOL] },
    classes: { current: [CLASS] },
    groups: { current: [COHORT] },
  });
  batch.set(adminDb.doc("users/u-child"), {
    userType: "student",
    email: "child@example.com",
    childLabelIndex: 3,
    archived: false,
    disabled: false,
    districts: { current: [SITE] },
    schools: { current: [SCHOOL] },
    classes: { current: [CLASS] },
    groups: { current: [COHORT] },
  });
  batch.set(adminDb.doc("users/u-caregiver"), {
    userType: "parent",
    email: "caregiver@example.com",
    archived: false,
    disabled: false,
    districts: { current: [SITE] },
    groups: { current: [COHORT] },
  });
  batch.set(adminDb.doc("users/u-site-admin"), {
    userType: "admin",
    email: "admin@example.com",
    archived: false,
    disabled: false,
    districts: { current: [SITE] },
  });

  // Still returned: archived/disabled users are no longer filtered out.
  batch.set(adminDb.doc("users/u-archived"), {
    userType: "teacher",
    email: "archived@example.com",
    archived: true,
    disabled: false,
    districts: { current: [SITE] },
    schools: { current: [SCHOOL] },
    classes: { current: [CLASS] },
    groups: { current: [COHORT] },
  });
  batch.set(adminDb.doc("users/u-disabled"), {
    userType: "teacher",
    email: "disabled@example.com",
    archived: false,
    disabled: true,
    districts: { current: [SITE] },
    schools: { current: [SCHOOL] },
    classes: { current: [CLASS] },
    groups: { current: [COHORT] },
  });

  // Excluded: off-site user.
  batch.set(adminDb.doc("users/u-other-site"), {
    userType: "teacher",
    email: "offsite@example.com",
    archived: false,
    disabled: false,
    districts: { current: [OTHER_SITE] },
  });

  // Invalid: skipped rather than returned (unknown userType, missing email).
  batch.set(adminDb.doc("users/u-bad-type"), {
    userType: "wizard",
    email: "wizard@example.com",
    archived: false,
    disabled: false,
    districts: { current: [SITE] },
  });
  batch.set(adminDb.doc("users/u-no-email"), {
    userType: "teacher",
    archived: false,
    disabled: false,
    districts: { current: [SITE] },
  });

  await batch.commit();
}
