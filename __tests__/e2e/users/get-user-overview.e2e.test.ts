import type {
  GetUserOverviewParams,
  GetUserOverviewResult,
} from "@levante-framework/levante-zod";
import type { HttpsCallable } from "firebase/functions";
import { Timestamp } from "firebase-admin/firestore";
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

// Seeds a `users/{uid}` doc with the fields the handler reads.
async function seedUser(
  uid: string,
  extra: Record<string, unknown> = {}
): Promise<void> {
  await adminDb.doc(`users/${uid}`).set({
    userType: "student",
    email: `${uid}@example.com`,
    archived: false,
    disabled: false,
    districts: { current: [SITE] },
    schools: { current: [] },
    classes: { current: [] },
    groups: { current: [] },
    ...extra,
  });
}

describe("getUserOverview (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let getUserOverview: HttpsCallable<
    GetUserOverviewParams,
    GetUserOverviewResult
  >;

  beforeEach(async () => {
    await Promise.all([clearFirestore(), clearAuth()]);
    await seedSystemPermissions();
    client = getClient();
    getUserOverview = client.call<GetUserOverviewParams, GetUserOverviewResult>(
      "getUserOverview"
    );
  });

  afterEach(() => client.cleanup());

  it("rejects unauthenticated callers", async () => {
    await expect(getUserOverview({ uid: "u-1" })).rejects.toMatchObject({
      code: "functions/unauthenticated",
    });
  });

  it("rejects invalid input with a per-field details payload", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await expect(
      // @ts-expect-error intentionally missing uid
      getUserOverview({})
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: {
        code: "schema",
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "uid",
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
    await expect(getUserOverview({ uid: "u-1" })).rejects.toMatchObject({
      code: "functions/permission-denied",
    });
  });

  it("returns not-found for a user that does not exist", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await expect(getUserOverview({ uid: "missing" })).rejects.toMatchObject({
      code: "functions/not-found",
      details: { code: "user", uid: "missing" },
    });
  });

  it("rejects admin target users with a usertype details payload", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedUser("u-admin-target", { userType: "admin" });
    await expect(
      getUserOverview({ uid: "u-admin-target" })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: { code: "usertype", uid: "u-admin-target", userType: "admin" },
    });
  });

  it("rejects users with an unexpected userType", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedUser("u-weird", { userType: "wizard" });
    await expect(getUserOverview({ uid: "u-weird" })).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: { code: "usertype", uid: "u-weird", userType: "wizard" },
    });
  });

  it("rejects callers without read access to the target's site", async () => {
    await signInAs(client, "u-other", {
      useNewPermissions: true,
      siteRoles: { [OTHER_SITE]: ["site_admin"] },
    });
    await seedUser("u-1");
    await expect(getUserOverview({ uid: "u-1" })).rejects.toMatchObject({
      code: "functions/permission-denied",
    });
  });

  it("rejects when the target belongs to a site the caller cannot read", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    // Membership in a second site the SITE admin cannot read.
    await seedUser("u-cross", { districts: { current: [SITE, OTHER_SITE] } });
    await expect(getUserOverview({ uid: "u-cross" })).rejects.toMatchObject({
      code: "functions/permission-denied",
    });
  });

  it("rejects when the target has no site membership", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedUser("u-orphan", { districts: { current: [] } });
    await expect(getUserOverview({ uid: "u-orphan" })).rejects.toMatchObject({
      code: "functions/permission-denied",
    });
  });

  it("omits childLabelIndex for non-child users", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedUser("u-teacher", { userType: "teacher" });
    await adminDb.doc(`districts/${SITE}`).set({ name: "Site One" });

    const { data } = await getUserOverview({ uid: "u-teacher" });

    expect(data).toMatchObject({
      uid: "u-teacher",
      email: "u-teacher@example.com",
      userType: "teacher",
      archived: false,
      disabled: false,
      orgs: [{ id: SITE, name: "Site One", orgType: "site" }],
      assignments: [],
    });
    expect(data).not.toHaveProperty("childLabelIndex");
  });

  it("returns the user's profile, orgs, and bucketed assignments", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    const dates = await seedOverviewFixture();

    const { data } = await getUserOverview({ uid: "u-target" });

    expect(data).toMatchObject({
      uid: "u-target",
      email: "u-target@example.com",
      userType: "child",
      childLabelIndex: 3,
      archived: false,
      disabled: false,
    });

    // Missing org docs are skipped; the four resolvable orgs are returned.
    expect(data.orgs).toEqual(
      expect.arrayContaining([
        { id: SITE, name: "Site One", orgType: "site" },
        { id: "school-a", name: "School A", orgType: "school" },
        { id: "class-1", name: "Class 1", orgType: "class" },
        { id: "cohort-1", name: "Cohort 1", orgType: "cohort" },
      ])
    );
    expect(data.orgs).toHaveLength(4);

    // Pending/failed and missing-date assignments are excluded.
    expect(data.assignments).toEqual(
      expect.arrayContaining([
        {
          id: "a-open",
          name: "Open Assignment",
          status: "open",
          dateOpened: dates.openOpened.toDate().toISOString(),
          dateClosed: dates.openClosed.toDate().toISOString(),
        },
        {
          id: "a-upcoming",
          name: "Upcoming Assignment",
          status: "upcoming",
          dateOpened: dates.upcomingOpened.toDate().toISOString(),
          dateClosed: dates.upcomingClosed.toDate().toISOString(),
        },
        {
          id: "a-closed",
          name: "Closed Assignment",
          status: "closed",
          dateOpened: dates.closedOpened.toDate().toISOString(),
          dateClosed: dates.closedClosed.toDate().toISOString(),
        },
      ])
    );
    expect(data.assignments).toHaveLength(3);
  });
});

