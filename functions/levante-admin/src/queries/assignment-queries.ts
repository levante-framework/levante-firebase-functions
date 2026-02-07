import { getFirestore, Filter, Query } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import _find from "lodash-es/find.js";
import _get from "lodash-es/get.js";
import _isEmpty from "lodash-es/isEmpty.js";
import _uniq from "lodash-es/uniq.js";
import _without from "lodash-es/without.js";
import _replace from "lodash-es/replace.js";
import _mapValues from "lodash-es/mapValues.js";
import _pick from "lodash-es/pick.js";
import _groupBy from "lodash-es/groupBy.js";
import _flatten from "lodash-es/flatten.js";
import { pluralizeFirestoreCollection } from "../utils/utils.js";

const buildScoreFilter = (filter: any) => {
  if (!filter?.field || !filter?.value) return undefined;

  const elementaryLevels = Filter.or(
    Filter.where("userData.schoolLevel", "==", "elementary"),
    Filter.where("userData.schoolLevel", "==", "early-childhood")
  );

  const upperLevels = Filter.or(
    Filter.where("userData.schoolLevel", "==", "middle"),
    Filter.where("userData.schoolLevel", "==", "high"),
    Filter.where("userData.schoolLevel", "==", "postsecondary")
  );

  if (filter.value === "Green") {
    return Filter.or(
      Filter.and(
        elementaryLevels,
        Filter.where(filter.field, ">=", 50)
      ),
      Filter.and(
        upperLevels,
        Filter.where(filter.field, ">=", filter.cutoffs?.above ?? 0)
      )
    );
  }

  if (filter.value === "Yellow") {
    return Filter.or(
      Filter.and(
        elementaryLevels,
        Filter.where(filter.field, "<", 50),
        Filter.where(filter.field, ">", 25)
      ),
      Filter.and(
        upperLevels,
        Filter.where(filter.field, "<", filter.cutoffs?.above ?? 0),
        Filter.where(filter.field, ">", filter.cutoffs?.some ?? 0)
      )
    );
  }

  if (filter.value === "Pink") {
    return Filter.or(
      Filter.and(
        elementaryLevels,
        Filter.where(filter.field, "<=", 25)
      ),
      Filter.and(
        upperLevels,
        Filter.where(filter.field, "<=", filter.cutoffs?.some ?? 0)
      )
    );
  }

  return undefined;
};

const buildAssignmentsQuery = ({
  adminId,
  orgType,
  orgId,
  orgArray,
  filter,
  grades,
}: {
  adminId: string;
  orgType: string;
  orgId: string | null;
  orgArray?: string[] | null;
  filter?: any;
  grades?: string[] | null;
}) => {
  const orgField = `readOrgs.${pluralizeFirestoreCollection(orgType)}`;
  const filters: Filter[] = [
    Filter.where("id", "==", adminId),
  ];

  if (orgArray && orgArray.length > 0) {
    filters.push(Filter.where(orgField, "array-contains-any", orgArray));
  } else if (orgId) {
    filters.push(Filter.where(orgField, "array-contains", orgId));
  }

  if (grades && grades.length > 0) {
    filters.push(Filter.where("userData.grade", "in", grades));
  }

  if (filter) {
    if (["Completed", "Started", "Assigned"].includes(filter?.value)) {
      filters.push(
        Filter.where(
          `progress.${filter.taskId.replace(/-/g, "_")}`,
          "==",
          filter.value.toLowerCase()
        )
      );
    } else {
      filters.push(Filter.where(`userData.${filter.field}`, "==", filter.value));
    }
  }

  return Filter.and(...filters);
};

const buildScoresQuery = ({
  adminId,
  orgType,
  orgId,
  orgArray,
  filter,
  grades,
}: {
  adminId: string;
  orgType: string;
  orgId: string | null;
  orgArray?: string[] | null;
  filter?: any;
  grades?: string[] | null;
}) => {
  const orgField = `readOrgs.${pluralizeFirestoreCollection(orgType)}`;
  const filters: Filter[] = [
    Filter.where("assignmentId", "==", adminId),
    Filter.where("taskId", "==", filter?.taskId),
    Filter.where("bestRun", "==", true),
  ];

  if (orgArray && orgArray.length > 0) {
    filters.push(Filter.where(orgField, "array-contains-any", orgArray));
  } else if (orgId) {
    filters.push(Filter.where(orgField, "array-contains", orgId));
  }

  const scoreFilter = buildScoreFilter(filter);
  if (scoreFilter) {
    filters.push(scoreFilter);
  }

  if (grades && grades.length > 0) {
    filters.push(Filter.where("userData.grade", "in", grades));
  }

  return Filter.and(...filters);
};

