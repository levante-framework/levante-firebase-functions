import { describe, test, beforeAll, afterAll, beforeEach } from 'vitest';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import * as fs from 'fs';

describe('Firestore security rules (levante-admin)', () => {
  let testEnv: import('@firebase/rules-unit-testing').RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-emulator',
      firestore: {
        rules: fs.readFileSync('functions/levante-admin/firestore.rules', 'utf8'),
      },
    });
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  test('legal docs are publicly readable', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().doc('legal/terms').set({ version: 1 });
    });

    const unauthed = testEnv.unauthenticatedContext();
    await assertSucceeds(unauthed.firestore().doc('legal/terms').get());
  });

  describe('userClaims', () => {
    test('can read own userClaims doc; cannot read others; cannot write', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/alice')
          .set({ claims: { admin: false } });
        await ctx
          .firestore()
          .doc('userClaims/bob')
          .set({ claims: { admin: false } });
      });

      const alice = testEnv.authenticatedContext('alice');
      await assertSucceeds(alice.firestore().doc('userClaims/alice').get());
      await assertFails(alice.firestore().doc('userClaims/bob').get());
      await assertFails(alice.firestore().doc('userClaims/alice').set({ claims: {} }));
    });
  });

  describe('system/permissions', () => {
    test('read requires auth; write denied', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('system/permissions').set({ permissions: {} });
      });

      const unauthed = testEnv.unauthenticatedContext();
      await assertFails(unauthed.firestore().doc('system/permissions').get());

      const alice = testEnv.authenticatedContext('alice');
      await assertSucceeds(alice.firestore().doc('system/permissions').get());
      await assertFails(alice.firestore().doc('system/permissions').set({}));
    });
  });

  describe('users collection (legacy permissions by default)', () => {
    test('a user can read their own user document', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('users/alice').set({ userType: 'student' });
      });

      const alice = testEnv.authenticatedContext('alice');
      await assertSucceeds(alice.firestore().doc('users/alice').get());
    });

    test('a parent can read their child user document', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().doc('users/parent1').set({ userType: 'parent' });
        await ctx
          .firestore()
          .doc('users/child1')
          .set({
            userType: 'student',
            parentIds: ['parent1'],
          });
      });

      const parent = testEnv.authenticatedContext('parent1');
      await assertSucceeds(parent.firestore().doc('users/child1').get());
    });

    test('an org admin can read a user in their district (legacy adminOrgs)', async () => {
      // Requesting user is admin for district d1 via userClaims.adminOrgs
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
        await ctx
          .firestore()
          .doc('users/u1')
          .set({
            userType: 'student',
            districts: { current: ['d1'] },
          });
      });

      const admin = testEnv.authenticatedContext('admin1');
      await assertSucceeds(admin.firestore().doc('users/u1').get());
    });

    test('create user allowed for admin of provided org with valid fields', async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        // Make the requester an admin of district d1
        await ctx
          .firestore()
          .doc('userClaims/admin2')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = testEnv.authenticatedContext('admin2');
      await assertSucceeds(
        admin
          .firestore()
          .doc('users/newUser')
          .set({
            userType: 'student',
            name: 'New Student',
            districts: { current: ['d1'] },
          }),
      );

      // Invalid: include disallowed field 'archived'
      await assertFails(
        admin
          .firestore()
          .doc('users/newUser2')
          .set({
            userType: 'student',
            name: 'Bad Student',
            districts: { current: ['d1'] },
            archived: true,
          }),
      );
    });
  });
});
