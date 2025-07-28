import * as admin from "firebase-admin/app";
import { getFirestore, WriteBatch } from "firebase-admin/firestore";
import { DocumentReference } from "firebase-admin/firestore";
import yargs from "yargs";
import cliProgress from "cli-progress";

interface Args {
  dryRun: boolean;
  environment: "dev" | "prod";
  limit: number;
  batchSize: number;
}

const argv = yargs(process.argv.slice(2))
  .options({
    dryRun: {
      alias: "d",
      description: "Dry run mode: show what would be merged without making changes",
      type: "boolean",
      default: true,
    },
    environment: {
      alias: "e",
      description: "Environment to run against",
      choices: ["dev", "prod"] as const,
      default: "dev" as const,
    },
    limit: {
      alias: "l",
      description: "Limit number of assessment users to process (0 = no limit)",
      type: "number",
      default: 100,
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

console.log(`Running merge-users script in ${argv.environment} environment`);
console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);

/**
 * Copy subcollections from one user document to another with batching
 */
async function copyUserSubcollections(
  fromUserRef: DocumentReference,
  toUserRef: DocumentReference,
  fromUserId: string,
  toUserId: string,
  db: FirebaseFirestore.Firestore
): Promise<{ success: boolean; error?: string; copiedRuns: number; copiedTrials: number }> {
  try {
    const runsCollectionRef = fromUserRef.collection("runs");
    const runsSnapshot = await runsCollectionRef.get();
    
    let copiedRuns = 0;
    let copiedTrials = 0;

    if (runsSnapshot.empty) {
      return { success: true, copiedRuns: 0, copiedTrials: 0 };
    }

    // Use batch operations for better performance
    let batch = db.batch();
    let operationCount = 0;
    const BATCH_LIMIT = 500; // Firestore batch limit

    for (const runDoc of runsSnapshot.docs) {
      const runData = runDoc.data();
      const runId = runDoc.id;
      
      // Check if run already exists in target user
      const targetRunRef = toUserRef.collection("runs").doc(runId);
      const existingRun = await targetRunRef.get();
      
      if (existingRun.exists) {
        continue;
      }

      if (!dryRun) {
        // Add run document to batch
        batch.set(targetRunRef, runData);
        operationCount++;
        
        // Commit batch if we're approaching the limit
        if (operationCount >= BATCH_LIMIT - 100) { // Leave room for trials
          await batch.commit();
          batch = db.batch();
          operationCount = 0;
        }
      }
      copiedRuns++;

      // Copy trials subcollection
      const trialsCollectionRef = runDoc.ref.collection("trials");
      const trialsSnapshot = await trialsCollectionRef.get();
      
      if (!trialsSnapshot.empty) {
        for (const trialDoc of trialsSnapshot.docs) {
          const trialData = trialDoc.data();
          const trialId = trialDoc.id;
          
          if (!dryRun) {
            // Add trial document to batch
            batch.set(targetRunRef.collection("trials").doc(trialId), trialData);
            operationCount++;
            
            // Commit batch if we're approaching the limit
            if (operationCount >= BATCH_LIMIT) {
              await batch.commit();
              batch = db.batch();
              operationCount = 0;
            }
          }
          copiedTrials++;
        }
      }
    }
    
    // Commit any remaining operations
    if (!dryRun && operationCount > 0) {
      await batch.commit();
    }

    return { success: true, copiedRuns, copiedTrials };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`  Error copying subcollections: ${errorMessage}`);
    return { success: false, error: errorMessage, copiedRuns: 0, copiedTrials: 0 };
  }
}

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
 * Main execution function
 */
async function mergeUsers() {
  try {
    console.log("\nInitializing Firebase connection...");
    
    // Initialize Firebase app for admin project (where both collections exist)
    const app = await initializeApp();
    const db = getFirestore(app);

    console.log("Firebase connection established successfully");

    // Get references to both collections
    const usersCollection = db.collection("users");
    const assessmentUsersCollection = db.collection("assessmentUsers");

    console.log("\nFetching assessment users...");
    
    // Apply limit for testing/dry runs
    let assessmentUsersSnapshot;
    if (argv.limit > 0) {
      console.log(`Limiting to ${argv.limit} assessment users for processing`);
      assessmentUsersSnapshot = await assessmentUsersCollection.limit(argv.limit).get();
    } else {
      assessmentUsersSnapshot = await assessmentUsersCollection.get();
    }
    
    if (assessmentUsersSnapshot.empty) {
      console.log("No assessment users found. Nothing to merge.");
      return;
    }

    console.log(`Found ${assessmentUsersSnapshot.size} assessment users to process`);

    let processedCount = 0;
    let successCount = 0;
    let skippedCount = 0;
    let errorCount = 0;
    let totalCopiedRuns = 0;
    let totalCopiedTrials = 0;

    // Set up progress bar
    const progressBar = new cliProgress.SingleBar({
      format: "Processing users [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}",
      barCompleteChar: "#",
      barIncompleteChar: ".",
    });
    
    progressBar.start(assessmentUsersSnapshot.size, 0);

    // Process each assessment user
    for (const assessmentUserDoc of assessmentUsersSnapshot.docs) {
      const assessmentUserId = assessmentUserDoc.id;
      processedCount++;

      // Look for matching user in the users collection
      const userDocRef = usersCollection.doc(assessmentUserId);
      const userDoc = await userDocRef.get();

      if (!userDoc.exists) {
        skippedCount++;
        progressBar.update(processedCount);
        continue;
      }

      // Copy subcollections from assessmentUser to user
      const result = await copyUserSubcollections(
        assessmentUserDoc.ref,
        userDocRef,
        assessmentUserId,
        userDoc.id,
        db
      );

      if (result.success) {
        successCount++;
        totalCopiedRuns += result.copiedRuns;
        totalCopiedTrials += result.copiedTrials;
      } else {
        errorCount++;
        // Only show errors immediately
        progressBar.stop();
        console.log(`❌ Error processing user ${assessmentUserId}: ${result.error}`);
        progressBar.start(assessmentUsersSnapshot.size, processedCount);
      }
      
      progressBar.update(processedCount);
    }
    
    progressBar.stop();
    console.log(); // Add newline after progress bar

    // Print summary
    console.log("=".repeat(60));
    console.log("MERGE SUMMARY");
    console.log("=".repeat(60));
    console.log(`Environment: ${argv.environment}`);
    console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
    console.log(`Limit applied: ${argv.limit > 0 ? argv.limit : "No limit"}`);
    console.log(`Batch size: ${argv.batchSize}`);
    console.log("=".repeat(60));
    console.log(`Total assessment users processed: ${processedCount}`);
    console.log(`Successfully merged: ${successCount}`);
    console.log(`Skipped (no matching user): ${skippedCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log("=".repeat(60));
    console.log(`Total runs ${dryRun ? "would be copied" : "copied"}: ${totalCopiedRuns}`);
    console.log(`Total trials ${dryRun ? "would be copied" : "copied"}: ${totalCopiedTrials}`);

    console.log("=".repeat(60));
    
    if (dryRun) {
      console.log("🔍 This was a dry run. No changes were made to the database.");
      console.log("🚀 Run without --dryRun flag to perform the actual merge.");
    } else {
      console.log("✅ Merge operation completed successfully!");
    }
    
    console.log("=".repeat(60));

    // Clean up Firebase app
    await admin.deleteApp(app);

  } catch (error) {
    console.error("Fatal error during execution:", error);
    process.exit(1);
  }
}

// Run the script
mergeUsers().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
