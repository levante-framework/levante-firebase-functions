import { getAuth, type UserImportResult, type Auth } from "firebase-admin/auth";
import {
  getFirestore,
  FieldPath,
  type DocumentReference,
  type WriteResult,
} from "firebase-admin/firestore";
import _get from "lodash-es/get";
import _head from "lodash-es/head";
import _split from "lodash-es/split";
import _set from "lodash-es/set";
import _isEmpty from "lodash-es/isEmpty";
import _includes from "lodash-es/includes";
import _chunk from "lodash-es/chunk";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import bcrypt from "bcrypt";
import { isEmulated } from "../utils/utils.js";
import { ROLES } from "../utils/constants.js";

interface InputUser {
  userType: string;
  childId?: string;
  parentId?: string;
  teacherId?: string;
  month: string;
  year: string;
  orgIds: {
    districts: string[];
    schools: string[];
    classes: string[];
    groups: string[];
    families: string[];
  };
  isTestData: boolean;
}

type ClassData = {
  districtId: string;
  schoolId: string;
};

type Claims = {
  roarUid: string;
  adminUid: string;
  assessmentUid: string;
};

interface BaseAuthUserData {
  uid: string;
  email: string;
  displayName: string;
  emailVerified: boolean;
  disabled: boolean;
  passwordHash?: Buffer;
  password?: string;
  fromCSV: InputUser;
  customClaims: {
    claims: Claims;
    roles: { siteId: string; role: string }[];
  };
  username?: string;
}

type AdminAuthUserData = BaseAuthUserData;

interface ReturnUserData {
  uid: string;
  email: string;
  password: string;
  username?: string;
}

