const { getAuth } = require("firebase-admin/auth");

async function updateUserRoles(adminApp, users, organizations) {
  const db = adminApp.firestore();
  const auth = getAuth(adminApp);

  console.log("  Updating user roles...");

  // Extract district IDs from the organizations for easy reference
  const districtIds = organizations.districts.map((d) => d.id);
  const districtNamesById = organizations.districts.reduce((acc, district) => {
    acc[district.id] = district.name || district.id;
    return acc;
  }, {});

  for (const user of users) {
    try {
      console.log(`    Updating roles for ${user.email}...`);

      const roles = [];

      if (user.userType === "admin") {
        if (user.userKey === "superAdmin") {
          // Super admin gets special "any" siteId
          roles.push({
            siteId: "any",
            siteName: "Any",
            role: "super_admin",
          });
          console.log(`      - Added super_admin role with siteId: any`);
        } else if (user.userKey === "admin") {
          // Regular admin - has access to all districts in the emulator
          for (const districtId of districtIds) {
            roles.push({
              siteId: districtId,
              siteName: districtNamesById[districtId],
              role: "admin",
            });
            console.log(`      - Added admin role with siteId: ${districtId}`);
          }
        } else if (user.userKey === "siteAdmin") {
          // Site admin - has site_admin role for all districts in the emulator
          for (const districtId of districtIds) {
            roles.push({
              siteId: districtId,
              siteName: districtNamesById[districtId],
              role: "site_admin",
            });
            console.log(
              `      - Added site_admin role with siteId: ${districtId}`
            );
          }
        } else if (user.userKey === "researchAssistant") {
          // Research assistant - has research_assistant role for all districts in the emulator
          for (const districtId of districtIds) {
            roles.push({
              siteId: districtId,
              siteName: districtNamesById[districtId],
              role: "research_assistant",
            });
            console.log(
              `      - Added research_assistant role with siteId: ${districtId}`
            );
          }
        }
      } else if (["student", "parent", "teacher"].includes(user.userType)) {
        // Participant users - they are linked to all districts in the emulator
        // (as per associations.js which links all participants to all organizations)
        for (const districtId of districtIds) {
          roles.push({
            siteId: districtId,
            siteName: districtNamesById[districtId],
            role: "participant",
          });
          console.log(
            `      - Added participant role with siteId: ${districtId}`
          );
        }
      }

      // Always update roles in user doc and Auth custom claims
      // 1) Update user doc roles array (empty array is valid)
      await db.collection("users").doc(user.uid).update({ roles });
      console.log(
        `      ✅ Updated ${user.email} user doc with ${roles.length} role(s)`
      );

      // 2) Set Auth custom claims (the enforcement source) for every user
      try {
        const rolesSet = Array.from(new Set(roles.map((r) => r.role)));
        const siteRoles = {};
        const siteNames = {};
        for (const { siteId, siteName, role } of roles) {
          // "any" is the super_admin sentinel, not a real site
          if (siteId === "any") {
            continue;
          }
          if (!siteRoles[siteId]) {
            siteRoles[siteId] = [];
          }
          if (!siteRoles[siteId].includes(role)) {
            siteRoles[siteId].push(role);
          }
          siteNames[siteId] = siteName;
        }

        const authClaims = {
          admin: user.userType === "admin",
          super_admin: rolesSet.includes("super_admin"),
          adminUid: user.uid,
          roarUid: user.uid,
          useNewPermissions: true,
          rolesSet,
          siteRoles,
          siteNames,
          roles,
        };
        await auth.setCustomUserClaims(user.uid, authClaims);
        console.log(`      ✅ Set Auth custom claims for ${user.email}`);
      } catch (e) {
        console.warn(
          `      ⚠️  Failed to set Auth claims for ${user.email}:`,
          e.message || e
        );
      }
    } catch (error) {
      console.error(
        `      ❌ Failed to update roles for ${user.email}:`,
        error.message
      );
      throw error;
    }
  }

  console.log("  All user roles updated successfully");
}

module.exports = { updateUserRoles };
