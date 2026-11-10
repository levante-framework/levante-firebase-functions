import { describe, test, beforeAll, afterAll, beforeEach } from "vitest";
import { assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import {
  createTestEnvironment,
  setupTestData,
  createUserWithClaims,
} from "./test-utils";

const SITE = "siteX";
const OTHER_SITE = "siteY";

const siteAdminClaims = {
  rolesSet: ["site_admin"],
  siteRoles: { [SITE]: ["site_admin"] },
  siteNames: { [SITE]: "Site X" },
};

describe("Reading user docs scoped by roles[].siteId", () => {
  let testEnv: import("@firebase/rules-unit-testing").RulesTestEnvironment;

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

    await setupTestData(testEnv, async (ctx) => {
      await ctx
        .firestore()
        .doc("system/permissions")
        .set({
          permissions: {
            super_admin: { users: ["create", "read", "update", "delete"] },
            site_admin: { users: ["create", "read", "update", "delete"] },
            admin: { users: ["create", "read", "update"] },
            research_assistant: { users: ["read"] },
            participant: { users: [] },
          },
        });

      await ctx.firestore().doc("users/requestingAdmin").set({
        userType: "admin",
        districts: { current: [] },
        roles: [{ siteId: SITE, role: "site_admin", siteName: "Site X" }],
      });
    });
  });

  test("site admin can read another admin in the same site", async () => {
    await setupTestData(testEnv, async (ctx) => {
      await ctx
        .firestore()
        .doc("users/creatorAdmin")
        .set({
          userType: "admin",
          displayName: "Creator Admin",
          districts: { current: [] },
          roles: [{ siteId: SITE, role: "admin", siteName: "Site X" }],
        });
    });

    const admin = createUserWithClaims(
      testEnv,
      "requestingAdmin",
      siteAdminClaims,
    );

    await assertSucceeds(admin.firestore().doc("users/creatorAdmin").get());
  });

  test("site admin cannot read an admin scoped to a different site", async () => {
    await setupTestData(testEnv, async (ctx) => {
      await ctx
        .firestore()
        .doc("users/foreignAdmin")
        .set({
          userType: "admin",
          districts: { current: [] },
          roles: [{ siteId: OTHER_SITE, role: "admin", siteName: "Site Y" }],
        });
    });

    const admin = createUserWithClaims(
      testEnv,
      "requestingAdmin",
      siteAdminClaims,
    );

    await assertFails(admin.firestore().doc("users/foreignAdmin").get());
  });

  test("site admin cannot read an admin that has no roles", async () => {
    await setupTestData(testEnv, async (ctx) => {
      await ctx.firestore().doc("users/unscopedAdmin").set({
        userType: "admin",
        districts: { current: [] },
        roles: [],
      });
    });

    const admin = createUserWithClaims(
      testEnv,
      "requestingAdmin",
      siteAdminClaims,
    );

    await assertFails(admin.firestore().doc("users/unscopedAdmin").get());
  });

  test("site admin can still read a participant via districts.current", async () => {
    await setupTestData(testEnv, async (ctx) => {
      await ctx
        .firestore()
        .doc("users/participant")
        .set({
          userType: "student",
          districts: { current: [SITE] },
          roles: [{ siteId: SITE, role: "participant", siteName: "Site X" }],
        });
    });

    const admin = createUserWithClaims(
      testEnv,
      "requestingAdmin",
      siteAdminClaims,
    );

    await assertSucceeds(admin.firestore().doc("users/participant").get());
  });

  test("site admin cannot read a participant in a different site", async () => {
    await setupTestData(testEnv, async (ctx) => {
      await ctx
        .firestore()
        .doc("users/foreignParticipant")
        .set({
          userType: "student",
          districts: { current: [OTHER_SITE] },
          roles: [
            { siteId: OTHER_SITE, role: "participant", siteName: "Site Y" },
          ],
        });
    });

    const admin = createUserWithClaims(
      testEnv,
      "requestingAdmin",
      siteAdminClaims,
    );

    await assertFails(
      admin.firestore().doc("users/foreignParticipant").get(),
    );
  });
});
