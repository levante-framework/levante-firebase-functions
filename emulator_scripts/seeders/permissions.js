const { FieldValue } = require('firebase-admin/firestore');

/**
 * Creates the system permissions document
 * @param {admin.app.App} adminApp - The Firebase Admin app instance
 * @returns {Promise<Object>} The created permissions structure
 */
async function createSystemPermissions(adminApp) {
  const db = adminApp.firestore();
  
  const permissionsDocument = {
    "permissions": {
      "super_admin": {
        "groups": {
          "sites": ["create", "read", "update", "delete", "exclude"],
          "schools": ["create", "read", "update", "delete", "exclude"],
          "classes": ["create", "read", "update", "delete", "exclude"],
          "cohorts": ["create", "read", "update", "delete", "exclude"]
        },
        "assignments": ["create", "read", "update", "delete", "exclude"],
        "users": ["create", "read", "update", "delete", "exclude"],
        "admins": {
          "site_admin": ["create", "read", "update", "delete"],
          "admin": ["create", "read", "update", "delete"],
          "research_assistant": ["create", "read", "update", "delete"]
        },
        "tasks": ["create", "read", "update", "delete", "exclude"]
      },
      "site_admin": {
        "groups": {
          "sites": ["read", "update"],
          "schools": ["create", "read", "update", "delete", "exclude"],
          "classes": ["create", "read", "update", "delete", "exclude"],
          "cohorts": ["create", "read", "update", "delete", "exclude"]
        },
        "assignments": ["create", "read", "update", "delete", "exclude"],
        "users": ["create", "read", "update", "delete", "exclude"],
        "admins": {
          "site_admin": ["create", "read"],
          "admin": ["create", "read", "update", "delete", "exclude"],
          "research_assistant": ["create", "read", "update", "delete"]
        },
        "tasks": ["create", "read", "update", "delete", "exclude"]
      },
      "admin": {
        "groups": {
          "sites": ["read", "update"],
          "schools": ["read", "update", "delete"],
          "classes": ["read", "update", "delete"],
          "cohorts": ["read", "update", "delete"]
        },
        "assignments": ["create", "read", "update", "delete"],
        "users": ["create", "read", "update"],
        "admins": {
          "site_admin": ["read"],
          "admin": ["read"],
          "research_assistant": ["create", "read"]
        },
        "tasks": ["read"]
      },
      "research_assistant": {
        "groups": {
          "sites": ["read"],
          "schools": ["read"],
          "classes": ["read"],
          "cohorts": ["read"]
        },
        "assignments": ["read"],
        "users": ["create", "read"],
        "admins": {
          "site_admin": ["read"],
          "admin": ["read"],
          "research_assistant": ["read"]
        },
        "tasks": ["read"]
      },
      "participant": {
        "groups": {
          "sites": [],
          "schools": [],
          "classes": [],
          "cohorts": []
        },
        "assignments": [],
        "users": [],
        "admins": {
          "site_admin": [],
          "admin": [],
          "research_assistant": []
        },
        "tasks": []
      }
    },
    "updatedAt": "2025-10-30T10:00:00Z",
    "version": "1.1.0"
  }
  
  
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
