import { deleteApp } from "firebase-admin/app";
import { Timestamp } from "firebase-admin/firestore";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { initAdmin } from "../utils/init-admin.js";

export type VariantsJsonEnvironment = "dev" | "prod";

export type VariantsJsonOutputTarget = "local" | "emulator";

const PROJECT_ID: Record<VariantsJsonEnvironment, string> = {
  dev: "hs-levante-admin-dev",
  prod: "hs-levante-admin-prod",
};

function disconnectFirestoreEmulatorFromEnv(): void {
  delete process.env.FIRESTORE_EMULATOR_HOST;
  delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
}

function stripFirestoreTimestamps(value: unknown): unknown {
  if (value instanceof Timestamp) {
    return undefined;
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => stripFirestoreTimestamps(item))
      .filter((item) => item !== undefined);
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const stripped = stripFirestoreTimestamps(v);
      if (stripped !== undefined) {
        out[k] = stripped;
      }
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
  outputTarget: VariantsJsonOutputTarget;
  fileName?: string;
};

export async function writeRegisteredVariantsJson(
  params: WriteRegisteredVariantsJsonParams,
): Promise<string> {
  const environment = params.environment ?? "dev";
  const fileName = params.fileName ?? "registered-variants.json";
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(thisDir, "../../../..");
  const outDir =
    params.outputTarget === "emulator"
      ? path.join(repoRoot, "emulator_scripts")
      : path.join(repoRoot, "functions/local");
  const outPath = path.join(outDir, fileName);

  disconnectFirestoreEmulatorFromEnv();

  const { app, db } = await initAdmin({
    environment,
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
        data: stripFirestoreTimestamps(d.data() ?? {}),
      }));

      rows.push({
        taskId: taskDoc.id,
        taskData: stripFirestoreTimestamps(rawTask),
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
}

function parseCli(): {
  environment: VariantsJsonEnvironment;
  outputTarget: VariantsJsonOutputTarget;
  fileName: string | undefined;
} {
  const args = process.argv.slice(2);
  let environment: VariantsJsonEnvironment = "dev";
  let outputTarget: VariantsJsonOutputTarget | null = null;
  let fileName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--env") {
      const v = args[++i];
      if (v === "dev" || v === "prod") {
        environment = v;
      } else {
        console.error('Use --env dev or --env prod');
        process.exit(1);
      }
    } else if (a === "--target") {
      const v = args[++i];
      if (v === "local" || v === "emulator") {
        outputTarget = v;
      } else {
        console.error('Use --target local or --target emulator');
        process.exit(1);
      }
    } else if (a === "--file") {
      fileName = args[++i];
    }
  }
  if (!outputTarget) {
    console.error("Required: --target local | emulator");
    process.exit(1);
  }
  return { environment, outputTarget, fileName };
}

const thisFile = fileURLToPath(import.meta.url);
const invokedAsCli = Boolean(process.argv[1] && path.resolve(process.argv[1]) === thisFile);

async function cliMain(): Promise<void> {
  const { environment, outputTarget, fileName } = parseCli();
  const written = await writeRegisteredVariantsJson({ environment, outputTarget, fileName });
  console.log(`Wrote ${written}`);
}

if (invokedAsCli) {
  void cliMain().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
