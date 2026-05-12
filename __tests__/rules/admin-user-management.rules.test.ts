import { describe, test, beforeAll, afterAll, beforeEach } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { createTestEnvironment, setupTestData, createUserWithClaims } from './test-utils';

describe('Admin User Management', () => {
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

  describe('user creation by different admin types', () => {
    test('district admin can create users in their district', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/districtAdmin')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'districtAdmin');
      await assertSucceeds(
        admin
          .firestore()
          .doc('users/newStudent')
          .set({
            userType: 'student',
            name: 'New Student',
            districts: { current: ['d1'] },
          }),
      );
    });

    test('school admin can create users in their school', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/schoolAdmin')
          .set({
            claims: { adminOrgs: { schools: ['s1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'schoolAdmin');
      await assertSucceeds(
        admin
          .firestore()
          .doc('users/newStudent')
          .set({
            userType: 'student',
            name: 'New Student',
            schools: { current: ['s1'] },
          }),
      );
    });

    test('class admin can create users in their class', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/classAdmin')
          .set({
            claims: { adminOrgs: { classes: ['c1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'classAdmin');
      await assertSucceeds(
        admin
          .firestore()
          .doc('users/newStudent')
          .set({
            userType: 'student',
            name: 'New Student',
            classes: { current: ['c1'] },
          }),
      );
    });

    test('group admin can create users in their group', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/groupAdmin')
          .set({
            claims: { adminOrgs: { groups: ['g1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'groupAdmin');
      await assertSucceeds(
        admin
          .firestore()
          .doc('users/newStudent')
          .set({
            userType: 'student',
            name: 'New Student',
            groups: { current: ['g1'] },
          }),
      );
    });

    test('admin cannot create user with invalid org structure (multiple districts)', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { districts: ['d1', 'd2'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertFails(
        admin
          .firestore()
          .doc('users/newStudent')
          .set({
            userType: 'student',
            name: 'New Student',
            districts: { current: ['d1', 'd2'] },
          }),
      );
    });

    test('admin cannot create user in org they do not admin', async () => {
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
          .doc('users/newStudent')
          .set({
            userType: 'student',
            name: 'New Student',
            districts: { current: ['d2'] },
          }),
      );
    });

    test('admin can create user with all allowed fields', async () => {
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
          .doc('users/newStudent')
          .set({
            userType: 'student',
            name: 'New Student',
            assessmentPid: 'pid123',
            studentData: { grade: '5th' },
            educatorData: { subject: 'math' },
            caregiverData: { relationship: 'parent' },
            adminData: { role: 'teacher' },
            districts: { current: ['d1'] },
            schools: { current: ['s1'] },
            classes: { current: ['c1'] },
            assessmentUid: 'uid123',
          }),
      );
    });

    test('admin cannot create user with disallowed fields', async () => {
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
          .doc('users/newStudent')
          .set({
            userType: 'student',
            name: 'New Student',
            districts: { current: ['d1'] },
            archived: true, // This field is not allowed
          }),
      );
    });
  });

  describe('user updates by admins', () => {
    test('admin can update user in their org', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            name: 'Student 1',
            districts: { current: ['d1'] },
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
        admin.firestore().doc('users/student1').update({
          name: 'Updated Student 1',
        }),
      );
    });

    test('admin cannot update archived field', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            name: 'Student 1',
            districts: { current: ['d1'] },
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
        admin.firestore().doc('users/student1').update({
          archived: true,
        }),
      );
    });

    test('admin cannot update assessmentUid field', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            name: 'Student 1',
            districts: { current: ['d1'] },
            assessmentUid: 'original-uid',
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
        admin.firestore().doc('users/student1').update({
          assessmentUid: 'new-uid',
        }),
      );
    });

    test('admin cannot update user not in their org', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            name: 'Student 1',
            districts: { current: ['d2'] },
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
        admin.firestore().doc('users/student1').update({
          name: 'Updated Student 1',
        }),
      );
    });

    test('user can update their own document', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            name: 'Student 1',
            districts: { current: ['d1'] },
          });
      });

      const student = createUserWithClaims(testEnv, 'student1');
      await assertSucceeds(
        student.firestore().doc('users/student1').update({
          name: 'Self Updated Name',
        }),
      );
    });

    test('user cannot update archived field on their own document', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            name: 'Student 1',
            districts: { current: ['d1'] },
          });
      });

      const student = createUserWithClaims(testEnv, 'student1');
      await assertFails(
        student.firestore().doc('users/student1').update({
          archived: true,
        }),
      );
    });

    test('school admin can update user in their school', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            name: 'Student 1',
            schools: { current: ['s1'] },
          });
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { schools: ['s1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(
        admin.firestore().doc('users/student1').update({
          name: 'Updated by School Admin',
        }),
      );
    });

    test('class admin can update user in their class', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            name: 'Student 1',
            classes: { current: ['c1'] },
          });
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { classes: ['c1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(
        admin.firestore().doc('users/student1').update({
          name: 'Updated by Class Admin',
        }),
      );
    });

    test('group admin can update user in their group', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/student1')
          .set({
            userType: 'student',
            name: 'Student 1',
            groups: { current: ['g1'] },
          });
        await ctx
          .firestore()
          .doc('userClaims/admin1')
          .set({
            claims: { adminOrgs: { groups: ['g1'] } },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(
        admin.firestore().doc('users/student1').update({
          name: 'Updated by Group Admin',
        }),
      );
    });
  });

  describe('user reading permissions', () => {
    test('parent can read their child user document', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('users/parent1').set({ userType: 'parent' });
        await ctx
          .firestore()
          .doc('users/child1')
          .set({
            userType: 'student',
            parentIds: ['parent1'],
          });
      });

      const parent = createUserWithClaims(testEnv, 'parent1');
      await assertSucceeds(parent.firestore().doc('users/child1').get());
    });

    test('admin can read user in their org', async () => {
      await setupTestData(testEnv, async (ctx) => {
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

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertSucceeds(admin.firestore().doc('users/u1').get());
    });

    test('admin cannot read user not in their org', async () => {
      await setupTestData(testEnv, async (ctx) => {
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
            districts: { current: ['d2'] },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin1');
      await assertFails(admin.firestore().doc('users/u1').get());
    });
  });
});
