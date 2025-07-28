import { EmailIdentifier, getAuth, UserRecord } from "firebase-admin/auth";
import { boolean } from "boolean";
import _chunk from "lodash/chunk";
import _concat from "lodash/concat";
import { StudentDataInput } from "../interfaces";

export interface User<T> {
  userData: T;
  authRecord: UserRecord | null;
}

interface CategorizeUsersResult<T> {
  create: User<T>[];
  update: User<T>[];
  unenroll: User<T>[];
}

/**
 * Categorizes a list of users into four groups: new users to be created, existing users to be updated,
 * existing users to be unenrolled, and users with an error condition.
 *
 * @param {object} input - An object containing input parameters.
 * @param {StudentDataInput[]} input.users - An array of user objects, where each object has a unique identifier and other properties.
 * @param {string} input.emailIdentifierKey - The key in each user object that represents the user's email.
 * @param {string} input.unenrollmentKey - The key in each user object that indicates whether the user should be unenrolled.
 *
 * @returns An object containing four arrays, where each is a subset of the input users array:
 * - `create`: Users who are not found in the Firebase authentication system and should be created.
 * - `update`: Existing users who should be updated in the Firebase authentication system.
 * - `unenroll`: Existing users who should be unenrolled from the Firebase authentication system.
 * - `unenrollRequestedButUserNotActivated`: Users who are not found in the Firebase authentication system but who have been flagged for unenrollment.
 * and an object containing `UserRecord` arrays for users to be updated and unenrolled.
 */
export const categorizeUsers = async ({
  users = [],
  emailIdentifierKey = "email",
  unenrollmentKey = "unenroll",
}: {
  users: StudentDataInput[];
  emailIdentifierKey: string;
  unenrollmentKey: string;
}): Promise<CategorizeUsersResult<StudentDataInput>> => {
  const auth = getAuth();

  const userIdentifiers = users.map((user) => ({
    email: user[emailIdentifierKey],
  })) as EmailIdentifier[];
  const identifierChunks = _chunk(userIdentifiers, 100);
  const userResultPromises = identifierChunks.map((chunk) =>
    auth.getUsers(chunk)
  );

  // This is an array of GetUsersResult objects, each of which contains a key
  // 'users' with an array of UserRecord objects and a key 'notFound' with an
  // array of UserIdentifier for users that were not found.
  const userResults = await Promise.all(userResultPromises);

  // Combine the results into a single object with 'users' and 'notFound' keys.
  const combined = userResults.reduce(
    (acc, { users: usersChunk, notFound: notFoundChunk }) => {
      acc.users.push(...usersChunk);
      acc.notFound.push(...notFoundChunk);
      return acc;
    },
    { users: [], notFound: [] }
  );

  const foundEmails = combined.users.map((user) => user.email?.toLowerCase());

  combined.notFound = combined.notFound.filter((userIdentifier) => {
    const email = (userIdentifier as EmailIdentifier).email.toLowerCase();
    return !foundEmails.includes(email);
  });

  // Extract arrays of just the identifiers.
  const notFoundIdentifiers = combined.notFound.map((userIdentifier) =>
    (userIdentifier as EmailIdentifier).email.toLowerCase()
  );
  const foundIdentifiers = combined.users.map((user) =>
    user.email?.toLowerCase()
  );

  // Filter new and existing users.
  const newUsers = users.filter((user) => {
    const email = (user[emailIdentifierKey] as string).toLowerCase();
    return notFoundIdentifiers.includes(email);
  });

  const existingUsers = users.filter((user) => {
    const email = (user[emailIdentifierKey] as string).toLowerCase();
    return foundIdentifiers.includes(email);
  });

  // Create arrays that are subsets of the input users array.
  const userData = {
    unenroll: existingUsers.filter((user) => boolean(user[unenrollmentKey])),
    update: existingUsers.filter((user) => !boolean(user[unenrollmentKey])),
    create: newUsers.filter((user) => !boolean(user[unenrollmentKey])),
    unenrollUnactivated: newUsers.filter((user) =>
      boolean(user[unenrollmentKey])
    ),
  };

  // Also create userRecord subsets for the update and unenroll subsets.
  const userRecords = {
    unenroll: combined.users.filter((userRecord) => {
      const email = userRecord.email?.toLowerCase;
      const inputUser = users.find(
        (user) => user[emailIdentifierKey].toLowerCase() === email
      );
      return boolean(inputUser?.[unenrollmentKey]);
    }),
    update: combined.users.filter((userRecord) => {
      const email = userRecord.email?.toLowerCase();
      const inputUser = users.find(
        (user) => user[emailIdentifierKey].toLowerCase() === email
      );
      return !boolean(inputUser?.[unenrollmentKey]);
    }),
  };

  const create = userData.create.map((user) => ({
    userData: user,
    authRecord: null,
  }));

  const update = userData.update.map((user) => {
    const email = user.email?.toLowerCase();
    const authRecord =
      userRecords.update.find(
        (record) => record.email?.toLowerCase() === email
      ) ?? null;
    return {
      userData: user,
      authRecord,
    };
  });

  const unenroll = _concat(userData.unenroll, userData.unenrollUnactivated).map(
    (user) => {
      const email = user.email?.toLowerCase();
      const authRecord =
        userRecords.unenroll.find(
          (record) => record.email?.toLowerCase() === email
        ) ?? null;
      return {
        userData: user,
        authRecord,
      };
    }
  );

  return {
    create,
    update,
    unenroll,
  };
};
