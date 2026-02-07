import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { initAdminEmulators } from "./test-utils";
import {
  getUsersByOrg,
  countUsersByOrg,
} from "../functions/levante-admin/src/queries/user-queries.js";
import {
  getOrgByName,
  getOrgsForAdmin,
  getOrgsAll,
  getDistricts,
  getSchools,
  getOrgsBySite,
  getTreeOrgs,
} from "../functions/levante-admin/src/queries/org-queries.js";
import {
  getAdministrationsPage,
  getAdminsBySite,
} from "../functions/levante-admin/src/queries/administration-queries.js";
import {
  getTasks,
  getTasksById,
  getVariants,
} from "../functions/levante-admin/src/queries/task-queries.js";
import {
  countRuns,
  getRunsPage,
} from "../functions/levante-admin/src/queries/run-queries.js";
import {
  countAssignments,
  getAssignmentsPage,
  getUserAssignments,
  getAssignmentsByNameAndSite,
} from "../functions/levante-admin/src/queries/assignment-queries.js";
import { getLegalDocs } from "../functions/levante-admin/src/queries/legal-queries.js";

const districtId = "district-1";
const schoolId = "school-1";
const classId = "class-1";
const groupId = "group-1";
const administrationId = "admin-1";
const taskId = "task-1";
const variantId = "variant-1";
const runId = "run-1";

const adminUid = "admin-uid";
const superUid = "super-uid";
const otherAdminUid = "other-admin-uid";
const studentUid = "student-uid";

