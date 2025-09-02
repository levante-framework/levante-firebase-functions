import { describe, test, beforeAll, afterAll, beforeEach } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { createTestEnvironment, setupTestData, createUserWithClaims } from './test-utils';

describe('Organizations (districts, schools, classes, groups)', () => {
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

  describe('districts', () => {
    test('user can read district they belong to', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('districts/d1').set({ name: 'District 1' });
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            districts: { current: ['d1'] },
          });
      });

      const student = createUserWithClaims(testEnv, 'student1');
      await assertSucceeds(student.firestore().doc('districts/d1').get());
    });

    test('district admin can read district they admin', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('districts/d1').set({ name: 'District 1' });
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(admin.firestore().doc('districts/d1').get());
    });

    test('user cannot read district they do not belong to', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('districts/d1').set({ name: 'District 1' });
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            districts: { current: ['d2'] },
          });
      });

      const student = createUserWithClaims(testEnv, 'student1');
      await assertFails(student.firestore().doc('districts/d1').get());
    });

    test('districts cannot be written by regular users', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertFails(admin.firestore().doc('districts/d1').set({ name: 'New District' }));
    });
  });

  describe('schools', () => {
    test('district admin can create school in their district', async () => {
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
        admin.firestore().doc('schools/s1').set({
          name: 'School 1',
          districtId: 'd1',
        }),
      );
    });

    test('district admin cannot create school in different district', async () => {
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
        admin.firestore().doc('schools/s1').set({
          name: 'School 1',
          districtId: 'd2',
        }),
      );
    });

    test('school admin can read school they admin', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('schools/s1').set({
          name: 'School 1',
          districtId: 'd1',
        });
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { schools: ['s1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(admin.firestore().doc('schools/s1').get());
    });

    test('district admin can update and delete schools in their district', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('schools/s1').set({
          name: 'School 1',
          districtId: 'd1',
        });
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(admin.firestore().doc('schools/s1').update({ name: 'Updated School 1' }));
      await assertSucceeds(admin.firestore().doc('schools/s1').delete());
    });
  });

  describe('classes', () => {
    test('district admin can create class in their district', async () => {
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
        admin.firestore().doc('classes/c1').set({
          name: 'Class 1',
          districtId: 'd1',
          schoolId: 's1',
        }),
      );
    });

    test('school admin can create class in their school', async () => {
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
        admin.firestore().doc('classes/c1').set({
          name: 'Class 1',
          districtId: 'd1',
          schoolId: 's1',
        }),
      );
    });

    test('class admin can read class they admin', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('classes/c1').set({
          name: 'Class 1',
          districtId: 'd1',
          schoolId: 's1',
        });
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { classes: ['c1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(admin.firestore().doc('classes/c1').get());
    });

    test('user in class can read class', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('classes/c1').set({
          name: 'Class 1',
          districtId: 'd1',
          schoolId: 's1',
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
      await assertSucceeds(student.firestore().doc('classes/c1').get());
    });
  });

  describe('groups', () => {
    test('group admin can create group', async () => {
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
        admin.firestore().doc('groups/g1').set({
          name: 'Group 1',
          description: 'Test group',
        }),
      );
    });

    test('group admin can update and delete group', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('groups/g1').set({
          name: 'Group 1',
          description: 'Test group',
        });
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { groups: ['g1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(admin.firestore().doc('groups/g1').update({ name: 'Updated Group 1' }));
      await assertSucceeds(admin.firestore().doc('groups/g1').delete());
    });

    test('user in group can read group', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('groups/g1').set({
          name: 'Group 1',
          description: 'Test group',
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
      await assertSucceeds(student.firestore().doc('groups/g1').get());
    });

    test('non-group member cannot read group', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('groups/g1').set({
          name: 'Group 1',
          description: 'Test group',
        });
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            groups: { current: ['g2'] },
          });
      });

      const student = createUserWithClaims(testEnv, 'student1');
      await assertFails(student.firestore().doc('groups/g1').get());
    });
  });
});
