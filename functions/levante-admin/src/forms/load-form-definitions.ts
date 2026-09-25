import {
  type FormSectionInfo,
  type InformationFormField,
  LoadFormDefinitionsParamsSchema,
  type LoadFormDefinitionsResult,
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
 * Reads a form definition and its registered (live) version from Firestore.
 *
 * Resolves the version in this order:
 *  1. `formDefinitions/{formId}.currentVersionId`, if that version is `registered`.
 *  2. otherwise the highest `versionNumber` among `registered` versions.
 */
async function loadFormDefinition(orgType: "site" | "school") {
  const db = getFirestore();

  const formId = ORG_TYPE_TO_FORM_ID[orgType];
  const formRef = db.collection("formDefinitions").doc(formId);
  const formSnap = await formRef.get();

  if (!formSnap.exists) {
    throw new HttpsError("not-found", "Form definition not found", {
      code: "form-definition",
      id: formId,
    });
  }

  const form = formSnap.data() as {
    currentVersionId?: string;
    formDescription?: string;
    fieldsDescription?: Record<string, string>;
  };

  const versionsRef = formRef.collection("versions");
  let versionSnap = form.currentVersionId
    ? await versionsRef.doc(form.currentVersionId).get()
    : null;

  if (!versionSnap?.exists || versionSnap.get("registered") !== true) {
    const registeredSnap = await versionsRef
      .where("registered", "==", true)
      .orderBy("versionNumber", "desc")
      .limit(1)
      .get();

    if (registeredSnap.empty) {
      throw new HttpsError(
        "failed-precondition",
        "Form definition has no registered version",
        {
          code: "unregistered",
          id: formId,
        }
      );
    }

    versionSnap = registeredSnap.docs[0];
  }

  const version = versionSnap.data() as {
    versionNumber?: number;
    generalPrompt?: string;
    sectionInfo?: FormSectionInfo[];
    fullFields?: InformationFormField[];
  };

  return {
    formId,
    versionId: versionSnap.id,
    versionNumber: version.versionNumber ?? 0,
    formDescription: form.formDescription ?? "",
    fieldsDescription: form.fieldsDescription ?? {},
    generalPrompt: version.generalPrompt ?? "",
    sectionInfo: version.sectionInfo ?? [],
    fullFields: version.fullFields ?? [],
  };
}

export const loadFormDefinitions = onCall(
  async (request): Promise<LoadFormDefinitionsResult> => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const parsed = LoadFormDefinitionsParamsSchema.safeParse(request.data);
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
        "New permission system must be enabled to load form definitions"
      );
    }

    const orgCollection = ORG_TYPE_TO_COLLECTION[orgType];
    const orgSnap = await getFirestore()
      .collection(orgCollection)
      .doc(orgId)
      .get();

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
      logger.warn("Permission denied for loading form definitions", {
        requestingUid: request.auth.uid,
        orgType,
        orgId,
        siteId,
      });
      throw new HttpsError(
        "permission-denied",
        `You do not have permission to load form definitions for ${orgType} ${orgId}`
      );
    }

    const definition = await loadFormDefinition(orgType);

    return {
      ...definition,
      orgType,
      orgId,
      savedResponses: [],
    };
  }
);
