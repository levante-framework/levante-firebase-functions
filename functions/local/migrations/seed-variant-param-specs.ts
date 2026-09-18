#!/usr/bin/env node

/**
 * One-time migration: derive `variantParamSpecs/{paramName}` from params on
 * existing `tasks/{taskId}/variants/{variantId}` documents.
 *
 * Matches emulator seeding in emulator_scripts/seeders/variant-param-specs.js.
 * Existing spec documents are left unchanged unless --overwrite is set.
 *
 * See functions/local/migrations/README.md for how to run this.
 */

import { FieldValue, type Firestore } from "firebase-admin/firestore";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { initAdmin } from "../src/utils/init-admin.js";

const MIGRATION_ACTOR = "migration-seed-variant-param-specs";

type ParamSpecType = "boolean" | "number" | "string" | "unknown";

interface Args {
  dryRun: boolean;
  overwrite: boolean;
  environment: "dev" | "prod";
  envFile: string;
  batchSize: number;
}

interface SpecDraft {
  id: string;
  name: string;
  type: ParamSpecType;
}

const argv = yargs(hideBin(process.argv))
  .options({
    dryRun: {
      alias: "d",
      description: "Show what would be written without making changes",
      type: "boolean",
      default: true,
    },
    overwrite: {
      alias: "o",
      description:
        "Delete all existing variantParamSpecs, then seed from scratch",
      type: "boolean",
      default: false,
    },
    environment: {
      alias: "e",
      description: "Environment to run against",
      choices: ["dev", "prod"] as const,
      default: "dev" as const,
    },
    envFile: {
      alias: "f",
      description:
        "Path to env file containing LEVANTE_ADMIN_DEV_FIREBASE_CREDENTIALS or LEVANTE_ADMIN_PROD_FIREBASE_CREDENTIALS",
      type: "string",
      default: ".env.local",
    },
    batchSize: {
      alias: "b",
      description: "Firestore batch size (max 500)",
      type: "number",
      default: 400,
    },
  })
  .help("help")
  .alias("help", "h").argv as Args;

function inferParamType(values: unknown[]): ParamSpecType {
  const types = new Set<ParamSpecType>();
  for (const value of values) {
    if (value === null || value === undefined) continue;
    const t = typeof value;
    if (t === "boolean" || t === "number" || t === "string") {
      types.add(t);
    } else {
      types.add("unknown");
    }
  }

  if (types.size === 0) return "unknown";
  if (types.size > 1) return "unknown";
  return [...types][0];
}

async function collectVariantParamSpecs(db: Firestore): Promise<SpecDraft[]> {
  const valuesByKey = new Map<string, unknown[]>();

  const tasksSnap = await db.collection("tasks").get();
  console.log(`Scanned ${tasksSnap.size} tasks`);

  let variantCount = 0;
  for (const taskDoc of tasksSnap.docs) {
    const variantsSnap = await taskDoc.ref.collection("variants").get();
    variantCount += variantsSnap.size;
    for (const variantDoc of variantsSnap.docs) {
      const params = variantDoc.data()?.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        continue;
      }
      for (const [key, value] of Object.entries(params)) {
        if (!valuesByKey.has(key)) valuesByKey.set(key, []);
        valuesByKey.get(key)!.push(value);
      }
    }
  }

  console.log(`Scanned ${variantCount} variants`);

  return [...valuesByKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, values]) => ({
      id: name,
      name,
      type: inferParamType(values),
    }));
}

async function deleteSpecs(db: Firestore, ids: string[]): Promise<number> {
  const batchSize = Math.min(Math.max(argv.batchSize, 1), 500);
  let deleted = 0;

  for (let i = 0; i < ids.length; i += batchSize) {
    const chunk = ids.slice(i, i + batchSize);
    const batch = db.batch();
    for (const id of chunk) {
      batch.delete(db.collection("variantParamSpecs").doc(id));
    }
    await batch.commit();
    deleted += chunk.length;
  }

  return deleted;
}

async function writeSpecs(
  db: Firestore,
  drafts: SpecDraft[],
  existingIds: Set<string>
): Promise<number> {
  const toWrite = drafts.filter((spec) => !existingIds.has(spec.id));
  const batchSize = Math.min(Math.max(argv.batchSize, 1), 500);
  const now = FieldValue.serverTimestamp();
  let written = 0;

  for (let i = 0; i < toWrite.length; i += batchSize) {
    const chunk = toWrite.slice(i, i + batchSize);
    const batch = db.batch();
    for (const spec of chunk) {
      const ref = db.collection("variantParamSpecs").doc(spec.id);
      batch.set(ref, {
        archived: false,
        createdAt: now,
        createdBy: MIGRATION_ACTOR,
        description: spec.name,
        name: spec.name,
        type: spec.type,
        updatedAt: now,
        updatedBy: MIGRATION_ACTOR,
      });
    }
    await batch.commit();
    written += chunk.length;
  }

  return written;
}

async function main() {
  console.log(`\nSeeding variantParamSpecs in ${argv.environment}`);
  console.log(`Dry run: ${argv.dryRun ? "ON" : "OFF"}`);
  console.log(`Overwrite: ${argv.overwrite ? "ON" : "OFF"}\n`);

  const { db } = await initAdmin({
    environment: argv.environment,
    envFile: argv.envFile,
  });

  const drafts = await collectVariantParamSpecs(db);
  const existingSnap = await db.collection("variantParamSpecs").get();
  const existingIds = new Set(existingSnap.docs.map((doc) => doc.id));
  const skipExisting = argv.overwrite ? new Set<string>() : existingIds;

  const toCreate = drafts.filter((spec) => !skipExisting.has(spec.id));
  const skipped = drafts.filter((spec) => skipExisting.has(spec.id));
  const unusedExisting = existingSnap.docs.filter(
    (doc) => !drafts.some((spec) => spec.id === doc.id)
  );

  console.log(`\nFound ${drafts.length} unique variant param keys`);
  for (const spec of drafts) {
    const status = argv.overwrite
      ? existingIds.has(spec.id)
        ? "replace"
        : "create"
      : existingIds.has(spec.id)
        ? "exists"
        : "create";
    console.log(`  - ${spec.id} (${spec.type}) [${status}]`);
  }

  if (argv.overwrite) {
    console.log(
      `\nOverwrite: would delete ${existingIds.size} existing variantParamSpecs documents`
    );
    for (const doc of unusedExisting) {
      console.log(`  - ${doc.id} [delete, unused]`);
    }
  } else {
    if (skipped.length > 0) {
      console.log(
        `\nSkipping ${skipped.length} existing variantParamSpecs documents`
      );
    }
    if (unusedExisting.length > 0) {
      console.log(
        `\n${unusedExisting.length} existing variantParamSpecs are not present on any current variant (left unchanged):`
      );
      for (const doc of unusedExisting) {
        console.log(`  - ${doc.id}`);
      }
    }
  }

  if (argv.dryRun) {
    console.log(
      `\nDry run: would ${argv.overwrite ? "delete existing specs and " : ""}create ${toCreate.length} variantParamSpecs documents`
    );
    console.log("Re-run with --dryRun false to write changes.");
    return;
  }

  if (argv.overwrite && existingIds.size > 0) {
    const deleted = await deleteSpecs(db, [...existingIds]);
    console.log(`\nDeleted ${deleted} existing variantParamSpecs documents`);
  }

  const written = await writeSpecs(db, drafts, skipExisting);
  console.log(`\nWrote ${written} variantParamSpecs documents`);
}

main().catch((error) => {
  console.error("Fatal error during execution:", error);
  process.exit(1);
});
