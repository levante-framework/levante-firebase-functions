const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');

// // Point to the emulator BEFORE initializing Firebase Admin
process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8180";
process.env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9199";

// Initialize Firebase Admin with the emulator configuration
const adminApp = admin.initializeApp({projectId: "demo-emulator"}, "admin-clearer");

async function clearDatabase() {
  try {
    console.log("=== CLEARING EMULATOR DATABASE ===\n");
    
    const auth = getAuth(adminApp);
    const db = adminApp.firestore();
    
    console.log("Step 1: Clearing Auth users...");
    
    // List all users and delete them
    let listUsersResult = await auth.listUsers(1000);
    let deletedCount = 0;
    
    while (listUsersResult.users.length > 0) {
      const uids = listUsersResult.users.map(user => user.uid);
      await auth.deleteUsers(uids);
      deletedCount += uids.length;
      console.log(`  Deleted ${uids.length} auth users`);
      
      // Get next batch if there's a page token
      if (listUsersResult.pageToken) {
        listUsersResult = await auth.listUsers(1000, listUsersResult.pageToken);
      } else {
        break;
      }
    }
    
    console.log(`✅ Cleared ${deletedCount} Auth users\n`);
    
    console.log("Step 2: Clearing Firestore collections...");
    
    const collections = [
      'system',
      'users',
      'userClaims', 
      'districts',
      'schools',
      'classes',
      'groups',
      'administrations'
    ];
    
    for (const collectionName of collections) {
      console.log(`  Clearing ${collectionName}...`);
      const collectionRef = db.collection(collectionName);
      const snapshot = await collectionRef.get();
      
      if (!snapshot.empty) {
        const batch = db.batch();
        snapshot.docs.forEach(doc => {
          batch.delete(doc.ref);
        });
        await batch.commit();
        console.log(`    ✅ Deleted ${snapshot.size} documents from ${collectionName}`);
      } else {
        console.log(`    ⚪ No documents found in ${collectionName}`);
      }
    }
    
    console.log("\n=== DATABASE CLEARED SUCCESSFULLY ===");
    console.log("You can now run the seeding script to populate with fresh test data.");
    
  } catch (error) {
    console.error("\n❌ CLEARING FAILED!");
    console.error("Error:", error.message);
    if (error.stack) {
      console.error("Stack trace:", error.stack);
    }
    throw error;
  }
}

// Run the clearing process
clearDatabase(); 
