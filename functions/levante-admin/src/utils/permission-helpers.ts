import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getAuth, UserRecord } from "firebase-admin/auth";
import {
  ACTIONS,
  RESOURCES,
  CacheService,
  PermissionService,
  type User as PermUser,
  type PermissionCheck,
  type LoggingModeConfig,
  type PermEventSink,
} from "@levante-framework/permissions-core";
import {
  PERMISSION_LOGGING_MODE,
  FIRESTORE_PERMISSIONS_DOCUMENT,
  FIRESTORE_PERMISSIONS_LOGS_COLLECTION,
  FIRESTORE_SYSTEM_COLLECTION,
} from "./constants.js";

export const createPermissionsFirestoreSink = (
  loggingConfig: LoggingModeConfig
): PermEventSink => {
  return {
    isEnabled: () => loggingConfig.mode !== "off",
    emit: (event) => {
      setImmediate(async () => {
        try {
          const db = getFirestore();
          const logsCollection = db
            .collection(FIRESTORE_SYSTEM_COLLECTION)
            .doc(FIRESTORE_PERMISSIONS_DOCUMENT)
            .collection(FIRESTORE_PERMISSIONS_LOGS_COLLECTION);
          await logsCollection.add({
            ...event,
            expireAt: Timestamp.fromMillis(
              Date.now() + 1000 * 60 * 60 * 24 * 90 // 90 days from now. TTL is not turned on yet.
            ),
          });
        } catch (error) {
          console.warn("Failed to write permission log event", error);
        }
      });
    },
  };
};

// Singleton permission service shared across functions
const cache = new CacheService(86_400_000); // 24 hours TTL
const loggingConfig: LoggingModeConfig = {
  mode: PERMISSION_LOGGING_MODE,
};
const service = new PermissionService(
  cache,
  loggingConfig,
  createPermissionsFirestoreSink(loggingConfig)
);
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

const transformClaimsToRoles = (customClaims: unknown): PermUser["roles"] => {
  const { siteRoles = {}, siteNames = {} } = (customClaims ?? {}) as {
    siteRoles?: Record<string, string[]>;
    siteNames?: Record<string, string>;
  };

  const seen = new Set<string>();
  const roles: Array<{ siteId: string; siteName: string; role: string }> = [];

  for (const [siteId, roleList] of Object.entries(siteRoles)) {
    for (const role of roleList) {
      if (!role) continue;
      const key = `${siteId}:${role}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roles.push({
        siteId,
        siteName: siteNames[siteId] ?? siteId,
        role,
      });
    }
  }

  return roles as PermUser["roles"];
};

export const buildPermissionsUserFromAuthRecord = (
  userRecord: UserRecord
): PermUser => {
  const roles = transformClaimsToRoles(userRecord.customClaims);
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
