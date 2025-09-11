const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');

async function createUserClaims(adminApp, users, organizations) {
  const auth = getAuth(adminApp);
  const db = adminApp.firestore();
  
  console.log("  Creating userClaims documents...");
  
  for (const [userKey, user] of Object.entries(users)) {
    try {
      console.log(`    Creating claims for ${userKey}...`);
      
      let claims = {
        adminOrgs: {
          classes: [],
          districts: [],
          families: [],
          groups: [],
          schools: []
        },
        minimalAdminOrgs: {
          classes: [],
          districts: [],
          families: [],
          groups: [],
          schools: []
        },
        super_admin: false,
        admin: false,
        useNewPermissions: false
      };
      
      // Set claims based on user type
      if (userKey === 'superAdmin') {
        claims.super_admin = true;
        claims.admin = true;
        // Super admin has access to all organizations
        claims.adminOrgs.districts = organizations.districts.map(d => d.id);
        claims.adminOrgs.schools = organizations.schools.map(s => s.id);
        claims.adminOrgs.classes = organizations.classes.map(c => c.id);
        claims.adminOrgs.groups = organizations.groups.map(g => g.id);
        claims.minimalAdminOrgs.districts = organizations.districts.map(d => d.id);
        claims.minimalAdminOrgs.schools = organizations.schools.map(s => s.id);
        
      } else if (userKey === 'admin') {
        // Regular admin has limited access to specific organizations
        claims.adminOrgs.districts = organizations.districts.map(d => d.id);
        claims.adminOrgs.schools = organizations.schools.map(s => s.id);
        claims.adminOrgs.classes = organizations.classes.map(c => c.id);
        claims.adminOrgs.groups = organizations.groups.map(g => g.id);
        claims.admin = true;
        
      }
      
      // Add assessment and other UIDs
      claims.assessmentUid = user.uid;
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
      if (['superAdmin', 'admin'].includes(userKey)) {
        authClaims = {
          admin: claims.admin,
          super_admin: claims.super_admin,
          adminUid: user.uid,
          assessmentUid: user.uid,
          roarUid: user.uid
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
