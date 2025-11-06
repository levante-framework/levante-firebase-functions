#!/usr/bin/env node
import * as admin from "firebase-admin/app";
import { deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import cliProgress from "cli-progress";
import * as fs from "fs";
import { resolve, isAbsolute } from "node:path";

interface Args {
  dryRun: boolean;
  environment: "dev" | "prod";
  batchSize: number;
  outputFile: string;
  userId: string;
  claimsFile?: string;
  overwrite: boolean;
}

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
      description: "Batch size for Firestore operations",
      type: "number",
      default: 500,
    },
    outputFile: {
      alias: "o",
      description: "File to write results to",
      type: "string",
      default: `user-custom-claims-results-${Date.now()}.txt`,
    },
    userId: {
      alias: "u",
      description: "UID of the user to inspect/update",
      type: "string",
      demandOption: true,
    },
    claimsFile: {
      alias: "c",
      description: "Path to a JSON file with new custom claims to add",
      type: "string",
    },
    overwrite: {
      alias: "w",
      description:
        "When set, overwrite existing custom claim values for matching keys",
      type: "boolean",
      default: false,
    },
  })
  .help("help")
  .alias("help", "h").argv as Args;

const dryRun = argv.dryRun;
const isDev = argv.environment === "dev";

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

type ScriptResults = {
  userId: string;
  environment: "dev" | "prod";
  dryRun: boolean;
  existingClaims: Record<string, unknown> | null;
  addedClaims: Record<string, unknown>;
  overwrittenClaims: Record<
    string,
    {
      previous: unknown;
      new: unknown;
    }
  >;
  skippedClaims: string[];
};

function readClaimsFile(filePath: string): Record<string, unknown> {
  const resolvedPath = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);

  if (!fs.existsSync(resolvedPath)) {
    console.error(`Claims file not found: ${resolvedPath}`);
    process.exit(1);
  }

  try {
    const contents = fs.readFileSync(resolvedPath, "utf-8");
    const parsed = JSON.parse(contents);

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.error("Claims file must contain a JSON object with key/value pairs.");
      process.exit(1);
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    console.error(`Failed to read claims file at ${resolvedPath}: ${error}`);
    process.exit(1);
  }
}

function writeResultsToFile(results: ScriptResults, outputFile: string) {
  console.log(`\n📄 Writing results to ${outputFile}...`);

  const output = `Script Results
================

Environment: ${results.environment}
Dry run mode: ${results.dryRun ? "ON" : "OFF"}
User ID: ${results.userId}
Generated at: ${new Date().toISOString()}

Existing Claims:
${JSON.stringify(results.existingClaims ?? {}, null, 2)}

Added Claims:
${JSON.stringify(results.addedClaims, null, 2)}

Overwritten Claims:
${JSON.stringify(results.overwrittenClaims, null, 2)}

Skipped Claims:
${JSON.stringify(results.skippedClaims, null, 2)}
`;

  fs.writeFileSync(outputFile, output);
  console.log(`✅ Results written to ${outputFile}`);
}

async function main() {
  try {
    console.log(
      `\nRunning get-user-custom-claims in ${argv.environment} environment`,
    );
    console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
    console.log(`Batch size: ${argv.batchSize}`);
    console.log(`User ID: ${argv.userId}`);
    console.log(`Overwrite existing claims: ${argv.overwrite ? "ON" : "OFF"}`);

    console.log("Initializing Firebase connection...");
    const app = await initializeApp();
    const db = getFirestore(app);
    // Touch Firestore to validate credentials/config even though we use Auth.
    await db.listCollections();
    const auth = getAuth(app);
    console.log("Firebase connection established successfully");

    console.log("\nFetching user custom claims...");
    const userRecord = await auth.getUser(argv.userId);
    const existingClaims = (userRecord.customClaims ?? {}) as Record<string, unknown>;
    console.log("Current custom claims:");
    console.log(existingClaims);

    const hasExistingStoredClaims = Object.keys(existingClaims).length > 0;
    const normalizedExistingClaims = hasExistingStoredClaims ? existingClaims : null;

    const results: ScriptResults = {
      userId: argv.userId,
      environment: argv.environment,
      dryRun,
      existingClaims: normalizedExistingClaims,
      addedClaims: {},
      overwrittenClaims: {},
      skippedClaims: [],
    };

    if (!argv.claimsFile) {
      console.log("\nNo claims file provided. Exiting after displaying current claims.");
      writeResultsToFile(results, argv.outputFile);
      await deleteApp(app);
      return;
    }

    const newClaims = readClaimsFile(argv.claimsFile);
    const claimsToAdd: Record<string, unknown> = {};
    const claimsToOverwrite: Record<string, unknown> = {};
    const overwrittenClaimsDetails: Record<
      string,
      {
        previous: unknown;
        new: unknown;
      }
    > = {};
    const skippedClaims: string[] = [];

    const entries = Object.entries(newClaims);
    const stringifyClaimValue = (input: unknown) => {
      const json = JSON.stringify(input);
      return json === undefined ? "undefined" : json;
    };
    const progressBar = new cliProgress.SingleBar({
      format: "Processing [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}",
      barCompleteChar: "#",
      barIncompleteChar: ".",
    });

    progressBar.start(entries.length, 0);

    for (const [key, value] of entries) {
      const nextValueString = stringifyClaimValue(value);
      if (key in existingClaims) {
        if (argv.overwrite) {
          const previousValue = existingClaims[key];
          const previousValueString = stringifyClaimValue(previousValue);
          claimsToOverwrite[key] = value;
          overwrittenClaimsDetails[key] = {
            previous: previousValue,
            new: value,
          };
          const overwritePrefix = dryRun ? "DRY RUN - would overwrite" : "Overwriting";
          console.log(
            `${overwritePrefix} claim '${key}' from ${previousValueString} to ${nextValueString}`,
          );
        } else {
          skippedClaims.push(key);
        }
      } else {
        claimsToAdd[key] = value;
        const addPrefix = dryRun ? "DRY RUN - would add" : "Adding";
        console.log(`${addPrefix} claim '${key}' with value ${nextValueString}`);
      }
      progressBar.increment();
    }

    progressBar.stop();

    const hasNewClaims = Object.keys(claimsToAdd).length > 0;
    const hasOverwrites = Object.keys(claimsToOverwrite).length > 0;

    if (!hasNewClaims && !hasOverwrites) {
      console.log(
        "\nNo claims to add or overwrite. Existing claims already contain provided keys.",
      );
      if (skippedClaims.length > 0) {
        console.log(`Skipped keys: ${skippedClaims.join(", ")}`);
      }
      results.skippedClaims = skippedClaims;
      writeResultsToFile(results, argv.outputFile);
      await deleteApp(app);
      return;
    }

    if (!dryRun) {
      const updatedClaims = { ...existingClaims, ...claimsToAdd, ...claimsToOverwrite };
      await auth.setCustomUserClaims(argv.userId, updatedClaims);
      console.log("\n✅ Custom claims updated successfully.");
      console.log("Updated custom claims:");
      console.log(updatedClaims);
      results.existingClaims = updatedClaims;
    } else {
      console.log("\n🔍 Dry run complete. Custom claims were not modified.");
    }

    results.addedClaims = claimsToAdd;
    results.overwrittenClaims = overwrittenClaimsDetails;
    results.skippedClaims = skippedClaims;

    writeResultsToFile(results, argv.outputFile);

    await deleteApp(app);
  } catch (error) {
    console.error("Fatal error during execution:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Unhandled error:", error);
  process.exit(1);
});

