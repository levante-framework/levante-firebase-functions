/* eslint-disable @typescript-eslint/no-non-null-assertion */
import * as admin from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { logger, setGlobalOptions } from "firebase-functions/v2";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import {
  ACTIONS,
  RESOURCES,
  ADMIN_SUB_RESOURCES,
} from "@levante-framework/permissions-core";
import {
  ensurePermissionsLoaded,
  buildPermissionsUserFromAuthRecord,
  filterSitesByPermission,
  getPermissionService,
} from "./utils/permission-helpers.js";
import {
  onDocumentCreated,
  onDocumentDeleted,
  onDocumentUpdated,
  onDocumentWritten,
} from "firebase-functions/v2/firestore";
import {
  appendOrRemoveAdminOrgs,
  setUidClaimsInBothProjects,
  getRoarUid,
} from "./users/set-custom-claims.js";
import { createAdminUser } from "./users/admin-user.js";
import { updateUserRecordHandler } from "./users/edit-users.js";
import { _createUsers } from "./users/create-users.js";
import { _createAdministratorWithRoles } from "./users/create-administrator.js";
import {
  loadAdministratorContext,
  removeAdministratorRoles,
  updateAdministratorRoles,
} from "./users/update-administrator.js";
import type { AdministratorRoleDefinition } from "./users/create-administrator.js";
import { createSoftDeleteCloudFunction } from "./utils/soft-delete.js";
import {
  syncAssignmentCreatedEventHandler,
  syncAssignmentDeletedEventHandler,
  syncAssignmentUpdatedEventHandler,
} from "./assignments/on-assignment-updates.js";
import {
  syncAssignmentsOnUserUpdateEventHandler,
  updateAssignmentsForOrgChunkHandler,
  syncAssignmentsOnAdministrationUpdateEventHandler,
} from "./assignments/sync-assignments.js";
import { getAdministrationsForAdministrator } from "./administrations/administration-utils.js";
import { _deleteAdministration } from "./administrations/delete-administration.js";
import { unenrollOrg } from "./orgs/org-utils.js";
import { deleteOrg } from "./orgs/delete-org.js";
import { _linkUsers } from "./user-linking.js";
import { writeSurveyResponses } from "./save-survey-results.js";
import { _editUsers } from "./edit-users.js";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import _isEmpty from "lodash-es/isEmpty.js";
import { _upsertOrg } from "./upsert-org.js";
import type { OrgData } from "./upsert-org.js";
import { syncOnRunDocUpdateEventHandler } from "./runs/index.js";
import { upsertAdministrationHandler } from "./upsertAdministration.js";
import { ORG_COLLECTION_TO_SUBRESOURCE } from "./utils/constants.js";
import { sanitizeRoles } from "./utils/role-helpers.js";

// initialize 'default' app on Google cloud platform
admin.initializeApp({
  credential: admin.applicationDefault(),
});

// Initialize permission system (lazy-loads on first use)
ensurePermissionsLoaded().catch((error) =>
  logger.error("Error initializing permissions at module load", { error })
);

setGlobalOptions({ timeoutSeconds: 540 });

// TODO: Remove this function and wrapper in firekit
export const setUidClaims = onCall(async (request) => {
  const adminUid = request.auth!.uid;

  const roarUid = await getRoarUid({
    adminUid,
  });

  if (!roarUid) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  return await setUidClaimsInBothProjects({
    roarUid,
    adminUid,
  });
});

// Not using this. Can be refactored or removed
const updateUserRecord = onCall(async (request) => {
  const adminUid = request.data.uid;
  const userRecord = request.data.userRecord;
  const { password: newPassword, email: newEmail } = userRecord;
  return await updateUserRecordHandler({
    adminUid,
    newPassword,
    newEmail,
  });
});

