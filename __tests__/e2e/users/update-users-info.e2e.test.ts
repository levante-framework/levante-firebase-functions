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

// birthMonth 0 (January) keeps getAge unambiguous year-round: it only decrements
// when the current month is before the birth month, which 0 never triggers.
const BIRTH_MONTH = 0;
const CURRENT_YEAR = new Date().getFullYear();
const dateOpened = new Date(Date.now() - 86_400_000);
const dateClosed = new Date(Date.now() + 365 * 86_400_000);

type AgeCondition = {
  field: "age";
  op: "GREATER_THAN_OR_EQUAL" | "LESS_THAN";
  value: number;
};

// Seeds the child the resync operates on. The district doc is required because
// getExhaustiveOrgs reads it; omit it (seedDistrict=false) to force a failure.
async function seedChild(
  uid: string,
  birthYear: number,
  { seedDistrict = true }: { seedDistrict?: boolean } = {}
): Promise<void> {
  if (seedDistrict) {
    await adminDb.doc(`districts/${SITE}`).set({ schools: [], subGroups: [] });
  }
  await seedUser(uid, {
    userType: "student",
    birthMonth: BIRTH_MONTH,
    birthYear,
  });
}

// Seeds an open administration assigned to SITE with a single age-gated task,
// including the assignedOrgs subcollection doc the resync queries to discover it.
async function seedAdministration(
  adminId: string,
  assigned: AgeCondition
): Promise<void> {
  await adminDb.doc(`administrations/${adminId}`).set({
    name: adminId,
    publicName: adminId,
    createdBy: "u-admin",
    siteId: SITE,
    dateOpened,
    dateClosed,
    dateCreated: dateOpened,
    districts: [SITE],
    schools: [],
    classes: [],
    groups: [],
    families: [],
    legal: {},
    sequential: false,
    testData: false,
    assessments: [
      {
        taskId: "task-1",
        variantId: "variant-1",
        variantName: "Variant 1",
        params: {},
        conditions: { assigned },
      },
    ],
  });
  await adminDb.doc(`administrations/${adminId}/assignedOrgs/${SITE}`).set({
    administrationId: adminId,
    orgId: SITE,
    orgType: "districts",
    dateOpened,
    dateClosed,
    dateCreated: dateOpened,
    createdBy: "u-admin",
    legal: {},
    name: adminId,
    publicName: adminId,
    testData: false,
    timestamp: new Date(),
  });
}

// Seeds an existing assignment for a child, as prepareNewAssignment would have
// created it when the child was still eligible. Pass `startedOn` to mark task-1
// as in progress (used to exercise the in-progress-retention boundary).
async function seedOpenAssignment(
  uid: string,
  adminId: string,
  { startedOn }: { startedOn?: Date } = {}
): Promise<void> {
  await adminDb.doc(`users/${uid}/assignments/${adminId}`).set({
    id: adminId,
    started: startedOn !== undefined,
    completed: false,
    assigningOrgs: { districts: [SITE], schools: [], classes: [], groups: [] },
    readOrgs: { districts: [SITE] },
    assessments: [
      {
        taskId: "task-1",
        optional: false,
        params: {},
        variantId: "variant-1",
        variantName: "Variant 1",
        ...(startedOn !== undefined ? { startedOn } : {}),
      },
    ],
    progress: { "task-1": startedOn !== undefined ? "started" : "assigned" },
    dateOpened,
    dateClosed,
    dateCreated: dateOpened,
  });
}

