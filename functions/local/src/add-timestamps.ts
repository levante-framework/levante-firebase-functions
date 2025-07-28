import * as admin from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import yargs from "yargs";
import cliProgress from "cli-progress";

/**
 * Adds createdAt and updatedAt fields to all documents in specified collections and sub-collections.
 * If a document already has these fields and they're not empty, it skips them.
 * If the document has existing date fields (like dateCreated), it uses those values.
 */
interface Args {
  dryRun: boolean;
  environment: "dev" | "prod";
  batchSize: number;
}

const argv = yargs(process.argv.slice(2))
  .options({
    dryRun: {
      alias: "d",
      description: "Dry run mode: show what would be updated without making changes",
      type: "boolean",
      default: true,
    },
    environment: {
      alias: "e",
      description: "Environment to run against",
      choices: ["dev", "prod"] as const,
      default: "dev" as const,
    },
    batchSize: {
      alias: "b",
      description: "Batch size for Firestore operations",
      type: "number",
      default: 500,
    },
  })
  .help("help")
  .alias("help", "h").argv as Args;

const dryRun = argv.dryRun;
const isDev = argv.environment === "dev";

// Set up environment variables for admin project
const envVariable = "ROAR_ADMIN_FIREBASE_CREDENTIALS";
const credentialFile = process.env[envVariable];

if (!credentialFile) {
  console.error(
    `Missing required environment variable: ${envVariable}
    Please set this environment variable using
    export ${envVariable}=path/to/credentials/for/admin/project.json`,
  );
  process.exit(1);
}

console.log(`Running add-timestamps script in ${argv.environment} environment`);
console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);

/**
 * Initialize Firebase app
 */
const initializeApp = async () => {
  const credentials = (
    await import(credentialFile, {
      assert: { type: "json" },
    })
  ).default;

  const projectId = isDev
    ? "hs-levante-admin-dev"
    : "hs-levante-admin-prod";

  return admin.initializeApp(
    {
      credential: admin.cert(credentials),
      projectId,
    },
    "admin",
  );
};

/**
 * Helper function to determine createdAt value based on existing fields
 */
function getCreatedAtValue(data: any): Timestamp | null {
  // Check various possible existing date fields
  if (data.dateCreated && data.dateCreated instanceof Timestamp) {
    return data.dateCreated;
  }
  if (data.created && data.created instanceof Timestamp) {
    return data.created;
  }
  if (data.timeStarted && data.timeStarted instanceof Timestamp) {
    return data.timeStarted;
  }
  if (data.timestamp && data.timestamp instanceof Timestamp) {
    return data.timestamp;
  }
  return null;
}

/**
 * Helper function to determine updatedAt value based on existing fields
 */
function getUpdatedAtValue(data: any): Timestamp | null {
  // Check various possible existing date fields
  if (data.dateUpdated && data.dateUpdated instanceof Timestamp) {
    return data.dateUpdated;
  }
  if (data.lastUpdated && data.lastUpdated instanceof Timestamp) {
    return data.lastUpdated;
  }
  if (data.timeFinished && data.timeFinished instanceof Timestamp) {
    return data.timeFinished;
  }
  if (data.timestamp && data.timestamp instanceof Timestamp) {
    return data.timestamp;
  }
  // If no specific update field, use created field
  return getCreatedAtValue(data);
}

/**
 * Process a collection or subcollection
 */
async function processCollection(
  db: FirebaseFirestore.Firestore,
  collectionPath: string,
  parentDoc?: FirebaseFirestore.DocumentSnapshot
): Promise<{ processed: number; updated: number }> {
  console.log(`\n📝 Processing collection: ${collectionPath}`);
  
  let query: FirebaseFirestore.Query | FirebaseFirestore.CollectionReference;
  
  if (parentDoc) {
    query = parentDoc.ref.collection(collectionPath);
  } else {
    query = db.collection(collectionPath);
  }
  
  const snapshot = await query.get();
  
  if (snapshot.empty) {
    console.log(`  ⚠️  Collection is empty`);
    return { processed: 0, updated: 0 };
  }
  
  const progressBar = new cliProgress.SingleBar({
    format: `Processing ${collectionPath} [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}`,
    barCompleteChar: "#",
    barIncompleteChar: ".",
  });
  
  progressBar.start(snapshot.size, 0);
  
  let processed = 0;
  let updated = 0;
  let batch = db.batch();
  let operationCount = 0;
  
  for (const doc of snapshot.docs) {
    const data = doc.data();
    const updates: any = {};
    let needsUpdate = false;
    
    // Check createdAt
    if (!data.createdAt || (data.createdAt instanceof Timestamp && data.createdAt.toMillis() === 0)) {
      const createdValue = getCreatedAtValue(data);
      if (createdValue) {
        updates.createdAt = createdValue;
        needsUpdate = true;
      } else {
        // Use current timestamp as fallback
        updates.createdAt = Timestamp.now();
        needsUpdate = true;
      }
    }
    
    // Check updatedAt
    if (!data.updatedAt || (data.updatedAt instanceof Timestamp && data.updatedAt.toMillis() === 0)) {
      const updatedValue = getUpdatedAtValue(data);
      if (updatedValue) {
        updates.updatedAt = updatedValue;
        needsUpdate = true;
      } else {
        // Use current timestamp as fallback
        updates.updatedAt = Timestamp.now();
        needsUpdate = true;
      }
    }
    
    if (needsUpdate) {
      if (!dryRun) {
        batch.update(doc.ref, updates);
        operationCount++;
        
        if (operationCount >= argv.batchSize) {
          await batch.commit();
          batch = db.batch();
          operationCount = 0;
        }
      }
      updated++;
    }
    
    processed++;
    progressBar.update(processed);
  }
  
  // Commit remaining operations
  if (!dryRun && operationCount > 0) {
    await batch.commit();
  }
  
  progressBar.stop();
  console.log(`  ✅ Processed: ${processed}, Updated: ${updated}`);
  
  return { processed, updated };
}