export const createAdministratorAccount = onCall(async (request) => {
  let adminOrgs = request.data.adminOrgs;
  const requesterAdminUid = request.auth!.uid;

  // Check permissions if using new permission system
  const auth = getAuth();
  const userRecord = await auth.getUser(requesterAdminUid);
  const customClaims = (userRecord.customClaims as any) || {};
  const useNewPermissions = customClaims.useNewPermissions === true;

  if (useNewPermissions) {
    await ensurePermissionsLoaded();

    const user = buildPermissionsUserFromAuthRecord(userRecord);

    // Validate districts array exists
    const requestedDistricts = adminOrgs?.districts ?? [];
    if (!Array.isArray(requestedDistricts) || requestedDistricts.length === 0) {
      logger.error("No districts provided for admin creation", {
        requesterAdminUid,
      });
      throw new HttpsError(
        "invalid-argument",
        "At least one district is required for admin creation"
      );
    }

    // Filter to only districts where caller can create admins
    const allowedDistricts = filterSitesByPermission(user, requestedDistricts, {
      resource: RESOURCES.ADMINS,
      action: ACTIONS.CREATE,
      subResource: "admin",
    });

    if (allowedDistricts.length === 0) {
      logger.error(
        "Permission denied: user cannot create admins in requested districts",
        {
          requesterAdminUid,
          requestedDistricts,
        }
      );
      throw new HttpsError(
        "permission-denied",
        "You do not have permission to create administrator accounts in the specified districts"
      );
    }

    // Keep only allowed districts
    adminOrgs.districts = allowedDistricts;
  }

  const email = request.data.email;
  const name = request.data.name;
  const orgs = request.data.orgs;
  const isTestData = request.data.isTestData ?? false;

  return await createAdminUser({
    email,
    name,
    orgs,
    adminOrgs,
    requesterAdminUid,
    isTestData,
    // Necessary for the LEVANTE admins (to write the ``admin`` property)
    addUserClaimsAdminProperty: true,
  });
});

export const createAdministrator = onCall(async (request) => {
  const requesterAdminUid = request.auth?.uid;
  if (!requesterAdminUid) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const { email, name, roles, isTestData = false } = request.data ?? {};

  const auth = getAuth();
  const requesterRecord = await auth.getUser(requesterAdminUid);
  const customClaims: any = requesterRecord.customClaims || {};
  const useNewPermissions = customClaims.useNewPermissions === true;

  if (!useNewPermissions) {
    throw new HttpsError(
      "permission-denied",
      "New permission system must be enabled to create administrators with roles"
    );
  }

  const sanitizedRoles = sanitizeRoles(roles);
  if (sanitizedRoles.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "A non-empty roles array is required"
    );
  }

  await ensurePermissionsLoaded();
  const requestingUser = buildPermissionsUserFromAuthRecord(requesterRecord);

  const permissionsService = getPermissionService();
  const allowedSites = sanitizedRoles.filter((role) =>
    permissionsService.canPerformSiteAction(
      requestingUser,
      role.siteId,
      RESOURCES.ADMINS,
      ACTIONS.CREATE,
      role.role as (typeof ADMIN_SUB_RESOURCES)[keyof typeof ADMIN_SUB_RESOURCES]
    )
  );

  if (allowedSites.length === 0) {
    logger.error(
      "Permission denied: user cannot create administrators in requested sites",
      {
        requesterAdminUid,
        requestedSites: allowedSites.map((role) => role.siteId),
      }
    );
    throw new HttpsError(
      "permission-denied",
      "You do not have permission to create administrator accounts in the specified sites"
    );
  }

  return await _createAdministratorWithRoles({
    email,
    name,
    roles: allowedSites,
    requesterAdminUid,
    isTestData,
  });
});

