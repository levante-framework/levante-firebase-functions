/**
 * Creates the system permissions document
 * @param {admin.app.App} adminApp - The Firebase Admin app instance
 * @returns {Promise<Object>} The created permissions structure
 */
async function createSystemPermissions(adminApp) {
  const permissionsCore = await import("@levante-framework/permissions-core");
  const {
    DEFAULT_PERMISSION_MATRIX,
    ALL_ACTIONS,
    ALL_ADMIN_SUB_RESOURCES,
    ALL_GROUP_SUB_RESOURCES,
    ALL_RESOURCES,
    ALL_ROLES,
  } = permissionsCore;
  const db = adminApp.firestore();
  const buildFallbackPermissionMatrix = () => {
    const resourcePermissions = (resource) => {
      if (resource === "groups") {
        return Object.fromEntries(
          ALL_GROUP_SUB_RESOURCES.map((subResource) => [
            subResource,
            ALL_ACTIONS,
          ])
        );
      }
      if (resource === "admins") {
        return Object.fromEntries(
          ALL_ADMIN_SUB_RESOURCES.map((subResource) => [
            subResource,
            ALL_ACTIONS,
          ])
        );
      }
      return ALL_ACTIONS;
    };

    return Object.fromEntries(
      ALL_ROLES.map((role) => [
        role,
        Object.fromEntries(
          ALL_RESOURCES.map((resource) => [
            resource,
            resourcePermissions(resource),
          ])
        ),
      ])
    );
  };
  const permissionMatrix =
    DEFAULT_PERMISSION_MATRIX || buildFallbackPermissionMatrix();

  const permissionsDocument = {
    permissions: permissionMatrix,
    updatedAt: "2025-10-30T10:00:00Z",
    version: "1.1.0",
  };

  try {
    await db.collection("system").doc("permissions").set(permissionsDocument);

    console.log("  ✓ Created system/permissions document");

    return permissionsDocument.permissions;
  } catch (error) {
    console.error("  ✗ Failed to create system permissions:", error.message);
    throw error;
  }
}

module.exports = { createSystemPermissions };
