import {
  type ListUsersResult,
  ListUsersParamsSchema,
} from "@levante-framework/levante-zod";
import { getFirestore } from "firebase-admin/firestore";
import { HttpsError } from "firebase-functions/v2/https";
import { ORG_NAMES } from "../interfaces.js";

type OrgUser = ListUsersResult["users"][number];

export const _getOrgUsers = async (data: any): Promise<ListUsersResult> => {
  const parsed = ListUsersParamsSchema.safeParse(data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", parsed.error);
  }

  const excludeArchived = parsed.excludeArchived;
  const excludeDisabled = parsed.excludeDisabled;
  const orderBy = parsed.orderBy;
  const orgId = parsed.orgId;
  const orgType = parsed.orgType;

  const db = getFirestore();
  const lowercaseOrgType = orgType.toLowerCase();
  const users: OrgUser[] = [];

  if (!ORG_NAMES.includes(lowercaseOrgType)) {
    throw new HttpsError(
      "invalid-argument",
      `${lowercaseOrgType} is not a valid org type`
    );
  }

  const usersCollection = db.collection("users");
  let usersQuery = usersCollection.where(
    `${lowercaseOrgType}.current`,
    "array-contains",
    orgId
  );
  if (excludeArchived) usersQuery = usersQuery.where("archived", "==", false);
  if (excludeDisabled) usersQuery = usersQuery.where("disabled", "==", false);
  const snapshot = await usersQuery.get();

  snapshot.forEach((doc) => {
    const userData = doc.data();

    let userType = userData.userType;
    if (userType.toLowerCase() === "parent") userType = "caregiver";
    if (userType.toLowerCase() === "student") userType = "child";

    users.push({
      uid: doc.id,
      username: userData.username,
      email: userData.email,
      userType,
      archived: userData.archived,
      disabled: userData.disabled,
    });
  });

  return { users };
};
