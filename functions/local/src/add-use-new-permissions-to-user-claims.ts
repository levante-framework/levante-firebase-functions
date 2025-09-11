import * as admin from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import yargs from "yargs";
import cliProgress from "cli-progress";

interface Args {
  dryRun: boolean;
  environment: "dev" | "prod";
  batchSize: number;
  testSize: number;
  printSkipped: boolean;
}

const argv = yargs(process.argv.slice(2))
  .options({
    dryRun: {
      alias: "d",
      description:
        "Dry run mode: show what would be done without making changes",
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
      description:
        "Limit processing to the first N userClaims documents (0 = no limit)",
      type: "number",
      default: 0,
    },
    printSkipped: {
      alias: "p",
      description:
        "Also print IDs of skipped documents (already had useNewPermissions=false)",
      type: "boolean",
      default: false,
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

  const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";

  return admin.initializeApp(
    {
      credential: admin.cert(credentials),
      projectId,
    },
    "admin",
  );
};

type ProcessResults = {
  processedCount: number;
  modifiedCount: number;
  skippedCount: number;
  errors: Array<{ id: string; message: string }>;
};

async function processUserClaims(
  db: FirebaseFirestore.Firestore,
): Promise<ProcessResults> {
  console.log("\n📝 Processing userClaims documents...");

  const snapshot = await db.collection("userClaims").get();
  const docs = argv.testSize > 0 ? snapshot.docs.slice(0, argv.testSize) : snapshot.docs;
  const total = docs.length;

  if (total === 0) {
    console.log("No userClaims documents found.");
    return { processedCount: 0, modifiedCount: 0, skippedCount: 0, errors: [] };
  }

  const progressBar = new cliProgress.SingleBar({
    format: "Processing [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}",
    barCompleteChar: "#",
    barIncompleteChar: ".",
  });

  progressBar.start(total, 0);

  let processedCount = 0;
  let modifiedCount = 0;
  let skippedCount = 0;
  const errors: Array<{ id: string; message: string }> = [];

  let batch = db.batch();
  let operationCount = 0;
  const BATCH_LIMIT = argv.batchSize;

  for (const doc of docs) {
    try {
      const data = doc.data();
      const current = data?.claims?.useNewPermissions;

      // Only update if not already explicitly false
      if (current !== false) {
        if (!dryRun) {
          batch.update(doc.ref, { "claims.useNewPermissions": false });
          operationCount++;

          if (operationCount >= BATCH_LIMIT) {
            await batch.commit();
            batch = db.batch();
            operationCount = 0;
          }
        }
        console.log(
          dryRun
            ? `DRY RUN - would modify userClaims: ${doc.id}`
            : `Modified userClaims: ${doc.id}`,
        );
        modifiedCount++;
      } else {
        skippedCount++;
        if (argv.printSkipped) {
          console.log(`Skipped userClaims: ${doc.id} (already false)`);
        }
      }
    } catch (error: any) {
      errors.push({ id: doc.id, message: String(error?.message || error) });
    }

    processedCount++;
    progressBar.update(processedCount);
  }

  if (!dryRun && operationCount > 0) {
    await batch.commit();
  }

  progressBar.stop();

  return { processedCount, modifiedCount, skippedCount, errors };
}

async function main() {
  try {
    console.log(
      `\nRunning add-useNewPermissions-to-userClaims in ${argv.environment} environment`,
    );
    console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
    console.log(`Batch size: ${argv.batchSize}`);
    if (argv.testSize > 0) {
      console.log(`Test size: limiting to first ${argv.testSize} documents`);
    }

    console.log("Initializing Firebase connection...");
    const app = await initializeApp();
    const db = getFirestore(app);
    console.log("Firebase connection established successfully");

    const results = await processUserClaims(db);

    console.log("\n" + "=".repeat(60));
    console.log("OPERATION SUMMARY");
    console.log("=".repeat(60));
    console.log(`Environment: ${argv.environment}`);
    console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
    console.log(`Batch size: ${argv.batchSize}`);
    console.log(`Test size: ${argv.testSize > 0 ? argv.testSize : "no limit"}`);
    console.log(`Processed: ${results.processedCount}`);
    console.log(`Modified: ${results.modifiedCount}`);
    console.log(`Skipped: ${results.skippedCount}`);
    console.log(`Errors: ${results.errors.length}`);
    console.log("=".repeat(60));

    if (dryRun) {
      console.log(
        "🔍 This was a dry run. No changes were made to the database.",
      );
      console.log("🚀 Run with --dryRun=false to execute changes.");
    } else {
      console.log("✅ Operation completed successfully!");
    }

    console.log("=".repeat(60));
  } catch (error) {
    console.error("Fatal error during execution:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});


