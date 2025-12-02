import {
  getFirestore,
  FieldValue,
  Timestamp,
  type DocumentReference,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import type { Class, Group, School } from "../firestore-schema.js";
import type { IAssessment, IOrgsList, IAdministration } from "./interfaces.js"; // Assuming necessary types/helpers are in common
import { ORG_NAMES } from "./interfaces.js";
import { standardizeAdministrationOrgs } from "./administrations/administration-utils.js";
import { updateAssignmentsForOrgChunkHandler } from "./assignments/sync-assignments.js";
import _reduce from "lodash-es/reduce.js";
import _pick from "lodash-es/pick.js";
import _difference from "lodash-es/difference.js";
import _fromPairs from "lodash-es/fromPairs.js";
import _map from "lodash-es/map.js";
import {
  chunkOrgs,
  getOnlyExistingOrgs,
  getExhaustiveOrgs,
  getUsersFromOrgs,
} from "./orgs/org-utils.js";
import {
  removeOrgsFromAssignments,
  rollbackAssignmentCreation,
  rollbackAdministrationCreation,
} from "./assignments/assignment-utils.js";
import _chunk from "lodash-es/chunk.js";
import { MAX_TRANSACTIONS } from "./utils/utils.js";

interface UpsertAdministrationData {
  name: string;
  publicName?: string;
  normalizedName: string;
  assessments: IAssessment[]; // Use interface from common
  dateOpen: string; // Expect ISO string from client
  dateClose: string; // Expect ISO string from client
  sequential?: boolean;
  orgs?: IOrgsList; // Use interface from common
  tags?: string[];
  administrationId?: string; // For updating existing
  isTestData?: boolean;
  legal?: { [key: string]: unknown };
  creatorName: string;
}

interface IAdministrationDoc {
  name: string;
  publicName: string;
  normalizedName: string;
  createdBy: string;
  groups: string[];
  classes: string[];
  schools: string[];
  districts: string[];
  dateCreated: Timestamp;
  dateOpened: Timestamp;
  dateClosed: Timestamp;
  assessments: IAssessment[];
  sequential: boolean;
  tags: string[];
  legal?: { [key: string]: unknown };
  testData: boolean;
  siteId: string;
  readOrgs?: IOrgsList;
  minimalOrgs?: IOrgsList;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  creatorName: string;
}

const createAssignments = async (
  administrationId: string,
  administrationDocRef: DocumentReference,
  currData: IAdministration,
  creatorUid?: string,
  isNewAdministration: boolean = false
) => {
  const { minimalOrgs } = await standardizeAdministrationOrgs({
    administrationId,
    administrationDocRef,
    currData,
    copyToSubCollections: true,
    forceCopy: true,
  });

  const orgChunks = chunkOrgs(minimalOrgs, 100);
  const allCreatedUserIds: string[] = [];
  const processedChunks: Array<{ orgChunk: IOrgsList; userIds: string[] }> = [];

  try {
    for (let i = 0; i < orgChunks.length; i++) {
      const orgChunk = orgChunks[i];
      const result = await updateAssignmentsForOrgChunkHandler({
        administrationId,
        administrationData: currData,
        orgChunk,
        mode: "add",
      });

      if (!result.success) {
        // If this chunk failed, rollback all previous chunks
        logger.error(
          `Assignment creation failed for org chunk ${
            i + 1
          }. Rolling back all previous chunks.`,
          {
            administrationId,
            chunkIndex: i,
            error: result.error,
            totalChunksProcessed: processedChunks.length,
          }
        );

        // Rollback all previously created assignments
        if (allCreatedUserIds.length > 0) {
          await rollbackAssignmentCreation(allCreatedUserIds, administrationId);
        }

        // If this is a new administration, also rollback the administration document
        if (isNewAdministration && creatorUid) {
          await rollbackAdministrationCreation(administrationId, creatorUid);
        }

        throw new Error(
          `Failed to create assignment for all participants. ${
            result.error?.message || "Unknown error"
          }. Please try again.`
        );
      }

      // Track successful chunk
      allCreatedUserIds.push(...result.userIds);
      processedChunks.push({ orgChunk, userIds: result.userIds });
    }

    logger.info(`Successfully created assignments for all participants`, {
      administrationId,
      totalUsersAssigned: allCreatedUserIds.length,
      chunksProcessed: processedChunks.length,
      totalChunks: orgChunks.length,
    });
  } catch (error: any) {
    // If we get here, either a chunk failed or rollback failed
    // Try to rollback any remaining assignments
    if (allCreatedUserIds.length > 0) {
      try {
        await rollbackAssignmentCreation(allCreatedUserIds, administrationId);
      } catch (rollbackError: any) {
        logger.error("Error during final rollback of assignments", {
          rollbackError,
          administrationId,
          userIds: allCreatedUserIds,
        });
      }
    }

    // If this is a new administration, also rollback the administration document
    if (isNewAdministration && creatorUid) {
      try {
        await rollbackAdministrationCreation(administrationId, creatorUid);
      } catch (adminRollbackError: any) {
        logger.error("Error during final rollback of administration document", {
          adminRollbackError,
          administrationId,
          creatorUid,
        });
      }
    }

    // Re-throw the error so it can be caught by the handler
    throw error;
  }
};

const updateAssignments = async (
  administrationId: string,
  administrationDocRef: DocumentReference,
  prevData: IAdministration,
  currData: IAdministration
) => {
  const db = getFirestore();
  const prevOrgs: IOrgsList = _pick(prevData, ORG_NAMES);
  const currOrgs: IOrgsList = _pick(currData, ORG_NAMES);

  const removedOrgs = _fromPairs(
    _map(Object.entries(currOrgs), ([key, value]) => [
      key,
      _difference(prevOrgs[key], value),
    ])
  ) as IOrgsList;

  const numRemovedOrgs = _reduce(
    removedOrgs,
    (sum, value) => (value ? sum + value.length : sum),
    0
  );

  if (numRemovedOrgs > 0) {
    let remainingUsersToRemove: string[] = [];
    let removedExhaustiveOrgs: IOrgsList = {};

    await db.runTransaction(async (transaction) => {
      const removedExistingOrgs = await getOnlyExistingOrgs(
        removedOrgs,
        transaction
      );
      removedExhaustiveOrgs = await getExhaustiveOrgs({
        orgs: removedExistingOrgs,
        transaction,
        includeArchived: true,
      });
      const usersToRemove = await getUsersFromOrgs({
        orgs: removedExhaustiveOrgs,
        transaction,
        includeArchived: true,
      });

      if (usersToRemove.length !== 0) {
        if (usersToRemove.length <= MAX_TRANSACTIONS) {
          return removeOrgsFromAssignments(
            usersToRemove,
            [administrationId],
            removedExhaustiveOrgs,
            transaction
          );
        } else {
          remainingUsersToRemove = usersToRemove;
          return Promise.resolve(usersToRemove.length);
        }
      } else {
        return Promise.resolve(0);
      }
    });

    for (const _userChunk of _chunk(remainingUsersToRemove, MAX_TRANSACTIONS)) {
      await db.runTransaction(async (transaction) => {
        return removeOrgsFromAssignments(
          _userChunk,
          [administrationId],
          removedExhaustiveOrgs,
          transaction
        );
      });
    }
  }

  const { minimalOrgs } = await standardizeAdministrationOrgs({
    administrationId,
    administrationDocRef,
    currData,
    copyToSubCollections: true,
    forceCopy: true,
  });

  const orgChunks = chunkOrgs(minimalOrgs, 100);

  for (let i = 0; i < orgChunks.length; i++) {
    const orgChunk = orgChunks[i];
    const result = await updateAssignmentsForOrgChunkHandler({
      administrationId,
      administrationData: currData,
      orgChunk,
      mode: "update",
    });

    if (!result.success) {
      logger.error(`Assignment update failed for org chunk ${i + 1}.`, {
        administrationId,
        chunkIndex: i,
        error: result.error,
      });
      throw new Error(
        `Failed to update assignment for all participants. ${
          result.error?.message || "Unknown error"
        }. Please try again.`
      );
    }
  }

  logger.info(`Successfully updated assignments for all participants`, {
    administrationId,
    chunksProcessed: orgChunks.length,
  });
};

export const upsertAdministrationHandler = async (
  callerAdminUid: string,
  data: UpsertAdministrationData
) => {
  logger.info("Administration upsert started", { callerUid: callerAdminUid });
  const db = getFirestore();

  // 2. Authorization Check (Verify caller is an admin or super_admin via userClaims collection)
  try {
    logger.info(
      " *** Fetching userClaims document for authorization check ***"
    );
    console.log("callerAdminUid: ", callerAdminUid);
    const userClaimsDocRef = db.collection("userClaims").doc(callerAdminUid);
    const userClaimsDoc = await userClaimsDocRef.get();

    if (!userClaimsDoc.exists) {
      logger.warn(
        `userClaims document not found for user ${callerAdminUid}. Assuming not admin.`
      );
      throw new HttpsError(
        "permission-denied",
        "User claims not found. Cannot verify admin privileges."
      );
    }

    const claimsData = userClaimsDoc.data() || {};

    if (
      claimsData.claims.admin !== true &&
      claimsData.claims.super_admin !== true
    ) {
      logger.warn(
        `User ${callerAdminUid} is not an admin or super_admin based on userClaims doc. Claims: ${JSON.stringify(
          claimsData
        )}`
      );
      throw new HttpsError(
        "permission-denied",
        "Caller does not have admin privileges."
      );
    }

    logger.info(
      `User ${callerAdminUid} verified as admin/super_admin via userClaims doc.`
    );
  } catch (error: any) {
    logger.error("Authorization check failed using userClaims", {
      errorMessage: error.message,
      errorDetails: error.toString(),
      callerUid: callerAdminUid,
    });
    // If it's already an HttpsError, rethrow it
    if (error instanceof HttpsError) {
      throw error;
    }
    // Otherwise, wrap it in a generic internal error
    throw new HttpsError(
      "internal",
      "An error occurred during authorization check."
    );
  }

  // 3. Input Validation
  const {
    name,
    publicName,
    normalizedName,
    assessments,
    dateOpen,
    dateClose,
    sequential = true,
    orgs = {
      districts: [],
      schools: [],
      classes: [],
      groups: [],
    },
    tags = [],
    administrationId,
    isTestData = false,
    legal,
    creatorName,
  } = data as UpsertAdministrationData;

  // Debug logging for date values
  logger.info("Date validation debug", {
    dateOpen,
    dateClose,
    dateOpenType: typeof dateOpen,
    dateCloseType: typeof dateClose,
  });

  if (
    !name ||
    !assessments ||
    !Array.isArray(assessments) ||
    !dateOpen ||
    !dateClose
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Missing required fields: name, assessments, dateOpen, dateClose."
    );
  }

  let dateOpenedTs: Timestamp;
  let dateClosedTs: Timestamp;
  try {
    const dateOpenObj = new Date(dateOpen);
    const dateCloseObj = new Date(dateClose);

    dateOpenedTs = Timestamp.fromDate(dateOpenObj);
    dateClosedTs = Timestamp.fromDate(dateCloseObj);
  } catch (e: unknown) {
    throw new HttpsError(
      "invalid-argument",
      "Invalid date format for dateOpen or dateClose. Use ISO 8601 format."
    );
  }

  if (dateClosedTs.toMillis() < dateOpenedTs.toMillis()) {
    throw new HttpsError(
      "invalid-argument",
      `The end date cannot be before the start date: ${dateClose} < ${dateOpen}`
    );
  }

  // 5. Firestore Transaction
  try {
    let prevData: IAdministration | undefined;

    if (administrationId) {
      const prevDoc = await db
        .collection("administrations")
        .doc(administrationId)
        .get();
      if (prevDoc.exists) {
        prevData = prevDoc.data() as IAdministration;
      }
    }

    const newAdministrationId = await db.runTransaction(async (transaction) => {
      let administrationDocRef: DocumentReference;

      if (administrationId) {
        administrationDocRef = db
          .collection("administrations")
          .doc(administrationId);

        const existingDoc = await transaction.get(administrationDocRef);
        if (!existingDoc.exists) {
          throw new HttpsError(
            "not-found",
            `Administration with ID ${administrationId} not found for update.`
          );
        }

        // Prepare data for update (merge: true will handle partial updates)
        const updateData: Partial<IAdministrationDoc> = {
          // Use Partial for updates
          name,
          publicName: publicName ?? name,
          normalizedName,
          // createdBy should not be updated
          groups: orgs.groups ?? [],
          classes: orgs.classes ?? [],
          schools: orgs.schools ?? [],
          districts: orgs.districts ?? [],
          // dateCreated should not be updated
          dateOpened: dateOpenedTs,
          dateClosed: dateClosedTs,
          assessments: assessments,
          sequential: sequential,
          tags: tags,
          legal: legal,
          testData: isTestData ?? false,
          // Explicitly construct org lists for update
          readOrgs: {
            // Re-enabled
            districts: orgs.districts ?? [],
            schools: orgs.schools ?? [],
            classes: orgs.classes ?? [],
            groups: orgs.groups ?? [],
          },
          minimalOrgs: {
            // Re-enabled
            districts: orgs.districts ?? [],
            schools: orgs.schools ?? [],
            classes: orgs.classes ?? [],
            groups: orgs.groups ?? [],
          },
          updatedAt: FieldValue.serverTimestamp() as Timestamp,
        };

        // --- Write 1 (Update Path) --- Update administration doc using transaction.update()
        transaction.update(administrationDocRef, updateData); // Switched from set with merge to update
      } else {
        // --- Create Path ---
        administrationDocRef = db.collection("administrations").doc();

        // --- Read 1 (Create Path) --- Check if user doc exists BEFORE any writes
        const userDocRef = db.collection("users").doc(callerAdminUid);
        const userDoc = await transaction.get(userDocRef);

        let siteId = orgs.districts?.[0];

        if (!siteId) {
          const groupId = orgs.groups?.[0];
          const classId = orgs.classes?.[0];
          const schoolId = orgs.schools?.[0];

          if (groupId) {
            const groupDocRef = db.collection("groups").doc(groupId);
            const groupDoc = await transaction.get(groupDocRef);
            if (!groupDoc.exists) {
              throw new HttpsError(
                "invalid-argument",
                `Group ${groupId} not found while resolving siteId.`
              );
            }

            const groupData = groupDoc.data() as Group | undefined;
            if (!groupData?.parentOrgId) {
              throw new HttpsError(
                "invalid-argument",
                `Group ${groupId} is missing a parentOrgId.`
              );
            }

            siteId = groupData.parentOrgId;
          } else if (classId) {
            const classDocRef = db.collection("classes").doc(classId);
            const classDoc = await transaction.get(classDocRef);
            if (!classDoc.exists) {
              throw new HttpsError(
                "invalid-argument",
                `Class ${classId} not found while resolving siteId.`
              );
            }

            const classData = classDoc.data() as Class | undefined;
            if (!classData?.districtId) {
              throw new HttpsError(
                "invalid-argument",
                `Class ${classId} is missing a districtId.`
              );
            }

            siteId = classData.districtId;
          } else if (schoolId) {
            const schoolDocRef = db.collection("schools").doc(schoolId);
            const schoolDoc = await transaction.get(schoolDocRef);
            if (!schoolDoc.exists) {
              throw new HttpsError(
                "invalid-argument",
                `School ${schoolId} not found while resolving siteId.`
              );
            }

            const schoolData = schoolDoc.data() as School | undefined;
            if (!schoolData?.districtId) {
              throw new HttpsError(
                "invalid-argument",
                `School ${schoolId} is missing a districtId.`
              );
            }

            siteId = schoolData.districtId;
          }
        }

        if (!siteId) {
          throw new HttpsError(
            "invalid-argument",
            "Unable to determine siteId. Provide a district or an organization associated with a district."
          );
        }

        // Prepare Administration Data for creation
        const administrationData: IAdministrationDoc = {
          name,
          publicName: publicName ?? name,
          normalizedName,
          createdBy: callerAdminUid,
          creatorName: creatorName,
          groups: orgs.groups ?? [],
          classes: orgs.classes ?? [],
          schools: orgs.schools ?? [],
          districts: orgs.districts ?? [],
          dateCreated: FieldValue.serverTimestamp() as Timestamp,
          dateOpened: dateOpenedTs,
          dateClosed: dateClosedTs,
          assessments: assessments,
          sequential: sequential,
          tags: tags,
          legal: legal,
          testData: isTestData ?? false,
          readOrgs: orgs,
          minimalOrgs: orgs,
          siteId,
          createdAt: FieldValue.serverTimestamp() as Timestamp,
          updatedAt: FieldValue.serverTimestamp() as Timestamp,
        };

        // --- Write 1 (Create Path) --- Create administration doc
        transaction.set(administrationDocRef, administrationData); // Use set without merge for creation

        if (userDoc.exists) {
          // --- Write 2 (Create Path) --- Update user if they exist
          transaction.update(userDocRef, {
            "adminData.administrationsCreated": FieldValue.arrayUnion(
              administrationDocRef.id
            ),
          });
        } else {
          // Log if user doc doesn't exist, but don't throw error
          logger.warn(
            `User document ${callerAdminUid} not found. Cannot add administration ${administrationDocRef.id} to created list.`
          );
        }
      }
      logger.info("Successfully prepared administration", {
        administrationId: administrationDocRef.id,
        operationType: administrationId ? "update" : "create",
      });
      return administrationDocRef.id; // Return the ID
    }); // End Transaction

    logger.info("Finished administration upsert transaction", {
      administrationId: newAdministrationId,
    });

    // Sync assignments synchronously for immediate visibility
    try {
      const administrationDocRef = db
        .collection("administrations")
        .doc(newAdministrationId);
      const administrationDoc = await administrationDocRef.get();

      if (!administrationDoc.exists) {
        logger.warn(
          `Administration ${newAdministrationId} not found after creation. Skipping sync.`
        );
        return { status: "ok", administrationId: newAdministrationId };
      }

      const administrationData = administrationDoc.data() as IAdministration;
      const isNewAdministration = !administrationId;
      const creatorUid = administrationData?.createdBy;

      if (isNewAdministration) {
        if (!creatorUid) {
          logger.error(
            `Cannot sync assignments: administration ${newAdministrationId} has no createdBy field`,
            { administrationId: newAdministrationId }
          );
          throw new HttpsError(
            "internal",
            "Administration document is missing creator information"
          );
        }
        await createAssignments(
          newAdministrationId,
          administrationDocRef,
          administrationData,
          creatorUid,
          true
        );
      } else if (prevData) {
        await updateAssignments(
          newAdministrationId,
          administrationDocRef,
          prevData,
          administrationData
        );
      } else {
        if (!creatorUid) {
          logger.error(
            `Cannot sync assignments: administration ${newAdministrationId} has no createdBy field`,
            { administrationId: newAdministrationId }
          );
          throw new HttpsError(
            "internal",
            "Administration document is missing creator information"
          );
        }
        await createAssignments(
          newAdministrationId,
          administrationDocRef,
          administrationData,
          creatorUid,
          true
        );
      }

      logger.info("Finished synchronous assignment sync", {
        administrationId: newAdministrationId,
      });
    } catch (syncError: any) {
      logger.error("Error during synchronous assignment sync", {
        error: syncError,
        administrationId: newAdministrationId,
      });

      // If this is a new administration and sync failed, the error was already thrown
      // and should have triggered rollback. Re-throw to prevent the function from
      // returning successfully when assignments failed to be created.
      const isNewAdministration = !administrationId;
      if (isNewAdministration) {
        throw syncError;
      }
    }

    return { status: "ok", administrationId: newAdministrationId };
  } catch (error: any) {
    logger.error("Error during administration upsert", { error });
    if (error instanceof HttpsError) {
      throw error; // Re-throw HttpsError
    }
    throw new HttpsError(
      "internal",
      `Failed to upsert administration: ${error.message}`
    );
  }
};
