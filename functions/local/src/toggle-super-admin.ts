/**
 * Toggles a user's super admin status.
 * This script takes an email address and flips the super_admin flag in the user's
 * custom claims document between true and false.
 */

import * as admin from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { Firestore, getFirestore } from "firebase-admin/firestore";

const adminCredentialFile = process.env.LEVANTE_ADMIN_FIREBASE_CREDENTIALS;

if (!adminCredentialFile) {
  console.error(
    `Missing required environment variables:
    - LEVANTE_ADMIN_FIREBASE_CREDENTIALS
    Please set these environment variables using
    export LEVANTE_ADMIN_FIREBASE_CREDENTIALS=path/to/credentials/for/admin/project.json`
  );
  process.exit(1);
}

const adminCredentials = (
  await import(adminCredentialFile, {
    assert: { type: "json" },
  })
).default;

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error("Give exactly one email argument");
  process.exit(1);
}

const email = args[0];
const adminApp = admin.initializeApp(
  {
    credential: admin.cert(adminCredentials),
    projectId: "hs-levante-admin-dev",
  },
  "admin",
);

const adminAuth = getAuth(adminApp);
const adminFirestore = getFirestore(adminApp);

// Get the target user's current custom claims.
await adminAuth.getUserByEmail(email).then((targetRecord) => {
  const targetClaims = targetRecord.customClaims;
  const adminUid = targetClaims?.adminUid;

  return toggleSuperAdmin({
    targetUid: adminUid,
    db: adminFirestore,
  }).then(({ userClaims }) => {
    console.log(
      `[admin] user ${userClaims.roarUid} with email ${email} ` +
        `now has super_admin = ${userClaims.super_admin}`,
    );
  });
});

export interface IAdminClaims {
  districts?: string[];
  schools?: string[];
  classes?: string[];
  families?: string[];
  groups?: string[];
}

/** Every ROAR user has the following custom claims */
export interface ICustomClaims {
  hyper_admin?: boolean;
  super_admin?: boolean;
  roarUid: string;
  adminUid: string;
  assessmentUid: string;
  adminOrgs?: IAdminClaims;
}

interface IInput {
  /** The auth UID of the target user */
  targetUid: string;
  db: Firestore;
}

/**
 * Toggle a ROAR user's super_admin claim.
 *
 * This function returns a Promise which resolves to an http status code. It
 * returns an object with a `status` property which is any of
 * - "ok" if successful,
 * - "permission-denied" if the requesting user is not authorized, or
 * - "resource-exhausted" if the users custom claims exceed the maximum storage size.
 *
 * @param {object} input - an object containing the custom admin claims
 * @param {string} input.targetUid - The assessment Firebase auth UID of the target user
 * @param {Firstore} input.db - The Firebase Admin SDK Firestore instance
 * @return {Promise<{ status: string }>}
 */
async function toggleSuperAdmin({ targetUid, db }: IInput) {
  const targetClaimsRef = db.collection("userClaims").doc(targetUid);
  const targetClaims = await targetClaimsRef.get().then((docSnap) => {
    return docSnap.data()?.claims;
  });

  targetClaims.super_admin = !targetClaims.super_admin;

  return db
    .collection("userClaims")
    .doc(targetUid)
    .set({
      claims: targetClaims,
    })
    .then(() => {
      return {
        status: "ok",
        userClaims: targetClaims,
      };
    });
}
