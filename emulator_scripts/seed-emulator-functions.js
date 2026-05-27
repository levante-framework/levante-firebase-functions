const { getSeedConfig } = require('./config');
const admin = require('firebase-admin');
const { seedRegisteredTasksFromProject } = require('./seeders/tasks-from-project');

const { projectId, isEmulator } = getSeedConfig();

if (!isEmulator) {
  throw new Error('seed-emulator-functions.js only runs against the Firebase emulator.');
}

const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199';
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8180';
const functionsOrigin =
  process.env.FUNCTIONS_EMULATOR_ORIGIN || `http://127.0.0.1:${process.env.FIREBASE_FUNCTIONS_EMULATOR_PORT || '5002'}`;
const superAdminEmail = process.env.E2E_AI_SUPER_ADMIN_EMAIL || 'superadmin@levante.test';
const superAdminPassword = process.env.E2E_AI_SUPER_ADMIN_PASSWORD || 'super123';
const sourceProjectId =
  process.env.SEED_TASK_SOURCE_PROJECT ||
  process.env.TASKS_SOURCE_PROJECT ||
  'hs-levante-admin-dev';
const validationApp = admin.initializeApp({ projectId }, 'functions-seed-validation');

const ADMIN_USERS = [
  {
    key: 'admin',
    email: 'admin@levante.test',
    name: { first: 'Admin', middle: '', last: 'User' },
    role: 'admin',
  },
  {
    key: 'siteAdmin',
    email: 'siteadmin@levante.test',
    name: { first: 'Site Admin', middle: '', last: 'User' },
    role: 'site_admin',
  },
  {
    key: 'researchAssistant',
    email: 'ra@levante.test',
    name: { first: 'Research Assistant', middle: '', last: 'User' },
    role: 'research_assistant',
  },
];

const ADMINISTRATION_TEMPLATES = [
  {
    templateId: 'reading-assessment-1',
    name: 'Basic Reading Assessment',
    publicName: 'Reading Skills Evaluation',
    taskIds: ['pa', 'sre', 'swr'],
    sequential: false,
    tags: ['reading', 'literacy', 'basic'],
    daysToClose: 30,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'cognitive-assessment-1',
    name: 'Cognitive Assessment Battery',
    publicName: 'Thinking Skills Assessment',
    taskIds: ['matrix-reasoning', 'mental-rotation', 'memory-game'],
    sequential: false,
    tags: ['cognitive', 'reasoning', 'memory'],
    daysToClose: 21,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'comprehensive-assessment-1',
    name: 'Comprehensive Academic Assessment',
    publicName: 'Complete Learning Evaluation',
    taskIds: ['vocab', 'egma-math', 'trog', 'theory-of-mind'],
    sequential: false,
    tags: ['comprehensive', 'academic', 'language'],
    daysToClose: 45,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'executive-function-assessment',
    name: 'Executive Function Assessment',
    publicName: 'Focus and Control Skills Test',
    taskIds: ['hearts-and-flowers', 'MEFS', 'same-different-selection'],
    sequential: false,
    tags: ['executive-function', 'attention', 'control'],
    daysToClose: 14,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'mixed-assessment-battery',
    name: 'Mixed Skills Assessment',
    publicName: 'General Skills Evaluation',
    taskIds: ['intro', 'pa', 'matrix-reasoning', 'vocab'],
    sequential: false,
    tags: ['mixed', 'general', 'evaluation'],
    daysToClose: 60,
    assignedCondition: { field: 'userType', op: 'EQUAL', value: 'student' },
  },
  {
    templateId: 'survey-administration',
    name: 'Background Survey',
    publicName: 'Background Information Survey',
    taskIds: ['survey'],
    sequential: true,
    tags: ['survey', 'background', 'information'],
    daysToClose: 90,
  },
];

const DEFAULT_LEGAL = {
  amount: '0',
  assent: null,
  consent: 'I consent to the terms of the Levante Privacy Policy and Terms of Service.',
  expectedTime: '30 minutes',
};

function normalizeToLowercase(value = '') {
  return value.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
}

function chunk(array, size) {
  const chunks = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
}

async function requestJson(url, options) {
  try {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.error) {
      const error = new Error(`${options.method || 'GET'} ${url} failed: ${response.status} ${JSON.stringify(body)}`);
      error.status = response.status;
      error.body = body;
      throw error;
    }
    return body;
  } catch (error) {
    error.url = url;
    throw error;
  }
}

