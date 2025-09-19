/**
 * Adds role information to user documents based on their userType and organization associations.
 * This script determines appropriate roles (super_admin, admin, participant) for users based on
 * their userClaims and organization memberships, then updates their user documents accordingly.
 */

import * as admin from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import cliProgress from "cli-progress";

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
    default: "dev",
  })
  .option("dry-run", {
    describe: "Run without making changes to the database",
    type: "boolean",
    default: true,
  })
  .option("batch-size", {
    describe: "Number of documents to process in each batch",
    type: "number",
    default: 500,
  })
  .help()
  .alias("help", "h")
  .parseSync();

const isDev = parsedArgs.d === "dev";
const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";
const dryRun = parsedArgs["dry-run"];
const batchSize = parsedArgs["batch-size"];

console.log(`Using ${isDev ? "development" : "production"} database`);
console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
console.log(`Batch size: ${batchSize}`);

// Initialize Firebase Admin SDK
const adminApp = admin.initializeApp(
  {
    credential: admin.cert(adminCredentials),
    projectId,
  },
  "admin",
);

const db = getFirestore(adminApp);

// Types for role structure
interface UserRole {
  siteId: string;
  role: "super_admin" | "admin" | "participant";
}

/**
 * Gets unique district IDs from an organization hierarchy
 */
async function getDistrictIdsFromOrgs(user: any): Promise<Set<string>> {
  const districtIds = new Set<string>();

  // Check direct districts
  if (user.districts?.all && Array.isArray(user.districts.all)) {
    user.districts.all.forEach((districtId: string) => {
      if (districtId) districtIds.add(districtId);
    });
  }

  // If we already have districts, return them
  if (districtIds.size > 0) {
    return districtIds;
  }

  // Otherwise, traverse the organization hierarchy
  const fetchPromises: Promise<void>[] = [];

  // Check schools
  if (user.schools?.all && Array.isArray(user.schools.all)) {
    for (const schoolId of user.schools.all) {
      fetchPromises.push(
        db.collection("schools").doc(schoolId).get().then((doc) => {
          if (doc.exists) {
            const data = doc.data();
            if (data?.districtId) {
              districtIds.add(data.districtId);
            }
          }
        }).catch((error) => {
          console.warn(`Failed to fetch school ${schoolId}: ${error.message}`);
        })
      );
    }
  }

  // Check classes
  if (user.classes?.all && Array.isArray(user.classes.all)) {
    for (const classId of user.classes.all) {
      fetchPromises.push(
        db.collection("classes").doc(classId).get().then((doc) => {
          if (doc.exists) {
            const data = doc.data();
            if (data?.districtId) {
              districtIds.add(data.districtId);
            }
          }
        }).catch((error) => {
          console.warn(`Failed to fetch class ${classId}: ${error.message}`);
        })
      );
    }
  }

  // Check groups
  if (user.groups?.all && Array.isArray(user.groups.all)) {
    for (const groupId of user.groups.all) {
      fetchPromises.push(
        db.collection("groups").doc(groupId).get().then((doc) => {
          if (doc.exists) {
            const data = doc.data();
            if (data?.parentOrgId) {
              districtIds.add(data.parentOrgId);
            }
          }
        }).catch((error) => {
          console.warn(`Failed to fetch group ${groupId}: ${error.message}`);
        })
      );
    }
  }

  // Wait for all fetches to complete
  await Promise.all(fetchPromises);

  return districtIds;
}

/**
 * Gets unique district IDs from adminOrgs in userClaims
 */
