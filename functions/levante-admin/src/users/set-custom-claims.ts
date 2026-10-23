/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { Auth } from "firebase-admin/auth";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldPath } from "firebase-admin/firestore";
import type {
  DocumentData,
  DocumentReference,
  Firestore,
  Query,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import _isEmpty from "lodash-es/isEmpty.js";
import {
  getIdentityProviderDocRef,
  IdentityProviderType,
} from "./identity-providers.js";
import { mergeRoleClaimsIntoClaims } from "../utils/role-helpers.js";

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

  const currentClaims = (user.customClaims as Record<string, unknown>) || {};

  const _db = db ?? getFirestore();

  if (roarUid === undefined) {
    roarUid = await getRoarUid({
      adminUid,
      createIfNotFound: true,
    });
  }

  /* eslint-disable @typescript-eslint/no-unused-vars */
  const { adminOrgs, ...authClaims } = currentClaims;

  const { claims: normalizedClaims, roleClaims } = mergeRoleClaimsIntoClaims(
    (authClaims as Record<string, unknown>) ?? {}
  );

  const normalizedClaimsWithPermissions = {
    ...normalizedClaims,
    useNewPermissions:
      typeof normalizedClaims.useNewPermissions === "boolean"
        ? (normalizedClaims.useNewPermissions as boolean)
        : roleClaims.roles.length > 0,
  };

  const newClaims = {
    ...normalizedClaimsWithPermissions,
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
