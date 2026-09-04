import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import {
  UpsertVariantParamSpecParamsSchema,
  type UpsertVariantParamSpecResult,
} from "@levante-framework/levante-zod";
import {
  assertCanWriteTasks,
  requireAuthUid,
  serializeVariantParamSpec,
  throwSchemaError,
} from "./task-management-utils.js";

export const upsertVariantParamSpec = onCall(
  async (req): Promise<UpsertVariantParamSpecResult> => {
    const uid = requireAuthUid(req.auth?.uid);

    const parsed = UpsertVariantParamSpecParamsSchema.safeParse(req.data ?? {});
    if (!parsed.success) throwSchemaError(parsed.error);

    const { archived, description, name, type, id } = parsed.data;

    const userRecord = await getAuth().getUser(uid);
    assertCanWriteTasks(userRecord.customClaims);

    const db = getFirestore();
    const now = FieldValue.serverTimestamp();

    if (id) {
      const specRef = db.collection("variantParamSpecs").doc(id);
      const existing = await specRef.get();
      if (!existing.exists) {
        throw new HttpsError(
          "not-found",
          `Variant param spec ${id} not found`,
          {
            code: "variant-param-spec",
            variantParamSpecId: id,
          }
        );
      }

      await specRef.update({
        archived,
        description,
        name,
        type,
        updatedAt: now,
        updatedBy: uid,
      });

      const updated = await specRef.get();
      return { variantParamSpec: serializeVariantParamSpec(updated) };
    }

    // Semantic id = param name (matches seeder / catalog keys).
    const specId = name;
    const specRef = db.collection("variantParamSpecs").doc(specId);
    const existing = await specRef.get();
    if (existing.exists) {
      throw new HttpsError(
        "already-exists",
        `Variant param spec ${specId} already exists`,
        {
          code: "variant-param-spec",
          variantParamSpecId: specId,
        }
      );
    }

    await specRef.set({
      archived,
      createdAt: now,
      createdBy: uid,
      description,
      name,
      type,
      updatedAt: now,
      updatedBy: uid,
    });

    const created = await specRef.get();
    return { variantParamSpec: serializeVariantParamSpec(created) };
  }
);
