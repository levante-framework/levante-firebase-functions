import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { HttpsError } from "firebase-functions/v2/https";

interface User {
  id: string;
  userType: "child" | "parent" | "teacher";
  parentId?: string;
  teacherId?: string;
  month?: number;
  year?: number;
  group?: string[];
  district?: string;
  school?: string;
  class?: string;
  uid: string;
}

interface LinkMap {
  all: string[];
  current: string[];
  dates: Record<string, { from: Timestamp; to: Timestamp | null }>;
}

const buildLinkMap = ({
  existingLinks,
  desiredCurrentIds,
  timestamp,
  replaceCurrent,
}: {
  existingLinks?: LinkMap;
  desiredCurrentIds: string[];
  timestamp: Timestamp;
  replaceCurrent: boolean;
}): LinkMap => {
  const existingAll = existingLinks?.all ?? [];
  const existingCurrent = existingLinks?.current ?? [];
  const existingDates = existingLinks?.dates ?? {};

  const current = replaceCurrent
    ? Array.from(new Set(desiredCurrentIds))
    : Array.from(new Set([...existingCurrent, ...desiredCurrentIds]));

  const updatedDates: LinkMap["dates"] = { ...existingDates };

  existingCurrent.forEach((id) => {
    if (!current.includes(id)) {
      updatedDates[id] = {
        from: updatedDates[id]?.from ?? timestamp,
        to: timestamp,
      };
    }
  });

  current.forEach((id) => {
    if (!updatedDates[id]) {
      updatedDates[id] = { from: timestamp, to: null };
    } else {
      updatedDates[id] = {
        from: updatedDates[id].from ?? timestamp,
        to: null,
      };
    }
  });

  return {
    all: Array.from(new Set([...existingAll, ...current])),
    current,
    dates: updatedDates,
  };
};

const updateUserLinks = async ({
  uid,
  linkField,
  desiredCurrentIds,
  timestamp,
  replaceCurrent,
}: {
  uid: string;
  linkField: "teacherLinks" | "parentLinks" | "childLinks";
  desiredCurrentIds: string[];
  timestamp: Timestamp;
  replaceCurrent: boolean;
}) => {
  const db = getFirestore();
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();
  const existingLinks = userDoc.exists ? (userDoc.data()?.[linkField] as LinkMap) : undefined;

  const updatedLinks = buildLinkMap({
    existingLinks,
    desiredCurrentIds,
    timestamp,
    replaceCurrent,
  });

  const legacyField =
    linkField === "teacherLinks"
      ? "teacherIds"
      : linkField === "parentLinks"
        ? "parentIds"
        : "childIds";

  await userRef.update({
    [linkField]: updatedLinks,
    [legacyField]: updatedLinks.current,
  });

  return { existingLinks, updatedLinks };
};

const removeChildLink = async ({
  uid,
  childUid,
  timestamp,
}: {
  uid: string;
  childUid: string;
  timestamp: Timestamp;
}) => {
  const db = getFirestore();
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();
  const existingLinks = userDoc.exists ? (userDoc.data()?.childLinks as LinkMap) : undefined;
  const desiredCurrentIds = (existingLinks?.current ?? []).filter(
    (currentId) => currentId !== childUid
  );

  const updatedLinks = buildLinkMap({
    existingLinks,
    desiredCurrentIds,
    timestamp,
    replaceCurrent: true,
  });

  await userRef.update({
    childLinks: updatedLinks,
    childIds: updatedLinks.current,
  });
};

