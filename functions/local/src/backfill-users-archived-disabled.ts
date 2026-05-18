/**
 * Backfill users archived and disabled fields.
 *
 * # dry run against dev (default)
 * npm run backfill-users-archived-disabled
 *
 * # dry run against prod
 * npm run backfill-users-archived-disabled -- --env prod
 *
 * # apply against dev
 * npm run backfill-users-archived-disabled -- --apply
 *
 * # apply against prod
 * npm run backfill-users-archived-disabled -- --env prod --apply
 */

import { deleteApp } from "firebase-admin/app";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { initAdmin } from "./utils/init-admin.js";

const parsedArgs = yargs(hideBin(process.argv))
  .option("e", {
    alias: "env",
    describe: "Environment: 'dev' or 'prod'",
    choices: ["dev", "prod"],
    default: "dev",
  })
  .option("apply", {
    describe: "Write changes (dry-run by default)",
    type: "boolean",
    default: false,
  })
  .help()
  .alias("help", "h")
  .parseSync();

const environment = parsedArgs.env as "dev" | "prod";
const apply = Boolean(parsedArgs.apply);

console.log(`Environment: ${environment}`);
console.log(`Dry run: ${apply ? "OFF" : "ON"}`);

const BATCH_SIZE = 500;

async function run() {
  const { app, db } = await initAdmin({ environment });
  try {
    const snapshot = await db
      .collection("users")
      .select("archived", "disabled")
      .get();
    console.log(`Found ${snapshot.size} user documents.`);

    const toUpdate = snapshot.docs.filter((doc) => {
      const data = doc.data();
      return !("archived" in data) || !("disabled" in data);
    });
    console.log(`Documents missing at least one field: ${toUpdate.length}`);

    if (apply) {
      let committed = 0;
      for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
        const batch = db.batch();
        for (const doc of toUpdate.slice(i, i + BATCH_SIZE)) {
          const data = doc.data();
          const updates: Record<string, boolean> = {};
          if (!("archived" in data)) updates.archived = false;
          if (!("disabled" in data)) updates.disabled = false;
          batch.update(doc.ref, updates);
        }
        await batch.commit();
        committed += Math.min(BATCH_SIZE, toUpdate.length - i);
        console.log(`Committed ${committed} / ${toUpdate.length}`);
      }
      console.log(`\nApplied ${toUpdate.length} updates.`);
    } else {
      console.log("\nThis was a dry run. No changes were made.");
      console.log("Re-run with --apply to write updates.");
    }
  } catch (error) {
    console.error("Error backfilling users archived and disabled:", error);
    process.exit(1);
  } finally {
    try {
      await deleteApp(app);
    } catch (error) {
      console.error("Error deleting Firebase app:", error);
    }
  }
}

run();
