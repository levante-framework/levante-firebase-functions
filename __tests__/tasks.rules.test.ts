import { describe, test, beforeAll, afterAll, beforeEach } from 'vitest';
import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import { createTestEnvironment, setupTestData, createUserWithClaims } from './test-utils';

describe('Tasks', () => {
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

  describe('task reading', () => {
    test('authenticated user can read tasks', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/task1').set({
          name: 'Test Task',
          description: 'A test task',
        });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertSucceeds(user.firestore().doc('tasks/task1').get());
    });

    test('unauthenticated user cannot read tasks', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/task1').set({
          name: 'Test Task',
          description: 'A test task',
        });
      });

      const unauthed = testEnv.unauthenticatedContext();
      await assertFails(unauthed.firestore().doc('tasks/task1').get());
    });
  });

  describe('task creation', () => {
    test('authenticated user can create task without registered field', async () => {
      const user = createUserWithClaims(testEnv, 'user1');
      await assertSucceeds(
        user
          .firestore()
          .doc('tasks/newTask')
          .set({
            name: 'New Task',
            description: 'A new task',
            params: { difficulty: 'easy' },
          }),
      );
    });

    test('user cannot create task with registered field', async () => {
      const user = createUserWithClaims(testEnv, 'user1');
      await assertFails(
        user.firestore().doc('tasks/newTask').set({
          name: 'New Task',
          description: 'A new task',
          registered: true,
        }),
      );
    });

    test('user can create task with all allowed fields', async () => {
      const user = createUserWithClaims(testEnv, 'user1');
      await assertSucceeds(
        user
          .firestore()
          .doc('tasks/newTask')
          .set({
            name: 'New Task',
            description: 'A new task',
            params: { difficulty: 'easy', level: 1 },
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
      );
    });

    test('unauthenticated user cannot create tasks', async () => {
      const unauthed = testEnv.unauthenticatedContext();
      await assertFails(
        unauthed.firestore().doc('tasks/newTask').set({
          name: 'New Task',
          description: 'A new task',
        }),
      );
    });
  });

  describe('task updates', () => {
    test('user can update task with allowed fields', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('tasks/task1')
          .set({
            name: 'Test Task',
            description: 'A test task',
            params: { difficulty: 'easy' },
            registered: false,
          });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertSucceeds(
        user
          .firestore()
          .doc('tasks/task1')
          .update({
            description: 'Updated description',
            lastUpdated: new Date(),
            params: { difficulty: 'medium' },
          }),
      );
    });

    test('user cannot update registered field', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/task1').set({
          name: 'Test Task',
          description: 'A test task',
          registered: false,
        });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertFails(
        user.firestore().doc('tasks/task1').update({
          registered: true,
        }),
      );
    });

    test('user can update params without adding new keys', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('tasks/task1')
          .set({
            name: 'Test Task',
            description: 'A test task',
            params: { difficulty: 'easy', level: 1 },
            registered: false,
          });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertSucceeds(
        user
          .firestore()
          .doc('tasks/task1')
          .update({
            params: { difficulty: 'hard', level: 1 },
          }),
      );
    });

    test('user cannot add new keys to params', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('tasks/task1')
          .set({
            name: 'Test Task',
            description: 'A test task',
            params: { difficulty: 'easy' },
            registered: false,
          });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertFails(
        user
          .firestore()
          .doc('tasks/task1')
          .update({
            params: { difficulty: 'easy', newKey: 'value' },
          }),
      );
    });

    test('user cannot remove keys from params', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('tasks/task1')
          .set({
            name: 'Test Task',
            description: 'A test task',
            params: { difficulty: 'easy', level: 1 },
            registered: false,
          });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertFails(
        user
          .firestore()
          .doc('tasks/task1')
          .update({
            params: { difficulty: 'easy' },
          }),
      );
    });

    test('user can update allowed fields together', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx
          .firestore()
          .doc('tasks/task1')
          .set({
            name: 'Test Task',
            description: 'A test task',
            params: { difficulty: 'easy' },
            registered: false,
          });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertSucceeds(
        user
          .firestore()
          .doc('tasks/task1')
          .update({
            description: 'Updated description',
            lastUpdated: new Date(),
            params: { difficulty: 'medium' },
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
      );
    });

    test('user cannot update disallowed fields', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/task1').set({
          name: 'Test Task',
          description: 'A test task',
          registered: false,
        });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertFails(
        user.firestore().doc('tasks/task1').update({
          name: 'Updated Name', // name is not in allowed update fields
        }),
      );
    });
  });

  describe('task variants', () => {
    test('user can read task variants', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/task1').set({
          name: 'Test Task',
          description: 'A test task',
        });
        await ctx
          .firestore()
          .doc('tasks/task1/variants/variant1')
          .set({
            name: 'Variant 1',
            params: { level: 1 },
          });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertSucceeds(user.firestore().doc('tasks/task1/variants/variant1').get());
    });

    test('user can create task variants', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/task1').set({
          name: 'Test Task',
          description: 'A test task',
        });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertSucceeds(
        user
          .firestore()
          .doc('tasks/task1/variants/newVariant')
          .set({
            name: 'New Variant',
            params: { level: 2 },
          }),
      );
    });

    test('user can update task variants', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/task1').set({
          name: 'Test Task',
          description: 'A test task',
        });
        await ctx
          .firestore()
          .doc('tasks/task1/variants/variant1')
          .set({
            name: 'Variant 1',
            params: { level: 1 },
          });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertSucceeds(
        user
          .firestore()
          .doc('tasks/task1/variants/variant1')
          .update({
            params: { level: 2 },
          }),
      );
    });

    test('user cannot create variant with registered field', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/task1').set({
          name: 'Test Task',
          description: 'A test task',
        });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertFails(
        user
          .firestore()
          .doc('tasks/task1/variants/newVariant')
          .set({
            name: 'New Variant',
            params: { level: 2 },
            registered: true,
          }),
      );
    });

    test('unauthenticated user cannot access variants', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/task1').set({
          name: 'Test Task',
          description: 'A test task',
        });
        await ctx
          .firestore()
          .doc('tasks/task1/variants/variant1')
          .set({
            name: 'Variant 1',
            params: { level: 1 },
          });
      });

      const unauthed = testEnv.unauthenticatedContext();
      await assertFails(unauthed.firestore().doc('tasks/task1/variants/variant1').get());
    });
  });

  describe('task deletion', () => {
    test('regular user cannot delete tasks', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/task1').set({
          name: 'Test Task',
          description: 'A test task',
        });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertFails(user.firestore().doc('tasks/task1').delete());
    });

    test('regular user cannot delete task variants', async () => {
      await setupTestData(testEnv, async (ctx) => {
        await ctx.firestore().doc('tasks/task1').set({
          name: 'Test Task',
          description: 'A test task',
        });
        await ctx
          .firestore()
          .doc('tasks/task1/variants/variant1')
          .set({
            name: 'Variant 1',
            params: { level: 1 },
          });
      });

      const user = createUserWithClaims(testEnv, 'user1');
      await assertFails(user.firestore().doc('tasks/task1/variants/variant1').delete());
    });
  });
});
