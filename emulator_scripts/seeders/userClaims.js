const { getAuth } = require('firebase-admin/auth');

function buildRoleStructure(roleNames, districts = []) {
  const uniqueRoles = Array.from(new Set((roleNames || []).filter(Boolean)));
  const siteRoles = {};
  const siteNames = {};

  if (Array.isArray(districts)) {
    for (const district of districts) {
      if (!district || !district.id) {
        continue;
      }

      siteRoles[district.id] = uniqueRoles.length > 0 ? [...uniqueRoles] : [];
      siteNames[district.id] = district.name || district.id;
    }
  }

  return {
    rolesSet: uniqueRoles,
    siteRoles,
    siteNames
  };
}
async function createUserClaims(adminApp, users, organizations) {
  const auth = getAuth(adminApp);
  const db = adminApp.firestore();
  
  console.log("  Creating userClaims documents...");
  
  for (const [userKey, user] of Object.entries(users)) {
    try {
      console.log(`    Creating claims for ${userKey}...`);
      
      let claims = {
        super_admin: false,
        admin: false,
        useNewPermissions: true,
      };
      
      // Set claims based on user type
      if (userKey === 'superAdmin') {
        claims.super_admin = true;
        claims.admin = true;
      } else if (['admin', 'siteAdmin', 'researchAssistant'].includes(userKey)) {
        claims.admin = true;
      }

      let rolesStructure = { rolesSet: [], siteRoles: {}, siteNames: {} };
      if (userKey === 'superAdmin') {
        rolesStructure = buildRoleStructure([
          'super_admin',
        ], organizations.districts);
      } else if (userKey === 'siteAdmin') {
        rolesStructure = buildRoleStructure([
          'site_admin',
        ], organizations.districts);
      } else if (userKey === 'admin') {
        rolesStructure = buildRoleStructure([
          'admin',
        ], organizations.districts);
      } else if (userKey === 'researchAssistant') {
        rolesStructure = buildRoleStructure([
          'research_assistant',
        ], organizations.districts);
      } else {
        rolesStructure = buildRoleStructure([
          'participant',
        ], organizations.districts);
      }
      
      // Add other UIDs
      claims.adminUid = user.uid;
      claims.roarUid = user.uid;
      
      // Check if userClaims document already exists
      const userClaimsDoc = await db.collection('userClaims').doc(user.uid).get();
      
      if (!userClaimsDoc.exists) {
        const claimsData = {
          claims: claims,
          lastUpdated: Date.now(),
          testData: true
        };
        
        await db.collection('userClaims').doc(user.uid).set(claimsData);
        console.log(`      ✅ Created userClaims document for ${user.uid}`);
      } else {
        console.log(`      ⚠️  UserClaims document already exists for ${user.uid}`);
      }
      
      // Also set custom claims in Auth for admin users
      let authClaims = {};
      if (['superAdmin', 'admin', 'siteAdmin', 'researchAssistant'].includes(userKey)) {
        authClaims = {
          admin: claims.admin,
          super_admin: claims.super_admin,
          adminUid: user.uid,
          roarUid: user.uid,
          useNewPermissions: claims.useNewPermissions,
          ...rolesStructure
        };

        await auth.setCustomUserClaims(user.uid, authClaims);
        console.log(`      ✅ Set Auth custom claims for ${user.uid}`);
      }

      // Persist computed claims for downstream seeders to consume (avoid reads)
      users[userKey].claims = claims;
      users[userKey].authClaims = authClaims;
      
    } catch (error) {
      console.error(`      ❌ Failed to create claims for ${userKey}:`, error.message);
      throw error;
    }
  }
}

module.exports = { createUserClaims }; 
