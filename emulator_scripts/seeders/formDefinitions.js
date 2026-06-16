const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const SEED_DIR = path.join(__dirname, '../seed-data/org-information-forms');

const VERSION_TIMESTAMP_FIELDS = ['createdAt', 'updatedAt', 'liveFrom', 'liveUntil'];

function toFirestoreTimestamp(value) {
  if (value == null) {
    return null;
  }
  return admin.firestore.Timestamp.fromDate(new Date(value));
}

function prepareVersionDocument(version) {
  const prepared = { ...version };

  for (const field of VERSION_TIMESTAMP_FIELDS) {
    if (field in prepared) {
      prepared[field] = toFirestoreTimestamp(prepared[field]);
    }
  }

  return prepared;
}

function loadSeedFiles() {
  return fs
    .readdirSync(SEED_DIR)
    .filter((filename) => filename.endsWith('.seed.json'))
    .sort()
    .map((filename) => {
      const filePath = path.join(SEED_DIR, filename);
      const seed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return { filename, filePath, seed };
    });
}

/**
 * Seeds org-information form definitions from emulator_scripts/seed-data/org-information-forms/*.seed.json
 * into Firestore at formDefinitions/{formId} and formDefinitions/{formId}/versions/{versionId}.
 *
 * @param {admin.app.App} adminApp
 * @returns {Promise<Array<{ formId: string, versionIds: string[] }>>}
 */
async function createFormDefinitions(adminApp) {
  const db = adminApp.firestore();
  const seedFiles = loadSeedFiles();
  const created = [];

  if (seedFiles.length === 0) {
    console.log('  ⚪ No *.seed.json files found in seed-data/org-information-forms');
    return created;
  }

  for (const { filename, seed } of seedFiles) {
    const { collection, documentId, definition, versions } = seed;

    if (collection !== 'formDefinitions' || !documentId || !definition || !versions) {
      throw new Error(
        `${filename} must include collection, documentId, definition, and versions`,
      );
    }

    const formRef = db.collection('formDefinitions').doc(documentId);
    await formRef.set(definition);

    const versionIds = [];
    for (const [versionId, version] of Object.entries(versions)) {
      await formRef.collection('versions').doc(versionId).set(prepareVersionDocument(version));
      versionIds.push(versionId);
    }

    created.push({ formId: documentId, versionIds });
    console.log(
      `  ✓ formDefinitions/${documentId} (${versionIds.length} version(s), ${versions[versionIds[0]]?.fullFields?.length ?? 0} fields)`,
    );
  }

  return created;
}

module.exports = { createFormDefinitions };
