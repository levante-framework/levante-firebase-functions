const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const DEFAULT_VARIANT_SEED_PATH = path.join(__dirname, 'default-variant-seed.json');

const FIRESTORE_TIMESTAMP_SENTINEL_KEY = '__firestoreTimestamp';

// The exporter (functions/local/src/variants/write-registered-variants-json.ts)
// wraps Firestore Timestamp values as `{ __firestoreTimestamp: "<iso>" }` so
// they survive JSON serialization. On seed we replace every sentinel with a
// fresh `serverTimestamp()` so timestamps in the emulator reflect when the
// data was seeded — not when it was last touched in dev/prod. Recursively
// walks arrays and objects; primitives pass through unchanged.
function isTimestampSentinel(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value[FIRESTORE_TIMESTAMP_SENTINEL_KEY] === 'string' &&
    Object.keys(value).length === 1
  );
}

function materializeFirestoreValues(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(materializeFirestoreValues);
  if (typeof value === 'object') {
    if (isTimestampSentinel(value)) {
      return admin.firestore.FieldValue.serverTimestamp();
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = materializeFirestoreValues(v);
    }
    return out;
  }
  return value;
}

function loadVariantSeedRows(seedPath) {
  if (!fs.existsSync(seedPath)) {
    throw new Error(
      `Variant seed file not found: ${seedPath}. Use default-variant-seed.json next to tasks.js or pass --variant-seed <path>. See emulator_scripts/blank-variant-seed.json for shape.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
  const rows = raw.rows;
  if (!Array.isArray(rows)) {
    throw new Error(`${seedPath} must contain a "rows" array`);
  }
  if (rows.length === 0) {
    throw new Error(
      `${seedPath} has an empty "rows" array. Add task rows or use emulator_scripts/seeders/default-variant-seed.json (see emulator_scripts/blank-variant-seed.json for the expected shape).`,
    );
  }
  for (const row of rows) {
    if (!row || typeof row.taskId !== 'string' || !row.taskData || typeof row.taskData !== 'object') {
      throw new Error(`Invalid row in ${seedPath}: each row needs taskId (string) and taskData (object)`);
    }
    if (!Array.isArray(row.variants) || row.variants.length === 0) {
      throw new Error(`Invalid row for task ${row.taskId} in ${seedPath}: variants must be a non-empty array`);
    }
    for (const v of row.variants) {
      if (!v || typeof v.id !== 'string' || !v.data || typeof v.data !== 'object') {
        throw new Error(`Invalid variant under task ${row.taskId} in ${seedPath}: need id (string) and data (object)`);
      }
    }
  }
  return rows;
}

async function seedTasksFromVariantSeedFile(db, seedPath) {
  const rows = loadVariantSeedRows(seedPath);
  const createdTasks = [];

  console.log(`  Seeding tasks from variant file: ${seedPath}`);

  for (const row of rows) {
    const { taskId, taskData, variants } = row;
    const taskRef = db.collection('tasks').doc(taskId);

    await taskRef.set({
      ...materializeFirestoreValues(taskData),
      lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
    });
    console.log(`    ✅ Task document: ${taskId}`);

    for (const v of variants) {
      await taskRef.collection('variants').doc(v.id).set({
        ...materializeFirestoreValues(v.data),
        lastUpdated: admin.firestore.FieldValue.serverTimestamp(),
      });
      console.log(`      ✅ Variant ${v.id}`);
    }

    const primaryVariantId = variants[0].id;
    const taskName = taskData.name || taskId;
    createdTasks.push({
      id: taskId,
      name: taskName,
      type: 'variant-seed',
      variantId: primaryVariantId,
    });
  }

  console.log(`  ✅ Seeded ${createdTasks.length} task(s) from variant seed`);
  return createdTasks;
}

async function createTasks(adminApp, options = {}) {
  const db = adminApp.firestore();
  const seedPath = options.variantSeedPath
    ? path.resolve(process.cwd(), options.variantSeedPath)
    : DEFAULT_VARIANT_SEED_PATH;
  return seedTasksFromVariantSeedFile(db, seedPath);
}

module.exports = {
  createTasks,
  loadVariantSeedRows,
  materializeFirestoreValues,
  isTimestampSentinel,
  FIRESTORE_TIMESTAMP_SENTINEL_KEY,
};