const getUserDocs = async (userDocIds: string[]) => {
  const db = getFirestore();
  const docs = await db.getAll(
    ...userDocIds.map((id) => db.collection("users").doc(id)),
    { fieldMask: ["name", "assessmentPid", "username", "studentData", "schools", "classes", "userType"] }
  );
  return _without(
    docs.map((doc) =>
      doc.exists
        ? {
            name: doc.ref.path,
            userId: doc.id,
            data: doc.data(),
          }
        : undefined
    ),
    undefined
  );
};

const getAssignmentDocs = async (assignmentPaths: string[]) => {
  const db = getFirestore();
  const docs = await db.getAll(...assignmentPaths.map((path) => db.doc(path)));
  return _without(
    docs.map((doc) =>
      doc.exists
        ? {
            name: doc.ref.path,
            userId: doc.ref.parent.parent?.id,
            data: doc.data(),
          }
        : undefined
    ),
    undefined
  );
};

export const countAssignments = async ({
  adminId,
  orgType,
  orgId,
  orgArray,
  filter,
  grades,
  useScoresFilter,
}: {
  adminId: string;
  orgType: string;
  orgId: string | null;
  orgArray?: string[] | null;
  filter?: any;
  grades?: string[] | null;
  useScoresFilter?: boolean;
}) => {
  const db = getFirestore();
  let query: Query = db.collectionGroup(useScoresFilter ? "runs" : "assignments");

  const filterClause = useScoresFilter
    ? buildScoresQuery({ adminId, orgType, orgId, orgArray, filter, grades })
    : buildAssignmentsQuery({ adminId, orgType, orgId, orgArray, filter, grades });

  query = query.where(filterClause);
  const countSnapshot = await query.count().get();
  return countSnapshot.data().count;
};

