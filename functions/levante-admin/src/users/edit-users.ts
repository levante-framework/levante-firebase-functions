import { getAuth } from "firebase-admin/auth";
import { logger } from "firebase-functions/v2";
import { HttpsError } from "firebase-functions/v2/https";
import _set from "lodash-es/set";
import _isEmpty from "lodash-es/isEmpty";

/**
 * Update the userRecord for a user in the both the admin and assessment apps.
 *
 * @param {object} params - Input parameters
 * @param {string} params.adminUid - The uid of the user in the admin app
 * @param {string} params.newEmail - The new email for the user
 * @param {string} params.newPassword - The new password for the user
 */
export const updateUserRecordHandler = async ({
  adminUid,
  newPassword,
  newEmail,
}: {
  adminUid: string;
  newPassword?: string;
  newEmail?: string;
}): Promise<{ status: string }> => {
  const auth = getAuth();

  logger.info(`Updating user record for user ${adminUid}`);

  if (!newPassword && !newEmail) {
    throw new HttpsError(
      "invalid-argument",
      `updateUserRecord called for user ${adminUid} without email or password parameters.`
    );
  }

  const userRecordUpdates = {};
  if (newEmail) {
    _set(userRecordUpdates, "email", newEmail);
  }
  if (newPassword) {
    _set(userRecordUpdates, "password", newPassword);
  }

  if (!_isEmpty(userRecordUpdates)) {
    return await auth
      .updateUser(adminUid, userRecordUpdates)
      .then(async (postUserRecord) => {
        return { status: "ok" };
      })
      .catch((error) => {
        logger.error(error);
        throw new HttpsError(
          "internal",
          `Error updating user record in Admin Database for user ${adminUid}: ${error}`
        );
      });
  }

  return { status: "no-updates" };
};