export async function _linkUsers(
  users: User[],
  siteId: string,
  isSuperAdmin: boolean,
  replaceLinks = false
): Promise<void> {
  const db = getFirestore();
  const userMap = new Map(users.map((user) => [user.id, user]));
  const timestamp = Timestamp.now();

  if (!isSuperAdmin) {
    // Validate all users belong to the admin's site
    const userUids = users.map((user) => user.uid);
    const userDocRefs = userUids.map((uid) => db.collection("users").doc(uid));
    const userDocs = await db.getAll(...userDocRefs);

    const usersNotInSite: string[] = [];
    for (const doc of userDocs) {
      if (!doc.exists) {
        throw new HttpsError("not-found", `User not found for uid: ${doc.id}`);
      }
      const userData = doc.data();
      const userDistricts: string[] = userData?.districts?.current || [];
      if (!userDistricts.includes(siteId)) {
        usersNotInSite.push(doc.id);
      }
    }

    if (usersNotInSite.length > 0) {
      logger.warn("Users not belonging to admin's site", {
        usersNotInSite,
        siteId,
      });
      throw new HttpsError(
        "permission-denied",
        `The following users do not belong to the admin's site: ${usersNotInSite.join(
          ", "
        )}`
      );
    }
  }

  for (const user of users) {
    const updates: { [key: string]: string[] } = {};

    const normalizedUserType = user.userType.toLowerCase();
    if (normalizedUserType === "child" || normalizedUserType === "student") {
      updates.parentIds = [];
      updates.teacherIds = [];

      // Link parents
      if (user.parentId) {
        const parentIds = user.parentId.split(",").map((id) => id.trim());

        for (const parentId of parentIds) {
          const parent = userMap.get(parentId);
          if (parent) {
            updates.parentIds.push(parent.uid);
          }
        }
      }

      // Link teachers
      if (user.teacherId) {
        const teacherIds = user.teacherId.split(",").map((id) => id.trim());

        for (const teacherId of teacherIds) {
          const teacher = userMap.get(teacherId);
          if (teacher) {
            updates.teacherIds.push(teacher.uid);
          }
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      continue;
    }

    const desiredParentUids = updates.parentIds ?? [];
    const desiredTeacherUids = updates.teacherIds ?? [];

    const { existingLinks: existingParentLinks } = await updateUserLinks({
      uid: user.uid,
      linkField: "parentLinks",
      desiredCurrentIds: desiredParentUids,
      timestamp,
      replaceCurrent: replaceLinks,
    });

    const { existingLinks: existingTeacherLinks } = await updateUserLinks({
      uid: user.uid,
      linkField: "teacherLinks",
      desiredCurrentIds: desiredTeacherUids,
      timestamp,
      replaceCurrent: replaceLinks,
    });

    const previousParentUids = existingParentLinks?.current ?? [];
    const previousTeacherUids = existingTeacherLinks?.current ?? [];

    const parentAdds = desiredParentUids.filter((id) => !previousParentUids.includes(id));
    const parentRemoves = replaceLinks
      ? previousParentUids.filter((id) => !desiredParentUids.includes(id))
      : [];

    const teacherAdds = desiredTeacherUids.filter((id) => !previousTeacherUids.includes(id));
    const teacherRemoves = replaceLinks
      ? previousTeacherUids.filter((id) => !desiredTeacherUids.includes(id))
      : [];

    for (const parentUid of parentAdds) {
      await updateUserLinks({
        uid: parentUid,
        linkField: "childLinks",
        desiredCurrentIds: [user.uid],
        timestamp,
        replaceCurrent: false,
      });
    }

    for (const parentUid of parentRemoves) {
      await removeChildLink({ uid: parentUid, childUid: user.uid, timestamp });
    }

    for (const teacherUid of teacherAdds) {
      await updateUserLinks({
        uid: teacherUid,
        linkField: "childLinks",
        desiredCurrentIds: [user.uid],
        timestamp,
        replaceCurrent: false,
      });
    }

    for (const teacherUid of teacherRemoves) {
      await removeChildLink({ uid: teacherUid, childUid: user.uid, timestamp });
    }
  }
}

async function updateUserDoc(
  uid: string,
  field: string | { [key: string]: string[] },
  value?: string
): Promise<void> {
  const db = getFirestore();
  const userRef = db.collection("users").doc(uid);

  if (typeof field === "string" && value) {
    await userRef.update({
      [field]: FieldValue.arrayUnion(value),
    });
  } else if (typeof field === "object") {
    const updates: { [key: string]: any } = {};
    for (const [key, values] of Object.entries(field)) {
      if (values && values.length > 0) {
        updates[key] = FieldValue.arrayUnion(...values);
      }
    }
    await userRef.update(updates);
  }
}
