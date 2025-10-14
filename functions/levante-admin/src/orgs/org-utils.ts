/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  getFirestore,
  FieldValue,
  FieldPath,
  Filter,
} from "firebase-admin/firestore";
import type {
  DocumentData,
  DocumentSnapshot,
  Transaction,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import _chunk from "lodash-es/chunk.js";
import _cloneDeep from "lodash-es/cloneDeep.js";
import _get from "lodash-es/get.js";
import _isEmpty from "lodash-es/isEmpty.js";
import _toPairs from "lodash-es/toPairs.js";
import _union from "lodash-es/union.js";
import _uniq from "lodash-es/uniq.js";
import _without from "lodash-es/without.js";
import type { IOrgsList } from "../interfaces.js";
import { ORG_NAMES } from "../interfaces.js";
import { doesDocExist, pluralizeFirestoreCollection } from "../utils/utils.js";
import { getAdministrationsFromOrgs } from "../administrations/administration-utils.js";
import {
  summarizeIdListForLog,
  summarizeOrgsForLog,
} from "../utils/logging.js";

/**
 * Get schools and subgroup from a specified district.
 *
 * @param {string} districtId - The ID of the district
 * @param {Transaction} transaction - The transaction with which to read DB documents
 * @param {boolean} includeArchived - Whether to include archived orgs. Defaults to false.
 * @returns {Promise<{ schools: string[]; subGroups: string[] }>} An object containing arrays of IDs for the schools and subgroups
 */
export const getSchoolsAndSubGroupsFromDistrict = async (
  districtId: string,
  transaction: Transaction,
  includeArchived = false
) => {
  const db = getFirestore();
  const districtRef = db.collection("districts").doc(districtId);
  const districtDoc = await transaction.get(districtRef);
  let schools: string[] = [];
  let subGroups: string[] = [];
  if (districtDoc.exists) {
    schools = districtDoc.data()!.schools || [];
    subGroups = districtDoc.data()!.subGroups || [];
  } else {
    throw new HttpsError(
      "not-found",
      `The district ${districtId} does not exist in the database.`
    );
  }

  const schoolsCollection = db.collection("schools");

  const schoolFilterComponents = [Filter.where("districtId", "==", districtId)];

  if (!includeArchived) {
    schoolFilterComponents.push(Filter.where("archived", "==", false));
  }

  const query = schoolsCollection.where(Filter.and(...schoolFilterComponents));
  const querySnapshot = await transaction.get(query);
  querySnapshot.forEach((documentSnapshot) => {
    schools = _union(schools, [documentSnapshot.id]);
  });

  const groupsCollection = db.collection("groups");

  const groupFilterComponents = [Filter.where("parentOrgId", "==", districtId)];

  if (!includeArchived) {
    groupFilterComponents.push(Filter.where("archived", "==", false));
  }

  const subGroupQuery = groupsCollection.where(
    Filter.and(...groupFilterComponents)
  );
  const subGroupQuerySnapshot = await transaction.get(subGroupQuery);
  subGroupQuerySnapshot.forEach((documentSnapshot) => {
    subGroups = _union(subGroups, [documentSnapshot.id]);
  });

  return {
    schools,
    subGroups,
  };
};

/**
 * Get classes and subgroup from a specified school.
 *
 * @param {string} schoolId - The ID of the school
 * @param {Transaction} transaction - The transaction with which to read DB documents
 * @param {boolean} includeArchived - Whether to include archived orgs. Defaults to false.
 * @returns {Promise<string[]>} An array of subgroup IDs from the specified class
 */
export const getClassesAndSubGroupsFromSchool = async (
  schoolId: string,
  transaction: Transaction,
  includeArchived = false
) => {
  const db = getFirestore();
  const schoolRef = db.collection("schools").doc(schoolId);
  const schoolDoc = await transaction.get(schoolRef);
  let classes: string[] = [];
  let subGroups: string[] = [];
  if (schoolDoc.exists) {
    classes = schoolDoc.data()!.classes || [];
  } else {
    throw new HttpsError(
      "not-found",
      `The school ${schoolId} does not exist in the database.`
    );
  }

  const classesCollection = db.collection("classes");

  const classFilterComponents = [Filter.where("schoolId", "==", schoolId)];

  if (!includeArchived) {
    classFilterComponents.push(Filter.where("archived", "==", false));
  }

  const query = classesCollection.where(Filter.and(...classFilterComponents));
  const querySnapshot = await transaction.get(query);
  querySnapshot.forEach((documentSnapshot) => {
    classes = _union(classes, [documentSnapshot.id]);
  });

  const groupsCollection = db.collection("groups");

  const groupFilterComponents = [Filter.where("parentOrgId", "==", schoolId)];

  if (!includeArchived) {
    groupFilterComponents.push(Filter.where("archived", "==", false));
  }

  const subGroupQuery = groupsCollection.where(
    Filter.and(...groupFilterComponents)
  );
  const subGroupQuerySnapshot = await transaction.get(subGroupQuery);
  subGroupQuerySnapshot.forEach((documentSnapshot) => {
    subGroups = _union(subGroups, [documentSnapshot.id]);
  });

  return {
    classes,
    subGroups,
  };
};

/**
 * Get classes and subgroup from a specified district.
 *
 * @param {string} districtId - The ID of the district
 * @param {Transaction} transaction - The transaction with which to read DB documents
 * @param {boolean} includeArchived - Whether to include archived orgs. Defaults to false.
 * @returns {Promise<string[]>} An array of subgroup IDs from the specified class
 */
export const getClassesAndSubGroupsFromDistrict = async (
  districtId: string,
  transaction: Transaction,
  includeArchived = false
) => {
  const db = getFirestore();
  let { schools, subGroups } = await getSchoolsAndSubGroupsFromDistrict(
    districtId,
    transaction,
    includeArchived
  );
  const classes: string[] = [];
  for (const school of schools) {
    const { classes } = await getClassesAndSubGroupsFromSchool(
      school,
      transaction,
      includeArchived
    );
    classes.push(...classes);
  }

  const classesCollection = db.collection("classes");
  const classFilterComponents = [Filter.where("districtId", "==", districtId)];

  if (!includeArchived) {
    classFilterComponents.push(Filter.where("archived", "==", false));
  }

  const query = classesCollection.where(Filter.and(...classFilterComponents));
  const querySnapshot = await transaction.get(query);
  querySnapshot.forEach((documentSnapshot) => {
    classes.push(documentSnapshot.id);
  });

  const groupsCollection = db.collection("groups");
  for (const classChunk of _chunk(_uniq(classes), 30)) {
    const groupFilterComponents = [
      Filter.where("parentOrgId", "in", classChunk),
    ];

    if (!includeArchived) {
      groupFilterComponents.push(Filter.where("archived", "==", false));
    }

    const subGroupQuery = groupsCollection.where(
      Filter.and(...groupFilterComponents)
    );

    const subGroupQuerySnapshot = await transaction.get(subGroupQuery);
    subGroupQuerySnapshot.forEach((documentSnapshot) => {
      subGroups = _union(subGroups, [documentSnapshot.id]);
    });
  }

  return {
    classes: _uniq(classes),
    subGroups,
  };
};

/**
 * Get subgroups from a specified group.
 *
 * @param {string} groupId - The ID of the group
 * @param {Transaction} transaction - The transaction with which to read DB documents
 * @param {boolean} includeArchived - Whether to include archived orgs. Defaults to false.
 * @returns {Promise<string[]>} An array of subgroup IDs from the specified class
 */
export const getSubGroupsFromGroup = async (
  groupId: string,
  transaction: Transaction,
  includeArchived = false
) => {
  const db = getFirestore();
  const groupRef = db.collection("groups").doc(groupId);
  const groupDoc = await transaction.get(groupRef);
  let subgroups: string[] = [];
  if (groupDoc.exists) {
    // If group document exists, get existing subgroups if they exist
    subgroups = groupDoc.data()!.subGroups || [];
  } else {
    // No group with that ID exists.
    throw new HttpsError(
      "not-found",
      `The group ${groupId} does not exist in the database.`
    );
  }

  // Query for any group with this groupID as the parentOrgId.
  // Add each one to the list of subgroups.
  const groupsCollection = db.collection("groups");

  const groupQueryComponents = [Filter.where("parentOrgId", "==", groupId)];

  if (!includeArchived) {
    groupQueryComponents.push(Filter.where("archived", "==", false));
  }

  const query = groupsCollection.where(Filter.and(...groupQueryComponents));
  const querySnapshot = await transaction.get(query);
  querySnapshot.forEach((documentSnapshot) => {
    subgroups = _union(subgroups, [documentSnapshot.id]);
  });

  return subgroups;
};


/**
 * Get subgroups from a specified class.
 *
 * @param {string} classId - The ID of the class
 * @param {Transaction} transaction - The transaction with which to read DB documents
 * @param {boolean} includeArchived - Whether to include archived orgs. Defaults to false.
 * @returns {Promise<string[]>} An array of subgroup IDs from the specified class
 */
export const getSubGroupsFromClass = async (
  classId: string,
  transaction: Transaction,
  includeArchived = false
) => {
  const db = getFirestore();
  const classRef = db.collection("classes").doc(classId);
  const classDoc = await transaction.get(classRef);
  let subgroups: string[] = [];
  if (classDoc.exists) {
    // If class document exists, get existing subgroups if they exist
    subgroups = classDoc.data()!.subGroups || [];
  } else {
    // No group with that ID exists.
    throw new HttpsError(
      "not-found",
      `The class ${classId} does not exist in the database.`
    );
  }

  // Query for any group with this groupID as the parentOrgId.
  // Add each one to the list of subgroups.
  const groupsCollection = db.collection("groups");

  const groupQueryComponents = [Filter.where("parentOrgId", "==", classId)];

  if (!includeArchived) {
    groupQueryComponents.push(Filter.where("archived", "==", false));
  }

  const query = groupsCollection.where(Filter.and(...groupQueryComponents));
  const querySnapshot = await transaction.get(query);
  querySnapshot.forEach((documentSnapshot) => {
    subgroups = _union(subgroups, [documentSnapshot.id]);
  });

  return subgroups;
};

/**
 * Filter non-existent organizations from an organization list.
 *
 * @param {IOrgsList} orgs - the input organization lists
 * @param {Transaction} transaction - the transaction with which to read DB documents
 * @return {IOrgsList} the existing orgs
 */
export const getOnlyExistingOrgs = async (
  orgs: IOrgsList,
  transaction: Transaction
) => {
  const db = getFirestore();
  const existingOrgs = _cloneDeep(orgs);

  for (const [orgType, _orgs] of Object.entries(orgs)) {
    if (_orgs.length > 0) {
      const docRefs = _orgs.map((orgId) => db.collection(orgType).doc(orgId));
      const docSnapshots = await transaction.getAll(...docRefs);
      const existingOrgIds = docSnapshots
        .filter((doc) => doc.exists)
        .map((doc) => doc.id);
      existingOrgs[orgType] = existingOrgIds;
    } else {
      existingOrgs[orgType] = [];
    }
  }

  return existingOrgs;
};

/**
 * Convert an object of organization arrays into an object of "exhaustive" org
 * arrays. By "exhaustive," we mean that any organization in the org list must
 * have each of it's dependent organizations explicitly listed in the same
 * object. For example, if district1 is in the ``districts`` list and district1
 * contains schools A and B. Then schools A and B should also be in the
 * ``schools`` list. Likewise if school A contains classes alpha and beta, then
 * classes alpha and beta should also be in the administration's ``classes``
 * list.
 *
 * @param {IOrgsList} orgs - the input organization lists
 * @param {Transaction} transaction - the transaction with which to read DB documents
 * @param {boolean} includeArchived - Whether to include archived orgs. Defaults to false.
 * @return {IOrgsList} the exhaustive org lists
 */
export const getExhaustiveOrgs = async ({
  orgs,
  transaction,
  includeArchived = false,
}: {
  orgs: IOrgsList;
  transaction: Transaction;
  includeArchived?: boolean;
}) => {
  const exhaustiveOrgs = _cloneDeep(orgs);
  for (const _district of _get(orgs, "districts", [])) {
    const { subGroups, schools } = await getSchoolsAndSubGroupsFromDistrict(
      _district,
      transaction,
      includeArchived
    );
    exhaustiveOrgs.schools = _union(exhaustiveOrgs.schools, schools);
    if (!_isEmpty(subGroups)) {
      exhaustiveOrgs.groups = _union(exhaustiveOrgs.groups || [], subGroups);
    }
    const { classes, subGroups: classSubGroups } =
      await getClassesAndSubGroupsFromDistrict(
        _district,
        transaction,
        includeArchived
      );
    exhaustiveOrgs.classes = _union(exhaustiveOrgs.classes, classes);
    if (!_isEmpty(classSubGroups)) {
      exhaustiveOrgs.groups = _union(
        exhaustiveOrgs.groups || [],
        classSubGroups
      );
    }
  }

  for (const _school of _get(exhaustiveOrgs, "schools", [])) {
    const { classes, subGroups } = await getClassesAndSubGroupsFromSchool(
      _school,
      transaction,
      includeArchived
    );
    exhaustiveOrgs.classes = _union(exhaustiveOrgs.classes, classes);
    if (!_isEmpty(subGroups)) {
      exhaustiveOrgs.groups = _union(exhaustiveOrgs.groups || [], subGroups);
    }
  }

  for (const _group of _get(exhaustiveOrgs, "groups", [])) {
    exhaustiveOrgs.groups = _union(
      exhaustiveOrgs.groups,
      await getSubGroupsFromGroup(_group, transaction, includeArchived)
    );
  }

  return exhaustiveOrgs;
};

/**
 * Convert an object of organization arrays into an object containing all
 * parent organizations as well.
 * For example, suppose district1 contains schools A and B and school A contains
 * classes alpha and beta. Then if class alpha in in the input ``orgs`` object,
 * then the output ``readOrgs`` will contain class alpha, school A, and district1.
 *
 * @param {IOrgsList} orgs - the input organization lists
 * @param {Transaction} transaction - the transaction with which to read DB documents
 * @return {IOrgsList} the read org lists
 */
export const getReadOrgs = async (
  orgs: IOrgsList,
  transaction: Transaction
): Promise<IOrgsList> => {
  const db = getFirestore();
  const readOrgs = _cloneDeep(orgs);

  for (const _class of _get(orgs, "classes", [])) {
    const classRef = db.collection("classes").doc(_class);
    const classDoc = await transaction.get(classRef);
    if (classDoc.exists) {
      const schoolId = classDoc.data()!.schoolId;
      const districtId = classDoc.data()!.districtId;

      if (schoolId) {
        readOrgs.schools = _union(readOrgs.schools ?? [], [schoolId]);
      }

      if (districtId) {
        readOrgs.districts = _union(readOrgs.districts ?? [], [districtId]);
      }
    }
  }

  for (const _school of _get(orgs, "schools", [])) {
    const schoolRef = db.collection("schools").doc(_school);
    const schoolDoc = await transaction.get(schoolRef);
    if (schoolDoc.exists) {
      const districtId = schoolDoc.data()!.districtId;

      if (districtId) {
        readOrgs.districts = _union(readOrgs.districts ?? [], [districtId]);
      }
    }
  }

  for (const _group of _get(orgs, "groups", [])) {
    const groupRef = db.collection("groups").doc(_group);
    const groupDoc = await transaction.get(groupRef);
    if (groupDoc.exists) {
      const parentOrgId = groupDoc.data()!.parentOrgId;
      const parentOrgType = groupDoc.data()!.parentOrgType;

      if (parentOrgType && parentOrgId) {
        readOrgs[pluralizeFirestoreCollection(parentOrgType)] = _union(
          readOrgs[pluralizeFirestoreCollection(parentOrgType)],
          [parentOrgId]
        );
      }
    }
  }

  return readOrgs;
};

/**
 * Get minimal orgs by removing the nested orgs.
 *
 * @param {IOrgsList} orgs - The input organization lists
 * @param {Transaction} transaction - The transaction with which to read DB documents
 * @returns {IOrgsList} The minimal orgs
 */
export const getMinimalOrgs = async (
  orgs: IOrgsList,
  transaction: Transaction
) => {
  const minimalOrgs = _cloneDeep(orgs);
  for (const _district of _get(orgs, "districts", [])) {
    const { schools } = await getSchoolsAndSubGroupsFromDistrict(
      _district,
      transaction
    );
    const { classes } = await getClassesAndSubGroupsFromDistrict(
      _district,
      transaction
    );
    minimalOrgs.schools = _without(minimalOrgs.schools, ...schools);
    minimalOrgs.classes = _without(minimalOrgs.classes, ...classes);
  }

  for (const _school of _get(minimalOrgs, "schools", [])) {
    const { classes } = await getClassesAndSubGroupsFromSchool(
      _school,
      transaction
    );
    minimalOrgs.classes = _without(minimalOrgs.classes, ...classes);
  }

  return minimalOrgs;
};

/**
 * Get users from the specified orgs.
 *
 * @param {IOrgsList} orgs - The input organization lists
 * @param {Transaction} transaction - The transaction with which to read DB documents
 * @param {string[]} userTypes - The user types to get (default: ["student", "parent", "teacher"])
 * @param {boolean} includeArchived - Whether to include archived orgs. Defaults to false.
 * @returns {Promise<string[]>} An array of user IDs from the specified orgs
 */
export const getUsersFromOrgs = async ({
  orgs,
  transaction,
  userTypes = ["student", "parent", "teacher"],
  includeArchived = false,
}: {
  orgs: IOrgsList;
  transaction: Transaction;
  userTypes?: string[];
  includeArchived?: boolean;
}) => {
  const db = getFirestore();
  let users: string[] = [];
  // First, we iterate over the different org types and grab the users in each of them.
  for (const [_type, _orgs] of _toPairs(orgs)) {
    // Because ``array-contains-any`` queries are limited to 10 comparisons each time,
    // we chuck the _orgs array into chunks of 10.
    for (const _orgChunk of _chunk(_orgs, 10)) {
      // We then query for the current org, limiting the number of results to ``limit``.
      const queryLimit = 100;
      // Do the first query before entering the pagination loop.
      const fieldPath = new FieldPath(_type, "current");

      // Only students should get assignments so query on orgs and students.
      // LEVANTE assigns questionnaires as assingments to teachers and parents.
      const userTypeFilters = userTypes.map((userType) =>
        Filter.where("userType", "==", userType)
      );

      const filterComponents = [
        Filter.where(fieldPath, "array-contains-any", _orgChunk),
        Filter.or(...userTypeFilters),
      ];

      if (!includeArchived) {
        filterComponents.push(Filter.where("archived", "==", false));
      }

      const andFilter = Filter.and(...filterComponents);

      const firstQuery = db
        .collection("users")
        .where(andFilter)
        .limit(queryLimit);
      let querySnapshot = await transaction.get(firstQuery);

      // Write results for the first query.
      querySnapshot.forEach((documentSnapshot) => {
        users = _union(users, [documentSnapshot.id]);
      });

      let numDocs = querySnapshot.docs.length;
      // If the query did not exhaust the results, continue paging.
      while (numDocs === queryLimit) {
        const lastVisible = querySnapshot.docs[numDocs - 1];
        const nextQuery = db
          .collection("users")
          .where(andFilter)
          .startAfter(lastVisible)
          .limit(queryLimit);
        querySnapshot = await transaction.get(nextQuery);
        querySnapshot.forEach((documentSnapshot) => {
          users = _union(users, [documentSnapshot.id]);
        });
        numDocs = querySnapshot.docs.length;
      }
    }
  }

  logger.debug("found users from orgs", {
    orgSummary: summarizeOrgsForLog(orgs),
    userSummary: summarizeIdListForLog(users),
  });
  return users;
};

/**
 * Chunks an IOrgsList into smaller IOrgsLists of a specified size.
 *
 * This function is useful when dealing with large amounts of data that need to be processed in smaller chunks.
 * It iterates over the properties of the input IOrgsList and divides each property's array into smaller chunks.
 *
 * @param {IOrgsList} orgs - The input organization lists.
 * @param {number} chunkSize - The size of each chunk.
 * @returns An array of smaller IOrgsLists, each containing a chunk of the original data.
 */
export function chunkOrgs(orgs: IOrgsList, chunkSize: number): IOrgsList[] {
  const indices: { [key in keyof IOrgsList]: number } = {
    districts: 0,
    schools: 0,
    classes: 0,
    groups: 0,
  };

  const chunks: IOrgsList[] = [];
  let orgsLeft = true;

  while (orgsLeft) {
    const chunk: IOrgsList = {};
    let count = 0;
    orgsLeft = false;

    for (const prop of Object.keys(indices)) {
      const _orgs = orgs[prop];
      if (_orgs && indices[prop] < _orgs.length) {
        orgsLeft = true;
        const startIdx = indices[prop];
        const endIdx = Math.min(startIdx + chunkSize - count, _orgs.length);
        chunk[prop] = _orgs.slice(startIdx, endIdx);
        count += endIdx - startIdx;
        indices[prop] = endIdx;

        if (count >= chunkSize) {
          break;
        }
      }
    }

    if (count > 0) {
      chunks.push(chunk);
    }
  }

  return chunks;
}

export const unenrollOrg = async ({
  orgType,
  orgId,
  orgDocSnapshot,
  modifyAssignedAdministrations = true,
}: {
  orgType: string;
  orgId: string;
  orgDocSnapshot?: DocumentSnapshot;
  modifyAssignedAdministrations?: boolean;
}) => {
  const db = getFirestore();

  const dependentOrgsToUnenroll: {
    groups: string[];
    classes: string[];
  } = {
    groups: [],
    classes: [],
  };

  await db
    .runTransaction(
      async (transaction) => {
        const pluralOrgType = pluralizeFirestoreCollection(orgType);
        const orgDocRef = db.collection(pluralOrgType).doc(orgId);

        let orgData: DocumentData;
        let orgDocExists: boolean;

        // First grab the org data. If the orgDocSnapshot is provided, use it.
        if (orgDocSnapshot) {
          orgData = orgDocSnapshot.data() ?? {};
          orgDocExists = orgDocSnapshot.exists;
        } else {
          const { data, exists } = await transaction
            .get(orgDocRef)
            .then((docSnap) => {
              return {
                data: docSnap.data() ?? {},
                exists: docSnap.exists,
              };
            });
          orgData = data;
          orgDocExists = exists;
        }

        // Find all **open** administrations assigned to this org
        const { administrations } = modifyAssignedAdministrations
          ? await getAdministrationsFromOrgs({
              orgs: { [pluralOrgType]: [orgId] },
              transaction,
              restrictToOpenAdministrations: true, // Restrict to open administrations
            })
          : { administrations: [] };

        const { districtId, schoolId, parentOrgId, parentOrgType } =
          orgData;
        const districtIdExists = districtId
          ? await doesDocExist(
              db.collection("districts").doc(districtId),
              transaction
            )
          : false;
        const schoolIdExists = schoolId
          ? await doesDocExist(
              db.collection("schools").doc(schoolId),
              transaction
            )
          : false;
        const parentOrgIdExists =
          parentOrgType && parentOrgId
            ? await doesDocExist(
                db
                  .collection(pluralizeFirestoreCollection(parentOrgType))
                  .doc(parentOrgId),
                transaction
              )
            : false;

        // And remove the org from the assigned orgs for each administration.
        for (const administrationId of administrations) {
          const administrationDocRef = db
            .collection("administrations")
            .doc(administrationId);
          const readOrgsFieldPath = new FieldPath("readOrgs", pluralOrgType);
          const minimalOrgsFieldPath = new FieldPath(
            "minimalOrgs",
            pluralOrgType
          );
          transaction.update(
            administrationDocRef,
            pluralOrgType,
            FieldValue.arrayRemove(orgId),
            readOrgsFieldPath,
            FieldValue.arrayRemove(orgId),
            minimalOrgsFieldPath,
            FieldValue.arrayRemove(orgId)
          );
        }

        // Unenroll subGroups (any org type can have subgroups)
        for (const subGroupId of orgData.subGroups ?? []) {
          dependentOrgsToUnenroll.groups.push(subGroupId);
        }

        // If the org is a school, remove it from it's district and archive all of its classes.
        if (pluralOrgType === "schools") {
          if (orgData.districtId && districtIdExists) {
            const districtDocRef = db
              .collection("districts")
              .doc(orgData.districtId);

            transaction.set(
              districtDocRef,
              {
                schools: FieldValue.arrayRemove(orgId),
                archivedSchools: FieldValue.arrayUnion(orgId),
              },
              { merge: true }
            );
          }

          for (const classId of orgData.classes ?? []) {
            dependentOrgsToUnenroll.classes.push(classId);
          }
        }

        // If the org is a class, remove it from it's school.
        if (pluralOrgType === "classes") {
          if (orgData.schoolId && schoolIdExists) {
            const schoolDocRef = db.collection("schools").doc(orgData.schoolId);

            transaction.set(
              schoolDocRef,
              {
                classes: FieldValue.arrayRemove(orgId),
                archivedClasses: FieldValue.arrayUnion(orgId),
              },
              { merge: true }
            );
          }
        }

        // If the org is a family, it can only have subgroups.
        // Subgroups have already been unenrolled above.

        // If the org is a group, remove it from its parentOrg and family.
        if (pluralOrgType === "groups") {
          if (
            orgData.parentOrgId &&
            orgData.parentOrgType &&
            parentOrgIdExists
          ) {
            const parentOrgDocRef = db
              .collection(pluralizeFirestoreCollection(orgData.parentOrgType))
              .doc(orgData.parentOrgId);

            transaction.set(
              parentOrgDocRef,
              {
                subGroups: FieldValue.arrayRemove(orgId),
                archivedSubGroups: FieldValue.arrayUnion(orgId),
              },
              { merge: true }
            );
          }
        }

        // Finally mark this org as archived.
        if (orgDocExists) {
          transaction.update(orgDocRef, {
            archived: true,
            lastModified: FieldValue.serverTimestamp(),
          });
        }

        return orgDocRef.path;
      },
      { maxAttempts: 1000 }
    )
    .then((orgDocPath) => {
      logger.debug(`Unenrolled ${orgDocPath}`);
    });

  // Store promises for unenrolling subordinate orgs.
  const promises: Promise<void>[] = [];

  for (const classId of dependentOrgsToUnenroll.classes) {
    promises.push(
      unenrollOrg({
        orgType: "classes",
        orgId: classId,
        modifyAssignedAdministrations,
      })
    );
  }

  for (const subGroupId of dependentOrgsToUnenroll.groups) {
    promises.push(
      unenrollOrg({
        orgType: "groups",
        orgId: subGroupId,
        modifyAssignedAdministrations,
      })
    );
  }

  await Promise.all(promises);
};

export const isEmptyOrgs = (orgs: IOrgsList) => {
  const allOrgIds: string[] = [];
  for (const orgType of ORG_NAMES) {
    allOrgIds.push(...(orgs[orgType] ?? []));
  }

  return allOrgIds.length === 0;
};
