// Import filesystem utilities for writing CSV and reading env file.
import * as fs from "fs";
// Import path utilities for resolving output paths.
import * as path from "path";
// Import yargs for CLI argument parsing.
import yargs from "yargs";
// Import shared local admin initialization utility.
import { initAdmin } from "./utils/init-admin.js";

// Define accepted CLI arguments for the script.
interface Args {
  // Which Firebase project should be scanned.
  environment: "dev" | "prod";
  // Optional path to a local env file to load before reading process.env.
  envFile: string;
  // Output CSV file path for detached administrations.
  outputFile: string;
  // Optional limit for smoke testing this script on fewer administration docs.
  testSize?: number;
}

// Parse command line arguments.
const argv = yargs(process.argv.slice(2))
  .options({
    environment: {
      alias: "e",
      description: "Environment to run against",
      choices: ["dev", "prod"] as const,
      default: "dev" as const,
    },
    envFile: {
      alias: "f",
      description:
        "Path to local env file containing LEVANTE_ADMIN_FIREBASE_CREDENTIALS",
      type: "string",
      default: ".env.local",
    },
    outputFile: {
      alias: "o",
      description: "CSV output path",
      type: "string",
      default: "detached-administrations-report.csv",
    },
    testSize: {
      alias: "t",
      description: "Limit number of administrations processed",
      type: "number",
    },
  })
  .help("help")
  .alias("help", "h").argv as Args;