export const updateAdministrator = onCall(async (request) => {
  const requesterAdminUid = request.auth?.uid;
  if (!requesterAdminUid) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const adminUidInput = request.data?.adminUid;
  if (typeof adminUidInput !== "string" || adminUidInput.trim().length === 0) {
    throw new HttpsError("invalid-argument", "A valid adminUid is required");
  }

  const rolesInput = request.data?.roles;
  if (!Array.isArray(rolesInput)) {
    throw new HttpsError(
      "invalid-argument",
      "Roles must be provided as an array"
    );
  }
  const sanitizedRoles = sanitizeRoles(
    rolesInput as AdministratorRoleDefinition[]
  );
  if (sanitizedRoles.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "A non-empty roles array is required"
    );
  }

  const auth = getAuth();
  const requesterRecord = await auth.getUser(requesterAdminUid);
  const customClaims: any = requesterRecord.customClaims || {};
  const useNewPermissions = customClaims.useNewPermissions === true;

  if (!useNewPermissions) {
    throw new HttpsError(
      "permission-denied",
      "New permission system must be enabled to update administrators with roles"
    );
  }

  await ensurePermissionsLoaded();
  const requestingUser = buildPermissionsUserFromAuthRecord(requesterRecord);
  const targetAdminUid = adminUidInput.trim();
  const context = await loadAdministratorContext(targetAdminUid);

  if (sanitizedRoles.length > 0) {
    const allowedUpdateSites: string[] = [];
    const permissionsService = getPermissionService();
    for (const role of sanitizedRoles) {
      const allowed = permissionsService.canPerformSiteAction(
        requestingUser,
        role.siteId,
        RESOURCES.ADMINS,
        // Here we updating an admins roles to creating an admin with a new role,
        ACTIONS.CREATE,
        role.role as (typeof ADMIN_SUB_RESOURCES)[keyof typeof ADMIN_SUB_RESOURCES]
      );
      if (allowed) {
        allowedUpdateSites.push(role.siteId);
      }
    }

    if (allowedUpdateSites.length !== sanitizedRoles.length) {
      const denied = sanitizedRoles.filter(
        (role) => !allowedUpdateSites.includes(role.siteId)
      );
      throw new HttpsError(
        "permission-denied",
        `You do not have permission to update administrators in sites: ${denied.join(
          ", "
        )}`
      );
    }
  }

  return await updateAdministratorRoles({
    context,
    updatedRoles: sanitizedRoles,
  });
});

export const removeAdministratorFromSite = onCall(async (request) => {
  const requesterAdminUid = request.auth?.uid;
  if (!requesterAdminUid) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const adminUidInput = request.data?.adminUid;
  if (typeof adminUidInput !== "string" || adminUidInput.trim().length === 0) {
    throw new HttpsError("invalid-argument", "A valid adminUid is required");
  }

  const siteIdInput = request.data?.siteId;
  if (typeof siteIdInput !== "string" || siteIdInput.trim().length === 0) {
    throw new HttpsError("invalid-argument", "A valid siteId is required");
  }

  const auth = getAuth();
  const requesterRecord = await auth.getUser(requesterAdminUid);
  const customClaims: any = requesterRecord.customClaims || {};
  const useNewPermissions = customClaims.useNewPermissions === true;

  if (!useNewPermissions) {
    throw new HttpsError(
      "permission-denied",
      "New permission system must be enabled to remove administrators from sites"
    );
  }

  await ensurePermissionsLoaded();
  const requestingUser = buildPermissionsUserFromAuthRecord(requesterRecord);
  const targetAdminUid = adminUidInput.trim();
  const targetSiteId = siteIdInput.trim();
  const context = await loadAdministratorContext(targetAdminUid);

  const permissionsService = getPermissionService();
  const allowedDeleteSites = permissionsService.canPerformSiteAction(
    requestingUser,
    targetSiteId,
    RESOURCES.ADMINS,
    ACTIONS.DELETE,
    "admin"
  );

  if (!allowedDeleteSites) {
    throw new HttpsError(
      "permission-denied",
      `You do not have permission to remove administrators from site ${targetSiteId}`
    );
  }

  return await removeAdministratorRoles({
    context,
    siteId: targetSiteId,
  });
});

export const syncAssignmentsOnAdministrationUpdate = onDocumentWritten(
  {
    document: "administrations/{administrationId}",
    memory: "2GiB",
  },
  syncAssignmentsOnAdministrationUpdateEventHandler
);

export const updateAssignmentsForOrgChunk = onTaskDispatched(
  {
    retryConfig: {
      maxAttempts: 5,
      minBackoffSeconds: 60,
    },
    rateLimits: {
      maxConcurrentDispatches: 6,
    },
    memory: "2GiB",
    timeoutSeconds: 540,
  },
  async (request) => {
    const { administrationId, administrationData, orgChunk, mode } =
      request.data;
    await updateAssignmentsForOrgChunkHandler({
      administrationId,
      administrationData,
      orgChunk,
      mode,
    });
  }
);

