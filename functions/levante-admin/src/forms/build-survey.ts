import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";

// Mirrors FullInformationFormField in firestore-schema.ts. Duplicated here (rather
// than imported) so the deployed function does not depend on the schema doc file.
// TODO: replace with the shared zod contract once it exists.
interface InformationFormField {
  itemId: string;
  variableName: string;
  kind: "text" | "number" | "single-select" | "multi-select";
  required: boolean;
  questionText: string;
  options?: { value: string; label: string }[];
  displayLogic?: { field: string; includes: string };
  infoExample?: string;
  notes?: string;
}

export interface BuildSurveyResult {
  formId: string;
  versionId: string;
  versionNumber: number;
  formDescription: string;
  fieldsDescription: Record<string, string>;
  fullFields: InformationFormField[];
}

/**
 * Reads a form definition and its registered (live) version from Firestore and
 * returns the field list the dashboard needs to render the form.
 *
 * Resolves the version in this order:
 *  1. `formDefinitions/{formId}.currentVersionId`, if that version is `registered`.
 *  2. otherwise the highest `versionNumber` among `registered` versions.
 */
async function buildSurvey(formId: string): Promise<BuildSurveyResult> {
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

  // Fall back to the highest-numbered registered version if the current version
  // is missing or not registered.
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
    fullFields?: InformationFormField[];
  };

  return {
    formId,
    versionId: versionSnap.id,
    versionNumber: version.versionNumber ?? 0,
    formDescription: form.formDescription ?? "",
    fieldsDescription: form.fieldsDescription ?? {},
    fullFields: version.fullFields ?? [],
  };
}

// NOTE: these callables intentionally do not require authentication so the form
// mockup can be viewed on a public dashboard route while it is being built out.
// Re-add an `request.auth` check before relying on this in production.

export const buildSchoolSurvey = onCall(
  async (): Promise<BuildSurveyResult> => {
    try {
      return await buildSurvey("schoolInformation");
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.error("buildSchoolSurvey failed", { error });
      throw new HttpsError("internal", "Failed to build school survey.");
    }
  }
);

export const buildSiteSurvey = onCall(async (): Promise<BuildSurveyResult> => {
  try {
    return await buildSurvey("siteInformation");
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    logger.error("buildSiteSurvey failed", { error });
    throw new HttpsError("internal", "Failed to build site survey.");
  }
});
