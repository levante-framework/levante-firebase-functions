const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');
const { getSeedConfig } = require('./config');
const { createSystemPermissions } = require('./seeders/permissions');
const { seedRegisteredTasksFromProject } = require('./seeders/tasks-from-project');

const { projectId, isEmulator } = getSeedConfig();

if (isEmulator) {
  process.env.FIRESTORE_EMULATOR_HOST ||= '127.0.0.1:8180';
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= '127.0.0.1:9199';
}

const app = admin.initializeApp({ projectId }, 'ui-seed-bootstrap');
const sourceProjectId =
  process.env.SEED_TASK_SOURCE_PROJECT ||
  process.env.TASKS_SOURCE_PROJECT ||
  'hs-levante-admin-dev';

async function ensureSuperAdmin() {
  const auth = getAuth(app);
  const db = app.firestore();
  const email = process.env.E2E_AI_SUPER_ADMIN_EMAIL || 'superadmin@levante.test';
  const password = process.env.E2E_AI_SUPER_ADMIN_PASSWORD || 'super123';

  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
    console.log(`  Super admin auth user already exists: ${email}`);
  } catch (error) {
    if (error.code !== 'auth/user-not-found') throw error;
    userRecord = await auth.createUser({
      email,
      password,
      emailVerified: true,
      displayName: 'Super Admin User',
      disabled: false,
    });
    console.log(`  Created super admin auth user: ${email}`);
  }

  const uid = userRecord.uid;
  const roles = [{ siteId: 'any', siteName: 'Any', role: 'super_admin' }];
  await db.collection('users').doc(uid).set(
    {
      archived: false,
      assessmentUid: uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      displayName: userRecord.displayName || 'Super Admin User',
      email,
      userType: 'admin',
      testData: true,
      adminData: { administrationsCreated: [] },
      sso: 'internal',
      roles,
      username: email.split('@')[0],
    },
    { merge: true },
  );

  const authClaims = {
    admin: true,
    super_admin: true,
    adminUid: uid,
    roarUid: uid,
    useNewPermissions: true,
    rolesSet: ['super_admin'],
    siteRoles: {},
    siteNames: {},
    roles,
  };

  await auth.setCustomUserClaims(uid, authClaims);
  await db.collection('userClaims').doc(uid).set(
    {
      claims: {
        admin: true,
        super_admin: true,
        useNewPermissions: true,
      },
      lastUpdated: Date.now(),
      testData: true,
    },
    { merge: true },
  );

  console.log(`  Bootstrapped super admin: ${email}`);
}

async function main() {
  if (!isEmulator) {
    throw new Error('bootstrap-ui-seed.js only runs against the Firebase emulator.');
  }

  console.log('=== BOOTSTRAPPING EMULATOR FOR CYPRESS UI SEED ===');
  await createSystemPermissions(app);
  await ensureSuperAdmin();
  await seedRegisteredTasksFromProject({
    targetApp: app,
    sourceProjectId,
    verbose: true,
  });
  console.log('=== EMULATOR UI SEED BOOTSTRAP COMPLETE ===');
}

main().catch((error) => {
  console.error('Bootstrap failed:', error);
  process.exit(1);
});
