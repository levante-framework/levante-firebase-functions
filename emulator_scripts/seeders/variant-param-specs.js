const admin = require("firebase-admin");

const SEED_ACTOR = "emulator-seed";

/**
 * Infers a variantParamSpec type from observed non-null JS values.
 * Mixed types or only-null observations become "unknown".
 */
function inferParamType(values) {
  const types = new Set();
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
  const only = [...types][0];
  return only === "unknown" ? "unknown" : only;
}

/**
 * Collects unique param keys across all task variants and builds spec drafts.
 */
async function collectVariantParamSpecs(db) {
  const valuesByKey = new Map();

  const tasksSnap = await db.collection("tasks").get();
  for (const taskDoc of tasksSnap.docs) {
    const variantsSnap = await taskDoc.ref.collection("variants").get();
    for (const variantDoc of variantsSnap.docs) {
      const params = variantDoc.data()?.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        continue;
      }
      for (const [key, value] of Object.entries(params)) {
        if (!valuesByKey.has(key)) valuesByKey.set(key, []);
        valuesByKey.get(key).push(value);
      }
    }
  }

  return [...valuesByKey.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, values]) => ({
      id: name,
      archived: false,
      description: name,
      name,
      type: inferParamType(values),
    }));
}

/**
 * Seeds `variantParamSpecs/{paramName}` from params found on all task variants.
 * Uses semantic document IDs matching the param key.
 */
async function seedVariantParamSpecs({
  targetApp,
  verbose = true,
  dryRun = false,
} = {}) {
  if (!targetApp) throw new Error("targetApp is required");

  const db = targetApp.firestore();
  const specs = await collectVariantParamSpecs(db);

  if (verbose) {
    console.log(
      `  Found ${specs.length} unique variant param keys across all tasks/variants`
    );
    for (const spec of specs) {
      console.log(`    - ${spec.id} (${spec.type})`);
    }
  }

  if (dryRun) {
    return { written: 0, specs };
  }

  const now = admin.firestore.FieldValue.serverTimestamp();
  let written = 0;

  // Firestore batches are capped at 500 ops.
  const chunkSize = 400;
  for (let i = 0; i < specs.length; i += chunkSize) {
    const chunk = specs.slice(i, i + chunkSize);
    const batch = db.batch();
    for (const spec of chunk) {
      const ref = db.collection("variantParamSpecs").doc(spec.id);
      batch.set(ref, {
        archived: false,
        createdAt: now,
        createdBy: SEED_ACTOR,
        description: spec.description,
        name: spec.name,
        type: spec.type,
        updatedAt: now,
        updatedBy: SEED_ACTOR,
      });
    }
    await batch.commit();
    written += chunk.length;
  }

  if (verbose) {
    console.log(`  ✅ Wrote ${written} variantParamSpecs documents`);
  }

  return { written, specs };
}

module.exports = {
  collectVariantParamSpecs,
  inferParamType,
  seedVariantParamSpecs,
};
