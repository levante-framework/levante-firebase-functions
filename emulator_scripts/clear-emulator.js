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

    async function deleteCollectionGroup(groupId) {
      console.log(`  Clearing collectionGroup(${groupId})...`);
      const snapshot = await db.collectionGroup(groupId).get();

      if (snapshot.empty) {
        console.log(`    ⚪ No documents found in collectionGroup(${groupId})`);
        return 0;
      }

      // Batch delete to avoid huge commits (max 500 operations per batch).
      let deleted = 0;
      let batch = db.batch();
      let ops = 0;

      for (const doc of snapshot.docs) {
        batch.delete(doc.ref);
        ops += 1;
        deleted += 1;

        if (ops >= 450) {
          await batch.commit();
          batch = db.batch();
          ops = 0;
        }
      }

      if (ops > 0) {
        await batch.commit();
      }

      console.log(`    ✅ Deleted ${deleted} document(s) from collectionGroup(${groupId})`);
      return deleted;
    }

    async function recursiveDeleteCollection(collectionName) {
      console.log(`  Clearing ${collectionName} (recursive)...`);
      const snapshot = await db.collection(collectionName).get();

      if (snapshot.empty) {
        console.log(`    ⚪ No documents found in ${collectionName}`);
        return 0;
      }

      let deleted = 0;
      for (const doc of snapshot.docs) {
        await db.recursiveDelete(doc.ref);
        deleted += 1;
      }
      console.log(`    ✅ Recursively deleted ${deleted} document(s) from ${collectionName}`);
      return deleted;
    }
    
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

    // IMPORTANT:
    // - Deleting a parent document does NOT delete its subcollections.
    // - The Firestore UI will show "grey" documents that "do not exist" but still have subcollections.
    // - Phantom documents cannot be discovered by listing a collection (because the parent doc doesn't exist),
    //   so recursive deletes alone are insufficient.
    // We first delete known subcollection docs via collectionGroup() to remove phantom parents,
    // then recursively delete top-level collections.

    // Common nested collections in this codebase:
    // - users/{uid}/assignments/{administrationId}
    // - users/{uid}/runs/{runId}
    // - administrations/{id}/(assignedOrgs|readOrgs|stats)/*
    // - tasks/{taskId}/variants/{variantId}
    await deleteCollectionGroup("assignments");
    await deleteCollectionGroup("runs");
    await deleteCollectionGroup("assignedOrgs");
    await deleteCollectionGroup("readOrgs");
    await deleteCollectionGroup("stats");
    await deleteCollectionGroup("variants");

    await recursiveDeleteCollection('users');
    await recursiveDeleteCollection('administrations');
    await recursiveDeleteCollection('tasks');

    // These collections should not have deep subcollections in the emulator seed data.
    const flatCollections = ['system', 'userClaims', 'districts', 'schools', 'classes', 'groups'];
    for (const collectionName of flatCollections) {
      console.log(`  Clearing ${collectionName}...`);
      const snapshot = await db.collection(collectionName).get();

      if (!snapshot.empty) {
        const batch = db.batch();
        snapshot.docs.forEach((doc) => {
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
