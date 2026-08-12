import {
  SaveOrgInformationParamsSchema,
  type SaveOrgInformationResult,
} from "@levante-framework/levante-zod";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError, onCall } from "firebase-functions/v2/https";

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

      const subcollection = informationSubcollectionFromOrgType(orgType);
      const responseRef = orgRef.collection(subcollection).doc("response");
      const path = `${orgCollection}/${orgId}/${subcollection}/response`;

      await responseRef.set(
        {
          ...responses,
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
