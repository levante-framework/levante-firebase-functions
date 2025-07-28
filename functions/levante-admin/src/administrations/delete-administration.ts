import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";

/**
 * Delete an administration and all its subcollections
 *
 * @param administrationId The administration ID to delete
 */
export const _deleteAdministration = async (administrationId: string) => {
  logger.info(`Starting deletion of administration: ${administrationId}`);

  const db = getFirestore();

  await db.runTransaction(async (transaction) => {
    const administrationDocRef = db
      .collection("administrations")
      .doc(administrationId);

    // Get the administration document first to check if it exists
    const docSnap = await transaction.get(administrationDocRef);
    if (!docSnap.exists) {
      throw new Error(
        `Administration with ID ${administrationId} does not exist`
      );
    }

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
