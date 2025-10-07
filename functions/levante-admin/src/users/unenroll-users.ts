import { getAuth, UserRecord } from "firebase-admin/auth";
import {
  DocumentData,
  DocumentReference,
  getFirestore,
  Transaction,
} from "firebase-admin/firestore";
import _union from "lodash-es/union";
import { User } from "./sort-users.js";
import { emptyOrgs } from "../utils/utils.js";
import { StudentDataInput } from "../interfaces.js";
import { logger } from "firebase-functions/v2";

/**
 * This function unenrolls a user from all of their current organizations and
 * archives the user.
 *
 * It adds a `to` date to all of their current organizations, ensures that their
 * `current` orgs are listed under `all` orgs, and finally empties their
 * `current` orgs. Lastly, it sets the `archived` flag to true.
 *
 * @param {object} input - An object containing input parameters.
 * @param {DocumentReference} input.userDocRef - The Firestore document reference for the user.
 * @param {Transaction} input.transaction - The Firestore transaction to use for this operation.
 * @param {DocumentData} [input.userDocData] - The Firestore document data for the user. Optional. If provided, the function will use this data instead of fetching it from Firestore.
 * @returns A Promise that resolves when the transaction is successfully completed.
 */
export const unenrollUser = async ({
  userDocRef,
  transaction,
  userDocData,
}: {
  userDocRef: DocumentReference;
  transaction: Transaction;
  userDocData?: DocumentData;
}) => {
  let userData: DocumentData;
  if (userDocData) {
    userData = userDocData;
  } else {
    userData = await transaction.get(userDocRef).then((docSnapshot) => {
      return docSnapshot.data() ?? {};
    });
  }

  logger.debug(`Unenrolling user at ${userDocRef.path}`);

  const unenrollDate = new Date();
  const {
    districts = emptyOrgs(),
    schools = emptyOrgs(),
    classes = emptyOrgs(),
    groups = emptyOrgs(),
    families = emptyOrgs(),
  } = userData;
  const orgs = { districts, schools, classes, groups, families };

  for (const orgKey of Object.keys(orgs)) {
    const currentOrgs = orgs[orgKey].current ?? [];
    orgs[orgKey].current = [];
    orgs[orgKey].all = _union(currentOrgs, orgs[orgKey].all ?? []);
    for (const orgId of currentOrgs) {
      if (orgs[orgKey].dates?.[orgId]) {
        orgs[orgKey].dates[orgId].to = unenrollDate;
      }
    }
  }

  logger.debug(`Unenrolled user at ${userDocRef.path} from all organizations`);
  return transaction.update(userDocRef, {
    ...orgs,
    archived: true,
  });
};

/**
 * This function unenrolls a user given their Firebase Admin SDK `UserRecord` object.
 *
 * It retrieves the user's unique identifier (UID) from the provided `userRecord` and
 * then updates the user's data in Firestore.
 *
 * @param {UserRecord} userRecord - The Firebase Admin SDK `UserRecord` object representing the user to be unenrolled.
 * @returns A Promise that resolves when the transaction is successfully completed.
 */
const unenrollUserFromUserRecord = async (userRecord: UserRecord) => {
  const db = getFirestore();
  const { uid: adminUid } = userRecord;

  const userClaimsDocRef = db.collection("userClaims").doc(adminUid);

  return db.runTransaction(async (transaction) => {
    const roarUid = await transaction
      .get(userClaimsDocRef)
      .then((docSnapshot) => {
        return docSnapshot.data()?.claims?.roarUid;
      });

    logger.debug(`Found ROAR UID for admin user ${adminUid}: ${roarUid}`);

    if (roarUid) {
      const userDocRef = db.collection("users").doc(roarUid);
      await unenrollUser({ userDocRef, transaction });
    }
  });
};

/**
 * This function unenrolls a user given an object containing their email address.
 *
 * It retrieves the user's Firestore document reference using their email
 * address and then updates the user's data in Firestore.
 *
 * @param {object} input - An object containing input parameters.
 * @param {StudentDataInput} input.userData - An object containing user data.
 * @param {string} [input.emailIdentifierKey="email"] - The key in the user's data that contains the email address.
 * @returns A Promise that resolves when the transaction is successfully completed.
 */
const unenrollUserFromUserData = async ({
  userData,
  emailIdentifierKey = "email",
}: {
  userData?: StudentDataInput;
  emailIdentifierKey: string;
}) => {
  const email = (userData ?? {})[emailIdentifierKey];

  logger.debug(`Unenrolling user with email ${email}`);

  if (!email) {
    throw new Error("User data does not contain an email address");
  }

  const db = getFirestore();
  return await db.runTransaction(async (transaction) => {
    const query = db.collection("users").where("email", "==", email);
    logger.debug(`Searching for user with email ${email}`);
    const userDocRef = await transaction
      .get(query)
      .then((snapshot) => {
        if (snapshot.empty) {
          logger.warn("User not found", { email });
          throw new Error("User not found");
        }

        if (snapshot.size > 1) {
          logger.warn("Multiple users found with the same email/username.", {
            email,
          });
          throw new Error("Multiple users found with the same email/username.");
        }

        return snapshot.docs[0].ref;
      })
      .catch(async (error) => {
        if (error.message === "User not found") {
          logger.debug(
            "User not found from user document query. Trying auth record instead."
          );
          const auth = getAuth();
          const userRecord = await auth.getUserByEmail(email);
          const userClaimsDocRef = db
            .collection("userClaims")
            .doc(userRecord.uid);
          const roarUid = await transaction
            .get(userClaimsDocRef)
            .then((docSnapshot) => {
              return docSnapshot.data()?.claims?.roarUid;
            });

          if (!roarUid) {
            throw new Error(
              `Could not find roarUid at ${userClaimsDocRef.path}`
            );
          }

          return db.collection("users").doc(roarUid);
        } else {
          throw error;
        }
      });

    logger.debug(`Found user with email ${email} at ${userDocRef.path}`, {
      userDocRef,
    });

    await unenrollUser({ userDocRef, transaction });
  });
};

/**
 * This function unenrolls users from a given list of Firebase Admin SDK `UserRecord` objects or user data.
 * It handles both cases where user records are provided and user data is provided.
 *
 * @param {object} input - An object containing input parameters.
 * @param {UserRecord[]} [input.userRecords=[]] - An array of Firebase Admin SDK `UserRecord` objects representing the users to be unenrolled.
 * @param {UserData[]} [input.userData=[]] - An array of objects containing user data.
 * @param {string} [input.emailIdentifierKey="email"] - The key in the user's data that contains the email address.
 * @returns {Promise<UnenrollUsersResult>} - A Promise that resolves to an array of PromiseSettledResult objects,
 * each representing the outcome of unenrolling a single user.
 */
export const unenrollUsers = async ({
  users = [],
  emailIdentifierKey = "email",
}: {
  users: User<StudentDataInput>[];
  emailIdentifierKey: string;
}): Promise<PromiseSettledResult<unknown>[]> => {
  return Promise.allSettled(
    users.map((user) => {
      if (user.authRecord) {
        return unenrollUserFromUserRecord(user.authRecord);
      } else {
        return unenrollUserFromUserData({
          userData: user.userData,
          emailIdentifierKey,
        });
      }
    })
  );
};
