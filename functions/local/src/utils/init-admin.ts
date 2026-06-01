// Import Firebase Admin app helpers.
import * as admin from "firebase-admin/app";
// Import Firestore accessor bound to a specific app.
import { getFirestore } from "firebase-admin/firestore";
// Import filesystem helpers for env file reading.
import * as fs from "fs";
// Import path helpers for resolving local file paths.
import * as path from "path";
// Import file URL helper to resolve this module location.
import { fileURLToPath } from "url";
// Import createRequire to load modules from specific package roots.
import { createRequire } from "module";

// Define the accepted local environments for admin project selection.
type AdminEnvironment = "dev" | "prod";

// Define configuration options for initialization.
interface InitAdminOptions {
  // Target environment to determine Firebase project id.
  environment: AdminEnvironment;
  // Optional path to an env file that contains credentials variable.
  envFile?: string;
  // Optional Firebase app name to avoid collisions.
  appName?: string;
  // Optionally initialize the Firebase default app as well.
  alsoInitializeDefaultApp?: boolean;
}

// Define return shape used by one-off scripts.
interface InitializedAdmin {
  // Initialized Firebase app instance.
  app: admin.App;
  // Firestore instance bound to the initialized app.
  db: FirebaseFirestore.Firestore;
}

// Name of environment variable containing dev credential JSON path.
const ADMIN_DEV_CREDENTIAL_ENV = "LEVANTE_ADMIN_DEV_FIREBASE_CREDENTIALS";
// Name of environment variable containing prod credential JSON path.
const ADMIN_PROD_CREDENTIAL_ENV = "LEVANTE_ADMIN_PROD_FIREBASE_CREDENTIALS";
// Backward-compatible fallback env var used by older scripts.
const ADMIN_FALLBACK_CREDENTIAL_ENV = "LEVANTE_ADMIN_FIREBASE_CREDENTIALS";

