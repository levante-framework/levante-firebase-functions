#!/usr/bin/env node
import * as admin from "firebase-admin/app";
import { getAuth, UserRecord } from "firebase-admin/auth";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import cliProgress from "cli-progress";
import * as fs from "fs";

interface Args {
  dryRun: boolean;
  environment: "dev" | "prod";
  batchSize: number;
  limit: number;
  uids?: string;
  outputFile: string;
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
      description: "Number of auth users to fetch per page (max 1000)",
      type: "number",
      default: 1000,
    },
    limit: {
      alias: "l",
      description:
        "Maximum number of users to process (0 = process every user encountered)",
      type: "number",
      default: 0,
    },
    uids: {
      alias: "u",
      description:
        "Comma-separated list of user UIDs to target. When provided, only these users are processed.",
      type: "string",
    },
    outputFile: {
      alias: "o",
      description: "File to write script results to",
      type: "string",
      default: `remove-rules-from-custom-claims-results-${Date.now()}.txt`,
    },
  })
  .help("help")
  .alias("help", "h")
  .strict()
  .parseSync() as unknown as Args;

const dryRun = argv.dryRun;
const isDev = argv.environment === "dev";
const pageSize = Math.min(Math.max(Math.trunc(argv.batchSize), 1), 1000);
const limit = Number.isFinite(argv.limit) && argv.limit > 0 ? Math.trunc(argv.limit) : undefined;
const parsedTargetUids =
  argv.uids
    ?.split(",")
    .map((uid) => uid.trim())
    .filter((uid) => uid.length > 0) ?? [];
const targetUids = parsedTargetUids.length > 0 ? parsedTargetUids : undefined;

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

type ProcessResults = {
  processedCount: number;
  modifiedCount: number;
  skippedCount: number;
  errors: Array<{ uid: string; message: string }>;
};

type ScriptResults = ProcessResults & {
  environment: "dev" | "prod";
  dryRun: boolean;
  limit?: number;
  targetedUids: string[];
};

type ProcessOptions = {
  dryRun: boolean;
  pageSize: number;
  limit?: number;
  targetUids?: string[];
  expectedTotal?: number;
};

const removeRulesFromClaims = (claims: Record<string, unknown>) => {
  const cloned = { ...claims };
  delete cloned.roles;
  return cloned;
};

const claimHasRules = (claims: Record<string, unknown>): boolean =>
  Object.prototype.hasOwnProperty.call(claims, "roles");

async function processUsers(
  auth: ReturnType<typeof getAuth>,
  options: ProcessOptions,
): Promise<ProcessResults> {
  const { dryRun: isDryRun, pageSize: authPageSize, limit: limitUsers, targetUids: targetOnly, expectedTotal } =
    options;

  const progressBar =
    typeof expectedTotal === "number" && expectedTotal > 0
      ? new cliProgress.SingleBar({
          format: "Processing users [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}",
          barCompleteChar: "#",
          barIncompleteChar: ".",
        })
      : undefined;

  if (progressBar) {
    progressBar.start(expectedTotal!, 0);
  }

  const results: ProcessResults = {
    processedCount: 0,
    modifiedCount: 0,
    skippedCount: 0,
    errors: [],
  };

  const updateProgress = () => {
    if (!progressBar) {
      return;
    }
    const total = expectedTotal ?? results.processedCount;
    progressBar.update(Math.min(results.processedCount, total));
  };

  const handleUserRecord = async (record: UserRecord) => {
    try {
      const claims = (record.customClaims ?? {}) as Record<string, unknown>;
      if (!claimHasRules(claims)) {
        results.skippedCount++;
        return;
      }

      const previousValue = claims.roles;
      const updatedClaims = removeRulesFromClaims(claims);
      const hasRemainingClaims = Object.keys(updatedClaims).length > 0;

      const messagePrefix = isDryRun ? "DRY RUN - would remove" : "Removed";
      console.log(
        `${messagePrefix} 'roles' claim for ${record.uid}${
          previousValue !== undefined ? ` (previous value: ${JSON.stringify(previousValue)})` : ""
        }`,
      );

      if (!isDryRun) {
        await auth.setCustomUserClaims(record.uid, hasRemainingClaims ? updatedClaims : null);
      }

      results.modifiedCount++;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Error processing user ${record.uid}: ${message}`);
      results.errors.push({ uid: record.uid, message });
    } finally {
      results.processedCount++;
      updateProgress();
    }
  };

  if (targetOnly && targetOnly.length > 0) {
    const trimmedTargets = limitUsers ? targetOnly.slice(0, limitUsers) : targetOnly;
    for (const uid of trimmedTargets) {
      try {
        const userRecord = await auth.getUser(uid);
        await handleUserRecord(userRecord);
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Error fetching user ${uid}: ${message}`);
        results.errors.push({ uid, message });
        results.processedCount++;
        updateProgress();
      }
    }
  } else {
    let processedLimitReached = false;
    let pageToken: string | undefined;

    while (!processedLimitReached) {
      const listResult = await auth.listUsers(authPageSize, pageToken);

      for (const userRecord of listResult.users) {
        await handleUserRecord(userRecord);
        if (limitUsers && results.processedCount >= limitUsers) {
          processedLimitReached = true;
          break;
        }
      }

      if (processedLimitReached || !listResult.pageToken) {
        break;
      }

      pageToken = listResult.pageToken;
    }
  }

  if (progressBar) {
    progressBar.stop();
  }

  return results;
}

