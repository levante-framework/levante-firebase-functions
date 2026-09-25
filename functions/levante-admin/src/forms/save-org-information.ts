import {
  SaveOrgInformationParamsSchema,
  type SaveOrgInformationResult,
} from "@levante-framework/levante-zod";
import {
  ACTIONS,
  GROUP_SUB_RESOURCES,
  RESOURCES,
} from "@levante-framework/permissions-core";
import { getAuth } from "firebase-admin/auth";
import {
  type DocumentSnapshot,
  FieldValue,
  type Firestore,
  getFirestore,
  type Transaction,
} from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import type { FormDefinitionVersion } from "../firestore-schema.js";
import { ORG_TYPE_TO_COLLECTION } from "../orgs/constants.js";
import {
  buildPermissionsUserFromAuthRecord,
  ensurePermissionsLoaded,
  filterSitesByPermission,
} from "../utils/permission-helpers.js";
import { ORG_TYPE_TO_FORM_ID } from "./org-paths.js";
import { findMissingRequiredFields } from "./validate-complete-answers.js";
import { validateResponseShape } from "./validate-response-shape.js";

function responsesForWrite(
  responses: Record<string, unknown>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(responses)) {
    payload[key] = value === null ? FieldValue.delete() : value;
  }
  return payload;
}

function requiredString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

async function coreFieldsFromOrg(
  orgType: "site" | "school",
  orgId: string,
  orgSnap: DocumentSnapshot,
  db: Firestore,
  tx: Transaction
): Promise<Record<string, unknown>> {
  if (orgType === "site") return { siteId: orgId };

  const districtId = requiredString(orgSnap.get("districtId"));
  if (!districtId) {
    throw new HttpsError("internal", "School has no site", {
      code: "org-incomplete",
      type: "school",
      id: orgId,
    });
  }

  const schoolName = requiredString(orgSnap.get("name"));
  if (!schoolName) {
    throw new HttpsError("internal", "School has no name", {
      code: "org-incomplete",
      type: "school",
      id: orgId,
    });
  }

  const districtSnap = await tx.get(db.collection("districts").doc(districtId));
  if (!districtSnap.exists) {
    throw new HttpsError("internal", "School references a missing site", {
      code: "org-incomplete",
      type: "school",
      id: orgId,
    });
  }

  const siteName = requiredString(districtSnap.get("name"));
  if (!siteName) {
    throw new HttpsError("internal", "Site has no name", {
      code: "org-incomplete",
      type: "site",
      id: districtId,
    });
  }

  return {
    schoolId: orgId,
    siteId: districtId,
    schoolPseudonym: schoolName,
    siteName,
  };
}

export const saveOrgInformation = onCall(
  async (request): Promise<SaveOrgInformationResult> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const parsed = SaveOrgInformationParamsSchema.safeParse(request.data);
    if (!parsed.success) {
      throw new HttpsError("invalid-argument", "Invalid input", {
        code: "schema",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
    }
    const { orgType, orgId, formVersion, responses, status } = parsed.data;

    const requestingUid = request.auth.uid;
    const userRecord = await getAuth().getUser(requestingUid);
    // Legacy permissions
    // TODO: remove after migration
    if (userRecord.customClaims?.useNewPermissions !== true) {
      throw new HttpsError(
        "permission-denied",
        "New permission system must be enabled to save org information"
      );
    }

    const db = getFirestore();
    const orgCollection = ORG_TYPE_TO_COLLECTION[orgType];
    const orgRef = db.collection(orgCollection).doc(orgId);
    const orgSnap = await orgRef.get();

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
        action: ACTIONS.UPDATE,
        subResource:
          orgType === "site"
            ? GROUP_SUB_RESOURCES.SITES
            : GROUP_SUB_RESOURCES.SCHOOLS,
      }).length > 0;
    if (!allowed) {
      logger.warn("Permission denied for saving org information", {
        requestingUid,
        orgType,
        orgId,
        siteId,
      });
      throw new HttpsError(
        "permission-denied",
        `You do not have permission to save org information for ${orgType} ${orgId}`
      );
    }

    const formId = ORG_TYPE_TO_FORM_ID[orgType];
    const versionSnap = await db
      .collection("formDefinitions")
      .doc(formId)
      .collection("versions")
      .doc(formVersion)
      .get();

    if (!versionSnap.exists) {
      throw new HttpsError("not-found", "Form version not found", {
        code: "form-version",
        id: formVersion,
      });
    }

    if (versionSnap.get("registered") !== true) {
      throw new HttpsError(
        "failed-precondition",
        "Form version is not registered",
        {
          code: "unregistered",
          id: formVersion,
        }
      );
    }

    const version = versionSnap.data() as FormDefinitionVersion;
    const issues = validateResponseShape(responses, version.fullFields);

    if (issues.length > 0) {
      throw new HttpsError("invalid-argument", "Invalid responses", {
        code: "responses",
        issues,
      });
    }

    const responseRef = orgRef.collection(formId).doc(formVersion);
    const path = `${orgCollection}/${orgId}/${formId}/${formVersion}`;
    let savedStatus = status;

    await db.runTransaction(async (tx) => {
      const existingSnap = await tx.get(responseRef);
      const existing = existingSnap.data();

      if (existing?.status === "complete" && status === "draft") {
        savedStatus = "complete";
        return;
      }

      const coreFields = await coreFieldsFromOrg(
        orgType,
        orgId,
        orgSnap,
        db,
        tx
      );

      if (status === "complete") {
        const merged: Record<string, unknown> = {
          ...(existing ?? {}),
          ...responses,
        };
        for (const [key, value] of Object.entries(responses)) {
          if (value === null) delete merged[key];
        }
        const missing = findMissingRequiredFields(merged, version.fullFields);

        if (missing.length > 0) {
          throw new HttpsError(
            "failed-precondition",
            "Required fields are missing",
            {
              code: "missing-fields",
              fields: missing,
            }
          );
        }
      }

      const payload: Record<string, unknown> = {
        ...responsesForWrite(responses),
        ...coreFields,
        formVersion,
        status,
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (!existingSnap.exists) {
        payload.createdAt = FieldValue.serverTimestamp();
      }
      tx.set(responseRef, payload, { merge: true });
    });

    return {
      orgType,
      orgId,
      formVersion,
      status: savedStatus,
      path,
    };
  }
);
