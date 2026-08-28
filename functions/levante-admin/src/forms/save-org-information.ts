import {
  SaveOrgInformationParamsSchema,
  type SaveOrgInformationResult,
} from "@levante-framework/levante-zod";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import type { FormDefinitionVersion } from "../firestore-schema.js";
import { validateResponseShape } from "./validate-response-shape.js";
import { findMissingRequiredFields } from "./validate-complete-answers.js";

type OrgType = "site" | "school";

function orgCollectionFromOrgType(orgType: OrgType): "districts" | "schools" {
  if (orgType === "site") return "districts";
  return "schools";
}

function informationSubcollectionFromOrgType(
  orgType: OrgType
): "siteInformation" | "schoolInformation" {
  if (orgType === "site") return "siteInformation";
  return "schoolInformation";
}

function responsesForWrite(
  responses: Record<string, unknown>
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(responses)) {
    payload[key] = value === null ? FieldValue.delete() : value;
  }
  return payload;
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
    const db = getFirestore();

    try {
      const userClaimsSnap = await db
        .collection("userClaims")
        .doc(requestingUid)
        .get();
      const isSuperAdmin = userClaimsSnap.data()?.claims?.super_admin === true;

      if (!isSuperAdmin) {
        throw new HttpsError(
          "permission-denied",
          "You must be a super admin to save org information."
        );
      }

      const orgCollection = orgCollectionFromOrgType(orgType);
      const orgRef = db.collection(orgCollection).doc(orgId);
      const orgSnap = await orgRef.get();

      if (!orgSnap.exists) {
        throw new HttpsError(
          "not-found",
          `${orgCollection} document "${orgId}" was not found.`
        );
      }

      const formId = informationSubcollectionFromOrgType(orgType);
      const versionSnap = await db
        .collection("formDefinitions")
        .doc(formId)
        .collection("versions")
        .doc(formVersion)
        .get();

      if (!versionSnap.exists) {
        throw new HttpsError(
          "not-found",
          `Form version "${formVersion}" was not found.`
        );
      }

      const version = versionSnap.data() as FormDefinitionVersion;
      const issues = validateResponseShape(responses, version.fullFields);

      if (issues.length > 0) {
        throw new HttpsError("invalid-argument", "Invalid input", {
          code: "schema",
          issues,
        });
      }

      const responseRef = orgRef.collection(formId).doc(formVersion);
      const path = `${orgCollection}/${orgId}/${formId}/${formVersion}`;

      if (status === "complete") {
        const existingSnap = await responseRef.get();
        const merged: Record<string, unknown> = {
          ...(existingSnap.data() ?? {}),
          ...responses,
        };
        for (const [key, value] of Object.entries(responses)) {
          if (value === null) delete merged[key];
        }
        const missing = findMissingRequiredFields(
          merged,
          version.fullFields
        );

        if (missing.length > 0) {
          throw new HttpsError(
            "failed-precondition",
            `Required fields are missing: ${missing.join(", ")}`
          );
        }
      }

      await responseRef.set(
        {
          ...responsesForWrite(responses),
          formVersion,
          status,
        },
        { merge: true }
      );

      return {
        orgType,
        orgId,
        formVersion,
        status,
        path,
      };
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.error("saveOrgInformation failed", {
        error,
        orgType,
        orgId,
        requestingUid,
      });
      throw new HttpsError("internal", "Failed to save org information.");
    }
  }
);
