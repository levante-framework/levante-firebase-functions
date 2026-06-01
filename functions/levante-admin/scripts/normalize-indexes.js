import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Strips the implicit `__name__` field from each index's fields array.
 *
 * Firestore implicitly orders every index by `__name__` as the final field,
 * but the Firebase CLI's `firestore:indexes` export omits it. Some CLI
 * versions wrote it into `firestore.indexes.json` anyway. This normalizer
 * removes those entries so the committed file matches what the CLI exports
 * from a deployed project, which is what the update/deploy workflows compare.
 *
 * All other normalization (density field, array ordering) has been verified
 * unnecessary as of firebase-tools 14.13.0 and is intentionally not done here
 * to keep this script minimal.
 */

const indexesPath =
  process.argv[2] ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "firestore.indexes.json");

const spec = JSON.parse(readFileSync(indexesPath, "utf8"));

spec.indexes = (spec.indexes ?? []).map((index) => ({
  ...index,
  fields: (index.fields ?? []).filter(
    (field) => field.fieldPath !== "__name__"
  ),
}));

writeFileSync(indexesPath, `${JSON.stringify(spec, null, 2)}\n`);
