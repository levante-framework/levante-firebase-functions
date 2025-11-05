/**
 * Script to add the siteId property to all administration documents.
 *
 * The siteId corresponds to the district a given administration belongs to.
 * We determine it using the following precedence:
 *   1. The first entry in the administration's districts array (if present)
 *   2. The district associated with any referenced school
 *   3. The district associated with any referenced class
 *   4. The district referenced by a group's parentOrgId
 */

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
      default: "site-id-results.txt",
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

type CacheMap = Map<string, string | null>;

interface OrgCaches {
  schools: CacheMap;
  classes: CacheMap;
  groups: CacheMap;
}

interface AdministrationProcessingResult {
  id: string;
  name: string;
  action: "added" | "updated" | "skipped" | "missing" | "error";
  siteId?: string;
  source?: string;
  sourceId?: string;
  notes?: string;
  error?: string;
}

interface ProcessingResults {
  processedCount: number;
  modifiedCount: number;
  skippedCount: number;
  missingCount: number;
  errorCount: number;
  administrations: AdministrationProcessingResult[];
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

async function getDistrictIdFromSchool(
  db: FirebaseFirestore.Firestore,
  schoolId: string,
  caches: OrgCaches,
): Promise<string | null> {
  if (caches.schools.has(schoolId)) {
    return caches.schools.get(schoolId) ?? null;
  }

  const doc = await db.collection("schools").doc(schoolId).get();

  if (!doc.exists) {
    caches.schools.set(schoolId, null);
    return null;
  }

  const data = doc.data();
  const districtId =
    typeof data?.districtId === "string" && data.districtId.trim().length > 0
      ? data.districtId.trim()
      : null;

  caches.schools.set(schoolId, districtId);
  return districtId;
}

async function getDistrictIdFromClass(
  db: FirebaseFirestore.Firestore,
  classId: string,
  caches: OrgCaches,
): Promise<string | null> {
  if (caches.classes.has(classId)) {
    return caches.classes.get(classId) ?? null;
  }

  const doc = await db.collection("classes").doc(classId).get();

  if (!doc.exists) {
    caches.classes.set(classId, null);
    return null;
  }

  const data = doc.data();
  const districtId =
    typeof data?.districtId === "string" && data.districtId.trim().length > 0
      ? data.districtId.trim()
      : null;

  caches.classes.set(classId, districtId);
  return districtId;
}

async function getDistrictIdFromGroup(
  db: FirebaseFirestore.Firestore,
  groupId: string,
  caches: OrgCaches,
): Promise<string | null> {
  if (caches.groups.has(groupId)) {
    return caches.groups.get(groupId) ?? null;
  }

  const doc = await db.collection("groups").doc(groupId).get();

  if (!doc.exists) {
    caches.groups.set(groupId, null);
    return null;
  }

  const data = doc.data();
  const districtId =
    typeof data?.parentOrgId === "string" &&
    data.parentOrgId.trim().length > 0
      ? data.parentOrgId.trim()
      : null;

  caches.groups.set(groupId, districtId);
  return districtId;
}

async function determineSiteId(
  db: FirebaseFirestore.Firestore,
  data: FirebaseFirestore.DocumentData,
  caches: OrgCaches,
): Promise<{ siteId: string | null; source?: string; sourceId?: string }>
{
  const districts = ensureStringArray(data.districts);
  if (districts.length > 0) {
    return {
      siteId: districts[0],
      source: "districts",
      sourceId: districts[0],
    };
  }

  const schools = ensureStringArray(data.schools);
  for (const schoolId of schools) {
    const districtId = await getDistrictIdFromSchool(db, schoolId, caches);
    if (districtId) {
      return { siteId: districtId, source: "schools", sourceId: schoolId };
    }
  }

  const classes = ensureStringArray(data.classes);
  for (const classId of classes) {
    const districtId = await getDistrictIdFromClass(db, classId, caches);
    if (districtId) {
      return { siteId: districtId, source: "classes", sourceId: classId };
    }
  }

  const groups = ensureStringArray(data.groups);
  for (const groupId of groups) {
    const districtId = await getDistrictIdFromGroup(db, groupId, caches);
    if (districtId) {
      return { siteId: districtId, source: "groups", sourceId: groupId };
    }
  }

  return { siteId: "" };
}

async function processAdministrations(
  db: FirebaseFirestore.Firestore,
): Promise<ProcessingResults> {
  console.log("\n📝 Processing administration documents...");

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
      missingCount: 0,
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

  const caches: OrgCaches = {
    schools: new Map(),
    classes: new Map(),
    groups: new Map(),
  };

  const results: ProcessingResults = {
    processedCount: 0,
    modifiedCount: 0,
    skippedCount: 0,
    missingCount: 0,
    errorCount: 0,
    administrations: [],
  };

  let batch = db.batch();
  let operationCount = 0;
  const BATCH_LIMIT = argv.batchSize;

  for (const doc of snapshot.docs) {
    try {
      const data = doc.data();
      const name =
        typeof data.name === "string" && data.name.trim().length > 0
          ? data.name.trim()
          : "N/A";

      const existingSiteId =
        typeof data.siteId === "string" && data.siteId.trim().length > 0
          ? data.siteId.trim()
          : undefined;

      const { siteId, source, sourceId } = await determineSiteId(
        db,
        data,
        caches,
      );

      if (!siteId) {
        results.administrations.push({
          id: doc.id,
          name,
          action: "missing",
          notes:
            "Unable to determine district from districts, schools, classes, or groups",
        });
        results.missingCount++;
        results.processedCount++;
        progressBar.update(results.processedCount);
        continue;
      }

      if (existingSiteId === siteId) {
        results.administrations.push({
          id: doc.id,
          name,
          action: "skipped",
          siteId,
          source,
          sourceId,
          notes: "siteId already set with matching value",
        });
        results.skippedCount++;
        results.processedCount++;
        progressBar.update(results.processedCount);
        continue;
      }

      const action: AdministrationProcessingResult["action"] = existingSiteId
        ? "updated"
        : "added";

      results.administrations.push({
        id: doc.id,
        name,
        action,
        siteId,
        source,
        sourceId,
        notes:
          existingSiteId && existingSiteId !== siteId
            ? `Replacing existing siteId ${existingSiteId}`
            : undefined,
      });

      results.modifiedCount++;

      if (!dryRun) {
        batch.update(doc.ref, { siteId });
        operationCount++;

        if (operationCount >= BATCH_LIMIT) {
          await batch.commit();
          batch = db.batch();
          operationCount = 0;
        }
      }

      results.processedCount++;
      progressBar.update(results.processedCount);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      results.administrations.push({
        id: doc.id,
        name: "Error reading document",
        action: "error",
        error: errorMessage,
      });
      results.errorCount++;
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

  const output = `Add siteId to Administrations Results
========================================

Environment: ${argv.environment}
Dry run mode: ${dryRun ? "ON" : "OFF"}
Generated at: ${new Date().toISOString()}

Summary:
--------
Total processed: ${results.processedCount}
Modified (added/updated): ${results.modifiedCount}
Skipped: ${results.skippedCount}
Missing siteId: ${results.missingCount}
Errors: ${results.errorCount}

Detailed Results:
-----------------
${results.administrations
    .map((admin) => {
      const base = `${admin.id}: ${admin.name} -> ${admin.action.toUpperCase()}`;
      const siteIdPart = admin.siteId ? ` | siteId: ${admin.siteId}` : "";
      const sourcePart = admin.source
        ? ` | source: ${admin.source}${
            admin.sourceId ? ` (${admin.sourceId})` : ""
          }`
        : "";
      const notesPart = admin.notes ? ` | notes: ${admin.notes}` : "";
      const errorPart = admin.error ? ` | error: ${admin.error}` : "";
      return `${base}${siteIdPart}${sourcePart}${notesPart}${errorPart}`;
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
      `\nRunning Add siteId to Administrations in ${argv.environment} environment`,
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
    console.log(`Missing siteId: ${results.missingCount}`);
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


