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
      groups: {
        sites: ["create", "read", "update", "delete", "exclude"],
        schools: ["create", "read", "update", "delete", "exclude"],
        classes: ["create", "read", "update", "delete", "exclude"],
        cohorts: ["create", "read", "update", "delete", "exclude"],
      },
      assignments: ["create", "read", "update", "delete", "exclude"],
      users: ["create", "read", "update", "delete", "exclude"],
      admins: {
        site_admin: ["create", "read", "update", "delete"],
        admin: ["create", "read", "update", "delete"],
        research_assistant: ["create", "read", "update", "delete"]
      },
      tasks: ["create", "read", "update", "delete", "exclude"]
    },
    site_admin: {
      groups: {
        sites: ["read", "update"],
        schools: ["create", "read", "update", "delete", "exclude"],
        classes: ["create", "read", "update", "delete", "exclude"],
        cohorts: ["create", "read", "update", "delete", "exclude"],
      },
      assignments: ["create", "read", "update", "delete", "exclude"],
      users: ["create", "read", "update", "delete", "exclude"],
      // Update for admins is only for roles.
      // A site admin can change an admin's role (e.g., upgrade them to a site_admin).
      // But a site_admin cannot update another admin's name or email.
      admins: {
        site_admin: ["create", "read"],
        admin: ["create", "read", "update", "delete", "exclude"],
        research_assistant: ["create", "read", "update", "delete"]
      },
      tasks: ["create", "read", "update", "delete", "exclude"]
    },
    admin: {
      groups: {
        sites: ["read", "update"],
        schools: ["read", "update", "delete"],
        classes: ["read", "update", "delete"],
        cohorts: ["read", "update", "delete"],
      },
      assignments: ["create", "read", "update", "delete"],
      users: ["create", "read", "update"],
      admins: {
        site_admin: ["read"],
        admin: ["read"],
        research_assistant: ["create", "read"]
      },
      tasks: ["read"]
    },
    research_assistant: {
      groups: {
        sites: ["read"],
        schools: ["read"],
        classes: ["read"],
        cohorts: ["read"],
      },
      assignments: ["read"],
      users: ["create", "read"],
      admins: {
        site_admin: ["read"],
        admin: ["read"],
        research_assistant: ["read"]
      },
      tasks: ["read"]
    },
    // Participants do not have access to the admin side of the platform
    participant: {
      groups: {
        sites: [],
        schools: [],
        classes: [],
        cohorts: [],
      },
      assignments: [],
      users: [],
      admins: {
        site_admin: [],
        admin: [],
        research_assistant: []
      },
      tasks: []
    }
  },
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
