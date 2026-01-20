#!/usr/bin/env node
import * as admin from "firebase-admin/app";
import { deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";

type Environment = "dev" | "prod";

type Role = {
  siteId: string;
  role: string;
  siteName?: string;
};

const envVariable = "LEVANTE_ADMIN_FIREBASE_CREDENTIALS";

function normalizeRoles(roles: unknown): Role[] {
  if (!Array.isArray(roles)) return [];
  return roles
    .map((r: any) => ({
      siteId: String(r?.siteId ?? ""),
      role: String(r?.role ?? ""),
      siteName: typeof r?.siteName === "string" ? r.siteName : "",
    }))
    .filter((r) => r.siteId && r.role);
}

function buildRoleMaps(roles: Role[]) {
  const siteRoles: Record<string, string[]> = {};
  const siteNames: Record<string, string> = {};

  for (const r of roles) {
    if (!siteRoles[r.siteId]) siteRoles[r.siteId] = [];
    if (!siteRoles[r.siteId].includes(r.role)) siteRoles[r.siteId].push(r.role);

    if (typeof r.siteName === "string" && r.siteName.trim()) siteNames[r.siteId] = r.siteName.trim();
    else if (!(r.siteId in siteNames)) siteNames[r.siteId] = r.siteId;
  }

  return { siteRoles, siteNames };
}

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
    apply: {
      description: "Write changes (dry-run by default)",
      type: "boolean",
      default: false,
    },
  })
  .check((a) => {
    if (!a.email && !a.uid) throw new Error("Provide either --email or --uid");
    return true;
  })
  .help("help")
  .alias("help", "h")
  .parseSync() as { environment: Environment; email?: string; uid?: string; apply: boolean };

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

const user = argv.uid ? await auth.getUser(argv.uid) : await auth.getUserByEmail(argv.email!);
const uid = user.uid;

const usersDoc = await db.doc(`users/${uid}`).get().then((s) => (s.exists ? s.data() : null));
const existingCustomClaims = (user.customClaims ?? {}) as Record<string, unknown>;

const rolesFromUsers = normalizeRoles((usersDoc as any)?.roles);
const rolesFromClaims = normalizeRoles((existingCustomClaims as any)?.roles);
const baseRoles = rolesFromUsers.length > 0 ? rolesFromUsers : rolesFromClaims;

const rolesSet = Array.from(new Set(baseRoles.map((r) => r.role)));
const { siteRoles, siteNames } = buildRoleMaps(baseRoles);

const nextCustomClaims = {
  ...existingCustomClaims,
  rolesSet,
  roles: baseRoles,
  siteRoles,
  siteNames,
};

console.log(
  JSON.stringify(
    {
      projectId,
      uid,
      email: user.email ?? undefined,
      apply: Boolean(argv.apply),
      usersRolesCount: rolesFromUsers.length,
      existingCustomClaims,
      proposedCustomClaims: nextCustomClaims,
    },
    null,
    2,
  ),
);

if (argv.apply) await auth.setCustomUserClaims(uid, nextCustomClaims);

await deleteApp(app);

