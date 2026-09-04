const { getSeedConfig } = require("./config");
const {
  seedRegisteredTasksFromProject,
} = require("./seeders/tasks-from-project");
const {
  ADMIN_USERS,
  ORG_FIXTURES,
  buildParticipantRows,
} = require("./function-based-seeders/fixtures");
const {
  bootstrapFunctionSeedPrerequisites,
} = require("./function-based-seeders/bootstrap");
const { getFunctionsSeedOptions } = require("./function-based-seeders/options");
const {
  createFunctionsSeedRuntime,
} = require("./function-based-seeders/runtime");
const {
  createAdminUsers,
  createAdministrations,
  createCaregiverSurveyAdministration,
  createOrgs,
  createParticipantUsers,
  linkParticipantUsers,
} = require("./function-based-seeders/steps");
const {
  validateDashboardVisibleData,
} = require("./function-based-seeders/validation");

const { projectId, isEmulator } = getSeedConfig();

if (!isEmulator) {
  throw new Error(
    "seed-emulator-functions.js only runs against the Firebase emulator."
  );
}

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8180";
process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9199";

const options = getFunctionsSeedOptions();
const runtime = createFunctionsSeedRuntime({ projectId });

function printTesterLogins({ createdUsers, userRows, createdAdmins }) {
  const userBySeedId = new Map(
    userRows.map((row, index) => [row.id, createdUsers[index]])
  );
  const logins = [
    {
      label: "Super admin",
      email: options.superAdminEmail,
      password: options.superAdminPassword,
    },
    ...createdAdmins.map((admin) => ({
      label: `Admin (${admin.role})`,
      email: admin.email,
      password: admin.password,
    })),
    {
      label: "Child participant",
      ...userBySeedId.get("student1"),
    },
    {
      label: "Teacher participant",
      ...userBySeedId.get("teacher"),
    },
    {
      label: "Caregiver participant",
      ...userBySeedId.get("parent"),
    },
  ].filter((login) => login.email && login.password);

  console.log("\nTester logins:");
  logins.forEach((login) => {
    console.log(`- ${login.label}: ${login.email} / ${login.password}`);
  });

  const caregiverCohortLogins = [
    {
      label: "Caregiver (no children)",
      ...userBySeedId.get("caregiverNoChild"),
    },
    {
      label: "Caregiver (one child)",
      ...userBySeedId.get("caregiverOneChild"),
    },
    {
      label: "Caregiver (two children)",
      ...userBySeedId.get("caregiverTwoChildren"),
    },
  ];
  console.log(`\n${ORG_FIXTURES.caregiverCohortName} logins:`);
  caregiverCohortLogins.forEach((login) => {
    console.log(`- ${login.label}: ${login.email} / ${login.password}`);
  });
}

