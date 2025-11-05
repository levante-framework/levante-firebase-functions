const { getAuth } = require('firebase-admin/auth');

async function updateUserRoles(adminApp, users, organizations) {
  const db = adminApp.firestore();
  const auth = getAuth(adminApp);
  
  console.log("  Updating user roles...");
  
  // Extract district IDs from the organizations for easy reference
  const districtIds = organizations.districts.map(d => d.id);
  const districtNamesById = organizations.districts.reduce((acc, district) => {
    acc[district.id] = district.name || district.id;
    return acc;
  }, {});
  
  for (const [userKey, user] of Object.entries(users)) {
    try {
      console.log(`    Updating roles for ${userKey}...`);
      
      const roles = [];
      
      if (user.userType === 'admin') {
        if (userKey === 'superAdmin') {
          // Super admin gets special "any" siteId
          roles.push({
            siteId: "any",
            siteName: "Any",
            role: "super_admin"
          });
          console.log(`      - Added super_admin role with siteId: any`);
        } else if (userKey === 'admin') {
          // Regular admin - has access to all districts in the emulator
          // This matches what we set in userClaims.js
          for (const districtId of districtIds) {
            roles.push({
              siteId: districtId,
              siteName: districtNamesById[districtId],
              role: "admin"
            });
            console.log(`      - Added admin role with siteId: ${districtId}`);
          }
        }
      } else if (['student', 'parent', 'teacher'].includes(user.userType)) {
        // Participant users - they are linked to all districts in the emulator
        // (as per associations.js which links all participants to all organizations)
        for (const districtId of districtIds) {
          roles.push({
            siteId: districtId,
            siteName: districtNamesById[districtId],
            role: "participant"
          });
          console.log(`      - Added participant role with siteId: ${districtId}`);
        }
      }
      
      // Always update roles in user doc and Auth custom claims
      // 1) Update user doc roles array (empty array is valid)
      await db.collection('users').doc(user.uid).update({ roles });
      console.log(`      ✅ Updated ${userKey} user doc with ${roles.length} role(s)`);

      // 2) Merge roles into Auth custom claims (ensure roles property exists for all users)
      try {
        const baseAuthClaims = (users[userKey] && users[userKey].authClaims) || {};
        const newAuthClaims = { ...baseAuthClaims, roles };
        await auth.setCustomUserClaims(user.uid, newAuthClaims);
        console.log(`      ✅ Set Auth custom claims roles for ${userKey}`);
      } catch (e) {
        console.warn(`      ⚠️  Failed to set Auth claims for ${userKey}:`, e.message || e);
      }
      
    } catch (error) {
      console.error(`      ❌ Failed to update roles for ${userKey}:`, error.message);
      throw error;
    }
  }
  
  console.log("  All user roles updated successfully");
}

module.exports = { updateUserRoles }; 
