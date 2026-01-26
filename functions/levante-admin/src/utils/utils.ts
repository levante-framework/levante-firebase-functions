import type { ParamsOf } from "firebase-functions/v2";
import type {
  Change,
  DocumentSnapshot,
  FirestoreEvent,
  QueryDocumentSnapshot,
} from "firebase-functions/v2/firestore";
import { GoogleAuth } from "google-auth-library";
import _invert from "lodash-es/invert.js";
import _without from "lodash-es/without.js";
import type { IOrgsMap } from "../interfaces.js";
import { config } from "./config.js";
import { Timestamp } from "firebase-admin/firestore";

/**
 * Checks if the functions are running in an emulator environment.
 * @returns {boolean} - Returns true if the functions are running in an emulator environment, otherwise false.
 */
export const isEmulated = () =>
  process.env.FUNCTIONS_EMULATOR === "true" || config.useEmulator;

/**
 * A map from singular Firestore collection names to their plural forms.
 */
const plurals = {
  group: "groups",
  district: "districts",
  school: "schools",
  class: "classes",
  family: "families",
  administration: "administrations",
  user: "users",
  assignment: "assignments",
  run: "runs",
  trial: "trials",
};

export const MAX_TRANSACTIONS = 100;

/**
 * Given a singular Firestore collection name, returns the corresponding plural form.
 * If the singular name is already plural, returns the singular name itself.
 *
 * @param {string} singular - The singular Firestore collection name.
 * @returns {string} The plural form of the given singular name.
 * @throws An error if the singular name is not found in the `plurals` map.
 */
export const pluralizeFirestoreCollection = (singular: string) => {
  if (Object.values(plurals).includes(singular)) return singular;

  const plural = plurals[singular];
  if (plural) return plural;

  throw new Error(
    `There is no plural Firestore collection for the ${singular}`
  );
};

/**
 * Given a plural Firestore collection name, returns the corresponding singular form.
 * If the plural name is not found in the `plurals` map, returns an error.
 *
 * @param {string} plural - The plural Firestore collection name.
 * @returns {string} The singular form of the given plural name, or an error if not found.
 * @throws An error if the plural name is not found in the `plurals` map.
 */
export const singularizeFirestoreCollection = (plural: string) => {
  if (Object.values(_invert(plurals)).includes(plural)) return plural;

  const singular = _invert(plurals)[plural];
  if (singular) return singular;

  throw new Error(`There is no Firestore collection ${plural}`);
};

export const orgTypes = ["districts", "schools", "classes", "groups"];

/**
 * Create an empty IOrgsMap
 *
 * @returns An empty IOrgsMap
 */
export const emptyOrgs = (): IOrgsMap => ({
  current: [],
  all: [],
  dates: {},
});

/**
 * A type representing a Firestore event processed by the onDocumentWritten Firebase cloud functions trigger.
 */
export type DocumentWrittenEvent = FirestoreEvent<
  Change<DocumentSnapshot> | undefined,
  ParamsOf<string>
>;

/**
 * A type representing a Firestore event processed by the onDocumentUpdated Firebase cloud functions trigger.
 */
export type DocumentUpdatedEvent = FirestoreEvent<
  Change<QueryDocumentSnapshot> | undefined,
  ParamsOf<string>
>;

/**
 * A type representing a Firestore event processed by the onDocumentDeleted Firebase cloud functions trigger.
 */
export type DocumentDeletedEvent = FirestoreEvent<
  QueryDocumentSnapshot | undefined,
  ParamsOf<string>
>;

/**
 * A type representing a Firestore event processed by the onDocumentCreated Firebase cloud functions trigger.
 */
export type DocumentCreatedEvent = FirestoreEvent<
  QueryDocumentSnapshot | undefined,
  ParamsOf<string>
>;

export function getDocRef(db, collection, uid) {
  return db.collection(collection).doc(uid);
}

export const delay = (milliseconds: number) => {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
};

/**
 * Get the URL of a given v2 cloud function.
 *
 * @param {string} name the function's name
 * @param {string} location the function's location
 * @return {Promise<string>} The URL of the function
 */
export const getFunctionUrl = async (name, location = "us-central1") => {
  // Emulator handles routing internally
  if (process.env.FUNCTIONS_EMULATOR === "true") {
    console.log("Emulator detected, no function url needed");
    return undefined;
  }

  const auth = new GoogleAuth({
    scopes: "https://www.googleapis.com/auth/cloud-platform",
  });
  const projectId = await auth.getProjectId();
  const url =
    "https://cloudfunctions.googleapis.com/v2beta/" +
    `projects/${projectId}/locations/${location}/functions/${name}`;

  const client = await auth.getClient();
  const res = await client.request({ url });
  const uri = (res.data as any)?.serviceConfig?.uri;
  if (!uri) {
    throw new Error(`Unable to retreive uri for function at ${url}`);
  }
  return uri;
};

export const doesDocExist = async (docRef, transaction) => {
  return transaction.get(docRef).then((docSnap) => {
    return docSnap.exists;
  });
};

/**
 * Recursively remove all fields with `undefined` values from an object.
 *
 * This function traverses objects and arrays, removing any properties or elements
 * with `undefined` values. It operates recursively, so it cleans nested objects and arrays
 * as well. Primitive values (non-object/array) are returned as-is.
 *
 * @param {any} obj - The object or value to clean. Can be an object, array, or any primitive type.
 * @returns A new object or value with all `undefined` fields removed. If the input is not an object or array,
 *          the original value is returned.
 *
 * @example
 * ```typescript
 * const input = {
 *   a: 1,
 *   b: undefined,
 *   c: {
 *     d: 3,
 *     e: undefined,
 *     f: { g: undefined, h: 4 }
 *   },
 *   i: [undefined, { j: 5, k: undefined }]
 * };
 *
 * const cleaned = removeUndefinedFields(input);
 * console.log(cleaned);
 * // Output: { a: 1, c: { d: 3, f: { h: 4 } }, i: [{ j: 5 }] }
 * ```
 */
export const removeUndefinedFields = (obj: any): any => {
  if (Array.isArray(obj)) {
    return _without(obj, undefined);
  } else if (obj && typeof obj === "object") {
    return Object.entries(obj).reduce((acc, [key, value]) => {
      const cleanedValue = removeUndefinedFields(value);
      if (cleanedValue !== undefined) {
        acc[key] = cleanedValue;
      }
      return acc;
    }, {} as any);
  }
  return obj;
};

export const parseTimestamp = (timestamp: Date | Timestamp): Date => {
  if (
    (timestamp as any)._seconds != undefined &&
    (timestamp as any)._nanoseconds != undefined
  ) {
    return new Date(
      new Timestamp(
        (timestamp as any)._seconds,
        (timestamp as any)._nanoseconds
      ).toDate()
    );
  }

  if ("toDate" in timestamp) {
    return new Date((timestamp as Timestamp).toDate());
  }

  return new Date(timestamp);
};
