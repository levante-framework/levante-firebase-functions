const admin = require("firebase-admin");
const { getAuth } = require("firebase-admin/auth");
const { createSystemPermissions } = require("../seeders/permissions");

async function ensureSuperAdmin({ app, email, password }) {
  const auth = getAuth(app);
  const db = app.firestore();

  let userRecord;
  try {
    userRecord = await auth.getUserByEmail(email);
    console.log(`  Super admin auth user already exists: ${email}`);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    userRecord = await auth.createUser({
      email,
      password,
      emailVerified: true,
      displayName: "Super Admin User",
      disabled: false,
    });
    console.log(`  Created super admin auth user: ${email}`);
  }

  const uid = userRecord.uid;
  const roles = [{ siteId: "any", siteName: "Any", role: "super_admin" }];
  await db
    .collection("users")
    .doc(uid)
    .set(
      {
        archived: false,
        assessmentUid: uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        displayName: userRecord.displayName || "Super Admin User",
        email,
        userType: "admin",
        testData: true,
        adminData: { administrationsCreated: [] },
        sso: "internal",
        roles,
        username: email.split("@")[0],
      },
      { merge: true }
    );

  const authClaims = {
    admin: true,
    super_admin: true,
    adminUid: uid,
    roarUid: uid,
    useNewPermissions: true,
    rolesSet: ["super_admin"],
    siteRoles: {},
    siteNames: {},
    roles,
  };

  await auth.setCustomUserClaims(uid, authClaims);
  await db
    .collection("userClaims")
    .doc(uid)
    .set(
      {
        claims: {
          admin: true,
          super_admin: true,
          useNewPermissions: true,
        },
        lastUpdated: Date.now(),
        testData: true,
      },
      { merge: true }
    );

  console.log(`  Bootstrapped super admin: ${email}`);
  return userRecord;
}

async function bootstrapFunctionSeedPrerequisites({
  app,
  superAdminEmail,
  superAdminPassword,
}) {
  await createSystemPermissions(app);
  await ensureSuperAdmin({
    app,
    email: superAdminEmail,
    password: superAdminPassword,
  });
}

module.exports = { bootstrapFunctionSeedPrerequisites, ensureSuperAdmin };
