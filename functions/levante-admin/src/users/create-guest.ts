import { getFirestore } from "firebase-admin/firestore";
import type { FieldValue } from "firebase-admin/firestore";
import type { AuthUserRecord } from "firebase-functions/v2/identity";
import { logger } from "firebase-functions/v2";
import _head from "lodash-es/head.js";
import _split from "lodash-es/split.js";
import _get from "lodash-es/get.js";
import _set from "lodash-es/set.js";
import _isEmpty from "lodash-es/isEmpty.js";
import _includes from "lodash-es/includes.js";
import { emptyOrgs } from "../utils/utils.js";

export const createGuestDocs = async (
  user: AuthUserRecord,
  sso: string = "google"
) => {
  const roarUid = user.uid;
  const guestUserData = {
    userType: "guest",
    districts: emptyOrgs(),
    schools: emptyOrgs(),
    classes: emptyOrgs(),
    families: emptyOrgs(),
    groups: emptyOrgs(),
    archived: false,
    createdAt: FieldValue.serverTimestamp(),
    sso,
  };

  const email = user.email;
  const displayName = user.displayName;

  const adminOnlyDocData = {
    email,
    displayName,
  };

  const db = getFirestore();

  const adminUserRef = db.collection("users").doc(roarUid);
  const adminUserDoc = await adminUserRef.get();
  if (adminUserDoc.exists) {
    logger.debug(`Updating existing user ${roarUid} in admin db`);
    await adminUserRef.update({
      ...adminOnlyDocData,
      sso,
    });
  } else {
    logger.debug(`Creating guest user ${roarUid} in admin db`);
    await adminUserRef.set({
      ...adminOnlyDocData,
      ...guestUserData,
    });
  }
};
