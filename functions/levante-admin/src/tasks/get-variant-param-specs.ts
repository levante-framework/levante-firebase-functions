import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { onCall } from "firebase-functions/v2/https";
import {
  GetVariantParamSpecsParamsSchema,
  type GetVariantParamSpecsResult,
} from "@levante-framework/levante-zod";
import {
  assertCanReadTasks,
  isNotArchived,
  requireAuthUid,
  serializeVariantParamSpec,
  throwSchemaError,
} from "./task-management-utils.js";

export const getVariantParamSpecs = onCall(
  async (req): Promise<GetVariantParamSpecsResult> => {
    const uid = requireAuthUid(req.auth?.uid);

    const parsed = GetVariantParamSpecsParamsSchema.safeParse(req.data ?? {});
    if (!parsed.success) throwSchemaError(parsed.error);

    const userRecord = await getAuth().getUser(uid);
    assertCanReadTasks(userRecord.customClaims);

    // Always return non-archived specs. Missing `archived` is treated as false.
    const snap = await getFirestore().collection("variantParamSpecs").get();
    const variantParamSpecs = snap.docs
      .filter((doc) => isNotArchived(doc.data()))
      .map(serializeVariantParamSpec);

    return { variantParamSpecs };
  }
);