// Convert unknown value into a normalized string array.
function ensureStringArray(value: unknown): string[] {
  // Non-array values should be treated as empty.
  if (!Array.isArray(value)) {
    return [];
  }
  // Keep non-empty trimmed strings only.
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// Escape a value for CSV format.
function toCsvCell(value: string): string {
  // Double-up existing quotes to preserve literal quotes.
  const escaped = value.replace(/"/g, '""');
  // Wrap every value in quotes for safety.
  return `"${escaped}"`;
}

// Join a list into a single pipe-delimited cell string.
function joinCell(values: string[]): string {
  // Return a stable delimiter format expected by analysts.
  return values.join("|");
}

// Map orgType to top-level collection name.
function resolveCollectionFromOrgType(orgType: string): string | null {
  // Normalize spacing and case just in case.
  const normalized = orgType.trim().toLowerCase();
  // Handle singular and plural values seen across code paths.
  if (normalized === "district" || normalized === "districts") {
    return "districts";
  }
  if (normalized === "school" || normalized === "schools") {
    return "schools";
  }
  if (normalized === "class" || normalized === "classes") {
    return "classes";
  }
  if (normalized === "group" || normalized === "groups") {
    return "groups";
  }
  // Unknown types are unresolved.
  return null;
}

// Resolve an org display name using orgType + orgId.
async function getOrgName(
  db: FirebaseFirestore.Firestore,
  cache: Map<string, string>,
  orgType: string,
  orgId: string,
): Promise<string> {
  // Build a cache key for this lookup.
  const cacheKey = `${orgType}:${orgId}`;
  // Serve cached name when available.
  if (cache.has(cacheKey)) {
    return cache.get(cacheKey) as string;
  }

  // Resolve collection name from orgType value.
  const collectionName = resolveCollectionFromOrgType(orgType);
  // Return placeholder for unsupported orgType.
  if (!collectionName) {
    const fallback = `UNKNOWN_ORG_TYPE(${orgType})`;
    cache.set(cacheKey, fallback);
    return fallback;
  }

  // Load organization document.
  const orgDoc = await db.collection(collectionName).doc(orgId).get();
  // Return placeholder if document is missing.
  if (!orgDoc.exists) {
    const fallback = `MISSING_ORG(${orgId})`;
    cache.set(cacheKey, fallback);
    return fallback;
  }

  // Read org data payload.
  const orgData = orgDoc.data();
  // Resolve human-readable name.
  const name =
    typeof orgData?.name === "string" && orgData.name.trim().length > 0
      ? orgData.name.trim()
      : `UNNAMED_ORG(${orgId})`;

  // Cache and return.
  cache.set(cacheKey, name);
  return name;
}

// Resolve site (district) name from siteId.
async function getSiteName(
  db: FirebaseFirestore.Firestore,
  cache: Map<string, string>,
  siteId: string,
): Promise<string> {
  // Handle missing siteId explicitly.
  if (!siteId) {
    return "";
  }
  // Use cache when possible.
  if (cache.has(siteId)) {
    return cache.get(siteId) as string;
  }
  // Fetch district doc by siteId.
  const siteDoc = await db.collection("districts").doc(siteId).get();
  // Use explicit marker if district doc is missing.
  if (!siteDoc.exists) {
    const fallback = `MISSING_SITE(${siteId})`;
    cache.set(siteId, fallback);
    return fallback;
  }
  // Extract district name.
  const siteData = siteDoc.data();
  const siteName =
    typeof siteData?.name === "string" && siteData.name.trim().length > 0
      ? siteData.name.trim()
      : `UNNAMED_SITE(${siteId})`;
  // Cache and return.
  cache.set(siteId, siteName);
  return siteName;
}

// Determine whether top-level assignment org fields are all empty.
function isDetachedAdministration(data: FirebaseFirestore.DocumentData): boolean {
  // Normalize each top-level org list.
  const districts = ensureStringArray(data.districts);
  const schools = ensureStringArray(data.schools);
  const classes = ensureStringArray(data.classes);
  const groups = ensureStringArray(data.groups);
  // Flag detached administrations where all four are empty.
  return (
    districts.length === 0 &&
    schools.length === 0 &&
    classes.length === 0 &&
    groups.length === 0
  );
}

// Define one CSV row shape for detached administrations.
interface DetachedAdministrationRow {
  administrationId: string;
  administrationName: string;
  siteId: string;
  siteName: string;
  dateOpened: string;
  dateClosed: string;
  createdBy: string;
  assignedOrgsIds: string[];
  assignedOrgTypes: string[];
  assignedOrgNames: string[];
}

// Convert Firestore timestamp-like values to ISO date strings.
function formatDateValue(value: unknown): string {
  // Return empty string for nullish values.
  if (!value) {
    return "";
  }

  // Handle Date instances.
  if (value instanceof Date) {
    return value.toISOString();
  }

  // Handle Firestore Timestamp objects that expose toDate().
  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as { toDate: () => Date }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }

  // Preserve string values as-is.
  if (typeof value === "string") {
    return value.trim();
  }

  // Fallback to string representation for other primitive/object values.
  return String(value);
}

// Traverse administrations and collect detached ones.
async function collectDetachedAdministrations(
  db: FirebaseFirestore.Firestore,
): Promise<DetachedAdministrationRow[]> {
  // Build query for all administrations or limited sample.
  let query: FirebaseFirestore.Query = db
    .collection("administrations")
    .select(
      "name",
      "siteId",
      "districts",
      "schools",
      "classes",
      "groups",
      "dateOpened",
      "dateClosed",
      "createdBy",
    );

  // Apply optional test limit.
  if (argv.testSize) {
    query = query.limit(argv.testSize);
  }

  // Execute query once.
  const snapshot = await query.get();
  // Log query scope.
  console.log(`Found ${snapshot.size} administration documents to inspect.`);

  // Prepare output rows.
  const rows: DetachedAdministrationRow[] = [];
  // Cache district names for repeated siteIds.
  const siteNameCache = new Map<string, string>();
  // Cache org names for repeated org lookups.
  const orgNameCache = new Map<string, string>();

  // Iterate each administration document.
  for (const administrationDoc of snapshot.docs) {
    // Read administration payload.
    const administrationData = administrationDoc.data();
    // Skip non-detached administrations.
    if (!isDetachedAdministration(administrationData)) {
      continue;
    }

    // Resolve top-level administration id and name.
    const administrationId = administrationDoc.id;
    const administrationName =
      typeof administrationData.name === "string" &&
      administrationData.name.trim().length > 0
        ? administrationData.name.trim()
        : "";
    // Resolve site id from top-level field.
    const siteId =
      typeof administrationData.siteId === "string" &&
      administrationData.siteId.trim().length > 0
        ? administrationData.siteId.trim()
        : "";
    // Resolve top-level dateOpened value.
    const dateOpened = formatDateValue(administrationData.dateOpened);
    // Resolve top-level dateClosed value.
    const dateClosed = formatDateValue(administrationData.dateClosed);
    // Resolve top-level createdBy value.
    const createdBy =
      typeof administrationData.createdBy === "string" &&
      administrationData.createdBy.trim().length > 0
        ? administrationData.createdBy.trim()
        : "";
    // Resolve site name via districts collection.
    const siteName = await getSiteName(db, siteNameCache, siteId);

    // Load assignedOrgs subcollection for this administration.
    const assignedOrgsSnapshot = await administrationDoc.ref
      .collection("assignedOrgs")
      .get();

    // Accumulate assigned org ids, types, and names.
    const assignedOrgsIds: string[] = [];
    const assignedOrgTypes: string[] = [];
    const assignedOrgNames: string[] = [];

    // Iterate through assignedOrg docs.
    for (const assignedOrgDoc of assignedOrgsSnapshot.docs) {
      // Read assignedOrg data.
      const assignedOrgData = assignedOrgDoc.data();
      // Prefer explicit orgId field; fallback to doc id.
      const orgId =
        typeof assignedOrgData.orgId === "string" &&
        assignedOrgData.orgId.trim().length > 0
          ? assignedOrgData.orgId.trim()
          : assignedOrgDoc.id;
      // Read orgType field or mark unknown.
      const orgType =
        typeof assignedOrgData.orgType === "string" &&
        assignedOrgData.orgType.trim().length > 0
          ? assignedOrgData.orgType.trim()
          : "UNKNOWN_ORG_TYPE";
      // Resolve org name from orgType + orgId.
      const orgName = await getOrgName(db, orgNameCache, orgType, orgId);

      // Push values preserving document order.
      assignedOrgsIds.push(orgId);
      assignedOrgTypes.push(orgType);
      assignedOrgNames.push(orgName);
    }

    // Append report row.
    rows.push({
      administrationId,
      administrationName,
      siteId,
      siteName,
      dateOpened,
      dateClosed,
      createdBy,
      assignedOrgsIds,
      assignedOrgTypes,
      assignedOrgNames,
    });
  }

  // Return final detached administration list.
  return rows;
}

// Persist detached administration rows to CSV.
function writeCsv(rows: DetachedAdministrationRow[]): void {
  // Resolve output path relative to current working directory.
  const outputPath = path.resolve(process.cwd(), argv.outputFile);
  // Build CSV header line.
  const header = [
    "administrationId",
    "administrationName",
    "siteId",
    "siteName",
    "dateOpened",
    "dateClosed",
    "createdBy",
    "assignedOrgsIds",
    "assignedOrgTypes",
    "assignedOrgNames",
  ].join(",");

  // Convert each row to CSV-safe columns.
  const csvLines = rows.map((row) =>
    [
      toCsvCell(row.administrationId),
      toCsvCell(row.administrationName),
      toCsvCell(row.siteId),
      toCsvCell(row.siteName),
      toCsvCell(row.dateOpened),
      toCsvCell(row.dateClosed),
      toCsvCell(row.createdBy),
      toCsvCell(joinCell(row.assignedOrgsIds)),
      toCsvCell(joinCell(row.assignedOrgTypes)),
      toCsvCell(joinCell(row.assignedOrgNames)),
    ].join(","),
  );

  // Join full CSV content.
  const csvContent = [header, ...csvLines].join("\n");
  // Write file atomically.
  fs.writeFileSync(outputPath, csvContent, "utf8");

  // Print completion message.
  console.log(`\n✅ CSV report written to: ${outputPath}`);
  console.log(`Detached administrations found: ${rows.length}`);
}

// Main script entrypoint.
async function main() {
  // Print startup context.
  console.log(
    `Running detached administration detector in ${argv.environment} environment`,
  );
  console.log(`Using env file: ${argv.envFile}`);
  console.log(`Output CSV: ${argv.outputFile}`);

  // Connect to Firebase.
  console.log("Initializing Firebase connection...");
  const { db } = await initAdmin({
    environment: argv.environment,
    envFile: argv.envFile,
    appName: "admin",
  });
  console.log("Firebase connection established.");

  // Scan administrations and build report rows.
  const rows = await collectDetachedAdministrations(db);
  // Write rows to CSV.
  writeCsv(rows);
}

// Execute script and fail with non-zero code on error.
main().catch((error) => {
  console.error("Fatal script error:", error);
  process.exit(1);
});
