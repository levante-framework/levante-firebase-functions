import {
  getFirestore,
  FieldValue,
  Timestamp,
  type DocumentReference,
} from "firebase-admin/firestore";
import _pick from "lodash-es/pick.js";
import type { IAdministration } from "./interfaces.js";
import { ORG_NAMES } from "./interfaces.js";
import {
  processNewAdministration,
  processModifiedAdministration,
} from "./administrations/sync-administrations.js";
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
  creatorName: string;
  siteId: string;
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
  syncStatus?: "pending" | "complete" | "failed";
  syncChunksTotal?: number;
  syncChunksCompleted?: number;
  syncErrorMessage?: string;
  readOrgs?: IOrgsList;
  minimalOrgs?: IOrgsList;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  creatorName: string;
}

export const upsertAdministrationHandler = async (
  callerAdminUid: string,
  data: UpsertAdministrationData
) => {
  logger.info("Administration upsert started", { callerUid: callerAdminUid });
  const db = getFirestore();

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

  const sanitizeOrgIds = (ids: string[] | undefined): string[] =>
    (ids ?? []).filter((id) => typeof id === "string" && id.length > 0);

  const sanitizedOrgs: IOrgsList = {
    districts: sanitizeOrgIds(orgs.districts),
    schools: sanitizeOrgIds(orgs.schools),
    classes: sanitizeOrgIds(orgs.classes),
    groups: sanitizeOrgIds(orgs.groups),
  };

  let newAdministrationId: string | undefined;
  try {
    const result = await db.runTransaction(async (transaction) => {
      let administrationDocRef: DocumentReference;
      let operationType: "create" | "update";
      let prevData: IAdministration | undefined;

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
        prevData = _pick(existingDoc.data(), [
          ...ORG_NAMES,
          "createdBy",
          "assessments",
          "name",
          "publicName",
          "dateOpened",
          "dateClosed",
          "sequential",
          "tags",
          "legal",
          "testData",
          "readOrgs",
          "minimalOrgs",
        ]) as IAdministration;

        // Prepare data for update (merge: true will handle partial updates)
        const updateData: Partial<IAdministrationDoc> = {
          // Use Partial for updates
          name,
          publicName: publicName ?? name,
          normalizedName,
          syncStatus: "pending",
          // createdBy should not be updated
          groups: sanitizedOrgs.groups ?? [],
          classes: sanitizedOrgs.classes ?? [],
          schools: sanitizedOrgs.schools ?? [],
          districts: sanitizedOrgs.districts ?? [],
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
            districts: sanitizedOrgs.districts ?? [],
            schools: sanitizedOrgs.schools ?? [],
            classes: sanitizedOrgs.classes ?? [],
            groups: sanitizedOrgs.groups ?? [],
          },
          minimalOrgs: {
            districts: sanitizedOrgs.districts ?? [],
            schools: sanitizedOrgs.schools ?? [],
            classes: sanitizedOrgs.classes ?? [],
            groups: sanitizedOrgs.groups ?? [],
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

        const siteId = data.siteId;

        // Prepare Administration Data for creation
        const administrationData: IAdministrationDoc = {
          name,
          publicName: publicName ?? name,
          normalizedName,
          syncStatus: "pending",
          createdBy: callerAdminUid,
          creatorName: creatorName,
          groups: sanitizedOrgs.groups ?? [],
          classes: sanitizedOrgs.classes ?? [],
          schools: sanitizedOrgs.schools ?? [],
          districts: sanitizedOrgs.districts ?? [],
          dateCreated: FieldValue.serverTimestamp() as Timestamp,
          dateOpened: dateOpenedTs,
          dateClosed: dateClosedTs,
          assessments: assessments,
          sequential: sequential,
          tags: tags,
          legal: legal,
          testData: isTestData ?? false,
          readOrgs: sanitizedOrgs,
          minimalOrgs: sanitizedOrgs,
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
        prevData = undefined;
      }
      logger.info(`Successfully prepared administration ${operationType}`, {
        administrationId: administrationDocRef.id,
      });
      return { administrationId: administrationDocRef.id, prevData };
    });
    newAdministrationId = result.administrationId;
    const prevData = result.prevData;

    logger.info("Finished administration upsert transaction", {
      administrationId: newAdministrationId,
    });

    const administrationDocRef = db
      .collection("administrations")
      .doc(newAdministrationId);
    const adminDoc = await administrationDocRef.get();
    const currData = adminDoc.data() as IAdministration;

    if (prevData === undefined) {
      await processNewAdministration(
        newAdministrationId,
        administrationDocRef,
        currData
      );
    } else {
      await processModifiedAdministration(
        newAdministrationId,
        administrationDocRef,
        prevData,
        currData
      );
    }

    return { status: "ok", administrationId: newAdministrationId };
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error("Error during administration upsert", {
      error: err,
      message: err.message,
      stack: err.stack,
      administrationId: newAdministrationId,
    });
    if (newAdministrationId) {
      try {
        const adminRef = db
          .collection("administrations")
          .doc(newAdministrationId);
        await adminRef.update({
          syncStatus: "failed",
          syncErrorMessage: err.message,
          updatedAt: FieldValue.serverTimestamp(),
        });
      } catch (updateErr) {
        logger.error("Failed to update administration sync status to failed", {
          administrationId: newAdministrationId,
          updateError: updateErr,
        });
      }
    }
    if (error instanceof HttpsError) {
      throw error;
    }
    throw new HttpsError(
      "internal",
      `Failed to upsert administration: ${err.message}`
    );
  }
};
