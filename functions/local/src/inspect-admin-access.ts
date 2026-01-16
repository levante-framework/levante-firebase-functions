#!/usr/bin/env node
import * as admin from "firebase-admin/app";
import { deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

type Environment = "dev" | "prod";
type Format = "table" | "json";

type UsersRole = {
  siteId: string;
  role: string;
  siteName?: string;
};

const envVariable = "LEVANTE_ADMIN_FIREBASE_CREDENTIALS";

const argv = yargs(hideBin(process.argv))
  .options({
    environment: {
      alias: "e",
      description: "Environment to run against",
      choices: ["dev", "prod"] as const,
      default: "prod" as const,
    },
    email: {
      description: "Target user's email",
      type: "string",
    },
    uid: {
      description: "Target user's Firebase Auth UID",
      type: "string",
    },
    format: {
      alias: "f",
      description: "Output format",
      choices: ["table", "json"] as const,
      default: "table" as const,
    },
  })
  .check((a) => {
    if (!a.email && !a.uid) throw new Error("Provide either --email or --uid");
    return true;
  })
  .help("help")
  .alias("help", "h")
  .parseSync() as {
  environment: Environment;
  email?: string;
  uid?: string;
  format: Format;
};

const credentialFile = process.env[envVariable];
if (!credentialFile) {
  console.error(
    `Missing required environment variable: ${envVariable}
    Please set this environment variable using
    export ${envVariable}=path/to/credentials/for/admin/project.json`,
  );
  process.exit(1);
}

const isDev = argv.environment === "dev";
const projectId = isDev ? "hs-levante-admin-dev" : "hs-levante-admin-prod";

const credentials = (
  await import(credentialFile, {
    assert: { type: "json" },
  })
).default;

const app = admin.initializeApp(
  {
    credential: admin.cert(credentials),
    projectId,
  },
  "admin",
);

const auth = getAuth(app);
const db = getFirestore(app);

async function safeGetDoc(path: string) {
  try {
    const snap = await db.doc(path).get();
    return snap.exists ? snap.data() : null;
  } catch (error) {
    return { _error: error instanceof Error ? error.message : String(error) };
  }
}

const user = argv.uid ? await auth.getUser(argv.uid) : await auth.getUserByEmail(argv.email!);
const uid = user.uid;

const [userClaimsDoc, usersDoc, systemPermissionsDoc] = await Promise.all([
  safeGetDoc(`userClaims/${uid}`),
  safeGetDoc(`users/${uid}`),
  safeGetDoc(`system/permissions`),
]);

if (argv.format === "table") {
  const customClaims = (user.customClaims ?? {}) as Record<string, unknown>;
  const userClaimsClaims = (userClaimsDoc as any)?.claims ?? {};
  const roles = (usersDoc as any)?.roles as UsersRole[] | undefined;

  console.log(`Project: ${projectId}`);
  console.table([
    {
      uid,
      email: user.email ?? undefined,
      super_admin_customClaim: Boolean((customClaims as any)?.super_admin),
      admin_customClaim: Boolean((customClaims as any)?.admin),
      super_admin_userClaimsDoc: Boolean((userClaimsClaims as any)?.super_admin),
      admin_userClaimsDoc: Boolean((userClaimsClaims as any)?.admin),
      useNewPermissions_userClaimsDoc: Boolean((userClaimsClaims as any)?.useNewPermissions),
      rolesCount_usersDoc: Array.isArray(roles) ? roles.length : undefined,
      hasSystemPermissionsDoc: Boolean(systemPermissionsDoc),
    },
  ]);

  await deleteApp(app);
  process.exit(0);
}

console.log(
  JSON.stringify(
    {
      projectId,
      user: {
        uid,
        email: user.email ?? undefined,
        displayName: user.displayName ?? undefined,
        disabled: user.disabled ?? undefined,
        customClaims: user.customClaims ?? {},
      },
      firestore: {
        userClaims: userClaimsDoc,
        users: usersDoc,
        system_permissions: systemPermissionsDoc,
      },
    },
    null,
    2,
  ),
);

await deleteApp(app);

