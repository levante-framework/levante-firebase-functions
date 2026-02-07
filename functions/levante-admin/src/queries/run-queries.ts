import { getFirestore, Filter, Query } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import _get from "lodash-es/get.js";
import _uniq from "lodash-es/uniq.js";
import _without from "lodash-es/without.js";
import _pick from "lodash-es/pick.js";
import { pluralizeFirestoreCollection } from "../utils/utils.js";

const applySelect = (query: Query, select: string[] | undefined) => {
  if (!select || select.length === 0) return query;
  return query.select(...select);
};

export const countRuns = async ({
  administrationId,
  orgType,
  orgId,
  taskId,
  requireCompleted = false,
}: {
  administrationId: string;
  orgType: string;
  orgId: string;
  taskId?: string;
  requireCompleted?: boolean;
}) => {
  const db = getFirestore();
  let query: Query = db.collectionGroup("runs");

  const orgField = `readOrgs.${pluralizeFirestoreCollection(orgType)}`;
  const filters: Filter[] = [
    Filter.where("assignmentId", "==", administrationId),
    Filter.where("bestRun", "==", true),
    Filter.where(orgField, "array-contains", orgId),
  ];

  if (taskId) {
    filters.push(Filter.where("taskId", "==", taskId));
  }
  if (requireCompleted) {
    filters.push(Filter.where("completed", "==", true));
  }

  query = query.where(Filter.and(...filters));
  const countSnapshot = await query.count().get();
  return countSnapshot.data().count;
};

export const getRunsPage = async ({
  administrationId,
  userId,
  orgType,
  orgId,
  taskId,
  pageLimit,
  page,
  select,
  scoreKey = "scores.computed.composite",
  paginate = true,
}: {
  administrationId: string;
  userId?: string;
  orgType: string;
  orgId: string;
  taskId?: string;
  pageLimit?: number;
  page?: number;
  select?: string[];
  scoreKey?: string;
  paginate?: boolean;
}) => {
  const db = getFirestore();
  let query: Query;

  if (userId) {
    query = db.collection("users").doc(userId).collection("runs");
  } else {
    query = db.collectionGroup("runs");
  }

  const orgField = `readOrgs.${pluralizeFirestoreCollection(orgType)}`;
  const filters: Filter[] = [
    Filter.where("assignmentId", "==", administrationId),
    Filter.where("bestRun", "==", true),
  ];

  if (orgId) {
    filters.push(Filter.where(orgField, "array-contains", orgId));
  }

  if (taskId) {
    filters.push(Filter.where("taskId", "==", taskId));
  }

  query = query.where(Filter.and(...filters));
  query = applySelect(query, select);

  if (paginate && Number.isFinite(pageLimit) && Number.isFinite(page)) {
    query = query.limit(pageLimit!).offset(page! * pageLimit!);
  }

  const snapshot = await query.get();
  const runDocs = snapshot.docs.map((doc) => ({
    id: doc.id,
    parentDoc: doc.ref.parent.parent?.id,
    ...(doc.data() as Record<string, unknown>),
  })) as Array<Record<string, any>>;

  const userDocIds = _uniq(
    _without(runDocs.map((doc) => doc.parentDoc), undefined)
  ) as string[];

  const userDocs = await db.getAll(
    ...userDocIds.map((id) => db.collection("users").doc(id)),
    { fieldMask: ["grade", "birthMonth", "birthYear", "schools.current"] }
  );
  const userDocDict = userDocs.reduce((acc, doc) => {
    if (doc.exists) {
      acc[doc.id] = { id: doc.id, ...doc.data() };
    }
    return acc;
  }, {} as Record<string, any>);

  const otherKeys = _without(select ?? [], scoreKey);

  return runDocs.map((run) => {
    const user = run.parentDoc ? userDocDict[run.parentDoc] : undefined;
    return {
      scores: _get(run, scoreKey),
      taskId: run.taskId,
      user,
      ..._pick(run, otherKeys),
    };
  });
};

export const validateRunQueryInput = ({
  administrationId,
}: {
  administrationId?: string;
}) => {
  if (!administrationId) {
    throw new HttpsError(
      "invalid-argument",
      "administrationId is required"
    );
  }
};
