import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { getAuth, UserRecord } from "firebase-admin/auth";
import { logger } from "firebase-functions/v2";
import { HttpsError } from "firebase-functions/v2/https";
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
import { normalizeRoleKey } from "./role-helpers.js";
import type { CallableRequest } from "firebase-functions/v2/https";

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
      const normalizedRole = normalizeRoleKey(role);
      if (!normalizedRole) continue;
      const key = `${siteId}:${normalizedRole}`;
      if (seen.has(key)) continue;
      seen.add(key);
      roles.push({
        siteId,
        siteName: siteNames[siteId] ?? siteId,
        role: normalizedRole,
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

/**
 * 
 * @param operation - The operation being performed.
 * @param request - The request object.
 * @param resource - The resource being performed.
 * @param action - The action being performed.
 * @param subResource - The sub-resource being performed.
 * @param config - The configuration object for the operation.
 * @returns void
 * @throws HttpsError if the user is not authenticated or does not have permission to perform the operation.
 * 
 */
export const checkPermission = async (
  operation: string,
  request: CallableRequest<any>,
  resource: (typeof RESOURCES)[keyof typeof RESOURCES],
  action: (typeof ACTIONS)[keyof typeof ACTIONS],
  subResource?: string,
  config: Record<string, any> = {},
): Promise<void> => {
  const requestingUid = request.auth?.uid;
  if (!requestingUid) {
    logger.error("User is not authenticated.");
    throw new HttpsError("unauthenticated", "User must be authenticated.");
  }
  try {
    const auth = getAuth();
    const userRecord = await auth.getUser(requestingUid);
    const customClaims: any = userRecord.customClaims || {};
    const useNewPermissions = customClaims.useNewPermissions === true;
    if (!useNewPermissions) {
      throw new HttpsError(
        "permission-denied",
        `New permission system must be enabled to ${operation}`
      );
    }
    await ensurePermissionsLoaded();
    const user = buildPermissionsUserFromAuthRecord(userRecord);

    const siteId = request.data.siteId;

    if (!siteId) {
      logger.error(`Missing site identifier for ${operation}`, {
        requestingUid,
        config,
      });
      throw new HttpsError(
        "invalid-argument",
        `A siteId (or districtId) is required to ${operation}`
      );
    }

    const allowed =
      filterSitesByPermission(user, [siteId], {
        resource,
        action,
        subResource,
      }).length > 0;

    if (!allowed) {
      logger.error(`Permission denied for ${operation}`, {
        requestingUid,
        config,
        siteId,
      });
      throw new HttpsError(
        "permission-denied",
        `You do not have permission to ${operation} in site ${siteId}`
      );
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError(
      "internal",
      (err as Error)?.message || "Permission check failed"
    );
  }
}
