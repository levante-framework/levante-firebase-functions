#!/usr/bin/env node
/**
 * Updates user claims to add district associations.
 * This script adds a specified district ID to the adminOrgs and minimalAdminOrgs
 * district arrays in userClaims documents for specified users.
 */

import * as admin from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import * as fs from "fs/promises";

// Check for required environment variables
const adminCredentialFile = process.env.ROAR_ADMIN_FIREBASE_CREDENTIALS;

if (!adminCredentialFile) {
  console.error(
    `Missing required environment variable:
    - ROAR_ADMIN_FIREBASE_CREDENTIALS
    Please set this environment variable using
    export ROAR_ADMIN_FIREBASE_CREDENTIALS=path/to/credentials/for/admin/project.json`,
  );
  process.exit(1);
}

// Import admin credentials
const adminCredentials = (
  await import(adminCredentialFile, {
    assert: { type: "json" },
  })
).default;

// Parse command line arguments
const parsedArgs = yargs(hideBin(process.argv))
  .option("d", {
    alias: "database",
    describe: "Database: 'dev' or 'prod'",
    choices: ["dev", "prod"],
    default: "prod",
  })
  .option("district", {
    describe: "District ID to add to user claims",
    type: "string",
    demandOption: true,
  })
  .option("u", {
    alias: "uids",
    describe: "Comma-separated list of user UIDs",
    type: "string",
  })
  .option("file", {
    describe: "Path to file containing user UIDs (one per line)",
    type: "string",
  })
  .check((argv) => {
    if (!argv.u && !argv.file) {
      throw new Error("Either -u or --file must be provided");
    }

    // Validate district ID
    if (
      !argv.district ||
      typeof argv.district !== "string" ||
      argv.district.trim() === ""
    ) {
      throw new Error("District ID must be a non-empty string");
    }

    return true;
  })
  .help()
  .alias("help", "h")
  .parseSync();

const isDev = parsedArgs.d === "dev";
const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";
const districtId = parsedArgs.district.trim();

// Validate district ID again to be safe
if (!districtId) {
  console.error("Error: District ID cannot be empty");
  process.exit(1);
}

console.log(`Using ${isDev ? "development" : "production"} database`);
console.log(`District ID to add: "${districtId}"`);

// Initialize Firebase Admin SDK
const adminApp = admin.initializeApp(
  {
    credential: admin.cert(adminCredentials),
    projectId,
  },
  "admin",
);

const db = getFirestore(adminApp);

/**
 * Get user UIDs from command line arguments or file
 */
async function getUserUids(): Promise<string[]> {
  if (parsedArgs.u) {
    const uids = parsedArgs.u
      .split(",")
      .map((uid) => uid.trim())
      .filter((uid) => uid.length > 0);
    return uids;
  } else if (parsedArgs.file) {
    try {
      const content = await fs.readFile(parsedArgs.file, "utf-8");
      const uids = content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return uids;
    } catch (error) {
      console.error(`Error reading UIDs file: ${error}`);
      process.exit(1);
    }
  }
  return [];
}

/**
 * Main function to update user claims with district ID
 */
async function updateUserDistrictClaims() {
  try {
    const userUids = await getUserUids();

    if (userUids.length === 0) {
      console.error("No user UIDs provided");
      process.exit(1);
    }

    console.log(`Updating claims for ${userUids.length} users...`);

    // Verify district exists
    try {
      const districtDoc = await db
        .collection("districts")
        .doc(districtId)
        .get();

      if (!districtDoc.exists) {
        console.error(`District with ID "${districtId}" not found.`);
        process.exit(1);
      }

      const districtData = districtDoc.data();
      console.log(`Found district: ${districtData?.name} (ID: ${districtId})`);
    } catch (error) {
      console.error(`Error fetching district: ${error}`);
      console.error(`Please check if "${districtId}" is a valid district ID`);
      process.exit(1);
    }

    // Process each user UID
    const batch = db.batch();
    const notFoundUids: string[] = [];
    const updatedUids: string[] = [];

    for (const uid of userUids) {
      if (!uid || uid.trim() === "") {
        console.warn("Skipping empty UID");
        continue;
      }

      try {
        const userClaimsDoc = await db.collection("userClaims").doc(uid).get();

        if (!userClaimsDoc.exists) {
          notFoundUids.push(uid);
          continue;
        }

        // Update the user claims document
        batch.update(userClaimsDoc.ref, {
          "claims.adminOrgs.districts": FieldValue.arrayUnion(districtId),
          "claims.minimalAdminOrgs.districts":
            FieldValue.arrayUnion(districtId),
        });

        updatedUids.push(uid);
      } catch (error) {
        console.error(`Error processing UID "${uid}": ${error}`);
      }
    }

    // Commit the batch if there are updates
    if (updatedUids.length > 0) {
      try {
        await batch.commit();
        console.log(
          `Successfully updated claims for ${updatedUids.length} users`,
        );
      } catch (error) {
        console.error(`Error committing batch updates: ${error}`);
        process.exit(1);
      }
    } else {
      console.log("No user claims were updated");
    }

    // Report not found UIDs
    if (notFoundUids.length > 0) {
      console.warn(
        `The following UIDs were not found in userClaims: ${notFoundUids.join(
          ", ",
        )}`,
      );
    }
  } catch (error) {
    console.error("Error updating user district claims:", error);
    process.exit(1);
  } finally {
    // Clean up Firebase app
    try {
      const app = admin.getApps().find((app) => app.name === "admin");
      if (app) {
        await app.delete();
      }
    } catch (error) {
      console.error("Error deleting Firebase app:", error);
    }
  }
}

// Execute the main function
updateUserDistrictClaims();
