import { UserRecord } from "firebase-admin/auth";
import type { User } from "./sort-users.js";
import { getAuth } from "firebase-admin/auth";
import { logger } from "firebase-functions/v2";
import type { FieldPathsAndValues, StudentDataInput } from "../interfaces.js";
import { delay, pluralizeFirestoreCollection } from "../utils/utils.js";
import { getFirestore } from "firebase-admin/firestore";
import type {
  DocumentReference,
  FieldPath,
  Transaction,
} from "firebase-admin/firestore";
import _flatten from "lodash-es/flatten.js";
import _get from "lodash-es/get.js";
import _intersection from "lodash-es/intersection.js";
import _set from "lodash-es/set.js";
import _isEmpty from "lodash-es/isEmpty.js";
import _omit from "lodash-es/omit.js";
import _union from "lodash-es/union.js";

const userRecordFields = ["name", "password"];

/**
 * This function updates a user's data. If the password field is provided, this function with update the user's record.
 *
 * @param {object} input - An object containing input parameters.
 * @param {DocumentReference} input.userDocRef - A reference to the Firestore document representing the user.
 * @param {object} input.updateRequest - Object containing the keys AuthRecord and UserData. UserData is used to update the user's document.
 * @param {Transaction} input.transaction - Transaction to use for this operation.
 * @returns The transaction, after adding several update events.
 */
export const updateUser = async ({
  userDocRef,
  updateRequest,
  transaction,
}: {
  userDocRef: DocumentReference;
  updateRequest: User<StudentDataInput>;
  transaction: Transaction;
}) => {
  const auth = getAuth();
  const db = getFirestore();

  const updateUserData = updateRequest.userData;
  // Construct an object with userRecord updates. If it's empty, skip record updates.
  const updateRecord = {};
  for (const field of userRecordFields) {
    if (updateUserData[field]) {
      _set(updateRecord, field, updateUserData[field]);
    }

    if (field === "name" && updateUserData[field]) {
      const computedName = `${_get(updateUserData.name, "first", "")} ${_get(
        updateUserData.name,
        "last",
        ""
      )}`;
      _set(updateRecord, "displayName", computedName);
    }
  }

  if (!_isEmpty(updateRecord)) {
    // Update user's record with the updateRecord object.
    const uid = userDocRef.id;

    await auth.updateUser(uid, updateRecord).catch((error) => {
      logger.error(
        `Error updating admin user record for user ${uid}: ${error}`
      );
    });
  }

  // Update the user's admin document with the updateRequest fields.
  const orgIds = _get(updateUserData, "orgIds", {});
  let adminUserUpdates = _omit(updateUserData, [
    "password",
    "orgIds",
    "districts",
    "schools",
    "classes",
    "groups",
    "families",
  ]);

  if (updateRequest.userData.email) {
    _set(adminUserUpdates, "email", updateRequest.userData.email);
  } else if (updateRequest.authRecord?.email) {
    _set(adminUserUpdates, "email", updateRequest.authRecord?.email);
  }

  // If there are orgIds included, add them to the object to update the admin document.
  if (!_isEmpty(orgIds)) {
    const existingUserData = await transaction
      .get(userDocRef)
      .then((docSnapshot) => {
        return docSnapshot.data() ?? {};
      });
    const orgs = constructOrgs(orgIds, existingUserData);
    for (const [orgKey, orgValue] of Object.entries(orgs)) {
      adminUserUpdates = _set(adminUserUpdates, orgKey, orgValue);
    }
  }
  logger.log("Total updates to be set:", adminUserUpdates);
  if (!_isEmpty(adminUserUpdates)) {
    // Typescript is unhappy with the conversion to FieldPathsAndValues because
    // it is expecting at least one element in the array.  We know that we will
    // fill in the elements next so we first cast to unknown and then to
    // FieldPathsAndValues.
    const fieldPathsAndValues = [] as unknown as FieldPathsAndValues;

    for (const [key, value] of Object.entries(adminUserUpdates)) {
      if (key === "studentData") {
        for (const [sdKey, sdValue] of Object.entries(value!)) {
          if (sdKey === "dob") {
            const jsDate = new Date(sdValue as string);
            fieldPathsAndValues.push(
              new FieldPath("studentData", sdKey),
              jsDate
            );
          } else {
            fieldPathsAndValues.push(
              new FieldPath("studentData", sdKey),
              sdValue
            );
          }
        }
      } else {
        fieldPathsAndValues.push(new FieldPath(key), value);
      }
    }

    const [firstPath, firstValue, ...rest] = fieldPathsAndValues;
    transaction.update(userDocRef, firstPath, firstValue, ...rest);
  }
};

/**
 * This function updates a user given their Firebase Admin SDK `UserRecord` object.
 *
 * It retrieves the user's unique identifier (UID) from the provided `userRecord` and
 * then updates the user's data in Firestore.
 *
 * @param {UserRecord} userRecord - The Firebase Admin SDK `UserRecord` object representing the user to be updated.
 * @returns A Promise that resolves when the transaction is successfully completed.
 */
