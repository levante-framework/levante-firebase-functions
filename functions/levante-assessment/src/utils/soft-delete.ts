import { logger } from "firebase-functions/v2";
import { Firestore, getFirestore } from "firebase-admin/firestore";
import { onDocumentDeleted } from "firebase-functions/v2/firestore";

/**
 * Interface representing the configuration of the cloud function trigger.
 */
interface ITrigger {
  /* An array of collections to be monitored for document deletions. */
  collections: string[];
  /* The path pattern for the trigger. */
  path: string;
  /* An array of parameter keys for the trigger. */
  paramKeys: string[];
}

/**
 * Constructs a trigger configuration object based on the provided collections.
 * @param {string[]} triggerCollections - An array of collections to be monitored for document deletions.
 * @returns {ITrigger} An object representing the trigger configuration.
 */
const constructTrigger = (triggerCollections: string[]): ITrigger => {
  // e.g. triggerCollections = ["users"] => "users/{doc0}"
  // e.g. triggerCollections = ["users", "runs"]
  // e.g. triggerCollections = ["users", "runs", "trials"]
  const triggerDocs = [...Array(triggerCollections.length).keys()].map(
    (key) => `doc${key}`
  );
  const triggerPairs = triggerDocs.map(
    (triggerDoc, index) => `${triggerCollections[index]}/{${triggerDoc}}`
  );
  return {
    collections: triggerCollections,
    path: triggerPairs.join("/"),
    paramKeys: triggerDocs,
  };
};

/**
 * Generates a new collection ID with a "deleted-" prefix.
 * @param {string} collectionId The original collection ID.
 * @returns {string} A new collection ID with a "deleted-" prefix.
 */
const softDeleteCollectionId = (collectionId: string) =>
  `deleted-${collectionId}`;

/**
 * Creates document reference objects for the source and target collections.
 * @param {Firestore} db - The Firestore instance.
 * @param {string[]} collectionIds - An array of collection IDs to be monitored.
 * @param {string[]} docIds - An array of document IDs within the specified collections.
 * @returns An object containing the source and target document reference objects.
 */
const createDocRefs = (
  db: Firestore,
  collectionIds: string[],
  docIds: string[]
) => {
  const pathPairs = collectionIds.map((collection, index) => [
    collection,
    docIds[index],
  ]);
  const sourcePath = pathPairs.reduce(
    (acc, [collection, docId]) => `${acc}/${collection}/${docId}`,
    ""
  );
  const targetPath = pathPairs.reduce(
    (acc, [collection, docId]) =>
      `${acc}/${softDeleteCollectionId(collection)}/${docId}`,
    ""
  );
  return {
    source: db.doc(sourcePath),
    target: db.doc(targetPath),
  };
};

/**
 * Creates a Cloud Function that listens for document deletions and copies the deleted document's data to a "deleted" collection.
 * @param {string[]} triggerCollections - An array of collections to be monitored for document deletions.
 * @returns A Cloud Function that listens for document deletions and copies the deleted document's data to a "deleted" collection.
 */
export const createSoftDeleteCloudFunction = (triggerCollections: string[]) => {
  const trigger = constructTrigger(triggerCollections);
  return onDocumentDeleted(trigger.path, async (event) => {
    const snap = event.data;
    const docData = snap?.data();
    const params = trigger.paramKeys.map((key) => event.params[key]);

    const db = getFirestore();
    const docRefs = createDocRefs(db, trigger.collections, params);

    if (docData) {
      logger.debug(
        `Document at ${docRefs.source.path} deleted. ` +
          `Copying it's content to ${docRefs.target.path}`
      );
      await docRefs.target.set(docData);
    }
  });
};
