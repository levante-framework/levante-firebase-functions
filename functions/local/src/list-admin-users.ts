#!/usr/bin/env node
import * as admin from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

function escapeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const str = String(value);
  const needsQuotes =
    str.includes(",") ||
    str.includes("\"") ||
    str.includes("\n") ||
    str.includes("\r");
  if (!needsQuotes) return str;
  return `"${str.replace(/"/g, "\"\"")}"`;
}

function toCsv<T extends Record<string, unknown>>(
  rows: T[],
  headers: (keyof T)[],
): string {
  const headerLine = headers.join(",");
  const lines = rows.map((row) =>
    headers.map((h) => escapeCsvCell(row[h])).join(","),
  );
  return [headerLine, ...lines].join("\n") + "\n";
}

function getUserName(userData: FirebaseFirestore.DocumentData): string | undefined {
  if (userData.displayName) return userData.displayName;

  const first = userData.name?.first;
  const middle = userData.name?.middle;
  const last = userData.name?.last;
  const parts = [first, middle, last].filter(Boolean) as string[];
  if (parts.length === 0) return undefined;
  return parts.join(" ");
}

// Check for required environment variables
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
  .option("o", {
    alias: "out",
    type: "string",
    describe:
      "Output CSV path (default: ./admin-users-<db>-<timestamp>.csv in current directory)",
  })
  .help()
  .alias("help", "h")
  .parseSync();

const isDev = parsedArgs.d === "dev";
const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";
const timestamp = new Date().toISOString().replace(/:/g, "-");
const outArg = parsedArgs.out as string | undefined;
const outPath = outArg ?
  path.resolve(outArg) :
  path.resolve(`admin-users-${isDev ? "dev" : "prod"}-${timestamp}.csv`);

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

    // Extract emails, names, and IDs for display
    const userInfo = filteredUsers.map((doc) => {
      const userData = doc.data();
      return {
        id: doc.id,
        email: userData.email,
        name: getUserName(userData),
      };
    });

    // Display results in a table
    console.log(
      `\nFound ${userInfo.length} admin users without 'levante' in their email:`,
    );
    console.table(userInfo);

    const csv = toCsv(userInfo, ["id", "email", "name"]);
    await writeFile(outPath, csv, { encoding: "utf8" });
    console.log(`\nWrote CSV: ${outPath}`);
  } catch (error) {
    console.error("Error fetching admin users:", error);
    process.exit(1);
  } finally {
    // Clean up Firebase app
    try {
      await admin.deleteApp(adminApp);
    } catch (error) {
      console.error("Error deleting Firebase app:", error);
    }
  }
}

// Execute the main function
listAdminUsers();
