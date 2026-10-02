import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Compare two Firestore index specs by content.
 *
 * `indexes` and `fieldOverrides` are sets: array order is not part of the
 * definition, and neither is the order of single-field indexes nested inside
 * a field override. Field order inside a composite index is significant and
 * is left unchanged. Object key order is ignored. No fields are stripped.
 */

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((sorted, key) => {
        sorted[key] = sortKeys(value[key]);
        return sorted;
      }, {});
  }
  return value;
}

function byJson(a, b) {
  const left = JSON.stringify(a);
  const right = JSON.stringify(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalizeFieldOverride(override) {
  const indexes = [...(override.indexes ?? [])].map(sortKeys).sort(byJson);
  return sortKeys({ ...override, indexes });
}

export function canonicalizeIndexSpec(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error("Index spec must be a JSON object");
  }

  const indexes = [...(spec.indexes ?? [])].map(sortKeys).sort(byJson);
  const fieldOverrides = [...(spec.fieldOverrides ?? [])]
    .map(canonicalizeFieldOverride)
    .sort(byJson);

  const rest = { ...spec };
  delete rest.indexes;
  delete rest.fieldOverrides;

  return sortKeys({ ...rest, fieldOverrides, indexes });
}

export function indexSpecsEqual(left, right) {
  return (
    JSON.stringify(canonicalizeIndexSpec(left)) ===
    JSON.stringify(canonicalizeIndexSpec(right))
  );
}

function readSpec(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function printCanonicalDiff(left, right, leftLabel, rightLabel) {
  const dir = mkdtempSync(join(tmpdir(), "compare-indexes-"));
  const leftPath = join(dir, "left.json");
  const rightPath = join(dir, "right.json");
  try {
    writeFileSync(leftPath, `${JSON.stringify(left, null, 2)}\n`);
    writeFileSync(rightPath, `${JSON.stringify(right, null, 2)}\n`);
    const result = spawnSync(
      "diff",
      ["-u", "--label", leftLabel, "--label", rightLabel, leftPath, rightPath],
      { encoding: "utf8" }
    );
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const [leftPath, rightPath] = process.argv.slice(2);
  if (!leftPath || !rightPath) {
    console.error(
      "Usage: node scripts/compare-indexes.js <left.json> <right.json>"
    );
    process.exit(2);
  }

  let left;
  let right;
  try {
    left = canonicalizeIndexSpec(readSpec(leftPath));
    right = canonicalizeIndexSpec(readSpec(rightPath));
  } catch (error) {
    console.error(`Failed to read index specs: ${error.message}`);
    process.exit(2);
  }

  if (JSON.stringify(left) === JSON.stringify(right)) {
    console.log("Index specs match.");
    process.exit(0);
  }

  console.error("Index specs differ.");
  printCanonicalDiff(left, right, leftPath, rightPath);
  process.exit(1);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