describe("updateUsersInfo (e2e)", () => {
  let client: ReturnType<typeof getClient>;
  let updateUsersInfo: HttpsCallable<
    UpdateUsersInfoParams,
    UpdateUsersInfoResult
  >;

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

  it("rejects birthMonth/birthYear for non-child users", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    // Default seeded userType is "teacher", i.e. not a child.
    await seedUser("u-teacher");

    await expect(
      updateUsersInfo({
        users: [{ uid: "u-teacher", birthMonth: 5, birthYear: 2015 }],
      })
    ).rejects.toMatchObject({
      code: "functions/invalid-argument",
      details: { code: "child-only-fields", uids: ["u-teacher"] },
    });

    const doc = await adminDb.doc("users/u-teacher").get();
    expect(doc.get("birthMonth")).toBeUndefined();
    expect(doc.get("birthYear")).toBeUndefined();
  });

  it("checks permissions before the child-only birth-field guard", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    // Non-child user on a site the caller cannot update. The caller must not
    // learn the user's type, so permission-denied takes precedence.
    await seedUser("u-cross", { districts: { current: [SITE, OTHER_SITE] } });

    await expect(
      updateUsersInfo({ users: [{ uid: "u-cross", birthMonth: 5 }] })
    ).rejects.toMatchObject({ code: "functions/permission-denied" });
  });

  it("updates birthMonth and birthYear for child users", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    // A birth change on a child triggers an assignment resync, which reads the
    // user's district doc; seed it even though there are no administrations.
    await adminDb.doc(`districts/${SITE}`).set({ schools: [], subGroups: [] });
    await seedUser("u-child", { userType: "student" });

    const { data } = await updateUsersInfo({
      users: [{ uid: "u-child", birthMonth: 5, birthYear: 2015 }],
    });

    expect(data).toEqual({
      users: [{ uid: "u-child", birthMonth: 5, birthYear: 2015 }],
    });

    const child = await adminDb.doc("users/u-child").get();
    expect(child.get("birthMonth")).toBe(5);
    expect(child.get("birthYear")).toBe(2015);
    expect(child.get("birthDateUpdatedAt")).toBeDefined();
  });

  it("does not stamp birthDateUpdatedAt when birth values are unchanged", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedUser("u-child", {
      userType: "student",
      birthMonth: 5,
      birthYear: 2015,
    });

    // Resend identical birth values alongside a real flag change.
    await updateUsersInfo({
      users: [
        { uid: "u-child", birthMonth: 5, birthYear: 2015, archived: true },
      ],
    });

    const child = await adminDb.doc("users/u-child").get();
    expect(child.get("archived")).toBe(true);
    expect(child.get("birthDateUpdatedAt")).toBeUndefined();
  });

  it("atomically creates an assignment when a birth change makes a child newly eligible", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedAdministration("admin-agein", {
      field: "age",
      op: "GREATER_THAN_OR_EQUAL",
      value: 8,
    });
    // Age 3: below the gate, so no assignment exists yet.
    await seedChild("u-child", CURRENT_YEAR - 3);

    const { data } = await updateUsersInfo({
      users: [{ uid: "u-child", birthYear: CURRENT_YEAR - 10 }],
    });

    expect(data.users).toEqual([
      { uid: "u-child", birthYear: CURRENT_YEAR - 10 },
    ]);

    // Field change persisted.
    const child = await adminDb.doc("users/u-child").get();
    expect(child.get("birthYear")).toBe(CURRENT_YEAR - 10);
    expect(child.get("birthDateUpdatedAt")).toBeDefined();

    // Assignment created in the same transaction.
    const assignment = await adminDb
      .doc("users/u-child/assignments/admin-agein")
      .get();
    expect(assignment.exists).toBe(true);
    expect(assignment.get("assessments")).toHaveLength(1);
    expect(assignment.get("assessments")[0].taskId).toBe("task-1");
  });

  it("atomically removes an assignment when a birth change makes a child ineligible", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedAdministration("admin-ageout", {
      field: "age",
      op: "LESS_THAN",
      value: 8,
    });
    // Age 3: eligible, so seed the assignment it would already have.
    await seedChild("u-child", CURRENT_YEAR - 3);
    await seedOpenAssignment("u-child", "admin-ageout");

    const { data } = await updateUsersInfo({
      users: [{ uid: "u-child", birthYear: CURRENT_YEAR - 10 }],
    });

    expect(data.users).toEqual([
      { uid: "u-child", birthYear: CURRENT_YEAR - 10 },
    ]);

    const child = await adminDb.doc("users/u-child").get();
    expect(child.get("birthYear")).toBe(CURRENT_YEAR - 10);

    // Assignment deleted in the same transaction.
    const assignment = await adminDb
      .doc("users/u-child/assignments/admin-ageout")
      .get();
    expect(assignment.exists).toBe(false);
  });

  it("retains an in-progress assessment when a birth change makes a child ineligible", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedAdministration("admin-ageout", {
      field: "age",
      op: "LESS_THAN",
      value: 8,
    });
    // Age 3: eligible, and task-1 is already in progress.
    await seedChild("u-child", CURRENT_YEAR - 3);
    const startedOn = new Date(Date.now() - 3_600_000);
    await seedOpenAssignment("u-child", "admin-ageout", { startedOn });

    const { data } = await updateUsersInfo({
      users: [{ uid: "u-child", birthYear: CURRENT_YEAR - 10 }],
    });

    expect(data.users).toEqual([
      { uid: "u-child", birthYear: CURRENT_YEAR - 10 },
    ]);

    // Child is now too old, but the started assessment is kept, so the
    // assignment survives rather than being deleted.
    const assignment = await adminDb
      .doc("users/u-child/assignments/admin-ageout")
      .get();
    expect(assignment.exists).toBe(true);
    const assessments = assignment.get("assessments");
    expect(assessments).toHaveLength(1);
    expect(assessments[0].taskId).toBe("task-1");
    expect(assessments[0].startedOn).toBeDefined();
  });

  it("drops the child from the response and writes nothing when the resync fails", async () => {
    await signInAs(client, "u-admin", SITE_ADMIN_CLAIMS);
    await seedAdministration("admin-agein", {
      field: "age",
      op: "GREATER_THAN_OR_EQUAL",
      value: 8,
    });
    // No district doc: getExhaustiveOrgs throws, so the whole transaction rolls back.
    await seedChild("u-child", CURRENT_YEAR - 3, { seedDistrict: false });

    const { data } = await updateUsersInfo({
      users: [{ uid: "u-child", birthYear: CURRENT_YEAR - 10 }],
    });

    // Failed child is dropped from the response.
    expect(data.users).toEqual([]);

    // Neither the field change nor any assignment was written.
    const child = await adminDb.doc("users/u-child").get();
    expect(child.get("birthYear")).toBe(CURRENT_YEAR - 3);
    expect(child.get("birthDateUpdatedAt")).toBeUndefined();
    const assignment = await adminDb
      .doc("users/u-child/assignments/admin-agein")
      .get();
    expect(assignment.exists).toBe(false);
  });
});
