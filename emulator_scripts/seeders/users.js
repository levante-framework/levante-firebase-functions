const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');

// User definitions with email and password
const USER_DEFINITIONS = {
  superAdmin: {
    email: 'superadmin@levante.test',
    password: 'super123',
    displayName: 'Super Admin User',
    userType: 'admin'
  },
  admin: {
    email: 'admin@levante.test',
    password: 'admin123',
    displayName: 'Admin User',
    userType: 'admin'
  },
  teacher: {
    email: 'teacher@levante.test',
    password: 'teach123',
    displayName: 'Teacher User',
    userType: 'teacher'
  },
  student: {
    email: 'student@levante.test',
    password: 'student123',
    displayName: 'Student User',
    userType: 'student'
  },
  parent: {
    email: 'parent@levante.test',
    password: 'parent123',
    displayName: 'Parent User',
    userType: 'parent'
  }
};

async function createUsers(adminApp) {
  const auth = getAuth(adminApp);
  const db = adminApp.firestore();
  const createdUsers = {};
  
  console.log("  Creating Auth users and user documents...");
  
  for (const [userKey, userDef] of Object.entries(USER_DEFINITIONS)) {
    try {
      console.log(`    Creating ${userKey}...`);
      
      // Check if user already exists
      let userRecord;
      try {
        userRecord = await auth.getUserByEmail(userDef.email);
        console.log(`      ⚠️  Auth user already exists: ${userDef.email}`);
      } catch (error) {
        if (error.code === 'auth/user-not-found') {
          // Create new Auth user
          userRecord = await auth.createUser({
            email: userDef.email,
            password: userDef.password,
            emailVerified: true,
            displayName: userDef.displayName,
            disabled: false
          });
          console.log(`      ✅ Created Auth user: ${userDef.email}`);
        } else {
          throw error;
        }
      }
      
      const uid = userRecord.uid;
      
      // Check if user document exists
      const userDoc = await db.collection('users').doc(uid).get();
      if (!userDoc.exists) {
        // Create user document according to schema
        const userData = {
          archived: false,
          assessmentUid: uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          displayName: userDef.displayName,
          email: userDef.email,
          userType: userDef.userType,
          testData: true,
          // Initialize empty org associations
          districts: {
            all: [],
            current: [],
            dates: {}
          },
          schools: {
            all: [],
            current: [],
            dates: {}
          },
          classes: {
            all: [],
            current: [],
            dates: {}
          },
          groups: {
            all: [],
            current: [],
            dates: {}
          },
          legal: {
            assent: {},
            tos: {}
          }
        };
        
        // Add admin-specific data for admin users
        if (userDef.userType === 'admin') {
          userData.adminData = {
            administrationsCreated: []
          };
          userData.sso = 'internal'; // Or could be 'google' for SSO users
        }
        
        // Add assignments for participant users
        if (['student', 'parent', 'teacher'].includes(userDef.userType)) {
          userData.assignments = {
            assigned: [],
            completed: [],
            started: []
          };
        }
        
        await db.collection('users').doc(uid).set(userData);
        console.log(`      ✅ Created user document: ${uid}`);
      } else {
        console.log(`      ⚠️  User document already exists: ${uid}`);
      }
      
      // Store user info for later use
      createdUsers[userKey] = {
        uid,
        email: userDef.email,
        password: userDef.password,
        displayName: userDef.displayName,
        userType: userDef.userType
      };
      
    } catch (error) {
      console.error(`      ❌ Failed to create ${userKey}:`, error.message);
      throw error;
    }
  }
  
  return createdUsers;
}

module.exports = { createUsers }; 
