import { CreateRequest, getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import _fromPairs from "lodash/fromPairs";
import { v4 as uuidv4 } from "uuid";
import { ICustomClaims, IName, IOrgsList } from "../interfaces";
import {
  appendOrRemoveAdminOrgs,
  setUidClaimsHandler,
  validateAdminStatus,
} from "./set-custom-claims";
import { ROLES } from "../utils/constants";

/**
 * Creates an admin user in both the admin and assessment Firebase projects.
 *
 * @param {object} params - An object containing the following properties:
 * @param {string} params.email - The email address of the new admin user.
 * @param {IName} params.name - The name of the new admin user.
 * @param {IOrgsList} params.orgs - The list of organizations the new admin user is a member of.
 * @param {IOrgsList} params.adminOrgs - The list of organizations the new admin user will have admin access to.
 * @param {string} params.requesterAdminUid - The UID of the user requesting the creation of the new admin user.
 * @param {boolean} [params.isTestData=false] - A flag indicating whether the new admin user is for testing purposes.
 * @param {boolean} [params.addUserClaimsAdminProperty=false] - A boolean indicating whether the new admin user should have an "admin" property added to their custom claims.
 * @returns {Promise<{ status: "ok" }>} - A promise that resolves to an object containing a "status" property with a value of "ok" upon successful creation of the admin user.
 */
export const createAdminUser = async ({
  email,
  name,
  orgs,
  adminOrgs,
  requesterAdminUid,
  isTestData = false,
  addUserClaimsAdminProperty = false,
}: {
  email: string;
  name: IName;
  orgs: IOrgsList;
  adminOrgs: IOrgsList;
  requesterAdminUid: string;
  isTestData?: boolean;
  addUserClaimsAdminProperty?: boolean;
}) => {
  const auth = getAuth();
  const db = getFirestore();

  //         +--------------------------------------------------------+
  // --------|  Create/edit users in Auth   |--------
  //         +--------------------------------------------------------+
  logger.debug(`Verifying admin user ${requesterAdminUid}`);
  const requesterRecord = await auth.getUser(requesterAdminUid);
  const requesterClaims = requesterRecord.customClaims as ICustomClaims;
  logger.debug("Got custom claims", { requesterClaims });
  const requesterUid = requesterClaims.adminUid;

  await validateAdminStatus({
    requesterUid: requesterUid,
    districts: adminOrgs.districts,
    schools: adminOrgs.schools,
    classes: adminOrgs.classes,
    families: adminOrgs.families,
    groups: adminOrgs.groups,
    auth: auth,
    db: db,
  });

  /* eslint-disable operator-linebreak */
  const displayName = name.middle
    ? `${name.first} ${name.middle} ${name.last}`
    : `${name.first} ${name.last}`;

  const getUserInfo = async (createPassword = false) => {
    const info: CreateRequest = {
      email,
      emailVerified: false,
      disabled: false,
      displayName,
    };

    if (createPassword) {
      info.password = uuidv4();
    }

    return info;
  };

  let preExistingUser = false;

  const adminUid = await auth
    .getUserByEmail(email)
    .then(async (userRecord) => {
      logger.debug(
        `Updating preexisting admin user with ${email} in admin project`
      );
      preExistingUser = true;
      await auth.updateUser(userRecord.uid, {
        email: userRecord.email || email,
        emailVerified: userRecord.emailVerified || false,
        disabled: false,
        displayName: userRecord.displayName || displayName,
      });
      return userRecord.uid;
    })
    .catch(async (error) => {
      if (error.code === "auth/user-not-found") {
        logger.debug(`Creating admin user with ${email} in admin project`);
        return auth
          .createUser(await getUserInfo(true))
          .then(async (userRecord) => {
            // Temporary, admin creation will be refactored to handle all admin role types.
            const roles = (adminOrgs.districts ?? []).map((districtId) => ({
              siteId: districtId,
              role: ROLES.ADMIN,
            }));
            await auth.setCustomUserClaims(userRecord.uid, { roles });
            return userRecord.uid;
          });
      } else {
        throw error;
      }
    });

  const roarUid = adminUid;
  const targetAuthUids = {
    admin: adminUid,
    assessment: adminUid,
  };

  logger.debug("Successfully created user", {
    roarUid,
    adminUid,
  });

  //         +--------------------------------------------------------+
  // --------|       Store UIDs and admin orgs in custom claims       |--------
  //         +--------------------------------------------------------+

  logger.debug(`Setting up custom claims in admin project`);

  // Pretty sure we don't use custom claims anywhere so this can be removed. Keeping for now.
  // await setUidClaimsHandler({
  //   roarUid,
  //   adminUid,
  //   auth: auth,
  //   db: db,
  //   targetAuthUid: targetAuthUids.admin,
  //   isTestData,
  // });



  await appendOrRemoveAdminOrgs({
    requesterUid: requesterUid,
    targetUid: targetAuthUids.admin,
    districts: adminOrgs.districts,
    schools: adminOrgs.schools,
    classes: adminOrgs.classes,
    families: adminOrgs.families,
    groups: adminOrgs.groups,
    action: "append",
    auth: auth,
    db: db,
  });

  if (addUserClaimsAdminProperty) {
    // Add admin property to userClaims docs for both projects
    const userClaimsDocRef = db
      .collection("userClaims")
      .doc(targetAuthUids.admin);

    const currentClaims = await userClaimsDocRef.get().then((docSnapshot) => {
      if (docSnapshot.exists) {
        /* eslint-disable @typescript-eslint/no-non-null-assertion */
        return docSnapshot.data()!.claims;
      }
      return {};
    });

    await userClaimsDocRef
      .set(
        {
          claims: {
            ...currentClaims,
            admin: true,
          },
        },
        { merge: true }
      )
      .then(() => {
        console.log("Updated userClaims doc");
      })
      .catch((error) => {
        console.error("Error updating userClaims doc: ", error);
        throw new Error("Error updating userClaims doc");
      });
  }

  //         +--------------------------------------------------------+
  // --------| Create docs in both the admin and assessment Firestore |--------
  //         +--------------------------------------------------------+
  const now = new Date();

  const orgListToMap = (orgs?: string[]) => {
    if (orgs === undefined) {
      return {
        current: [],
        all: [],
        dates: {},
      };
    }
    return {
      current: orgs || [],
      all: orgs || [],
      dates: _fromPairs(orgs.map((o) => [o, { from: now }])),
    };
  };

  let adminUserDocData = {};
  if (preExistingUser) {
    adminUserDocData = {
      userType: "admin",
      assessmentUid: adminUid,
      archived: false,
      lastUpdated: FieldValue.serverTimestamp(),
      testData: isTestData ?? false,
    };

    for (const orgType of ["districts", "schools", "classes", "groups"]) {
      if (orgs[orgType]?.length) {
        adminUserDocData[`${orgType}.current`] = FieldValue.arrayUnion(
          ...orgs[orgType]
        );
        adminUserDocData[`${orgType}.all`] = FieldValue.arrayUnion(
          ...orgs[orgType]
        );
        for (const orgId of orgs[orgType]) {
          adminUserDocData[`${orgType}.dates.${orgId}`] =
            FieldValue.serverTimestamp();
        }
      }
    }
  } else {
    adminUserDocData = {
      userType: "admin",
      assessmentUid: adminUid,
      districts: orgListToMap(orgs.districts),
      schools: orgListToMap(orgs.schools),
      classes: orgListToMap(orgs.classes),
      families: orgListToMap(orgs.families),
      groups: orgListToMap(orgs.groups),
      archived: false,
      createdAt: FieldValue.serverTimestamp(),
      lastUpdated: FieldValue.serverTimestamp(),
      testData: isTestData ?? false,
    };
  }

  const adminData = {
    ...adminUserDocData,
    email,
    name,
  };

  logger.debug("Creating user doc in admin project");
  const adminUserDocRef = db.collection("users").doc(roarUid);
  await adminUserDocRef.set(adminData, { merge: true });

  return {
    status: "ok",
  };
};
