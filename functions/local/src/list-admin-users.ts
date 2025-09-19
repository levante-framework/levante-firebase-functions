#!/usr/bin/env node
/**
 * Lists admin users whose emails don't contain specific internal domains.
 * This script queries for admin users and filters out those with internal domains
 * like 'levante', 'test', 'stanford', etc., to identify external admin users.
 */

import * as admin from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

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
  .help()
  .alias("help", "h")
  .parseSync();

const isDev = parsedArgs.d === "dev";
const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";

console.log(`Using ${isDev ? "development" : "production"} database`);

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
 * Main function to fetch admin users whose emails don't include "levante"
 */
async function listAdminUsers() {
  try {
    console.log("Fetching admin users without 'levante' in their email...");

    // Query users collection for admin users
    const usersSnapshot = await db
      .collection("users")
      .where("userType", "==", "admin")
      .get();

    if (usersSnapshot.empty) {
      console.log("No admin users found.");
      return;
    }

    // Filter users whose emails don't include "levante"
    const filteredUsers = usersSnapshot.docs.filter((doc) => {
      const userData = doc.data();
      return (
        userData.email &&
        !userData.email.includes("levante") &&
        !userData.email.includes("test") &&
        !userData.email.includes("stanford") &&
        !userData.email.includes("hs-levante") &&
        !userData.email.includes("tarmac") &&
        !userData.email.includes("learningtapestry")
      );
    });

    if (filteredUsers.length === 0) {
      console.log("No admin users found without 'levante' in their email.");
      return;
    }

    // Extract emails and IDs for display
    const userInfo = filteredUsers.map((doc) => ({
      id: doc.id,
      email: doc.data().email,
    }));

    // Display results in a table
    console.log(
      `\nFound ${userInfo.length} admin users without 'levante' in their email:`,
    );
    console.table(userInfo);
  } catch (error) {
    console.error("Error fetching admin users:", error);
    process.exit(1);
  } finally {
    // Clean up Firebase app
    try {
      await adminApp.delete();
    } catch (error) {
      console.error("Error deleting Firebase app:", error);
    }
  }
}

// Execute the main function
listAdminUsers();