async function getDistrictIdsFromAdminOrgs(adminOrgs: any): Promise<Set<string>> {
  const districtIds = new Set<string>();

  // Add direct districts
  if (adminOrgs?.districts && Array.isArray(adminOrgs.districts)) {
    adminOrgs.districts.forEach((districtId: string) => {
      if (districtId) districtIds.add(districtId);
    });
  }

  // Traverse organization hierarchy for additional districts
  const fetchPromises: Promise<void>[] = [];

  // Check schools
  if (adminOrgs?.schools && Array.isArray(adminOrgs.schools)) {
    for (const schoolId of adminOrgs.schools) {
      fetchPromises.push(
        db.collection("schools").doc(schoolId).get().then((doc) => {
          if (doc.exists) {
            const data = doc.data();
            if (data?.districtId) {
              districtIds.add(data.districtId);
            }
          }
        }).catch((error) => {
          console.warn(`Failed to fetch school ${schoolId}: ${error.message}`);
        })
      );
    }
  }

  // Check classes
  if (adminOrgs?.classes && Array.isArray(adminOrgs.classes)) {
    for (const classId of adminOrgs.classes) {
      fetchPromises.push(
        db.collection("classes").doc(classId).get().then((doc) => {
          if (doc.exists) {
            const data = doc.data();
            if (data?.districtId) {
              districtIds.add(data.districtId);
            }
          }
        }).catch((error) => {
          console.warn(`Failed to fetch class ${classId}: ${error.message}`);
        })
      );
    }
  }

  // Check groups
  if (adminOrgs?.groups && Array.isArray(adminOrgs.groups)) {
    for (const groupId of adminOrgs.groups) {
      fetchPromises.push(
        db.collection("groups").doc(groupId).get().then((doc) => {
          if (doc.exists) {
            const data = doc.data();
            if (data?.parentOrgId) {
              districtIds.add(data.parentOrgId);
            }
          }
        }).catch((error) => {
          console.warn(`Failed to fetch group ${groupId}: ${error.message}`);
        })
      );
    }
  }

  // Wait for all fetches to complete
  await Promise.all(fetchPromises);

  return districtIds;
}

/**
 * Determines roles for an admin user based on their userClaims
 */
async function getAdminRoles(userId: string): Promise<UserRole[]> {
  const roles: UserRole[] = [];

  try {
    const userClaimsDoc = await db.collection("userClaims").doc(userId).get();
    
    if (!userClaimsDoc.exists) {
      console.warn(`No userClaims document found for admin user ${userId}`);
      return roles;
    }

    const claims = userClaimsDoc.data()?.claims;
    
    if (!claims) {
      console.warn(`No claims field found in userClaims for user ${userId}`);
      return roles;
    }

    // Check if super admin
    if (claims.super_admin === true) {
      roles.push({
        siteId: "any",
        role: "super_admin"
      });
      return roles;
    }

    // Regular admin - get all districts from adminOrgs (including hierarchy traversal)
    if (claims.adminOrgs) {
      const districtIds = await getDistrictIdsFromAdminOrgs(claims.adminOrgs);
      
      for (const districtId of districtIds) {
        roles.push({
          siteId: districtId,
          role: "admin"
        });
      }
    }

    if (roles.length === 0) {
      console.warn(`Admin user ${userId} has no associated districts`);
    }

  } catch (error) {
    console.error(`Error getting admin roles for user ${userId}: ${error}`);
  }

  return roles;
}

/**
 * Determines roles for a participant user based on their organization associations
 */
async function getParticipantRoles(user: any): Promise<UserRole[]> {
  const roles: UserRole[] = [];
  const districtIds = await getDistrictIdsFromOrgs(user);

  for (const districtId of districtIds) {
    roles.push({
      siteId: districtId,
      role: "participant"
    });
  }

  if (roles.length === 0) {
    console.warn(`Participant user ${user.id} has no associated districts`);
  }

  return roles;
}

/**
 * Main function to add roles to all users
 */
