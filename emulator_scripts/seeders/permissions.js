const { DEFAULT_PERMISSION_MATRIX } = require('@levante-framework/permissions-core');

/**
 * Creates the system permissions document
 * @param {admin.app.App} adminApp - The Firebase Admin app instance
 * @returns {Promise<Object>} The created permissions structure
 */
async function createSystemPermissions(adminApp) {
  const db = adminApp.firestore();
  
  const permissionsDocument = {
    "permissions": DEFAULT_PERMISSION_MATRIX,
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
