const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

const supportDir = process.env.LEVANTE_SUPPORT_DIR
  ? path.resolve(process.env.LEVANTE_SUPPORT_DIR)
  : path.resolve(__dirname, "..", "..", "levante-support");
const appDir = process.env.E2E_APP_DIR
  ? path.resolve(process.env.E2E_APP_DIR)
  : path.resolve(__dirname, "..", "..", "levante-dashboard");
const bootstrapScript = path.resolve(__dirname, "bootstrap-ui-seed.js");
const firebaseBin =
  process.env.FIREBASE_BIN ||
  path.resolve(__dirname, "..", "node_modules", ".bin", "firebase");
const firebaseConfigPath =
  process.env.FIREBASE_CONFIG_PATH ||
  path.resolve(__dirname, "..", "firebase.json");

const projectId =
  process.env.E2E_FIREBASE_PROJECT_ID ||
  process.env.FIREBASE_PROJECT_ID ||
  "demo-emulator";
const cypressCacheFolder =
  process.env.CYPRESS_CACHE_FOLDER &&
  !process.env.CYPRESS_CACHE_FOLDER.includes("/tmp/cursor-sandbox-cache")
    ? process.env.CYPRESS_CACHE_FOLDER
    : path.join(os.homedir(), ".cache", "Cypress");
const env = {
  ...process.env,
  E2E_FIREBASE_PROJECT_ID: projectId,
  E2E_USE_FIREBASE_EMULATOR: "TRUE",
  E2E_VIDEO: "false",
  E2E_BROWSER: process.env.E2E_BROWSER || "chrome",
  E2E_AI_SUPER_ADMIN_EMAIL:
    process.env.E2E_AI_SUPER_ADMIN_EMAIL || "superadmin@levante.test",
  E2E_AI_SUPER_ADMIN_PASSWORD:
    process.env.E2E_AI_SUPER_ADMIN_PASSWORD || "super123",
  FIRESTORE_EMULATOR_HOST:
    process.env.FIRESTORE_EMULATOR_HOST || "127.0.0.1:8180",
  FIREBASE_AUTH_EMULATOR_HOST:
    process.env.FIREBASE_AUTH_EMULATOR_HOST || "127.0.0.1:9199",
  FIREBASE_BIN: firebaseBin,
  FIREBASE_CONFIG_PATH: firebaseConfigPath,
  CYPRESS_CACHE_FOLDER: cypressCacheFolder,
  E2E_APP_DIR: appDir,
  VITE_BIN:
    process.env.VITE_BIN ||
    path.resolve(appDir, "node_modules", ".bin", "vite"),
  E2E_EMULATOR_BOOTSTRAP_CMD:
    process.env.E2E_EMULATOR_BOOTSTRAP_CMD ||
    `node ${JSON.stringify(bootstrapScript)}`,
};

console.log("=== STARTING EMULATOR ADMIN LOGIN SMOKE TEST ===");
console.log(`Support repo: ${supportDir}`);
console.log(`Dashboard app: ${appDir}`);
console.log(`Project ID: ${projectId}`);
console.log("Video recording: disabled");

if (process.env.E2E_SKIP_FUNCTIONS_BUILD !== "true") {
  console.log(
    "\nBuilding levante-admin functions for the Functions emulator..."
  );
  const buildResult = spawnSync("npm", ["run", "build"], {
    cwd: path.resolve(__dirname, ".."),
    env: process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (buildResult.status !== 0) {
    console.error(
      `\nFunctions build failed with exit code ${buildResult.status}`
    );
    process.exit(buildResult.status || 1);
  }
}

const result = spawnSync(
  "npm",
  ["run", "e2e:researchers:emulator:admin-login"],
  {
    cwd: supportDir,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
  }
);

if (result.error) {
  console.error(
    "\nAdmin login smoke test failed to start:",
    result.error.message
  );
  process.exit(1);
}

if (result.status !== 0) {
  console.error(
    `\nAdmin login smoke test failed with exit code ${result.status}`
  );
  process.exit(result.status || 1);
}

console.log("\n=== EMULATOR ADMIN LOGIN SMOKE TEST COMPLETE ===");
