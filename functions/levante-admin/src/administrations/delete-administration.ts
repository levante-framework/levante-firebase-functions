import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { FieldPath } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import _get from "lodash-es/get.js";
import _pick from "lodash-es/pick.js";
import type { IOrgsList } from "../interfaces.js";
import { ORG_NAMES } from "../interfaces.js";
import { processRemovedAdministration } from "./sync-administrations.js";

/**
 * Delete an administration and all its subcollections
 *
 * @param administrationId The administration ID to delete
 */
export const _deleteAdministration = async (administrationId: string) => {
  logger.info(`Starting deletion of administration: ${administrationId}`);

  const db = getFirestore();
  const administrationDocRef = db
    .collection("administrations")
    .doc(administrationId);

  const docSnap = await administrationDocRef.get();
  if (!docSnap.exists) {
    throw new Error(
      `Administration with ID ${administrationId} does not exist`
    );
  }

  const prevData = docSnap.data()!;
  const prevOrgs = _pick(prevData, ORG_NAMES) as IOrgsList;

  const createdBy = _get(prevData, "createdBy");
  if (createdBy) {
    const creatorDocRef = db.collection("users").doc(createdBy);
    await creatorDocRef.update(
      new FieldPath("adminData", "administrationsCreated"),
      FieldValue.arrayRemove(administrationId)
    );
  }

  await processRemovedAdministration(administrationId, prevOrgs);

  await db.runTransaction(async (transaction) => {
    // Define subcollections to delete
    const subcollections = ["stats", "assigningOrgs", "readOrgs"];

    // Delete all documents in each subcollection
    for (const subcollection of subcollections) {
      const subcollectionRef = db
        .collection("administrations")
        .doc(administrationId)
        .collection(subcollection);
      const subcollectionSnapshot = await subcollectionRef.get();

      subcollectionSnapshot.forEach((doc) => {
        if (doc.exists) {
          transaction.delete(doc.ref);
        }
      });
    }

    // Delete the main administration document
    transaction.delete(administrationDocRef);

    logger.info(`Successfully deleted administration: ${administrationId}`);
  });
};
