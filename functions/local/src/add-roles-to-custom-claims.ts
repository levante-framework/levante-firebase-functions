#!/usr/bin/env node
/**
 * Adds user roles from Firestore user documents to Firebase Auth custom claims.
 * This script processes users in batches and ensures their roles field from the database
 * is synchronized with their Auth custom claims for authorization purposes.
 */

import * as admin from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import cliProgress from "cli-progress";

// CLI args
const parsedArgs = yargs(hideBin(process.argv))
  .option("d", {
    alias: "database",
    describe: "Database: 'dev' or 'prod'",
    choices: ["dev", "prod"],
    default: "dev",
  })
  .option("dry-run", {
    describe: "Run without making changes to Auth or Firestore",
    type: "boolean",
    default: true,
  })
  .option("batch-size", {
    describe: "Number of Firestore doc updates per batch commit",
    type: "number",
    default: 500,
  })
  .option("limit", {
    describe: "Maximum number of users to process. If omitted, processes all users (unless --uids provided)",
    type: "number",
  })
  .option("uids", {
    describe: "Comma-separated list of user UIDs to process (overrides --limit if provided)",
    type: "string",
  })
  .help()
  .alias("help", "h")
  .parseSync();

const isDev = parsedArgs.d === "dev";
const dryRun = parsedArgs["dry-run"] as boolean;
const batchSize = parsedArgs["batch-size"] as number;
const limitArg = (parsedArgs["limit"] as number | undefined) ?? undefined;
const uidsArg = (parsedArgs["uids"] as string | undefined) ?? undefined;

console.log(`Using ${isDev ? "development" : "production"} database`);
console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
console.log(`Batch size: ${batchSize}`);
if (uidsArg) {
  console.log(`Targeting specific UIDs: ${uidsArg}`);
} else if (typeof limitArg === "number") {
  console.log(`Limiting to at most ${limitArg} user(s)`);
}

// Env var for Admin credentials (admin project only)
const adminCredentialFile = process.env.LEVANTE_ADMIN_FIREBASE_CREDENTIALS;

if (!adminCredentialFile) {
  console.error(
    `Missing required environment variable:
    - LEVANTE_ADMIN_FIREBASE_CREDENTIALS
    Please set this environment variable using
    export LEVANTE_ADMIN_FIREBASE_CREDENTIALS=path/to/credentials/for/admin/project.json`,
  );
  process.exit(1);
}

// Import admin credentials (ESM JSON import)
const adminCredentials = (
  await import(adminCredentialFile, {
    assert: { type: "json" },
  })
).default;

// Initialize Firebase Admin SDK (admin project)
const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";
const adminApp = admin.initializeApp(
  {
    credential: admin.cert(adminCredentials),
    projectId,
  },
  "admin",
);

const db = getFirestore(adminApp);
const auth = getAuth(adminApp);

type AnyObject = { [key: string]: any };

/**
 * Safely coerce user.roles to an array; return [] if missing/invalid
 */
const coerceRolesArray = (rolesValue: unknown): any[] => {
  if (Array.isArray(rolesValue)) return rolesValue;
  return [];
};

/**
 * Ensure custom claims JSON length is within 1000 byte limit (stringified length approximation)
 */
const claimsWithinLimit = (claims: AnyObject): boolean => {
  try {
    const str = JSON.stringify(claims);
    return str.length <= 1000;
  } catch {
    return false;
  }
};

/**
 * Main execution
 */
