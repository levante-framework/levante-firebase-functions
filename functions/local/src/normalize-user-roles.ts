#!/usr/bin/env node
import * as admin from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

interface UserRoleEntry {
  siteId?: unknown;
  siteName?: unknown;
  role?: unknown;
}

type NormalizedRole = {
  siteId: string;
  siteName: string;
  role: string;
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

const normalizeRoles = (rawRoles: unknown): NormalizedRole[] => {
  if (!Array.isArray(rawRoles)) return [];
  const seen = new Set<string>();
  const normalized: NormalizedRole[] = [];

  for (const entry of rawRoles) {
    const { role, siteId, siteName } = (entry ?? {}) as UserRoleEntry;
    const normalizedRole = normalizeRoleKey(role);
    if (!normalizedRole) continue;
    const normalizedSiteId = typeof siteId === "string" ? siteId.trim() : "";
    if (!normalizedSiteId) continue;
    const normalizedSiteName =
      typeof siteName === "string" && siteName.trim().length > 0
        ? siteName.trim()
        : normalizedSiteId;
    const key = `${normalizedSiteId}::${normalizedRole}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      siteId: normalizedSiteId,
      siteName: normalizedSiteName,
      role: normalizedRole,
    });
  }

  return normalized;
};

const parsedArgs = yargs(hideBin(process.argv))
  .option("d", {
    alias: "database",
    describe: "Database: 'dev' or 'prod'",
    choices: ["dev", "prod"],
    default: "prod",
  })
  .option("apply", {
    describe: "Write changes (dry-run by default)",
    type: "boolean",
    default: false,
  })
  .option("email", {
    describe: "Target a single user by email",
    type: "string",
  })
  .option("uid", {
    describe: "Target a single user by UID",
    type: "string",
  })
  .option("limit", {
    describe: "Limit number of users processed",
    type: "number",
  })
  .help()
  .alias("help", "h")
  .parseSync();

const isDev = parsedArgs.d === "dev";
const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";
const apply = Boolean(parsedArgs.apply);
const targetEmail =
  typeof parsedArgs.email === "string" && parsedArgs.email.trim().length > 0
    ? parsedArgs.email.trim()
    : undefined;
const targetUid =
  typeof parsedArgs.uid === "string" && parsedArgs.uid.trim().length > 0
    ? parsedArgs.uid.trim()
    : undefined;
const limit =
  typeof parsedArgs.limit === "number" && Number.isFinite(parsedArgs.limit)
    ? Math.floor(parsedArgs.limit)
    : undefined;

console.log(`Using ${isDev ? "development" : "production"} database`);
console.log(`Dry run mode: ${apply ? "OFF" : "ON"}`);
if (targetEmail) {
  console.log(`Target email: ${targetEmail}`);
}
if (targetUid) {
  console.log(`Target UID: ${targetUid}`);
}

const adminCredentialFile = process.env.LEVANTE_ADMIN_FIREBASE_CREDENTIALS;
const adminCredentials = adminCredentialFile
  ? (
      await import(adminCredentialFile, {
        assert: { type: "json" },
      })
    ).default
  : null;

const adminApp = admin.initializeApp(
  {
    credential: adminCredentials
      ? admin.cert(adminCredentials)
      : admin.applicationDefault(),
    projectId,
  },
  "admin",
);

if (!adminCredentialFile) {
  console.log(
    "LEVANTE_ADMIN_FIREBASE_CREDENTIALS not set; using application default credentials.",
  );
}

const db = getFirestore(adminApp);

async function normalizeUserRoles() {
  try {
    let snapshot: FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>;

    if (targetUid) {
      const doc = await db.collection("users").doc(targetUid).get();
      snapshot = {
        docs: doc.exists ? [doc] : [],
        empty: !doc.exists,
        size: doc.exists ? 1 : 0,
        forEach: (fn: (doc: any) => void) => {
          if (doc.exists) fn(doc);
        },
      } as FirebaseFirestore.QuerySnapshot<FirebaseFirestore.DocumentData>;
    } else if (targetEmail) {
      let query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = db
        .collection("users")
        .where("email", "==", targetEmail);
      if (typeof limit === "number") {
        query = query.limit(limit);
      }
      snapshot = await query.get();
    } else {
      let query: FirebaseFirestore.Query<FirebaseFirestore.DocumentData> = db
        .collection("users")
        .where("userType", "==", "admin");
      if (typeof limit === "number") {
        query = query.limit(limit);
      }
      snapshot = await query.get();
    }

    if (snapshot.empty) {
      console.log("No admin users found.");
      return;
    }

    const stats = {
      processed: 0,
      updated: 0,
      unchanged: 0,
    };

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const normalizedRoles = normalizeRoles(data.roles);
      const originalRoles = Array.isArray(data.roles) ? data.roles : [];

      const rolesChanged =
        JSON.stringify(originalRoles) !== JSON.stringify(normalizedRoles);

      if (!rolesChanged) {
        stats.unchanged++;
      } else {
        stats.updated++;
        if (apply) {
          await doc.ref.set({ roles: normalizedRoles }, { merge: true });
        }
      }

      stats.processed++;
    }

    console.log("\nSUMMARY");
    console.log(`Processed: ${stats.processed}`);
    console.log(`Updated: ${stats.updated}`);
    console.log(`Unchanged: ${stats.unchanged}`);

    if (!apply) {
      console.log("\n🔍 This was a dry run. No changes were made.");
      console.log("🚀 Re-run with --apply to write changes.");
      console.log(
        "After applying, run update-all-user-custom-claims to rebuild siteRoles/siteNames.",
      );
    }
  } catch (error) {
    console.error("Error normalizing user roles:", error);
    process.exit(1);
  } finally {
    try {
      await admin.deleteApp(adminApp);
    } catch (error) {
      console.error("Error deleting Firebase app:", error);
    }
  }
}

normalizeUserRoles();
