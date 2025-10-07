/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import type {
  DocumentReference,
  Transaction,
  Firestore,
} from "firebase-admin/firestore";

/**
 * An object representing an update action to be performed on a Firestore document.
 */
export interface UpdateAction {
  /* The document reference to update. */
  docRef?: DocumentReference;
  /* The path of the field to update. */
  fieldPath?: string;
  /* fieldValue - The new value for the field. */
  fieldValue?: FieldValue | string | string[] | null;
}

/**
 * Commits a list of update actions to a Firestore transaction.
 * @param {Object} params - An object containing the update actions and the transaction to use.
 * @param {UpdateAction[]} params.updateActions - The list of update actions to be committed.
 * @param {Transaction} params.transaction - The transaction to use for the updates.
 */
export const commitTransactionUpdates = ({
  updateActions = [],
  transaction,
}: {
  updateActions: UpdateAction[];
  transaction: Transaction;
}) => {
  for (const action of updateActions) {
    if (action.docRef && action.fieldPath && action.fieldValue !== undefined) {
      transaction.update(action.docRef, action.fieldPath, action.fieldValue);
    }
  }
};

/**
 * Removes a field from organizations if its value matches a reference value.
 *
 * @param {Object} params - An object containing the parameters for the operation.
 * @param {string} params.fieldPath - The field path to check and potentially remove.
 * @param {string} [params.groupFieldPath='parentOrgId'] - A separate field path for group documents to check and potentially remove.
 * @param {string} params.fieldValueToUnset - The reference value to unset.
 * @param {string[]} [params.districts=[]] - The district doc IDs to check and potentially modify.
 * @param {string[]} [params.schools=[]] - The school doc IDs to check and potentially modify.
 * @param {string[]} [params.classes=[]] - The class doc IDs to check and potentially modify.
 * @param {string[]} [params.groups=[]] - The group doc IDs to check and potentially modify.
 * @param {string[]} [params.families=[]] - The family doc IDs to check and potentially modify.
 * @param {Transaction} params.transaction - The transaction to use.
 * @param {Firestore} [params.db=getFirestore()] - The Firestore instance to use.
 * @returns {Promise<UpdateAction[]>} - A promise that resolves to an array of update actions.
 */
export const unsetFieldInDocs = async ({
  fieldPath,
  groupFieldPath = "parentOrgId",
  fieldValueToUnset,
  districts = [],
  schools = [],
  classes = [],
  groups = [],
  families = [],
  transaction,
  db = getFirestore(),
}: {
  fieldPath: string;
  groupFieldPath?: string;
  fieldValueToUnset: string;
  districts?: string[];
  schools?: string[];
  classes?: string[];
  groups?: string[];
  families?: string[];
  transaction: Transaction;
  db?: Firestore;
}): Promise<UpdateAction[]> => {
  // For all of the removed classes, make sure the
  // ``schoolId`` field is not set to this school.
  // For all of the removed subGroups, make sure the ``parentOrgId``
  // field is not set to this school.
  const orgUpdatePromises: Promise<UpdateAction>[] = [];
  const orgsToUpdate = {
    districts,
    schools,
    classes,
    groups,
    families,
  };

  for (const [orgType, orgIds] of Object.entries(orgsToUpdate)) {
    for (const orgId of orgIds ?? []) {
      const orgDocRef = db.collection(orgType).doc(orgId);
      orgUpdatePromises.push(
        transaction.get(orgDocRef).then((orgDocSnap) => {
          const orgData = orgDocSnap.data();
          if (orgType === "groups") {
            // Check if the parentOrgId field is set to this district.
            if (orgData?.[groupFieldPath] === fieldValueToUnset) {
              // If so, set it to null.
              return {
                docRef: orgDocRef,
                fieldPath: groupFieldPath,
                fieldValue: null,
              };
            }
          } else {
            // Check if the schoolId field is set to this school.
            if (orgData?.[fieldPath] === fieldValueToUnset) {
              // If so, set it to null.
              return {
                docRef: orgDocRef,
                fieldPath,
                fieldValue: null,
              };
            }
          }
          return {};
        })
      );
    }
  }

  return Promise.all(orgUpdatePromises);
};
