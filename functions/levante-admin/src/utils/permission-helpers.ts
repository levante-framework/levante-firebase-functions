import { getFirestore } from "firebase-admin/firestore";
import { getAuth, UserRecord } from "firebase-admin/auth";
import {
  ACTIONS,
  RESOURCES,
  CacheService,
  PermissionService,
  type User as PermUser,
  type PermissionCheck,
} from "@levante-framework/permissions-core";

// Singleton permission service shared across functions
const cache = new CacheService(86_400_000); // 24 hours TTL
const service = new PermissionService(cache);
let loadingPromise: Promise<void> | null = null;

export const ensurePermissionsLoaded = async () => {
  if (service.isPermissionsLoaded()) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    const db = getFirestore();
    const permissionsDoc = await db
      .collection("system")
      .doc("permissions")
      .get();
    const data = permissionsDoc.data();
    if (!data)
      throw new Error("Permissions document not found at system/permissions");
    const result = service.loadPermissions({
      version: data.version,
      permissions: data.permissions,
      updatedAt: data.updatedAt,
    });
    if (!result.success) {
      throw new Error(
        `Failed to load permission matrix: ${result.errors.join(", ")}`
      );
    }
  })();

  try {
    await loadingPromise;
  } finally {
    loadingPromise = null;
  }
};

export const getPermissionService = () => service;

export const buildPermissionsUserFromAuthRecord = (
  userRecord: UserRecord
): PermUser => {
  const roles = ((userRecord.customClaims as any)?.roles ??
    []) as PermUser["roles"];
  return {
    uid: userRecord.uid,
    email: userRecord.email ?? "",
    roles,
  };
};

export const buildPermissionsUserFromUid = async (
  uid: string
): Promise<PermUser> => {
  const auth = getAuth();
  const record = await auth.getUser(uid);
  return buildPermissionsUserFromAuthRecord(record);
};

export const filterSitesByPermission = (
  user: PermUser,
  siteIds: string[],
  check: {
    resource: (typeof RESOURCES)[keyof typeof RESOURCES];
    action: (typeof ACTIONS)[keyof typeof ACTIONS];
    subResource?: string;
  }
) => {
  const svc = getPermissionService();
  return siteIds.filter((siteId) =>
    svc.canPerformSiteAction(
      user,
      siteId,
      check.resource as any,
      check.action as any,
      check.subResource as any
    )
  );
};

export const bulkCheckForSite = (
  user: PermUser,
  siteId: string,
  checks: PermissionCheck[]
) => getPermissionService().bulkPermissionCheck(user, siteId, checks);
