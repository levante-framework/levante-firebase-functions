import { getAuth } from "firebase-admin/auth";
import { FieldPath, getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  GetSiteOverviewParamsSchema,
  type GetSiteOverviewResult,
} from "@levante-framework/levante-zod";
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
        }))
      );
    }
    const { siteId } = parsed.data;

    const userRecord = await getAuth().getUser(uid);
    // Legacy permissions
    // TODO: remove after migration
    if (userRecord.customClaims?.useNewPermissions !== true) {
      logger.warn("Permission denied for site overview: legacy permissions", {
        requestingUid: uid,
        siteId,
      });
      throw new HttpsError(
        "permission-denied",
        "New permission system must be enabled to view site overview"
      );
    }
    await ensurePermissionsLoaded();
    const user = buildPermissionsUserFromAuthRecord(userRecord);
    // All checks required: this view is only routed to roles that have full
    // read access to a site. If any check fails, the caller shouldn't be on
    // this page at all — fail closed rather than returning a partial view.
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
        `You do not have permission to view site ${siteId}`
      );
    }

    const db = getFirestore();
    // TODO(perf): user/assignment counts currently read every matching doc and
    // bucket in memory. If a site grows past a few thousand users, replace the
    // users + administrations reads with `getCountFromServer()` aggregations
    // per bucket (3 user-type counts + 3 assignment-status counts). Requires
    // new composite indexes (userType + districts.current + archived, and
    // siteId + dateOpened/dateClosed combos). Schools/classes/cohorts can stay
    // as list reads since names are needed anyway.
    const [usersSnap, assignmentsSnap, schoolsSnap, classesSnap, cohortsSnap] =
      await Promise.all([
        db
          .collection("users")
          .where(
            new FieldPath("districts", "current"),
            "array-contains",
            siteId
          )
          .where("archived", "==", false)
          .where("disabled", "==", false)
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
    const unexpectedUsers: { id: string; userType: unknown }[] = [];
    for (const doc of usersSnap.docs) {
      const userType = doc.get("userType");
      switch (userType) {
        case "teacher":
          userCounts.teachers++;
          break;
        case "parent":
          userCounts.caregivers++;
          break;
        case "student":
          userCounts.children++;
          break;
        case "admin":
          // Admins are intentionally excluded from welcome-page counts.
          break;
        default:
          unexpectedUsers.push({ id: doc.id, userType });
      }
    }
    if (unexpectedUsers.length > 0) {
      logger.warn("Skipped users with unexpected userType", {
        siteId,
        users: unexpectedUsers,
      });
    }

    const now = Timestamp.now();
    const assignmentCounts = { open: 0, upcoming: 0, closed: 0 };
    const skippedAssignmentIds: string[] = [];
    for (const doc of assignmentsSnap.docs) {
      const opened = doc.get("dateOpened") as Timestamp | undefined;
      const closed = doc.get("dateClosed") as Timestamp | undefined;
      // Schema declares both fields required; missing dates indicate drift.
      // Skip rather than bucket arbitrarily, but surface IDs so we can fix the data.
      if (!opened || !closed) {
        skippedAssignmentIds.push(doc.id);
        continue;
      }
      if (opened.toMillis() > now.toMillis()) assignmentCounts.upcoming++;
      else if (closed.toMillis() < now.toMillis()) assignmentCounts.closed++;
      else assignmentCounts.open++;
    }
    if (skippedAssignmentIds.length > 0) {
      logger.warn("Skipped assignments with missing dates", {
        siteId,
        assignmentIds: skippedAssignmentIds,
      });
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
  }
);
