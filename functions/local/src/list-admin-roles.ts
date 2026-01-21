#!/usr/bin/env node
import * as admin from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

type RoleRow = {
  email: string;
  site: string;
  role: string;
};

const ROLE_ORDER = ["super_admin", "site_admin", "admin", "research_assistant"] as const;
const ROLE_LABELS: Record<string, string> = {
  super_admin: "Super Admin",
  site_admin: "Site Admin",
  admin: "Admin",
  research_assistant: "Research Associate",
};

function normalizeRoleKey(role: unknown): string {
  if (typeof role !== "string") return "";
  const normalized = role.trim().toLowerCase().replace(/\s+/g, "_");
  if (normalized === "superadmin") return "super_admin";
  if (normalized === "siteadmin") return "site_admin";
  if (normalized === "research_associate") return "research_assistant";
  return normalized;
}

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
  .option("o", {
    alias: "out",
    type: "string",
    describe:
      "Output CSV path (default: ./admin-roles-<db>-<timestamp>.csv in current directory)",
  })
  .help()
  .alias("help", "h")
  .parseSync();

const isDev = parsedArgs.d === "dev";
const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";
const timestamp = new Date().toISOString().replace(/:/g, "-");
const outArg = parsedArgs.out as string | undefined;
const outPath = outArg
  ? path.resolve(outArg)
  : path.resolve(`admin-roles-${isDev ? "dev" : "prod"}-${timestamp}.csv`);

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

if (!adminCredentialFile) {
  console.log(
    "LEVANTE_ADMIN_FIREBASE_CREDENTIALS not set; using application default credentials.",
  );
}

const db = getFirestore(adminApp);

async function listAdminRoles() {
  try {
    const usersSnapshot = await db
      .collection("users")
      .where("userType", "==", "admin")
      .get();

    if (usersSnapshot.empty) {
      console.log("No admin users found.");
      return;
    }

    const rows: RoleRow[] = [];
    const seen = new Set<string>();

    for (const doc of usersSnapshot.docs) {
      const userData = doc.data();
      const email = typeof userData.email === "string" ? userData.email : "";
      const roles = Array.isArray(userData.roles) ? userData.roles : [];

      for (const entry of roles) {
        const roleKey = normalizeRoleKey(entry?.role);
        if (!ROLE_ORDER.includes(roleKey as (typeof ROLE_ORDER)[number])) continue;

        const site = normalizeSiteName(entry?.siteName, entry?.siteId);
        const row: RoleRow = {
          email,
          site,
          role: ROLE_LABELS[roleKey] ?? roleKey,
        };

        const key = `${row.email}::${row.site}::${row.role}`;
        if (!seen.has(key)) {
          seen.add(key);
          rows.push(row);
        }
      }
    }

    rows.sort((a, b) => {
      const aIdx = ROLE_ORDER.indexOf(
        normalizeRoleKey(a.role) as (typeof ROLE_ORDER)[number],
      );
      const bIdx = ROLE_ORDER.indexOf(
        normalizeRoleKey(b.role) as (typeof ROLE_ORDER)[number],
      );
      if (aIdx !== bIdx) return aIdx - bIdx;
      if (a.site !== b.site) return a.site.localeCompare(b.site);
      return a.email.localeCompare(b.email);
    });

    if (rows.length === 0) {
      console.log("No admin roles found for the requested role set.");
      return;
    }

    console.table(rows);

    const csv = toCsv(rows, ["email", "site", "role"]);
    await writeFile(outPath, csv, { encoding: "utf8" });
    console.log(`\nWrote CSV: ${outPath}`);
  } catch (error) {
    console.error("Error fetching admin roles:", error);
    process.exit(1);
  } finally {
    try {
      await admin.deleteApp(adminApp);
    } catch (error) {
      console.error("Error deleting Firebase app:", error);
    }
  }
}

listAdminRoles();
