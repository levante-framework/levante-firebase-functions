import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { initAdmin } from "../utils/init-admin.js";

export type VariantsJsonEnvironment = "dev" | "prod";

const PROJECT_ID: Record<VariantsJsonEnvironment, string> = {
  dev: "hs-levante-admin-dev",
  prod: "hs-levante-admin-prod",
};

const DEFAULT_OUT_REPO_RELATIVE = "emulator_scripts/registered-variants.json";

function getDefaultOutPath(): string {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(thisDir, "../../../..");
  return path.join(repoRoot, DEFAULT_OUT_REPO_RELATIVE);
}

// Clear the Firestore / Auth emulator hosts from `process.env` so that
// Firebase Admin connects to the live project, even if the caller's shell
// has those vars set (e.g. they're also running `npm run dev` in another
// terminal). Returns a restorer function that puts the previous values
// back; callers must invoke it in a `finally` so importing this module and
// calling `writeRegisteredVariantsJson()` doesn't leave the caller's env
// permanently mutated.
function disconnectFirestoreEmulatorFromEnv(): () => void {
  const previousFirestoreHost = process.env.FIRESTORE_EMULATOR_HOST;
  const previousAuthHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
  return () => {
    if (previousFirestoreHost !== undefined) {
      process.env.FIRESTORE_EMULATOR_HOST = previousFirestoreHost;
    }
    if (previousAuthHost !== undefined) {
      process.env.FIREBASE_AUTH_EMULATOR_HOST = previousAuthHost;
    }
  };
}

function isFirestoreTimestamp(value: unknown): value is { toDate: () => Date } {
  return (
    value instanceof Timestamp ||
    (typeof value === "object" &&
      value !== null &&
      "toDate" in value &&
      typeof (value as { toDate: unknown }).toDate === "function")
  );
}

// JSON-safe serializer for Firestore values. Replaces Timestamp instances
// with a sentinel object `{ __firestoreTimestamp: "<iso>" }` so the seeder
// can recognize them and rehydrate to a fresh server timestamp at seed
// time (i.e. timestamps in the emulator reflect when the data was seeded,
// not when it was last touched in dev/prod). Preserves array indices and
// object keys verbatim. Other Firestore-only types (DocumentReference,
// GeoPoint, Bytes) pass through unchanged — if you start seeing weird
// shapes in the output for those, extend this function.
export function serializeFirestoreValue(value: unknown): unknown {
  if (isFirestoreTimestamp(value)) {
    return { __firestoreTimestamp: value.toDate().toISOString() };
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => serializeFirestoreValue(item));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = serializeFirestoreValue(v);
    }
    return out;
  }
  return value;
}

export type RegisteredVariantRow = {
  taskId: string;
  taskData: unknown;
  variants: Array<{ id: string; data: unknown }>;
};

export type WriteRegisteredVariantsJsonParams = {
  environment?: VariantsJsonEnvironment;
  outPath?: string;
  envFile?: string;
};

export async function writeRegisteredVariantsJson(
  params: WriteRegisteredVariantsJsonParams = {},
): Promise<string> {
  const environment = params.environment ?? "dev";
  const outPath = params.outPath
    ? path.resolve(process.cwd(), params.outPath)
    : getDefaultOutPath();

  const restoreEmulatorEnv = disconnectFirestoreEmulatorFromEnv();

  try {
    const { app, db } = await initAdmin({
      environment,
      envFile: params.envFile,
      appName: "write-registered-variants-json",
      alsoInitializeDefaultApp: false,
    });

    const rows: RegisteredVariantRow[] = [];

    try {
      const tasksSnap = await db.collection("tasks").get();
      const taskDocs = [...tasksSnap.docs].sort((a, b) => a.id.localeCompare(b.id));

      for (const taskDoc of taskDocs) {
        const rawTask = taskDoc.data();
        if (!rawTask) {
          continue;
        }

        const variantsSnap = await taskDoc.ref.collection("variants").get();
        const registeredDocs = variantsSnap.docs.filter((d) => d.get("registered") === true);
        if (registeredDocs.length === 0) {
          continue;
        }

        const variants = registeredDocs.map((d) => ({
          id: d.id,
          data: serializeFirestoreValue(d.data() ?? {}),
        }));

        rows.push({
          taskId: taskDoc.id,
          taskData: serializeFirestoreValue(rawTask),
          variants,
        });
      }

      const sourceProject = PROJECT_ID[environment];
      const payload = {
        exportedAt: new Date().toISOString(),
        environment,
        sourceProject,
        rows,
      };

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf8");
      return outPath;
    } finally {
      await deleteApp(app).catch(() => {});
    }
  } finally {
    restoreEmulatorEnv();
  }
}

interface CliArgs {
  environment: VariantsJsonEnvironment;
  envFile: string;
  out?: string;
}

function parseCliArgs(): CliArgs {
  return yargs(process.argv.slice(2))
    .scriptName("export-registered-variants")
    .usage(
      "$0 [options]\n\nExports task / variant docs (registered === true) from a live Firebase project to a JSON snapshot the emulator seeder can consume.",
    )
    .options({
      environment: {
        alias: ["e", "env"],
        description: "Source project to read from.",
        choices: ["dev", "prod"] as const,
        default: "dev" as const,
      },
      envFile: {
        alias: ["f", "env-file"],
        description: "Path to env file containing credentials variable.",
        type: "string",
        default: ".env.local",
      },
      out: {
        alias: "o",
        description: `Output JSON file path (resolved against the current working directory). Defaults to <repo>/${DEFAULT_OUT_REPO_RELATIVE}.`,
        type: "string",
      },
    })
    .help("help")
    .alias("help", "h")
    .strict().argv as unknown as CliArgs;
}

const thisFile = fileURLToPath(import.meta.url);
const invokedAsCli = Boolean(process.argv[1] && path.resolve(process.argv[1]) === thisFile);

async function cliMain(): Promise<void> {
  const args = parseCliArgs();
  const written = await writeRegisteredVariantsJson({
    environment: args.environment,
    outPath: args.out,
    envFile: args.envFile,
  });
  console.log(`Wrote ${written}`);
}

if (invokedAsCli) {
  void cliMain().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
