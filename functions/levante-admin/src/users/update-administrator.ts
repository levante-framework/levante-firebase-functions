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


export const updateAdministratorRoles = async ({
  context,
  updatedRoles,
}: {
  context: AdministratorContext;
  updatedRoles: AdministratorRoleDefinition[];
}) => {
  const auth = getAuth();
  const db = getFirestore();

  const sanitizedRoles = await db.runTransaction(async (transaction) => {
      const adminDoc = await transaction.get(context.adminUserDocRef);
      if (!adminDoc.exists) {
        throw new HttpsError(
          "not-found",
          "Administrator user document not found"
        );
      }

      const adminDocData = adminDoc.data() as Record<string, unknown>;
      const currentRoles = sanitizeRoles(
        Array.isArray(adminDoc.data()?.roles)
          ? (adminDoc.data()!.roles as AdministratorRoleDefinition[])
          : []
      );

      const siteIdsToUpdate = new Set<string>();
      const mergedRolesMap = new Map<string, AdministratorRoleDefinition>();
      for (const role of currentRoles) {
        mergedRolesMap.set(role.siteId, role);
      }
      for (const incomingRole of updatedRoles) {
        mergedRolesMap.set(incomingRole.siteId, { ...incomingRole });
        siteIdsToUpdate.add(incomingRole.siteId);
      }

      const mergedRoles = sanitizeRoles(Array.from(mergedRolesMap.values()));

      const now = FieldValue.serverTimestamp();
      transaction.update(context.adminUserDocRef, {
        roles: mergedRoles,
        updatedAt: now,
      });

      for (const siteId of siteIdsToUpdate) {
        const role = mergedRolesMap.get(siteId);
        if (!role) {
          continue;
        }

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

        const existingEntry = administrators.find(
          (entry) =>
            entry?.adminUid === context.adminUid &&
            (entry?.siteId === siteId)
        );

        const otherAdministrators = administrators.filter(
          (entry) =>
            entry?.adminUid !== context.adminUid ||(entry.siteId !== siteId)
        );

        const updatedAdministrators = [
          ...otherAdministrators,
          {
            ...existingEntry,
            adminUid: context.adminUid,
            siteId,
            role: role.role,
            status: ADMINISTRATOR_STATUS.ACTIVE,
            name: context.targetRecord.displayName
          },
        ];

        transaction.update(districtDocRef, {
          administrators: updatedAdministrators,
          updatedAt: now,
        });
      }

      return mergedRoles;
    }
  );

  const existingClaims: Record<string, unknown> =
    (context.targetRecord.customClaims as Record<string, unknown>) ?? {};
  const updatedClaims = {
    ...existingClaims,
    roles: sanitizedRoles,
    useNewPermissions: true,
    adminUid: context.adminUid,
  };

  await auth.setCustomUserClaims(context.adminUid, updatedClaims);

  return {
    status: "ok" as const,
    adminUid: context.adminUid,
    roles: sanitizedRoles,
  };
};

export const removeAdministratorRoles = async ({
  context,
  siteId,
}: {
  context: AdministratorContext;
  siteId: string;
}) => {
  const auth = getAuth();
  const db = getFirestore();

  const { remainingRoles } = await db.runTransaction(async (transaction) => {
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

    const remainingRoles = sanitizeRoles(
      currentRoles.filter((role) => role.siteId !== siteId)
    );
    const now = FieldValue.serverTimestamp();

    transaction.update(context.adminUserDocRef, {
      roles: remainingRoles,
      updatedAt: now,
    });

    const districtDocRef = db.collection("districts").doc(siteId);
    const districtSnapshot = await transaction.get(districtDocRef);

    if (!districtSnapshot.exists) {
      throw new HttpsError("not-found", `District document ${siteId} not found`);
    }

    const administrators = districtSnapshot.data()?.administrators ?? [];

    const existingEntry = administrators.find(
      (entry) =>
        entry?.adminUid === context.adminUid && (entry?.siteId === siteId)
    );

    const otherAdministrators = administrators.filter(
      (entry) =>
        entry?.adminUid !== context.adminUid || (entry.siteId !== siteId)
    );

    const updatedAdministrators = existingEntry
      ? [
          ...otherAdministrators,
          {
            ...existingEntry,
            adminUid: context.adminUid,
            siteId,
            status: ADMINISTRATOR_STATUS.INACTIVE,
            role: existingEntry.role,
            name: context.targetRecord.displayName,
          },
        ]
      : otherAdministrators;

    transaction.update(districtDocRef, {
      administrators: updatedAdministrators,
      updatedAt: now,
    });

    return { remainingRoles };
  });

  const existingClaims: Record<string, unknown> =
    (context.targetRecord.customClaims as Record<string, unknown>) ?? {};
  const updatedClaims = {
    ...existingClaims,
    roles: remainingRoles,
    useNewPermissions: true,
    adminUid: context.adminUid,
  };

  await auth.setCustomUserClaims(context.adminUid, updatedClaims);

  return {
    status: "ok" as const,
    adminUid: context.adminUid,
    roles: remainingRoles,
  };
};
