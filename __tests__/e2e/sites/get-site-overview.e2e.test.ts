import type { GetSiteOverviewResult } from "@levante-framework/levante-zod";
import { Timestamp } from "firebase-admin/firestore";
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

const daysFromNow = (days: number) =>
  Timestamp.fromDate(new Date(Date.now() + days * 24 * 60 * 60 * 1000));

describe("getSiteOverview (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let getSiteOverview: HttpsCallable<{ siteId: string }, GetSiteOverviewResult>;

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()]);
    await seedSystemPermissions();
    client = getClient();
    getSiteOverview = client.call<{ siteId: string }, GetSiteOverviewResult>(
      "getSiteOverview",
    );
  });

  afterEach(() => client.cleanup());

  it("rejects unauthenticated callers", async () => {
    await expect(getSiteOverview({ siteId: SITE })).rejects.toMatchObject({
      code: "functions/unauthenticated",
    });
  });

  it("rejects invalid input with a per-field details payload", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await expect(
      // @ts-expect-error intentionally missing siteId
      getSiteOverview({}),
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: expect.arrayContaining([
        expect.objectContaining({
          path: "siteId",
          message: expect.any(String),
        }),
      ]),
    });
    await expect(
      // @ts-expect-error intentionally wrong type for siteId
      getSiteOverview({ siteId: 123 }),
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: expect.arrayContaining([
        expect.objectContaining({
          path: "siteId",
          message: expect.any(String),
        }),
      ]),
    });
  });

  it("rejects callers without read access to the requested site", async () => {
    await signInAs(client, "u-other", {
      useNewPermissions: true,
      siteRoles: { [OTHER_SITE]: ["site_admin"] },
    });
    await expect(getSiteOverview({ siteId: SITE })).rejects.toMatchObject({
      code: "functions/permission-denied",
    });
  });

  it("rejects migrated callers with no site roles", async () => {
    await signInAs(client, "u-no-roles", { useNewPermissions: true });
    await expect(getSiteOverview({ siteId: SITE })).rejects.toMatchObject({
      code: "functions/permission-denied",
    });
  });

  it("rejects callers who have not been migrated to the new permission system", async () => {
    await signInAs(client, "u-legacy", {
      siteRoles: { [SITE]: ["site_admin"] },
    });
    await expect(getSiteOverview({ siteId: SITE })).rejects.toMatchObject({
      code: "functions/permission-denied",
    });
  });

  it("returns zero counts and empty arrays for a site with no data", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);

    const { data } = await getSiteOverview({ siteId: SITE });

    expect(data).toEqual({
      counts: {
        users: { teachers: 0, caregivers: 0, children: 0 },
        assignments: { open: 0, upcoming: 0, closed: 0 },
      },
      schools: [],
      classes: [],
      cohorts: [],
    });
  });

  it("aggregates counts and lists for the requested site, excluding archived, off-site, and admin users", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedSiteFixture();

    const { data } = await getSiteOverview({ siteId: SITE });

    expect(data.counts).toEqual({
      users: { teachers: 2, caregivers: 1, children: 3 },
      assignments: { open: 2, upcoming: 1, closed: 1 },
    });

    expect(data.schools).toEqual(
      expect.arrayContaining([
        { id: "school-a", name: "School A" },
        { id: "school-b", name: "School B" },
      ]),
    );
    expect(data.schools).toHaveLength(2);

    expect(data.classes).toEqual(
      expect.arrayContaining([
        { id: "class-1", name: "Class 1", schoolId: "school-a" },
        { id: "class-2", name: "Class 2", schoolId: "school-a" },
        { id: "class-3", name: "Class 3", schoolId: "school-b" },
      ]),
    );
    expect(data.classes).toHaveLength(3);

    expect(data.cohorts).toEqual([{ id: "cohort-1", name: "Cohort 1" }]);
  });
});

