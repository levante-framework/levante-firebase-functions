import {
  DocumentReference,
  FieldValue,
  Filter,
  getFirestore,
  Transaction,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { IAdminClaims } from "../interfaces";

export enum IdentityProviderType {}

export interface IdentityProviderData {
  providerType: IdentityProviderType;
  providerId: string;
  lastSync: Date;
  activated: boolean;
  roarUid: string;
  email?: string;
  adminUid?: string;
  adminOrgs?: IAdminClaims;
}

/**
 * Retrieve the document ID of an existing identity provider document or creates a new one if not found.
 *
 * @param {object} params - An object containing the necessary parameters.
 * @param {string} params.identityProviderId - The unique identifier of the identity provider.
 * @param {IdentityProviderType} params.identityProviderType - The type of the identity provider.
 * @param {string} params.roarUid - The ROAR UID of the user. May not be specified along with identityProviderId.
 * @param {boolean} [params.createIfNotFound=true] - A boolean indicating whether to create a new identity provider document if it doesn't exist.
 * @param {Transaction} params.transaction - The Firestore transaction to use for this operation.
 *
 * @returns A promise that resolves to the document ID of the existing or newly created identity provider document.
 *
 * @throws An HttpsError with code "invalid-argument" if multiple provider ID documents are found for the given provider.
 */
export const getIdentityProviderDocRef = async ({
  identityProviderId,
  identityProviderType,
  identityProviderEmail,
  roarUid,
  createIfNotFound = true,
  allowMultiples = false,
  transaction,
}: {
  identityProviderId?: string;
  identityProviderType?: IdentityProviderType;
  identityProviderEmail?: string;
  roarUid?: string;
  createIfNotFound?: boolean;
  allowMultiples?: boolean;
  transaction: Transaction;
}): Promise<DocumentReference | DocumentReference[] | null> => {
  if (
    !roarUid &&
    !(identityProviderId && identityProviderType) &&
    !(identityProviderEmail && identityProviderType)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Missing required parameters: roarUid or (identityProviderId and identityProviderType) or (identityProviderEmail and identityProviderType)"
    );
  }

  if (
    roarUid &&
    (identityProviderId || identityProviderType || identityProviderEmail)
  ) {
    throw new HttpsError(
      "invalid-argument",
      "Cannot specify both roarUid and identityProviderId or identityProviderType or identityProviderEmail"
    );
  }

  const db = getFirestore();
  const idpCollection = db.collection("identityProviderIds");

  let query;
  if (roarUid) {
    query = idpCollection.where("roarUid", "==", roarUid);
  } else if (identityProviderId && identityProviderType) {
    query = idpCollection.where(
      Filter.and(
        Filter.where("providerType", "==", identityProviderType),
        Filter.where("providerId", "==", identityProviderId)
      )
    );
  } else if (identityProviderEmail && identityProviderType) {
    query = idpCollection.where(
      Filter.and(
        Filter.where("providerType", "==", identityProviderType),
        Filter.where("email", "==", identityProviderEmail.toLowerCase())
      )
    );
  }

  return transaction.get(query).then((querySnapshot) => {
    if (querySnapshot.empty) {
      if (createIfNotFound) {
        return idpCollection.doc();
      }
      return null;
    }

    if (querySnapshot.size > 1) {
      if (allowMultiples) {
        return querySnapshot.docs.map((doc) => doc.ref as DocumentReference);
      } else {
        const errMessage =
          "Multiple provider ID documents found for " +
          `${
            roarUid
              ? `roarUid ${roarUid}`
              : `provider ${identityProviderType} ${identityProviderId}, email ${identityProviderEmail}`
          }`;
        throw new HttpsError("invalid-argument", errMessage);
      }
    }

    return querySnapshot.docs[0].ref as DocumentReference;
  });
};

/**
 * Update the `lastSync` field of the specified identity provider document within a Firestore transaction.
 *
 * @param {object} params - An object containing the necessary parameters.
 * @param {string} params.identityProviderDocId - The document ID of the identity provider document to update.
 * @param {Transaction} params.transaction - The Firestore transaction to use for this operation.
 *
 * @returns {Transaction} The updated Firestore transaction.
 */
export const updateIdentityProviderLastSync = ({
  identityProviderDocId,
  transaction,
}: {
  identityProviderDocId: string;
  transaction: Transaction;
}) => {
  const db = getFirestore();
  const idpDocRef = db
    .collection("identityProviderIds")
    .doc(identityProviderDocId);
  return transaction.update(idpDocRef, {
    lastSync: FieldValue.serverTimestamp(),
  });
};

/**
 * Mark the specified identity provider document as activated (when a user authenticates).
 *
 * @param {object} params - An object containing the necessary parameters.
 * @param {string} params.identityProviderDocId - The document ID of the identity provider document to activate.
 * @param {Transaction} params.transaction - The Firestore transaction to use for this operation.
 *
 * @returns {Transaction} The updated Firestore transaction.
 */
export const activateIdentityProvider = ({
  identityProviderDocId,
  transaction,
}: {
  identityProviderDocId: string;
  transaction: Transaction;
}) => {
  const db = getFirestore();
  const idpDocRef = db
    .collection("identityProviderIds")
    .doc(identityProviderDocId);
  return transaction.update(idpDocRef, {
    activated: true,
  });
};
