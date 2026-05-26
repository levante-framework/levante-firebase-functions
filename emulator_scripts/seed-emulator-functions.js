const { getSeedConfig } = require('./config');

const { projectId, isEmulator } = getSeedConfig();

if (!isEmulator) {
  throw new Error('seed-emulator-functions.js only runs against the Firebase emulator.');
}

const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199';
const firestoreHost = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8180';
const functionsOrigin = process.env.FUNCTIONS_EMULATOR_ORIGIN || `http://127.0.0.1:${process.env.FIREBASE_FUNCTIONS_EMULATOR_PORT || '5002'}`;
const superAdminEmail = process.env.E2E_AI_SUPER_ADMIN_EMAIL || 'superadmin@levante.test';
const superAdminPassword = process.env.E2E_AI_SUPER_ADMIN_PASSWORD || 'super123';

function normalizeToLowercase(value = '') {
  return value.trim().toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
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
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(firestoreValueToJs);
  if ('mapValue' in value) {
    return Object.fromEntries(
      Object.entries(value.mapValue.fields || {}).map(([key, nestedValue]) => [key, firestoreValueToJs(nestedValue)]),
    );
  }
  return undefined;
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

async function getDocument(path, idToken) {
  const response = await fetch(
    `http://${firestoreHost}/v1/projects/${projectId}/databases/(default)/documents/${path}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${idToken}` },
    },
  );

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
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