async function addRolesToCustomClaimsForAllUsers() {
  try {
    console.log("\n========================================");
    console.log("Adding roles from user docs into custom claims");
    console.log("========================================\n");

    let userDocs: Array<FirebaseFirestore.QueryDocumentSnapshot | FirebaseFirestore.DocumentSnapshot> = [];

    if (uidsArg) {
      const uids = uidsArg
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      if (uids.length === 0) {
        console.error("No valid UIDs provided via --uids");
        return;
      }
      console.log(`Fetching ${uids.length} user document(s) by UID...`);
      const docs = await Promise.all(
        uids.map((uid) => db.collection("users").doc(uid).get()),
      );
      userDocs = docs.filter((d) => d.exists);
      const missing = docs.filter((d) => !d.exists).map((d) => d.id);
      if (missing.length > 0) {
        console.warn(`Warning: ${missing.length} UID(s) not found: ${missing.join(", ")}`);
      }
    } else {
      let usersQuery: FirebaseFirestore.Query = db.collection("users");
      if (typeof limitArg === "number") {
        if (!Number.isFinite(limitArg) || limitArg <= 0) {
          console.error("--limit must be a positive integer");
          return;
        }
        usersQuery = usersQuery.limit(limitArg);
      }
      const usersSnapshot = await usersQuery.get();
      userDocs = usersSnapshot.docs;
    }

    const totalUsers = userDocs.length;

    if (totalUsers === 0) {
      console.log("No users found in the database");
      return;
    }

    console.log(`Found ${totalUsers} users to process\n`);

    const progressBar = new cliProgress.SingleBar({
      format: "Processing users [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}",
      barCompleteChar: "#",
      barIncompleteChar: ".",
    });
    progressBar.start(totalUsers, 0);

    let processed = 0;
    let authUpdated = 0;
    let userDocsUpdated = 0;
    let errors = 0;

    let batch = db.batch();
    let batchCount = 0;

    for (const userDoc of userDocs) {
      const uid = userDoc.id;
      const userData = userDoc.data() as AnyObject;
      const rolesArray = coerceRolesArray(userData.roles);

      try {
        // 1) If user doc lacks a valid roles array, update it with []
        if (!Array.isArray(userData.roles)) {
          if (!dryRun) {
            batch.update(userDoc.ref, { roles: [] });
            batchCount++;
            if (batchCount >= batchSize) {
              await batch.commit();
              batch = db.batch();
              batchCount = 0;
            }
          }
          userDocsUpdated++;
        }

        // 2) Merge roles into existing custom claims in Auth
        let currentClaims: AnyObject = {};
        try {
          const userRecord = await auth.getUser(uid);
          currentClaims = (userRecord.customClaims as AnyObject) || {};
        } catch (authErr: any) {
          console.warn(`Auth user not found or error for uid ${uid}: ${authErr?.message || authErr}`);
          // Continue to ensure Firestore roles field is set; skip claims write
          processed++;
          progressBar.update(processed);
          continue;
        }

        const newClaims = { ...currentClaims, roles: rolesArray } as AnyObject;

        if (!claimsWithinLimit(newClaims)) {
          console.error(`Skipping claims update for ${uid}: claims exceed size limit`);
        } else if (!dryRun) {
          await auth.setCustomUserClaims(uid, newClaims);
          authUpdated++;
        } else {
          authUpdated++;
        }


      } catch (err) {
        console.error(`Error processing user ${uid}:`, err);
        errors++;
      }

      processed++;
      progressBar.update(processed);
    }

    // Commit remaining batched Firestore updates
    if (!dryRun && batchCount > 0) {
      await batch.commit();
    }

    progressBar.stop();

    console.log("\n========================================");
    console.log("SUMMARY");
    console.log("========================================");
    console.log(`Environment: ${isDev ? "development" : "production"}`);
    console.log(`Dry run: ${dryRun ? "YES (no changes made)" : "NO (changes applied)"}`);
    console.log(`\nTotal users processed: ${processed}`);
    console.log(`Auth custom claims updated: ${authUpdated}`);
    console.log(`User docs updated with blank roles: ${userDocsUpdated}`);
    console.log(`Errors: ${errors}`);
    console.log("========================================\n");
  } catch (fatalErr) {
    console.error("Fatal error:", fatalErr);
    process.exit(1);
  } finally {
    try {
      await admin.deleteApp(adminApp);
    } catch (e) {
      // noop
    }
  }
}

addRolesToCustomClaimsForAllUsers();


