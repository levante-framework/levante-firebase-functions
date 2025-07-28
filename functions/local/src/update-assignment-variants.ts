import * as admin from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import yargs from "yargs";
import cliProgress from "cli-progress";
import isEqual from "lodash/isEqual";
import pLimit from "p-limit";

// --------------- Configuration ---------------
const DRY_RUN = false; // Set to false to perform actual writes
const CONCURRENCY_LIMIT = 5; // Number of users to process in parallel

// --------------- Types ---------------
interface CLIArgs {
  database: "dev" | "prod";
  targetUids?: string; // Optional: Comma-separated list of UIDs or path to file
  batchSize: number; // For processing users in batches if not all are targeted
  runAllUsers: boolean; // Flag to run on all users, overrides targetUids and batchSize for user fetching
}

interface Task {
  taskId: string;
  params: Record<string, any>;
  variantId?: string;
  variantName?: string;
  [key: string]: any; // Allow other existing properties
}

interface Assignment {
  id: string; // Assignment document ID
  assessments: Task[];
  // ... other existing properties
}

interface Variant {
  id: string; // Firestore document ID, which is the variantId
  name: string; // Mandatory property
  params?: Record<string, any>;
}

// --------------- Globals ---------------
// Firebase app instances
let adminApp: admin.App;
let assessmentApp: admin.App;

// Caches
const variantCache = new Map<
  string,
  { variantId: string; variantName: string }
>();
// Key: taskId, Value: Array of variants (those with a 'name' property)
const taskVariantMap = new Map<string, Variant[]>();

// Predefined list of task IDs to fetch variants for.
// This can be expanded or dynamically determined if needed.
const PREDEFINED_TASK_IDS: string[] = [
  "MEFS",
  "egma-math",
  "hearts-and-flowers",
  "intro",
  "matrix-reasoning",
  "memory-game",
  "mental-rotation",
  "pa",
  "pa-de",
  "pa-es",
  "same-different-selection",
  "sre",
  "sre-de",
  "sre-es",
  "swr",
  "survey",
  "swr-de",
  "swr-es",
  "theory-of-mind",
  "trog",
  "vocab",
];

// --------------- Firebase Initialization ---------------
const initializeFirebaseApps = async (database: "dev" | "prod") => {
  const adminEnvVar = `ROAR_ADMIN_FIREBASE_CREDENTIALS`;
  const assessmentEnvVar = `ROAR_ASSESSMENT_FIREBASE_CREDENTIALS`;

  const adminCredFile = process.env[adminEnvVar];
  const assessmentCredFile = process.env[assessmentEnvVar];

  if (!adminCredFile || !assessmentCredFile) {
    console.error(
      `Missing required environment variables: ${adminEnvVar} and/or ${assessmentEnvVar}
      Please set these environment variables using:
      export ${adminEnvVar}=path/to/credentials/for/admin/project.json
      export ${assessmentEnvVar}=path/to/credentials/for/assessment/project.json`,
    );
    process.exit(1);
  }

  try {
    const adminCredentials = (
      await import(adminCredFile, { assert: { type: "json" } })
    ).default;
    const assessmentCredentials = (
      await import(assessmentCredFile, { assert: { type: "json" } })
    ).default;

    const adminProjectId =
      database === "dev" ? `hs-levante-admin-dev` : `hs-levante-admin-prod`;
    const assessmentProjectId =
      database === "dev"
        ? `hs-levante-assessment-dev`
        : `hs-levante-assessment-prod`;

    adminApp = admin.initializeApp(
      { credential: admin.cert(adminCredentials), projectId: adminProjectId },
      "adminProject", // Unique name for this app instance
    );

    assessmentApp = admin.initializeApp(
      {
        credential: admin.cert(assessmentCredentials),
        projectId: assessmentProjectId,
      },
      "assessmentProject", // Unique name for this app instance
    );

    console.log(`Initialized Firebase apps for ${database} environment.`);
    console.log(`Admin Project ID: ${adminApp.options.projectId}`);
    console.log(`Assessment Project ID: ${assessmentApp.options.projectId}`);
  } catch (error) {
    console.error("Error initializing Firebase Admin SDKs:", error);
    process.exit(1);
  }
};

