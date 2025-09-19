#!/usr/bin/env node
/**
 * Nests groups under a district in the organizational hierarchy.
 * This script takes a district name and a list of group names, then updates
 * the database to establish parent-child relationships between the district and groups.
 */

import * as admin from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
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
const argv = yargs(hideBin(process.argv))
  .option("d", {
    alias: "district",
    describe: "District name",
    type: "string",
    demandOption: true,
  })
  .option("g", {
    alias: "groups",
    describe: "Comma-separated list of group names",
    type: "string",
    demandOption: true,
  })
  .help()
  .alias("help", "h").argv;

const districtName = argv.district;
// Split the groups string by commas and trim whitespace
const groupNames = argv.groups.split(",").map((group: string) => group.trim());

console.log(`Nesting groups under district: ${districtName}`);
console.log(`Groups to nest: ${groupNames.join(", ")}`);

// Initialize Firebase Admin SDK
const adminApp = admin.initializeApp(
  {
    credential: admin.cert(adminCredentials),
    projectId: "hs-levante-admin-prod",
  },
  "admin",
);

const db = getFirestore(adminApp);

interface GroupInfo {
  id: string;
  name: string;
  data: any;
}

/**
 * Main function to nest groups under a district
 */
async function nestGroupsUnderDistrict() {
  try {
    // Find the district by name
    const districtQuerySnapshot = await db
      .collection("districts")
      .where("name", "==", districtName)
      .limit(1)
      .get();

    if (districtQuerySnapshot.empty) {
      console.error(`District with name "${districtName}" not found.`);
      process.exit(1);
    }

    const districtDoc = districtQuerySnapshot.docs[0];
    const districtId = districtDoc.id;
    console.log(`Found district: ${districtName} (ID: ${districtId})`);

    // Find groups by name
    const foundGroups: GroupInfo[] = [];
    const notFoundGroups: string[] = [];

    for (const groupName of groupNames) {
      const groupQuerySnapshot = await db
        .collection("groups")
        .where("name", "==", groupName)
        .limit(1)
        .get();

      if (groupQuerySnapshot.empty) {
        notFoundGroups.push(groupName);
        continue;
      }

      const groupDoc = groupQuerySnapshot.docs[0];
      foundGroups.push({
        id: groupDoc.id,
        name: groupName,
        data: groupDoc.data(),
      });
    }

    if (notFoundGroups.length > 0) {
      console.warn(
        `The following groups were not found: ${notFoundGroups.join(", ")}`,
      );
    }

    if (foundGroups.length === 0) {
      console.error("No groups were found to nest under the district.");
      process.exit(1);
    }

    // Update district and groups in a batch
    const batch = db.batch();

    // Update district document to add groups to subGroups array
    const groupIds = foundGroups.map((group) => group.id);
    batch.update(districtDoc.ref, {
      subGroups: FieldValue.arrayUnion(...groupIds),
    });

    // Update each group document to set parentOrgId and parentOrgType
    for (const group of foundGroups) {
      const groupRef = db.collection("groups").doc(group.id);
      batch.update(groupRef, {
        parentOrgId: districtId,
        parentOrgType: "districts",
      });
    }

    // Commit the batch
    await batch.commit();

    console.log(
      `Successfully nested ${foundGroups.length} groups under district "${districtName}"`,
    );
    console.log("Groups nested:");
    foundGroups.forEach((group) => {
      console.log(`- ${group.name} (ID: ${group.id})`);
    });
  } catch (error) {
    console.error("Error nesting groups under district:", error);
    process.exit(1);
  } finally {
    // Clean up Firebase app
    await adminApp.delete();
  }
}

// Execute the main function
nestGroupsUnderDistrict();
