import {
  GetUserOverviewParamsSchema,
  type GetUserOverviewResult,
} from "@levante-framework/levante-zod";
import { ACTIONS, RESOURCES } from "@levante-framework/permissions-core";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { ORG_TYPE_TO_COLLECTION } from "../orgs/constants.js";
import { isVisibleAssignment } from "../utils/assignment.js";
import {
  buildPermissionsUserFromAuthRecord,
  ensurePermissionsLoaded,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";
import { isRoarUserType, ROAR_TO_LEVANTE_USERTYPE } from "./user-utils.js";

const ORG_TYPES = ["site", "school", "class", "cohort"] as const;

export const getUserOverview = onCall(
  async (req): Promise<GetUserOverviewResult> => {
    const requestingUid = req.auth?.uid;
    if (!requestingUid)
      throw new HttpsError("unauthenticated", "User must be authenticated");

    const parsed = GetUserOverviewParamsSchema.safeParse(req.data);
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", "Invalid input", {
        code: "schema",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const { uid: targetUid } = parsed.data;

    const userRecord = await getAuth().getUser(requestingUid);
    // Legacy permissions
    // TODO: remove after migration
    if (userRecord.customClaims?.useNewPermissions !== true) {
      logger.warn("Permission denied for user overview: legacy permissions", {
        requestingUid,
        targetUid,
      });
      throw new HttpsError(
        "permission-denied",
        "New permission system must be enabled to view user overview"
      );
    }

    const db = getFirestore();
    const userRef = db.collection("users").doc(targetUid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError("not-found", "User not found", {
        code: "user",
        uid: targetUid,
      });
    }

    const roarUserType = userSnap.get("userType");
    const userType = isRoarUserType(roarUserType)
      ? ROAR_TO_LEVANTE_USERTYPE[roarUserType]
      : undefined;
    if (!userType) {
      logger.error("User has an unexpected userType", {
        uid: targetUid,
        userType: roarUserType,
      });
      throw new HttpsError(
        "invalid-argument",
        "User has an unexpected userType",
        { code: "usertype", uid: targetUid, userType: String(roarUserType) }
      );
    } else if (userType === "admin") {
      throw new HttpsError("invalid-argument", "User must not be an admin", {
        code: "usertype",
        uid: targetUid,
        userType: "admin",
      });
    }

    const userSites: string[] = userSnap.get("districts")?.current ?? [];

    await ensurePermissionsLoaded();
    const requestingUser = buildPermissionsUserFromAuthRecord(userRecord);
    const allowedSites = new Set(
      filterSitesByPermission(requestingUser, userSites, {
        resource: RESOURCES.USERS,
        action: ACTIONS.READ,
      })
    );
    const allowed =
      userSites.length > 0 && userSites.every((s) => allowedSites.has(s));
    if (!allowed) {
      throw new HttpsError(
        "permission-denied",
        "You do not have permission to view this user"
      );
    }

    const orgRefs = ORG_TYPES.flatMap((orgType) =>
      (
        (userSnap.get(ORG_TYPE_TO_COLLECTION[orgType])?.current ??
          []) as string[]
      ).map((id) => ({
        orgType,
        ref: db.collection(ORG_TYPE_TO_COLLECTION[orgType]).doc(id),
      }))
    );

    const [orgSnaps, assignmentsSnap] = await Promise.all([
      orgRefs.length ? db.getAll(...orgRefs.map((o) => o.ref)) : [],
      userRef.collection("assignments").get(),
    ]);

    const orgs: GetUserOverviewResult["orgs"] = [];
    const missingOrgs: { orgType: string; id: string }[] = [];
    orgSnaps.forEach((snap, i) => {
      const { orgType } = orgRefs[i];
      if (!snap.exists) {
        missingOrgs.push({ orgType, id: snap.id });
        return;
      }
      orgs.push({ id: snap.id, name: String(snap.get("name")), orgType });
    });
    if (missingOrgs.length > 0) {
      logger.warn("Skipped missing orgs for user overview", {
        uid: targetUid,
        orgs: missingOrgs,
      });
    }

    const now = Timestamp.now();
    const assignments: GetUserOverviewResult["assignments"] = [];
    const skippedAssignmentIds: string[] = [];
    for (const doc of assignmentsSnap.docs) {
      if (!isVisibleAssignment(doc.data())) continue;
      const opened = doc.get("dateOpened") as Timestamp | undefined;
      const closed = doc.get("dateClosed") as Timestamp | undefined;
      if (!opened || !closed) {
        skippedAssignmentIds.push(doc.id);
        continue;
      }
      const status =
        opened.toMillis() > now.toMillis()
          ? "upcoming"
          : closed.toMillis() < now.toMillis()
          ? "closed"
          : "open";
      assignments.push({
        id: doc.id,
        name: String(doc.get("name")),
        status,
        dateOpened: opened.toDate().toISOString(),
        dateClosed: closed.toDate().toISOString(),
      });
    }
    if (skippedAssignmentIds.length > 0) {
      logger.warn("Skipped assignments with missing dates for user overview", {
        uid: targetUid,
        assignmentIds: skippedAssignmentIds,
      });
    }

    const childLabelIndex = userSnap.get("childLabelIndex");

    return {
      uid: targetUid,
      email: String(userSnap.get("email")),
      userType,
      ...(typeof childLabelIndex === "number" ? { childLabelIndex } : {}),
      archived: userSnap.get("archived") === true,
      disabled: userSnap.get("disabled") === true,
      orgs,
      assignments,
    };
  }
);
