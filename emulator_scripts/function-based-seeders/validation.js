const { ADMIN_USERS } = require("./fixtures");

async function validateDashboardVisibleData({
  runtime,
  siteId,
  createdAdministrations,
  idToken,
  studentCount,
  adminUsers = ADMIN_USERS,
}) {
  const administrationsResult = await runtime.callFunction(
    "getAdministrations",
    { testData: false, idsOnly: false },
    idToken
  );
  const administrations = Array.isArray(administrationsResult)
    ? administrationsResult
    : administrationsResult?.data;

  if (!Array.isArray(administrations)) {
    throw new Error(
      `getAdministrations returned an unexpected response: ${JSON.stringify(
        administrationsResult
      )}`
    );
  }

  const missingAdministrationIds = createdAdministrations
    .map((administration) => administration.id)
    .filter(
      (administrationId) =>
        !administrations.some((admin) => admin.id === administrationId)
    );
  if (missingAdministrationIds.length > 0) {
    throw new Error(
      `Seeded administrations are not visible: ${missingAdministrationIds.join(
        ", "
      )}`
    );
  }

  const siteUsers = await runtime.runFirestoreQuery(
    {
      structuredQuery: {
        from: [{ collectionId: "users" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "districts.current" },
            op: "ARRAY_CONTAINS",
            value: { stringValue: siteId },
          },
        },
      },
    },
    idToken
  );
  const participantCount = studentCount + 3;
  const visibleSiteUsers = siteUsers.filter((row) => row.document);
  if (visibleSiteUsers.length !== participantCount) {
    throw new Error(
      `Expected ${participantCount} visible participant users for ${siteId}, found ${visibleSiteUsers.length}.`
    );
  }

  const [
    usersCount,
    userClaimsCount,
    districtsCount,
    schoolsCount,
    classesCount,
    groupsCount,
    administrationsCount,
  ] = await Promise.all([
    runtime.countCollection("users"),
    runtime.countCollection("userClaims"),
    runtime.countCollection("districts"),
    runtime.countCollection("schools"),
    runtime.countCollection("classes"),
    runtime.countCollection("groups"),
    runtime.countCollection("administrations"),
  ]);

  const expectedUsersCount = participantCount + adminUsers.length + 1;
  const expectedCounts = {
    users: expectedUsersCount,
    userClaims: expectedUsersCount,
    districts: 1,
    schools: 1,
    classes: 2,
    groups: 1,
    administrations: createdAdministrations.length,
  };
  const actualCounts = {
    users: usersCount,
    userClaims: userClaimsCount,
    districts: districtsCount,
    schools: schoolsCount,
    classes: classesCount,
    groups: groupsCount,
    administrations: administrationsCount,
  };

  for (const [key, expected] of Object.entries(expectedCounts)) {
    if (actualCounts[key] !== expected) {
      throw new Error(
        `Expected ${expected} ${key}, found ${actualCounts[key]}.`
      );
    }
  }

  const assignmentCounts = await Promise.all(
    createdAdministrations.map(async (administration) => ({
      name: administration.name,
      count: await runtime.countAssignmentsForAdministration(administration.id),
      expected: administration.expectedAssignmentCount,
    }))
  );
  for (const assignmentCount of assignmentCounts) {
    if (assignmentCount.count !== assignmentCount.expected) {
      throw new Error(
        `Expected ${assignmentCount.expected} assignments for ${assignmentCount.name}, found ${assignmentCount.count}.`
      );
    }
  }

  return {
    ...actualCounts,
    assignmentCounts,
    totalAssignments: assignmentCounts.reduce(
      (sum, item) => sum + item.count,
      0
    ),
  };
}

module.exports = { validateDashboardVisibleData };