// Parse a simple KEY=VALUE env file and set process.env for missing keys.
function loadEnvFile(envFilePath: string): void {
  // Resolve relative path from current working directory.
  const resolvedPath = path.resolve(process.cwd(), envFilePath);
  // Exit quickly when file does not exist.
  if (!fs.existsSync(resolvedPath)) {
    return;
  }

  // Read env file as text.
  const fileContents = fs.readFileSync(resolvedPath, "utf8");
  // Split into lines for parsing.
  const lines = fileContents.split(/\r?\n/);

  // Process each line in the env file.
  for (const line of lines) {
    // Ignore whitespace-only lines.
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    // Ignore comments.
    if (trimmed.startsWith("#")) {
      continue;
    }
    // Find first equals sign.
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    // Parse key and value fragments.
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();

    // Remove wrapping quotes when present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    // Preserve already-exported shell values.
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

// Resolve likely paths for an env file across local and repo roots.
function getEnvFileCandidates(envFile: string): string[] {
  // Resolve current module directory in ESM context.
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);
  // Resolve local package root (functions/local).
  const localRoot = path.resolve(currentDir, "../../");
  // Resolve repository root (levante-firebase-functions).
  const repoRoot = path.resolve(currentDir, "../../../../");

  // Build candidate list in priority order.
  const candidates = new Set<string>();

  // If user passed an absolute path, try that directly first.
  if (path.isAbsolute(envFile)) {
    candidates.add(envFile);
  } else {
    // Try relative to current process directory.
    candidates.add(path.resolve(process.cwd(), envFile));
    // Try relative to local package root.
    candidates.add(path.resolve(localRoot, envFile));
    // Try relative to repo root.
    candidates.add(path.resolve(repoRoot, envFile));
  }

  // Always include common defaults so top-level .env is detected.
  candidates.add(path.resolve(localRoot, ".env.local"));
  candidates.add(path.resolve(localRoot, ".env"));
  candidates.add(path.resolve(repoRoot, ".env.local"));
  candidates.add(path.resolve(repoRoot, ".env"));

  return Array.from(candidates);
}

// Get Firebase admin project id by local environment.
function getProjectId(environment: AdminEnvironment): string {
  // Map environment to project id.
  return environment === "dev" ? "hs-levante-admin-dev" : "hs-levante-admin-prod";
}

// Resolve credential env variable name by environment.
function getCredentialEnvName(environment: AdminEnvironment): string {
  // Use environment-specific variable.
  return environment === "dev"
    ? ADMIN_DEV_CREDENTIAL_ENV
    : ADMIN_PROD_CREDENTIAL_ENV;
}

// Resolve credential JSON path to an absolute file path.
function resolveCredentialPath(credentialPath: string): string {
  // Resolve current module directory in ESM context.
  const currentFilePath = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFilePath);
  // Resolve local package root (functions/local).
  const localRoot = path.resolve(currentDir, "../../");
  // Resolve repository root (levante-firebase-functions).
  const repoRoot = path.resolve(currentDir, "../../../../");

  // Return absolute paths unchanged.
  if (path.isAbsolute(credentialPath)) {
    return credentialPath;
  }

  // Try several relative bases and return first existing path.
  const candidates = [
    path.resolve(process.cwd(), credentialPath),
    path.resolve(localRoot, credentialPath),
    path.resolve(repoRoot, credentialPath),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fall back to repo-root relative for consistent behavior.
  return path.resolve(repoRoot, credentialPath);
}

// Initialize Firebase admin app and Firestore for local one-off scripts.
export async function initAdmin(options: InitAdminOptions): Promise<InitializedAdmin> {
  // Default options for optional parameters.
  const envFile = options.envFile ?? ".env.local";
  const appName = options.appName ?? "admin";
  const shouldInitDefaultApp = options.alsoInitializeDefaultApp ?? false;

  // Load env values from supported env-file locations.
  const envFileCandidates = getEnvFileCandidates(envFile);
  for (const candidate of envFileCandidates) {
    loadEnvFile(candidate);
  }

  // Read service-account JSON path from env-specific variable first.
  const credentialEnvName = getCredentialEnvName(options.environment);
  const credentialFile =
    process.env[credentialEnvName] || process.env[ADMIN_FALLBACK_CREDENTIAL_ENV];
  if (!credentialFile) {
    console.error(
      `Missing required environment variable for ${options.environment}:
- ${credentialEnvName}
Fallback supported for backward compatibility:
- ${ADMIN_FALLBACK_CREDENTIAL_ENV}

Please set it either by:
1) exporting it in your shell:
   export ${credentialEnvName}=path/to/service-account.json
2) or adding it to an env file (local or repo root), for example:
   ${credentialEnvName}=/absolute/path/to/service-account.json`,
    );
    process.exit(1);
  }

  // Normalize credential file path before dynamic import.
  const resolvedCredentialFile = resolveCredentialPath(credentialFile);
  // Expose credential path for libraries that rely on Application Default Credentials.
  process.env.GOOGLE_APPLICATION_CREDENTIALS = resolvedCredentialFile;

  // Dynamically import the service-account JSON credentials.
  const credentials = (
    await import(resolvedCredentialFile, {
      assert: { type: "json" },
    })
  ).default;
  const projectId = getProjectId(options.environment);

  // Set explicit project context for Google/Firebase SDKs used by downstream handlers.
  process.env.GOOGLE_CLOUD_PROJECT = projectId;
  process.env.GCLOUD_PROJECT = projectId;
  if (!process.env.FIREBASE_CONFIG) {
    process.env.FIREBASE_CONFIG = JSON.stringify({ projectId });
  }

  // Reuse existing named app when already initialized.
  let app: admin.App;
  try {
    app = admin.getApp(appName);
  } catch (_error) {
    // Initialize new app when app does not exist yet.
    app = admin.initializeApp(
      {
        credential: admin.cert(credentials),
        projectId,
      },
      appName,
    );
  }

  // Optionally ensure the default app is initialized for code paths that call getFirestore() with no app.
  if (shouldInitDefaultApp) {
    try {
      admin.getApp();
    } catch (_error) {
      admin.initializeApp({
        credential: admin.cert(credentials),
        projectId,
      });
    }

    // Initialize default app for the levante-admin package copy of firebase-admin when present.
    try {
      const currentFilePath = fileURLToPath(import.meta.url);
      const currentDir = path.dirname(currentFilePath);
      const repoRoot = path.resolve(currentDir, "../../../../");
      const levanteAdminRequire = createRequire(
        path.resolve(
          repoRoot,
          "functions/levante-admin/package.json",
        ),
      );

      const adminApp = levanteAdminRequire("firebase-admin/app") as {
        getApp: () => unknown;
        initializeApp: (options: unknown) => unknown;
        cert: (serviceAccountPathOrObject: unknown) => unknown;
      };

      try {
        adminApp.getApp();
      } catch (_levanteAdminDefaultMissingError) {
        adminApp.initializeApp({
          credential: adminApp.cert(credentials),
          projectId,
        });
      }
    } catch (_levanteAdminModuleUnavailableError) {
      // Ignore if levante-admin package resolution is unavailable in this environment.
    }
  }

  // Return both app and Firestore client.
  return {
    app,
    db: getFirestore(app),
  };
}