/**
 * Process tasks collection with variants subcollection
 */
async function processTasksWithVariants(db: FirebaseFirestore.Firestore): Promise<{ processed: number; updated: number }> {
  console.log("\n📝 Processing tasks collection with variants subcollection");
  
  const tasksSnapshot = await db.collection("tasks").get();
  let totalProcessed = 0;
  let totalUpdated = 0;
  
  // Process tasks documents
  const tasksResult = await processCollection(db, "tasks");
  totalProcessed += tasksResult.processed;
  totalUpdated += tasksResult.updated;
  
  // Process variants subcollection for each task
  for (const taskDoc of tasksSnapshot.docs) {
    const variantsQuery = taskDoc.ref.collection("variants").where("name", "!=", null);
    const variantsSnapshot = await variantsQuery.get();
    
    if (!variantsSnapshot.empty) {
      console.log(`\n  📂 Processing variants for task: ${taskDoc.id}`);
      const variantsResult = await processCollection(db, "variants", taskDoc);
      totalProcessed += variantsResult.processed;
      totalUpdated += variantsResult.updated;
    }
  }
  
  return { processed: totalProcessed, updated: totalUpdated };
}

/**
 * Main execution function
 */
async function addTimestamps() {
  try {
    console.log("\nInitializing Firebase connection...");
    
    // Initialize Firebase app
    const app = await initializeApp();
    const db = getFirestore(app);
    
    console.log("Firebase connection established successfully");
    
    let totalProcessed = 0;
    let totalUpdated = 0;
    
    // Process administrations and its subcollections
    const adminResult = await processCollection(db, "administrations");
    totalProcessed += adminResult.processed;
    totalUpdated += adminResult.updated;
    
    // Process administrations subcollections
    const adminSnapshot = await db.collection("administrations").get();
    for (const adminDoc of adminSnapshot.docs) {
      // assignedOrgs
      const assignedOrgsResult = await processCollection(db, "assignedOrgs", adminDoc);
      totalProcessed += assignedOrgsResult.processed;
      totalUpdated += assignedOrgsResult.updated;
      
      // readOrgs
      const readOrgsResult = await processCollection(db, "readOrgs", adminDoc);
      totalProcessed += readOrgsResult.processed;
      totalUpdated += readOrgsResult.updated;
      
      // stats
      const statsResult = await processCollection(db, "stats", adminDoc);
      totalProcessed += statsResult.processed;
      totalUpdated += statsResult.updated;
    }
    
    // Process other collections
    const collections = ["classes", "districts", "groups", "schools", "guests", "users"];
    
    for (const collection of collections) {
      const result = await processCollection(db, collection);
      totalProcessed += result.processed;
      totalUpdated += result.updated;
      
      // Process subcollections for guests and users
      if (collection === "guests" || collection === "users") {
        const parentSnapshot = await db.collection(collection).get();
        
        for (const parentDoc of parentSnapshot.docs) {
          // Process runs subcollection
          const runsResult = await processCollection(db, "runs", parentDoc);
          totalProcessed += runsResult.processed;
          totalUpdated += runsResult.updated;
          
          // Process assignments subcollection (only for users)
          if (collection === "users") {
            const assignmentsResult = await processCollection(db, "assignments", parentDoc);
            totalProcessed += assignmentsResult.processed;
            totalUpdated += assignmentsResult.updated;
          }
        }
      }
    }
    
    // Process tasks with variants
    const tasksResult = await processTasksWithVariants(db);
    totalProcessed += tasksResult.processed;
    totalUpdated += tasksResult.updated;
    
    // Print summary
    console.log("\n" + "=".repeat(60));
    console.log("TIMESTAMP UPDATE SUMMARY");
    console.log("=".repeat(60));
    console.log(`Environment: ${argv.environment}`);
    console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
    console.log(`Batch size: ${argv.batchSize}`);
    console.log("=".repeat(60));
    console.log(`Total documents processed: ${totalProcessed}`);
    console.log(`Total documents ${dryRun ? "would be updated" : "updated"}: ${totalUpdated}`);
    console.log("=".repeat(60));
    
    if (dryRun) {
      console.log("🔍 This was a dry run. No changes were made to the database.");
      console.log("🚀 Run without --dryRun flag to update timestamps.");
    } else {
      console.log("✅ Timestamp update operation completed successfully!");
    }
    
    console.log("=".repeat(60));
    
  } catch (error) {
    console.error("Fatal error during execution:", error);
    process.exit(1);
  }
}

// Run the script
addTimestamps().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
