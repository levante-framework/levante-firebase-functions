import {
  getFirestore,
  FieldValue,
  Timestamp,
  type DocumentReference,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import type { IAssessment, IOrgsList } from "./interfaces.js"; // Assuming necessary types/helpers are in common

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
  readOrgs?: IOrgsList;
  minimalOrgs?: IOrgsList;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

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
    const newAdministrationId = await db.runTransaction(async (transaction) => {
      let administrationDocRef: DocumentReference;
      let operationType: string; // To log 'create' or 'update'

      if (administrationId) {
        operationType = "update";
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
        operationType = "create";
        administrationDocRef = db.collection("administrations").doc();

        // --- Read 1 (Create Path) --- Check if user doc exists BEFORE any writes
        const userDocRef = db.collection("users").doc(callerAdminUid);
        const userDoc = await transaction.get(userDocRef);

        // Prepare Administration Data for creation
        const administrationData: IAdministrationDoc = {
          name,
          publicName: publicName ?? name,
          normalizedName,
          createdBy: callerAdminUid,
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
      logger.info(`Successfully prepared administration ${operationType}`, {
        administrationId: administrationDocRef.id,
      });
      return administrationDocRef.id; // Return the ID
    }); // End Transaction

    logger.info("Finished administration upsert transaction", {
      administrationId: newAdministrationId,
    });
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
