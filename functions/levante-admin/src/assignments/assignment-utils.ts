/* eslint-disable @typescript-eslint/no-non-null-assertion */
import {
  CollectionReference,
  DocumentData,
  DocumentReference,
  Timestamp,
  Transaction,
  getFirestore,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import _flatten from "lodash-es/flatten";
import _get from "lodash-es/get";
import _intersection from "lodash-es/intersection";
import _isEqual from "lodash-es/isEqual";
import _map from "lodash-es/map";
import _pick from "lodash-es/pick";
import _reduce from "lodash-es/reduce";
import _without from "lodash-es/without";
import {
  FieldPathsAndValues,
  IAdministration,
  IOrgsList,
  IUserData,
  ORG_NAMES,
} from "../interfaces.js";
import { getReadOrgs, isEmptyOrgs } from "../orgs/org-utils.js";
import { evaluateCondition } from "../administrations/conditions.js";
import { removeUndefinedFields } from "../utils/utils.js";
import {
  summarizeAssignmentForLog,
  summarizeAssessmentsForLog,
  summarizeIdListForLog,
} from "../utils/logging.js";

/**
 * Parse a Firestore Timestamp or Date instance
 *
 * @param {Date | Timestamp} timestamp - The Firestore Timestamp or Date instance.
 *
 * @returns {Date} The parsed Date instance.
 */
const parseTimestamp = (timestamp: Date | Timestamp): Date => {
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

/**
 * Removes an assignment document from a user.
 *
 * TODO: This removes assignments even if they are in progress or completed.
 * We should consider handling in progress and completed assignments differently.
 * Perhaps they get moved to a separate "archived" collection.
 * Discuss with the partnerships team.
 *
 * @param {string} userUid - The unique identifier of the user.
 * @param {string} administrationId - The unique identifier of the administration.
 * @param {Transaction} transaction - The Firestore transaction object.
 * @returns A Promise that resolves when the assignment is removed.
 */
const removeAssignmentFromUser = async (
  userUid: string,
  administrationId: string,
  transaction: Transaction
) => {
  const db = getFirestore();
  const assignmentRef = db
    .collection("users")
    .doc(userUid)
    .collection("assignments")
    .doc(administrationId);

  logger.debug(`Removing assignment ${administrationId} from user ${userUid}`);
  return transaction.delete(assignmentRef);
};

/**
 * Removes assignments from multiple users.
 *
 * @param {string[]} users - An array of unique identifiers of the users.
 * @param {string} administrationId - The unique identifier of the administration.
 * @param {Transaction} transaction - The Firestore transaction object.
 * @returns A Promise that resolves when all assignments are removed.
 */
export const removeAssignmentFromUsers = async (
  users: string[],
  administrationId: string,
  transaction: Transaction
) => {
  if (!users.length) {
    return [];
  }

  logger.debug(`Removing assignment ${administrationId} for users`, {
    userSummary: summarizeIdListForLog(users),
  });

  return Promise.all(
    _map(users, (user) =>
      removeAssignmentFromUser(user, administrationId, transaction)
    )
  );
};

/**
 * Prepare a new assignment for a user.
 *
 * @param {string} userUid - The unique identifier of the user.
 * @param {string} administrationId - The unique identifier of the administration.
 * @param {IAdministration} administrationData - The data of the administration.
 * @param {Transaction} transaction - The Firestore transaction object.
 * @returns A Promise that resolves with the assignment reference and data.
 */
const prepareNewAssignment = async (
  userUid: string,
  administrationId: string,
  administrationData: IAdministration,
  transaction: Transaction
) => {
  const db = getFirestore();
  const userRef = db.collection("users").doc(userUid);
  const assignmentRef = userRef.collection("assignments").doc(administrationId);

  // These are all of the orgs that have been assigned the administration.
  const assigningOrgs = _pick(administrationData, ORG_NAMES);
  // Now we need to get the intersection of all the assigningOrgs with all of the users orgs.
  const userData = await transaction.get(userRef);
  if (userData.exists) {
    const userOrgs = _pick(userData.data(), ORG_NAMES);

    const usersAssigningOrgs: IOrgsList = {};
    for (const orgName of ORG_NAMES) {
      usersAssigningOrgs[orgName] = _intersection(
        userOrgs[orgName]?.current,
        assigningOrgs[orgName]
      );
    }

    if (isEmptyOrgs(usersAssigningOrgs)) {
      return [undefined, undefined];
    }

    const userReadOrgs = await getReadOrgs(usersAssigningOrgs, transaction);

    const assessments: {
      taskId: string;
      optional?: boolean;
      params: { [key: string]: unknown };
      variantId: string;
      variantName: string;
    }[] = [];

    for (const assessment of _get(administrationData, "assessments")) {
      // Use conditions from administrationData to evaluate whether or not to assign to this user.
      const { conditions } = assessment;
      // Prepopulate the assignedAssessment, default to required (i.e., optional=false).
      const assignedAssessment = {
        taskId: assessment.taskId,
        optional: false,
        params: assessment.params,
        variantId: assessment.variantId,
        variantName: assessment.variantName,
      };

      if (conditions) {
        const { optional, assigned } = conditions;
        let pushAssessment = false;
        // Evaluate assigned first. The result of this evaluation dictates
        // whether or not we push the assessment to the user's
        // assignedAssessments array.
        if (assigned) {
          pushAssessment = evaluateCondition({
            userData: userData.data()! as IUserData,
            condition: assigned,
          });
        } else {
          // If the user supplied only optional conditions, then we assume that
          // they wanted to assign it to everyone.
          pushAssessment = true;
        }

        // Next, evaluate the optional condition. This only sets the `optional`
        // metadata. The `assigned` flag above is still responsible for pushing
        // the assessment to the user's assignedAssessments array.
        if (optional) {
          assignedAssessment.optional = evaluateCondition({
            userData: userData.data()! as IUserData,
            condition: optional,
          });
        }
        // No else block required here because we initialized the assignment with optional=false.

        if (pushAssessment) {
          assessments.push(assignedAssessment);
        }
      } else {
        // If no conditions are specified, assign as required to all users.
        assessments.push(assignedAssessment);
      }
    }

    if (assessments.length === 0) {
      return [undefined, undefined];
    }

    // Grab a copy of the user doc and remove org and assignment data, keeping
    // the rest to copy over into the assignment. Yay, denormalization!
    const {
      studentData = {},
      name = null,
      assessmentPid = null,
      assessmentUid = null,
      email = null,
      username = null,
    } = userData.data()!;

    const userDataCopy = {
      ...studentData,
      name,
      assessmentPid,
      assessmentUid,
      email,
      username,
    };

    const progress = assessments.reduce((acc, { taskId }) => {
      acc[taskId.replace(/-/g, "_")] = "assigned";
      return acc;
    }, {});

    const { dateOpened, dateClosed, dateCreated } = administrationData;
    const cleanedAssessments = removeUndefinedFields(assessments);

    if (!_isEqual(cleanedAssessments, assessments)) {
      logger.warn(
        `[prepareNewAssignment]: cleaned assessments do not match original assessments`,
        {
          administrationId,
          assignmentPath: assignmentRef.path,
          originalSummary: summarizeAssessmentsForLog(assessments),
          cleanedSummary: summarizeAssessmentsForLog(cleanedAssessments),
        }
      );
    }

    const assignmentData: DocumentData = {
      id: administrationId,
      started: false,
      completed: false,
      dateAssigned: new Date(),
      dateOpened: parseTimestamp(dateOpened),
      dateClosed: parseTimestamp(dateClosed),
      dateCreated: parseTimestamp(dateCreated),
      createdBy: administrationData.createdBy,
      legal: administrationData.legal ?? {},
      name: administrationData.name ?? "",
      publicName: administrationData.publicName ?? "",
      sequential: administrationData.sequential ?? false,
      assigningOrgs: usersAssigningOrgs,
      readOrgs: userReadOrgs,
      assessments,
      progress,
      userData: userDataCopy,
      testData: administrationData.testData ?? false,
      demoData: administrationData.demoData ?? false,
      lastSyncedFromAdministration: new Date(),
    };

    return [assignmentRef, assignmentData] as [DocumentReference, DocumentData];
  } else {
    return [undefined, undefined];
  }
};

/**
 * Adds a new assignment to multiple users.
 *
 * @param {string[]} users - An array of unique identifiers of the users.
 * @param {string} administrationId - The unique identifier of the administration.
 * @param {IAdministration} administrationData - The data of the administration.
 * @param {Transaction} transaction - The Firestore transaction object.
 * @returns A Promise that resolves with an array of assignment references and data.
 */
export const addAssignmentToUsers = async (
  users: string[],
  administrationId: string,
  administrationData: IAdministration,
  transaction: Transaction
) => {
  console.log("hit addAssignmentToUsers");
  const assignments = await Promise.all(
    _map(users, (user) =>
      prepareNewAssignment(
        user,
        administrationId,
        administrationData,
        transaction
      )
    )
  );

  return _map(assignments, ([assignmentRef, assignmentData]) => {
    if (assignmentRef && assignmentData) {
      logger.debug(`Adding new assignment at ${assignmentRef.path}`, {
        assignmentSummary: summarizeAssignmentForLog(assignmentData),
      });
      return transaction.set(assignmentRef, assignmentData, { merge: true });
    } else {
      return transaction;
    }
  });
};

/**
 * Remove organizations from the assigningOrgs of an assignment.
 *
 * If no organization remain after the removal, the assignment is deleted.
 *
 * @param {string} userUid - The unique identifier of the user.
 * @param {string} administrationId - The unique identifier of the administration.
 * @param {IOrgsList} orgsToRemove - The data of the administration.
 * @param {Transaction} transaction - The Firestore transaction object.
 * @returns A Promise that resolves with the assignment reference and data.
 */
export const removeOrgsFromAssignment = async (
  userUid: string,
  administrationId: string,
  orgsToRemove: IOrgsList,
  transaction: Transaction
) => {
  const db = getFirestore();
  const userDocRef = db.collection("users").doc(userUid);
  const assignmentRef = userDocRef
    .collection("assignments")
    .doc(administrationId);
  const assignmentDoc = await transaction.get(assignmentRef);
  if (assignmentDoc.exists) {
    const assigningOrgs = _get(assignmentDoc.data(), "assigningOrgs", []);
    for (const orgName of Object.keys(assigningOrgs)) {
      assigningOrgs[orgName] = _without(
        assigningOrgs[orgName],
        ...(orgsToRemove[orgName] ?? [])
      );
    }

    const numRemainingAssigningOrgs = _reduce(
      assigningOrgs,
      (sum, value) => sum + value.length,
      0
    );

    if (numRemainingAssigningOrgs > 0) {
      const readOrgs = await getReadOrgs(assigningOrgs, transaction);
      return [assignmentRef, assigningOrgs, readOrgs] as [
        DocumentReference,
        IOrgsList | undefined,
        IOrgsList | undefined
      ];
    } else {
      return [assignmentRef, undefined, undefined] as [
        DocumentReference,
        IOrgsList | undefined,
        IOrgsList | undefined
      ];
    }
  } else {
    return [undefined, undefined, undefined];
  }
};

/**
 * Remove organizations from the assigningOrgs of multiple assignments.
 *
 * @param {string[]} users - An array of unique identifiers of the users.
 * @param {string} administrationId - The unique identifier of the administration.
 * @param {IOrgsList} orgsToRemove - The data of the administration.
 * @param {Transaction} transaction - The Firestore transaction object.
 * @returns A Promise that resolves with the assignment reference and data.
 */
export const removeOrgsFromAssignments = async (
  users: string[],
  administrationIds: string[],
  orgsToRemove: IOrgsList,
  transaction: Transaction
) => {
  const assignments = await Promise.all(
    _flatten(
      administrationIds.map((administrationId) => {
        return users.map((user) => {
          return removeOrgsFromAssignment(
            user,
            administrationId,
            orgsToRemove,
            transaction
          );
        });
      })
    )
  );

  return _map(assignments, ([assignmentRef, assigningOrgs, readOrgs]) => {
    if (assignmentRef) {
      if (assigningOrgs) {
        return transaction.update(assignmentRef, {
          id: assignmentRef.id,
          assigningOrgs,
          readOrgs,
        });
      } else {
        logger.debug(`Removing assignment ${assignmentRef.path}`);
        // TODO: This removes assignments even if they are in progress or completed.
        // We should consider handling in progress and completed assignments differently.
        // Perhaps they get moved to a separate "archived" collection.
        // Discuss with the partnerships team.
        return transaction.delete(assignmentRef);
      }
    } else {
      return transaction;
    }
  });
};

/**
 * Updates or creates an assignment for a user based on the provided
 * administration data.
 *
 * @param {string} userUid - The unique identifier of the user.
 * @param {string} administrationId - The unique identifier of the administration.
 * @param {IAdministration} administrationData - The data of the administration.
 * @param {Transaction} transaction - The Firestore transaction object.
 *
 * @returns A tuple containing the Firestore document reference of the assignment
 * and the updated assignment data. If the assignment does not exist, the
 * assignment data will be `undefined`.
 */
export const updateAssignmentForUser = async (
  userUid: string,
  administrationId: string,
  administrationData: IAdministration,
  transaction: Transaction
) => {
  const db = getFirestore();
  const userRef = db.collection("users").doc(userUid);
  const assignmentRef = userRef.collection("assignments").doc(administrationId);
  const assignmentDoc = await transaction.get(assignmentRef);
  if (assignmentDoc.exists) {
    // TODO: Evaluate the conditions in the administration. Look at the user
    // data, which should be copied (denomarlized) into the assignment doc. If
    // the conditional applicability of any assessments has changed, unassign or
    // assign the assessment.

    // These are all of the orgs that have assigned the administration.
    const assigningOrgs = _pick(administrationData, ORG_NAMES);

    // Now we need to get the intersection of all the assigningOrgs with all of the users orgs.
    const userData = await transaction.get(userRef);
    if (userData.exists) {
      // All orgs affiliated with this user
      const userOrgs = _pick(userData.data(), ORG_NAMES);

      // Just the orgs that assigned to this user
      const usersAssigningOrgs: IOrgsList = {};
      for (const orgName of ORG_NAMES) {
        usersAssigningOrgs[orgName] = _intersection(
          userOrgs[orgName]?.current,
          assigningOrgs[orgName]
        );
      }

      if (isEmptyOrgs(usersAssigningOrgs)) {
        return [assignmentRef, undefined];
      }

      const userReadOrgs = await getReadOrgs(usersAssigningOrgs, transaction);

      // Existing assignment assessments
      const existingAssessments = _get(assignmentDoc.data(), "assessments", []);

      // All assessments from the administration
      const administrationAssessments = _get(
        administrationData,
        "assessments",
        []
      );

      // Initialize updatedAssessments by preserving any existingAssessments that
      // have been started.
      const updatedAssessments = existingAssessments.filter(
        (assessment) => assessment.startedOn || assessment.runId
      );

      // Then iterate through the administration assessments and add any that
      // satisfy the optional or required conditions, but only if they are not
      // already in the array.
      for (const _assessment of administrationAssessments) {
        const assessmentAlreadyStarted = updatedAssessments
          .map((a) => a.taskId)
          .includes(_assessment.taskId);

        // Use conditions from administrationData to evaluate whether or not to assign to this user.
        const { conditions } = _assessment;

        if (assessmentAlreadyStarted) {
          // If we get here, the assessment has already been started and is in
          // the ``updatedAssessments`` array already. Therefore, we do not need to
          // evaluate the ``assigned`` condition. But we do need to evaluate the
          // ``optional`` condition and update the assessment's optional
          // parameter.
          const assessmentIdx = updatedAssessments.findIndex(
            (a) => a.taskId === _assessment.taskId
          );
          let isOptional: boolean = false;

          if (conditions) {
            const { optional } = conditions;
            if (optional) {
              isOptional = evaluateCondition({
                userData: userData.data()! as IUserData,
                condition: optional,
              });
            }
          }

          updatedAssessments[assessmentIdx].optional = isOptional;
          if (_assessment.params) {
            updatedAssessments[assessmentIdx].params = _assessment.params;
          }
        } else {
          // Prepopulate the assignedAssessment, default to required.
          const assignedAssessment = {
            taskId: _assessment.taskId,
            optional: false,
            params: _assessment.params,
            variantId: _assessment.variantId,
            variantName: _assessment.variantName,
          };

          if (conditions) {
            const { optional, assigned } = conditions;
            let pushAssessment = false;
            // Evaluate assigned first. The result of this evaluation dictates
            // whether or not we push the assessment to the user's
            // assignedAssessments array.
            if (assigned) {
              pushAssessment = evaluateCondition({
                userData: userData.data()! as IUserData,
                condition: assigned,
              });
            } else {
              // If the user supplied only optional conditions, then we assume that
              // they wanted to assign it to everyone.
              pushAssessment = true;
            }

            // Next, evaluate the opational condition. This only sets the `optional`
            // metadata. The `assigned` flag above is still responsible for pushing
            // the assessment to the user's assignedAssessments array.
            if (optional) {
              assignedAssessment.optional = evaluateCondition({
                userData: userData.data()! as IUserData,
                condition: optional,
              });
            }
            // No else block required here because we initialized the assignment
            // with optional=false.

            if (pushAssessment) {
              updatedAssessments.push(assignedAssessment);
            }
          } else {
            // If no conditions are specified, assign as required to all users.
            updatedAssessments.push(assignedAssessment);
          }
        }
      }

      if (updatedAssessments.length === 0) {
        return [assignmentRef, undefined];
      }

      // Grab a copy of the user doc and remove org and assignment data, keeping
      // the rest to copy over into the assignment. Yay, denormalization!
      const {
        studentData = {},
        name = null,
        assessmentPid = null,
        assessmentUid = null,
        email = null,
        username = null,
      } = userData.data()!;

      const userDataCopy = {
        ...studentData,
        name,
        assessmentPid,
        assessmentUid,
        email,
        username,
      };

      const { dateOpened, dateClosed, dateCreated } = administrationData;
      const cleanedAssessments = removeUndefinedFields(updatedAssessments);

      if (!_isEqual(cleanedAssessments, updatedAssessments)) {
        logger.warn(
          `[updateAssignmentForUser]: cleaned assessments do not match original assessments`,
          {
            administrationId,
            assignmentPath: assignmentRef.path,
            originalSummary: summarizeAssessmentsForLog(updatedAssessments),
            cleanedSummary: summarizeAssessmentsForLog(cleanedAssessments),
          }
        );
      }

      const assignmentData: DocumentData = {
        ...assignmentDoc.data,
        id: administrationId,
        dateOpened: parseTimestamp(dateOpened),
        dateClosed: parseTimestamp(dateClosed),
        dateCreated: parseTimestamp(dateCreated),
        assigningOrgs: usersAssigningOrgs,
        createdBy: administrationData.createdBy,
        legal: administrationData.legal ?? {},
        name: administrationData.name ?? "",
        publicName: administrationData.publicName ?? "",
        sequential: administrationData.sequential ?? false,
        readOrgs: userReadOrgs,
        assessments: cleanedAssessments,
        userData: userDataCopy,
        testData: administrationData.testData ?? false,
        demoData: administrationData.demoData ?? false,
        lastSyncedFromAdministration: new Date(),
      };

      return [assignmentRef, assignmentData] as [
        DocumentReference,
        DocumentData
      ];
    } else {
      return [assignmentRef, undefined];
    }
  } else {
    return prepareNewAssignment(
      userUid,
      administrationId,
      administrationData,
      transaction
    );
  }
};

/**
 * Updates or creates assignments for multiple users based on the provided
 * administration data.
 *
 * @param {string[]} users - An array of unique identifiers of the users.
 * @param {string} administrationId - The unique identifier of the administration.
 * @param {IAdministration} administrationData - The data of the administration.
 * @param {Transaction} transaction - The Firestore transaction object.
 *
 * @returns An array of tuples, each containing the Firestore document reference of
 * the assignment and the updated assignment data for a user. If an assignment does
 * not exist for a user, the assignment data will be `undefined`.
 */
export const updateAssignmentForUsers = async (
  users: string[],
  administrationId: string,
  administrationData: IAdministration,
  transaction: Transaction
) => {
  const assignments = await Promise.all(
    _map(users, (user) =>
      updateAssignmentForUser(
        user,
        administrationId,
        administrationData,
        transaction
      )
    )
  );

  return _map(assignments, ([assignmentRef, assignmentData]) => {
    if (assignmentRef && assignmentData) {
      logger.info(`Updating or creating assignment ${assignmentRef.path}`, {
        assignmentSummary: summarizeAssignmentForLog(assignmentData),
      });
      return transaction.set(assignmentRef, assignmentData, { merge: true });
    } else if (assignmentRef) {
      return transaction.delete(assignmentRef);
    } else {
      return transaction;
    }
  });
};

export const updateAllAssignmentsInCollection = async ({
  collectionRef,
  fieldPathsAndValues,
  restrictToOpenAssignments = true,
}: {
  collectionRef: CollectionReference;
  fieldPathsAndValues: FieldPathsAndValues;
  restrictToOpenAssignments?: boolean;
}) => {
  const db = getFirestore();
  return db.runTransaction(async (transaction) => {
    let allDocRefs: DocumentReference[] = [];
    if (restrictToOpenAssignments) {
      allDocRefs = await transaction
        .get(collectionRef.where("dateClosed", ">", new Date()))
        .then((snapshot) => snapshot.docs.map((doc) => doc.ref));
    } else {
      allDocRefs = await transaction
        .get(collectionRef)
        .then((snapshot) => snapshot.docs.map((doc) => doc.ref));
    }

    const [firstField, firstValue, ...rest] = fieldPathsAndValues;

    for (const docRef of allDocRefs) {
      transaction.update(docRef, firstField, firstValue, ...rest);
    }
  });
};