// --------------- Variant Pre-fetching ---------------
const prefetchTaskVariants = async () => {
  const assessmentDb = getFirestore(assessmentApp);
  console.log("\nPrefetching variants from Assessment project...");

  const progressBar = new cliProgress.SingleBar(
    {},
    cliProgress.Presets.shades_classic,
  );
  progressBar.start(PREDEFINED_TASK_IDS.length, 0);

  for (const taskId of PREDEFINED_TASK_IDS) {
    try {
      const variantsSnapshot = await assessmentDb
        .collection(`tasks/${taskId}/variants`)
        .get();
      const variantsWithNames: Variant[] = [];
      variantsSnapshot.forEach((doc) => {
        const data = doc.data();
        if (data.name && typeof data.name === "string") {
          // Ensure 'name' property exists and is a string
          variantsWithNames.push({
            id: doc.id,
            name: data.name,
            params: data.params,
            ...data, // include other metadata
          });
        }
      });
      if (variantsWithNames.length > 0) {
        taskVariantMap.set(taskId, variantsWithNames);
      } else {
        console.log(
          `No variants with a 'name' property found for taskId: ${taskId}`,
        );
      }
    } catch (error) {
      console.error(`Error fetching variants for taskId ${taskId}:`, error);
    }
    progressBar.increment();
  }
  progressBar.stop();
  console.log(`Prefetched variants for ${taskVariantMap.size} task IDs.`);
};

// --------------- Main Processing Logic ---------------

const getSpecifiedUids = async (
  uidArg: string | undefined,
): Promise<Set<string> | null> => {
  if (!uidArg) return null;
  if (uidArg.endsWith(".txt")) {
    try {
      const fs = await import("fs/promises");
      const content = await fs.readFile(uidArg, "utf-8");
      return new Set(
        content
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line),
      );
    } catch (error) {
      console.error("Error reading UIDs file:", error);
      process.exit(1);
    }
  }
  return new Set(uidArg.split(",").map((uid) => uid.trim()));
};

