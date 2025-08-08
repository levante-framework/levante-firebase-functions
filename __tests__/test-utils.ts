import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import * as fs from 'fs';

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
