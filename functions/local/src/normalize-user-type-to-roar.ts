#!/usr/bin/env node

/**
 * Normalize users/*.userType to ROAR values (see CANONICAL)
 *
 * - Only does obviously safe conversions (see CONVERSIONS)
 * - Doesn't capture docs w/ missing userType field
 * - Dry run by default, use --apply to write changes
 *
 * Usage:
 * ```bash
 * # Default, dry run on dev:
 * npm run normalize-user-type
 *
 * # Apply changes on dev:
 * npm run normalize-user-type -- --apply
 *
 * # Dry run on prod:
 * npm run normalize-user-type -- --env prod
 *
 * # Apply changes on prod:
 * npm run normalize-user-type -- --env prod --apply
 * ```
 */

import { deleteApp } from "firebase-admin/app";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { initAdmin } from "./utils/init-admin.js";

const CANONICAL = new Set(["admin", "parent", "student", "teacher"]);

const CONVERSIONS: Record<string, string> = {
  child: "student",
  "child ": "student",
  chikd: "student",
  caregiver: "parent",
  caregivers: "parent",
  "teacher ": "teacher",
};

type ChangeEntry =
  | { id: string; oldValue: string; newValue: string; status: "convert" }
  | { id: string; oldValue: string; newValue: null; status: "unknown" };

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

async function run() {
  const { app, db } = await initAdmin({ environment });
  try {
    const usersRef = db.collection("users");

    // Note: Firestore `== null` only matches fields explicitly set to null, not absent fields.
    // Documents with no userType field cannot be queried efficiently and are not surfaced here.
    let query: FirebaseFirestore.Query = usersRef.where("userType", "not-in", [
      ...CANONICAL,
    ]);

    const snap = await query.get();
    const allDocs = snap.docs;

    if (allDocs.length === 0) {
      console.log("No users found outside canonical types.");
      return;
    }

    const changelist: ChangeEntry[] = [];

    for (const doc of allDocs) {
      const raw = doc.data().userType;

      const converted = CONVERSIONS[raw as string];
      if (converted) {
        changelist.push({
          id: doc.id,
          oldValue: raw as string,
          newValue: converted,
          status: "convert",
        });
      } else {
        changelist.push({
          id: doc.id,
          oldValue: raw as string,
          newValue: null,
          status: "unknown",
        });
      }
    }

    const toConvert = changelist.filter((e) => e.status === "convert");
    const toReview = changelist.filter((e) => e.status !== "convert");

    console.log(`\nConversions (${toConvert.length} users):`);
    if (toConvert.length > 0) console.table(toConvert);

    console.log(`\nNeeds manual review (${toReview.length} users):`);
    if (toReview.length > 0)
      console.table(
        toReview.map((e) => ({ id: e.id, value: e.oldValue, status: e.status }))
      );

    if (apply) {
      for (const entry of toConvert) {
        await db
          .doc(`users/${entry.id}`)
          .set({ userType: entry.newValue }, { merge: true });
      }
      console.log(`\nApplied ${toConvert.length} conversions.`);
    } else {
      console.log("\nThis was a dry run. No changes were made.");
      console.log("Re-run with --apply to write conversions.");
    }
  } catch (error) {
    console.error("Error normalizing user types:", error);
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
