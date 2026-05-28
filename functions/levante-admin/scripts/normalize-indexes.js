import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const indexesPath =
  process.argv[2] ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "firestore.indexes.json");

const spec = JSON.parse(readFileSync(indexesPath, "utf8"));

spec.indexes = (spec.indexes ?? [])
  .map((index) => {
    const { density: _density, ...indexWithoutDensity } = index;
    return {
      ...indexWithoutDensity,
      fields: (index.fields ?? []).filter(
        (field) => field.fieldPath !== "__name__",
      ),
    };
  })
  .sort(compareIndex);

spec.fieldOverrides = (spec.fieldOverrides ?? []).sort(compareFieldOverride);

function compareIndex(a, b) {
  return (
    cmp(a.collectionGroup, b.collectionGroup) ||
    cmp(a.queryScope, b.queryScope) ||
    cmp(fieldsKey(a.fields), fieldsKey(b.fields))
  );
}

function compareFieldOverride(a, b) {
  return cmp(a.collectionGroup, b.collectionGroup) || cmp(a.fieldPath, b.fieldPath);
}

function fieldsKey(fields) {
  return (fields ?? [])
    .map((f) => `${f.fieldPath}|${f.order ?? ""}|${f.arrayConfig ?? ""}`)
    .join("::");
}

function cmp(x, y) {
  const a = x ?? "";
  const b = y ?? "";
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

writeFileSync(indexesPath, `${JSON.stringify(spec, null, 2)}\n`);
