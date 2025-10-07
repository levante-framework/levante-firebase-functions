import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import _pick from "lodash-es/pick.js";
import { ORG_NAMES } from "../interfaces.js";

/**
 * Deletes a user from the database and Firebase Auth.
 *
 * @param {Object} params - An object containing the requester's and target's Roar UIDs.
 * @param {string} params.requesterRoarUid - The Roar UID of the user requesting the deletion.
 * @param {string} params.targetRoarUid - The Roar UID of the user to be deleted.
 * @returns {Promise<void>} - A promise that resolves when the user is successfully deleted.
 * @throws {HttpsError} - If the requester is not authorized to delete users.
 */
export const deleteUser = async ({
  requesterRoarUid,
  targetRoarUid,
}: {
  requesterRoarUid: string;
  targetRoarUid: string;
}) => {
  const db = getFirestore();

  const auth = getAuth();

  const requesterClaimsDocRef = db
    .collection("userClaims")
    .doc(requesterRoarUid);
  const requesterClaims = await requesterClaimsDocRef.get().then((docSnap) => {
    return docSnap.data()?.claims ?? null;
  });

  if (!requesterClaims?.super_admin) {
    throw new HttpsError(
      "permission-denied",
      "The requesting user in not authorized to delete users."
    );
  }

  const promises: Promise<unknown>[] = [];

  const userRef = db.collection("users").doc(targetRoarUid);
  const userClaimsRef = db.collection("userClaims").doc(targetRoarUid);

  promises.push(
    db.recursiveDelete(userRef).then(() => {
      logger.debug(`Deleted user ${targetRoarUid} from database.`);
    })
  );
  promises.push(
    db.recursiveDelete(userClaimsRef).then(() => {
      logger.debug(`Deleted user claims ${targetRoarUid} from database.`);
    })
  );
  promises.push(
    auth.deleteUser(targetRoarUid).then(() => {
      logger.debug(`Deleted user ${targetRoarUid} from auth.`);
    })
  );
  await Promise.all(promises);
};

/**
 * Removes an organization from a user's list of organizations.
 *
 * @param {Object} params - An object containing the requester's and target's Roar UIDs, as well as the organization type and ID.
 * @param {string} params.requesterRoarUid - The Roar UID of the user requesting the removal.
 * @param {string} params.targetRoarUid - The Roar UID of the user whose organization is to be removed.
 * @param {string} params.orgType - The type of the organization to be removed.
 * @param {string} params.orgId - The ID of the organization to be removed.
 * @returns {Promise<void>} - A promise that resolves when the organization is successfully removed.
 * @throws {HttpsError} - If the requester is not authorized to remove organizations from users.
 */
export const removeOrgFromUser = async ({
  requesterRoarUid,
  targetRoarUid,
  orgType,
  orgId,
}: {
  requesterRoarUid: string;
  targetRoarUid: string;
  orgType: string;
  orgId: string;
}) => {
  const db = getFirestore();

  const requesterClaimsDocRef = db
    .collection("userClaims")
    .doc(requesterRoarUid);
  const requesterClaims = await requesterClaimsDocRef.get().then((docSnap) => {
    return docSnap.data()?.claims ?? null;
  });

  if (!requesterClaims?.super_admin) {
    throw new HttpsError(
      "permission-denied",
      "The requesting user in not authorized to remove orgs from users."
    );
  }

  await db.runTransaction(async (transaction) => {
    const userDocRef = db.collection("users").doc(targetRoarUid);
    const userDocSnap = await transaction.get(userDocRef);
    if (userDocSnap.exists) {
      const allOrgs = _pick(userDocSnap.data(), ORG_NAMES);
      logger.debug(`Removing orgs from users/${targetRoarUid}`, {
        requesterRoarUid,
        targetRoarUid,
        allOrgs,
        orgToRemove: `${orgType}/${orgId}`,
      });
      // TODO: If the orgs are empty after removing this one, delete the user
      // Otherwise, just update the orgs with this one removed
    } else {
      throw new Error(`User ${targetRoarUid} does not exist in the database.`);
    }
  });
};
