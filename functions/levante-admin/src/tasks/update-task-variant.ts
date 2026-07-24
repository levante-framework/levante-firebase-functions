import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  UpdateTaskVariantParamsSchema,
  type UpdateTaskVariantResult,
} from "@levante-framework/levante-zod";
import {
  assertCanWriteTasks,
  requireAuthUid,
  resolveAttributionEmails,
  serializeTaskVariant,
  taskIdFromVariantPath,
  throwSchemaError,
  writeVariantRevision,
} from "./task-management-utils.js";

export const updateTaskVariant = onCall(
  async (req): Promise<UpdateTaskVariantResult> => {
    const uid = requireAuthUid(req.auth?.uid);

    const parsed = UpdateTaskVariantParamsSchema.safeParse(req.data ?? {});
    if (!parsed.success) throwSchemaError(parsed.error);

    const { id, archived, registered } = parsed.data;

    const userRecord = await getAuth().getUser(uid);
    assertCanWriteTasks(userRecord.customClaims);

    const db = getFirestore();
    const variantsSnap = await db.collectionGroup("variants").get();
    const matched = variantsSnap.docs.find((doc) => doc.id === id);

    if (!matched) {
      throw new HttpsError("not-found", `Variant ${id} not found`, {
        code: "variant",
        variantId: id,
      });
    }

    const taskId = taskIdFromVariantPath(matched.ref.path);
    if (!taskId) {
      throw new HttpsError("not-found", `Variant ${id} not found`, {
        code: "variant",
        variantId: id,
      });
    }

    const now = FieldValue.serverTimestamp();
    await matched.ref.update({
      archived,
      registered,
      updatedAt: now,
      updatedBy: uid,
    });

    const updated = await matched.ref.get();
    await writeVariantRevision(updated, {
      archived,
      registered,
      updatedBy: uid,
    });

    return {
      variant: (
        await resolveAttributionEmails([
          serializeTaskVariant(updated, taskId, registered),
        ])
      )[0],
    };
  }
);