export const syncAssignmentsOnUserUpdate = onDocumentWritten(
  {
    document: "users/{roarUid}",
    memory: "512MiB",
  },
  (event) =>
    syncAssignmentsOnUserUpdateEventHandler({
      event,
      userTypes: ["student", "parent", "teacher"],
    })
);

export const syncAssignmentCreated = onDocumentCreated(
  "users/{roarUid}/assignments/{assignmentUid}",
  syncAssignmentCreatedEventHandler
);

export const syncAssignmentDeleted = onDocumentDeleted(
  "users/{roarUid}/assignments/{assignmentUid}",
  syncAssignmentDeletedEventHandler
);

export const syncAssignmentUpdated = onDocumentUpdated(
  {
    document: "users/{roarUid}/assignments/{assignmentUid}",
    timeoutSeconds: 300,
    memory: "512MiB",
  },
  syncAssignmentUpdatedEventHandler
);

export const softDeleteUser = createSoftDeleteCloudFunction(["users"]);

export const softDeleteUserAssignment = createSoftDeleteCloudFunction([
  "users",
  "assignments",
]);

export const createUsers = onCall(
  { memory: "2GiB", timeoutSeconds: 540 },
  async (request) => {
    const userData = request.data.users;
    const requestingUid = request.auth!.uid;

    // New permission system gate: ensure caller can create users in the requested site
    try {
      const auth = getAuth();
      const userRecord = await auth.getUser(requestingUid);
      const customClaims: any = userRecord.customClaims || {};
      const useNewPermissions = customClaims.useNewPermissions === true;

      if (useNewPermissions) {
        await ensurePermissionsLoaded();
        const user = buildPermissionsUserFromAuthRecord(userRecord);

        // Expect a single site identifier on the request
        const siteId: string | undefined = (request.data.siteId ||
          request.data.districtId) as string | undefined;

        if (!siteId) {
          throw new HttpsError(
            "invalid-argument",
            "A siteId (or districtId) is required to create users"
          );
        }

        const allowed =
          filterSitesByPermission(user, [siteId], {
            resource: RESOURCES.USERS,
            action: ACTIONS.CREATE,
          }).length > 0;

        if (!allowed) {
          throw new HttpsError(
            "permission-denied",
            `You do not have permission to create users in site ${siteId}`
          );
        }
      }
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      // For unexpected errors in permission path, surface as internal
      throw new HttpsError(
        "internal",
        (err as Error)?.message || "Permission check failed"
      );
    }

    const result = await _createUsers(requestingUid, userData);
    return result;
  }
);

export const saveSurveyResponses = onCall(async (request) => {
  const requestingUid = request.auth!.uid;

  try {
    const result = await writeSurveyResponses(requestingUid, request.data);
    return result;
    // eslint-disable @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error("Error writing survey responses", {
      error,
      requestingUid,
    });
    throw new HttpsError(
      "internal",
      error.message ||
        "An unknown error occurred while writing survey responses"
    );
  }
});

