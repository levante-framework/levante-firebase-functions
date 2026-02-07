import {
  getFirestore,
  Filter,
  Query,
  FieldPath,
} from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { HttpsError } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";
import _intersection from "lodash-es/intersection.js";
import _uniqBy from "lodash-es/uniqBy.js";
import _flattenDeep from "lodash-es/flattenDeep.js";
import _without from "lodash-es/without.js";
import _zip from "lodash-es/zip.js";
import _isEmpty from "lodash-es/isEmpty.js";
import { RESOURCES } from "@levante-framework/permissions-core";
import {
  assertCanReadSite,
  getUserClaims,
} from "./query-permissions.js";

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

const getAdminContext = async (uid: string) => {
  const auth = getAuth();
  const record = await auth.getUser(uid);
  const customClaims = (record.customClaims as Record<string, unknown>) || {};
  const isSuperAdmin =
    customClaims.super_admin === true ||
    (await getUserClaims(uid)).super_admin === true;
  const adminOrgs = (await getUserClaims(uid)).adminOrgs ?? {};
  return { record, customClaims, isSuperAdmin, adminOrgs };
};

export const getOrgByName = async ({
  uid,
  orgType,
  orgNormalizedName,
  parentDistrict,
  parentSchool,
  orderBy,
  select,
}: {
  uid: string;
  orgType: string;
  orgNormalizedName: string;
  parentDistrict?: string | null;
  parentSchool?: string | null;
  orderBy?: any[];
  select?: string[];
}) => {
  const db = getFirestore();
  if (!orgType || !orgNormalizedName) {
    throw new HttpsError(
      "invalid-argument",
      "orgType and orgNormalizedName are required."
    );
  }

  if (orgType === "districts" && parentDistrict) {
    await assertCanReadSite({
      uid,
      siteId: parentDistrict,
      resource: RESOURCES.GROUPS,
    });
  } else if (parentDistrict) {
    await assertCanReadSite({
      uid,
      siteId: parentDistrict,
      resource: RESOURCES.GROUPS,
    });
  }

  let query: Query = db.collection(orgType);
  const filters = [
    Filter.where("normalizedName", "==", orgNormalizedName),
  ];

  if (orgType === "schools" && parentDistrict) {
    filters.push(Filter.where("districtId", "==", parentDistrict));
  }

  if (orgType === "classes") {
    if (parentSchool) {
      filters.push(Filter.where("schoolId", "==", parentSchool));
    }
    if (parentDistrict) {
      filters.push(Filter.where("districtId", "==", parentDistrict));
    }
  }

  if (orgType === "groups" && parentDistrict) {
    filters.push(Filter.where("parentOrgId", "==", parentDistrict));
  }

  query = query.where(Filter.and(...filters));
  query = applyOrderBy(query, orderBy);
  query = applySelect(query, select);

  const snapshot = await query.get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
};

