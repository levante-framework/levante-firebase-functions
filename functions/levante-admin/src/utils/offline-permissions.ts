import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import {
  buildPermissionsUserFromAuthRecord,
  ensurePermissionsLoaded,
  filterSitesByPermission,
} from "./permission-helpers.js";

type Resource = (typeof RESOURCES)[keyof typeof RESOURCES];
type Action = (typeof ACTIONS)[keyof typeof ACTIONS];

/**
 * Gate for the offline-launcher callables: the caller must be a super admin, or an
 * administrator allowed to perform `check` on at least one of `siteIds`. Uses the
 * permissions-core matrix when the caller is on the new permission system, and falls
 * back to the legacy `adminOrgs.districts` on the caller's userClaims document otherwise.
 */
export async function assertSiteAccess(
  callerUid: string,
  siteIds: string[],
  check: { resource: Resource; action: Action },
  what: string
): Promise<void> {
  const record = await getAuth().getUser(callerUid);
  const claims = (record.customClaims ?? {}) as Record<string, unknown>;
  if (claims.super_admin === true) return;

  if (siteIds.length === 0) {
    throw new HttpsError(
      "failed-precondition",
      `Cannot ${what}: no site to check permissions against`
    );
  }

  if (claims.useNewPermissions === true) {
    await ensurePermissionsLoaded();
    const user = buildPermissionsUserFromAuthRecord(record);
    if (filterSitesByPermission(user, siteIds, check).length > 0) return;
  } else {
    const claimsDoc = await getFirestore()
      .collection("userClaims")
      .doc(callerUid)
      .get();
    const adminOrgs = (claimsDoc.get("claims.adminOrgs") ?? {}) as {
      districts?: string[];
    };
    if ((adminOrgs.districts ?? []).some((d) => siteIds.includes(d))) return;
  }

  throw new HttpsError(
    "permission-denied",
    `You do not have permission to ${what}`
  );
}

/** Districts a user document belongs to (current membership first, then history). */
export function districtsOf(
  userData: FirebaseFirestore.DocumentData | undefined
): string[] {
  const districts = (userData?.districts ?? {}) as {
    current?: string[];
    all?: string[];
  };
  return [...new Set([...(districts.current ?? []), ...(districts.all ?? [])])];
}
