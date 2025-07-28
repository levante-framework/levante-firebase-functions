import { getFirestore, FieldValue } from "firebase-admin/firestore";

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

export async function _linkUsers(
  requestingUid: string,
  users: User[]
): Promise<void> {
  const adminDb = getFirestore();

  const claimsDocRef = adminDb.collection("userClaims").doc(requestingUid);
  const currentClaims = await claimsDocRef.get().then((docSnapshot) => {
    if (docSnapshot.exists) {
      return docSnapshot.data()!.claims;
    }
    return null;
  });

  if (!currentClaims.super_admin && !currentClaims.admin) {
    throw new Error("User does not have permission to link users");
  }

  const userMap = new Map(users.map((user) => [user.id, user]));

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
  const adminDb = getFirestore();
  const userRef = adminDb.collection("users").doc(uid);

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
