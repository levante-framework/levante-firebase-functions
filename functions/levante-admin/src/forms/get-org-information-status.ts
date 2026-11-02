import {
  GetOrgInformationStatusParamsSchema,
  type GetOrgInformationStatusResult,
} from "@levante-framework/levante-zod";
import {
  ACTIONS,
  GROUP_SUB_RESOURCES,
  RESOURCES,
} from "@levante-framework/permissions-core";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { ORG_TYPE_TO_COLLECTION } from "../orgs/constants.js";
import {
  buildPermissionsUserFromAuthRecord,
  ensurePermissionsLoaded,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";
import { ORG_TYPE_TO_FORM_ID } from "./org-paths.js";

/**
 * Registered version for an org-information form.
 *
 * Same order as `loadFormDefinition`:
 *  1. `currentVersionId`, when that version document exists and is `registered`.
 *  2. otherwise the highest `versionNumber` among `registered` versions.
 *
 * A missing form document is treated as no registered version. This callable's
 * error schema has no `form-definition` code.
 */
async function resolveRegisteredVersionId(
  orgType: "site" | "school"
): Promise<string> {
  const formId = ORG_TYPE_TO_FORM_ID[orgType];
  const formRef = getFirestore().collection("formDefinitions").doc(formId);
  const formSnap = await formRef.get();

  const noCurrentVersion = () =>
    new HttpsError(
      "failed-precondition",
      "Form definition has no registered version",
      {
        code: "no-current-version",
        id: formId,
      }
    );

  if (!formSnap.exists) throw noCurrentVersion();

  const currentVersionId = formSnap.get("currentVersionId") as
    | string
    | undefined;
  const versionsRef = formRef.collection("versions");
  let versionSnap = currentVersionId
    ? await versionsRef.doc(currentVersionId).get()
    : null;

  if (!versionSnap?.exists || versionSnap.get("registered") !== true) {
    const registeredSnap = await versionsRef
      .where("registered", "==", true)
      .orderBy("versionNumber", "desc")
      .limit(1)
      .get();

    if (registeredSnap.empty) throw noCurrentVersion();

    versionSnap = registeredSnap.docs[0];
  }

  return versionSnap.id;
}

function progressFromAnswer(
  status: unknown,
  orgId: string
): "incomplete" | "complete" {
  if (status === "draft") return "incomplete";
  if (status === "complete") return "complete";
  throw new HttpsError("internal", "Unexpected org information status", {
    code: "unexpected-status",
    id: orgId,
    status: typeof status === "string" ? status : String(status),
  });
}

export const getOrgInformationStatus = onCall(
  async (request): Promise<GetOrgInformationStatusResult> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const parsed = GetOrgInformationStatusParamsSchema.safeParse(request.data);
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", "Invalid input", {
        code: "schema",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const { orgType, orgId } = parsed.data;

    const userRecord = await getAuth().getUser(request.auth.uid);
    // Legacy permissions
    // TODO: remove after migration
    if (userRecord.customClaims?.useNewPermissions !== true) {
      throw new HttpsError(
        "permission-denied",
        "New permission system must be enabled to get org information status"
      );
    }

    const db = getFirestore();
    const orgCollection = ORG_TYPE_TO_COLLECTION[orgType];
    const orgSnap = await db.collection(orgCollection).doc(orgId).get();

    if (!orgSnap.exists) {
      throw new HttpsError("not-found", "Org not found", {
        code: "org",
        type: orgType,
        id: orgId,
      });
    }

    const siteId = orgType === "site" ? orgId : orgSnap.get("districtId");
    if (typeof siteId !== "string") {
      throw new HttpsError("internal", "School has no site", {
        code: "org-incomplete",
        type: "school",
        id: orgId,
      });
    }

    await ensurePermissionsLoaded();
    const user = buildPermissionsUserFromAuthRecord(userRecord);
    const allowed =
      filterSitesByPermission(user, [siteId], {
        resource: RESOURCES.GROUPS,
        action: ACTIONS.READ,
        subResource:
          orgType === "site"
            ? GROUP_SUB_RESOURCES.SITES
            : GROUP_SUB_RESOURCES.SCHOOLS,
      }).length > 0;
    if (!allowed) {
      logger.warn("Permission denied for getting org information status", {
        requestingUid: request.auth.uid,
        orgType,
        orgId,
        siteId,
      });
      throw new HttpsError(
        "permission-denied",
        `You do not have permission to get org information status for ${orgType} ${orgId}`
      );
    }

    const versionId = await resolveRegisteredVersionId(orgType);
    const formId = ORG_TYPE_TO_FORM_ID[orgType];
    const savedSnap = await db
      .collection(orgCollection)
      .doc(orgId)
      .collection(formId)
      .doc(versionId)
      .get();

    if (!savedSnap.exists) {
      return { orgId, orgType, progress: "not-started" };
    }

    return {
      orgId,
      orgType,
      progress: progressFromAnswer(savedSnap.get("status"), orgId),
    };
  }
);