async function main() {
  console.log("=== STARTING FUNCTIONS-DRIVEN EMULATOR SEED ===");
  console.log(`Profile:           ${options.profile}`);
  console.log(`Task source:       ${options.sourceProjectId}`);

  await seedRegisteredTasksFromProject({
    targetApp: runtime.app,
    sourceProjectId: options.sourceProjectId,
    verbose: true,
  });

  if (options.profile === "tasks-only") {
    console.log("=== TASK-ONLY SEED COMPLETE ===");
    return;
  }

  console.log("Bootstrapping system permissions and super admin...");
  await bootstrapFunctionSeedPrerequisites({
    app: runtime.app,
    superAdminEmail: options.superAdminEmail,
    superAdminPassword: options.superAdminPassword,
  });

  const { idToken, uid } = await runtime.signIn({
    email: options.superAdminEmail,
    password: options.superAdminPassword,
  });

  console.log("Calling setUidClaims as seeded super admin...");
  await runtime.callFunction("setUidClaims", {}, idToken);

  if (options.profile === "minimal") {
    console.log("=== MINIMAL FUNCTIONS-DRIVEN EMULATOR SEED COMPLETE ===");
    return;
  }

  console.log("Creating visible org fixtures through upsertOrg...");
  const orgs = await createOrgs({ runtime, idToken, uid });

  console.log("Creating administrator users through createAdministrator...");
  const createdAdmins = await createAdminUsers({
    runtime,
    idToken,
    siteId: orgs.siteId,
    siteName: orgs.siteName,
  });

  console.log("Creating participant users through createUsers...");
  const userRows = buildParticipantRows({
    siteId: orgs.siteId,
    schoolId: orgs.schoolId,
    originalClassId: orgs.originalClassId,
    newClassId: orgs.newClassId,
    cohortId: orgs.cohortId,
    caregiverCohortId: orgs.caregiverCohortId,
    studentCount: options.studentCount,
  });
  const childCount = userRows.filter((row) => row.userType === "child").length;
  const participantCount = userRows.length;
  const caregiverCohortMemberCount = userRows.filter((row) =>
    row.orgIds.cohorts?.includes(orgs.caregiverCohortId)
  ).length;
  const createdUsers = await createParticipantUsers({
    runtime,
    userRows,
    siteId: orgs.siteId,
    idToken,
  });

  console.log("Linking participant users through linkUsers...");
  await linkParticipantUsers({
    runtime,
    userRows,
    createdUsers,
    siteId: orgs.siteId,
    idToken,
  });

  let createdAdministrations = [];
  if (options.includeAdministrations) {
    console.log("Creating administrations through upsertAdministration...");
    createdAdministrations = await createAdministrations({
      runtime,
      idToken,
      siteId: orgs.siteId,
      schoolId: orgs.schoolId,
      classIds: [orgs.originalClassId, orgs.newClassId],
      cohortId: orgs.cohortId,
      creatorName: "Super Admin User",
      childCount,
      participantCount,
      includeOptionalAdministrationTemplates:
        options.includeOptionalAdministrationTemplates,
    });

    console.log("Creating caregiver survey administration...");
    const caregiverSurvey = await createCaregiverSurveyAdministration({
      runtime,
      idToken,
      siteId: orgs.siteId,
      caregiverCohortId: orgs.caregiverCohortId,
      creatorName: "Super Admin User",
      expectedAssignmentCount: caregiverCohortMemberCount,
    });
    if (caregiverSurvey) createdAdministrations.push(caregiverSurvey);
  } else {
    console.log("Skipping administrations for this seed profile.");
  }

  const validationSummary = options.validate
    ? await validateDashboardVisibleData({
        runtime,
        siteId: orgs.siteId,
        createdAdministrations,
        idToken,
        participantCount,
        expectedGroups: 2,
        adminUsers: ADMIN_USERS,
      })
    : null;

  console.log("=== FUNCTIONS-DRIVEN EMULATOR SEED COMPLETE ===");
  console.log(`Site:              ${orgs.siteName} (${orgs.siteId})`);
  console.log(`School:            ${orgs.schoolName} (${orgs.schoolId})`);
  console.log(
    `Classes:           ${orgs.originalClassName} (${orgs.originalClassId}), ${orgs.newClassName} (${orgs.newClassId})`
  );
  console.log(`Cohort:            ${orgs.cohortName} (${orgs.cohortId})`);
  console.log(
    `Admin users:       ${
      createdAdmins.length + 1
    } including bootstrapped super admin`
  );
  console.log(`Participant users: ${createdUsers.length}`);
  console.log(`Administrations:   ${createdAdministrations.length}`);

  if (validationSummary) {
    console.log(`Firestore users:   ${validationSummary.users}`);
    console.log(`UserClaims docs:   ${validationSummary.userClaims}`);
    console.log(`Assignment docs:   ${validationSummary.totalAssignments}`);
    validationSummary.assignmentCounts.forEach((assignmentCount) => {
      console.log(`- ${assignmentCount.name}: ${assignmentCount.count}`);
    });
  }

  printTesterLogins({ createdUsers, userRows, createdAdmins });
}

main().catch((error) => {
  console.error("\n❌ FUNCTIONS-DRIVEN EMULATOR SEED FAILED");
  console.error(error);
  process.exit(1);
});
