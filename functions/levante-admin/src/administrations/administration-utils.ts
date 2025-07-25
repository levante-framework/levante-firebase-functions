import {
  CollectionReference,
  DocumentReference,
  FieldPath,
  Filter,
  getFirestore,
  Query,
  Transaction,
  FieldValue,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import _flatten from "lodash/flatten";
import _isEqual from "lodash/isEqual";
import _pick from "lodash/pick";
import _toPairs from "lodash/toPairs";
import _union from "lodash/union";
import _reduce from "lodash/reduce";
import _map from "lodash/map";
import _fromPairs from "lodash/fromPairs";
import { IAdministration, IOrgsList, ORG_NAMES } from "../interfaces";
import { removeOrgsFromAssignments } from "../assignments/assignment-utils";
import {
  chunkOrgs,
  getExhaustiveOrgs,
  getMinimalOrgs,
  getOnlyExistingOrgs,
  getReadOrgs,
} from "../orgs/org-utils";

/**
 * Retrieve all administrations associated with the provided orgs.
 *
 * @param {IOrgList} orgs - An object containing the different org types and their corresponding org IDs.
 * @param {Transaction} transaction - A Firebase Firestore transaction object.
 * @param {boolean} restrictToOpenAdministrations - A boolean indicating whether to only include open administrations. Default: true
 * @param {boolean} idsOnly - A boolean indicating whether to return only the administration IDs. Default: true
 * @param {null | boolean} testData - A boolean indicating how to filter testData. Default: null, meaning do not filter.
 * @param {boolean} useReadOrgs - A boolean indicating whether to use readOrgs instead of assignedOrgs to find administrations. Default: false
 * @returns {string[]} An array of all administrations associated with the provided orgs.
 */
export const getAdministrationsFromOrgs = async ({
  orgs,
  transaction,
  restrictToOpenAdministrations = true,
  idsOnly = true,
  testData = null,
  useReadOrgs = false,
  verbose = false,
}: {
  orgs: IOrgsList;
  transaction: Transaction;
  restrictToOpenAdministrations?: boolean;
  idsOnly?: boolean;
  testData?: null | boolean;
  useReadOrgs?: boolean;
  verbose?: boolean;
}) => {
  const db = getFirestore();
  let administrations: string[] = [];
  const administrationData: { [id: string]: IAdministration } = {};

  // Because ``in`` queries are limited to 10 comparisons each time,
  // we chuck the orgs array into chunks of 10.
  for (const orgChunk of chunkOrgs(orgs, 10)) {
    const orgIds = _flatten(Object.values(orgChunk));

    const filterComponents = [Filter.where("orgId", "in", orgIds)];

    if (restrictToOpenAdministrations) {
      filterComponents.push(Filter.where("dateClosed", ">", new Date()));
    }

    if (testData !== null) {
      filterComponents.push(Filter.where("testData", "==", testData));
    }

    // Limiting the number of results to ``queryLimit``.
    const queryLimit = 500;
    const collectionName = useReadOrgs ? "readOrgs" : "assignedOrgs";

    const firstQuery = db
      .collectionGroup(collectionName)
      .where(Filter.and(...filterComponents))
      .select("administrationId")
      .limit(queryLimit);

    let querySnapshot = await transaction.get(firstQuery);

    for (const documentSnapshot of querySnapshot.docs) {
      const administrationId = documentSnapshot.data()?.administrationId;
      if (administrationId) {
        administrations = _union(administrations, [administrationId]);

        if (!idsOnly) {
          if (!(administrationId in administrationData)) {
            const administrationDocRef = db
              .collection("administrations")
              .doc(administrationId);
            const administrationDocData = await transaction
              .get(administrationDocRef)
              .then((docSnap) => docSnap.data() as IAdministration);
            if (administrationDocData) {
              administrationData[administrationId] = administrationDocData;
            }
          }
        }
      }
    }

    let numDocs = querySnapshot.docs.length;

    // If the query did not exhaust the results, continue paging.
    while (numDocs === queryLimit) {
      const lastVisible = querySnapshot.docs[numDocs - 1];
      const nextQuery = firstQuery.startAfter(lastVisible);
      querySnapshot = await transaction.get(nextQuery);

      for (const documentSnapshot of querySnapshot.docs) {
        const administrationId = documentSnapshot.data()?.administrationId;
        if (administrationId) {
          administrations = _union(administrations, [administrationId]);

          if (!idsOnly) {
            if (!(administrationId in administrationData)) {
              const administrationDocRef = db
                .collection("administrations")
                .doc(administrationId);
              const administrationDocData = await transaction
                .get(administrationDocRef)
                .then((docSnap) => docSnap.data() as IAdministration);
              if (administrationDocData) {
                administrationData[administrationId] = administrationDocData;
              }
            }
          }
        }
      }
      numDocs = querySnapshot.docs.length;
    }
  }

  if (verbose) {
    logger.debug("found all administrations from orgs", {
      orgs,
      administrations,
    });
  }
  return {
    administrations,
    administrationData,
  };
};

/**
 * Processes the removal of orgs for a specific user.
 *
 * @param {string} roarUid - The unique identifier for the user.
 * @param {IOrgsList} removedOrgs - An object containing the different org types and their corresponding org IDs that have been removed.
 * @returns {Promise<void>} A Promise that resolves when the process is completed.
 */
export const processUserRemovedOrgs = async (
  roarUid: string,
  removedOrgs: IOrgsList
) => {
  logger.debug("Detected removed orgs", { removedOrgs });
  const db = getFirestore();
  await db.runTransaction(async (transaction) => {
    const removedExhaustiveOrgs = await getExhaustiveOrgs({
      orgs: removedOrgs,
      transaction,
      includeArchived: true,
    });

    const { administrations } = await getAdministrationsFromOrgs({
      orgs: removedExhaustiveOrgs,
      transaction,
      restrictToOpenAdministrations: true, // Restrict to open assignments. If a user has been removed from an org, we want to keep old assignments that they completed.
    });

    await removeOrgsFromAssignments(
      [roarUid],
      administrations,
      removedExhaustiveOrgs,
      transaction
    );
  });
};

/**
 * Write the administration's assigned and read orgs to their respective subcollections.
 *
 * @param {object} input - An object containing the administration ID, orgs to be written to readOrgs subcollection,
 * orgs to be written to assignedOrgs subcollection, and a Firestore transaction.
 * @param {string} input.administrationId - The unique identifier for the administration.
 * @param {IOrgsList} input.readOrgs - An object containing the different org types and their corresponding org IDs to be written to readOrgs subcollection.
 * @param {IOrgsList} input.assignedOrgs - An object containing the different org types and their corresponding org IDs to be written to assignedOrgs subcollection.
 * @param {Transaction} input.transaction - A Firestore transaction object.
 * @returns {Promise<void>} A Promise that resolves when the write operation is completed.
 */
export const writeAdministrationOrgsToSubcollections = async ({
  administrationId,
  readOrgs = {},
  assignedOrgs = {},
  administrationData,
  transaction,
}: {
  administrationId: string;
  readOrgs: IOrgsList;
  assignedOrgs: IOrgsList;
  administrationData: IAdministration;
  transaction: Transaction;
}) => {
  const db = getFirestore();
  const administrationDocRef = db
    .collection("administrations")
    .doc(administrationId);
  const assignedCollectionRef = administrationDocRef.collection("assignedOrgs");
  const readCollectionRef = administrationDocRef.collection("readOrgs");

  const denormalizedAdministrationData = _pick(administrationData, [
    "dateClosed",
    "dateOpened",
    "dateCreated",
    "createdBy",
    "legal",
    "name",
    "publicName",
    "testData",
  ]);

  for (const [orgType, orgIds] of _toPairs(readOrgs)) {
    for (const orgId of orgIds) {
      const orgRef = readCollectionRef.doc(orgId);
      const orgData = {
        ...denormalizedAdministrationData,
        orgType,
        administrationId,
        orgId,
        timestamp: new Date(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      transaction.set(orgRef, orgData);
    }
  }

  for (const [orgType, orgIds] of _toPairs(assignedOrgs)) {
    for (const orgId of orgIds) {
      const orgRef = assignedCollectionRef.doc(orgId);
      const orgData = {
        ...denormalizedAdministrationData,
        orgType,
        administrationId,
        orgId,
        timestamp: new Date(),
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };

      transaction.set(orgRef, orgData);
    }
  }
};

/**
 * Standardize the administration's orgs.
 *
 * @description
 * This function ensures that an administrations assigned orgs are existing and exhaustive. It then ensures that the readOrgs and minimalOrgs ensuring they are exhaustive, readOrgs and minimalOrgs are populated,
 * and writes them to their respective subcollections.
 *
 * @param {object} input - An object containing the administration ID, Firestore document reference, current data,
 * options for copying to subcollections and forcing a copy.
 * @param {string} input.administrationId - The unique identifier for the administration.
 * @param {DocumentReference} input.administrationDocRef - A Firestore document reference for the administration.
 * @param {IAdministration} input.currData - The current data for the administration.
 * @param {boolean} input.copyToSubCollections - A boolean indicating whether to copy the orgs to subcollections.
 * @param {boolean} input.forceCopy - A boolean indicating whether to force a copy, even if the orgs are already up-to-date.
 * @returns {Promise<IOrgsList>} A Promise that resolves with the assigned orgs when the standardization process is completed.
 */
export const standardizeAdministrationOrgs = async ({
  administrationId,
  administrationDocRef,
  currData,
  copyToSubCollections = true,
  forceCopy = false,
  verbose = false,
}: {
  administrationId: string;
  administrationDocRef: DocumentReference;
  currData: IAdministration;
  copyToSubCollections?: boolean;
  forceCopy?: boolean;
  verbose?: boolean;
}): Promise<{
  assignedOrgs: IOrgsList;
  minimalOrgs: IOrgsList;
  readOrgs: IOrgsList;
}> => {
  const db = getFirestore();

  const currOrgs = _pick(currData, ORG_NAMES);

  const numCurrOrgs = _reduce(
    currOrgs,
    (sum, value) => sum + (Array.isArray(value) ? value.length : 0),
    0
  );

  let assignedOrgs: IOrgsList;
  let readOrgs: IOrgsList;
  let minimalOrgs: IOrgsList;

  // Skip transaction if no orgs to process to prevent empty transaction errors.
  if (numCurrOrgs > 0) {
    ({ assignedOrgs, readOrgs, minimalOrgs } = await db.runTransaction(
      async (transaction) => {
        const existingOrgs = await getOnlyExistingOrgs(currOrgs, transaction);
        const currMinimalOrgs = await getMinimalOrgs(existingOrgs, transaction);
        const currExhaustiveOrgs = await getExhaustiveOrgs({
          orgs: existingOrgs,
          transaction,
        });
        const currReadOrgs = await getReadOrgs(currExhaustiveOrgs, transaction);

        if (!_isEqual(currMinimalOrgs, currOrgs)) {
          transaction.update(
            administrationDocRef,
            currMinimalOrgs as Partial<IAdministration>
          );
        }
        return {
          assignedOrgs: currExhaustiveOrgs,
          readOrgs: currReadOrgs,
          minimalOrgs: currMinimalOrgs,
        };
      }
    ));
  } else {
    const emptyOrgs = _fromPairs(
      _map(ORG_NAMES, (name) => [name, []])
    ) as IOrgsList;
    assignedOrgs = emptyOrgs;
    readOrgs = emptyOrgs;
    minimalOrgs = emptyOrgs;
  }

  const shouldCopy =
    copyToSubCollections && (forceCopy || !_isEqual(minimalOrgs, currOrgs));

  const numReadOrgs = _reduce(
    readOrgs,
    (sum, value) => (value ? sum + value.length : sum),
    0
  );
  const numAssignedOrgs = _reduce(
    assignedOrgs,
    (sum, value) => (value ? sum + value.length : sum),
    0
  );

  if (shouldCopy && numReadOrgs + numAssignedOrgs > 0) {
    await db.runTransaction(async (transaction) => {
      return writeAdministrationOrgsToSubcollections({
        administrationId,
        readOrgs,
        assignedOrgs,
        administrationData: currData,
        transaction,
      });
    });
  }

  if (verbose) {
    logger.debug(`Standardized orgs for administration ${administrationId}`, {
      minimalOrgs,
    });
  }

  return {
    assignedOrgs,
    minimalOrgs,
    readOrgs,
  };
};

export const getAdministrationsForAdministrator = async ({
  administratorRoarUid,
  restrictToOpenAdministrations = false,
  testData = null,
  idsOnly = false,
  verbose = false,
}: {
  administratorRoarUid: string;
  restrictToOpenAdministrations?: boolean;
  testData?: null | boolean;
  idsOnly?: boolean;
  verbose?: boolean;
}) => {
  const db = getFirestore();

  return db.runTransaction(async (transaction) => {
    const roarUidFieldPath = new FieldPath("claims", "roarUid");
    const userClaimsQuery = db
      .collection("userClaims")
      .where(roarUidFieldPath, "==", administratorRoarUid);

    const { adminOrgs, super_admin } = await transaction
      .get(userClaimsQuery)
      .then((snapshot) => {
        if (snapshot.empty) {
          throw new Error(
            `No user claims found for the Roar UID ${administratorRoarUid}`
          );
        }

        if (snapshot.docs.length > 1) {
          throw new Error(
            `Multiple user claims found for the same Roar UID ${administratorRoarUid}`
          );
        }

        return snapshot.docs[0].data()?.claims;
      });

    if (super_admin) {
      logger.debug(
        `Requesting administrator ${administratorRoarUid} is a super admin. Returning all administrations`
      );

      const administrationsCollection = db.collection("administrations");

      let administrationsQuery: CollectionReference | Query =
        administrationsCollection;
      const filterComponents: Filter[] = [];

      if (testData !== null) {
        filterComponents.push(Filter.where("testData", "==", testData));
      }
      if (restrictToOpenAdministrations) {
        filterComponents.push(Filter.where("dateClosed", ">", new Date()));
      }

      if (filterComponents.length > 0) {
        administrationsQuery = administrationsQuery.where(
          Filter.and(...filterComponents)
        );
      }

      const administrations = await transaction
        .get(administrationsQuery)
        .then((snapshot) => {
          return snapshot.docs.map((doc) => ({
            id: doc.id,
            ...doc.data(),
          }));
        });

      logger.debug(`Found administrations for ${administratorRoarUid}`, {
        administrations,
      });

      if (idsOnly) {
        return administrations.map((admin) => admin.id);
      } else {
        return administrations;
      }
    }

    if (verbose) {
      logger.debug(
        `Requesting administrator ${administratorRoarUid} has adminOrgs. Returning matching administrations`,
        { adminOrgs }
      );
    }

    if (!adminOrgs) {
      return [];
    }

    const { administrations, administrationData } =
      await getAdministrationsFromOrgs({
        orgs: adminOrgs,
        transaction,
        restrictToOpenAdministrations, // Restrict to open assignments. If a user has been removed from an org, we want to keep old assignments that they completed.
        idsOnly,
        testData: testData,
        useReadOrgs: true,
      });

    if (verbose) {
      logger.debug(`Found administrations for ${administratorRoarUid}`, {
        administrations,
      });
    }

    if (idsOnly) {
      return administrations;
    }

    const result = Object.entries(administrationData).map(([id, data]) => ({
      id,
      ...data,
    }));

    return result;
  });
};
