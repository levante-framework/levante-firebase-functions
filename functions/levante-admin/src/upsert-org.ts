import { getFirestore, FieldValue } from "firebase-admin/firestore";
import type {
  DocumentData,
  Firestore,
  Transaction,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";

export interface OrgData {
  id?: string; // If provided, it's an update; otherwise, create.
  type: "districts" | "schools" | "classes" | "groups"; // Org type determines the collection
  [key: string]: any;
}

interface ParentLink {
  childArrayField: string;
  collection: string;
  parentId: string;
}

const VALID_ORG_TYPES = ["districts", "schools", "classes", "groups"] as const;

// Helper function to get plural collection name
function getPluralCollectionName(orgType: string): string {
  if (orgType === "class") return "classes";
  return `${orgType}s`; // for district, school, group
}

export const getGroupTypeLabel = (orgType: string): string => {
  switch (orgType) {
    case "districts":
      return "Site";
    case "classes":
      return "Class";
    case "schools":
      return "School";
    case "groups":
      return "Cohort";
    default:
      return "Group";
  }
};

function validateOrgType(orgType: string): asserts orgType is OrgData["type"] {
  if (!orgType || !(VALID_ORG_TYPES as readonly string[]).includes(orgType)) {
    logger.error("Invalid Group type provided.", { orgType });
    throw new HttpsError("invalid-argument", "Invalid Group type provided.");
  }
}

function validateGroupParentType(
  parentOrgType: string | undefined,
  operation: string
): void {
  if (parentOrgType !== "district") {
    logger.error(
      `Invalid parentOrgType for Cohort ${operation}. Must be 'Site'.`,
      { parentOrgType }
    );
    throw new HttpsError(
      "invalid-argument",
      "Invalid parent Group type. Cohorts can only belong to a Site."
    );
  }
}

/**
 * Derives the parent link for a given org type and its data.
 * For groups, both parentOrgId and parentOrgType must be present.
 */
function resolveParentLink(
  orgType: OrgData["type"],
  data: Record<string, any>
): ParentLink | null {
  if (orgType === "groups" && data.parentOrgId && data.parentOrgType) {
    return {
      parentId: data.parentOrgId,
      collection: getPluralCollectionName(data.parentOrgType),
      childArrayField: "subGroups",
    };
  }

  if (orgType === "classes" && data.schoolId) {
    return {
      parentId: data.schoolId,
      collection: "schools",
      childArrayField: "classes",
    };
  }

  if (orgType === "schools" && data.districtId) {
    return {
      parentId: data.districtId,
      collection: "districts",
      childArrayField: "schools",
    };
  }

  return null;
}

/**
 * For group updates, only parentOrgId is required (the target collection
 * is always "districts" since the validation guarantees it).
 */
function resolveNewGroupParentLink(
  data: Record<string, any>
): ParentLink | null {
  if (!data.parentOrgId) return null;

  return {
    parentId: data.parentOrgId,
    collection: "districts",
    childArrayField: "subGroups",
  };
}

function hasParentChanged(
  oldLink: ParentLink | null,
  newLink: ParentLink | null
): boolean {
  if (!newLink) return false;
  if (!oldLink) return true;
  return (
    oldLink.parentId !== newLink.parentId ||
    oldLink.collection !== newLink.collection
  );
}

function removeFromParent(
  transaction: Transaction,
  db: Firestore,
  parent: ParentLink,
  childId: string
): void {
  const ref = db.collection(parent.collection).doc(parent.parentId);
  transaction.update(ref, {
    [parent.childArrayField]: FieldValue.arrayRemove(childId),
  });
}

function addToParent(
  transaction: Transaction,
  db: Firestore,
  parent: ParentLink,
  childId: string
): void {
  const ref = db.collection(parent.collection).doc(parent.parentId);
  transaction.update(ref, {
    [parent.childArrayField]: FieldValue.arrayUnion(childId),
  });
}

function transferParentRelationship(
  transaction: Transaction,
  db: Firestore,
  orgType: OrgData["type"],
  orgId: string,
  oldData: DocumentData,
  newData: Record<string, any>
): void {
  if (orgType === "groups") {
    validateGroupParentType(newData.parentOrgType, "update");
  }

  const oldLink = resolveParentLink(orgType, oldData);
  const newLink =
    orgType === "groups"
      ? resolveNewGroupParentLink(newData)
      : resolveParentLink(orgType, newData);

  if (!hasParentChanged(oldLink, newLink)) return;

  if (oldLink) {
    removeFromParent(transaction, db, oldLink, orgId);
  }
  addToParent(transaction, db, newLink!, orgId);
}

async function updateExistingOrg(
  db: Firestore,
  orgType: OrgData["type"],
  orgId: string,
  dataToSet: Record<string, any>,
  requestingUid: string
): Promise<string> {
  const orgDocRef = db.collection(orgType).doc(orgId);

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

    const oldData = orgDocSnap.data() as DocumentData;

    transferParentRelationship(
      transaction,
      db,
      orgType,
      orgId,
      oldData,
      dataToSet
    );

    logger.info("Updating Group document.", {
      requestingUid,
      orgType,
      orgId,
      data: dataToSet,
    });
    transaction.update(orgDocRef, {
      ...dataToSet,
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return orgId;
}

async function assertNoDuplicate(
  db: Firestore,
  orgType: OrgData["type"],
  dataToSet: Record<string, any>
): Promise<void> {
  const existing = await db
    .collection(orgType)
    .where("siteId", "==", dataToSet.siteId)
    .where("normalizedName", "==", dataToSet.normalizedName)
    .limit(1)
    .get();

  if (!existing.empty) {
    throw new HttpsError(
      "internal",
      `${getGroupTypeLabel(orgType)} "${dataToSet.name}" already exists`
    );
  }
}

function linkToParent(
  transaction: Transaction,
  db: Firestore,
  orgType: OrgData["type"],
  newOrgId: string,
  dataToSet: Record<string, any>
): void {
  if (orgType === "groups") {
    validateGroupParentType(dataToSet.parentOrgType, "creation");
  }

  const parentLink = resolveParentLink(orgType, dataToSet);
  if (!parentLink) return;

  logger.info("Linking new org to parent.", {
    orgType,
    newOrgId,
    parentCollection: parentLink.collection,
    parentId: parentLink.parentId,
  });
  addToParent(transaction, db, parentLink, newOrgId);
}

async function createNewOrg(
  db: Firestore,
  orgType: OrgData["type"],
  dataToSet: Record<string, any>,
  requestingUid: string
): Promise<string> {
  await assertNoDuplicate(db, orgType, dataToSet);

  const newOrgDocRef = db.collection(orgType).doc();
  const newOrgId = newOrgDocRef.id;

  await db.runTransaction(async (transaction) => {
    logger.info("Creating new Group document.", {
      requestingUid,
      orgType,
      newOrgId,
      data: dataToSet,
    });

    transaction.set(newOrgDocRef, {
      ...dataToSet,
      id: newOrgId,
      archived: false, // required for queries / cloud functions. TODO: ask ROAR why this is needed
      createdBy: requestingUid,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    linkToParent(transaction, db, orgType, newOrgId, dataToSet);
  });

  return newOrgId;
}

/**
 * Creates or updates an organization.
 * @param requestingUid The UID of the user making the request.
 * @param orgData The data for the organization to be created or updated.
 * @returns The ID of the created or updated organization.
 */
export async function _upsertOrg(
  requestingUid: string,
  orgData: OrgData
): Promise<string> {
  const { id: orgId, type: orgType, ...dataToSet } = orgData;
  validateOrgType(orgType);

  const db = getFirestore();

  try {
    if (orgId) {
      return await updateExistingOrg(
        db,
        orgType,
        orgId,
        dataToSet,
        requestingUid
      );
    }
    return await createNewOrg(db, orgType, dataToSet, requestingUid);
  } catch (error: any) {
    logger.error("Error creating or updating Group.", {
      requestingUid,
      orgData,
      error,
    });
    if (error instanceof HttpsError) throw error;
    throw new HttpsError(
      "internal",
      "An unexpected error occurred while processing the Group.",
      error.message
    );
  }
}
