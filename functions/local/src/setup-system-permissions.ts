/**
 * Sets up the system permissions document in Firestore.
 * This script creates a system/permissions document that defines role-based permissions
 * for different user types (super_admin, site_admin, admin, research_assistant, participant).
 */

import * as admin from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

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
  permissions: {
    super_admin: {
      groups: ["create", "read", "update", "delete", "exclude"],
      assignments: ["create", "read", "update", "delete", "exclude"],
      users: ["create", "read", "update", "delete", "exclude"],
      admins: ["create", "read", "update", "delete", "exclude"],
      tasks: ["create", "read", "update", "delete", "exclude"]
    },
    site_admin: {
      groups: ["create", "read", "update", "delete", "exclude"],
      assignments: ["create", "read", "update", "delete", "exclude"],
      users: ["create", "read", "update", "delete", "exclude"],
      admins: ["create", "read", "update", "delete", "exclude"],
      tasks: ["create", "read", "update", "delete", "exclude"]
    },
    admin: {
      groups: ["create", "read", "update"],
      assignments: ["create", "read", "update"],
      users: ["create", "read", "update"],
      admins: ["read"],
      tasks: ["read"]
    },
    research_assistant: {
      groups: ["read"],
      assignments: ["read"],
      users: ["create", "read"],
      admins: ["read"],
      tasks: ["read"]
    },
    participant: {
      groups: [],
      assignments: [],
      users: [],
      admins: [],
      tasks: []
    }
  },
  updatedAt: FieldValue.serverTimestamp(),
  version: "1.0.0"
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