const processUserAssignments = async (user: admin.auth.UserRecord) => {
  const adminDb = getFirestore(adminApp);
  const userId = user.uid;
  let assignmentsUpdatedCount = 0;

  try {
    const assignmentsSnapshot = await adminDb
      .collection(`users/${userId}/assignments`)
      .get();
    if (assignmentsSnapshot.empty) {
      // console.log(`No assignments found for user ${userId}. Skipping.`);
      return 0;
    }

    const batch = adminDb.batch();
    let changesInBatch = 0;

    for (const assignmentDoc of assignmentsSnapshot.docs) {
      const assignmentId = assignmentDoc.id;
      const assignmentData = assignmentDoc.data() as Omit<Assignment, "id">;

      if (
        !assignmentData.assessments ||
        !Array.isArray(assignmentData.assessments) ||
        assignmentData.assessments.length === 0
      ) {
        // console.log(`No assessments array or empty in assignment ${assignmentId} for user ${userId}. Skipping.`);
        continue;
      }

      const originalAssessments = JSON.parse(
        JSON.stringify(assignmentData.assessments),
      ) as Task[]; // Deep clone for comparison
      const updatedAssessments: Task[] = [];
      let madeChangesToThisAssignment = false;

      for (const task of originalAssessments) {
        const { taskId, params } = task;
        const cacheKey = `${taskId}:${
          params ? JSON.stringify(params) : "undefined"
        }`;
        let variantInfo = variantCache.get(cacheKey);

        if (!variantInfo) {
          const variantsForTask = taskVariantMap.get(taskId);
          if (variantsForTask && variantsForTask.length > 0) {
            // 1. Try to find a variant whose params match the task's (deep equality)
            let foundVariant = variantsForTask.find((v) =>
              isEqual(v.params || {}, params || {}),
            );

            // 2. If none match, fallback
            if (!foundVariant) {
              const fallbackName =
                taskId === "MEFS" || taskId === "survey"
                  ? "All Languages"
                  : "en";
              foundVariant = variantsForTask.find(
                (v) => v.name === fallbackName,
              );
              if (foundVariant) {
                console.log(
                  `[User: ${userId}, Assignment: ${assignmentId}, Task: ${taskId}] Variant fallback to name="${fallbackName}" used.`,
                );
              }
            }

            if (foundVariant) {
              variantInfo = {
                variantId: foundVariant.id,
                variantName: foundVariant.name,
              };
              variantCache.set(cacheKey, variantInfo);
            } else {
              console.log(
                `[User: ${userId}, Assignment: ${assignmentId}, Task: ${taskId}] No matching variant found, nor fallback for params: ${JSON.stringify(
                  params,
                )}. Task will not be updated with variant info.`,
              );
            }
          } else {
            console.log(
              `[User: ${userId}, Assignment: ${assignmentId}, Task: ${taskId}] No variants preloaded (or none with a 'name' field) for this taskId. Task will not be updated.`,
            );
          }
        }

        const updatedTask = { ...task };
        if (variantInfo) {
          updatedTask.variantId = variantInfo.variantId;
          updatedTask.variantName = variantInfo.variantName;
        }
        updatedAssessments.push(updatedTask);

        // Check if this specific task was actually changed
        if (
          variantInfo &&
          (!task.variantId ||
            task.variantId !== variantInfo.variantId ||
            !task.variantName ||
            task.variantName !== variantInfo.variantName)
        ) {
          madeChangesToThisAssignment = true;
        }
      }

      if (madeChangesToThisAssignment) {
        if (DRY_RUN) {
          console.log(
            `[DRY_RUN] User: ${userId}, Assignment: ${assignmentId} would be updated.`,
          );
          console.log(
            `  Old Assessments: ${JSON.stringify(
              originalAssessments.map((t) => ({
                taskId: t.taskId,
                params: t.params,
                variantId: t.variantId,
                variantName: t.variantName,
              })),
            )} `,
          );
          console.log(
            `  New Assessments: ${JSON.stringify(
              updatedAssessments.map((t) => ({
                taskId: t.taskId,
                params: t.params,
                variantId: t.variantId,
                variantName: t.variantName,
              })),
            )} `,
          );
        } else {
          batch.update(assignmentDoc.ref, { assessments: updatedAssessments });
          changesInBatch++;
        }
        assignmentsUpdatedCount++;
      }
    }

    if (!DRY_RUN && changesInBatch > 0) {
      await batch.commit();
      console.log(
        `[User: ${userId}] Successfully updated ${changesInBatch} assignment(s).`,
      );
    } else if (DRY_RUN && assignmentsUpdatedCount > 0) {
      // console.log(`[DRY_RUN User: ${userId}] Would have updated ${assignmentsUpdatedCount} assignment(s).`);
    }
  } catch (error) {
    console.error(`Error processing assignments for user ${userId}:`, error);
  }
  return assignmentsUpdatedCount;
};