export const getOrgsForAdmin = async ({
  uid,
  orgType,
  selectedDistrict,
  select,
}: {
  uid: string;
  orgType: string;
  selectedDistrict?: string | null;
  select?: string[];
}) => {
  const db = getFirestore();
  const { isSuperAdmin, adminOrgs } = await getAdminContext(uid);
  const districtId = selectedDistrict === "any" ? null : selectedDistrict ?? null;

  if (isSuperAdmin) {
    let query: Query = db.collection(orgType);
    const filters: Filter[] = [];
    if (orgType === "schools" && districtId) {
      filters.push(Filter.where("districtId", "==", districtId));
    }
    if (filters.length > 0) {
      query = query.where(Filter.and(...filters));
    }
    query = applySelect(query, select);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  if (orgType === "groups") {
    const groupIds = adminOrgs[orgType] ?? [];
    const docs = await Promise.all(
      groupIds.map((orgId: string) => db.collection(orgType).doc(orgId).get())
    );
    return _uniqBy(
      docs.filter((doc) => doc.exists).map((doc) => ({ id: doc.id, ...doc.data() })),
      (org) => org.id
    );
  }

  if (orgType === "districts") {
    const promises = (adminOrgs[orgType] ?? []).map((orgId: string) =>
      db.collection(orgType).doc(orgId).get()
    );

    const schoolPromises = (adminOrgs["schools"] ?? []).map((schoolId: string) =>
      db.collection("schools").doc(schoolId).get()
    );
    const classPromises = (adminOrgs["classes"] ?? []).map((classId: string) =>
      db.collection("classes").doc(classId).get()
    );

    const [districtDocs, schools, classes] = await Promise.all([
      Promise.all(promises),
      Promise.all(schoolPromises),
      Promise.all(classPromises),
    ]);

    const districtIds = schools
      .filter((doc) => doc.exists)
      .map((doc) => doc.data()?.districtId)
      .filter(Boolean);
    districtIds.push(
      ...classes
        .filter((doc) => doc.exists)
        .map((doc) => doc.data()?.districtId)
        .filter(Boolean)
    );

    const extraDistrictDocs = await Promise.all(
      districtIds.map((id: string) => db.collection(orgType).doc(id).get())
    );

    return _uniqBy(
      [...districtDocs, ...extraDistrictDocs]
        .filter((doc) => doc.exists)
        .map((doc) => ({ id: doc.id, ...doc.data() })),
      (org) => org.id
    );
  }

  if (orgType === "schools") {
    if (!districtId) return [];
    const districtDoc = await db.collection("districts").doc(districtId).get();
    if (!districtDoc.exists) return [];
    const districtSchools = districtDoc.data()?.schools ?? [];

    if ((adminOrgs["districts"] ?? []).includes(districtId)) {
      const docs = await Promise.all(
        (districtSchools ?? []).map((schoolId: string) =>
          db.collection("schools").doc(schoolId).get()
        )
      );
      return docs.filter((doc) => doc.exists).map((doc) => ({ id: doc.id, ...doc.data() }));
    }

    if ((adminOrgs["schools"] ?? []).length > 0) {
      const schoolIds = _intersection(adminOrgs["schools"], districtSchools);
      const docs = await Promise.all(
        (schoolIds ?? []).map((schoolId: string) =>
          db.collection("schools").doc(schoolId).get()
        )
      );
      return docs.filter((doc) => doc.exists).map((doc) => ({ id: doc.id, ...doc.data() }));
    }

    if ((adminOrgs["classes"] ?? []).length > 0) {
      const classDocs = await Promise.all(
        (adminOrgs["classes"] ?? []).map((classId: string) =>
          db.collection("classes").doc(classId).get()
        )
      );
      const schoolIds = _intersection(
        districtSchools,
        classDocs
          .filter((doc) => doc.exists)
          .map((doc) => doc.data()?.schoolId)
      );
      const docs = await Promise.all(
        (schoolIds ?? []).map((schoolId: string) =>
          db.collection("schools").doc(schoolId).get()
        )
      );
      return docs.filter((doc) => doc.exists).map((doc) => ({ id: doc.id, ...doc.data() }));
    }
    return [];
  }

  return [];
};

export const getOrgsAll = async ({
  uid,
  orgType,
  parentDistrict,
  parentSchool,
  orderBy,
  select,
  includeCreators,
  loggedInUserId,
}: {
  uid: string;
  orgType: string;
  parentDistrict?: string | null;
  parentSchool?: string | null;
  orderBy?: any[];
  select?: string[];
  includeCreators?: boolean;
  loggedInUserId?: string | null;
}) => {
  const db = getFirestore();
  if (orgType === "districts" && parentDistrict) {
    await assertCanReadSite({
      uid,
      siteId: parentDistrict,
      resource: RESOURCES.GROUPS,
    });
  }

  let query: Query = db.collection(orgType);
  const filters: Filter[] = [];

  if (orgType === "schools" && parentDistrict) {
    filters.push(Filter.where("districtId", "==", parentDistrict));
  }
  if (orgType === "classes") {
    if (parentSchool) {
      filters.push(Filter.where("schoolId", "==", parentSchool));
    }
    if (parentDistrict) {
      filters.push(Filter.where("districtId", "==", parentDistrict));
    }
  }
  if (orgType === "groups" && parentDistrict) {
    filters.push(Filter.where("parentOrgId", "==", parentDistrict));
  }

  if (filters.length > 0) {
    query = query.where(Filter.and(...filters));
  }

  query = applyOrderBy(query, orderBy);
  query = applySelect(query, select);

  let orgs = (await query.get()).docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  }));

  if (includeCreators) {
    const creatorIds = [
      ...new Set(orgs.map((org) => org.createdBy).filter(Boolean)),
    ];
    if (creatorIds.length > 0) {
      const creatorDocs = await Promise.all(
        creatorIds.map((id) => db.collection("users").doc(id).get())
      );
      const creatorsMap = new Map(
        creatorDocs
          .filter((doc) => doc.exists)
          .map((doc) => [doc.id, doc.data()])
      );

      orgs = orgs.map((org) => {
        let creatorName = "Unknown User";
        if (org.createdBy) {
          const creatorData = creatorsMap.get(org.createdBy);
          if (creatorData?.displayName) {
            creatorName = creatorData.displayName;
          } else if (creatorData?.name?.first && creatorData?.name?.last) {
            creatorName = `${creatorData.name.first} ${creatorData.name.last}`;
          }
          if (loggedInUserId && loggedInUserId === org.createdBy) {
            creatorName += " (You)";
          }
        }
        return { ...org, creatorName };
      });
    }
  }

  return orgs;
};

