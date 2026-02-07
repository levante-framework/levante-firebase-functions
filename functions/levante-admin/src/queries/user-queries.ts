import { getFirestore, Filter, Query } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import { RESOURCES } from "@levante-framework/permissions-core";
import { assertCanReadSite, getSiteIdForOrg } from "./query-permissions.js";

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

export const getUsersByOrg = async ({
  uid,
  orgType,
  orgId,
  pageLimit,
  page,
  orderBy,
  restrictToActiveUsers,
  select,
}: {
  uid: string;
  orgType: string;
  orgId: string;
  pageLimit: number;
  page: number;
  orderBy?: any[];
  restrictToActiveUsers?: boolean;
  select?: string[];
}) => {
  const db = getFirestore();
  const siteId = await getSiteIdForOrg(orgType, orgId);
  await assertCanReadSite({ uid, siteId, resource: RESOURCES.USERS });

  let query: Query = db.collection("users");
  const filters: Filter[] = [
    Filter.where(`${orgType}.current`, "array-contains", orgId),
  ];

  if (restrictToActiveUsers) {
    filters.push(Filter.where("archived", "==", false));
  }

  query = query.where(Filter.and(...filters));
  query = applyOrderBy(query, orderBy);
  query = applySelect(query, select);

  if (Number.isFinite(pageLimit) && Number.isFinite(page)) {
    query = query.limit(pageLimit).offset(page * pageLimit);
  }

  const snapshot = await query.get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
};

export const countUsersByOrg = async ({
  uid,
  orgType,
  orgId,
  restrictToActiveUsers,
}: {
  uid: string;
  orgType: string;
  orgId: string;
  restrictToActiveUsers?: boolean;
}) => {
  const db = getFirestore();
  const siteId = await getSiteIdForOrg(orgType, orgId);
  await assertCanReadSite({ uid, siteId, resource: RESOURCES.USERS });

  let query: Query = db.collection("users");
  const filters: Filter[] = [
    Filter.where(`${orgType}.current`, "array-contains", orgId),
  ];

  if (restrictToActiveUsers) {
    filters.push(Filter.where("archived", "==", false));
  }

  query = query.where(Filter.and(...filters));
  const countSnapshot = await query.count().get();
  return countSnapshot.data().count;
};

export const validateUserQueryInput = ({
  orgType,
  orgId,
}: {
  orgType: string;
  orgId: string;
}) => {
  if (!orgType || !orgId) {
    throw new HttpsError(
      "invalid-argument",
      "orgType and orgId are required."
    );
  }
};

export const logUserQuery = ({
  uid,
  orgType,
  orgId,
  action,
}: {
  uid: string;
  orgType: string;
  orgId: string;
  action: string;
}) => {
  logger.debug(`User query ${action}`, { uid, orgType, orgId });
};
