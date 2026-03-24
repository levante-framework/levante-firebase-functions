import * as admin from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { DEFAULT_PERMISSION_MATRIX } from "@levante-framework/permissions-core";

const adminCredentialFile = process.env.LEVANTE_ADMIN_FIREBASE_CREDENTIALS;

if (!adminCredentialFile) {
  console.error(
    `Missing required environment variables:
    - ROAR_ADMIN_FIREBASE_CREDENTIALS
    Please set these environment variables using
    export ROAR_ADMIN_FIREBASE_CREDENTIALS=path/to/credentials/for/admin/project.json`
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
    projectId: "hs-levante-admin-dev",
  },
  "admin",
);

const adminFirestore = getFirestore(adminApp);

const permissionsDocument = {
  permissions: DEFAULT_PERMISSION_MATRIX,
  updatedAt: FieldValue.serverTimestamp(),
  version: "1.1.0"
};

try {
  console.log("Creating system/permissions document...");
  
  await adminFirestore
    .collection("system")
    .doc("permissions")
    .set(permissionsDocument);
  
  console.log("✅ Successfully created system/permissions document");
  console.log("Document structure:", JSON.stringify(permissionsDocument, null, 2));
  
} catch (error) {
  console.error("❌ Error creating system/permissions document:", error);
  process.exit(1);
}

process.exit(0);