async function signIn() {
  const body = await requestJson(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=emulator-key`,
    {
      method: 'POST',
      body: JSON.stringify({
        email: superAdminEmail,
        password: superAdminPassword,
        returnSecureToken: true,
      }),
    },
  );

  return {
    idToken: body.idToken,
    uid: body.localId,
  };
}

async function callFunction(name, data, idToken) {
  const url = `${functionsOrigin}/${projectId}/us-central1/${name}`;
  const startedAt = Date.now();

  while (true) {
    try {
      const body = await requestJson(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ data }),
      });
      return body.result;
    } catch (error) {
      const isFunctionsStartupRace = error.status === 404 || error.cause?.code === 'ECONNREFUSED';
      if (!isFunctionsStartupRace || Date.now() - startedAt > 60_000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

function firestoreValueToJs(value) {
  if (!value || typeof value !== 'object') return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(firestoreValueToJs);
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, nestedValue]) => [key, firestoreValueToJs(nestedValue)]),
    );
  }
  return undefined;
}

async function runFirestoreQuery(body, idToken) {
  return requestJson(
    `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(body),
    },
  );
}

async function runFirestoreAggregationQuery(body, idToken) {
  return requestJson(
    `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents:runAggregationQuery`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(body),
    },
  );
}

async function countCollection(collectionId, idToken) {
  const snapshot = await validationApp.firestore().collection(collectionId).get();
  return snapshot.size;
}

async function countAssignmentsForAdministration(administrationId, idToken) {
  const snapshot = await validationApp
    .firestore()
    .collectionGroup('assignments')
    .where('id', '==', administrationId)
    .get();
  return snapshot.size;
}

async function getFirstVariant(taskId, idToken) {
  const body = await requestJson(
    `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents/tasks/${encodeURIComponent(
      taskId,
    )}/variants?pageSize=1`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    },
  );

  const document = body.documents?.[0];
  if (!document) throw new Error(`No seeded variant found for task ${taskId}`);

  return {
    variantId: document.name.split('/').pop(),
    variantName: firestoreValueToJs(document.fields?.name) || 'en',
    params: firestoreValueToJs(document.fields?.params) || {},
  };
}

async function getVariantsByTaskIds(taskIds, idToken) {
  const entries = await Promise.all(taskIds.map(async (taskId) => [taskId, await getFirstVariant(taskId, idToken)]));
  return Object.fromEntries(entries);
}

