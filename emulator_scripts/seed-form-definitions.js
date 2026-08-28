/**
 * Seed only org-information form definitions (useful after editing *.seed.json).
 *
 * Usage (from levante-firebase-functions, with emulator running):
 *   npm run emulator:seed:forms
 */
const admin = require("firebase-admin");
const { getSeedConfig } = require("./config");
const { createFormDefinitions } = require("./seeders/formDefinitions");

const { projectId, isEmulator } = getSeedConfig();

if (isEmulator) {
  process.env.FIRESTORE_EMULATOR_HOST ||= "127.0.0.1:8180";
  process.env.FIREBASE_AUTH_EMULATOR_HOST ||= "127.0.0.1:9199";
}

const adminApp = admin.initializeApp({ projectId }, "admin-form-definition-seeder");

createFormDefinitions(adminApp)
  .then((created) => {
    console.log(`Seeded ${created.length} form definition(s).`);
    created.forEach(({ formId, versionIds }) => {
      console.log(`- formDefinitions/${formId} (${versionIds.join(", ")})`);
    });
  })
  .catch((error) => {
    console.error("Form definition seeding failed:", error.message);
    process.exitCode = 1;
  });
