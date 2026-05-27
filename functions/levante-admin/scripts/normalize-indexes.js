import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const indexesPath =
  process.argv[2] ??
  join(dirname(fileURLToPath(import.meta.url)), "..", "firestore.indexes.json");

const spec = JSON.parse(readFileSync(indexesPath, "utf8"));

spec.indexes = (spec.indexes ?? []).map((index) => {
  const { density: _density, ...indexWithoutDensity } = index;
  return {
    ...indexWithoutDensity,
    fields: (index.fields ?? []).filter(
      (field) => field.fieldPath !== "__name__",
    ),
  };
});

writeFileSync(indexesPath, `${JSON.stringify(spec, null, 2)}\n`);
