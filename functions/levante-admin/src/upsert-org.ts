import { getFirestore, FieldValue, FieldPath } from "firebase-admin/firestore";
import type { DocumentData } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";

// Helper function to get plural collection name
function getPluralCollectionName(orgType: string): string {
  if (orgType === "class") return "classes";
  return `${orgType}s`; // for district, school, group
}

export interface OrgData {
  id?: string; // If provided, it's an update; otherwise, create.
  type: "districts" | "schools" | "classes" | "groups"; // Org type determines the collection
  [key: string]: any;
}

/**
 * Internal function to handle the logic of creating or updating an organization.
 * @param requestingUid The UID of the user making the request.
 * @param orgData The data for the organization to be created or updated.
 * @returns The ID of the created or updated organization.
 */
export async function _upsertOrg(
  requestingUid: string,
  orgData: OrgData
): Promise<string> {
  console.log("orgData", orgData);
  const db = getFirestore();

  const { id: orgId, type: orgType, ...dataToSet } = orgData;
  const now = FieldValue.serverTimestamp();

  if (
    !orgType ||
    !["districts", "schools", "classes", "groups"].includes(orgType)
  ) {
    logger.error("Invalid Group type provided.", { orgType });
    throw new HttpsError("invalid-argument", "Invalid Group type provided.");
  }

  const orgCollectionRef = db.collection(orgType);

  try {
    if (orgId) {
      // --- Update existing organization ---
      const orgDocRef = orgCollectionRef.doc(orgId);

      await db.runTransaction(async (transaction) => {
        const orgDocSnap = await transaction.get(orgDocRef);

        if (!orgDocSnap.exists) {
          logger.error("Group document not found for update.", {
            orgType,
            orgId,
          });
          throw new HttpsError(
            "not-found",
            `Group with ID ${orgId} not found in ${orgType}.`
          );
        }

        const oldOrgData = orgDocSnap.data() as DocumentData;

        // --- Handle parent relationship updates ---
        if (orgType === "groups") {
          const oldParentOrgId = oldOrgData?.parentOrgId;
          const oldParentOrgType = oldOrgData?.parentOrgType;
          const newParentOrgId = dataToSet.parentOrgId;
          const newParentOrgType = dataToSet.parentOrgType;

          // --- Validation: Group parent must be a district if specified ---
          if (newParentOrgType && newParentOrgType !== "district") {
            logger.error(
              "Invalid parentOrgType for Cohort update. Must be 'Site'.",
              { parentOrgType: newParentOrgType, orgId }
            );
            throw new HttpsError(
              "invalid-argument",
              "Invalid parent Group type. Cohorts can only belong to a Site."
            );
          }
          // --- End Validation ---

          if (
            newParentOrgId && // newParentOrgType is implicitly 'district' if defined
            (oldParentOrgId !== newParentOrgId ||
              oldParentOrgType !== newParentOrgType) // Compare if parent actually changed
          ) {
            const pluralOldParentType = oldParentOrgType
              ? getPluralCollectionName(oldParentOrgType) // Need old type for removal
              : null; // Handle case where old parent didn't exist
            const pluralNewParentType = "districts"; // We know it must be district if set

            // Remove from old parent if exists and type is known
            if (oldParentOrgId && pluralOldParentType) {
              const oldParentOrgRef = db
                .collection(pluralOldParentType)
                .doc(oldParentOrgId);
              transaction.update(oldParentOrgRef, {
                subGroups: FieldValue.arrayRemove(orgId),
              });
            } else if (!newParentOrgId && oldParentOrgId && oldParentOrgType) {
              // Handle removal of parent relationship if old parent existed
              const pluralOldParentType =
                getPluralCollectionName(oldParentOrgType);
              // No need to check if pluralOldParentType is null, as oldParentOrgType is checked
              const oldParentOrgRef = db
                .collection(pluralOldParentType)
                .doc(oldParentOrgId);
              transaction.update(oldParentOrgRef, {
                subGroups: FieldValue.arrayRemove(orgId),
              });
            }
            // Add to new parent
            const newParentOrgRef = db
              .collection(pluralNewParentType)
              .doc(newParentOrgId);
            transaction.update(newParentOrgRef, {
              subGroups: FieldValue.arrayUnion(orgId),
            });
          }
        } else if (orgType === "classes") {
          const oldSchoolId = oldOrgData?.schoolId;
          const newSchoolId = dataToSet.schoolId;
          if (newSchoolId && oldSchoolId !== newSchoolId) {
            // Remove from old school if exists
            if (oldSchoolId) {
              const oldSchoolRef = db.collection("schools").doc(oldSchoolId);
              transaction.update(oldSchoolRef, {
                classes: FieldValue.arrayRemove(orgId),
              });
            }
            // Add to new school
            const newSchoolRef = db.collection("schools").doc(newSchoolId);
            transaction.update(newSchoolRef, {
              classes: FieldValue.arrayUnion(orgId),
            });
          }
        } else if (orgType === "schools") {
          const oldDistrictId = oldOrgData?.districtId;
          const newDistrictId = dataToSet.districtId;
          if (newDistrictId && oldDistrictId !== newDistrictId) {
            // Remove from old district if exists
            if (oldDistrictId) {
              const oldDistrictRef = db
                .collection("districts")
                .doc(oldDistrictId);
              transaction.update(oldDistrictRef, {
                schools: FieldValue.arrayRemove(orgId),
              });
            }
            // Add to new district
            const newDistrictRef = db
              .collection("districts")
              .doc(newDistrictId);
            transaction.update(newDistrictRef, {
              schools: FieldValue.arrayUnion(orgId),
            });
          }
        }
        // --- End Handle parent relationship updates ---

        logger.info("Updating Group document.", {
          requestingUid,
          orgType,
          orgId,
          data: dataToSet,
        });
        transaction.update(orgDocRef, {
          ...dataToSet,
          updatedAt: now,
        });
      });

      return orgId;
    } else {
      // --- Create new organization ---
      const newOrgDocRef = orgCollectionRef.doc();
      const newOrgId = newOrgDocRef.id;

      await db.runTransaction(async (transaction) => {
        // 1. Create the new organization document
        logger.info("Creating new Group document.", {
          requestingUid,
          orgType,
          newOrgId,
          data: dataToSet,
        });
        transaction.set(newOrgDocRef, {
          ...dataToSet,
          id: newOrgId, // Store the ID within the document as well
          archived: false, // required for queries / cloud functions. TODO: ask ROAR why this is needed
          createdBy: requestingUid,
          createdAt: now,
          updatedAt: now,
        });

        // --- Handle relationship creation ---
        if (orgType === "groups") {
          // --- Validation: Group parent must be a district if specified ---
          if (
            dataToSet.parentOrgType &&
            dataToSet.parentOrgType !== "district"
          ) {
            logger.error(
              "Invalid parentOrgType for Cohort creation. Must be 'Site'.",
              { parentOrgType: dataToSet.parentOrgType }
            );
            throw new HttpsError(
              "invalid-argument",
              "Invalid parent Group type. Cohorts can only belong to a Site."
            );
          }
          // --- End Validation ---

          if (dataToSet.parentOrgId && dataToSet.parentOrgType) {
            // parentOrgType must be 'district' here
            const pluralParentType = getPluralCollectionName(
              dataToSet.parentOrgType // Should always resolve to 'districts'
            );
            const parentOrgRef = db
              .collection(pluralParentType)
              .doc(dataToSet.parentOrgId as string);
            logger.info("Adding new group to parent org subGroups array", {
              parentOrgType: dataToSet.parentOrgType,
              parentCollection: pluralParentType,
              parentOrgId: dataToSet.parentOrgId,
              newOrgId: newOrgId,
            });
            transaction.update(parentOrgRef, {
              subGroups: FieldValue.arrayUnion(newOrgId),
            });
          }
        } else if (orgType === "classes") {
          if (dataToSet.schoolId) {
            const schoolRef = db
              .collection("schools")
              .doc(dataToSet.schoolId as string);
            logger.info("Adding new class to school classes array", {
              schoolId: dataToSet.schoolId,
              newOrgId: newOrgId,
            });
            transaction.update(schoolRef, {
              classes: FieldValue.arrayUnion(newOrgId),
            });
          }
        } else if (orgType === "schools") {
          if (dataToSet.districtId) {
            const districtRef = db
              .collection("districts")
              .doc(dataToSet.districtId as string);
            logger.info("Adding new school to district schools array", {
              districtId: dataToSet.districtId,
              newOrgId: newOrgId,
            });
            transaction.update(districtRef, {
              schools: FieldValue.arrayUnion(newOrgId),
            });
          }
        }
        // --- End Handle relationship creation ---
      });

      return newOrgId;
    }
  } catch (error: any) {
    logger.error("Error creating or updating Group.", {
      requestingUid,
      orgData,
      error,
    });
    if (error instanceof HttpsError) {
      throw error; // Re-throw HttpsErrors directly
    }
    // Throw a generic internal error for unexpected issues
    throw new HttpsError(
      "internal",
      "An unexpected error occurred while processing the Group.",
      error.message
    );
  }
}
