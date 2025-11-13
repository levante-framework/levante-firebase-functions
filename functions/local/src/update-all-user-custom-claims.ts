#!/usr/bin/env node
import * as admin from "firebase-admin/app";
import { deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import cliProgress from "cli-progress";

interface Args {
  dryRun: boolean;
  environment: "dev" | "prod";
  batchSize: number;
  limit?: number;
  uids?: string;
}

interface UserRoleEntry {
  siteId?: unknown;
  siteName?: unknown;
  role?: unknown;
}

interface ClaimsUpdate {
  rolesSet: string[];
  siteRoles: Record<string, string[]>;
  siteNames: Record<string, string>;
  isSuperAdmin: boolean;
  hasRoles: boolean;
}

type AnyObject = Record<string, unknown>;

const argv = yargs(hideBin(process.argv))
  .options({
    dryRun: {
      alias: "d",
      description: "Dry run mode: show what would be done without making changes",
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
      description: "Unused for Auth updates; kept for consistency with other scripts",
      type: "number",
      default: 500,
    },
    limit: {
      alias: "l",
      description: "Maximum number of users to process (only applies when --uids is not provided)",
      type: "number",
    },
    uids: {
      alias: "u",
      description: "Comma-separated list of user UIDs to process",
      type: "string",
    },
  })
  .help("help")
  .alias("help", "h")
  .parseSync() as Args;

const dryRun = argv.dryRun;
const isDev = argv.environment === "dev";
const limitArg =
  typeof argv.limit === "number" && Number.isFinite(argv.limit) && argv.limit > 0
    ? Math.floor(argv.limit)
    : undefined;
const uidsArg =
  typeof argv.uids === "string" && argv.uids.trim().length > 0
    ? argv.uids
        .split(",")
        .map((uid) => uid.trim())
        .filter((uid) => uid.length > 0)
    : undefined;

console.log(`Using ${isDev ? "development" : "production"} database`);
console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
if (uidsArg && uidsArg.length > 0) {
  console.log(`Processing ${uidsArg.length} user(s) by UID`);
} else if (typeof limitArg === "number") {
  console.log(`Processing up to ${limitArg} user(s)`);
} else {
  console.log("Processing all users");
}

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

const claimsWithinLimit = (claims: AnyObject): boolean => {
  try {
    const str = JSON.stringify(claims);
    return Buffer.byteLength(str, "utf8") <= 1000;
  } catch {
    return false;
  }
};

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

const buildClaimsFromRoles = (rawRoles: unknown): ClaimsUpdate => {
  const rolesSet = new Set<string>();
  const siteRoles: Record<string, Set<string>> = {};
  const siteNames: Record<string, string> = {};

  if (!Array.isArray(rawRoles)) {
    return {
      rolesSet: [],
      siteRoles: {},
      siteNames: {},
      isSuperAdmin: false,
      hasRoles: false,
    };
  }

  let hasRoles = false;
  let isSuperAdmin = false;

  for (const entry of rawRoles) {
    const { role, siteId, siteName } = (entry ?? {}) as UserRoleEntry;

    if (typeof role !== "string" || role.trim().length === 0) {
      continue;
    }

    const normalizedRole = role.trim();

    if (normalizedRole === "super_admin") {
      isSuperAdmin = true;
      hasRoles = true;
      break;
    }

    if (typeof siteId !== "string" || siteId.trim().length === 0) {
      continue;
    }

    const normalizedSiteId = siteId.trim();
    const normalizedSiteName =
      typeof siteName === "string" && siteName.trim().length > 0
        ? siteName.trim()
        : undefined;

    hasRoles = true;
    rolesSet.add(normalizedRole);

    if (!siteRoles[normalizedSiteId]) {
      siteRoles[normalizedSiteId] = new Set<string>();
    }
    siteRoles[normalizedSiteId].add(normalizedRole);

    if (normalizedSiteName) {
      siteNames[normalizedSiteId] = normalizedSiteName;
    }
  }

  if (isSuperAdmin) {
    return {
      rolesSet: ["super_admin"],
      siteRoles: {},
      siteNames: {},
      isSuperAdmin: true,
      hasRoles: true,
    };
  }

  const normalizedRolesSet = Array.from(rolesSet).sort();
  const normalizedSiteRoles = sortStringArrayRecord(
    Object.entries(siteRoles).reduce<Record<string, string[]>>((acc, [siteId, roles]) => {
      acc[siteId] = Array.from(roles).sort();
      return acc;
    }, {}),
  );

  const normalizedSiteNames = sortStringRecord(siteNames);

  return {
    rolesSet: normalizedRolesSet,
    siteRoles: normalizedSiteRoles,
    siteNames: normalizedSiteNames,
    isSuperAdmin: false,
    hasRoles,
  };
};

const claimsAreEqual = (
  currentClaims: AnyObject,
  nextClaims: Pick<ClaimsUpdate, "rolesSet" | "siteRoles" | "siteNames">,
) => {
  const currentRolesSet = Array.isArray(currentClaims.rolesSet)
    ? [...(currentClaims.rolesSet as string[])].sort()
    : [];
  const currentSiteRoles =
    currentClaims.siteRoles && typeof currentClaims.siteRoles === "object"
      ? sortStringArrayRecord(
          Object.entries(currentClaims.siteRoles as Record<string, unknown>).reduce<
            Record<string, string[]>
          >((acc, [siteId, roles]) => {
            if (Array.isArray(roles)) {
              const validRoles = roles.filter((role): role is string => typeof role === "string");
              if (validRoles.length > 0) {
                acc[siteId] = validRoles;
              }
            }
            return acc;
          }, {}),
        )
      : {};
  const currentSiteNames =
    currentClaims.siteNames && typeof currentClaims.siteNames === "object"
      ? sortStringRecord(
          Object.entries(currentClaims.siteNames as Record<string, unknown>).reduce<
            Record<string, string>
          >((acc, [siteId, siteName]) => {
            if (typeof siteName === "string") {
              acc[siteId] = siteName;
            }
            return acc;
          }, {}),
        )
      : {};

  const nextSiteRolesSorted = sortStringArrayRecord(nextClaims.siteRoles);
  const nextSiteNamesSorted = sortStringRecord(nextClaims.siteNames);

  return (
    JSON.stringify(currentRolesSet) === JSON.stringify(nextClaims.rolesSet) &&
    JSON.stringify(currentSiteRoles) === JSON.stringify(nextSiteRolesSorted) &&
    JSON.stringify(currentSiteNames) === JSON.stringify(nextSiteNamesSorted)
  );
};

async function main() {
  let app: admin.App | undefined;
  try {
    console.log("Initializing Firebase connection...");
    app = await initializeApp();
    const db = getFirestore(app);
    const auth = getAuth(app);
    await db.listCollections();
    console.log("Firebase connection established successfully\n");

    let userDocs: FirebaseFirestore.DocumentSnapshot<FirebaseFirestore.DocumentData>[] =
      [];

    if (uidsArg && uidsArg.length > 0) {
      const snapshots = await Promise.all(
        uidsArg.map((uid) => db.collection("users").doc(uid).get()),
      );
      userDocs = snapshots.filter((snap) => snap.exists);
      const missing = snapshots.filter((snap) => !snap.exists);
      if (missing.length > 0) {
        console.warn(
          `Warning: ${missing.length} user document(s) not found: ${missing
            .map((snap) => snap.id)
            .join(", ")}`,
        );
      }
    } else {
      let query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> =
        db.collection("users");
      if (typeof limitArg === "number") {
        query = query.limit(limitArg);
      }
      const snapshot = await query.get();
      userDocs = snapshot.docs;
    }

    const totalUsers = userDocs.length;

    if (totalUsers === 0) {
      console.log("No users found to process.");
      return;
    }

    console.log(`Found ${totalUsers} user(s) to process.\n`);

    const progressBar = new cliProgress.SingleBar({
      format: "Processing users [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}",
      barCompleteChar: "#",
      barIncompleteChar: ".",
    });

    progressBar.start(totalUsers, 0);

    const stats = {
      processed: 0,
      updated: 0,
      skippedUnchanged: 0,
      missingUserDoc: 0,
      missingRoles: 0,
      superAdmins: 0,
      errors: 0,
    };

    for (const userDoc of userDocs) {
      const uid = userDoc.id;
      const userData = userDoc.data() as AnyObject | undefined;

      if (!userData) {
        stats.missingUserDoc++;
        stats.processed++;
        progressBar.update(stats.processed);
        continue;
      }

      const { rolesSet, siteRoles, siteNames, isSuperAdmin, hasRoles } =
        buildClaimsFromRoles(userData.roles);

      if (isSuperAdmin) {
        stats.superAdmins++;
      } else if (!hasRoles) {
        stats.missingRoles++;
      }

      try {
        const userRecord = await auth.getUser(uid);
        const currentClaims = (userRecord.customClaims ?? {}) as AnyObject;

        const claimsPayload = {
          rolesSet,
          siteRoles,
          siteNames,
        };

        const mergedClaims = {
          ...currentClaims,
          ...claimsPayload,
        };

        if (claimsAreEqual(currentClaims, claimsPayload)) {
          stats.skippedUnchanged++;
        } else if (!claimsWithinLimit(mergedClaims)) {
          stats.errors++;
          console.error(
            `Skipping ${uid}: updated custom claims would exceed Firebase size limits`,
          );
        } else {
          stats.updated++;
          if (!dryRun) {
            await auth.setCustomUserClaims(uid, mergedClaims);
          }
        }
      } catch (error) {
        stats.errors++;
        console.error(`Error updating claims for user ${uid}:`, error);
      }

      stats.processed++;
      progressBar.update(stats.processed);
    }

    progressBar.stop();

    console.log("\n========================================");
    console.log("SUMMARY");
    console.log("========================================");
    console.log(`Environment: ${isDev ? "development" : "production"}`);
    console.log(`Dry run: ${dryRun ? "YES (no changes made)" : "NO (changes applied)"}`);
    console.log(`Total users processed: ${stats.processed}`);
    console.log(`Claims updated: ${stats.updated}`);
    console.log(`Skipped (no changes needed): ${stats.skippedUnchanged}`);
    console.log(`Users missing roles data: ${stats.missingRoles}`);
    console.log(`Users processed as super admins: ${stats.superAdmins}`);
    console.log(`User docs missing data: ${stats.missingUserDoc}`);
    console.log(`Errors: ${stats.errors}`);
    console.log("========================================\n");

    if (dryRun) {
      console.log("🔍 This was a dry run. No changes were made to custom claims.");
      console.log("🚀 Run with --dryRun=false to apply updates.");
    } else {
      console.log("✅ Custom claims update completed successfully.");
    }
  } catch (error) {
    console.error("Fatal error during execution:", error);
    process.exit(1);
  } finally {
    if (app) {
      try {
        await deleteApp(app);
      } catch (cleanupError) {
        console.error("Error cleaning up Firebase app:", cleanupError);
      }
    }
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});

