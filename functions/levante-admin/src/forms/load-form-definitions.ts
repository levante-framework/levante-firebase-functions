import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";

type OrgType = "site" | "school";

interface FormSectionInfo {
  sectionId: string;
  title: string;
  description: string;
}

interface InformationFormField {
  itemId: string;
  variableName: string;
  kind: "text" | "number" | "single-select" | "multi-select";
  required: boolean;
  sectionId: string;
  questionText: string;
  options?: { value: string; label: string }[];
  displayLogic?: { field: string; includes: string };
  infoExample?: string;
  notes?: string;
}

export interface LoadFormDefinitionsResult {
  formId: string;
  versionId: string;
  versionNumber: number;
  formDescription: string;
  fieldsDescription: Record<string, string>;
  generalPrompt: string;
  sectionInfo: FormSectionInfo[];
  fullFields: InformationFormField[];
  orgType: OrgType;
  orgId: string;
  savedResponses: unknown[];
}

function formIdFromOrgType(orgType: OrgType): string {
  if (orgType === "site") return "siteInformation";
  return "schoolInformation";
}

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

    const { orgType, orgId } = request.data ?? {};

    if (orgType !== "site" && orgType !== "school") {
      throw new HttpsError(
        "invalid-argument",
        "orgType must be site or school"
      );
    }
    if (!orgId || typeof orgId !== "string") {
      throw new HttpsError("invalid-argument", "orgId is required");
    }

    try {
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