const updateUserFromUserRecord = async (
  userRecord: UserRecord,
  user: User<StudentDataInput>
) => {
  const db = getFirestore();
  const { uid: adminUid } = userRecord;

  const userClaimsDocRef = db.collection("userClaims").doc(adminUid);

  return db.runTransaction(
    async (transaction) => {
      const roarUid = await transaction
        .get(userClaimsDocRef)
        .then((docSnapshot) => {
          return docSnapshot.data()?.claims?.roarUid;
        });

      if (roarUid) {
        logger.info(
          `roarUid found for user ${userRecord.email}. Updating docs.`
        );
        const userDocRef = db.collection("users").doc(roarUid);
        await updateUser({ userDocRef, updateRequest: user, transaction });
      } else {
        logger.info(
          `No roarUid found for user ${userRecord.email}. Creating new docs.`
        );
      }
    },
    {
      maxAttempts: 3,
    }
  );
};

/**
 * This function updates a user given an object containing their email address.
 *
 * It retrieves the user's Firestore document reference using their email
 * address and then updates the user's data in Firestore.
 *
 * @param {object} input - An object containing input parameters.
 * @param {UserData} input.userData - An object containing user data.
 * @param {string} [input.emailIdentifierKey="email"] - The key in the user's data that contains the email address.
 * @returns A Promise that resolves when the transaction is successfully completed.
 */
const updateUserFromUserData = async ({
  user,
  emailIdentifierKey = "email",
}: {
  user: User<StudentDataInput>;
  emailIdentifierKey: string;
}) => {
  const email = user.userData[emailIdentifierKey];
  if (email) {
    const db = getFirestore();
    return db.runTransaction(
      async (transaction) => {
        const query = db.collection("users").where("email", "==", email);
        const userDocRef = await transaction.get(query).then((snapshot) => {
          if (snapshot.empty) {
            throw new Error("User not found");
          }

          if (snapshot.size > 1) {
            throw new Error(
              "Multiple users found with the same email/username."
            );
          }

          return snapshot.docs[0].ref;
        });

        await updateUser({ userDocRef, updateRequest: user, transaction });
      },
      { maxAttempts: 3 }
    );
  } else {
    throw new Error("User data does not contain an email address");
  }
};

/**
 * This function updates user documents and user records.
 * It handles writing to the user record in the case that email, password, or names are provided.
 * It also handles writing and merging to the user documment in both firestores in the case that other information is provided.
 *
 * @param {object} input - An object containing input parameters.
 * @param {UserData[]} [input.users=[]] - An array of objects containing user data.
 * @param {string} [input.emailIdentifierKey="email"] - The key in the user's data that contains the email address.
 * @returns {Promise<UnenrollUsersResult>} - A Promise that resolves to an array of PromiseSettledResult objects,
 * each representing the outcome of unenrolling a single user.
 */
export const updateUsers = async ({
  users = [],
  emailIdentifierKey = "email",
}: {
  users: User<StudentDataInput>[];
  emailIdentifierKey: string;
}): Promise<PromiseSettledResult<unknown>[]> => {
  const promises: Promise<void>[] = [];

  for (const user of users) {
    if (user.authRecord) {
      logger.info(`Updating user ${user.authRecord.email} from auth record`);
      if (_intersection(userRecordFields, Object.keys(user.userData))) {
        await delay(600);
      }
      promises.push(updateUserFromUserRecord(user.authRecord, user));
    } else {
      logger.info(
        `Updating user ${user.userData[emailIdentifierKey]} from user data`
      );
      if (_intersection(userRecordFields, Object.keys(user.userData))) {
        await delay(600);
      }
      promises.push(
        updateUserFromUserData({
          user,
          emailIdentifierKey,
        })
      );
    }
  }

  return Promise.allSettled(promises);
};

/**
 * This function constructs organization objects for a user based on provided organization IDs.
 *
 * @param allOrgIds - An object containing new organization IDs.
 * @returns {object} - An object containing complete organization objects
 */
const constructOrgs = (allOrgIds, existingUserData) => {
  const dateNow = new Date();
  let orgs = {};

  const orgTypes = ["district", "school", "class", "group", "family"];
  for (const orgType of orgTypes) {
    const orgIds = _get(allOrgIds, pluralizeFirestoreCollection(orgType));
    if (!_isEmpty(orgIds)) {
      const currentOrgs = _get(
        existingUserData,
        `${pluralizeFirestoreCollection(orgType)}.current`,
        []
      );
      currentOrgs.forEach((currentOrgId) => {
        if (!orgIds.includes(currentOrgId)) {
          _set(
            existingUserData,
            `${pluralizeFirestoreCollection(orgType)}.dates.${currentOrgId}.to`,
            dateNow
          );
        }
      });

      const orgDates = {};
      orgIds.forEach((orgId) => {
        orgDates[orgId] = {
          from: dateNow,
          to: null,
        };
      });

      _set(orgs, pluralizeFirestoreCollection(orgType), {
        current: orgIds,
        all: _union(
          orgIds,
          _get(
            existingUserData,
            `${pluralizeFirestoreCollection(orgType)}.current`,
            []
          )
        ),
        dates: {
          ...orgDates,
          ..._get(
            existingUserData,
            `${pluralizeFirestoreCollection(orgType)}.dates`,
            {}
          ),
        },
      });
    }
  }

  return orgs;
};
