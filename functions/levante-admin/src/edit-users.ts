import {
  getFirestore,
  Timestamp,
  DocumentReference,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";

interface UserUpdateData {
  uid: string;
  month?: string;
  year?: string;
  district?: string;
  school?: string;
  class?: string;
  group?: string;
}

interface UpdateError {
  uid: string;
  reason: string;
  field?: string;
}

interface UpdateResult {
  success: boolean;
  message: string;
  errors?: UpdateError[];
  totalProcessed: number;
  successfulUpdates: number;
}

/**
 * Edits user records with the provided data
 * @param requestingUid - The UID of the user making the request
 * @param usersToUpdate - Array of user objects with fields to update
 * @returns Object indicating success or failure with details of any errors
 */
export async function _editUsers(
  requestingUid: string,
  usersToUpdate: UserUpdateData[]
): Promise<UpdateResult> {
  const db = getFirestore();
  const errors: UpdateError[] = [];
  let successfulUpdates = 0;

  // Verify the requesting user has admin privileges
  try {
    const claimsDocRef = db.collection("userClaims").doc(requestingUid);
    const claimsDoc = await claimsDocRef.get();

    if (!claimsDoc.exists) {
      throw new HttpsError("permission-denied", "User claims not found");
    }

    const claims = claimsDoc.data()?.claims;
    if (!claims?.admin && !claims?.super_admin) {
      throw new HttpsError(
        "permission-denied",
        "User does not have admin privileges"
      );
    }
  } catch (error: any) {
    throw new HttpsError(
      "permission-denied",
      `Authentication error: ${error.message || String(error)}`
    );
  }

  // Process each user update
  for (const userData of usersToUpdate) {
    const { uid } = userData;

    if (!uid) {
      errors.push({
        uid: "unknown",
        reason: "Missing uid field",
      });
      continue;
    }

    try {
      const userRef = db.collection("users").doc(uid);
      const userDoc = await userRef.get();

      if (!userDoc.exists) {
        errors.push({
          uid,
          reason: "User not found",
        });
        continue;
      }

      const updates: Record<string, any> = {};
      let hasErrors = false;

      // Handle birth month and year
      if (userData.month !== undefined) {
        try {
          const monthNum = parseInt(userData.month, 10);
          if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) {
            errors.push({
              uid,
              reason: "Invalid month value",
              field: "month",
            });
            hasErrors = true;
          } else {
            updates.birthMonth = monthNum;
          }
        } catch (error: any) {
          errors.push({
            uid,
            reason: `Error processing month: ${error.message || String(error)}`,
            field: "month",
          });
          hasErrors = true;
        }
      }

      if (userData.year !== undefined) {
        try {
          const yearNum = parseInt(userData.year, 10);
          const currentYear = new Date().getFullYear();
          if (isNaN(yearNum) || yearNum < 1900 || yearNum > currentYear) {
            errors.push({
              uid,
              reason:
                "Invalid year value. Must be between 1900 and the current year.",
              field: "year",
            });
            hasErrors = true;
          } else {
            updates.birthYear = yearNum;
          }
        } catch (error: any) {
          errors.push({
            uid,
            reason: `Error processing year: ${error.message || String(error)}`,
            field: "year",
          });
          hasErrors = true;
        }
      }

      // Apply basic updates if there are any and no errors were found
      if (Object.keys(updates).length > 0 && !hasErrors) {
        try {
          await userRef.update(updates);
        } catch (error: any) {
          errors.push({
            uid,
            reason: `Error updating basic fields: ${
              error.message || String(error)
            }`,
          });
          hasErrors = true;
        }
      }

      // Handle organization updates separately
      const orgErrors = await processOrgUpdates(db, userRef, userData);
      if (orgErrors.length > 0) {
        errors.push(...orgErrors.map((err) => ({ ...err, uid })));
        hasErrors = true;
      }

      if (!hasErrors) {
        successfulUpdates++;
      }
    } catch (error: any) {
      errors.push({
        uid,
        reason: `Unexpected error: ${error.message || String(error)}`,
      });
    }
  }

  return {
    success: errors.length === 0,
    message:
      errors.length === 0
        ? "All users updated successfully"
        : `${successfulUpdates} users updated successfully, ${errors.length} error(s) occurred`,
    errors: errors.length > 0 ? errors : [],
    totalProcessed: usersToUpdate.length,
    successfulUpdates: successfulUpdates,
  };
}