async function addUserRoles() {
  try {
    console.log("\n========================================");
    console.log("Adding roles to user documents");
    console.log("========================================\n");

    // Get all users
    const usersSnapshot = await db.collection("users").get();
    const totalUsers = usersSnapshot.size;

    if (totalUsers === 0) {
      console.log("No users found in the database");
      return;
    }

    console.log(`Found ${totalUsers} users to process\n`);

    // Progress bar
    const progressBar = new cliProgress.SingleBar({
      format: "Processing users [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}",
      barCompleteChar: "#",
      barIncompleteChar: ".",
    });

    progressBar.start(totalUsers, 0);

    // Statistics
    let processed = 0;
    let updated = 0;
    let skipped = 0;
    let errors = 0;
    const userTypeStats: Record<string, number> = {};
    const roleStats: Record<string, number> = {};

    // Process users in batches
    let batch = db.batch();
    let batchCount = 0;

    for (const userDoc of usersSnapshot.docs) {
      const userId = userDoc.id;
      const userData = userDoc.data();
      const userType = userData.userType || "unknown";

      // Track user types
      userTypeStats[userType] = (userTypeStats[userType] || 0) + 1;

      try {
        // Skip if user already has roles field (unless we want to overwrite)
        if (userData.roles && Array.isArray(userData.roles) && userData.roles.length > 0) {
          skipped++;
          processed++;
          progressBar.update(processed);
          continue;
        }

        let roles: UserRole[] = [];

        // Determine roles based on userType
        if (userType === "admin") {
          roles = await getAdminRoles(userId);
        } else if (["student", "parent", "teacher"].includes(userType)) {
          roles = await getParticipantRoles({ ...userData, id: userId });
        } else {
          console.warn(`\nUnknown userType '${userType}' for user ${userId}`);
          skipped++;
          processed++;
          progressBar.update(processed);
          continue;
        }

        // Track role statistics
        for (const role of roles) {
          roleStats[role.role] = (roleStats[role.role] || 0) + 1;
        }

        // Update the user document
        if (roles.length > 0) {
          if (!dryRun) {
            batch.update(userDoc.ref, {
              roles: roles
            });
            batchCount++;

            // Commit batch if it reaches the size limit
            if (batchCount >= batchSize) {
              await batch.commit();
              batch = db.batch();
              batchCount = 0;
            }
          }
          updated++;
        } else {
          // User has no roles to add (no associated districts)
          skipped++;
        }

      } catch (error) {
        console.error(`\nError processing user ${userId}: ${error}`);
        errors++;
      }

      processed++;
      progressBar.update(processed);
    }

    // Commit any remaining batch operations
    if (!dryRun && batchCount > 0) {
      await batch.commit();
    }

    progressBar.stop();

    // Print summary
    console.log("\n========================================");
    console.log("SUMMARY");
    console.log("========================================");
    console.log(`Environment: ${isDev ? "development" : "production"}`);
    console.log(`Dry run: ${dryRun ? "YES (no changes made)" : "NO (changes applied)"}`);
    console.log(`\nTotal users processed: ${processed}`);
    console.log(`Users updated: ${updated}`);
    console.log(`Users skipped: ${skipped}`);
    console.log(`Errors: ${errors}`);
    
    console.log("\nUser types processed:");
    for (const [type, count] of Object.entries(userTypeStats)) {
      console.log(`  ${type}: ${count}`);
    }

    console.log("\nRoles assigned:");
    for (const [role, count] of Object.entries(roleStats)) {
      console.log(`  ${role}: ${count}`);
    }

    if (dryRun) {
      console.log("\n⚠️  This was a DRY RUN. No changes were made to the database.");
      console.log("Run with --dry-run=false to apply changes.");
    } else {
      console.log("\n✅ Roles successfully added to user documents!");
    }

    console.log("========================================\n");

  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  } finally {
    // Clean up Firebase app
    try {
      const app = admin.getApps().find((app) => app.name === "admin");
      if (app) {
        await admin.deleteApp(app);
      }
    } catch (error) {
      console.error("Error deleting Firebase app:", error);
    }
  }
}

// Execute the main function
addUserRoles();
