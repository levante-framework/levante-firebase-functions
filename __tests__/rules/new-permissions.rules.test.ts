import { describe, test, beforeAll, afterAll, beforeEach } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { createTestEnvironment, setupTestData, createUserWithClaims } from './test-utils';

describe('New Permission System', () => {
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

    // Set up system permissions for new permission system
    await setupTestData(testEnv, async (ctx) => {
      await ctx
        .firestore()
        .doc('system/permissions')
        .set({
          permissions: {
            super_admin: {
              users: ['create', 'read', 'update', 'delete'],
              tasks: ['create', 'read', 'update', 'delete'],
              groups: ['create', 'read', 'update', 'delete'],
              assignments: ['create', 'read', 'update', 'delete'],
              admins: ['create', 'read', 'update', 'delete'],
            },
            site_admin: {
              users: ['create', 'read', 'update', 'delete'],
              tasks: ['create', 'read', 'update', 'delete'],
              groups: ['create', 'read', 'update', 'delete'],
              assignments: ['create', 'read', 'update', 'delete'],
              admins: ['create', 'read', 'update', 'delete'],
            },
            admin: {
              users: ['create', 'read', 'update'],
              tasks: ['read', 'update'],
              groups: ['create', 'read', 'update'],
              assignments: ['read', 'update'],
              admins: ['create', 'read', 'update'],
            },
            research_assistant: {
              users: ['read'],
              tasks: ['read'],
              groups: ['read'],
              assignments: ['read'],
              admins: ['read'],
            },
            participant: {
              users: [],
              tasks: [],
              groups: [],
              assignments: [],
              admins: [],
            },
          },
        });
    });
  });

  describe('super_admin role', () => {
    test('super_admin can delete users', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/testUser')
          .set({
            userType: 'student',
            name: 'Test User',
            districts: { current: ['d1'] },
          });
      });

      const superAdmin = createUserWithClaims(testEnv, 'superAdmin', {
        useNewPermissions: true,
        roles: ['super_admin'],
      });
      await assertSucceeds(superAdmin.firestore().doc('users/testUser').delete());
    });

    test('super_admin can delete tasks', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/testTask').set({
          name: 'Test Task',
        });
      });

      const superAdmin = createUserWithClaims(testEnv, 'superAdmin', {
        useNewPermissions: true,
        roles: ['super_admin'],
      });
      await assertSucceeds(superAdmin.firestore().doc('tasks/testTask').delete());
    });

    test('super_admin can delete administrations', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/testAdmin')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'creator',
          });
      });

      const superAdmin = createUserWithClaims(testEnv, 'superAdmin', {
        useNewPermissions: true,
        roles: ['super_admin'],
      });
      await assertSucceeds(superAdmin.firestore().doc('administrations/testAdmin').delete());
    });

    test('super_admin can delete groups', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('groups/testGroup').set({
          name: 'Test Group',
        });
      });

      const superAdmin = createUserWithClaims(testEnv, 'superAdmin', {
        useNewPermissions: true,
        roles: ['super_admin'],
      });
      await assertSucceeds(superAdmin.firestore().doc('groups/testGroup').delete());
    });
  });

  describe('site_admin role', () => {
    test('site_admin can delete users', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/testUser')
          .set({
            userType: 'student',
            name: 'Test User',
            districts: { current: ['d1'] },
          });
      });

      const siteAdmin = createUserWithClaims(testEnv, 'siteAdmin', {
        useNewPermissions: true,
        roles: ['site_admin'],
      });
      await assertSucceeds(siteAdmin.firestore().doc('users/testUser').delete());
    });

    test('site_admin can delete tasks', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/testTask').set({
          name: 'Test Task',
        });
      });

      const siteAdmin = createUserWithClaims(testEnv, 'siteAdmin', {
        useNewPermissions: true,
        roles: ['site_admin'],
      });
      await assertSucceeds(siteAdmin.firestore().doc('tasks/testTask').delete());
    });

    test('site_admin can create and update groups', async () => {
      const siteAdmin = createUserWithClaims(testEnv, 'siteAdmin', {
        useNewPermissions: true,
        roles: ['site_admin'],
      });

      await assertSucceeds(
        siteAdmin.firestore().doc('groups/newGroup').set({
          name: 'New Group',
        }),
      );

      await assertSucceeds(
        siteAdmin.firestore().doc('groups/newGroup').update({
          name: 'Updated Group',
        }),
      );
    });
  });

  describe('admin role', () => {
    test('admin cannot delete users', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/testUser')
          .set({
            userType: 'student',
            name: 'Test User',
            districts: { current: ['d1'] },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin', {
        useNewPermissions: true,
        roles: ['admin'],
      });
      await assertFails(admin.firestore().doc('users/testUser').delete());
    });

    test('admin cannot delete tasks', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/testTask').set({
          name: 'Test Task',
        });
      });

      const admin = createUserWithClaims(testEnv, 'admin', {
        useNewPermissions: true,
        roles: ['admin'],
      });
      await assertFails(admin.firestore().doc('tasks/testTask').delete());
    });

    test('admin cannot delete administrations', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/testAdmin')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'creator',
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin', {
        useNewPermissions: true,
        roles: ['admin'],
      });
      await assertFails(admin.firestore().doc('administrations/testAdmin').delete());
    });

    test('admin can read and update tasks', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('tasks/testTask')
          .set({
            name: 'Test Task',
            description: 'Original description',
            params: { level: 1 },
          });
      });

      const admin = createUserWithClaims(testEnv, 'admin', {
        useNewPermissions: true,
        roles: ['admin'],
      });

      await assertSucceeds(admin.firestore().doc('tasks/testTask').get());
      await assertSucceeds(
        admin.firestore().doc('tasks/testTask').update({
          description: 'Updated description',
        }),
      );
    });

    test('admin can create users but needs org admin rights', async () => {
      const admin = createUserWithClaims(testEnv, 'admin', {
        useNewPermissions: true,
        roles: ['admin'],
      });

      // This should fail because admin doesn't have adminOrgs in new system
      await assertFails(
        admin
          .firestore()
          .doc('users/newUser')
          .set({
            userType: 'student',
            name: 'New User',
            districts: { current: ['d1'] },
          }),
      );
    });
  });

  describe('research_assistant role', () => {
    test('research_assistant can only read users', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/testUser')
          .set({
            userType: 'student',
            name: 'Test User',
            districts: { current: ['d1'] },
          });
      });

      const researcher = createUserWithClaims(testEnv, 'researcher', {
        useNewPermissions: true,
        roles: ['research_assistant'],
      });

      // Can read
      await assertSucceeds(researcher.firestore().doc('users/testUser').get());

      // Cannot write
      await assertFails(
        researcher.firestore().doc('users/newUser').set({
          userType: 'student',
          name: 'New User',
        }),
      );
      await assertFails(researcher.firestore().doc('users/testUser').delete());
    });

    test('research_assistant can only read tasks', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/testTask').set({
          name: 'Test Task',
        });
      });

      const researcher = createUserWithClaims(testEnv, 'researcher', {
        useNewPermissions: true,
        roles: ['research_assistant'],
      });

      // Can read
      await assertSucceeds(researcher.firestore().doc('tasks/testTask').get());

      // Cannot write
      await assertFails(
        researcher.firestore().doc('tasks/newTask').set({
          name: 'New Task',
        }),
      );
      await assertFails(researcher.firestore().doc('tasks/testTask').delete());
    });

    test('research_assistant can only read groups', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('groups/testGroup').set({
          name: 'Test Group',
        });
      });

      const researcher = createUserWithClaims(testEnv, 'researcher', {
        useNewPermissions: true,
        roles: ['research_assistant'],
      });

      // Can read with permission
      await assertSucceeds(researcher.firestore().doc('groups/testGroup').get());

      // Cannot write
      await assertFails(
        researcher.firestore().doc('groups/newGroup').set({
          name: 'New Group',
        }),
      );
    });

    test('research_assistant can read administrations', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('administrations/testAdmin')
          .set({
            name: 'Test Administration',
            districts: ['d1'],
            createdBy: 'creator',
          });
      });

      const researcher = createUserWithClaims(testEnv, 'researcher', {
        useNewPermissions: true,
        roles: ['research_assistant'],
      });

      await assertSucceeds(researcher.firestore().doc('administrations/testAdmin').get());
    });
  });

  describe('participant role', () => {
    test('participant has no special permissions', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('users/participant')
          .set({
            userType: 'student',
            name: 'Participant',
            districts: { current: ['d1'] },
          });
        await ctx
          .firestore()
          .doc('users/otherUser')
          .set({
            userType: 'student',
            name: 'Other User',
            districts: { current: ['d1'] },
          });
      });

      const participant = createUserWithClaims(testEnv, 'participant', {
        useNewPermissions: true,
        roles: ['participant'],
      });

      // Can read own document
      await assertSucceeds(participant.firestore().doc('users/participant').get());

      // Cannot read other users
      await assertFails(participant.firestore().doc('users/otherUser').get());
    });

    test('participant cannot read groups without permission', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('groups/testGroup').set({
          name: 'Test Group',
        });
      });

      const participant = createUserWithClaims(testEnv, 'participant', {
        useNewPermissions: true,
        roles: ['participant'],
      });

      // Participant cannot read groups without permission
      await assertFails(participant.firestore().doc('groups/testGroup').get());
    });

    test('participant can still read tasks (legacy behavior)', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/testTask').set({
          name: 'Test Task',
        });
      });

      const participant = createUserWithClaims(testEnv, 'participant', {
        useNewPermissions: true,
        roles: ['participant'],
      });

      // Tasks are readable by authenticated users regardless of new permissions
      await assertSucceeds(participant.firestore().doc('tasks/testTask').get());
    });
  });

  describe('role hierarchy', () => {
    test('user with multiple roles gets highest role permissions', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('users/testUser').set({
          userType: 'student',
          name: 'Test User',
        });
      });

      const multiRoleUser = createUserWithClaims(testEnv, 'multiRole', {
        useNewPermissions: true,
        roles: ['participant', 'research_assistant', 'admin'],
      });

      // Should get admin permissions (highest role)
      await assertSucceeds(multiRoleUser.firestore().doc('users/testUser').get());

      // But still cannot delete (admin doesn't have delete permission)
      await assertFails(multiRoleUser.firestore().doc('users/testUser').delete());
    });

    test('super_admin overrides all other roles', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('users/testUser').set({
          userType: 'student',
          name: 'Test User',
        });
      });

      const superAdminUser = createUserWithClaims(testEnv, 'superUser', {
        useNewPermissions: true,
        roles: ['participant', 'super_admin', 'admin'],
      });

      // Should get super_admin permissions
      await assertSucceeds(superAdminUser.firestore().doc('users/testUser').delete());
    });
  });

  describe('permission system comparison', () => {
    test('legacy system allows admin actions without new permissions', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('userClaims/legacyAdmin')
          .set({
            claims: { adminOrgs: { districts: ['d1'] } },
          });
      });

      const legacyAdmin = createUserWithClaims(testEnv, 'legacyAdmin');
      await assertSucceeds(
        legacyAdmin
          .firestore()
          .doc('users/newUser')
          .set({
            userType: 'student',
            name: 'New User',
            districts: { current: ['d1'] },
          }),
      );
    });

    test('new system requires both role and org admin rights for user creation', async () => {
      const newSystemAdmin = createUserWithClaims(testEnv, 'newAdmin', {
        useNewPermissions: true,
        roles: ['admin'],
      });

      // Should fail because no adminOrgs in new system
      await assertFails(
        newSystemAdmin
          .firestore()
          .doc('users/newUser')
          .set({
            userType: 'student',
            name: 'New User',
            districts: { current: ['d1'] },
          }),
      );
    });

    test('new system allows deletion for super_admin', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('users/testUser').set({
          userType: 'student',
          name: 'Test User',
        });
      });

      const newSystemSuperAdmin = createUserWithClaims(testEnv, 'newSuperAdmin', {
        useNewPermissions: true,
        roles: ['super_admin'],
      });

      await assertSucceeds(newSystemSuperAdmin.firestore().doc('users/testUser').delete());
    });

    test('legacy system does not allow deletion', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('users/testUser').set({
          userType: 'student',
          name: 'Test User',
        });
        await ctx
          .firestore()
          .doc('userClaims/legacyAdmin')
          .set({
            claims: { admin: true },
          });
      });

      const legacyAdmin = createUserWithClaims(testEnv, 'legacyAdmin');
      await assertFails(legacyAdmin.firestore().doc('users/testUser').delete());
    });
  });
});
