import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import * as fs from 'fs';
import * as admin from 'firebase-admin';

export async function createTestEnvironment() {
  return await initializeTestEnvironment({
    projectId: 'demo-emulator',
    firestore: {
      rules: fs.readFileSync('functions/levante-admin/firestore.rules', 'utf8'),
    },
  });
}

export async function setupTestData(testEnv: any, setupFn: (ctx: any) => Promise<void>) {
  await testEnv.withSecurityRulesDisabled(setupFn);
}

export function createUserWithClaims(testEnv: any, uid: string, claims: any = {}) {
  return testEnv.authenticatedContext(uid, claims);
}

export function createUnauthenticatedContext(testEnv: any) {
  return testEnv.unauthenticatedContext();
}

export function initAdminEmulators() {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8180';
  process.env.FIREBASE_AUTH_EMULATOR_HOST =
    process.env.FIREBASE_AUTH_EMULATOR_HOST || '127.0.0.1:9199';
  process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-emulator';

  if (admin.apps.length === 0) {
    admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  }

  return {
    auth: admin.auth(),
    db: admin.firestore(),
  };
}
