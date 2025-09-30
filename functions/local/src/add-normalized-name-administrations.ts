/**
 * Script to add normalizedName property to all administration documents.
 * Takes the name property and normalizes it using the normalize function from helpers.
 */

import * as admin from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import yargs from "yargs";
import cliProgress from "cli-progress";
import * as fs from "fs";
import { normalizeToLowercase } from "../../../helpers/index.js";

interface Args {
  dryRun: boolean;
  environment: "dev" | "prod";
  batchSize: number;
  testSize?: number;
  outputFile: string;
}

const argv = yargs(process.argv.slice(2))
  .options({
    dryRun: {
      alias: "d",
      description: "Dry run mode: show what would be done without making changes",
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
    testSize: {
      alias: "t",
      description: "Amount of documents to test on. Only process these amount of documents",
      type: "number",
    },
    outputFile: {
      alias: "o",
      description: "Output file for results",
      type: "string",
      default: "normalized-name-results.txt",
    },
  })
  .help("help")
  .alias("help", "h").argv as Args;

const dryRun = argv.dryRun;
const isDev = argv.environment === "dev";

// Set up environment variables for admin project
const envVariable = "LEVANTE_ADMIN_FIREBASE_CREDENTIALS";
const credentialFile = process.env[envVariable];

if (!credentialFile) {
  console.error(
    `Missing required environment variable: ${envVariable}
    Please set this environment variable using
    export ${envVariable}=path/to/credentials/for/admin/project.json`,
  );
  process.exit(1);
}

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

interface ProcessingResults {
  processedCount: number;
  modifiedCount: number;
  skippedCount: number;
  errorCount: number;
  administrations: {
    id: string;
    name: string;
    normalizedName: string;
    action: "added" | "updated" | "skipped" | "error";
    error?: string;
  }[];
}

async function processAdministrations(
  db: FirebaseFirestore.Firestore
): Promise<ProcessingResults> {
  console.log("\n📝 Processing administration documents...");

  // Get all administrations or limited for testing
  const query = argv.testSize 
    ? db.collection("administrations").limit(argv.testSize)
    : db.collection("administrations");
  
  const snapshot = await query.get();
  
  if (snapshot.empty) {
    console.log("No administration documents found.");
    return {
      processedCount: 0,
      modifiedCount: 0,
      skippedCount: 0,
      errorCount: 0,
      administrations: [],
    };
  }

  const progressBar = new cliProgress.SingleBar({
    format: "Processing [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}",
    barCompleteChar: "#",
    barIncompleteChar: ".",
  });
  
  progressBar.start(snapshot.size, 0);
  
  const results: ProcessingResults = {
    processedCount: 0,
    modifiedCount: 0,
    skippedCount: 0,
    errorCount: 0,
    administrations: [],
  };

  let batch = db.batch();
  let operationCount = 0;
  const BATCH_LIMIT = argv.batchSize;

  for (const doc of snapshot.docs) {
    try {
      const data = doc.data();
      const name = data.name as string;
      const existingNormalizedName = data.normalizedName as string | undefined;

      if (!name || typeof name !== "string") {
        results.administrations.push({
          id: doc.id,
          name: name || "N/A",
          normalizedName: "N/A",
          action: "error",
          error: "Missing or invalid name field",
        });
        results.errorCount++;
        results.processedCount++;
        progressBar.update(results.processedCount);
        continue;
      }

      const normalizedName = normalizeToLowercase(name);

      // Check if we need to update
      if (existingNormalizedName === normalizedName) {
        results.administrations.push({
          id: doc.id,
          name,
          normalizedName,
          action: "skipped",
        });
        results.skippedCount++;
      } else {
        const action = existingNormalizedName ? "updated" : "added";
        
        results.administrations.push({
          id: doc.id,
          name,
          normalizedName,
          action,
        });
        
        results.modifiedCount++;

        if (!dryRun) {
          batch.update(doc.ref, { normalizedName });
          operationCount++;
          
          if (operationCount >= BATCH_LIMIT) {
            await batch.commit();
            batch = db.batch();
            operationCount = 0;
          }
        }
      }

      results.processedCount++;
      progressBar.update(results.processedCount);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      results.administrations.push({
        id: doc.id,
        name: "Error reading document",
        normalizedName: "N/A",
        action: "error",
        error: errorMessage,
      });
      results.errorCount++;
      results.processedCount++;
      progressBar.update(results.processedCount);
    }
  }
  
  // Commit remaining operations
  if (!dryRun && operationCount > 0) {
    await batch.commit();
  }
  
  progressBar.stop();
  return results;
}

function writeResultsToFile(results: ProcessingResults, outputFile: string) {
  console.log(`\n📄 Writing results to ${outputFile}...`);
  
  const output = `Administration Normalized Name Addition Results
=============================================

Environment: ${argv.environment}
Dry run mode: ${dryRun ? "ON" : "OFF"}
Generated at: ${new Date().toISOString()}

Summary:
--------
Total processed: ${results.processedCount}
Modified: ${results.modifiedCount}
Skipped (already normalized): ${results.skippedCount}
Errors: ${results.errorCount}

Detailed Results:
-----------------
${results.administrations.map(admin => 
  `${admin.id}: ${admin.name} -> "${admin.normalizedName}" (${admin.action})${admin.error ? ` - Error: ${admin.error}` : ""}`
).join('\n')}

Configuration:
--------------
Batch size: ${argv.batchSize}
${argv.testSize ? `Test size: ${argv.testSize}` : 'Processing all documents'}
`;

  fs.writeFileSync(outputFile, output);
  console.log(`✅ Results written to ${outputFile}`);
}

async function main() {
  try {
    console.log(`\nRunning Add Normalized Name to Administrations in ${argv.environment} environment`);
    console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
    
    // Initialize Firebase
    console.log("Initializing Firebase connection...");
    const app = await initializeApp();
    const db = getFirestore(app);
    console.log("Firebase connection established successfully");

    // Process administrations
    const results = await processAdministrations(db);

    // Write results
    writeResultsToFile(results, argv.outputFile);

    // Print summary
    console.log("\n" + "=".repeat(60));
    console.log("OPERATION SUMMARY");
    console.log("=".repeat(60));
    console.log(`Environment: ${argv.environment}`);
    console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
    console.log(`Batch size: ${argv.batchSize}`);
    console.log(`Total processed: ${results.processedCount}`);
    console.log(`Modified: ${results.modifiedCount}`);
    console.log(`Skipped: ${results.skippedCount}`);
    console.log(`Errors: ${results.errorCount}`);
    console.log("=".repeat(60));
    
    if (dryRun) {
      console.log("🔍 This was a dry run. No changes were made to the database.");
      console.log("🚀 Run without --dryRun flag to execute changes.");
    } else {
      console.log("✅ Operation completed successfully!");
    }
    
    console.log("=".repeat(60));

  } catch (error) {
    console.error("Fatal error during execution:", error);
    process.exit(1);
  }
}

// Run the script
main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});
