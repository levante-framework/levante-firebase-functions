import { logger } from "firebase-functions/v2";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

// ----------------THIS FUNCTION IS A PLACEHOLDER----------------
// This function is a placeholder for the actual implementation of the
// deleteOrg function. It is not yet implemented.
// ----------------THIS FUNCTION IS A PLACEHOLDER----------------

// Type for organization collection names
export type OrgCollectionName =
  | "districts"
  | "schools"
  | "classes"
  | "groups"
  | "families";

/**
 * Delete an organization from Firestore.
 *
 * @param orgsCollection The type of organization to delete.
 * @param orgId The ID of the organization to delete.
 * @param recursive If true, recursively delete all children of this org.
 *                  Default is true.
 * @returns Promise<void>
 */
export async function deleteOrg(
  orgsCollection: OrgCollectionName,
  orgId: string,
  recursive = true
): Promise<void> {
  const db = getFirestore();

  try {
    // Run the deletion in a transaction to ensure consistency
    await db.runTransaction(async (transaction) => {
      const orgDocRef = db.collection(orgsCollection).doc(orgId);
      const docSnap = await transaction.get(orgDocRef);

      if (docSnap.exists) {
        const orgData = docSnap.data();
        if (!orgData) {
          throw new Error(`Organization data is missing for ID ${orgId}`);
        }

        // Save the dependent schools and classes for recursive deletion
        // later. Why are we doing this here? Because all transaction reads
        // have to take place before any writes, updates, or deletions. We
        // are potentially reading school docs to get all of the classes.
        const { schools = [], classes = [], groups: subGroups = [] } = orgData;

        if (recursive) {
          for (const school of schools) {
            const schoolRef = db.collection("schools").doc(school);
            const schoolDocSnap = await transaction.get(schoolRef);
            if (schoolDocSnap.exists) {
              const schoolData = schoolDocSnap.data();
              if (schoolData) {
                classes.push(...(schoolData.classes ?? []));
                subGroups.push(...(schoolData.subGroups ?? []));
              }
            }
          }
        }

        // Remove this org from the parent's list of child orgs.
        const { schoolId, districtId } = orgData;

        if (schoolId !== undefined) {
          const schoolRef = db.collection("schools").doc(schoolId);
          transaction.update(schoolRef, {
            classes: FieldValue.arrayRemove(orgId),
          });
        } else if (districtId !== undefined) {
          const districtRef = db.collection("districts").doc(districtId);
          transaction.update(districtRef, {
            schools: FieldValue.arrayRemove(orgId),
          });
        }

        // Delete the main organization document
        transaction.delete(orgDocRef);

        // Remove children orgs if recursive is true
        if (recursive) {
          for (const _class of classes) {
            const classRef = db.collection("classes").doc(_class);
            transaction.delete(classRef);
          }

          for (const school of schools) {
            const schoolRef = db.collection("schools").doc(school);
            transaction.delete(schoolRef);
          }

          for (const subGroup of subGroups) {
            const groupRef = db.collection("groups").doc(subGroup);
            transaction.delete(groupRef);
          }
        }
      } else {
        throw new Error(
          `Could not find an organization with ID ${orgId} in the ROAR database.`
        );
      }
    });

    logger.info(
      `Successfully deleted organization ${orgId} from ${orgsCollection}`
    );
  } catch (error) {
    logger.error(`Error deleting organization ${orgId}:`, error);
    throw error;
  }
}
