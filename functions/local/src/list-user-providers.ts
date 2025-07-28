import * as admin from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import yargs from "yargs";
import cliProgress from "cli-progress";

interface Args {
  database: string;
  project: "admin" | "assessment";
  outputFormat: "json" | "table";
  mode: "read" | "write";
  test: boolean;
  batchSize: number;
  uids: string;
}

const argv = yargs(process.argv.slice(2))
  .options({
    database: {
      alias: "db",
      description: "Database: 'dev' or 'prod'",
      choices: ["dev", "prod"],
      default: "prod",
    },
    project: {
      alias: "p",
      description: "Project: 'admin' or 'assessment'",
      choices: ["admin", "assessment"],
      demandOption: true,
    },
    outputFormat: {
      alias: "f",
      description: "Output format: 'json' or 'table'",
      choices: ["json", "table"],
      default: "table",
    },
    mode: {
      alias: "m",
      description: "Mode: 'read' or 'write'",
      choices: ["read", "write"],
      default: "read",
    },
    test: {
      alias: "t",
      description: "Test mode - process only a small batch of users",
      type: "boolean",
      default: false,
    },
    batchSize: {
      alias: "b",
      description: "Number of users to process in test mode",
      type: "number",
      default: 10,
    },
    uids: {
      alias: "u",
      description:
        "Comma-separated list of UIDs or path to file containing UIDs (one per line)",
      description:
        "Comma-separated list of UIDs or path to file containing UIDs (one per line)",
      type: "string",
    },
  })
  .help()
  .alias("help", "h").argv as Args;

const isDev = argv.database === "dev";

// Set up environment variables based on project
const envVariable = `ROAR_${argv.project.toUpperCase()}_FIREBASE_CREDENTIALS`;

const credentialFile = process.env[envVariable];

if (!credentialFile) {
  console.error(
    `Missing required environment variable: ${envVariable}
    Please set this environment variable using
    export ${envVariable}=path/to/credentials/for/${argv.project}/project.json`,
  );
  process.exit(1);
}

const initializeApp = async () => {
  const credentials = (
    await import(credentialFile, {
      assert: { type: "json" },
    })
  ).default;

  const projectId = isDev
    ? `hs-levante-${argv.project}-dev`
    : `hs-levante-${argv.project}-prod`;

  return admin.initializeApp(
    {
      credential: admin.cert(credentials),
      projectId,
    },
    argv.project,
  );
};

