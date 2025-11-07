import * as admin from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import yargs from "yargs";
import cliProgress from "cli-progress";
import * as fs from "fs";

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
        "Amount of documents to test on. Only process this number of documents",
      type: "number",
    },
    outputFile: {
      alias: "o",
      description: "Output file for results",
      type: "string",
      default: "creator-name-results.txt",
    },
  })
  .help("help")
  .alias("help", "h").argv as Args;

const dryRun = argv.dryRun;
const isDev = argv.environment === "dev";

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

type UserNameCacheEntry = {
  name: string;
  userExists: boolean;
};

type UserNameCache = Map<string, UserNameCacheEntry>;

interface AdministrationProcessingResult {
  id: string;
  name: string;
  action: "added" | "updated" | "skipped" | "error";
  creatorName: string;
  createdBy?: string;
  notes?: string;
  error?: string;
}

interface ProcessingResults {
  processedCount: number;
  modifiedCount: number;
  skippedCount: number;
  missingCreatorCount: number;
  missingUserCount: number;
  missingUserNameCount: number;
  errorCount: number;
  administrations: AdministrationProcessingResult[];
}

function buildNameFromUserData(
  data: FirebaseFirestore.DocumentData | undefined,
): string {
  if (!data) {
    return "";
  }

  const displayName =
    typeof data.displayName === "string" ? data.displayName.trim() : "";
  if (displayName) {
    return displayName;
  }

  const rawName = data.name;
  if (!rawName || typeof rawName !== "object" || Array.isArray(rawName)) {
    return "";
  }

  const nameObject = rawName as Partial<
    Record<"first" | "middle" | "last", unknown>
  >;

  const parts = ("first middle last".split(" ") as const)
    .map((key) => {
      const value = nameObject[key];
      if (typeof value !== "string") {
        return "";
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : "";
    })
    .filter((part) => part.length > 0);

  return parts.join(" ");
}

async function getCreatorName(
  db: FirebaseFirestore.Firestore,
  userId: string,
  cache: UserNameCache,
): Promise<UserNameCacheEntry> {
  if (cache.has(userId)) {
    return cache.get(userId)!;
  }

  const userDoc = await db.collection("users").doc(userId).get();

  if (!userDoc.exists) {
    const entry: UserNameCacheEntry = { name: "", userExists: false };
    cache.set(userId, entry);
    return entry;
  }

  const name = buildNameFromUserData(userDoc.data());
  const entry: UserNameCacheEntry = { name, userExists: true };
  cache.set(userId, entry);
  return entry;
}

async function processAdministrations(
  db: FirebaseFirestore.Firestore,
): Promise<ProcessingResults> {
  console.log("\n📝 Processing administration documents...");

  const collectionRef = db.collection("administrations");
  const query = argv.testSize ? collectionRef.limit(argv.testSize) : collectionRef;

  const snapshot = await query.get();

  if (snapshot.empty) {
    console.log("No administration documents found.");
    return {
      processedCount: 0,
      modifiedCount: 0,
      skippedCount: 0,
      missingCreatorCount: 0,
      missingUserCount: 0,
      missingUserNameCount: 0,
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

  const cache: UserNameCache = new Map();

  const results: ProcessingResults = {
    processedCount: 0,
    modifiedCount: 0,
    skippedCount: 0,
    missingCreatorCount: 0,
    missingUserCount: 0,
    missingUserNameCount: 0,
    errorCount: 0,
    administrations: [],
  };

  let batch = db.batch();
  let operationCount = 0;
  const BATCH_LIMIT = argv.batchSize;

  for (const doc of snapshot.docs) {
    try {
      const data = doc.data();
      const adminName =
        typeof data.name === "string" && data.name.trim().length > 0
          ? data.name.trim()
          : "N/A";

      const createdBy =
        typeof data.createdBy === "string" ? data.createdBy.trim() : "";

      const existingCreatorNameRaw =
        typeof data.creatorName === "string" ? data.creatorName : undefined;
      const existingCreatorName = existingCreatorNameRaw?.trim();

      let newCreatorName = "";
      const notes: string[] = [];

      if (!createdBy) {
        results.missingCreatorCount++;
        notes.push("createdBy field missing");
      } else {
        const { name, userExists } = await getCreatorName(db, createdBy, cache);
        newCreatorName = name.trim();

        if (!userExists) {
          results.missingUserCount++;
          notes.push("creator user document not found");
        } else if (!newCreatorName) {
          results.missingUserNameCount++;
          notes.push("creator user name empty");
        }
      }

      const hasExistingField = typeof existingCreatorNameRaw === "string";
      const shouldUpdate =
        !hasExistingField ||
        existingCreatorName !== newCreatorName ||
        (hasExistingField && existingCreatorNameRaw !== existingCreatorName);

      if (shouldUpdate) {
        results.modifiedCount++;

        const action: AdministrationProcessingResult["action"] =
          hasExistingField && existingCreatorNameRaw !== undefined
            ? "updated"
            : "added";

        results.administrations.push({
          id: doc.id,
          name: adminName,
          action,
          creatorName: newCreatorName,
          createdBy: createdBy || undefined,
          notes: notes.length > 0 ? notes.join("; ") : undefined,
        });

        if (!dryRun) {
          batch.update(doc.ref, { creatorName: newCreatorName });
          operationCount++;

          if (operationCount >= BATCH_LIMIT) {
            await batch.commit();
            batch = db.batch();
            operationCount = 0;
          }
        }
      } else {
        results.skippedCount++;

        results.administrations.push({
          id: doc.id,
          name: adminName,
          action: "skipped",
          creatorName: existingCreatorName ?? "",
          createdBy: createdBy || undefined,
          notes: notes.length > 0 ? notes.join("; ") : undefined,
        });
      }

      results.processedCount++;
      progressBar.update(results.processedCount);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      results.errorCount++;
      results.administrations.push({
        id: doc.id,
        name: "Error processing document",
        action: "error",
        creatorName: "",
        error: errorMessage,
      });
      results.processedCount++;
      progressBar.update(results.processedCount);
    }
  }

  if (!dryRun && operationCount > 0) {
    await batch.commit();
  }

  progressBar.stop();
  return results;
}

function writeResultsToFile(results: ProcessingResults, outputFile: string) {
  console.log(`\n📄 Writing results to ${outputFile}...`);

  const output = `Add creatorName to Administrations Results
========================================

Environment: ${argv.environment}
Dry run mode: ${dryRun ? "ON" : "OFF"}
Generated at: ${new Date().toISOString()}

Summary:
--------
Total processed: ${results.processedCount}
Modified (added/updated): ${results.modifiedCount}
Skipped: ${results.skippedCount}
Missing createdBy: ${results.missingCreatorCount}
Missing creator user document: ${results.missingUserCount}
Missing creator user name: ${results.missingUserNameCount}
Errors: ${results.errorCount}

Detailed Results:
-----------------
${results.administrations
    .map((admin) => {
      const base = `${admin.id}: ${admin.name} -> ${admin.action.toUpperCase()}`;
      const creatorNamePart = ` | creatorName: ${admin.creatorName}`;
      const createdByPart = admin.createdBy ? ` | createdBy: ${admin.createdBy}` : "";
      const notesPart = admin.notes ? ` | notes: ${admin.notes}` : "";
      const errorPart = admin.error ? ` | error: ${admin.error}` : "";
      return `${base}${creatorNamePart}${createdByPart}${notesPart}${errorPart}`;
    })
    .join("\n")}

Configuration:
--------------
Batch size: ${argv.batchSize}
${argv.testSize ? `Test size: ${argv.testSize}` : "Processing all documents"}
`;

  fs.writeFileSync(outputFile, output);
  console.log(`✅ Results written to ${outputFile}`);
}

async function main() {
  try {
    console.log(
      `\nRunning Add creatorName to Administrations in ${argv.environment} environment`,
    );
    console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);

    console.log("Initializing Firebase connection...");
    const app = await initializeApp();
    const db = getFirestore(app);
    console.log("Firebase connection established successfully");

    const results = await processAdministrations(db);

    writeResultsToFile(results, argv.outputFile);

    console.log("\n" + "=".repeat(60));
    console.log("OPERATION SUMMARY");
    console.log("=".repeat(60));
    console.log(`Environment: ${argv.environment}`);
    console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
    console.log(`Batch size: ${argv.batchSize}`);
    console.log(`Total processed: ${results.processedCount}`);
    console.log(`Modified: ${results.modifiedCount}`);
    console.log(`Skipped: ${results.skippedCount}`);
    console.log(`Missing createdBy: ${results.missingCreatorCount}`);
    console.log(`Missing creator user document: ${results.missingUserCount}`);
    console.log(`Missing creator user name: ${results.missingUserNameCount}`);
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

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});


