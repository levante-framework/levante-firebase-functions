/* eslint-disable @typescript-eslint/no-non-null-assertion */
import * as admin from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { logger, setGlobalOptions } from "firebase-functions/v2";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import {
  ensurePermissionsLoaded,
  buildPermissionsUserFromAuthRecord,
  filterSitesByPermission,
} from "./utils/permission-helpers";
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
} from "./users/set-custom-claims";
import { createAdminUser } from "./users/admin-user";
import { updateUserRecordHandler } from "./users/edit-users";
import { _createUsers } from "./users/create-users";
import { createSoftDeleteCloudFunction } from "./utils/soft-delete";
import {
  syncAssignmentCreatedEventHandler,
  syncAssignmentDeletedEventHandler,
  syncAssignmentUpdatedEventHandler,
} from "./assignments/on-assignment-updates";
import {
  syncAssignmentsOnUserUpdateEventHandler,
  updateAssignmentsForOrgChunkHandler,
  syncAssignmentsOnAdministrationUpdateEventHandler,
} from "./assignments/sync-assignments";
import { getAdministrationsForAdministrator } from "./administrations/administration-utils";
import { _deleteAdministration } from "./administrations/delete-administration";
import { unenrollOrg } from "./orgs/org-utils";
import { deleteOrg } from "./orgs/delete-org";
import { _linkUsers } from "./user-linking";
import { writeSurveyResponses } from "./save-survey-results";
import { _editUsers } from "./edit-users";
import { onTaskDispatched } from "firebase-functions/v2/tasks";
import _isEmpty from "lodash/isEmpty";
import { _upsertOrg, OrgData } from "./upsert-org";
import { syncOnRunDocUpdateEventHandler } from "./runs";

// initialize 'default' app on Google cloud platform
admin.initializeApp({
  credential: admin.applicationDefault(),
});

// Initialize permission system (lazy-loads on first use)
ensurePermissionsLoaded().catch((error) =>
  logger.error("Error initializing permissions at module load", { error })
);

setGlobalOptions({ timeoutSeconds: 540 });

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

export const appendToAdminClaims = onCall(async (request) => {
  const input = {
    requesterUid: request.auth!.uid,
    targetUid: request.data.targetUid,
    districtId: request.data.districtId,
    schoolId: request.data.schoolId,
    classId: request.data.classId,
    familyId: request.data.familyId,
    groupId: request.data.groupId,
    action: "append" as const,
  };

  return await appendOrRemoveAdminOrgs(input);
});

export const removeFromAdminClaims = onCall(async (request) => {
  const input = {
    requesterUid: request.auth!.uid,
    targetUid: request.data.targetUid,
    districtId: request.data.districtId,
    schoolId: request.data.schoolId,
    classId: request.data.classId,
    familyId: request.data.familyId,
    groupId: request.data.groupId,
    action: "remove" as const,
  };

  return await appendOrRemoveAdminOrgs(input);
});

// Not using this. Can be refactored or removed
export const updateUserRecord = onCall(async (request) => {
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
      logger.error("No districts provided for admin creation", { requesterAdminUid });
      throw new HttpsError("invalid-argument", "At least one district is required for admin creation");
    }

    // Filter to only districts where caller can create admins
    const allowedDistricts = filterSitesByPermission(user, requestedDistricts, {
      resource: RESOURCES.ADMINS,
      action: ACTIONS.CREATE,
      subResource: 'admin',
    });

    if (allowedDistricts.length === 0) {
      logger.error("Permission denied: user cannot create admins in requested districts", {
        requesterAdminUid,
        requestedDistricts,
      });
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
export const softDeleteUserExternalData = createSoftDeleteCloudFunction([
  "users",
  "externalData",
]);

export const createUsers = onCall(
  { memory: "2GiB", timeoutSeconds: 540 },
  async (request) => {
    const userData = request.data.userData;
    const requestingUid = request.auth!.uid;

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
    console.error("Error writing survey responses: ", error);
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
  return await _linkUsers(requestingUid, users);
});

export const getAdministrations = onCall(async (request) => {
  const adminUid = request.auth!.uid;

  const idsOnly = request.data.idsOnly ?? true;

  const restrictToOpenAdministrations =
    request.data.restrictToOpenAdministrations ?? false;

  const testData = request.data.testData ?? null;

  const roarUid = await getRoarUid({
    adminUid,
    fallBackToAdminUid: true,
  });

  if (!roarUid) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const administrations = await getAdministrationsForAdministrator({
    administratorRoarUid: roarUid,
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
  const orgData = request.data.orgData as OrgData;

  if (!requestingUid) {
    logger.error("User is not authenticated.");
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }

  if (!orgData || typeof orgData !== "object") {
    logger.error("Invalid orgData provided.", { orgData });
    throw new HttpsError(
      "invalid-argument",
      "Organization data is missing or invalid."
    );
  }

  // Ensure basic data like type is present before calling the internal function
  if (!orgData.type) {
    logger.error("Organization type is missing in orgData.", { orgData });
    throw new HttpsError("invalid-argument", "Organization type is required.");
  }

  try {
    const orgId = await _upsertOrg(requestingUid, orgData);
    logger.info("Organization successfully upserted.", {
      requestingUid,
      orgType: orgData.type,
      orgId,
    });
    return { status: "ok", orgId };
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
    // Check if user is a super admin
    const db = getFirestore();
    const userClaimsRef = db.collection("userClaims").doc(requestingUid);
    const userClaimsDoc = await userClaimsRef.get();

    if (!userClaimsDoc.exists) {
      logger.error("User claims not found.", { requestingUid });
      throw new HttpsError("permission-denied", "User permissions not found.");
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

export * from "./upsertAdministration";

export { completeTask } from "./tasks/completeTask";
export { startTask } from "./tasks/startTask";

export const syncOnRunDocUpdate = onDocumentWritten(
  {
    document: "users/{roarUid}/runs/{runId}",
  },
  syncOnRunDocUpdateEventHandler
);