const getSpecifiedUids = async (
  uidArg: string | undefined
): Promise<Set<string> | null> => {
const getSpecifiedUids = async (
  uidArg: string | undefined,
): Promise<Set<string> | null> => {
  if (!uidArg) return null;

  // Check if argument is a file path
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

  // Treat as comma-separated list
  return new Set(uidArg.split(",").map((uid) => uid.trim()));
};

// Function to check if a user needs a provider update
const needsProviderUpdate = (
  user: import("firebase-admin/auth").UserRecord,
): boolean => {
  console.log("email:", user.email, "providerData:", user.providerData);
  return !!user.email?.includes("levante") && user.providerData.length === 0;
};

const listAllUsers = async () => {
  const app = await initializeApp();
  const auth = getAuth(app);
  const allUsers: import("firebase-admin/auth").UserRecord[] = [];
  let usersNeedingUpdate: import("firebase-admin/auth").UserRecord[] = [];
  let nextPageToken: string | undefined;

  // Get specified UIDs if any
  const targetUids = await getSpecifiedUids(argv.uids);

  const progressBar = new cliProgress.SingleBar({
    format: "Fetching users [{bar}] {percentage}% | {value}/{total} users",
    barCompleteChar: "#",
    barIncompleteChar: ".",
  });

  if (targetUids) {
    // Fetch specific users by UID
    console.log(`Fetching ${targetUids.size} specified users...`);
    progressBar.start(targetUids.size, 0);

    for (const uid of targetUids) {
      try {
        const user = await auth.getUser(uid);
        if (needsProviderUpdate(user)) {
          usersNeedingUpdate.push(user);
        }
        allUsers.push(user);
        progressBar.increment();
      } catch (error) {
        console.error(`Error fetching user ${uid}:`, error);
      }
    }
  } else {
    // Existing batch/all users logic
    const maxResults = argv.test ? Math.min(10, 1000) : 1000;
    let { users: initialUsers, pageToken: initialPageToken } =
      await auth.listUsers(maxResults);

    // Filter users that need provider updates
    initialUsers.forEach((user) => {
      if (needsProviderUpdate(user)) {
        usersNeedingUpdate.push(user);
      }
    });

    allUsers.push(...initialUsers);
    nextPageToken = initialPageToken;

    // If not in test mode, continue fetching all users
    if (!argv.test) {
      const totalEstimatedUsers = 10000; // Estimate for progress bar
      progressBar.start(totalEstimatedUsers, initialUsers.length);

      while (nextPageToken) {
        const { users: pageUsers, pageToken } = await auth.listUsers(
          1000,
          nextPageToken,
        );

        // Filter users that need provider updates
        pageUsers.forEach((user) => {
          if (needsProviderUpdate(user)) {
            usersNeedingUpdate.push(user);
          }
        });

        allUsers.push(...pageUsers);
        nextPageToken = pageToken;
        progressBar.update(allUsers.length);
      }
    } else {
      // In test mode, limit to batch size
      progressBar.start(argv.batchSize, initialUsers.length);

      // If we need more users to reach batch size and have more pages
      while (allUsers.length < argv.batchSize && nextPageToken) {
        const { users: pageUsers, pageToken } = await auth.listUsers(
          Math.min(1000, argv.batchSize - allUsers.length),
          nextPageToken,
        );

        // Filter users that need provider updates
        pageUsers.forEach((user) => {
          if (needsProviderUpdate(user)) {
            usersNeedingUpdate.push(user);
          }
        });

        allUsers.push(...pageUsers);
        nextPageToken = pageToken;
        progressBar.update(allUsers.length);
      }

      // Trim to batch size if needed
      if (allUsers.length > argv.batchSize) {
        allUsers.length = argv.batchSize;
        // Re-filter users needing update to match the trimmed list
        const allUserIds = new Set(allUsers.map((u) => u.uid));
        usersNeedingUpdate = usersNeedingUpdate.filter((u) =>
          allUserIds.has(u.uid),
        );
      }
    }
  }

  progressBar.stop();

  if (argv.test) {
    console.log(`\nTest mode: Processed ${allUsers.length} users`);
  }

  // Only process users that need provider updates from this point on
  const users = usersNeedingUpdate;

  console.log(`\nFound ${users.length} users needing provider updates`);

  if (users.length === 0) {
    console.log("No users need provider updates. Exiting.");
    await admin.deleteApp(app);
    return;
  }

  const userSummaries = users.map((user) => ({
    uid: user.uid,
    email: user.email,
    providers: user.providerData.map((provider) => ({
      providerId: provider.providerId,
      email: provider.email,
    })),
    disabled: user.disabled,
    emailVerified: user.emailVerified,
  }));

  if (argv.mode === "write" && users.length > 0) {
    const updateProgressBar = new cliProgress.SingleBar({
      format:
        "Updating users [{bar}] {percentage}% | ETA: {eta}s | {value}/{total}",
      barCompleteChar: "#",
      barIncompleteChar: ".",
    });

    updateProgressBar.start(users.length, 0);

    for (const user of users) {
      try {
        // Update to use proper provider data structure
        await auth.updateUser(user.uid, {
          providerToLink: {
            providerId: isDev
              ? "oidc.hs-levante-admin-dev"
              : "oidc.hs-levante-admin-prod",
            uid: user.uid,
          },
        });
        updateProgressBar.increment();
      } catch (error) {
        console.error(`Error updating user ${user.uid}:`, error);
      }
    }

    updateProgressBar.stop();
    console.log("\nFinished updating users");
  }

  if (argv.outputFormat === "json") {
    console.log(JSON.stringify(userSummaries, null, 2));
  } else {
    if (argv.mode === "read") {
      console.table(
        userSummaries.map((user) => ({
          uid: user.uid,
          email: user.email,
          providers: user.providers.map((p) => p.providerId).join(", "),
          providerEmails: user.providers.map((p) => p.email).join(", "),
        })),
      );
    }
  }

  console.log(`\nTotal users needing updates: ${users.length}`);
  console.log(`Total users processed: ${allUsers.length}`);

  // Print provider statistics for users needing updates
  const providerCounts = users.reduce(
    (acc, user) => {
      user.providerData.forEach((provider) => {
        acc[provider.providerId] = (acc[provider.providerId] || 0) + 1;
      });
      return acc;
    },
    {} as { [key: string]: number },
  );

  if (Object.keys(providerCounts).length > 0) {
    console.log("\nProvider Statistics for users needing updates:");
    if (argv.mode === "read") {
      console.table(
        Object.entries(providerCounts).map(([provider, count]) => ({
          Provider: provider,
          Count: count,
          Percentage: `${((count / users.length) * 100).toFixed(2)}%`,
        })),
      );
    }
  } else {
    console.log(
      "\nNo provider statistics available (all users have no providers)",
    );
  }

  await admin.deleteApp(app);
};

listAllUsers().catch((error) => {
  console.error("Error listing users:", error);
  process.exit(1);
});
