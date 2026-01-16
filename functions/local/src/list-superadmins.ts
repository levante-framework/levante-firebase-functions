#!/usr/bin/env node
import * as admin from "firebase-admin/app";
import { deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

type Environment = "dev" | "prod";
type Format = "table" | "json";

const envVariable = "LEVANTE_ADMIN_FIREBASE_CREDENTIALS";

const argv = yargs(hideBin(process.argv))
  .options({
    environment: {
      alias: "e",
      description: "Environment to run against",
      choices: ["dev", "prod"] as const,
      default: "prod" as const,
    },
    limit: {
      description: "Limit number of rows displayed",
      type: "number",
    },
    format: {
      alias: "f",
      description: "Output format",
      choices: ["table", "json"] as const,
      default: "table" as const,
    },
  })
  .help("help")
  .alias("help", "h")
  .parseSync() as { environment: Environment; limit?: number; format: Format };

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

const snap = await db.collection("userClaims").where("claims.super_admin", "==", true).get();
const uids = snap.docs.map((d) => d.id);
const limitedUids =
  typeof argv.limit === "number" && argv.limit > 0 ? uids.slice(0, argv.limit) : uids;

const rows: Array<Record<string, unknown>> = [];

for (const uid of limitedUids) {
  const doc = snap.docs.find((d) => d.id === uid);
  const docClaims = (doc?.data() as any)?.claims ?? {};

  let email: string | undefined;
  let displayName: string | undefined;
  let authDisabled: boolean | undefined;
  let authSuperAdmin: boolean | undefined;
  let authAdmin: boolean | undefined;

  try {
    const user = await auth.getUser(uid);
    email = user.email ?? undefined;
    displayName = user.displayName ?? undefined;
    authDisabled = user.disabled ?? undefined;
    authSuperAdmin = Boolean((user.customClaims as any)?.super_admin);
    authAdmin = Boolean((user.customClaims as any)?.admin);
  } catch {
    email = undefined;
    displayName = undefined;
    authDisabled = undefined;
    authSuperAdmin = undefined;
    authAdmin = undefined;
  }

  rows.push({
    uid,
    email,
    displayName,
    authDisabled,
    super_admin_userClaimsDoc: Boolean(docClaims?.super_admin),
    admin_userClaimsDoc: Boolean(docClaims?.admin),
    super_admin_customClaim: authSuperAdmin,
    admin_customClaim: authAdmin,
    mismatch: Boolean(docClaims?.super_admin) !== Boolean(authSuperAdmin),
  });
}

if (argv.format === "json") {
  console.log(JSON.stringify({ projectId, count: rows.length, rows }, null, 2));
  await deleteApp(app);
  process.exit(0);
}

console.log(`Project: ${projectId}`);
console.log(
  `SuperAdmins found (by Firestore userClaims): ${uids.length}${argv.limit ? ` (showing ${rows.length})` : ""}`,
);
console.table(rows);

await deleteApp(app);

