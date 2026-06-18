const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const appDir = process.env.E2E_APP_DIR
  ? path.resolve(process.env.E2E_APP_DIR)
  : path.resolve(__dirname, "..", "..", "levante-dashboard");
const bootstrapScript = path.resolve(__dirname, "bootstrap-ui-seed.js");
const seedScript = path.resolve(__dirname, "seed-emulator-functions.js");
const firebaseBin =
  process.env.FIREBASE_BIN ||
  path.resolve(rootDir, "node_modules", ".bin", "firebase");
const firebaseConfigPath =
  process.env.FIREBASE_CONFIG_PATH || path.resolve(rootDir, "firebase.json");
const viteBin =
  process.env.VITE_BIN || path.resolve(appDir, "node_modules", ".bin", "vite");

const projectId =
  process.env.E2E_FIREBASE_PROJECT_ID ||
  process.env.FIREBASE_PROJECT_ID ||
  "demo-emulator";
const dashboardPort = process.env.E2E_PORT || "5173";
const emulatorUiPort = process.env.E2E_EMULATOR_UI_PORT || "4001";
const authPort = process.env.FIREBASE_AUTH_EMULATOR_PORT || "9199";
const firestorePort = process.env.FIRESTORE_EMULATOR_PORT || "8180";
const functionsPort = process.env.FIREBASE_FUNCTIONS_EMULATOR_PORT || "5002";
const superAdminEmail =
  process.env.E2E_AI_SUPER_ADMIN_EMAIL || "superadmin@levante.test";
const superAdminPassword =
  process.env.E2E_AI_SUPER_ADMIN_PASSWORD || "super123";

const firebaseLog = "/tmp/firebase-seeded-dashboard.log";
const viteLog = "/tmp/vite-seeded-dashboard.log";
const processes = [];

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || rootDir,
    env: options.env || process.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}`
    );
  }
}

function killOnPort(port) {
  spawnSync(
    "bash",
    [
      "-lc",
      `if command -v lsof >/dev/null 2>&1; then lsof -ti:${port} | xargs -r kill -9; elif command -v fuser >/dev/null 2>&1; then fuser -k ${port}/tcp; fi`,
    ],
    {
      stdio: "ignore",
    }
  );
}

function startProcess(label, command, args, options) {
  const out = fs.openSync(options.logFile, "w");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", out, out],
    shell: process.platform === "win32",
  });

  processes.push({ label, child });
  child.on("exit", (code, signal) => {
    if (code === null && signal === "SIGTERM") return;
    console.error(
      `${label} exited unexpectedly with code=${code} signal=${signal}. See ${options.logFile}`
    );
    cleanup(1);
  });

  return child;
}

function waitForUrl(url, label, timeoutMs = 60_000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    function attempt() {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) {
          resolve();
          return;
        }
        retry();
      });

      request.on("error", retry);
      request.setTimeout(1_000, () => {
        request.destroy();
        retry();
      });
    }

    function retry() {
      if (Date.now() - startedAt > timeoutMs) {
        reject(
          new Error(
            `${label} did not become ready at ${url} within ${timeoutMs}ms`
          )
        );
        return;
      }
      setTimeout(attempt, 1_000);
    }

    attempt();
  });
}

function cleanup(exitCode = 0) {
  for (const { child } of processes.reverse()) {
    if (!child.killed) child.kill("SIGTERM");
  }
  process.exit(exitCode);
}

async function main() {
  console.log("=== STARTING SEEDED LEVANTE DASHBOARD EMULATOR ===");
  console.log(`Project ID: ${projectId}`);
  console.log(`Dashboard app: ${appDir}`);

  if (process.env.E2E_SKIP_FUNCTIONS_BUILD !== "true") {
    console.log("\nBuilding levante-admin functions...");
    runChecked("npm", ["run", "build"], { cwd: rootDir });
  }

  killOnPort(emulatorUiPort);
  killOnPort(authPort);
  killOnPort(firestorePort);
  killOnPort(functionsPort);
  killOnPort(dashboardPort);

  console.log("\nStarting Firebase emulators...");
  startProcess(
    "Firebase emulators",
    firebaseBin,
    [
      "emulators:start",
      "--only",
      "auth,firestore,functions",
      "--project",
      projectId,
      "--config",
      firebaseConfigPath,
    ],
    { cwd: rootDir, env: process.env, logFile: firebaseLog }
  );
  await waitForUrl(
    `http://127.0.0.1:${emulatorUiPort}`,
    "Firebase Emulator UI"
  );

  console.log("Starting dashboard dev server...");
  startProcess(
    "Dashboard dev server",
    viteBin,
    ["--force", "--host", "--port", dashboardPort],
    {
      cwd: appDir,
      env: {
        ...process.env,
        VITE_HTTPS: "FALSE",
        VITE_LEVANTE: "TRUE",
        VITE_FIREBASE_PROJECT: "DEV",
        VITE_EMULATOR: "TRUE",
      },
      logFile: viteLog,
    }
  );
  await waitForUrl(`http://127.0.0.1:${dashboardPort}`, "Dashboard dev server");

  const seedEnv = {
    ...process.env,
    EMULATOR: "1",
    E2E_FIREBASE_PROJECT_ID: projectId,
    FIREBASE_PROJECT_ID: projectId,
    FIRESTORE_EMULATOR_HOST: `127.0.0.1:${firestorePort}`,
    FIREBASE_AUTH_EMULATOR_HOST: `127.0.0.1:${authPort}`,
    FIREBASE_FUNCTIONS_EMULATOR_PORT: functionsPort,
    FUNCTIONS_EMULATOR_ORIGIN: `http://127.0.0.1:${functionsPort}`,
  };

  console.log("Bootstrapping permissions, admin login, and task variants...");
  runChecked("node", [bootstrapScript], {
    cwd: rootDir,
    env: seedEnv,
  });

  console.log(
    "Seeding visible emulator dashboard data through Firebase Functions..."
  );
  runChecked("node", [seedScript], {
    cwd: rootDir,
    env: seedEnv,
  });

  console.log("\n=== SEEDED DASHBOARD READY ===");
  console.log(`Dashboard:        http://localhost:${dashboardPort}/signin`);
  console.log(`Emulator UI:      http://127.0.0.1:${emulatorUiPort}`);
  console.log(`Email:            ${superAdminEmail}`);
  console.log(`Password:         ${superAdminPassword}`);
  console.log(
    "\nLeave this process running while you use the dashboard. Press Ctrl+C to stop emulators and Vite."
  );
  console.log(`Firebase log:     ${firebaseLog}`);
  console.log(`Dashboard log:    ${viteLog}`);

  if (process.env.E2E_EXIT_AFTER_READY === "true") cleanup(0);
}

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));

main().catch((error) => {
  console.error("\nFailed to start seeded dashboard:", error.message);
  console.error(`Firebase log: ${firebaseLog}`);
  console.error(`Dashboard log: ${viteLog}`);
  cleanup(1);
});
