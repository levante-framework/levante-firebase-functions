import { getFirestore, FieldValue } from "firebase-admin/firestore";
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

export async function _linkUsers(users: User[], siteId: string): Promise<void> {
  const db = getFirestore();
  const userMap = new Map(users.map((user) => [user.id, user]));

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

  for (const user of users) {
    const updates: { [key: string]: string[] } = {};

    if (user.userType.toLowerCase() === "child") {
      updates.parentIds = [];
      updates.teacherIds = [];

      // Link parents
      if (user.parentId) {
        const parentIds = user.parentId.split(",").map((id) => id.trim());

        for (const parentId of parentIds) {
          const parent = userMap.get(parentId);
          if (parent) {
            updates.parentIds.push(parent.uid);
            await updateUserDoc(parent.uid, "childIds", user.uid);
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
            await updateUserDoc(teacher.uid, "childIds", user.uid);
          }
        }
      }
    }

    // Update the child user's document with the linked UIDs
    if (Object.keys(updates).length > 0) {
      await updateUserDoc(user.uid, updates);
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