function writeResultsToFile(results: ScriptResults, outputFile: string) {
  console.log(`\n📄 Writing results to ${outputFile}...`);

  const payload = {
    environment: results.environment,
    dryRun: results.dryRun,
    limit: results.limit ?? 0,
    targetedUids: results.targetedUids,
    processedCount: results.processedCount,
    modifiedCount: results.modifiedCount,
    skippedCount: results.skippedCount,
    errors: results.errors,
    generatedAt: new Date().toISOString(),
  };

  const output = `Script Results
================

${JSON.stringify(payload, null, 2)}
`;

  fs.writeFileSync(outputFile, output);
  console.log("✅ Results written to file");
}

async function main() {
  let app: admin.App | undefined;
  try {
    const scriptName = "remove-rules-from-custom-claims";
    console.log(
      `\nRunning ${scriptName} in ${argv.environment} environment`,
    );
    console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
    console.log(`Auth page size: ${pageSize}`);
    if (limit) {
      console.log(`Processing limit: ${limit} user(s)`);
    }
    const effectiveTargetUids =
      targetUids && limit ? targetUids.slice(0, limit) : targetUids;
    if (effectiveTargetUids?.length) {
      console.log(`Targeting ${effectiveTargetUids.length} specific UID(s)`);
    }

    console.log("Initializing Firebase connection...");
    app = await initializeApp();
    const auth = getAuth(app);
    console.log("Firebase Auth initialized successfully");

    const expectedTotal = effectiveTargetUids?.length ?? limit ?? undefined;
    const results = await processUsers(auth, {
      dryRun,
      pageSize,
      limit,
      targetUids: effectiveTargetUids,
      expectedTotal,
    });

    const scriptResults: ScriptResults = {
      ...results,
      environment: argv.environment,
      dryRun,
      limit,
      targetedUids: effectiveTargetUids ?? [],
    };

    writeResultsToFile(scriptResults, argv.outputFile);

    console.log("\n" + "=".repeat(60));
    console.log("OPERATION SUMMARY");
    console.log("=".repeat(60));
    console.log(`Environment: ${argv.environment}`);
    console.log(`Dry run mode: ${dryRun ? "ON" : "OFF"}`);
    console.log(`Auth page size: ${pageSize}`);
    console.log(`Processed users: ${results.processedCount}`);
    console.log(`Claims modified: ${results.modifiedCount}`);
    console.log(`Users skipped (no 'roles' claim): ${results.skippedCount}`);
    console.log(`Errors: ${results.errors.length}`);
    console.log("=".repeat(60));

    if (results.errors.length > 0) {
      console.log("\nErrors encountered:");
      results.errors.slice(0, 10).forEach((error) => {
        console.log(`- ${error.uid}: ${error.message}`);
      });
      if (results.errors.length > 10) {
        console.log(`...and ${results.errors.length - 10} more`);
      }
    }

    if (dryRun) {
      console.log(
        "\n🔍 This was a dry run. No changes were made to user custom claims.",
      );
      console.log("🚀 Run with --dryRun=false to execute changes.");
    } else {
      console.log("\n✅ Operation completed successfully!");
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Fatal error during execution:", message);
    process.exit(1);
  } finally {
    if (app) {
      try {
        await admin.deleteApp(app);
      } catch (cleanupError: unknown) {
        const message =
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        console.error(`Error while cleaning up Firebase app: ${message}`);
      }
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Unhandled error:", message);
  process.exit(1);
});