// Seeds a child user with a full org set (including one missing org) and a
// range of assignments across statuses and visibility states.
async function seedOverviewFixture() {
  const openOpened = daysFromNow(-5);
  const openClosed = daysFromNow(5);
  const upcomingOpened = daysFromNow(7);
  const upcomingClosed = daysFromNow(14);
  const closedOpened = daysFromNow(-30);
  const closedClosed = daysFromNow(-1);

  const batch = adminDb.batch();

  batch.set(adminDb.doc("users/u-target"), {
    userType: "student",
    email: "u-target@example.com",
    childLabelIndex: 3,
    archived: false,
    disabled: false,
    districts: { current: [SITE] },
    // "school-missing" has no doc and must be skipped.
    schools: { current: ["school-a", "school-missing"] },
    classes: { current: ["class-1"] },
    groups: { current: ["cohort-1"] },
  });

  batch.set(adminDb.doc(`districts/${SITE}`), { name: "Site One" });
  batch.set(adminDb.doc("schools/school-a"), { name: "School A" });
  batch.set(adminDb.doc("classes/class-1"), { name: "Class 1" });
  batch.set(adminDb.doc("groups/cohort-1"), { name: "Cohort 1" });

  batch.set(adminDb.doc("users/u-target/assignments/a-open"), {
    name: "Open Assignment",
    dateOpened: openOpened,
    dateClosed: openClosed,
    syncStatus: "complete",
  });
  // No syncStatus: legacy assignment, still visible.
  batch.set(adminDb.doc("users/u-target/assignments/a-upcoming"), {
    name: "Upcoming Assignment",
    dateOpened: upcomingOpened,
    dateClosed: upcomingClosed,
  });
  batch.set(adminDb.doc("users/u-target/assignments/a-closed"), {
    name: "Closed Assignment",
    dateOpened: closedOpened,
    dateClosed: closedClosed,
    syncStatus: "complete",
  });
  // Hidden: not fully synced.
  batch.set(adminDb.doc("users/u-target/assignments/a-pending"), {
    name: "Pending Assignment",
    dateOpened: openOpened,
    dateClosed: openClosed,
    syncStatus: "pending",
  });
  batch.set(adminDb.doc("users/u-target/assignments/a-failed"), {
    name: "Failed Assignment",
    dateOpened: openOpened,
    dateClosed: openClosed,
    syncStatus: "failed",
  });
  // Visible but missing dates: skipped.
  batch.set(adminDb.doc("users/u-target/assignments/a-no-dates"), {
    name: "Dateless Assignment",
    syncStatus: "complete",
  });

  await batch.commit();

  return {
    openOpened,
    openClosed,
    upcomingOpened,
    upcomingClosed,
    closedOpened,
    closedClosed,
  };
}
