import {
  GetSiteOverviewParamsSchema,
  type GetSiteOverviewResult,
} from "@levante-framework/levante-zod";
import { getAuth } from "firebase-admin/auth";
import { FieldPath, getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  ACTIONS,
  GROUP_SUB_RESOURCES,
  RESOURCES,
} from "@levante-framework/permissions-core";
import {
  buildPermissionsUserFromAuthRecord,
  bulkCheckForSite,
  ensurePermissionsLoaded,
} from "../utils/permission-helpers.js";

export const getSiteOverview = onCall(
  async (req): Promise<GetSiteOverviewResult> => {
    const uid = req.auth?.uid;
    if (!uid)
      throw new HttpsError("unauthenticated", "User must be authenticated");

    const parsed = GetSiteOverviewParamsSchema.safeParse(req.data);
    if (!parsed.success) {
      throw new HttpsError(
        "invalid-argument",
        "Invalid input",
        parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      );
    }
    const { siteId } = parsed.data;

    const userRecord = await getAuth().getUser(uid);
    // Legacy permissions (@TODO: remove after migration)
    if (userRecord.customClaims?.useNewPermissions !== true) {
      logger.warn("Permission denied for site overview: legacy permissions", {
        requestingUid: uid,
        siteId,
      });
      throw new HttpsError(
        "permission-denied",
        "New permission system must be enabled to view site overview",
      );
    }
    await ensurePermissionsLoaded();
    const user = buildPermissionsUserFromAuthRecord(userRecord);
    const checks = bulkCheckForSite(user, siteId, [
      { resource: RESOURCES.USERS, action: ACTIONS.READ },
      { resource: RESOURCES.ASSIGNMENTS, action: ACTIONS.READ },
      {
        resource: RESOURCES.GROUPS,
        action: ACTIONS.READ,
        subResource: GROUP_SUB_RESOURCES.SCHOOLS,
      },
      {
        resource: RESOURCES.GROUPS,
        action: ACTIONS.READ,
        subResource: GROUP_SUB_RESOURCES.CLASSES,
      },
      {
        resource: RESOURCES.GROUPS,
        action: ACTIONS.READ,
        subResource: GROUP_SUB_RESOURCES.COHORTS,
      },
    ]);
    const denied = checks.filter((c) => !c.allowed);
    if (denied.length > 0) {
      logger.warn("Permission denied for site overview", {
        requestingUid: uid,
        siteId,
        denied: denied.map((c) => ({
          resource: c.resource,
          action: c.action,
          subResource: c.subResource,
        })),
      });
      throw new HttpsError(
        "permission-denied",
        `You do not have permission to view site ${siteId}`,
      );
    }

    const db = getFirestore();
    const [usersSnap, assignmentsSnap, schoolsSnap, classesSnap, cohortsSnap] =
      await Promise.all([
        db
          .collection("users")
          .where(
            new FieldPath("districts", "current"),
            "array-contains",
            siteId,
          )
          .where("archived", "==", false)
          .select("userType")
          .get(),
        db
          .collection("administrations")
          .where("siteId", "==", siteId)
          .select("dateOpened", "dateClosed")
          .get(),
        db
          .collection("schools")
          .where("districtId", "==", siteId)
          .where("archived", "==", false)
          .select("name")
          .get(),
        db
          .collection("classes")
          .where("districtId", "==", siteId)
          .where("archived", "==", false)
          .select("name", "schoolId")
          .get(),
        db
          .collection("groups")
          .where("parentOrgId", "==", siteId)
          .where("archived", "==", false)
          .select("name")
          .get(),
      ]);

    const userCounts = { teachers: 0, caregivers: 0, children: 0 };
    for (const doc of usersSnap.docs) {
      switch (doc.get("userType")) {
        case "teacher":
          userCounts.teachers++;
          break;
        case "parent":
          userCounts.caregivers++;
          break;
        case "student":
          userCounts.children++;
          break;
      }
    }

    const now = Timestamp.now();
    const assignmentCounts = { open: 0, upcoming: 0, closed: 0 };
    for (const doc of assignmentsSnap.docs) {
      const opened = doc.get("dateOpened") as Timestamp | undefined;
      const closed = doc.get("dateClosed") as Timestamp | undefined;
      if (!opened || !closed) continue;
      if (opened.toMillis() > now.toMillis()) assignmentCounts.upcoming++;
      else if (closed.toMillis() < now.toMillis()) assignmentCounts.closed++;
      else assignmentCounts.open++;
    }

    return {
      counts: { users: userCounts, assignments: assignmentCounts },
      schools: schoolsSnap.docs.map((d) => ({
        id: d.id,
        name: d.get("name"),
      })),
      classes: classesSnap.docs.map((d) => ({
        id: d.id,
        name: d.get("name"),
        schoolId: d.get("schoolId"),
      })),
      cohorts: cohortsSnap.docs.map((d) => ({
        id: d.id,
        name: d.get("name"),
      })),
    };
  },
);
