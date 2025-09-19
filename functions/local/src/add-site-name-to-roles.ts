import * as admin from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
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
    describe: "Number of user documents to update per batch commit",
    type: "number",
    default: 500,
  })
  .option("test-size", {
    describe: "Amount of user documents to process (testing only)",
    type: "number",
  })
  .help()
  .alias("help", "h")
  .parseSync();

const isDev = parsedArgs.d === "dev";
const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";
const dryRun = parsedArgs["dry-run"] as boolean;
const batchSize = parsedArgs["batch-size"] as number;
const testSize = (parsedArgs["test-size"] as number | undefined) ?? undefined;

console.log(`Using ${isDev ? "development" : "production"} database`);
console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
console.log(`Batch size: ${batchSize}`);
if (typeof testSize === "number" && testSize > 0) {
  console.log(`Test size: limiting to ${testSize} users`);
}

// Initialize Firebase Admin SDK
const adminApp = admin.initializeApp(
  {
    credential: admin.cert(adminCredentials),
    projectId,
  },
  "admin",
);

const db = getFirestore(adminApp);

type RoleObject = Record<string, unknown> & {
  siteId?: string;
  role?: string;
  siteName?: string;
};

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function buildSiteIdToNameMap(siteIds: Set<string>): Promise<Map<string, string>> {
  const idList = Array.from(siteIds).filter((id) => !!id);
  const idToName = new Map<string, string>();

  if (idList.length === 0) return idToName;

  // Firestore 'in' operator supports up to 30 values per query
  const idChunks = chunk(idList, 30);

  for (const ids of idChunks) {
    const snapshot = await db
      .collection("districts")
      .where(FieldPath.documentId(), "in", ids)
      .get();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const name = (data?.name as string) ?? "";
      idToName.set(doc.id, name);
    }
  }

  return idToName;
}

async function addSiteNamesToRoles() {
  try {
    console.log("\n========================================");
    console.log("Adding siteName to user.roles entries");
    console.log("========================================\n");

    // Fetch users (optionally limited for testing)
    const usersSnapshot =
      typeof testSize === "number" && testSize > 0
        ? await db.collection("users").limit(testSize).get()
        : await db.collection("users").get();
    const totalUsers = usersSnapshot.size;

    if (totalUsers === 0) {
      console.log("No users found in the database");
      return;
    }

    console.log(`Found ${totalUsers} users to process\n`);

    // First pass: collect all siteIds that are missing siteName
    const siteIdsToFetch = new Set<string>();
    for (const userDoc of usersSnapshot.docs) {
      const data = userDoc.data();
      const roles = Array.isArray(data.roles) ? (data.roles as RoleObject[]) : [];
      for (const role of roles) {
        if (role && typeof role === "object") {
          const siteId = (role.siteId as string) || "";
          const hasSiteName = typeof role.siteName === "string" && role.siteName.length > 0;
          if (siteId && !hasSiteName) {
            siteIdsToFetch.add(siteId);
          }
        }
      }
    }

    console.log(`Unique siteIds needing lookup: ${siteIdsToFetch.size}`);

    // Build map of siteId -> district.name
    const siteIdToName = await buildSiteIdToNameMap(siteIdsToFetch);

    // Progress bar for updates
    const progressBar = new cliProgress.SingleBar({
      format: "Updating users [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}",
      barCompleteChar: "#",
      barIncompleteChar: ".",
    });
    progressBar.start(totalUsers, 0);

    // Stats
    let processed = 0;
    let usersUpdated = 0;
    let rolesModified = 0;
    let rolesMissingDistrict = 0;
    const updatedUsersSummary: { userId: string; rolesUpdated: number }[] = [];

    // Batch writes
    let batch = db.batch();
    let batchCount = 0;

    for (const userDoc of usersSnapshot.docs) {
      const data = userDoc.data();
      const roles = Array.isArray(data.roles) ? (data.roles as RoleObject[]) : [];

      if (roles.length === 0) {
        processed++;
        progressBar.update(processed);
        continue;
      }

      let changed = false;
      let userRolesModified = 0;
      const updatedRoles: RoleObject[] = roles.map((role) => {
        if (!role || typeof role !== "object") return role;

        const siteId = (role.siteId as string) || "";
        const hasSiteName = typeof role.siteName === "string" && role.siteName.length > 0;
        if (!siteId || hasSiteName) {
          return role;
        }

        const siteName = siteIdToName.get(siteId);
        if (siteName !== undefined) {
          changed = true;
          rolesModified++;
          userRolesModified++;
          return { ...role, siteName };
        } else {
          // District not found
          rolesMissingDistrict++;
          changed = true;
          userRolesModified++;
          return { ...role, siteName: "" };
        }
      });

      if (changed) {
        if (!dryRun) {
          batch.update(userDoc.ref, { roles: updatedRoles });
          batchCount++;
          if (batchCount >= batchSize) {
            await batch.commit();
            batch = db.batch();
            batchCount = 0;
          }
        }
        usersUpdated++;
        if (typeof testSize === "number" && testSize > 0) {
          updatedUsersSummary.push({ userId: userDoc.id, rolesUpdated: userRolesModified });
        }
      }

      processed++;
      progressBar.update(processed);
    }

    if (!dryRun && batchCount > 0) {
      await batch.commit();
    }

    progressBar.stop();

    // If running with test-size, list out updated user IDs
    if (typeof testSize === "number" && testSize > 0) {
      if (updatedUsersSummary.length > 0) {
        console.log("\nUpdated users (test-size mode):");
        for (const u of updatedUsersSummary) {
          console.log(` - ${u.userId} (${u.rolesUpdated} roles updated)`);
        }
      } else {
        console.log("\nNo users were updated in test-size run.");
      }
    }

    // Summary
    console.log("\n========================================");
    console.log("SUMMARY");
    console.log("========================================");
    console.log(`Environment: ${isDev ? "development" : "production"}`);
    console.log(`Dry run: ${dryRun ? "YES (no changes made)" : "NO (changes applied)"}`);
    console.log(`Users processed: ${processed}`);
    console.log(`Users updated: ${usersUpdated}`);
    console.log(`Roles updated with siteName: ${rolesModified}`);
    console.log(`Roles with missing districts: ${rolesMissingDistrict}`);
    console.log("========================================\n");

    if (dryRun) {
      console.log("⚠️  This was a DRY RUN. No changes were made to the database.");
      console.log("Run with --dry-run=false to apply changes.");
    } else {
      console.log("✅ siteName added to applicable roles.");
    }
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  } finally {
    // Clean up Firebase app
    try {
      const app = (await import("firebase-admin/app")).getApps().find((a) => a.name === "admin");
      if (app) {
        await (await import("firebase-admin/app")).deleteApp(app);
      }
    } catch (err) {
      console.error("Error deleting Firebase app:", err);
    }
  }
}

// Execute the main function
addSiteNamesToRoles();


