import { getFirestore, type DocumentSnapshot } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { ORG_TYPE_TO_FORM_ID } from "./org-paths.js";

/**
 * Registered version for an org-information form.
 *
 *  1. `currentVersionId`, when that version document exists and is `registered`.
 *  2. otherwise the highest `versionNumber` among `registered` versions.
 *
 * A missing form document is `not-found` / `form-definition`. No registered
 * version is `failed-precondition` / `unregistered`.
 */
export async function resolveRegisteredFormVersion(
  orgType: "site" | "school"
): Promise<{
  formId: (typeof ORG_TYPE_TO_FORM_ID)[typeof orgType];
  formSnap: DocumentSnapshot;
  versionSnap: DocumentSnapshot;
}> {
  const formId = ORG_TYPE_TO_FORM_ID[orgType];
  const formRef = getFirestore().collection("formDefinitions").doc(formId);
  const formSnap = await formRef.get();

  if (!formSnap.exists) {
    throw new HttpsError("not-found", "Form definition not found", {
      code: "form-definition",
      id: formId,
    });
  }

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

  return { formId, formSnap, versionSnap };
}
