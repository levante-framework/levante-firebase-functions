/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Auth, getAuth } from "firebase-admin/auth";
import {
  DocumentData,
  DocumentReference,
  FieldPath,
  Firestore,
  getFirestore,
  Query,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import _concat from "lodash/concat";
import _isEmpty from "lodash/isEmpty";
import _set from "lodash/set";
import _toPairs from "lodash/toPairs";
import _uniq from "lodash/uniq";
import _without from "lodash/without";
import {
  getIdentityProviderDocRef,
  IdentityProviderType,
} from "./identity-providers";

/**
 * Retrieve the ROAR UID of a user.
 *
 * If a user has been imported from an external identity provider, then this
 * function will lookup the ROAR UID created/saved during that import.
 * Otherwise, it falls back on the admin auth UID of the user. If the admin
 * auth UID is not provided, then it creates a new document in the users
 * collection and returns that document ID.
 *
 * @param {object} input - The input parameters
 * @param {string} input.adminUid - The admin auth UID of the user
 * @param {string} input.identityProviderId - The ID of the user in the external
 *                                            identity provider
 * @param {string} input.identityProviderEmail - The email of the user in the external
 *                                            identity provider
 * @param {string} input.identityProviderType - The type of the external identity
 *                                            provider
 * @param {boolean} input.createIfNotFound - If true, create a new document in
 *                                           the users collection and use that
 *                                           document ID as the ROAR UID.
 * @param {boolean} input.fallBackToAdminUid - If true, fall back to the admin auth UID
 * @return {string | undefined} - The ROAR UID of the user, or null if no fallbacks are defined
 */
export const getRoarUid = async ({
  adminUid,
  identityProviderId,
  identityProviderEmail,
  identityProviderType,
  createIfNotFound = true,
  fallBackToAdminUid = true,
}: {
  adminUid?: string;
  identityProviderId?: string;
  identityProviderEmail?: string;
  identityProviderType?: IdentityProviderType;
  createIfNotFound?: boolean;
  fallBackToAdminUid?: boolean;
}): Promise<string | undefined> => {
  const db = getFirestore();
  if (identityProviderId && identityProviderType) {
    let idpCollection = db.collection(
      "identityProviderIds"
    ) as Query<DocumentData>;
    return idpCollection.get().then(async (querySnapshot) => {
      if (querySnapshot.empty) {
        if (adminUid) {
          const userClaimsDoc = await db
            .collection("userClaims")
            .doc(adminUid)
            .get()
            .then((doc) => doc.data());

          if (userClaimsDoc && userClaimsDoc.roarUid) {
            return userClaimsDoc.roarUid;
          }

          if (fallBackToAdminUid) {
            return adminUid;
          }
        }

        if (createIfNotFound) {
          const newRoarUid = db.collection("users").doc().id;
          return newRoarUid;
        } else {
          return undefined;
        }
      }

      if (querySnapshot.size > 1) {
        throw new HttpsError(
          "invalid-argument",
          `Multiple provider ID documents found for provider ${identityProviderType} ${identityProviderId}`
        );
      }

      return querySnapshot.docs[0].data()!.roarUid;
    });
  }

  if (adminUid) {
    const userClaimsDoc = await db
      .collection("userClaims")
      .doc(adminUid)
      .get()
      .then((doc) => doc.data());

    if (userClaimsDoc && userClaimsDoc.claims?.roarUid) {
      return userClaimsDoc.claims.roarUid;
    }

    if (fallBackToAdminUid) {
      return adminUid;
    }
  }

  if (createIfNotFound) {
    const newRoarUid = db.collection("users").doc().id;
    return newRoarUid;
  } else {
    return undefined;
  }
};

interface ISetUidClaimsInput {
  roarUid?: string;
  adminUid: string;
  auth?: Auth;
  db?: Firestore;
  targetAuthUid?: string;
  isTestData?: boolean;
  identityProviderType?: IdentityProviderType;
  identityProviderId?: string;
}

/**
 * Set custom UIDs in the custom claims of a ROAR user.
 *
 * This function returns a Promise which resolves to an http status code. It returns
 * - StatusCode.SuccessOK if successful,
 * - StatusCode.ServerErrorInsuffientStorage if new custom claims exceed the maximum storage size.
 *
 * @param {object} input - The input parameters
 * @param {string} input.roarUid - The ROAR UID of the user
 * @param {string} input.adminUid - The auth UID of user in the ROAR admin Firebase project
 * @param {Auth} input.auth - The Firebase Auth instance to use for the operation
 * @param {Firestore} input.db - The Firestore instance to use for the operation
 * @param {string} input.targetAuthUid - The auth UID of the user in the target Firebase project (optional)
 * @param {boolean} input.isTestData - Indicates whether this is a test data operation (optional)
 * @return {Promise<StatusCode>}
 */
export const setUidClaimsHandler = async ({
  roarUid,
  adminUid,
  auth,
  db,
  targetAuthUid,
  isTestData = false,
}: ISetUidClaimsInput) => {
  const targetUid = targetAuthUid || adminUid;
  const _auth = auth ?? getAuth();
  let user;
  try {
    user = await _auth.getUser(targetUid);
  } catch (error) {
    logger.error("Error getting user in setUidClaimsHandler", {
      error,
      targetUid,
    });
    throw Error(
      `Error getting user with uid in setUidClaimsHandler ${targetUid}: ${error}`
    );
  }

  const currentClaims = user.customClaims || {};

  const _db = db ?? getFirestore();

  if (roarUid === undefined) {
    roarUid = await getRoarUid({
      adminUid,
      createIfNotFound: true,
    });
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { adminOrgs, ...authClaims } = currentClaims;

  const newClaims = {
    ...authClaims,
    roarUid,
    adminUid,
  };

  const stringifiedClaims = JSON.stringify(newClaims);
  if (stringifiedClaims.length > 1000) {
    logger.error(
      "New custom claims object string > 1000 characters",
      stringifiedClaims
    );
    throw new HttpsError(
      "resource-exhausted",
      "The users custom claims exceed the maximum storage size."
    );
  }

  return _auth
    .setCustomUserClaims(targetUid, newClaims)
    .then(async () => {
      const userClaimsRef = _db.collection("userClaims").doc(targetUid);
      const userClaimsSnapshot = await userClaimsRef.get();

      if (userClaimsSnapshot.exists) {
        const roarUidFieldPath = new FieldPath("claims", "roarUid");
        const adminUidFieldPath = new FieldPath("claims", "adminUid");

        return userClaimsRef.update(
          roarUidFieldPath,
          roarUid,
          adminUidFieldPath,
          adminUid
        );
      } else {
        const userClaimsData = {
          claims: newClaims,
          testData: isTestData,
        };
        return userClaimsRef.set(userClaimsData);
      }
    })
    .then(() => {
      return {
        status: "ok",
        userClaims: newClaims,
      };
    })
    .catch((error) => {
      logger.error("Error setting custom claims", error);
      throw new HttpsError("internal", "Error setting custom claims");
    });
};

export const setUidClaimsInBothProjects = async ({
  adminUid,
  roarUid,
}: {
  adminUid: string;
  roarUid: string;
}) => {
  let envVars;

  const auth = {
    admin: getAuth(),
  };
  const db = {
    admin: getFirestore(),
  };
  // Set up custom claims for admin and assessment users
  const targetAuthUids = {
    admin: adminUid,
  };

  const claimsResults = {};

  for (const projectKey of ["admin"]) {
    claimsResults[projectKey] = await setUidClaimsHandler({
      roarUid,
      adminUid,
      auth: auth[projectKey],
      db: db[projectKey],
      targetAuthUid: targetAuthUids[projectKey],
    });
  }

  db.admin.runTransaction(async (transaction) => {
    const idpDocRef = (await getIdentityProviderDocRef({
      roarUid,
      createIfNotFound: false,
      transaction,
    })) as DocumentReference | null;

    if (idpDocRef) {
      const adminOrgs = await transaction
        .get(idpDocRef)
        .then((doc) => doc.data()?.adminOrgs);
      if (adminOrgs && !_isEmpty(adminOrgs)) {
        const userClaimsDocRef = db.admin
          .collection("userClaims")
          .doc(adminUid);
        const adminOrgsFieldPath = new FieldPath("claims", "adminOrgs");
        transaction.update(userClaimsDocRef, adminOrgsFieldPath, adminOrgs);
      }
    }
  });

  return claimsResults["admin"];
};

interface IValidateAdminInput {
  /** The auth UID of the requesting user */
  requesterUid: string;
  /** The district ID to be appended to the custom admin claims */
  districts?: string[];
  /** The school ID to be appended to the custom admin claims */
  schools?: string[];
  /** The class ID to be appended to the custom admin claims */
  classes?: string[];
  /** The family ID to be appended to the custom admin claims */
  families?: string[];
  /** The group ID to be appended to the custom admin claims */
  groups?: string[];
  /** The admin Auth instance */
  auth?: Auth;
  /** The admin Firestore instance */
  db?: Firestore;
}

interface IAdminClaimsInput extends IValidateAdminInput {
  /** The auth UID of the target user */
  targetUid: string;
  /** Whether to append or remove the org */
  action: "append" | "remove";
}

/**
 * Append or remove organization IDs to the custom admin claims of a ROAR user.
 *
 * This function returns a Promise which resolves to an http status code. It returns
 * - StatusCode.SuccessOK if successful,
 * - StatusCode.ClientErrorForbidden if the requesting user is not authorized,
 * - StatusCode.ClientErrorNotFound if any of the organization IDs do not exist in Firestore, or
 * - StatusCode.ServerErrorNotImplemented if the organization type is not yet implemented.
 * - StatusCode.ServerErrorInsuffientStorage if new custom claims exceed the maximum storage size.
 *
 * @param {object} params - an object containing the custom admin claims
 * @param {string} params.requesterUid - The assessment Firebase auth UID of the requesting user
 * @param {string} params.targetUid - The assessment Firebase auth UID of the target user
 * @param {string} params.districts - The district IDs to be appended to the custom admin claims
 * @param {string} params.schools - The school IDs to be appended to the custom admin claims
 * @param {string} params.classes - The class IDs to be appended to the custom admin claims
 * @param {string} params.families - The family IDs to be appended to the custom admin claims
 * @param {string} params.groups - The group IDs to be appended to the custom admin claims
 * @param {string} params.action - Whether to append or remove the org
 * @param {Auth} params.auth - The Firebase Auth instance to use
 * @param {Firestore} params.db - The Firestore instance to use
 * @return {Promise<StatusCode>}
 */
export const appendOrRemoveAdminOrgs = async ({
  requesterUid,
  targetUid,
  districts,
  schools,
  classes,
  families,
  groups,
  action,
  auth,
  db,
}: IAdminClaimsInput) => {
  const _auth = auth ?? getAuth();
  const _db = db ?? getFirestore();

  const response = await validateAdminStatus({
    requesterUid,
    districts,
    schools,
    classes,
    families,
    groups,
    auth: _auth,
    db: _db,
  });

  if (response.status !== "ok") {
    return response;
  }

  const userClaimsRef = _db.collection("userClaims").doc(targetUid);
  const userClaims = await userClaimsRef.get().then((docSnap) => {
    if (!docSnap.exists) {
      return null;
    }

    return docSnap.data()!.claims;
  });

  const emptyOrgList = {
    districts: [],
    schools: [],
    classes: [],
    families: [],
    groups: [],
  };

  // Get the target user's current custom claims.
  const { adminOrgs = emptyOrgList, ...otherClaims } = userClaims || {};

  logger.debug(`Editing admin orgs for ${targetUid}`, {
    previousOrgs: adminOrgs,
    action,
    districts,
    schools,
    classes,
    families,
    groups,
  });

  if (action === "append") {
    adminOrgs.districts = _uniq(
      _without(_concat(adminOrgs.districts, districts), undefined)
    );
    adminOrgs.schools = _uniq(
      _without(_concat(adminOrgs.schools, schools), undefined)
    );
    adminOrgs.classes = _uniq(
      _without(_concat(adminOrgs.classes, classes), undefined)
    );
    adminOrgs.families = _uniq(
      _without(_concat(adminOrgs.families, families), undefined)
    );
    adminOrgs.groups = _uniq(
      _without(_concat(adminOrgs.groups, groups), undefined)
    );
  } else if (action === "remove") {
    adminOrgs.districts = _uniq(
      _without(adminOrgs.districts, districts, undefined)
    );
    adminOrgs.schools = _uniq(_without(adminOrgs.schools, schools, undefined));
    adminOrgs.classes = _uniq(_without(adminOrgs.classes, classes, undefined));
    adminOrgs.families = _uniq(
      _without(adminOrgs.families, families, undefined)
    );
    adminOrgs.groups = _uniq(_without(adminOrgs.groups, groups, undefined));
  }

  logger.debug(`Finished editing admin orgs for ${targetUid}`, {
    currentOrgs: adminOrgs,
  });

  const stringifiedClaims = JSON.stringify(otherClaims);
  if (stringifiedClaims.length > 1000) {
    logger.error(
      "New custom claims object string > 1000 characters",
      stringifiedClaims
    );
    throw new HttpsError(
      "resource-exhausted",
      "The users custom claims exceed the maximum storage size."
    );
  }

  return _auth
    .setCustomUserClaims(targetUid, otherClaims)
    .then(() => {
      return _db
        .collection("userClaims")
        .doc(targetUid)
        .set(
          {
            claims: {
              adminOrgs,
              ...otherClaims,
            },
          },
          { merge: true }
        );
    })
    .then(() => {
      return {
        status: "ok",
        userClaims: {
          adminOrgs,
          ...otherClaims,
        },
      };
    });
};

/**
 * Validate admin status. Check that a requesting user is authorized to edit a target user.
 *
 * This function returns a Promise which resolves to an http status code. It returns
 * - StatusCode.SuccessOK if successful,
 * - StatusCode.ClientErrorForbidden if the requesting user is not authorized,
 * - StatusCode.ClientErrorNotFound if any of the organization IDs do not exist in Firestore, or
 * - StatusCode.ServerErrorNotImplemented if the organization type is not yet implemented.
 *
 * @param {object} params - an object containing the custom admin claims
 * @param {string} params.requesterUid - The assessment Firebase auth UID of the requesting user
 * @param {string} params.targetUid - The assessment Firebase auth UID of the target user
 * @param {string} params.districts - The district ID to be appended to the custom admin claims
 * @param {string} params.schools - The school ID to be appended to the custom admin claims
 * @param {string} params.classes - The class ID to be appended to the custom admin claims
 * @param {string} params.families - The family ID to be appended to the custom admin claims
 * @param {string} params.groups - The group ID to be appended to the custom admin claims
 * @param {Firestore} params.db - The admin Firestore instance
 * @return {Promise<StatusCode>}
 */
export const validateAdminStatus = async ({
  requesterUid,
  districts,
  schools,
  classes,
  families,
  groups,
  db,
}: IValidateAdminInput) => {
  const _db = db ?? getFirestore();

  logger.debug(`Validating admin status for ${requesterUid}`);

  const requesterClaimsDocRef = _db.collection("userClaims").doc(requesterUid);
  const requesterClaims = await requesterClaimsDocRef.get().then((docSnap) => {
    return docSnap.data()?.claims ?? null;
  });

  // Validate requester claims ensure that the requester UID is authorized
  // to modify the adminOrgs of the target UID.

  // Admins can only modify the adminOrgs of users in subordinate organizations.
  // For example, a district admin can designate another user as a school admin
  // for a school in their district. Or a class in their district. A school admin
  // can designate another user as a class admin for a class in their school.

  // The following nested conditionals will return error codes is the user
  // does not have permission to modify the adminOrgs of the target UID.

  if (!requesterClaims?.super_admin) {
    // If a district or group is being added, then the requesting user must be a
    // super_admin.
    if (districts || groups) {
      throw new HttpsError(
        "permission-denied",
        "The requesting user in not authorized to add/remove district or group administrators."
      );
    }

    // If a classId is being added, then the requesting user must be an admin
    // for the class's parent school or district.
    if (classes) {
      for (const classId of classes) {
        const classDoc = await _db.collection("classes").doc(classId).get();
        if (classDoc.exists) {
          const parentSchoolId = classDoc.data()!.schoolId;
          const parentDistrictId = classDoc.data()!.districtId;
          if (
            !(
              requesterClaims?.adminOrgs?.districts?.includes(
                parentDistrictId
              ) || requesterClaims?.adminOrgs?.schools?.includes(parentSchoolId)
            )
          ) {
            // The requesting user is not an admin for the parent school or district.
            throw new HttpsError(
              "permission-denied",
              "The requesting user in not authorized to add/remove " +
                `administrators for class ${classId}.`
            );
          }
        } else {
          // The classId does not exist in the database.
          throw new HttpsError(
            "not-found",
            `The classId ${classId} does not exist in the database.`
          );
        }
      }
    }

    if (schools) {
      for (const schoolId of schools) {
        const schoolDoc = await _db.collection("schools").doc(schoolId).get();
        if (schoolDoc.exists) {
          const parentDistrictId = schoolDoc.data()!.districtId;
          if (
            !requesterClaims?.adminOrgs?.districts?.includes(parentDistrictId)
          ) {
            // The requesting user is not an admin for the parent district.
            throw new HttpsError(
              "permission-denied",
              "The requesting user in not authorized to add/remove " +
                `administrators for school ${schoolId}.`
            );
          }
        } else {
          // The schoolId does not exist in the database.
          throw new HttpsError(
            "not-found",
            `The schoolId ${schoolId} does not exist in the database.`
          );
        }
      }
    }

    if (families) {
      for (const familyId of families) {
        if (!requesterClaims?.adminOrgs?.families?.includes(familyId)) {
          // The requesting user is not an admin for the parent district.
          throw new HttpsError(
            "permission-denied",
            "The requesting user in not authorized to add/remove " +
              `administrators for family ${familyId}.`
          );
        }
      }
    }
  } else {
    for (const [orgType, orgs] of _toPairs({
      districts,
      schools,
      classes,
      families,
      groups,
    })) {
      if (orgs) {
        for (const orgId of orgs) {
          const orgDoc = await _db.collection(orgType).doc(orgId).get();
          if (!orgDoc.exists) {
            // The orgId does not exist in the database.
            throw new HttpsError(
              "not-found",
              `Could not find ID ${orgId} in the database ${orgType} collection.`
            );
          }
        }
      }
    }
  }

  return {
    status: "ok",
  };
};