export const getDistricts = async ({
  uid,
  districts,
}: {
  uid: string;
  districts?: Array<{ siteId: string }> | null;
}) => {
  const db = getFirestore();
  if (!districts) {
    const snapshot = await db.collection("districts").get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  if (Array.isArray(districts) && districts.length > 0) {
    const docs = await Promise.all(
      districts.map((district) =>
        db.collection("districts").doc(district.siteId).get()
      )
    );
    return docs.filter((doc) => doc.exists).map((doc) => ({ id: doc.id, ...doc.data() }));
  }
  return [];
};

export const getSchools = async ({
  uid,
  districts,
}: {
  uid: string;
  districts?: string[] | null;
}) => {
  const db = getFirestore();
  if (!districts) {
    const snapshot = await db.collection("schools").get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }

  if (Array.isArray(districts) && districts.length > 0) {
    let query: Query = db.collection("schools");
    query = query.where("districtId", "in", districts);
    const snapshot = await query.get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  }
  return [];
};

export const getOrgsBySite = async ({ uid, siteId }: { uid: string; siteId: string }) => {
  const db = getFirestore();
  await assertCanReadSite({ uid, siteId, resource: RESOURCES.GROUPS });

  const schoolsSnapshot = await db
    .collection("schools")
    .where("districtId", "==", siteId)
    .select("id")
    .get();

  const classesSnapshot = await db
    .collection("classes")
    .where("districtId", "==", siteId)
    .select("id")
    .get();

  const groupsSnapshot = await db
    .collection("groups")
    .where("parentOrgId", "==", siteId)
    .select("id")
    .get();

  const results = [
    ...schoolsSnapshot.docs.map((doc) => ({ id: doc.id })),
    ...classesSnapshot.docs.map((doc) => ({ id: doc.id })),
    ...groupsSnapshot.docs.map((doc) => ({ id: doc.id })),
  ];

  return results;
};

export const getTreeOrgs = async ({
  uid,
  administrationId,
  assignedOrgs,
}: {
  uid: string;
  administrationId: string;
  assignedOrgs: Record<string, string[]>;
}) => {
  const db = getFirestore();
  const siteId = assignedOrgs?.districts?.[0];
  if (siteId) {
    await assertCanReadSite({ uid, siteId, resource: RESOURCES.GROUPS });
  }

  const orgTypes = ["districts", "schools", "groups", "families"];
  const orgPaths = _flattenDeep(
    orgTypes.map((orgType) =>
      (assignedOrgs[orgType] ?? []).map((orgId) => `${orgType}/${orgId}`)
    )
  );
  const statsPaths = _flattenDeep(
    orgTypes.map((orgType) =>
      (assignedOrgs[orgType] ?? []).map(
        (orgId) => `administrations/${administrationId}/stats/${orgId}`
      )
    )
  );

  const orgDocs = await Promise.all(
    orgPaths.map((path) => db.doc(path).get())
  );
  const statsDocs = await Promise.all(
    statsPaths.map((path) => db.doc(path).get())
  );

  const dsgfOrgs = _without(
    _zip(orgDocs, statsDocs).map(([orgDoc, stats], index) => {
      if (!orgDoc || !orgDoc.exists) return undefined;
      const data = orgDoc.data() ?? {};
      const { classes, schools, archivedSchools, archivedClasses, ...nodeData } =
        data as Record<string, unknown>;
      const node: any = {
        key: String(index),
        data: {
          orgType: orgDoc.ref.parent.id,
          schools,
          classes,
          archivedSchools,
          archivedClasses,
          stats: stats?.data(),
          ...nodeData,
          id: orgDoc.id,
        },
      };
      if (classes || archivedClasses) {
        node.children = [...(classes ?? []), ...(archivedClasses ?? [])].map(
          (classId) => ({
            key: `${node.key}-${classId}`,
            data: {
              orgType: "classes",
              id: classId,
            },
          })
        );
      }
      return node;
    }),
    undefined
  );

  const districtIds = dsgfOrgs
    .filter((node: any) => node.data.orgType === "districts")
    .map((node: any) => node.data.id);

  const dependentSchoolIds = _flattenDeep(
    dsgfOrgs.map((node: any) => [
      ...(node.data.schools ?? []),
      ...(node.data.archivedSchools ?? []),
    ])
  );
  const independentSchoolIds =
    dsgfOrgs.length > 0
      ? _without(assignedOrgs.schools, ...dependentSchoolIds)
      : assignedOrgs.schools;
  const dependentClassIds = _flattenDeep(
    dsgfOrgs.map((node: any) => [
      ...(node.data.classes ?? []),
      ...(node.data.archivedClasses ?? []),
    ])
  );
  const independentClassIds =
    dsgfOrgs.length > 0
      ? _without(assignedOrgs.classes, ...dependentClassIds)
      : assignedOrgs.classes;

  const independentSchools = (dsgfOrgs ?? []).filter(
    (node: any) =>
      node.data.orgType === "schools" &&
      independentSchoolIds.includes(node.data.id)
  );

  const dependentSchools = (dsgfOrgs ?? []).filter(
    (node: any) =>
      node.data.orgType === "schools" &&
      !independentSchoolIds.includes(node.data.id)
  );

  const independentClassDocs = await Promise.all(
    independentClassIds.map((classId: string) => db.collection("classes").doc(classId).get())
  );
  const independentClassStats = await Promise.all(
    independentClassIds.map((classId: string) =>
      db.doc(`administrations/${administrationId}/stats/${classId}`).get()
    )
  );

  let independentClasses = _without(
    _zip(independentClassDocs, independentClassStats).map(([orgDoc, stats], index) => {
      if (!orgDoc || !orgDoc.exists) return undefined;
      return {
        key: String(dsgfOrgs.length + index),
        data: {
          orgType: "classes",
          ...(stats?.data() && { stats: stats.data() }),
          ...orgDoc.data(),
          id: orgDoc.id,
        },
      };
    }),
    undefined
  );

  const directReportClasses = independentClasses.filter((node: any) =>
    districtIds.includes(node.data.districtId)
  );
  independentClasses = independentClasses.filter(
    (node: any) => !districtIds.includes(node.data.districtId)
  );

  const treeTableOrgs = dsgfOrgs.filter(
    (node: any) => node.data.orgType === "districts"
  );
  treeTableOrgs.push(...independentSchools);

  for (const school of dependentSchools) {
    const districtId = school.data.districtId;
    const districtIndex = treeTableOrgs.findIndex(
      (node: any) => node.data.id === districtId
    );
    if (districtIndex !== -1) {
      treeTableOrgs[districtIndex].children =
        treeTableOrgs[districtIndex].children ?? [];
      treeTableOrgs[districtIndex].children.push({
        ...school,
        key: `${treeTableOrgs[districtIndex].key}-${school.key}`,
      });
    } else {
      treeTableOrgs.push(school);
    }
  }

  for (const _class of directReportClasses) {
    const districtId = _class.data.districtId;
    const districtIndex = treeTableOrgs.findIndex(
      (node: any) => node.data.id === districtId
    );
    if (districtIndex !== -1) {
      const directReportSchoolKey = `${treeTableOrgs[districtIndex].key}-9999`;
      const directReportSchool = {
        key: directReportSchoolKey,
        data: {
          orgType: "schools",
          orgId: "9999",
          name: "Direct Report Classes",
        },
        children: [
          {
            ..._class,
            key: `${directReportSchoolKey}-${_class.key}`,
          },
        ],
      };
      treeTableOrgs[districtIndex].children =
        treeTableOrgs[districtIndex].children ?? [];
      const schoolIndex = treeTableOrgs[districtIndex].children.findIndex(
        (node: any) => node.key === directReportSchoolKey
      );
      if (schoolIndex === -1) {
        treeTableOrgs[districtIndex].children.push(directReportSchool);
      } else {
        treeTableOrgs[districtIndex].children[schoolIndex].children.push(_class);
      }
    } else {
      treeTableOrgs.push(_class);
    }
  }

  treeTableOrgs.push(...(independentClasses ?? []));
  treeTableOrgs.push(
    ...dsgfOrgs.filter((node: any) => node.data.orgType === "groups")
  );
  treeTableOrgs.push(
    ...dsgfOrgs.filter((node: any) => node.data.orgType === "families")
  );

  (treeTableOrgs ?? []).forEach((node: any) => {
    if (node.children) {
      node.children.sort((a: any, b: any) => {
        if (!a.data.stats) return 1;
        if (!b.data.stats) return -1;
        return (a.data.name ?? "").localeCompare(b.data.name ?? "");
      });
    }
  });

  return treeTableOrgs;
};

export const validateOrgQueryInput = ({
  orgType,
}: {
  orgType: string;
}) => {
  if (!orgType) {
    throw new HttpsError("invalid-argument", "orgType is required.");
  }
};

export const logOrgQuery = ({
  uid,
  orgType,
  action,
}: {
  uid: string;
  orgType: string;
  action: string;
}) => {
  logger.debug(`Org query ${action}`, { uid, orgType });
};
