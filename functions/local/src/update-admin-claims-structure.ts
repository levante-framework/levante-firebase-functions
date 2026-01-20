import * as admin from "firebase-admin/app";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
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
    describe: "Number of documents to update per batch commit",
    type: "number",
    default: 500,
  })
  .help()
  .alias("help", "h")
  .parseSync();

const isDev = parsedArgs.d === "dev";
const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";
const dryRun = parsedArgs["dry-run"] as boolean;
const batchSize = parsedArgs["batch-size"] as number;

console.log(`Using ${isDev ? "development" : "production"} database`);
console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);

// Initialize Firebase Admin SDK
const adminApp = admin.initializeApp(
  {
    credential: admin.cert(adminCredentials),
    projectId,
  },
  "admin",
);

const db = getFirestore(adminApp);
db.settings({ ignoreUndefinedProperties: true });
const auth = getAuth(adminApp);

interface UserRoleEntry {
  siteId?: unknown;
  siteName?: unknown;
  role?: unknown;
}

interface ClaimsUpdate {
  rolesSet: string[];
  siteRoles: Record<string, string[]>;
  siteNames: Record<string, string>;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

async function buildSiteIdToNameMap(
  siteIds: Set<string>,
): Promise<Map<string, string>> {
  const idList = Array.from(siteIds).filter((id) => !!id && id !== "any");
  const idToName = new Map<string, string>();

  if (idList.length === 0) return idToName;

  // Firestore 'in' operator supports up to 30 values per query
  const idChunks = chunk(idList, 30);

  for (const ids of idChunks) {
    try {
      const snapshot = await db
        .collection("districts")
        .where(FieldPath.documentId(), "in", ids)
        .get();

      for (const doc of snapshot.docs) {
        const data = doc.data();
        const name = (data?.name as string) ?? "";
        idToName.set(doc.id, name);
      }
    } catch (error) {
      console.warn(`Error fetching districts chunk: ${error}`);
    }
  }

  return idToName;
}

// Helper functions from update-all-user-custom-claims.ts

const sortStringArrayRecord = (record: Record<string, string[]>) => {
  return Object.keys(record)
    .sort()
    .reduce<Record<string, string[]>>((acc, key) => {
      acc[key] = [...record[key]].sort();
      return acc;
    }, {});
};

const sortStringRecord = (record: Record<string, string>) => {
  return Object.keys(record)
    .sort()
    .reduce<Record<string, string>>((acc, key) => {
      acc[key] = record[key];
      return acc;
    }, {});
};

const normalizeRoleKey = (role: unknown): string => {
  if (typeof role !== "string") return "";
  const cleaned = role.trim().toLowerCase();
  if (cleaned.length === 0) return "";
  const normalized = cleaned.replace(/\s+/g, "_");
  if (normalized === "superadmin") return "super_admin";
  if (normalized === "siteadmin") return "site_admin";
  if (normalized === "research_associate") return "research_assistant";
  if (normalized === "researchassistant") return "research_assistant";
  return normalized;
};

const buildClaimsFromRoles = (
  rawRoles: unknown,
  siteIdToName: Map<string, string>,
): ClaimsUpdate => {
  const rolesSet = new Set<string>();
  const siteRoles: Record<string, Set<string>> = {};
  const siteNames: Record<string, string> = {};

  if (!Array.isArray(rawRoles)) {
    return {
      rolesSet: [],
      siteRoles: {},
      siteNames: {},
    };
  }

  for (const entry of rawRoles) {
    const { role, siteId } = (entry ?? {}) as UserRoleEntry;

    const normalizedRole = normalizeRoleKey(role);
    if (!normalizedRole) {
      continue;
    }

    if (typeof siteId !== "string" || siteId.trim().length === 0) {
      continue;
    }

    const normalizedSiteId = siteId.trim();

    // Look up site name from our pre-fetched map
    const siteNameFromMap = siteIdToName.get(normalizedSiteId);

    rolesSet.add(normalizedRole);

    if (!siteRoles[normalizedSiteId]) {
      siteRoles[normalizedSiteId] = new Set<string>();
    }
    siteRoles[normalizedSiteId].add(normalizedRole);

    if (siteNameFromMap) {
      siteNames[normalizedSiteId] = siteNameFromMap;
    }
  }

  const normalizedRolesSet = Array.from(rolesSet).sort();
  const normalizedSiteRoles = sortStringArrayRecord(
    Object.entries(siteRoles).reduce<Record<string, string[]>>(
      (acc, [id, roles]) => {
        acc[id] = Array.from(roles).sort();
        return acc;
      },
      {},
    ),
  );
  const normalizedSiteNames = sortStringRecord(siteNames);

  return {
    rolesSet: normalizedRolesSet,
    siteRoles: normalizedSiteRoles,
    siteNames: normalizedSiteNames,
  };
};

const claimsWithinLimit = (claims: Record<string, unknown>): boolean => {
  try {
    const str = JSON.stringify(claims);
    return Buffer.byteLength(str, "utf8") <= 1000;
  } catch {
    return false;
  }
};

async function updateAdminClaimsStructure() {
  try {
    console.log("\n========================================");
    console.log("Updating admin users claims structure");
    console.log("========================================\n");

    // Get admin users
    console.log("Fetching admin users...");
    const usersSnapshot = await db
      .collection("users")
      .where("userType", "==", "admin")
      .get();
    const totalUsers = usersSnapshot.size;

    if (totalUsers === 0) {
      console.log("No admin users found in the database");
      return;
    }

    console.log(`Found ${totalUsers} admin users to process\n`);

    // 1. Collect all unique siteIds from all admin users to batch fetch names
    const allSiteIds = new Set<string>();
    for (const userDoc of usersSnapshot.docs) {
      const userData = userDoc.data();
      const roles = (userData.roles || []) as UserRoleEntry[];
      for (const role of roles) {
        if (typeof role.siteId === "string" && role.siteId) {
          allSiteIds.add(role.siteId);
        }
      }
    }

    console.log(`Found ${allSiteIds.size} unique site IDs. Fetching names...`);
    const siteIdToName = await buildSiteIdToNameMap(allSiteIds);

    // Progress bar
    const progressBar = new cliProgress.SingleBar({
      format:
        "Processing users [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}",
      barCompleteChar: "#",
      barIncompleteChar: ".",
    });

    progressBar.start(totalUsers, 0);

    let processed = 0;
    let updatedAuth = 0;
    let updatedFirestore = 0;
    let errors = 0;

    let firestoreBatch = db.batch();
    let batchCount = 0;

    for (const userDoc of usersSnapshot.docs) {
      const uid = userDoc.id;
      const userData = userDoc.data();

      try {
        // 1. Build new claims structure from user document roles
        const { rolesSet, siteRoles, siteNames } = buildClaimsFromRoles(
          userData.roles,
          siteIdToName,
        );

        // 2. Fetch current Auth claims
        let currentClaims: Record<string, unknown> = {};
        try {
          const userRecord = await auth.getUser(uid);
          currentClaims = (userRecord.customClaims || {}) as Record<
            string,
            unknown
          >;
        } catch (e: unknown) {
          const authError = e as { code?: string };
          if (authError.code === "auth/user-not-found") {
            processed++;
            progressBar.update(processed);
            continue;
          }
          throw e;
        }

        // 3. Construct new claims object
        const newClaims: Record<string, unknown> = {
          ...currentClaims,
          useNewPermissions: true,
          rolesSet,
          siteRoles,
          siteNames,
        };

        // Remove old 'roles' property
        delete newClaims.roles;

        if (!claimsWithinLimit(newClaims)) {
          console.error(
            `\nSkipping ${uid}: updated custom claims would exceed Firebase size limits`,
          );
          errors++;
          processed++;
          progressBar.update(processed);
          continue;
        }

        // 4. Update Auth
        if (!dryRun) {
          await auth.setCustomUserClaims(uid, newClaims);
          updatedAuth++;
        } else {
          updatedAuth++; // count as updated for dry run stats
        }

        // 5. Update Firestore userClaims collection to match
        if (!dryRun) {
          const userClaimsRef = db.collection("userClaims").doc(uid);
          firestoreBatch.set(
            userClaimsRef,
            { claims: { useNewPermissions: true } },
            { merge: true },
          );
          batchCount++;

          if (batchCount >= batchSize) {
            await firestoreBatch.commit();
            firestoreBatch = db.batch();
            batchCount = 0;
          }
          updatedFirestore++;
        } else {
          updatedFirestore++;
        }
      } catch (error) {
        console.error(`\nError processing user ${uid}: ${error}`);
        errors++;
      }

      processed++;
      progressBar.update(processed);
    }

    // Commit remaining Firestore batch
    if (!dryRun && batchCount > 0) {
      await firestoreBatch.commit();
    }

    progressBar.stop();

    console.log("\n========================================");
    console.log("SUMMARY");
    console.log("========================================");
    console.log(`Processed: ${processed}`);
    console.log(`Auth Claims Updated: ${updatedAuth}`);
    console.log(`Firestore userClaims Updated: ${updatedFirestore}`);
    console.log(`Errors: ${errors}`);

    if (dryRun) {
      console.log("\n⚠️  This was a DRY RUN. No changes were made.");
      console.log("Run with --dry-run=false to apply changes.");
    } else {
      console.log("\n✅ Successfully updated admin users.");
    }
    console.log("========================================\n");
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  } finally {
    // Clean up
    try {
      const app = admin.getApps().find((app) => app.name === "admin");
      if (app) await admin.deleteApp(app);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

updateAdminClaimsStructure();
