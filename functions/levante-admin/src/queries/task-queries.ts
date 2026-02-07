import { getFirestore, Query } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import _uniq from "lodash-es/uniq.js";
import _without from "lodash-es/without.js";

const applyOrderBy = (query: Query, orderBy: any[] | undefined) => {
  if (!orderBy || orderBy.length === 0) return query;
  let updated = query;
  orderBy.forEach((order) => {
    const fieldPath = order?.field?.fieldPath;
    const direction =
      (order?.direction ?? "ASCENDING") === "DESCENDING" ? "desc" : "asc";
    if (fieldPath) {
      updated = updated.orderBy(fieldPath, direction);
    }
  });
  return updated;
};

const applySelect = (query: Query, select: string[] | undefined) => {
  if (!select || select.length === 0) return query;
  return query.select(...select);
};

export const getTasks = async ({
  registered = true,
  allData = false,
  orderBy,
  select,
}: {
  registered?: boolean;
  allData?: boolean;
  orderBy?: any[];
  select?: string[];
}) => {
  const db = getFirestore();
  let query: Query = db.collection("tasks");
  if (registered) {
    query = query.where("registered", "==", true);
  }
  query = applyOrderBy(query, orderBy);
  if (!allData) {
    query = applySelect(query, select);
  }
  const snapshot = await query.get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
};

export const getTasksById = async ({ taskIds }: { taskIds: string[] }) => {
  const db = getFirestore();
  if (!Array.isArray(taskIds) || taskIds.length === 0) return [];
  const refs = taskIds.map((id) => db.collection("tasks").doc(id));
  const docs = await db.getAll(...refs);
  return docs.filter((doc) => doc.exists).map((doc) => ({ id: doc.id, ...doc.data() }));
};

export const getVariants = async ({
  registered = false,
}: {
  registered?: boolean;
}) => {
  const db = getFirestore();
  let query: Query = db.collectionGroup("variants");
  if (registered) {
    query = query.where("registered", "==", true);
  }
  const snapshot = await query.get();
  const variants = snapshot.docs.map((doc) => ({
    id: doc.id,
    data: doc.data(),
    parentTaskId: doc.ref.parent.parent?.id,
  }));

  const taskIds = _uniq(
    _without(
      variants.map((variant) => variant.parentTaskId),
      undefined
    )
  ) as string[];

  if (taskIds.length === 0) return [];

  const taskDocs = await db.getAll(
    ...taskIds.map((id) => db.collection("tasks").doc(id))
  );
  const taskMap = new Map(
    taskDocs
      .filter((doc) => doc.exists)
      .map((doc) => [doc.id, { id: doc.id, ...doc.data() }])
  );

  return variants.map((variant) => {
    const task = variant.parentTaskId
      ? taskMap.get(variant.parentTaskId)
      : undefined;
    return {
      id: variant.id,
      variant: {
        id: variant.id,
        ...variant.data,
      },
      task,
    };
  });
};

export const validateTaskQueryInput = ({
  taskIds,
}: {
  taskIds?: string[];
}) => {
  if (taskIds && !Array.isArray(taskIds)) {
    throw new HttpsError("invalid-argument", "taskIds must be an array");
  }
};