export const getAssignmentsPage = async ({
  adminId,
  orgType,
  orgId,
  pageLimit,
  page,
  includeScores,
  includeSurveyResponses,
  select,
  paginate,
  filters,
  orderBy,
}: {
  adminId: string;
  orgType: string;
  orgId: string | null;
  pageLimit: number;
  page: number;
  includeScores?: boolean;
  includeSurveyResponses?: boolean;
  select?: string[];
  paginate?: boolean;
  filters?: any[];
  orderBy?: any[];
}) => {
  const db = getFirestore();
  const adminProjectId = "admin";
  const order = orderBy ?? [];

  let nonOrgFilter: any = null;
  let orgFilters: any = null;
  let gradeFilters: any = null;
  (filters ?? []).forEach((filter) => {
    if (filter.collection === "schools") {
      orgFilters = filter;
    } else if (filter.collection === "grade") {
      gradeFilters = filter;
    } else if (filter.collection !== "schools") {
      if (nonOrgFilter) {
        throw new Error("You may specify at most one filter");
      }
      nonOrgFilter = filter;
    }
  });

  if (nonOrgFilter && nonOrgFilter.collection === "scores") {
    const orgArray = orgFilters?.value?.length ? orgFilters.value : null;
    const grades = gradeFilters?.value ?? null;
    let runQuery: Query = db.collectionGroup("runs");
    const runFilter = buildScoresQuery({
      adminId,
      orgType: orgArray ? "school" : orgType,
      orgId: orgArray ? null : orgId,
      orgArray,
      filter: nonOrgFilter,
      grades,
    });
    runQuery = runQuery.where(runFilter);
    if (paginate) {
      runQuery = runQuery.limit(pageLimit).offset(page * pageLimit);
    }
    const runSnapshot = await runQuery.get();
    const scoreRuns = runSnapshot.docs.map((doc) => ({
      id: doc.id,
      name: doc.ref.path,
      data: doc.data(),
    }));

    const userDocPaths = _uniq(
      _without(
        scoreRuns.map((runDoc) => {
          if (runDoc.name) {
            return _replace(runDoc.name.split("/runs/")[0], adminProjectId, adminProjectId);
          }
          return undefined;
        }),
        undefined
      )
    );
    const userDocs = await getUserDocs(
      userDocPaths.map((path) => path.split("/users/")[1])
    );

    const assignmentDocPaths = userDocPaths.map(
      (userDocPath) => `${userDocPath}/assignments/${adminId}`
    );
    const assignmentDocs = await getAssignmentDocs(assignmentDocPaths);

    const scoresObj = assignmentDocs.map((assignment) => {
      const user = _find(userDocs, { userId: assignment.userId });
      const scores = scoreRuns.filter((run) =>
        _get(run, "data.userId", "").includes(assignment.userId)
      );
      return {
        user,
        assignment,
        scores,
      };
    });
    return scoresObj;
  }

  const orgArray = orgFilters?.value?.length ? orgFilters.value : null;
  const grades = gradeFilters?.value ?? null;
  let query: Query = db.collectionGroup("assignments");
  const assignmentFilter = buildAssignmentsQuery({
    adminId,
    orgType: orgArray ? "school" : orgType,
    orgId: orgArray ? null : orgId,
    orgArray,
    filter: nonOrgFilter,
    grades,
  });
  query = query.where(assignmentFilter);
  if (!_isEmpty(order)) {
    const orderField = order[0]?.field?.fieldPath;
    const direction =
      order[0]?.direction === "DESCENDING" ? "desc" : "asc";
    if (orderField) query = query.orderBy(orderField, direction);
  }
  if (paginate) {
    query = query.limit(pageLimit).offset(page * pageLimit);
  }
  if (select && select.length > 0) {
    query = query.select(...select);
  }
  const snapshot = await query.get();
  const assignmentDocs = snapshot.docs.map((doc) => ({
    name: doc.ref.path,
    userId: doc.ref.parent.parent?.id,
    data: doc.data(),
  }));

  const userDocIds = _uniq(
    _without(assignmentDocs.map((doc) => doc.userId), undefined)
  ) as string[];
  const userDocs = await getUserDocs(userDocIds);

  const userDocDict = userDocs.reduce((acc, user) => {
    acc[user.userId] = user;
    return acc;
  }, {} as Record<string, any>);

  const scoresObj = assignmentDocs.map((assignment) => {
    const user = userDocDict[assignment.userId];
    return {
      assignment,
      user,
    };
  }) as Array<{
    assignment: any;
    user: any;
    surveyResponses?: unknown[];
  }>;

  if (includeScores) {
    const runRefs = _flatten(
      assignmentDocs.map((assignment) =>
        (assignment.data?.assessments ?? [])
          .map((task: any) =>
            assignment.userId && task.runId
              ? db.doc(`users/${assignment.userId}/runs/${task.runId}`)
              : undefined
          )
          .filter(Boolean)
      )
    );

    if (runRefs.length > 0) {
      const runDocs = await db.getAll(...runRefs);
      scoresObj.forEach((score) => {
        const assessments = score.assignment?.data?.assessments ?? [];
        assessments.forEach((task: any) => {
          const runDoc = runDocs.find(
            (doc) => doc.exists && doc.id === task.runId
          );
          if (runDoc?.exists) {
            const runData = runDoc.data();
            task.scores = runData?.scores;
            task.reliable = runData?.reliable;
            task.engagementFlags = runData?.engagementFlags;
          }
        });
      });
    }
  }

  if (includeSurveyResponses) {
    const responses = _flatten(
      assignmentDocs.map((assignment) =>
        (assignment.data?.assessments ?? []).map((task: any) => task?.surveyResponses)
      )
    ).filter(Boolean);
    scoresObj.forEach((score) => {
      score.surveyResponses = responses;
    });
  }

  return scoresObj;
};

export const getUserAssignments = async ({ roarUid }: { roarUid: string }) => {
  const db = getFirestore();
  const snapshot = await db
    .collection("users")
    .doc(roarUid)
    .collection("assignments")
    .get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
};

export const getAssignmentsByNameAndSite = async ({
  name,
  normalizedName,
  siteId,
  adminId,
}: {
  name: string;
  normalizedName: string;
  siteId: string;
  adminId?: string;
}) => {
  const db = getFirestore();
  let query: Query = db.collection("administrations");
  const filters: Filter[] = [
    Filter.where("siteId", "==", siteId),
    Filter.or(
      Filter.where("name", "==", name),
      Filter.where("normalizedName", "==", normalizedName)
    ),
  ];
  if (adminId) {
    filters.push(Filter.where("__name__", "!=", db.doc(`administrations/${adminId}`)));
  }
  query = query.where(Filter.and(...filters));
  const snapshot = await query.get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
};

export const validateAssignmentQueryInput = ({
  adminId,
}: {
  adminId?: string;
}) => {
  if (!adminId) {
    throw new HttpsError("invalid-argument", "adminId is required.");
  }
};
