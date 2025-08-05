async function updateUserRoles(adminApp, users, organizations) {
  const db = adminApp.firestore();
  
  console.log("  Updating user roles...");
  
  // Extract district IDs from the organizations for easy reference
  const districtIds = organizations.districts.map(d => d.id);
  
  for (const [userKey, user] of Object.entries(users)) {
    try {
      console.log(`    Updating roles for ${userKey}...`);
      
      const roles = [];
      
      if (user.userType === 'admin') {
        if (userKey === 'superAdmin') {
          // Super admin gets special "any" siteId
          roles.push({
            siteId: "any",
            role: "super_admin"
          });
          console.log(`      - Added super_admin role with siteId: any`);
        } else if (userKey === 'admin') {
          // Regular admin - has access to all districts in the emulator
          // This matches what we set in userClaims.js
          for (const districtId of districtIds) {
            roles.push({
              siteId: districtId,
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
            role: "participant"
          });
          console.log(`      - Added participant role with siteId: ${districtId}`);
        }
      }
      
      // Update the user document with roles
      if (roles.length > 0) {
        await db.collection('users').doc(user.uid).update({
          roles: roles
        });
        console.log(`      ✅ Updated ${userKey} with ${roles.length} role(s)`);
      } else {
        console.log(`      ⚠️  No roles to add for ${userKey}`);
      }
      
    } catch (error) {
      console.error(`      ❌ Failed to update roles for ${userKey}:`, error.message);
      throw error;
    }
  }
  
  console.log("  All user roles updated successfully");
}

module.exports = { updateUserRoles }; 
