#!/usr/bin/env node
import * as admin from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

type RoleRow = {
  email: string;
  userType: string;
  site: string;
  role: string;
};

const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  site_admin: "Site Admin",
  admin: "Admin",
  research_assistant: "Research Associate",
  participant: "Participant",
};

function normalizeSiteName(siteName: unknown, siteId: unknown): string {
  if (typeof siteName === "string" && siteName.trim().length > 0) {
    return siteName.trim();
  }
  if (typeof siteId === "string" && siteId.trim().length > 0) {
    return siteId.trim();
  }
  return "";
}

const adminCredentialFile = process.env.LEVANTE_ADMIN_FIREBASE_CREDENTIALS;
const adminCredentials = adminCredentialFile
  ? (
      await import(adminCredentialFile, {
        assert: { type: "json" },
      })
    ).default
  : null;

const parsedArgs = yargs(hideBin(process.argv))
  .option("d", {
    alias: "database",
    describe: "Database: 'dev' or 'prod'",
    choices: ["dev", "prod"],
    default: "prod",
  })
  .option("e", {
    alias: "emails",
    type: "array",
    describe: "Email addresses to look up",
    demandOption: true,
  })
  .help()
  .alias("help", "h")
  .parseSync();

const isDev = parsedArgs.d === "dev";
const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";
const emails = (parsedArgs.e as unknown[]).map((e) => String(e).trim());

console.log(`Using ${isDev ? "development" : "production"} database`);

const adminApp = admin.initializeApp(
  {
    credential: adminCredentials
      ? admin.cert(adminCredentials)
      : admin.applicationDefault(),
    projectId,
  },
  "admin",
);

const db = getFirestore(adminApp);

async function listRolesByEmail() {
  try {
    if (!adminCredentialFile) {
      console.log(
        "LEVANTE_ADMIN_FIREBASE_CREDENTIALS not set; using application default credentials.",
      );
    }

    const results: RoleRow[] = [];
    const seen = new Set<string>();

    const chunks: string[][] = [];
    for (let i = 0; i < emails.length; i += 10) {
      chunks.push(emails.slice(i, i + 10));
    }

    for (const chunk of chunks) {
      const snapshot = await db
        .collection("users")
        .where("email", "in", chunk)
        .get();

      for (const doc of snapshot.docs) {
        const data = doc.data();
        const email = typeof data.email === "string" ? data.email : "";
        const userType = typeof data.userType === "string" ? data.userType : "";
        const roles = Array.isArray(data.roles) ? data.roles : [];

        if (roles.length === 0) {
          const row: RoleRow = {
            email,
            userType,
            site: "",
            role: "",
          };
          const key = `${row.email}::${row.site}::${row.role}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push(row);
          }
          continue;
        }

        for (const entry of roles) {
          const roleRaw = typeof entry?.role === "string" ? entry.role.trim() : "";
          const role = ROLE_LABELS[roleRaw] ?? roleRaw;
          const site = normalizeSiteName(entry?.siteName, entry?.siteId);
          const row: RoleRow = {
            email,
            userType,
            site,
            role,
          };
          const key = `${row.email}::${row.site}::${row.role}`;
          if (!seen.has(key)) {
            seen.add(key);
            results.push(row);
          }
        }
      }
    }

    if (results.length === 0) {
      console.log("No matching users found in users collection.");
      return;
    }

    results.sort((a, b) => {
      if (a.email !== b.email) return a.email.localeCompare(b.email);
      if (a.role !== b.role) return a.role.localeCompare(b.role);
      return a.site.localeCompare(b.site);
    });

    console.table(results);
  } catch (error) {
    console.error("Error fetching roles:", error);
    process.exit(1);
  } finally {
    try {
      await admin.deleteApp(adminApp);
    } catch (error) {
      console.error("Error deleting Firebase app:", error);
    }
  }
}

listRolesByEmail();
