import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  GetTaskVariantRevisionsParamsSchema,
  type GetTaskVariantRevisionsResult,
} from "@levante-framework/levante-zod";
import {
  assertCanWriteTasks,
  requireAuthUid,
  resolveAttributionEmails,
  serializeTaskVariantRevision,
  throwSchemaError,
} from "./task-management-utils.js";

/**
 * Returns the registered/deregistered revision history for a variant.
 * Super-admin only.
 */
export const getTaskVariantRevisions = onCall(
  async (req): Promise<GetTaskVariantRevisionsResult> => {
    const uid = requireAuthUid(req.auth?.uid);

    const parsed = GetTaskVariantRevisionsParamsSchema.safeParse(req.data ?? {});
    if (!parsed.success) throwSchemaError(parsed.error);

    const { variantId } = parsed.data;

    const userRecord = await getAuth().getUser(uid);
    assertCanWriteTasks(userRecord.customClaims);

    const db = getFirestore();
    // Only the ref/path is needed to locate the variant; select() keeps the
    // collection-group scan from transferring every field.
    const variantsSnap = await db.collectionGroup("variants").select().get();
    const variantDoc = variantsSnap.docs.find((doc) => doc.id === variantId);

    if (!variantDoc) {
      throw new HttpsError("not-found", `Variant ${variantId} not found`, {
        code: "variant",
        variantId,
      });
    }

    const revisionsSnap = await variantDoc.ref
      .collection("revisions")
      .orderBy("updatedAt", "desc")
      .get();

    const revisions = await resolveAttributionEmails(
      revisionsSnap.docs.map(serializeTaskVariantRevision)
    );

    return { variantId, revisions };
  }
);
