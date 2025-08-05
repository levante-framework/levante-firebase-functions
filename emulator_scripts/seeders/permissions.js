const { FieldValue } = require('firebase-admin/firestore');

/**
 * Creates the system permissions document
 * @param {admin.app.App} adminApp - The Firebase Admin app instance
 * @returns {Promise<Object>} The created permissions structure
 */
async function createSystemPermissions(adminApp) {
  const db = adminApp.firestore();
  
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
    await db
      .collection("system")
      .doc("permissions")
      .set(permissionsDocument);
    
    console.log("  ✓ Created system/permissions document");
    
    return permissionsDocument.permissions;
  } catch (error) {
    console.error("  ✗ Failed to create system permissions:", error.message);
    throw error;
  }
}

module.exports = { createSystemPermissions };