function generateRandomString(length = 10) {
  let result = "";
  const characters = "abcdefghijklmnopqrstuvwxyz0123456789";
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

function generateEmail(emailDomain: string) {
  const emailName = generateRandomString();
  return `${emailName}${emailDomain}`;
}

/**
 * Checks an array of emails against Firebase Auth in batches of 100.
 * @param {string[]} emails - Array of email addresses to check.
 * @param {object} auth - Firebase Admin SDK Auth instance.
 * @returns {Promise<string[]>} Array of emails already in use.
 */
async function validateEmails(emails: string[], auth: Auth): Promise<string[]> {
  const chunkedEmails = _chunk(emails, 100);
  const emailsAlreadyInUse: string[] = [];

  for (const chunk of chunkedEmails) {
    try {
      const result = await auth.getUsers(chunk.map((email) => ({ email })));

      if (result.users.length > 0) {
        result.users.forEach((user) => {
          if (user.email) {
            emailsAlreadyInUse.push(user.email);
          }
        });
      }
    } catch (error) {
      logger.error("Error processing emails", {
        error,
        chunkSize: chunk.length,
      });
    }
  }

  logger.debug("Found existing emails in use", {
    count: emailsAlreadyInUse.length,
  });

  return emailsAlreadyInUse;
}

// TODO: Update this since we are removing the ROAR code. ROAR allowed people to submit emails, we don't allow that.
async function getValidEmails({
  users,
  auth,
  emailDomain,
}: {
  users: InputUser[];
  auth: Auth;
  emailDomain: string;
}): Promise<string[]> {
  let validEmails: string[] = [];

  let processedUsers = 0;

  while (validEmails.length < users.length) {
    const remainingUsers = users.slice(processedUsers);
    const newEmails = remainingUsers.map((user) => generateEmail(emailDomain));

    try {
      const emailsAlreadyInUse = await validateEmails(newEmails, auth);
      logger.debug("Found new emails already in use", {
        count: emailsAlreadyInUse.length,
      });

      // Filter out emails that are already in use
      const newValidEmails = newEmails.filter(
        (email: string) => !emailsAlreadyInUse.includes(email)
      );
      validEmails.push(...newValidEmails);
      processedUsers += newValidEmails.length;
    } catch (error) {
      logger.error("Error checking new emails", { error });
      throw error;
    }
  }

  logger.debug("Successfully validated unique emails", {
    count: validEmails.length,
  });
  return validEmails.slice(0, users.length); // Ensure we return exactly the number of emails needed
}

function getUserType(user: InputUser) {
  const userType = user?.userType?.toLowerCase() ?? "student";

  return userType === "child" ? "student" : userType; // parent, teacher;
}

export const _createUsers = async (
  requestingUid: string,
  userData: InputUser[],
  validateRequesterPermissions = true
) => {
  const db = getFirestore();
  const auth = getAuth();
  // Check requesting user's claims to make sure they are creating users within their permissions.
  const claimsDocRef = db.collection("userClaims").doc(requestingUid);
  const currentClaims = await claimsDocRef.get().then((docSnapshot) => {
    if (docSnapshot.exists) {
      return docSnapshot.data()!.claims;
    }
    return null;
  });

  if (
    (validateRequesterPermissions && !currentClaims) ||
    (validateRequesterPermissions &&
      !currentClaims?.super_admin &&
      validateRequesterPermissions &&
      !currentClaims?.admin)
  ) {
    throw new HttpsError(
      "permission-denied",
      "The requesting user does not have the necessary permissions to create users."
    );
  }

  const classDataCache: Record<string, ClassData> = {};

  // Super admins can create users in any org
  // Admins can only create users in their orgs
  if (!currentClaims.super_admin) {
    for (let user of userData) {
      const {
        districts: districtIds,
        schools: schoolIds,
        classes: classIds,
        groups: groups,
      } = user.orgIds;

      if (!_isEmpty(classIds) && _isEmpty(schoolIds) && _isEmpty(districtIds)) {
        throw new HttpsError(
          "invalid-argument",
          "This user is assigned to a class, but does not have a school or district assigned."
        );
      }

      if (!_isEmpty(schoolIds) && _isEmpty(districtIds)) {
        throw new HttpsError(
          "invalid-argument",
          "This user is assigned to a school, but does not have a district assigned."
        );
      }

      const adminOrgs = currentClaims.adminOrgs;
      // Validate user creation from educational admins
      if (
        !_isEmpty(adminOrgs.districts) ||
        !_isEmpty(adminOrgs.schools) ||
        !_isEmpty(adminOrgs.classes)
      ) {
        for (const districtId of districtIds) {
          if (!_includes(adminOrgs.districts, districtId)) {
            throw new HttpsError(
              "permission-denied",
              `The requesting user is not an administrator for site ${districtId}.`
            );
          }
        }
        for (const schoolId of schoolIds) {
          if (!_includes(adminOrgs.schools, schoolId)) {
            throw new HttpsError(
              "permission-denied",
              `The requesting user is not an administrator for school ${schoolId}.`
            );
          }
        }
        for (const classId of classIds) {
          if (!_includes(adminOrgs.classes, classId)) {
            throw new HttpsError(
              "permission-denied",
              `The requesting user is not an administrator for class ${classId}.`
            );
          }
        }
      }

      // 1. Check if the class data already exists in cache
      // 2. If it doesent, get classData from db and cache it
      // 3. If it does, check if the district and school ids match
      // 4. If they don't, throw an error
      // 5. If classData cannot be found, throw an error

      // We also need to verify that the school and classes are in the district
      if (!_isEmpty(classIds)) {
        for (const classId of classIds) {
          if (classDataCache[classId]) {
            const classData = classDataCache[classId];
            if (
              !_includes(districtIds, classData.districtId) ||
              !_includes(schoolIds, classData.schoolId)
            ) {
              throw new HttpsError(
                "invalid-argument",
                "The district, school, and class fields for this new " +
                  "user are inconsistent. The class must be in the school " +
                  "and the school must be in the district."
              );
            }
          } else {
            const classRef = db.collection("classes").doc(classId);
            const classSnapshot = await classRef.get();
            if (classSnapshot.exists) {
              const classData = classSnapshot.data();
              // This condition is redundant but TypeScript complains otherwise.
              if (!classData) {
                throw new HttpsError(
                  "not-found",
                  `The class with ID ${classId} could not be found.`
                );
              }

              if (
                !_includes(districtIds, classData.districtId) ||
                !_includes(schoolIds, classData.schoolId)
              ) {
                throw new HttpsError(
                  "invalid-argument",
                  "The district, school, and class fields for this new " +
                    "user are inconsistent.The class must be in the school " +
                    "and the school must be in the district."
                );
              }

              classDataCache[classId] = {
                districtId: classData.districtId,
                schoolId: classData.schoolId,
              };
            } else {
              throw new HttpsError(
                "not-found",
                `The class with ID ${classId} could not be found.`
              );
            }
          }
        }
      }

      // Check that the new user's groups are in the admin's adminOrgs.groups
      for (const group of groups) {
        if (!_includes(adminOrgs.groups, group)) {
          throw new HttpsError(
            "permission-denied",
            `The requesting user is not an administrator for group ${group}.`
          );
        }
      }
    }
  }

  // -----------------------------------------------------------------------------

  // We can share the id's across projects because the id algorithm uses timestamps under the hood.
  // Users will now have one uid across both projects
  const userAdminDocs: DocumentReference[] = userData.map((user) =>
    db.collection("users").doc()
  );

  const emailDomain = "@levante.com";

  const userEmails = await getValidEmails({
    users: userData,
    auth: auth,
    emailDomain,
  });

  const adminAuthUsers: AdminAuthUserData[] = [];
  const adminUserClaimsDocs: Promise<WriteResult>[] = [];
  const returnUserData: ReturnUserData[] = [];

  // Prepare a map of districtId -> name (bulk fetch unique IDs to populate siteName)
  const uniqueDistrictIds = Array.from(
    new Set(userData.flatMap((u) => u.orgIds.districts || []))
  );
  const districtIdToName = new Map<string, string>();
  if (uniqueDistrictIds.length > 0) {
    const chunk = <T>(arr: T[], size: number): T[][] => {
      const chunks: T[][] = [];
      for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
      }
      return chunks;
    };
    const idChunks = chunk(uniqueDistrictIds, 30);
    for (const ids of idChunks) {
      const snap = await db
        .collection("districts")
        .where(FieldPath.documentId(), "in", ids)
        .get();
      for (const doc of snap.docs) {
        const data = doc.data();
        districtIdToName.set(doc.id, (data?.name as string) ?? "");
      }
    }
  }

  // Add relavent data to the auth user object
  for (let i = 0; i < userData.length; i++) {
    const user = userData[i];

    let displayName = "";

    // generate random password
    const stringPassword = generateRandomString();

    const roles: { siteId: string; role: string; siteName: string }[] = [];
    user.orgIds.districts.forEach((districtId) => {
      roles.push({
        siteId: districtId,
        role: ROLES.PARTICIPANT,
        siteName: districtIdToName.get(districtId) ?? "",
      });
    });

    const claims = {
      roarUid: userAdminDocs[i].id,
      adminUid: userAdminDocs[i].id,
      assessmentUid: userAdminDocs[i].id,
    };

    const authUserData: BaseAuthUserData = {
      uid: userAdminDocs[i].id,
      email: userEmails[i],
      displayName: displayName,
      emailVerified: false,
      disabled: false,
      fromCSV: user,
      customClaims: { claims: claims, roles },
    };

    // Handle password differently for emulator vs production
    if (isEmulated()) {
      // For emulators, use plain text password
      authUserData.password = stringPassword;
    } else {
      // For production, use hashed password
      const hashedPassword = await bcrypt.hash(stringPassword, 1);
      authUserData.passwordHash = Buffer.from(hashedPassword);
    }

    logger.debug("Prepared auth user data", {
      uid: authUserData.uid,
      email: authUserData.email,
      rolesCount: authUserData.customClaims.roles.length,
    });

    // TODO: Migrate to using username for login
    let username = "";

    adminAuthUsers.push(authUserData);

    const adminUserClaimDoc = db
      .collection("userClaims")
      .doc(userAdminDocs[i].id);
    adminUserClaimsDocs.push(
      adminUserClaimDoc.set({
        claims: {
          ...claims,
          useNewPermissions: false,
        },
      })
    );

    returnUserData.push({
      uid: authUserData.uid,
      email: authUserData.email,
      password: stringPassword,
    });
  }

  const maxRetries = 3; // Set a maximum number of retries to avoid infinite loops

  async function createAuthUsers(
    usersToRegister: AdminAuthUserData[],
    project: string,
    currentRetry = 0
  ) {
    // TODO: This is a workaround, the importUsers method doesn't seem to work in the emulator. .
    try {
      if (isEmulated()) {
        // For emulators, create users individually using createUser
        logger.debug("Creating users individually for emulator", {
          count: usersToRegister.length,
          project,
        });
        const results: Array<
          | { success: true; uid: string }
          | { success: false; error: any; user: AdminAuthUserData }
        > = [];

        for (const user of usersToRegister) {
          try {
            const userRecord = await auth.createUser({
              uid: user.uid,
              email: user.email,
              password: user.password!,
              displayName: user.displayName,
              emailVerified: user.emailVerified,
              disabled: user.disabled,
            });

            // Set custom claims after user creation
            await auth.setCustomUserClaims(
              userRecord.uid,
              user.customClaims.claims
            );

            results.push({ success: true, uid: userRecord.uid });
          } catch (error: any) {
            logger.error("Failed to create user in emulator", {
              email: user.email,
              error,
              project,
            });
            results.push({ success: false, error, user });
          }
        }

        const failureCount = results.filter((r) => !r.success).length;
        const successCount = results.filter((r) => r.success).length;

        if (failureCount > 0 && currentRetry < maxRetries) {
          const failedUsers = results
            .filter((r) => !r.success)
            .map(
              (r) =>
                (r as { success: false; error: any; user: AdminAuthUserData })
                  .user
            );

          logger.warn("Retrying failed emulator user creations", {
            retryCount: currentRetry + 1,
            maxRetries,
            failedCount: failedUsers.length,
            project,
          });
          await createAuthUsers(failedUsers, project, currentRetry + 1);
        } else if (failureCount > 0 && currentRetry >= maxRetries) {
          logger.error("Maximum retries exceeded creating emulator users", {
            maxRetries,
            project,
            failedUsers: results
              .filter((r) => !r.success)
              .map(
                (r) =>
                  (r as { success: false; error: any; user: AdminAuthUserData })
                    .user.email
              ),
          });
          throw new Error(
            `Maximum retries (${maxRetries}) exceeded. Failed to create ${failureCount} users`
          );
        }

        return;
      }

      // For production, use bulk importUsers
      let res: UserImportResult;
      res = await auth.importUsers(usersToRegister, {
        hash: {
          algorithm: "BCRYPT",
        },
      });

      const failedUsers: any[] = []; // Reset the failedUsers array for each retry

      if (res.failureCount > 0) {
        // The index property maps to the index of the user in the usersToRegister array
        res.errors.forEach((error) => {
          failedUsers.push(usersToRegister[error.index]);
        });
      }

      // If there are failures and we haven't reached the max number of retries
      if (failedUsers.length > 0 && currentRetry < maxRetries) {
        // Retry with failed users
        await createAuthUsers(failedUsers, project, currentRetry + 1);
      } else if (failedUsers.length > 0 && currentRetry >= maxRetries) {
        logger.error("Maximum retries exceeded importing users", {
          maxRetries,
          project,
          failedCount: failedUsers.length,
        });
        throw new Error(
          `Maximum retries (${maxRetries}) exceeded. Failed to create all users`
        );
      }
    } catch (error: any) {
      logger.error("An error occurred while creating users", {
        error,
        project,
        attempt: currentRetry,
      });
      throw new Error(error.message);
    }
  }

  await createAuthUsers(adminAuthUsers, "admin");

  const retryDelay = 1000; // 1 second

  async function setClaimsDocs(claimsDocs: Promise<WriteResult>[], db: string) {
    let remainingDocs = claimsDocs;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (remainingDocs.length === 0) break;

      const results = await Promise.allSettled(remainingDocs);

      const failedDocs = results
        .map((result, index) =>
          result.status === "rejected" ? remainingDocs[index] : null
        )
        // Type guard. It's telling TypeScript that any non-null value that passes this filter
        // is guaranteed to be a Promise<WriteResult>
        .filter((doc): doc is Promise<WriteResult> => doc !== null);

      if (failedDocs.length === 0) {
        return;
      }

      logger.warn("Retrying failed UID claims doc writes", {
        database: db,
        failedCount: failedDocs.length,
        attempt: attempt + 1,
        maxRetries,
      });
      remainingDocs = failedDocs;

      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }

    if (remainingDocs.length > 0) {
      throw new Error(
        `Failed to set ${remainingDocs.length} ${db} UID claims docs after ${maxRetries} attempts`
      );
    }
  }

  try {
    await setClaimsDocs(adminUserClaimsDocs, "admin");
  } catch (error) {
    logger.error("Fatal error setting UID claims docs", { error });
    throw error;
  }

  // Once the Auth User is created, populate the corresponding user's doc in firestore
  const adminUserDocs: Promise<WriteResult>[] = [];

  function prepareUserDocs() {
    for (let i = 0; i < adminAuthUsers.length; i++) {
      let currentUser = adminAuthUsers[i];

      const adminUserDocRef: DocumentReference = userAdminDocs[i];

      // Avoid storing password & identifiable information in user doc
      const { uid, fromCSV, email, displayName, emailVerified, disabled } =
        currentUser;

      const userType = getUserType(fromCSV);

      const userObj = {
        uid,
        email,
        displayName,
        emailVerified,
        disabled,
        username: email.split("@")[0],
        userType: userType,
        grade: "",
        archived: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        lastUpdated: new Date(), // keeping this until we migrate to updatedAt
        roles: currentUser.customClaims.roles,
      };

      const validUserTypes = ["student", "child", "teacher", "parent"];

      const userOrgs = {
        districts: fromCSV.orgIds.districts,
        schools: fromCSV.orgIds.schools,
        classes: fromCSV.orgIds.classes,
        groups: fromCSV.orgIds.groups,
      };

      // Add orgs to user object
      // Helper function to ensure we always work with arrays
      // Future plans to support multiple classes, potentially other orgs as well.
      const ensureArray = (value: string | string[]): string[] => {
        if (Array.isArray(value)) {
          return value;
        } else if (typeof value === "string") {
          return value.length > 0 ? [value] : [];
        } else {
          return [value];
        }
      };

      // Add orgs to user object
      if (validUserTypes.includes(userType)) {
        for (const [orgType, orgIds] of Object.entries(userOrgs)) {
          const orgIdsArray = ensureArray(orgIds);
          userObj[orgType] = {
            current: orgIdsArray,
            all: orgIdsArray,
            dates: orgIdsArray.reduce(
              (
                acc: Record<string, { from: Date; to: null }>,
                orgId: string
              ) => {
                acc[orgId] = {
                  from: new Date(),
                  to: null,
                };
                return acc;
              },
              {}
            ),
          };
        }
      }

      // Levante holds birthMonth and birthYear in admin user doc
      if ("month" in fromCSV && "year" in fromCSV) {
        userObj["birthMonth"] = (fromCSV as InputUser).month;
        userObj["birthYear"] = (fromCSV as InputUser).year;
      }

      // console.log("userObj after adding dob: ", userObj);

      adminUserDocs.push(adminUserDocRef.set(userObj, { merge: true }));
    }
  }

  try {
    prepareUserDocs();
  } catch (error) {
    logger.error("Error preparing user docs", { error });
  }

  async function createUserDocs(userDocs: Promise<WriteResult>[], db: string) {
    let remainingDocs = userDocs;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (remainingDocs.length === 0) break;

      const results = await Promise.allSettled(remainingDocs);

      const failedDocs = results
        .map((result, index) =>
          result.status === "rejected" ? remainingDocs[index] : null
        )
        .filter((doc): doc is Promise<WriteResult> => doc !== null);

      if (failedDocs.length === 0) {
        logger.debug(`Successfully created all ${db} user docs`);
        return;
      }

      logger.warn("Retrying failed user doc writes", {
        database: db,
        failedCount: failedDocs.length,
        attempt: attempt + 1,
        maxRetries,
      });
      remainingDocs = failedDocs;

      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      }
    }

    if (remainingDocs.length > 0) {
      throw new Error(
        `Failed to create ${remainingDocs.length} ${db} user docs after ${maxRetries} attempts`
      );
    }
  }

  // Create user docs in the admin database
  try {
    await createUserDocs(adminUserDocs, "admin");
  } catch (error) {
    logger.error("Error creating user docs", { error });
    throw error;
  }

  return {
    status: "success",
    message: "Users created successfully",
    data: returnUserData,
  };
};
