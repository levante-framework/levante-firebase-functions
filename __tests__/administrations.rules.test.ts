import { describe, test, beforeAll, afterAll, beforeEach } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { createTestEnvironment, setupTestData, createUserWithClaims } from './test-utils';

describe('Administrations', () => {
  let testEnv: import('@firebase/rules-unit-testing').RulesTestEnvironment;

  beforeAll(async () => {
    testEnv = await createTestEnvironment();
  });

  afterAll(async () => {
    if (testEnv) {
      await testEnv.cleanup();
    }
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
  });

  describe('administration creation', () => {
    test('admin can create administration for their org', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(
        admin
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'admin1',
          }),
      );
    });

    test('admin cannot create administration for org they do not admin', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertFails(
        admin
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d2'],
            createdBy: 'admin1',
          }),
      );
    });

    test('admin cannot create administration with wrong createdBy', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertFails(
        admin
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'someoneElse',
          }),
      );
    });

    test('school admin can create administration for their school', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { schools: ['s1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(
        admin
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'School Administration',
            schools: ['s1'],
            createdBy: 'admin1',
          }),
      );
    });

    test('class admin can create administration for their class', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { classes: ['c1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(
        admin
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Class Administration',
            classes: ['c1'],
            createdBy: 'admin1',
          }),
      );
    });

    test('group admin can create administration for their group', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { groups: ['g1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(
        admin
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Group Administration',
            groups: ['g1'],
            createdBy: 'admin1',
          }),
      );
    });
  });

  describe('administration reading', () => {
    test('user assigned to administration can read it', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'admin1',
          });
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            districts: { current: ['d1'] },
          });
      });

      const student = createUserWithClaims(testEnv, 'student1');
      await assertSucceeds(student.firestore().doc('administrations/admin1').get());
    });

    test('user not assigned to administration cannot read it', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'admin1',
          });
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            districts: { current: ['d2'] },
          });
      });

      const student = createUserWithClaims(testEnv, 'student1');
      await assertFails(student.firestore().doc('administrations/admin1').get());
    });

    test('creator can read administration they created', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'admin1',
          });
      });

      const creator = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(creator.firestore().doc('administrations/admin1').get());
    });

    test('admin for org can read administration', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'creator1',
          });
        await ctx
          .firestore()
          .doc('userClaims/admin2')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin2');
      await assertSucceeds(admin.firestore().doc('administrations/admin1').get());
    });

    test('user assigned to school can read district administration', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            schools: ['s1'],
            createdBy: 'admin1',
          });
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            schools: { current: ['s1'] },
          });
      });

      const student = createUserWithClaims(testEnv, 'student1');
      await assertSucceeds(student.firestore().doc('administrations/admin1').get());
    });

    test('user assigned to class can read class administration', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            classes: ['c1'],
            createdBy: 'admin1',
          });
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            classes: { current: ['c1'] },
          });
      });

      const student = createUserWithClaims(testEnv, 'student1');
      await assertSucceeds(student.firestore().doc('administrations/admin1').get());
    });

    test('user assigned to group can read group administration', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            groups: ['g1'],
            createdBy: 'admin1',
          });
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            groups: { current: ['g1'] },
          });
      });

      const student = createUserWithClaims(testEnv, 'student1');
      await assertSucceeds(student.firestore().doc('administrations/admin1').get());
    });
  });

  describe('administration updates', () => {
    test('creator can update administration', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'admin1',
          });
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(
        admin.firestore().doc('administrations/admin1').update({
          name: 'Updated Administration',
        }),
      );
    });

    test('creator cannot update createdBy field', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'admin1',
          });
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertFails(
        admin.firestore().doc('administrations/admin1').update({
          createdBy: 'someoneElse',
        }),
      );
    });

    test('org admin can update administration in their org', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'creator1',
          });
        await ctx
          .firestore()
          .doc('userClaims/admin2')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin2');
      await assertSucceeds(
        admin.firestore().doc('administrations/admin1').update({
          name: 'Updated by Org Admin',
        }),
      );
    });

    test('non-admin cannot update administration', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'admin1',
          });
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            districts: { current: ['d1'] },
          });
      });

      const student = createUserWithClaims(testEnv, 'student1');
      await assertFails(
        student.firestore().doc('administrations/admin1').update({
          name: 'Unauthorized Update',
        }),
      );
    });
  });

  describe('administration completion stats', () => {
    test('admin can read administration completion stats', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'admin1',
          });
        await ctx.firestore().doc('administrations/admin1/stats/completion').set({
          completed: 5,
          total: 10,
        });
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(admin.firestore().doc('administrations/admin1/stats/completion').get());
    });

    test('creator can read completion stats', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'creator1',
          });
        await ctx.firestore().doc('administrations/admin1/stats/completion').set({
          completed: 5,
          total: 10,
        });
      });

      const creator = createUserWithClaims(testEnv, 'creator1');
      await assertSucceeds(creator.firestore().doc('administrations/admin1/stats/completion').get());
    });

    test('non-admin cannot read completion stats', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'admin1',
          });
        await ctx.firestore().doc('administrations/admin1/stats/completion').set({
          completed: 5,
          total: 10,
        });
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            districts: { current: ['d1'] },
          });
      });

      const student = createUserWithClaims(testEnv, 'student1');
      await assertFails(student.firestore().doc('administrations/admin1/stats/completion').get());
    });

    test('completion stats cannot be written', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/admin1')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'admin1',
          });
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertFails(
        admin.firestore().doc('administrations/admin1/stats/completion').set({
          completed: 10,
          total: 10,
        }),
      );
    });
  });
});
