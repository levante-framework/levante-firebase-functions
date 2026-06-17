import { getFirestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import type { TaskDoc, VariantDoc } from "../../firestore-schema.js";

export interface VariantSummary extends VariantDoc {
  id: string;
  taskId: string;
  taskName: string;
}

export interface GetVariantsOptions {
  taskId?: string;
  registeredVariantsOnly?: boolean;
}

function mapVariantDoc(
  doc: QueryDocumentSnapshot,
  taskId: string,
  taskName: string
): VariantSummary {
  return {
    id: doc.id,
    taskId,
    taskName,
    ...(doc.data() as VariantDoc),
  };
}

function isRegistered(registered: boolean | undefined): boolean {
  return registered !== false;
}

function filterRegisteredVariants(
  variants: VariantSummary[],
  registeredVariantsOnly: boolean
): VariantSummary[] {
  if (!registeredVariantsOnly) {
    return variants;
  }
  return variants.filter((variant) => isRegistered(variant.registered));
}

async function getVariantsForTask(
  taskId: string,
  registeredVariantsOnly: boolean
): Promise<VariantSummary[]> {
  const db = getFirestore();
  const taskRef = db.collection("tasks").doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) {
    throw new HttpsError("not-found", `Task ${taskId} not found.`);
  }

  const taskName = (taskSnap.data() as TaskDoc).name ?? "";
  const variantsSnap = await taskRef.collection("variants").get();
  const variants = variantsSnap.docs.map((doc) =>
    mapVariantDoc(doc, taskId, taskName)
  );
  return filterRegisteredVariants(variants, registeredVariantsOnly);
}

async function getAllVariants(
  registeredVariantsOnly: boolean
): Promise<VariantSummary[]> {
  const db = getFirestore();
  const [tasksSnap, variantsSnap] = await Promise.all([
    db.collection("tasks").get(),
    db.collectionGroup("variants").get(),
  ]);

  const taskNames = new Map<string, string>();
  const includedTaskIds = new Set<string>();

  for (const doc of tasksSnap.docs) {
    const taskData = doc.data() as TaskDoc;
    taskNames.set(doc.id, taskData.name ?? "");
    if (!registeredVariantsOnly || isRegistered(taskData.registered)) {
      includedTaskIds.add(doc.id);
    }
  }

  const variants = variantsSnap.docs
    .map((doc) => {
      const taskId = doc.ref.parent.parent!.id;
      return mapVariantDoc(doc, taskId, taskNames.get(taskId) ?? "");
    })
    .filter((variant) => includedTaskIds.has(variant.taskId));

  return filterRegisteredVariants(variants, registeredVariantsOnly);
}

export const getVariantsHandler = async (
  options: GetVariantsOptions = {}
): Promise<VariantSummary[]> => {
  const { taskId, registeredVariantsOnly = true } = options;

  if (typeof registeredVariantsOnly !== "boolean") {
    throw new HttpsError(
      "invalid-argument",
      "registeredVariantsOnly must be a boolean when provided."
    );
  }

  if (taskId !== undefined) {
    if (typeof taskId !== "string" || taskId.trim().length === 0) {
      throw new HttpsError(
        "invalid-argument",
        "taskId must be a non-empty string when provided."
      );
    }
    return getVariantsForTask(taskId.trim(), registeredVariantsOnly);
  }

  return getAllVariants(registeredVariantsOnly);
};
