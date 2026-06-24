const admin = require("firebase-admin");
const { getSeedConfig } = require("./config");
const { getTaskSourceProject } = require("./function-based-seeders/options");
const {
  seedRegisteredTasksFromProject,
} = require("./seeders/tasks-from-project");

const { projectId, isEmulator } = getSeedConfig();

if (!isEmulator) {
  throw new Error(
    "seed-tasks-from-project.js only runs against the Firebase emulator."
  );
}

process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8180";

const sourceProjectId = getTaskSourceProject();

const app = admin.initializeApp({ projectId }, "tasks-from-project-seeder");

async function main() {
  console.log("=== COPYING REGISTERED TASKS + VARIANTS TO EMULATOR ===");
  await seedRegisteredTasksFromProject({
    targetApp: app,
    sourceProjectId,
    verbose: true,
  });
  console.log("=== TASK COPY COMPLETE ===");
}

main()
  .catch((error) => {
    console.error("\n❌ TASK COPY FAILED");
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    try {
      await admin.deleteApp(app);
    } catch {
      // noop
    }
  });
