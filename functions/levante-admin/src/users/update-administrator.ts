import { getAuth } from "firebase-admin/auth";
import type { UserRecord } from "firebase-admin/auth";
import {
  getFirestore,
  FieldValue,
  type DocumentReference,
} from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  sanitizeRoles,
  type AdministratorRoleDefinition,
} from "./create-administrator.js";
import { ADMINISTRATOR_STATUS } from "../utils/constants.js";

export interface AdministratorContext {
  adminUid: string;
  targetRecord: UserRecord;
  adminUserDocRef: DocumentReference;
  adminData: Record<string, unknown>;
  previousRoles: AdministratorRoleDefinition[];
}

export interface AdministratorRoleDiff {
  sitesRequiringUpdate: string[];
  sitesRemoved: string[];
}


export const loadAdministratorContext = async (
  adminUid: string
): Promise<AdministratorContext> => {
  if (!adminUid || typeof adminUid !== "string") {
    throw new HttpsError("invalid-argument", "A valid adminUid is required");
  }

  const auth = getAuth();
  const db = getFirestore();

  let targetRecord: UserRecord;
  try {
    targetRecord = await auth.getUser(adminUid);
  } catch {
    throw new HttpsError("not-found", "Administrator auth record not found");
  }

  const adminUserDocRef = db.collection("users").doc(adminUid);
  const adminDocSnapshot = await adminUserDocRef.get();

  if (!adminDocSnapshot.exists) {
    throw new HttpsError("not-found", "Administrator user document not found");
  }

  const adminData = adminDocSnapshot.data() as Record<string, unknown>;
  const previousRoles = sanitizeRoles(
    Array.isArray(adminData?.roles)
      ? (adminData.roles as AdministratorRoleDefinition[])
      : []
  );

  return {
    adminUid,
    targetRecord,
    adminUserDocRef,
    adminData,
    previousRoles,
  };
};


export const applyAdministratorRoleMutation = async ({
  context,
  updatedRoles,
}: {
  context: AdministratorContext;
  updatedRoles: AdministratorRoleDefinition[];
}) => {
  const auth = getAuth();
  const db = getFirestore();

  const { removedSiteIds } = await db.runTransaction(async (transaction) => {
    const adminDoc = await transaction.get(context.adminUserDocRef);
    if (!adminDoc.exists) {
      throw new HttpsError("not-found", "Administrator user document not found");
    }

    const adminDocData = adminDoc.data() as Record<string, unknown>;
    const currentRoles = sanitizeRoles(
      Array.isArray(adminDoc.data()?.roles)
        ? (adminDoc.data()!.roles as AdministratorRoleDefinition[])
        : []
    );

    transaction.update(context.adminUserDocRef, {
      roles: updatedRoles,
      updatedAt: FieldValue.serverTimestamp(),
    });

    const siteIdsToProcess = new Set<string>();
    for (const role of updatedRoles) {
      siteIdsToProcess.add(role.siteId);
    }

    for (const siteId of siteIdsToProcess) {
      const districtDocRef = db.collection("districts").doc(siteId);
      const districtSnapshot = await transaction.get(districtDocRef);

      if (!districtSnapshot.exists) {
        throw new HttpsError(
          "not-found",
          `District document ${siteId} not found`
        );
      }

      const administrators = Array.isArray(
        districtSnapshot.data()?.administrators
      )
        ? (districtSnapshot.data()!.administrators as Array<
            Record<string, unknown>
          >)
        : [];

      const filteredAdministrators = administrators.filter(
        (entry) => entry?.adminUid !== context.adminUid
      );

      const rolesForSite = updatedRoles.filter(
        (role) => role.siteId === siteId
      );

      const updatedAdministrators = [...filteredAdministrators];

      for (const role of rolesForSite) {
        updatedAdministrators.push({
          adminUid: context.adminUid,
          name: adminDocData.name,
          status: ADMINISTRATOR_STATUS.ACTIVE,
          role: role.role,
        });
      }

      transaction.update(districtDocRef, {
        administrators: updatedAdministrators,
        updatedAt: FieldValue.serverTimestamp(),
      });
    }

    const removedSiteIds = currentRoles
      .filter(
        (role) =>
          !updatedRoles.some(
            (nextRole) =>
              nextRole.siteId === role.siteId && nextRole.role === role.role
          )
      )
      .map((role) => role.siteId);

    return { removedSiteIds: Array.from(new Set(removedSiteIds)) };
  });

  const existingClaims: Record<string, unknown> =
    (context.targetRecord.customClaims as Record<string, unknown>) ?? {};
  const updatedClaims = {
    ...existingClaims,
    // this will override any existing roles
    roles: updatedRoles,
    useNewPermissions: true,
    adminUid: context.adminUid,
  };

  await auth.setCustomUserClaims(context.adminUid, updatedClaims);

  return {
    status: "ok" as const,
    adminUid: context.adminUid,
    roles: updatedRoles,
    removedSiteIds,
  };
};