async function waitForAssignmentSync({ administrationId, userIds, idToken }) {
  const startedAt = Date.now();
  const timeoutMs = 30_000;

  while (Date.now() - startedAt < timeoutMs) {
    const documents = await Promise.all(
      userIds.map((userId) => getDocument(`users/${userId}/assignments/${administrationId}`, idToken)),
    );
    const allSynced = documents.every((document) => document?.fields?.syncStatus?.stringValue === 'complete');
    if (allSynced) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for assignment ${administrationId} to sync to ${userIds.length} users.`);
}

async function validateDashboardVisibleData({ administrationId, siteId, expectedUserCount, idToken }) {
  const administrationsResult = await callFunction(
    'getAdministrations',
    { testData: false, idsOnly: false },
    idToken,
  );
  const administrations = Array.isArray(administrationsResult) ? administrationsResult : administrationsResult?.data;

  if (!Array.isArray(administrations) || !administrations.some((admin) => admin.id === administrationId)) {
    throw new Error(
      `Seeded administration ${administrationId} is not visible through getAdministrations(testData=false).`,
    );
  }

  const userRows = await runFirestoreQuery(
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
  const visibleUsers = userRows.filter((row) => row.document);

  if (visibleUsers.length !== expectedUserCount) {
    throw new Error(`Expected ${expectedUserCount} visible users for ${siteId}, found ${visibleUsers.length}.`);
  }
}

async function upsertOrg(idToken, data) {
  const result = await callFunction('upsertOrg', data, idToken);
  if (result?.status !== 'ok' || !result?.orgId) {
    throw new Error(`upsertOrg returned an unexpected response: ${JSON.stringify(result)}`);
  }
  return result.orgId;
}

async function main() {
  console.log('=== STARTING FUNCTIONS-DRIVEN EMULATOR SEED ===');
  const { idToken, uid } = await signIn();

  console.log('Calling setUidClaims as seeded super admin...');
  await callFunction('setUidClaims', {}, idToken);

  console.log('Creating visible org fixtures through upsertOrg...');
  const siteName = 'Function Seed District';
  const schoolName = 'Function Seed Elementary School';
  const className = 'Function Seed Class - Room 201';
  const cohortName = 'Function Seed Reading Cohort';

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

  const classId = await upsertOrg(idToken, {
    name: className,
    normalizedName: normalizeToLowercase(className),
    type: 'classes',
    tags: ['function-seed'],
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

  console.log('Creating users through createUsers...');
  const orgIds = { districts: [siteId], schools: [schoolId], classes: [classId], groups: [cohortId], families: [] };
  const userRows = [
    ...Array.from({ length: 8 }, (_, index) => ({
      id: `function_seed_child_${index + 1}`,
      userType: 'child',
      month: String((index % 12) + 1),
      year: String(2016 + (index % 3)),
      orgIds,
      isTestData: false,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      id: `function_seed_parent_${index + 1}`,
      userType: 'parent',
      month: '',
      year: '',
      orgIds,
      isTestData: false,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      id: `function_seed_teacher_${index + 1}`,
      userType: 'teacher',
      month: '',
      year: '',
      orgIds,
      isTestData: false,
    })),
  ];

  const createUsersResult = await callFunction('createUsers', { users: userRows, siteId }, idToken);
  const createdUsers = createUsersResult?.data;
  if (!Array.isArray(createdUsers) || createdUsers.length !== userRows.length) {
    throw new Error(`createUsers returned an unexpected response: ${JSON.stringify(createUsersResult)}`);
  }

  console.log('Linking users through linkUsers...');
  const createdUserBySeedId = new Map(userRows.map((row, index) => [row.id, createdUsers[index]]));
  const parentIds = ['function_seed_parent_1', 'function_seed_parent_2'];
  const teacherIds = ['function_seed_teacher_1', 'function_seed_teacher_2'];
  await callFunction(
    'linkUsers',
    {
      siteId,
      users: userRows.map((row, index) => {
        const linkedParentId = parentIds[index < 4 ? 0 : 1];
        const linkedTeacherId = teacherIds[index < 4 ? 0 : 1];
        return {
          id: row.id,
          userType: row.userType,
          uid: createdUserBySeedId.get(row.id)?.uid,
          ...(row.userType === 'child' && {
            parentId: linkedParentId,
            teacherId: linkedTeacherId,
            month: Number(row.month),
            year: Number(row.year),
          }),
        };
      }),
    },
    idToken,
  );

  console.log('Creating administration through upsertAdministration...');
  const variant = await getFirstVariant('intro', idToken);
  const now = new Date();
  const closeDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const administrationName = 'Function Seed Intro Assignment';

  const administrationResult = await callFunction(
    'upsertAdministration',
    {
      name: administrationName,
      publicName: administrationName,
      normalizedName: normalizeToLowercase(administrationName),
      assessments: [
        {
          taskId: 'intro',
          variantId: variant.variantId,
          variantName: variant.variantName,
          params: variant.params,
        },
      ],
      dateOpen: now.toISOString(),
      dateClose: closeDate.toISOString(),
      sequential: false,
      orgs: {
        districts: [siteId],
        schools: [schoolId],
        classes: [classId],
        groups: [cohortId],
      },
      isTestData: false,
      legal: {
        consent: null,
        assent: null,
        amount: '',
        expectedTime: '',
      },
      creatorName: 'Super Admin User',
      siteId,
    },
    idToken,
  );

  if (administrationResult?.administrationId) {
    await waitForAssignmentSync({
      administrationId: administrationResult.administrationId,
      userIds: createdUsers.map((user) => user.uid),
      idToken,
    });
    await validateDashboardVisibleData({
      administrationId: administrationResult.administrationId,
      siteId,
      expectedUserCount: createdUsers.length,
      idToken,
    });
  }

  console.log('=== FUNCTIONS-DRIVEN EMULATOR SEED COMPLETE ===');
  console.log(`Site:           ${siteName} (${siteId})`);
  console.log(`School:         ${schoolName} (${schoolId})`);
  console.log(`Class:          ${className} (${classId})`);
  console.log(`Cohort:         ${cohortName} (${cohortId})`);
  console.log(`Administration: ${administrationName} (${administrationResult?.administrationId || 'created'})`);
  console.log(`Created users (${createdUsers.length}):`);
  createdUsers.forEach((user, index) => {
    console.log(`- ${userRows[index].userType}: ${user.email} (password: ${user.password})`);
  });
}

main().catch((error) => {
  console.error('\n❌ FUNCTIONS-DRIVEN EMULATOR SEED FAILED');
  console.error(error);
  process.exit(1);
});
