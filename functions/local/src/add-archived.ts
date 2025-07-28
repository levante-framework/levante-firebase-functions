import * as admin from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Iterate over all users in the roar-admin database.
 */
const dryRun = false;
const isDev = true;

const adminCredentialFile = process.env.ROAR_ADMIN_FIREBASE_CREDENTIALS;

if (!adminCredentialFile) {
  console.error(
    `Missing required environment variables:
    - ROAR_ADMIN_FIREBASE_CREDENTIALS
    Please set these environment variables using
    export ROAR_ADMIN_FIREBASE_CREDENTIALS=path/to/credentials/for/admin/project.json`,
  );
  process.exit(1);
}

const adminCredentials = (
  await import(adminCredentialFile, {
    assert: { type: "json" },
  })
).default;

const adminApp = admin.initializeApp(
  {
    credential: admin.cert(adminCredentials),
    projectId: isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod",
  },
  "admin",
);

const db = getFirestore(adminApp);

const orgTypes = ["users"];

for (const orgType of orgTypes) {
  console.log(`Querying for ${orgType}...`);
  const orgQuery = db.collection(orgType);
  await orgQuery.get().then((querySnapshot) => {
    console.log(`Processing ${querySnapshot.size} ${orgType}s`);
    for (const doc of querySnapshot.docs) {
      const docData = doc.data();
      // console.log(orgType, "orgData", docData);
      if (!Object.keys(docData).includes("archived")) {
        if (dryRun) {
          console.log(`Found no archived for ${orgType} ${doc.id}`);
        } else {
          console.log(`Adding archived to ${doc.id}`);
          doc.ref.update({ archived: false });
        }
      }
    }
  });
}
