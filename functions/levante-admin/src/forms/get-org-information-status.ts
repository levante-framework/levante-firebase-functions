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

type OrgStatusResult = GetOrgInformationStatusResult["results"][number];

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

function resultFromAnswer(orgId: string, status: unknown): OrgStatusResult {
  if (status === "draft") return { orgId, progress: "incomplete" };
  if (status === "complete") return { orgId, progress: "complete" };
  return {
    orgId,
    error: {
      code: "unexpected-status",
      status: typeof status === "string" ? status : String(status),
    },
  };
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
    const { orgType, orgIds } = parsed.data;

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
    const uniqueOrgIds = [...new Set(orgIds)];
    const orgSnaps = await db.getAll(
      ...uniqueOrgIds.map((orgId) => db.collection(orgCollection).doc(orgId))
    );
    const orgSnapById = new Map(orgSnaps.map((snap) => [snap.id, snap]));

    const siteIdByOrgId = new Map<string, string>();
    const errorByOrgId = new Map<string, OrgStatusResult>();
    for (const orgId of uniqueOrgIds) {
      const orgSnap = orgSnapById.get(orgId);
      if (!orgSnap?.exists) {
        errorByOrgId.set(orgId, { orgId, error: { code: "org" } });
        continue;
      }

      if (orgType === "site") {
        siteIdByOrgId.set(orgId, orgId);
        continue;
      }

      const siteId = orgSnap.get("districtId");
      if (typeof siteId !== "string") {
        errorByOrgId.set(orgId, {
          orgId,
          error: { code: "org-incomplete" },
        });
        continue;
      }
      siteIdByOrgId.set(orgId, siteId);
    }

    const siteIds = [...new Set(siteIdByOrgId.values())];
    if (siteIds.length > 0) {
      await ensurePermissionsLoaded();
      const user = buildPermissionsUserFromAuthRecord(userRecord);
      const allowed = filterSitesByPermission(user, siteIds, {
        resource: RESOURCES.GROUPS,
        action: ACTIONS.READ,
        subResource:
          orgType === "site"
            ? GROUP_SUB_RESOURCES.SITES
            : GROUP_SUB_RESOURCES.SCHOOLS,
      });
      if (allowed.length !== siteIds.length) {
        logger.warn("Permission denied for getting org information status", {
          requestingUid: request.auth.uid,
          orgType,
          siteIds: siteIds.filter((siteId) => !allowed.includes(siteId)),
        });
        throw new HttpsError(
          "permission-denied",
          `You do not have permission to get org information status for ${orgType}`
        );
      }
    }

    const versionId = await resolveRegisteredVersionId(orgType);
    const formId = ORG_TYPE_TO_FORM_ID[orgType];
    const readableOrgIds = uniqueOrgIds.filter((orgId) =>
      siteIdByOrgId.has(orgId)
    );
    const answerSnaps =
      readableOrgIds.length === 0
        ? []
        : await db.getAll(
            ...readableOrgIds.map((orgId) =>
              db
                .collection(orgCollection)
                .doc(orgId)
                .collection(formId)
                .doc(versionId)
            )
          );
    const answerSnapByOrgId = new Map(
      readableOrgIds.map((orgId, index) => [orgId, answerSnaps[index]])
    );

    const results = orgIds.map((orgId): OrgStatusResult => {
      const error = errorByOrgId.get(orgId);
      if (error) return error;

      const savedSnap = answerSnapByOrgId.get(orgId);
      if (!savedSnap?.exists) return { orgId, progress: "not-started" };
      return resultFromAnswer(orgId, savedSnap.get("status"));
    });

    const failed = results.flatMap((result) =>
      "error" in result ? [result] : []
    );
    if (failed.length > 0) {
      logger.warn("Org information status item errors", {
        orgType,
        results: failed,
      });
    }

    return { orgType, results };
  }
);