/**
 * Process organization updates for a user
 * @param db - Firestore database instance
 * @param userRef - Reference to the user document
 * @param userData - User data containing organization information
 * @returns Array of errors encountered during processing
 */
async function processOrgUpdates(
  db: ReturnType<typeof getFirestore>,
  userRef: DocumentReference,
  userData: UserUpdateData
): Promise<Array<Omit<UpdateError, "uid">>> {
  const now = Timestamp.now();
  const errors: Array<Omit<UpdateError, "uid">> = [];

  // Process each organization type separately to ensure proper updates
  if (userData.district) {
    const error = await updateOrg(
      db,
      userRef,
      "districts",
      userData.district,
      now
    );
    if (error) {
      errors.push({ ...error, field: "district" });
    }
  }

  if (userData.school) {
    const error = await updateOrg(db, userRef, "schools", userData.school, now);
    if (error) {
      errors.push({ ...error, field: "school" });
    }
  }

  if (userData.class) {
    const error = await updateOrg(db, userRef, "classes", userData.class, now);
    if (error) {
      errors.push({ ...error, field: "class" });
    }
  }

  if (userData.group) {
    const error = await updateOrg(db, userRef, "groups", userData.group, now);
    if (error) {
      errors.push({ ...error, field: "group" });
    }
  }

  return errors;
}

/**
 * Update a specific organization for a user
 * @param db - Firestore database instance
 * @param userRef - Reference to the user document
 * @param orgType - Type of organization (districts, schools, classes, groups)
 * @param orgName - Name of the organization
 * @param timestamp - Timestamp to use for the 'from' field
 * @returns Error object if an error occurred, null otherwise
 */
async function updateOrg(
  db: ReturnType<typeof getFirestore>,
  userRef: DocumentReference,
  orgType: string,
  orgName: string,
  timestamp: Timestamp
): Promise<Omit<UpdateError, "uid"> | null> {
  try {
    const orgId = await getOrgIdByName(db, orgType, orgName);

    if (!orgId) {
      return {
        reason: `${
          orgType === "districts" ? "sites" : orgType
        } with name "${orgName}" not found`,
      };
    }

    // Create the update object with the correct structure
    const update = {
      [orgType]: {
        all: [orgId],
        current: [orgId],
        dates: {
          [orgId]: {
            from: timestamp,
            to: null,
          },
        },
      },
    };

    // Update the user document with the new organization data
    await userRef.update(update);
    return null;
  } catch (error: any) {
    return {
      reason: `Error updating ${orgType}: ${error.message || String(error)}`,
    };
  }
}

/**
 * Get organization ID by name
 * @param db - Firestore database instance
 * @param collectionName - Name of the organization collection
 * @param orgName - Name of the organization to find
 * @returns Organization ID or null if not found
 */
async function getOrgIdByName(
  db: ReturnType<typeof getFirestore>,
  collectionName: string,
  orgName: string
): Promise<string | null> {
  try {
    const querySnapshot = await db
      .collection(collectionName)
      .where("name", "==", orgName)
      .limit(1)
      .get();

    if (querySnapshot.empty) {
      return null;
    }

    return querySnapshot.docs[0].id;
  } catch (error: any) {
    console.error(
      `Error finding ${collectionName} with name "${orgName}": ${
        error.message || String(error)
      }`
    );
    return null;
  }
}