// Seeds a deterministic fixture so the aggregation contract can be asserted exactly.
// Includes off-site, archived, and partial-data docs to verify all exclusion rules.
async function seedSiteFixture() {
  const batch = adminDb.batch();

  // Users on this site (counted)
  for (const [id, userType] of [
    ["u-teacher-1", "teacher"],
    ["u-teacher-2", "teacher"],
    ["u-parent-1", "parent"],
    ["u-student-1", "student"],
    ["u-student-2", "student"],
    ["u-student-3", "student"],
  ] as const) {
    batch.set(adminDb.doc(`users/${id}`), {
      userType,
      archived: false,
      districts: { current: [SITE] },
    });
  }

  // Excluded users
  batch.set(adminDb.doc("users/u-admin-on-site"), {
    userType: "admin", // admins are not in the result counts
    archived: false,
    districts: { current: [SITE] },
  });
  batch.set(adminDb.doc("users/u-archived-teacher"), {
    userType: "teacher",
    archived: true,
    districts: { current: [SITE] },
  });
  batch.set(adminDb.doc("users/u-other-site-teacher"), {
    userType: "teacher",
    archived: false,
    districts: { current: [OTHER_SITE] },
  });

  // Assignments on this site
  batch.set(adminDb.doc("administrations/a-open-1"), {
    siteId: SITE,
    dateOpened: daysFromNow(-5),
    dateClosed: daysFromNow(5),
  });
  batch.set(adminDb.doc("administrations/a-open-2"), {
    siteId: SITE,
    dateOpened: daysFromNow(-1),
    dateClosed: daysFromNow(30),
  });
  batch.set(adminDb.doc("administrations/a-upcoming"), {
    siteId: SITE,
    dateOpened: daysFromNow(7),
    dateClosed: daysFromNow(14),
  });
  batch.set(adminDb.doc("administrations/a-closed"), {
    siteId: SITE,
    dateOpened: daysFromNow(-30),
    dateClosed: daysFromNow(-1),
  });
  // Skipped: missing dates (should not break aggregation or be miscounted)
  batch.set(adminDb.doc("administrations/a-no-dates"), { siteId: SITE });
  // Excluded: different site
  batch.set(adminDb.doc("administrations/a-other-site"), {
    siteId: OTHER_SITE,
    dateOpened: daysFromNow(-1),
    dateClosed: daysFromNow(1),
  });

  // Schools (one archived, one off-site)
  batch.set(adminDb.doc("schools/school-a"), {
    name: "School A",
    districtId: SITE,
    archived: false,
  });
  batch.set(adminDb.doc("schools/school-b"), {
    name: "School B",
    districtId: SITE,
    archived: false,
  });
  batch.set(adminDb.doc("schools/school-archived"), {
    name: "Archived School",
    districtId: SITE,
    archived: true,
  });
  batch.set(adminDb.doc("schools/school-other-site"), {
    name: "Off-site School",
    districtId: OTHER_SITE,
    archived: false,
  });

  // Classes (one archived, one off-site)
  batch.set(adminDb.doc("classes/class-1"), {
    name: "Class 1",
    districtId: SITE,
    schoolId: "school-a",
    archived: false,
  });
  batch.set(adminDb.doc("classes/class-2"), {
    name: "Class 2",
    districtId: SITE,
    schoolId: "school-a",
    archived: false,
  });
  batch.set(adminDb.doc("classes/class-3"), {
    name: "Class 3",
    districtId: SITE,
    schoolId: "school-b",
    archived: false,
  });
  batch.set(adminDb.doc("classes/class-archived"), {
    name: "Archived Class",
    districtId: SITE,
    schoolId: "school-a",
    archived: true,
  });
  batch.set(adminDb.doc("classes/class-other-site"), {
    name: "Off-site Class",
    districtId: OTHER_SITE,
    schoolId: "school-other-site",
    archived: false,
  });

  // Cohorts (groups collection — one archived, one off-site)
  batch.set(adminDb.doc("groups/cohort-1"), {
    name: "Cohort 1",
    parentOrgId: SITE,
    archived: false,
  });
  batch.set(adminDb.doc("groups/cohort-archived"), {
    name: "Archived Cohort",
    parentOrgId: SITE,
    archived: true,
  });
  batch.set(adminDb.doc("groups/cohort-other-site"), {
    name: "Off-site Cohort",
    parentOrgId: OTHER_SITE,
    archived: false,
  });

  await batch.commit();
}
