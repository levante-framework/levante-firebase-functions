import * as fs from "fs";
import * as path from "path";
import yargs from "yargs";
import Papa from "papaparse";
import { initAdmin } from "./utils/init-admin.js";
import { upsertAdministrationHandler } from "../../levante-admin/src/upsertAdministration.js";

interface Args {
  environment: "dev" | "prod";
  envFile: string;
  inputFile: string;
  outputFile: string;
  dryRun: boolean;
  testSize?: number;
}

interface CsvRow {
  administrationId: string;
  districts: string;
  schools: string;
  class: string;
  groups: string;
}

interface OrgList {
  districts: string[];
  schools: string[];
  classes: string[];
  groups: string[];
}

interface ReattachResult {
  administrationId: string;
  status: "updated" | "dry-run" | "error";
  message: string;
}

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
      description: "Path to env file",
      type: "string",
      default: ".env.local",
    },
    inputFile: {
      alias: "i",
      description: "Input CSV with administrationId,targetOrgs",
      type: "string",
      default: "detached-admins-to-reattach.csv",
    },
    outputFile: {
      alias: "o",
      description: "Output CSV with operation status",
      type: "string",
      default: "detached-admins-reattach-results.csv",
    },
    dryRun: {
      alias: "d",
      description: "Validate and print without mutating data",
      type: "boolean",
      default: true,
    },
    testSize: {
      alias: "t",
      description: "Limit number of rows to process",
      type: "number",
    },
  })
  .help("help")
  .alias("help", "h").argv as Args;

function parseCsv(inputFilePath: string): CsvRow[] {
  const resolvedPath = path.resolve(process.cwd(), inputFilePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Input CSV file not found: ${resolvedPath}`);
  }

  const csvText = fs.readFileSync(resolvedPath, "utf8");
  const parsed = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length > 0) {
    const message = parsed.errors.map((error) => error.message).join("; ");
    throw new Error(`Failed parsing CSV: ${message}`);
  }

  return parsed.data.map((row) => {
    const administrationId =
      row.administrationId?.trim() || row.administrationID?.trim() || "";
    const districts = row.districts?.trim() || "";
    const schools = row.schools?.trim() || "";
    const classValue = row.class?.trim() || row.classes?.trim() || "";
    const groups = row.groups?.trim() || "";
    return {
      administrationId,
      districts,
      schools,
      class: classValue,
      groups,
    };
  });
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
}

function parseOrgCell(rawValue: string): string[] {
  if (!rawValue.trim()) {
    return [];
  }
  return Array.from(
    new Set(
      rawValue
        .split("|")
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    ),
  );
}

function parseTargetOrgs(row: CsvRow): OrgList {
  const parsed = {
    districts: parseOrgCell(row.districts),
    schools: parseOrgCell(row.schools),
    classes: parseOrgCell(row.class),
    groups: parseOrgCell(row.groups),
  };

  return {
    districts: ensureStringArray(parsed.districts),
    schools: ensureStringArray(parsed.schools),
    classes: ensureStringArray(parsed.classes),
    groups: ensureStringArray(parsed.groups),
  };
}

function formatDateField(value: unknown): string {
  if (!value) {
    return "";
  }

  if (
    typeof value === "object" &&
    value !== null &&
    "toDate" in value &&
    typeof (value as { toDate: () => Date }).toDate === "function"
  ) {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return value;
  }

  return String(value);
}

function toCsvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function writeResults(outputFile: string, results: ReattachResult[]): void {
  const outputPath = path.resolve(process.cwd(), outputFile);
  const header = ["administrationId", "status", "message"].join(",");
  const lines = results.map((result) =>
    [
      toCsvCell(result.administrationId),
      toCsvCell(result.status),
      toCsvCell(result.message),
    ].join(","),
  );
  fs.writeFileSync(outputPath, [header, ...lines].join("\n"), "utf8");
  console.log(`\n✅ Results written to ${outputPath}`);
}

async function main() {
  console.log(
    `Running reattach administrations in ${argv.environment} environment`,
  );
  console.log(`Dry run mode: ${argv.dryRun ? "ON" : "OFF"}`);
  console.log(`Input file: ${argv.inputFile}`);

  const { db } = await initAdmin({
    environment: argv.environment,
    envFile: argv.envFile,
    appName: "admin",
    alsoInitializeDefaultApp: true,
  });

  const inputRows = parseCsv(argv.inputFile);
  const rows = argv.testSize ? inputRows.slice(0, argv.testSize) : inputRows;
  const results: ReattachResult[] = [];

  for (const row of rows) {
    const administrationId = row.administrationId.trim();
    if (!administrationId) {
      results.push({
        administrationId: "",
        status: "error",
        message: "Missing administrationId in CSV row",
      });
      continue;
    }

    try {
      const targetOrgs = parseTargetOrgs(row);
      const hasAnyTargetOrg =
        targetOrgs.districts.length > 0 ||
        targetOrgs.schools.length > 0 ||
        targetOrgs.classes.length > 0 ||
        targetOrgs.groups.length > 0;

      if (!hasAnyTargetOrg) {
        throw new Error("No target organizations parsed from targetOrgs");
      }

      const adminDoc = await db
        .collection("administrations")
        .doc(administrationId)
        .get();
      if (!adminDoc.exists) {
        throw new Error("Administration not found");
      }

      const data = adminDoc.data();
      if (!data) {
        throw new Error("Administration data was empty");
      }

      const payload = {
        administrationId,
        name: typeof data.name === "string" ? data.name : "",
        publicName: typeof data.publicName === "string" ? data.publicName : "",
        normalizedName:
          typeof data.normalizedName === "string" ? data.normalizedName : "",
        assessments: Array.isArray(data.assessments) ? data.assessments : [],
        dateOpen: formatDateField(data.dateOpened),
        dateClose: formatDateField(data.dateClosed),
        sequential: typeof data.sequential === "boolean" ? data.sequential : true,
        orgs: targetOrgs,
        tags: Array.isArray(data.tags) ? data.tags : [],
        isTestData: Boolean(data.testData),
        legal: data.legal,
        creatorName:
          typeof data.creatorName === "string" ? data.creatorName : "Unknown",
        siteId: typeof data.siteId === "string" ? data.siteId : "",
      };

      const callerUid =
        typeof data.createdBy === "string" && data.createdBy.length > 0
          ? data.createdBy
          : "local-script";

      if (argv.dryRun) {
        results.push({
          administrationId,
          status: "dry-run",
          message: `Validated payload. Target org counts: d=${targetOrgs.districts.length}, s=${targetOrgs.schools.length}, c=${targetOrgs.classes.length}, g=${targetOrgs.groups.length}`,
        });
        continue;
      }

      await upsertAdministrationHandler(callerUid, payload);

      results.push({
        administrationId,
        status: "updated",
        message: "upsertAdministration completed",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        administrationId,
        status: "error",
        message,
      });
    }
  }

  writeResults(argv.outputFile, results);

  const updatedCount = results.filter((result) => result.status === "updated").length;
  const dryRunCount = results.filter((result) => result.status === "dry-run").length;
  const errorCount = results.filter((result) => result.status === "error").length;

  console.log("\n" + "=".repeat(60));
  console.log("REATTACH SUMMARY");
  console.log("=".repeat(60));
  console.log(`Total rows processed: ${results.length}`);
  console.log(`Updated: ${updatedCount}`);
  console.log(`Dry-run validated: ${dryRunCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log("=".repeat(60));
}

main().catch((error) => {
  console.error("Fatal script error:", error);
  process.exit(1);
});