async function getDocument(path, idToken) {
  const response = await fetch(`http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents/${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${idToken}` },
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

async function waitForAssignmentSync({ administrationId, expectedCount, idToken }) {
  const startedAt = Date.now();
  const timeoutMs = 120_000;

  while (Date.now() - startedAt < timeoutMs) {
    const syncedCount = await countAssignmentsForAdministration(administrationId, idToken);
    if (syncedCount === expectedCount) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(`Timed out waiting for assignment ${administrationId} to sync to ${expectedCount} users.`);
}

async function upsertOrg(idToken, data) {
  const result = await callFunction('upsertOrg', data, idToken);
  if (result?.status !== 'ok' || !result?.orgId) {
    throw new Error(`upsertOrg returned an unexpected response: ${JSON.stringify(result)}`);
  }
  return result.orgId;
}

async function createAdminUsers({ idToken, siteId, siteName }) {
  const createdAdmins = [];

  for (const adminUser of ADMIN_USERS) {
    const result = await callFunction(
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

function buildParticipantRows({ siteId, schoolId, originalClassId, newClassId, cohortId }) {
  const baseOrgIds = {
    districts: [siteId],
    schools: [schoolId],
    groups: [cohortId],
    families: [],
  };

  const rowForClass = (row, classId) => ({
    ...row,
    orgIds: {
      ...baseOrgIds,
      classes: [classId],
    },
    isTestData: false,
  });

  return [
    rowForClass(
      {
        id: 'teacher',
        userType: 'teacher',
        month: '',
        year: '',
      },
      originalClassId,
    ),
    rowForClass(
      {
        id: 'student',
        userType: 'child',
        month: '1',
        year: '2018',
      },
      originalClassId,
    ),
    rowForClass(
      {
        id: 'parent',
        userType: 'parent',
        month: '',
        year: '',
      },
      newClassId,
    ),
    ...Array.from({ length: 200 }, (_, index) => {
      const studentNumber = index + 1;
      return rowForClass(
        {
          id: `student${studentNumber}`,
          userType: 'child',
          month: String((studentNumber % 12) + 1),
          year: '2018',
        },
        studentNumber <= 100 ? newClassId : originalClassId,
      );
    }),
  ];
}

async function createParticipantUsers({ userRows, siteId, idToken }) {
  const createdUsers = [];

  for (const rows of chunk(userRows, 25)) {
    const result = await callFunction('createUsers', { users: rows, siteId }, idToken);
    if (!Array.isArray(result?.data) || result.data.length !== rows.length) {
      throw new Error(`createUsers returned an unexpected response: ${JSON.stringify(result)}`);
    }
    createdUsers.push(...result.data);
  }

  return createdUsers;
}

async function linkParticipantUsers({ userRows, createdUsers, siteId, idToken }) {
  const createdUserBySeedId = new Map(userRows.map((row, index) => [row.id, createdUsers[index]]));

  await callFunction(
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
    if (!variant) throw new Error(`Missing variant for task ${taskId}`);

    return {
      taskId,
      variantId: variant.variantId,
      variantName: variant.variantName,
      params: variant.params,
      ...(template.assignedCondition && {
        conditions: { assigned: template.assignedCondition },
      }),
    };
  });
}

async function createAdministrations({ idToken, siteId, schoolId, classIds, cohortId, creatorName }) {
  const allTaskIds = Array.from(new Set(ADMINISTRATION_TEMPLATES.flatMap((template) => template.taskIds)));
  const variantsByTaskId = await getVariantsByTaskIds(allTaskIds, idToken);
  const createdAdministrations = [];
  const now = new Date();

  for (const template of ADMINISTRATION_TEMPLATES) {
    const closeDate = new Date(now.getTime() + template.daysToClose * 24 * 60 * 60 * 1000);
    const result = await callFunction(
      'upsertAdministration',
      {
        name: template.name,
        publicName: template.publicName,
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
        tags: template.tags,
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

    const expectedAssignmentCount = template.templateId === 'survey-administration' ? 203 : 201;
    await waitForAssignmentSync({
      administrationId: result.administrationId,
      expectedCount: expectedAssignmentCount,
      idToken,
    });

    createdAdministrations.push({
      ...template,
      id: result.administrationId,
      expectedAssignmentCount,
    });
  }

  return createdAdministrations;
}

async function validateDashboardVisibleData({ siteId, createdAdministrations, idToken }) {
  const administrationsResult = await callFunction(
    'getAdministrations',
    { testData: false, idsOnly: false },
    idToken,
  );
  const administrations = Array.isArray(administrationsResult) ? administrationsResult : administrationsResult?.data;

  if (!Array.isArray(administrations)) {
    throw new Error(`getAdministrations returned an unexpected response: ${JSON.stringify(administrationsResult)}`);
  }

  const missingAdministrationIds = createdAdministrations
    .map((administration) => administration.id)
    .filter((administrationId) => !administrations.some((admin) => admin.id === administrationId));
  if (missingAdministrationIds.length > 0) {
    throw new Error(`Seeded administrations are not visible: ${missingAdministrationIds.join(', ')}`);
  }

  const siteUsers = await runFirestoreQuery(
    {
      structuredQuery: {
        from: [{ collectionId: 'users' }],
        where: {
          fieldFilter: {
            field: { fieldPath: 'districts.current' },
            op: 'ARRAY_CONTAINS',
            value: { stringValue: siteId },
          },
        },
      },
    },
    idToken,
  );
  const visibleSiteUsers = siteUsers.filter((row) => row.document);
  if (visibleSiteUsers.length !== 203) {
    throw new Error(`Expected 203 visible participant users for ${siteId}, found ${visibleSiteUsers.length}.`);
  }

  const [usersCount, userClaimsCount, districtsCount, schoolsCount, classesCount, groupsCount, administrationsCount] =
    await Promise.all([
      countCollection('users', idToken),
      countCollection('userClaims', idToken),
      countCollection('districts', idToken),
      countCollection('schools', idToken),
      countCollection('classes', idToken),
      countCollection('groups', idToken),
      countCollection('administrations', idToken),
    ]);

  const expectedCounts = {
    users: 207,
    userClaims: 207,
    districts: 1,
    schools: 1,
    classes: 2,
    groups: 1,
    administrations: 6,
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
      throw new Error(`Expected ${expected} ${key}, found ${actualCounts[key]}.`);
    }
  }

  const assignmentCounts = await Promise.all(
    createdAdministrations.map(async (administration) => ({
      name: administration.name,
      count: await countAssignmentsForAdministration(administration.id, idToken),
      expected: administration.expectedAssignmentCount,
    })),
  );
  for (const assignmentCount of assignmentCounts) {
    if (assignmentCount.count !== assignmentCount.expected) {
      throw new Error(
        `Expected ${assignmentCount.expected} assignments for ${assignmentCount.name}, found ${assignmentCount.count}.`,
      );
    }
  }

  return {
    ...actualCounts,
    assignmentCounts,
    totalAssignments: assignmentCounts.reduce((sum, item) => sum + item.count, 0),
  };
}

async function main() {
  console.log('=== STARTING FUNCTIONS-DRIVEN EMULATOR SEED ===');
  await seedRegisteredTasksFromProject({
    targetApp: validationApp,
    sourceProjectId,
    verbose: true,
  });
  const { idToken, uid } = await signIn();

  console.log('Calling setUidClaims as seeded super admin...');
  await callFunction('setUidClaims', {}, idToken);

  console.log('Creating visible org fixtures through upsertOrg...');
  const siteName = 'Function Seed District';
  const schoolName = 'Function Seed Elementary School';
  const originalClassName = '3rd Grade - Room 101';
  const newClassName = '4th Grade - Room 102';
  const cohortName = 'Reading Intervention Cohort';

  const siteId = await upsertOrg(idToken, {
    name: siteName,
    normalizedName: normalizeToLowercase(siteName),
    type: 'districts',
    tags: ['function-seed', 'test'],
    createdBy: uid,
    siteId: 'any',
    subGroups: [],
  });

  const schoolId = await upsertOrg(idToken, {
    name: schoolName,
    normalizedName: normalizeToLowercase(schoolName),
    type: 'schools',
    tags: ['function-seed'],
    createdBy: uid,
    siteId,
    districtId: siteId,
  });

  const originalClassId = await upsertOrg(idToken, {
    name: originalClassName,
    normalizedName: normalizeToLowercase(originalClassName),
    type: 'classes',
    tags: ['function-seed', 'third-grade'],
    createdBy: uid,
    siteId,
    districtId: siteId,
    schoolId,
  });

  const newClassId = await upsertOrg(idToken, {
    name: newClassName,
    normalizedName: normalizeToLowercase(newClassName),
    type: 'classes',
    tags: ['function-seed', 'fourth-grade'],
    createdBy: uid,
    siteId,
    districtId: siteId,
    schoolId,
  });

  const cohortId = await upsertOrg(idToken, {
    name: cohortName,
    normalizedName: normalizeToLowercase(cohortName),
    type: 'groups',
    tags: ['function-seed', 'reading'],
    createdBy: uid,
    siteId,
    parentOrgId: siteId,
    parentOrgType: 'district',
  });

  console.log('Creating administrator users through createAdministrator...');
  const createdAdmins = await createAdminUsers({ idToken, siteId, siteName });

  console.log('Creating participant users through createUsers...');
  const userRows = buildParticipantRows({
    siteId,
    schoolId,
    originalClassId,
    newClassId,
    cohortId,
  });
  const createdUsers = await createParticipantUsers({ userRows, siteId, idToken });

  console.log('Linking participant users through linkUsers...');
  await linkParticipantUsers({ userRows, createdUsers, siteId, idToken });

  console.log('Creating administrations through upsertAdministration...');
  const createdAdministrations = await createAdministrations({
    idToken,
    siteId,
    schoolId,
    classIds: [originalClassId, newClassId],
    cohortId,
    creatorName: 'Super Admin User',
  });

  const validationSummary = await validateDashboardVisibleData({
    siteId,
    createdAdministrations,
    idToken,
  });

  console.log('=== FUNCTIONS-DRIVEN EMULATOR SEED COMPLETE ===');
  console.log(`Site:              ${siteName} (${siteId})`);
  console.log(`School:            ${schoolName} (${schoolId})`);
  console.log(`Classes:           ${originalClassName} (${originalClassId}), ${newClassName} (${newClassId})`);
  console.log(`Cohort:            ${cohortName} (${cohortId})`);
  console.log(`Admin users:       ${createdAdmins.length + 1} including bootstrapped super admin`);
  console.log(`Participant users: ${createdUsers.length}`);
  console.log(`Firestore users:   ${validationSummary.users}`);
  console.log(`UserClaims docs:   ${validationSummary.userClaims}`);
  console.log(`Administrations:   ${validationSummary.administrations}`);
  console.log(`Assignment docs:   ${validationSummary.totalAssignments}`);
  validationSummary.assignmentCounts.forEach((assignmentCount) => {
    console.log(`- ${assignmentCount.name}: ${assignmentCount.count}`);
  });
}

main().catch((error) => {
  console.error('\n❌ FUNCTIONS-DRIVEN EMULATOR SEED FAILED');
  console.error(error);
  process.exit(1);
});