const main = async () => {
  const argv = yargs(process.argv.slice(2))
    .options({
      database: {
        alias: "db",
        description: "Database: 'dev' or 'prod'",
        choices: ["dev", "prod"] as const,
        demandOption: true,
      },
      targetUids: {
        alias: "u",
        description:
          "Comma-separated list of UIDs or path to file containing UIDs (one per line) to process. If not provided, runs on users based on batchSize or all users if runAllUsers is true.",
        type: "string",
      },
      batchSize: {
        alias: "b",
        description:
          "Number of users to process in each batch when not processing specific UIDs or all users. Defaults to 1000.",
        type: "number",
        default: 10,
      },
      runAllUsers: {
        alias: "all",
        description:
          "Process all users. Overrides targetUids and ignores batchSize for user fetching (still fetches in pages of 1000).",
        type: "boolean",
        default: false,
      },
    })
    .help()
    .alias("help", "h").argv as CLIArgs;

  console.log(`Script starting with DRY_RUN = ${DRY_RUN}`);
  await initializeFirebaseApps(argv.database);
  await prefetchTaskVariants();

  const adminAuth = getAuth(adminApp);
  const limit = pLimit(CONCURRENCY_LIMIT);
  let totalAssignmentsUpdated = 0;
  let usersProcessedCount = 0;

  const specifiedUids = await getSpecifiedUids(argv.targetUids);

  if (specifiedUids) {
    console.log(`\nProcessing ${specifiedUids.size} specified users...`);
    const userProcessingProgressBar = new cliProgress.SingleBar(
      {},
      cliProgress.Presets.shades_classic,
    );
    userProcessingProgressBar.start(specifiedUids.size, 0);

    const promises = Array.from(specifiedUids).map((uid) =>
      limit(async () => {
        try {
          const user = await adminAuth.getUser(uid);
          const count = await processUserAssignments(user);
          totalAssignmentsUpdated += count;
        } catch (error) {
          console.error(`Error fetching or processing user ${uid}:`, error);
        } finally {
          usersProcessedCount++;
          userProcessingProgressBar.increment();
        }
      }),
    );
    await Promise.all(promises);
    userProcessingProgressBar.stop();
  } else {
    console.log(
      `\nProcessing users ${
        argv.runAllUsers
          ? "for all users"
          : "in batches up to " + argv.batchSize
      }...`,
    );
    const userFetchingProgressBar = new cliProgress.SingleBar(
      {
        format:
          "Fetching user pages [{bar}] {percentage}% | {value}/{total} pages (approx)",
      },
      cliProgress.Presets.shades_classic,
    );

    let nextPageToken: string | undefined;
    let pageCount = 0;
    let usersProcessedForCurrentBatchTarget = 0; // Counter for current batch target

    // Estimate total pages for progress bar
    const estimatedTotalPages = argv.runAllUsers
      ? 100
      : Math.max(1, Math.ceil(argv.batchSize / 1000));
    userFetchingProgressBar.start(estimatedTotalPages, 0);

    do {
      const listUsersResult = await adminAuth.listUsers(1000, nextPageToken);
      pageCount++;
      userFetchingProgressBar.update(pageCount);

      let usersInPage = listUsersResult.users;
      if (usersInPage.length === 0) {
        userFetchingProgressBar.update(estimatedTotalPages); // Complete the bar if no users found
        break;
      }

      // If not running for all users, trim the fetched users to not exceed batchSize
      if (!argv.runAllUsers) {
        const remainingForBatch =
          argv.batchSize - usersProcessedForCurrentBatchTarget;
        if (usersInPage.length > remainingForBatch) {
          usersInPage = usersInPage.slice(0, remainingForBatch);
        }
      }

      if (usersInPage.length === 0 && !argv.runAllUsers) {
        // No more users needed for this batch
        userFetchingProgressBar.update(estimatedTotalPages); // Complete the bar
        break;
      }

      const userProcessingSubProgressBar = new cliProgress.SingleBar(
        {
          format: `Processing users in current page/batch chunk [{bar}] {percentage}% | {value}/{total} users`,
        },
        cliProgress.Presets.shades_classic,
      );
      userProcessingSubProgressBar.start(usersInPage.length, 0);

      const promises = usersInPage.map((user) =>
        limit(async () => {
          try {
            const count = await processUserAssignments(user);
            totalAssignmentsUpdated += count;
          } catch (error) {
            console.error(`Error processing user ${user.uid} in batch:`, error);
          } finally {
            userProcessingSubProgressBar.increment();
          }
        }),
      );
      await Promise.all(promises);
      userProcessingSubProgressBar.stop();

      usersProcessedCount += usersInPage.length; // Increment global counter

      if (!argv.runAllUsers) {
        usersProcessedForCurrentBatchTarget += usersInPage.length;
        if (usersProcessedForCurrentBatchTarget >= argv.batchSize) {
          console.log(
            `\nReached batch target of ${argv.batchSize} users. Processed ${usersProcessedForCurrentBatchTarget}.`,
          );
          userFetchingProgressBar.update(estimatedTotalPages); // Complete the bar
          break;
        }
      }

      nextPageToken = listUsersResult.pageToken;
    } while (nextPageToken);
    userFetchingProgressBar.stop();
  }

  console.log(`\n--- Script Finished ---`);
  console.log(`Total users processed: ${usersProcessedCount}`);
  console.log(
    `Total assignments updated (or would be updated if DRY_RUN=true): ${totalAssignmentsUpdated}`,
  );
  if (DRY_RUN) {
    console.log("DRY_RUN was enabled. No actual writes were performed.");
  }

  // Gracefully shutdown Firebase apps
  await adminApp.delete();
  await assessmentApp.delete();
};

main().catch((error) => {
  console.error("Unhandled error in main execution:", error);
  if (adminApp) adminApp.delete().catch(console.error);
  if (assessmentApp) assessmentApp.delete().catch(console.error);
  process.exit(1);
});
