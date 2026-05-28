const {
  ADMIN_USERS,
  ADMINISTRATION_TEMPLATES,
  DEFAULT_LEGAL,
  ORG_FIXTURES,
  chunk,
  normalizeToLowercase,
} = require('./fixtures');

async function createOrgs({ runtime, idToken, uid, orgFixtures = ORG_FIXTURES }) {
  const { siteName, schoolName, originalClassName, newClassName, cohortName } = orgFixtures;

  const siteId = await upsertOrg(runtime, idToken, {
    name: siteName,
    normalizedName: normalizeToLowercase(siteName),
    type: 'districts',
    tags: ['function-seed', 'test'],
    createdBy: uid,
    siteId: 'any',
    subGroups: [],
  });

  const schoolId = await upsertOrg(runtime, idToken, {
    name: schoolName,
    normalizedName: normalizeToLowercase(schoolName),
    type: 'schools',
    tags: ['function-seed'],
    createdBy: uid,
    siteId,
    districtId: siteId,
  });

  const originalClassId = await upsertOrg(runtime, idToken, {
    name: originalClassName,
    normalizedName: normalizeToLowercase(originalClassName),
    type: 'classes',
    tags: ['function-seed', 'third-grade'],
    createdBy: uid,
    siteId,
    districtId: siteId,
    schoolId,
  });

  const newClassId = await upsertOrg(runtime, idToken, {
    name: newClassName,
    normalizedName: normalizeToLowercase(newClassName),
    type: 'classes',
    tags: ['function-seed', 'fourth-grade'],
    createdBy: uid,
    siteId,
    districtId: siteId,
    schoolId,
  });

  const cohortId = await upsertOrg(runtime, idToken, {
    name: cohortName,
    normalizedName: normalizeToLowercase(cohortName),
    type: 'groups',
    tags: ['function-seed', 'reading'],
    createdBy: uid,
    siteId,
    parentOrgId: siteId,
    parentOrgType: 'district',
  });

  return {
    siteId,
    schoolId,
    originalClassId,
    newClassId,
    cohortId,
    siteName,
    schoolName,
    originalClassName,
    newClassName,
    cohortName,
  };
}

async function upsertOrg(runtime, idToken, data) {
  const result = await runtime.callFunction('upsertOrg', data, idToken);
  if (result?.status !== 'ok' || !result?.orgId) {
    throw new Error(`upsertOrg returned an unexpected response: ${JSON.stringify(result)}`);
  }
  return result.orgId;
}

async function createAdminUsers({ runtime, idToken, siteId, siteName, adminUsers = ADMIN_USERS }) {
  const createdAdmins = [];

  for (const adminUser of adminUsers) {
    const result = await runtime.callFunction(
      'createAdministrator',
      {
        email: adminUser.email,
        name: adminUser.name,
        roles: [{ role: adminUser.role, siteId, siteName }],
        isTestData: false,
      },
      idToken,
    );
    createdAdmins.push({ ...adminUser, uid: result?.adminUid });
  }

  return createdAdmins;
}

async function createParticipantUsers({ runtime, userRows, siteId, idToken }) {
  const createdUsers = [];

  for (const rows of chunk(userRows, 25)) {
    const result = await runtime.callFunction('createUsers', { users: rows, siteId }, idToken);
    if (!Array.isArray(result?.data) || result.data.length !== rows.length) {
      throw new Error(`createUsers returned an unexpected response: ${JSON.stringify(result)}`);
    }
    createdUsers.push(...result.data);
  }

  return createdUsers;
}

async function linkParticipantUsers({ runtime, userRows, createdUsers, siteId, idToken }) {
  const createdUserBySeedId = new Map(userRows.map((row, index) => [row.id, createdUsers[index]]));

  await runtime.callFunction(
    'linkUsers',
    {
      siteId,
      users: userRows.map((row) => ({
        id: row.id,
        userType: row.userType,
        uid: createdUserBySeedId.get(row.id)?.uid,
        ...(row.userType === 'child' && {
          parentId: 'parent',
          teacherId: 'teacher',
          month: Number(row.month),
          year: Number(row.year),
        }),
      })),
    },
    idToken,
  );
}

function buildAdministrationAssessments({ template, variantsByTaskId }) {
  return template.taskIds.map((taskId) => {
    const variant = variantsByTaskId[taskId];
    if (!variant) throw new Error(`Missing seeded registered variant for task ${taskId}`);

    return {
      taskId,
      variantId: variant.variantId,
      variantName: variant.variantName,
      params: variant.params,
      // TODO: remove when task-level assignment conditions are read from task documents.
      ...(template.assignedCondition && {
        conditions: { assigned: template.assignedCondition },
      }),
    };
  });
}

async function createAdministrations({
  runtime,
  idToken,
  siteId,
  schoolId,
  classIds,
  cohortId,
  creatorName,
  studentCount,
  includeOptionalAdministrationTemplates = false,
  administrationTemplates = ADMINISTRATION_TEMPLATES,
}) {
  const templates = includeOptionalAdministrationTemplates
    ? administrationTemplates
    : administrationTemplates.filter((template) => !template.optional);
  const allTaskIds = Array.from(new Set(templates.flatMap((template) => template.taskIds)));
  const variantsByTaskId = await runtime.getVariantsByTaskIds(allTaskIds, idToken);
  const createdAdministrations = [];
  const now = new Date();

  for (const template of templates) {
    const missingTasks = template.taskIds.filter((taskId) => !variantsByTaskId[taskId]);
    if (missingTasks.length > 0) {
      console.log(
        `Skipping administration template ${template.templateId}; missing registered variants for: ${missingTasks.join(', ')}`,
      );
      continue;
    }

    const closeDate = new Date(now.getTime() + template.daysToClose * 24 * 60 * 60 * 1000);
    const result = await runtime.callFunction(
      'upsertAdministration',
      {
        name: template.name,
        normalizedName: normalizeToLowercase(template.name),
        assessments: buildAdministrationAssessments({ template, variantsByTaskId }),
        dateOpen: now.toISOString(),
        dateClose: closeDate.toISOString(),
        sequential: template.sequential,
        orgs: {
          districts: [siteId],
          schools: [schoolId],
          classes: classIds,
          groups: [cohortId],
        },
        isTestData: false,
        legal: DEFAULT_LEGAL,
        creatorName,
        siteId,
      },
      idToken,
    );

    if (!result?.administrationId) {
      throw new Error(`upsertAdministration returned an unexpected response: ${JSON.stringify(result)}`);
    }

    const expectedAssignmentCount = template.assignedCondition ? studentCount + 1 : studentCount + 3;
    await waitForAssignmentSync({
      runtime,
      administrationId: result.administrationId,
      expectedCount: expectedAssignmentCount,
    });

    createdAdministrations.push({
      ...template,
      id: result.administrationId,
      expectedAssignmentCount,
    });
  }

  return createdAdministrations;
}

async function waitForAssignmentSync({ runtime, administrationId, expectedCount }) {
  const startedAt = Date.now();
  const timeoutMs = 120_000;

  while (Date.now() - startedAt < timeoutMs) {
    const syncedCount = await runtime.countAssignmentsForAdministration(administrationId);
    if (syncedCount === expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for assignment ${administrationId} to sync to ${expectedCount} users.`);
}

module.exports = {
  createAdminUsers,
  createAdministrations,
  createOrgs,
  createParticipantUsers,
  linkParticipantUsers,
};