describe("query callables (emulator)", () => {
  const { auth, db } = initAdminEmulators();

  const clearCollection = async (collection: string) => {
    const snap = await db.collection(collection).get();
    await Promise.all(snap.docs.map((doc) => db.recursiveDelete(doc.ref)));
  };

  const deleteUserIfExists = async (uid: string) => {
    try {
      await auth.deleteUser(uid);
    } catch {
      // ignore missing users
    }
  };

  beforeAll(async () => {
    await deleteUserIfExists(adminUid);
    await deleteUserIfExists(superUid);
    await deleteUserIfExists(otherAdminUid);
    await deleteUserIfExists(studentUid);
  });

  beforeEach(async () => {
    await Promise.all([
      clearCollection("userClaims"),
      clearCollection("users"),
      clearCollection("districts"),
      clearCollection("schools"),
      clearCollection("classes"),
      clearCollection("groups"),
      clearCollection("administrations"),
      clearCollection("legal"),
      clearCollection("tasks"),
    ]);

    await auth.createUser({ uid: adminUid, email: "admin@example.com" });
    await auth.createUser({ uid: superUid, email: "super@example.com" });
    await auth.createUser({ uid: otherAdminUid, email: "other@example.com" });
    await auth.createUser({ uid: studentUid, email: "student@example.com" });

    await auth.setCustomUserClaims(adminUid, { useNewPermissions: false });
    await auth.setCustomUserClaims(superUid, { useNewPermissions: false });
    await auth.setCustomUserClaims(otherAdminUid, { useNewPermissions: false });

    await db.collection("userClaims").doc(adminUid).set({
      claims: {
        adminOrgs: { districts: [districtId], schools: [], classes: [], groups: [] },
        super_admin: false,
      },
    });
    await db.collection("userClaims").doc(superUid).set({
      claims: {
        adminOrgs: { districts: [], schools: [], classes: [], groups: [] },
        super_admin: true,
      },
    });
    await db.collection("userClaims").doc(otherAdminUid).set({
      claims: {
        adminOrgs: { districts: ["district-2"], schools: [], classes: [], groups: [] },
        super_admin: false,
      },
    });

    await db.collection("districts").doc(districtId).set({
      id: districtId,
      name: "Test District",
      normalizedName: "test district",
      schools: [schoolId],
      subGroups: [groupId],
      archived: false,
    });
    await db.collection("schools").doc(schoolId).set({
      id: schoolId,
      name: "Test School",
      normalizedName: "test school",
      districtId,
      classes: [classId],
      archived: false,
    });
    await db.collection("classes").doc(classId).set({
      id: classId,
      name: "Test Class",
      normalizedName: "test class",
      districtId,
      schoolId,
      archived: false,
    });
    await db.collection("groups").doc(groupId).set({
      id: groupId,
      name: "Test Group",
      parentOrgId: districtId,
      parentOrgType: "district",
      archived: false,
    });

    await db.collection("users").doc(adminUid).set({
      userType: "admin",
      roles: [{ siteId: districtId, role: "admin", siteName: "Test District" }],
      districts: { current: [districtId] },
    });
    await db.collection("users").doc(studentUid).set({
      userType: "student",
      archived: false,
      districts: { current: [districtId] },
      schools: { current: [schoolId] },
      classes: { current: [classId] },
      groups: { current: [groupId] },
    });

    await db.collection("administrations").doc(administrationId).set({
      id: administrationId,
      name: "Admin 1",
      publicName: "Admin 1",
      dateOpened: new Date(),
      dateClosed: new Date(Date.now() + 86400000),
      dateCreated: new Date(),
      assessments: [],
      districts: [districtId],
      schools: [schoolId],
      classes: [classId],
      groups: [groupId],
      families: [],
      testData: false,
      creatorName: "Admin User",
      siteId: districtId,
    });
    await db.doc(`administrations/${administrationId}/stats/total`).set({
      total: 1,
    });

    await db
      .collection("users")
      .doc(studentUid)
      .collection("assignments")
      .doc(administrationId)
      .set({
        id: administrationId,
        assessments: [{ runId }],
        readOrgs: { districts: [districtId], schools: [schoolId], classes: [classId], groups: [groupId] },
        assigningOrgs: { districts: [districtId], schools: [schoolId], classes: [classId], groups: [groupId] },
      });

    await db
      .collection("users")
      .doc(studentUid)
      .collection("runs")
      .doc(runId)
      .set({
        id: runId,
        assignmentId: administrationId,
        taskId,
        bestRun: true,
        completed: true,
        readOrgs: { districts: [districtId], schools: [schoolId], classes: [classId], groups: [groupId] },
        scores: { computed: { composite: 5 } },
      });

    await db.collection("tasks").doc(taskId).set({
      name: "Task 1",
      registered: true,
    });
    await db.collection("tasks").doc(taskId).collection("variants").doc(variantId).set({
      name: "Variant 1",
      registered: true,
    });

    await db.collection("legal").doc("consent").set({
      fileName: "consent.md",
      gitHubOrg: "levante-framework",
      gitHubRepository: "docs",
      currentCommit: "abc123",
      params: {},
    });
  });

  it("handles user + org queries with permissions", async () => {
    const users = await getUsersByOrg({
      uid: adminUid,
      orgType: "districts",
      orgId: districtId,
      pageLimit: 10,
      page: 0,
      select: ["id", "userType"],
      restrictToActiveUsers: true,
    });
    expect(users.length).toBeGreaterThan(0);

    const count = await countUsersByOrg({
      uid: adminUid,
      orgType: "districts",
      orgId: districtId,
      restrictToActiveUsers: true,
    });
    expect(count).toBeGreaterThan(0);

    await expect(
      getUsersByOrg({
        uid: otherAdminUid,
        orgType: "districts",
        orgId: districtId,
        pageLimit: 1,
        page: 0,
      })
    ).rejects.toMatchObject({ code: "permission-denied" });

    const orgByName = await getOrgByName({
      uid: adminUid,
      orgType: "schools",
      orgNormalizedName: "test school",
      parentDistrict: districtId,
      select: ["id", "name"],
    });
    expect(orgByName.length).toBe(1);

    const orgsForAdmin = await getOrgsForAdmin({
      uid: adminUid,
      orgType: "districts",
      selectedDistrict: districtId,
      select: ["id", "name"],
    });
    expect(orgsForAdmin.length).toBeGreaterThan(0);

    const orgsAll = await getOrgsAll({
      uid: adminUid,
      orgType: "schools",
      parentDistrict: districtId,
      select: ["id", "name"],
    });
    expect(orgsAll.length).toBeGreaterThan(0);

    const districts = await getDistricts({ uid: adminUid, districts: null });
    expect(districts.length).toBeGreaterThan(0);

    const schools = await getSchools({ uid: adminUid, districts: [districtId] });
    expect(schools.length).toBeGreaterThan(0);

    const orgsBySite = await getOrgsBySite({ uid: adminUid, siteId: districtId });
    expect(orgsBySite.length).toBeGreaterThan(0);

    const tree = await getTreeOrgs({
      uid: adminUid,
      administrationId,
      assignedOrgs: {
        districts: [districtId],
        schools: [schoolId],
        classes: [classId],
        groups: [groupId],
        families: [],
      },
    });
    expect(tree.length).toBeGreaterThan(0);
  });

  it("handles administration, assignment, run, task, legal queries", async () => {
    const adminPage = await getAdministrationsPage({
      uid: superUid,
      selectedDistrictId: districtId,
      fetchTestData: false,
      orderBy: [{ field: { fieldPath: "name" }, direction: "ASCENDING" }],
    });
    expect(adminPage.administrations.length).toBeGreaterThan(0);

    const admins = await getAdminsBySite({ siteId: districtId });
    expect(admins.length).toBeGreaterThan(0);

    const tasks = await getTasks({ registered: true, allData: false, select: ["name"] });
    expect(tasks.length).toBeGreaterThan(0);

    const tasksById = await getTasksById({ taskIds: [taskId] });
    expect(tasksById.length).toBe(1);

    const variants = await getVariants({ registered: true });
    expect(variants.length).toBeGreaterThan(0);

    const runCount = await countRuns({
      administrationId,
      orgType: "districts",
      orgId: districtId,
    });
    expect(runCount).toBeGreaterThan(0);

    const runs = await getRunsPage({
      administrationId,
      orgType: "districts",
      orgId: districtId,
      pageLimit: 10,
      page: 0,
      select: ["scores", "taskId"],
      paginate: true,
    });
    expect(runs.length).toBeGreaterThan(0);

    const assignmentCount = await countAssignments({
      adminId: administrationId,
      orgType: "district",
      orgId: districtId,
    });
    expect(assignmentCount).toBeGreaterThan(0);

    const assignments = await getAssignmentsPage({
      adminId: administrationId,
      orgType: "district",
      orgId: districtId,
      pageLimit: 10,
      page: 0,
      paginate: true,
      includeScores: false,
      includeSurveyResponses: false,
    });
    expect(assignments.length).toBeGreaterThan(0);

    const userAssignments = await getUserAssignments({ roarUid: studentUid });
    expect(userAssignments.length).toBeGreaterThan(0);

    const assignmentsByName = await getAssignmentsByNameAndSite({
      name: "Admin 1",
      normalizedName: "admin 1",
      siteId: districtId,
    });
    expect(assignmentsByName.length).toBeGreaterThan(0);

    const legalDocs = await getLegalDocs();
    expect(legalDocs.length).toBeGreaterThan(0);
  });
});
