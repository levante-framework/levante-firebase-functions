/**
 * Resets a single users's password to a freshly generated one, matching how
 * levante-admin generates passwords (a-z0-9, length 10).
 *
 * Defaults to the dev project and to a dry run: it prints the new password
 * without writing it. Pass --apply to actually update the user, and relay the
 * printed password to the user (there is no other way to recover it).
 *
 * Applying also revokes the user's refresh tokens, invalidating existing
 * sessions so the old password can no longer be used.
 *
 * Usage:
 *   # Dry run against dev (prints the password that would be set)
 *   npm run reset-user-password -- --uid <UID>
 *
 *   # Apply against prod
 *   npm run reset-user-password -- --uid <UID> -e prod --apply
 */
import { deleteApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { initAdmin } from "./utils/init-admin.js";

/**
 * Generates a random string in the same way levante-admin does.
 *
 * Copied from `generateRandomString` in
 * functions/levante-admin/src/users/create-users.ts. Keep in sync: passwords
 * set here must match the format that function produces for new users.
 */
function generateRandomString(length = 10): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  const charsLength = chars.length;

  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * charsLength));
  }

  return result;
}

const argv = yargs(hideBin(process.argv))
  .options({
    environment: {
      alias: "e",
      description: "Environment to run against",
      choices: ["dev", "prod"] as const,
      default: "dev" as const,
    },
    uid: {
      description: "Target user's Firebase Auth UID",
      type: "string",
      demandOption: true,
    },
    apply: {
      description: "Write the new password (dry-run by default)",
      type: "boolean",
      default: false,
    },
  })
  .help("help")
  .alias("help", "h")
  .parseSync() as {
  environment: "dev" | "prod";
  uid: string;
  apply: boolean;
};

const projectId =
  argv.environment === "dev" ? "hs-levante-admin-dev" : "hs-levante-admin-prod";

const { app } = await initAdmin({ environment: argv.environment });
const auth = getAuth(app);

try {
  const user = await auth.getUser(argv.uid);

  const newPassword = generateRandomString();

  console.log(
    JSON.stringify(
      {
        projectId,
        uid: argv.uid,
        email: user.email ?? undefined,
        apply: argv.apply,
        newPassword,
      },
      null,
      2
    )
  );

  if (argv.apply) {
    await auth.updateUser(argv.uid, { password: newPassword });
    await auth.revokeRefreshTokens(argv.uid);
    console.log(`[admin] password reset and sessions revoked for ${argv.uid}`);
  } else {
    console.log(
      "Dry run: password was not changed. Re-run with --apply to write."
    );
  }
} catch (error) {
  if ((error as { code?: string }).code === "auth/user-not-found") {
    console.error(`No user found in ${projectId} with UID ${argv.uid}`);
  } else {
    console.error(error);
  }
  process.exitCode = 1;
} finally {
  await deleteApp(app);
}