export const linkUsers = onCall(async (request) => {
  const requestingUid = request.auth!.uid;
  const users = request.data.users;
  const siteId: string | undefined = (request.data.siteId ||
    request.data.districtId) as string | undefined;

  if (!siteId) {
    throw new HttpsError(
      "invalid-argument",
      "A siteId (or districtId) is required to link users"
    );
  }

  try {
    const auth = getAuth();
    const userRecord = await auth.getUser(requestingUid);
    const customClaims: any = userRecord.customClaims || {};
    const useNewPermissions = customClaims.useNewPermissions === true;

    if (useNewPermissions) {
      await ensurePermissionsLoaded();
      const user = buildPermissionsUserFromAuthRecord(userRecord);

      const allowed =
        filterSitesByPermission(user, [siteId], {
          resource: RESOURCES.USERS,
          // If you can create users, you can link them.
          action: ACTIONS.CREATE,
        }).length > 0;

      if (!allowed) {
        throw new HttpsError(
          "permission-denied",
          `You do not have permission to link users in site ${siteId}`
        );
      }
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError(
      "internal",
      (err as Error)?.message || "Permission check failed"
    );
  }
  return await _linkUsers(users, siteId);
});

export const getAdministrations = onCall(async (request) => {
  const adminUid = request.auth!.uid;

  const idsOnly = request.data.idsOnly ?? true;

  const restrictToOpenAdministrations =
    request.data.restrictToOpenAdministrations ?? false;

  const testData = request.data.testData ?? null;

  const administrations = await getAdministrationsForAdministrator({
    adminUid,
    restrictToOpenAdministrations,
    testData,
    idsOnly,
  });

  return { status: "ok", data: administrations };
});

export const unenrollOrgTask = onTaskDispatched(
  {
    retryConfig: {
      maxAttempts: 5,
      minBackoffSeconds: 60,
    },
    rateLimits: {
      maxConcurrentDispatches: 10,
    },
    memory: "1GiB",
    timeoutSeconds: 540,
  },
  async (request) => {
    const { orgType, orgId, orgDocSnapshot, modifyAssignedAdministrations } =
      request.data;

    await unenrollOrg({
      orgType,
      orgId,
      orgDocSnapshot,
      modifyAssignedAdministrations,
    });
  }
);

export const editUsers = onCall(async (request) => {
  const requestingUid = request.auth?.uid;
  if (!requestingUid) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const usersToUpdate = request.data.users;
  if (!Array.isArray(usersToUpdate) || usersToUpdate.length === 0) {
    throw new HttpsError(
      "invalid-argument",
      "Users array is required and must not be empty"
    );
  }

  return await _editUsers(requestingUid, usersToUpdate);
});

export const upsertOrg = onCall(async (request) => {
  const requestingUid = request.auth?.uid;
  const groupData = request.data.orgData as OrgData;

  if (!requestingUid) {
    logger.error("User is not authenticated.");
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!groupData || typeof groupData !== "object") {
    logger.error("Invalid groupData provided.", { groupData });
    throw new HttpsError(
      "invalid-argument",
      "Group data is missing or invalid."
    );
  }

  // Ensure basic data like type is present before calling the internal function
  if (!groupData.type) {
    logger.error("Group type is missing in groupData.", { groupData });
    throw new HttpsError("invalid-argument", "Group type is required.");
  }

  try {
    const auth = getAuth();
    const userRecord = await auth.getUser(requestingUid);
    const customClaims: any = userRecord.customClaims || {};
    const useNewPermissions = customClaims.useNewPermissions === true;

    if (useNewPermissions) {
      await ensurePermissionsLoaded();
      const user = buildPermissionsUserFromAuthRecord(userRecord);

      const groupType =
        groupData.type as keyof typeof ORG_COLLECTION_TO_SUBRESOURCE;
      const subResource = ORG_COLLECTION_TO_SUBRESOURCE[groupType];

      if (!subResource) {
        logger.error("Unsupported group type for permission check", {
          groupType,
        });
        throw new HttpsError(
          "invalid-argument",
          `Unsupported group type: ${groupType}`
        );
      }

      const groupId =
        typeof groupData.id === "string" ? groupData.id : undefined;
      const rawSiteId =
        (groupData.districtId as string | undefined) ||
        (groupData.parentOrgId as string | undefined);
      const siteId =
        typeof rawSiteId === "string" ? rawSiteId.trim() : undefined;
      console.log("siteId:  ", siteId);

      if (groupData.type !== "districts" && !siteId) {
        logger.error("Missing site identifier for group upsert", {
          requestingUid,
          groupType,
        });
        throw new HttpsError(
          "invalid-argument",
          "A siteId is required to create or update groups"
        );
      }

      const action = groupId ? ACTIONS.UPDATE : ACTIONS.CREATE;
      const allowed =
        filterSitesByPermission(user, [siteId!], {
          resource: RESOURCES.GROUPS,
          action,
          subResource,
        }).length > 0;

      if (!allowed) {
        logger.error("Permission denied for group upsert", {
          requestingUid,
          groupType,
          subResource,
          groupId,
          siteId,
          action,
        });
        throw new HttpsError(
          "permission-denied",
          `You do not have permission to ${action} ${groupType} in site ${siteId}`
        );
      }
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError(
      "internal",
      (err as Error)?.message || "Permission check failed"
    );
  }

  try {
    const groupId = await _upsertOrg(requestingUid, groupData);
    logger.info("Group successfully upserted.", {
      requestingUid,
      groupType: groupData.type,
      groupId,
    });
    return { status: "ok", orgId: groupId };
  } catch (error) {
    // Errors are logged and potentially transformed into HttpsError within _upsertOrg
    // Re-throw the error for the Cloud Functions framework to handle
    throw error;
  }
});

export const deleteOrgFunction = onCall(async (request) => {
  const requestingUid = request.auth?.uid;
  const { orgsCollection, orgId, recursive = true } = request.data;

  if (!requestingUid) {
    logger.error("User is not authenticated.");
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!orgsCollection || !orgId) {
    logger.error("Missing required parameters.", { orgsCollection, orgId });
    throw new HttpsError(
      "invalid-argument",
      "Organization collection and ID are required."
    );
  }

  // Validate organization collection type
  const validCollections = ["districts", "schools", "classes", "groups"];
  if (!validCollections.includes(orgsCollection)) {
    logger.error("Invalid organization collection type.", { orgsCollection });
    throw new HttpsError(
      "invalid-argument",
      "Invalid organization collection type."
    );
  }

  try {
    const auth = getAuth();
    const userRecord = await auth.getUser(requestingUid);
    const customClaims: any = userRecord.customClaims || {};
    const useNewPermissions = customClaims.useNewPermissions === true;

    if (useNewPermissions) {
      await ensurePermissionsLoaded();
      const user = buildPermissionsUserFromAuthRecord(userRecord);

      const subResource = orgsCollection;

      if (!subResource) {
        logger.error("Unsupported organization collection for delete", {
          orgsCollection,
        });
        throw new HttpsError(
          "invalid-argument",
          `Unsupported organization type: ${orgsCollection}`
        );
      }

      const siteId = request.data.siteId;

      if (!siteId) {
        logger.error("Missing site identifier for org delete", {
          requestingUid,
          orgsCollection,
          orgId,
        });
        throw new HttpsError(
          "invalid-argument",
          "A siteId (e.g. districtId) is required to delete organizations"
        );
      }

      const allowed =
        filterSitesByPermission(user, [siteId], {
          resource: RESOURCES.GROUPS,
          action: ACTIONS.DELETE,
          subResource,
        }).length > 0;

      if (!allowed) {
        logger.error("Permission denied for org delete", {
          requestingUid,
          orgsCollection,
          subResource,
          orgId,
          siteId,
        });
        throw new HttpsError(
          "permission-denied",
          `You do not have permission to delete ${orgsCollection} in site ${siteId}`
        );
      }
    } else {
      const db = getFirestore();
      const userClaimsRef = db.collection("userClaims").doc(requestingUid);
      const userClaimsDoc = await userClaimsRef.get();

      if (!userClaimsDoc.exists) {
        logger.error("User claims not found.", { requestingUid });
        throw new HttpsError(
          "permission-denied",
          "User permissions not found."
        );
      }

      const userClaims = userClaimsDoc.data();
      const isSuperAdmin = userClaims?.claims?.super_admin === true;

      if (!isSuperAdmin) {
        logger.error("User is not a super admin.", { requestingUid });
        throw new HttpsError(
          "permission-denied",
          "You must be a super admin to delete an organization."
        );
      }
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError(
      "internal",
      (err as Error)?.message || "Permission check failed"
    );
  }

  try {
    await deleteOrg(orgsCollection, orgId, recursive);
    logger.info("Organization successfully deleted.", {
      requestingUid,
      orgsCollection,
      orgId,
      recursive,
    });
    return { status: "ok", message: "Organization deleted successfully" };
  } catch (error) {
    logger.error("Error deleting organization:", error);
    throw new HttpsError("internal", "Failed to delete organization");
  }
});

export const deleteAdministration = onCall(async (request) => {
  const requestingUid = request.auth?.uid;
  const { administrationId } = request.data;

  if (!requestingUid) {
    logger.error("User is not authenticated.");
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!administrationId) {
    logger.error("Missing required parameter: administrationId");
    throw new HttpsError("invalid-argument", "Administration ID is required.");
  }

  try {
    const auth = getAuth();
    const userRecord = await auth.getUser(requestingUid);
    const customClaims: any = userRecord.customClaims || {};
    const useNewPermissions = customClaims.useNewPermissions === true;

    if (useNewPermissions) {
      await ensurePermissionsLoaded();
      const user = buildPermissionsUserFromAuthRecord(userRecord);

      const siteId = request.data.siteId;

      if (!siteId) {
        logger.error("Missing site identifier for administration delete", {
          requestingUid,
          administrationId,
        });
        throw new HttpsError(
          "invalid-argument",
          "A siteId (or districtId) is required to delete administrations"
        );
      }

      const allowed =
        filterSitesByPermission(user, [siteId], {
          resource: RESOURCES.ASSIGNMENTS,
          action: ACTIONS.DELETE,
        }).length > 0;

      if (!allowed) {
        logger.error("Permission denied for administration delete", {
          requestingUid,
          administrationId,
          siteId,
        });
        throw new HttpsError(
          "permission-denied",
          `You do not have permission to delete administrations in site ${siteId}`
        );
      }
    } else {
      const db = getFirestore();
      const userClaimsRef = db.collection("userClaims").doc(requestingUid);
      const userClaimsDoc = await userClaimsRef.get();

      if (!userClaimsDoc.exists) {
        logger.error("User claims not found.", { requestingUid });
        throw new HttpsError(
          "permission-denied",
          "User permissions not found."
        );
      }

      const userClaims = userClaimsDoc.data();
      const isSuperAdmin = userClaims?.claims?.super_admin === true;
      if (!isSuperAdmin) {
        logger.error("User is not a super admin.", { requestingUid });
        throw new HttpsError(
          "permission-denied",
          "You must be a super admin to delete an administration."
        );
      }
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError(
      "internal",
      (err as Error)?.message || "Permission check failed"
    );
  }

  try {
    await _deleteAdministration(administrationId);
    logger.info("Administration successfully deleted.", {
      requestingUid,
      administrationId,
    });
    return { status: "ok", message: "Administration deleted successfully" };
  } catch (error) {
    logger.error("Error deleting administration:", error);
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError("internal", "Failed to delete administration");
  }
});

export const upsertAdministration = onCall(async (request) => {
  const requestingUid = request.auth?.uid;
  if (!requestingUid) {
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  // New permission system gate: verify caller can create/update administrations in the requested site
  try {
    const auth = getAuth();
    const userRecord = await auth.getUser(requestingUid);
    const customClaims: any = userRecord.customClaims || {};
    const useNewPermissions = customClaims.useNewPermissions === true;

    if (useNewPermissions) {
      await ensurePermissionsLoaded();
      const user = buildPermissionsUserFromAuthRecord(userRecord);

      const action = request.data?.administrationId
        ? ACTIONS.UPDATE
        : ACTIONS.CREATE;
      const siteId: string | undefined = (request.data.siteId ||
        request.data.districtId) as string | undefined;

      if (!siteId) {
        throw new HttpsError(
          "invalid-argument",
          "A siteId (or districtId) is required to upsert administrations"
        );
      }

      const allowed =
        filterSitesByPermission(user, [siteId], {
          resource: RESOURCES.ASSIGNMENTS,
          action,
        }).length > 0;

      if (!allowed) {
        throw new HttpsError(
          "permission-denied",
          `You do not have permission to ${action} administrations in site ${siteId}`
        );
      }
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError(
      "internal",
      (err as Error)?.message || "Permission check failed"
    );
  }

  // Delegate to handler
  return await upsertAdministrationHandler(requestingUid, request.data);
});

export { completeTask } from "./tasks/completeTask.js";
export { startTask } from "./tasks/startTask.js";

export const syncOnRunDocUpdate = onDocumentWritten(
  {
    document: "users/{roarUid}/runs/{runId}",
  },
  syncOnRunDocUpdateEventHandler
);
