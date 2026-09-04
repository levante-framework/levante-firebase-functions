import { getAuth } from "firebase-admin/auth";
import {
  getFirestore,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  GetTaskVariantsParamsSchema,
  type GetTaskVariantsResult,
  type SerializedTaskVariant,
} from "@levante-framework/levante-zod";
import {
  assertCanReadTasks,
  isNotArchived,
  requireAuthUid,
  resolveAttributionEmails,
  resolveRegisteredFromLatestRevision,
  serializeTaskVariant,
  taskIdFromVariantPath,
  throwSchemaError,
} from "./task-management-utils.js";

async function buildVariantResult(
  doc: QueryDocumentSnapshot,
  taskId: string,
  registeredFilter: boolean | undefined
): Promise<SerializedTaskVariant | null> {
  const registered = await resolveRegisteredFromLatestRevision(doc);
  if (registeredFilter !== undefined && registered !== registeredFilter) {
    return null;
  }
  return serializeTaskVariant(doc, taskId, registered);
}

export const getTaskVariants = onCall(
  async (req): Promise<GetTaskVariantsResult> => {
    const uid = requireAuthUid(req.auth?.uid);

    const parsed = GetTaskVariantsParamsSchema.safeParse(req.data ?? {});
    if (!parsed.success) throwSchemaError(parsed.error);

    const { registered, taskId, variantIds } = parsed.data;

    const userRecord = await getAuth().getUser(uid);
    assertCanReadTasks(userRecord.customClaims);

    const db = getFirestore();

    if (taskId) {
      const taskRef = db.collection("tasks").doc(taskId);
      const taskSnap = await taskRef.get();
      if (!taskSnap.exists) {
        throw new HttpsError("not-found", `Task ${taskId} not found`, {
          code: "task",
          taskId,
        });
      }

      const variantsSnap = await taskRef.collection("variants").get();
      const variants = (
        await Promise.all(
          variantsSnap.docs
            .filter((doc) => isNotArchived(doc.data()))
            .map((doc) => buildVariantResult(doc, taskId, registered))
        )
      ).filter((variant): variant is SerializedTaskVariant => variant !== null);

      return { variants: await resolveAttributionEmails(variants) };
    }

    if (variantIds) {
      const variantsSnap = await db.collectionGroup("variants").get();
      const byId = new Map(
        variantsSnap.docs
          .filter((doc) => isNotArchived(doc.data()))
          .map((doc) => [doc.id, doc])
      );

      const missing: string[] = [];
      const variants: SerializedTaskVariant[] = [];
      for (const variantId of variantIds) {
        const doc = byId.get(variantId);
        if (!doc) {
          missing.push(variantId);
          continue;
        }
        const parentTaskId = taskIdFromVariantPath(doc.ref.path);
        if (!parentTaskId) {
          missing.push(variantId);
          continue;
        }
        const variant = await buildVariantResult(doc, parentTaskId, registered);
        if (variant) variants.push(variant);
      }

      if (missing.length > 0) {
        throw new HttpsError(
          "not-found",
          `Variants not found: ${missing.join(", ")}`,
          {
            code: "variants",
            variantIds: missing,
          }
        );
      }

      return { variants: await resolveAttributionEmails(variants) };
    }

    // No taskId / variantIds: return all non-archived variants.
    const variantsSnap = await db.collectionGroup("variants").get();
    const variants = (
      await Promise.all(
        variantsSnap.docs
          .filter((doc) => {
            if (!isNotArchived(doc.data())) return false;
            return Boolean(taskIdFromVariantPath(doc.ref.path));
          })
          .map((doc) =>
            buildVariantResult(
              doc,
              taskIdFromVariantPath(doc.ref.path)!,
              registered
            )
          )
      )
    ).filter((variant): variant is SerializedTaskVariant => variant !== null);

    return { variants: await resolveAttributionEmails(variants) };
  }
);
