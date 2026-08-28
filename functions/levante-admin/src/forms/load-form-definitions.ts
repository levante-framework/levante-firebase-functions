import {
  type FormSectionInfo,
  type InformationFormField,
  LoadFormDefinitionsParamsSchema,
  type LoadFormDefinitionsResult,
} from "@levante-framework/levante-zod";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { formIdFromOrgType, orgCollectionFromOrgType } from "./org-paths.js";

/**
 * Reads a form definition and its registered (live) version from Firestore.
 *
 * Resolves the version in this order:
 *  1. `formDefinitions/{formId}.currentVersionId`, if that version is `registered`.
 *  2. otherwise the highest `versionNumber` among `registered` versions.
 */
async function loadFormDefinition(formId: string) {
  const db = getFirestore();

  const formRef = db.collection("formDefinitions").doc(formId);
  const formSnap = await formRef.get();

  if (!formSnap.exists) {
    throw new HttpsError(
      "not-found",
      `Form definition "${formId}" was not found.`
    );
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
        `Form "${formId}" has no registered version.`
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

    try {
      const orgCollection = orgCollectionFromOrgType(orgType);
      const orgSnap = await getFirestore()
        .collection(orgCollection)
        .doc(orgId)
        .get();

      if (!orgSnap.exists) {
        throw new HttpsError(
          "not-found",
          `${orgCollection} document "${orgId}" was not found.`
        );
      }

      const formId = formIdFromOrgType(orgType);
      const definition = await loadFormDefinition(formId);

      return {
        ...definition,
        orgType,
        orgId,
        savedResponses: [],
      };
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.error("loadFormDefinitions failed", { error, orgType, orgId });
      throw new HttpsError("internal", "Failed to load form definitions.");
    }
  }
);
