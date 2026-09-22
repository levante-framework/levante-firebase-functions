/**
 * Resets one or more users' passwords to freshly generated ones, matching how
 * levante-admin generates passwords (a-z0-9, length 10).
 *
 * Defaults to the dev project and to a dry run: it prints the new passwords
 * without writing them. Pass --apply to actually update the users, and relay
 * each printed password to its user (there is no other way to recover it).
 *
 * Applying also revokes each user's refresh tokens, invalidating existing
 * sessions so the old password can no longer be used.
 *
 * Each UID is processed independently: a failure on one (e.g. unknown UID)
 * does not stop the others, and the script exits non-zero if any failed.
 *
 * The generated uid,email,password rows are written as a CSV to the path given
 * by --output, in both dry-run and apply modes.
 *
 * Usage:
 *   # Dry run against dev (prints the passwords that would be set)
 *   npm run reset-user-password -- --uids <UID> [<UID> ...] -o out.csv
 *
 *   # Apply against prod
 *   npm run reset-user-password -- --uids <UID> [<UID> ...] -o out.csv -e prod --apply
 */
import * as fs from "fs";
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
    uids: {
      description: "Target users' Firebase Auth UIDs",
      type: "array",
      string: true,
      demandOption: true,
    },
    output: {
      alias: "o",
      description: "Filepath to write CSV output",
      type: "string",
      demandOption: true,
    },
    apply: {
      description: "Write the new passwords (dry-run by default)",
      type: "boolean",
      default: false,
    },
  })
  .help("help")
  .alias("help", "h")
  .parseSync() as {
  environment: "dev" | "prod";
  uids: string[];
  output: string;
  apply: boolean;
};

const projectId =
  argv.environment === "dev" ? "hs-levante-admin-dev" : "hs-levante-admin-prod";

const { app } = await initAdmin({ environment: argv.environment });
const auth = getAuth(app);

try {
  // Fail fast: prove the output path is writable before applying any
  // (irreversible) password changes, so generated passwords can't be lost.
  fs.writeFileSync(argv.output, "uid,email,password\n");

  const results: Array<Record<string, unknown>> = [];
  const csvRows: string[] = [];

  for (const uid of new Set(argv.uids)) {
    try {
      const user = await auth.getUser(uid);
      const newPassword = generateRandomString();

      if (argv.apply) {
        await auth.updateUser(uid, { password: newPassword });
        await auth.revokeRefreshTokens(uid);
        console.log(`Password reset and sessions revoked for ${uid}`);
      }

      results.push({ uid, email: user.email ?? undefined, newPassword });
      csvRows.push(`${uid},${user.email ?? ""},${newPassword}`);
    } catch (error) {
      process.exitCode = 1;
      if ((error as { code?: string }).code === "auth/user-not-found") {
        console.error(`No user found in ${projectId} with UID ${uid}`);
        results.push({ uid, error: "user-not-found" });
      } else {
        console.error(`Failed to reset password for ${uid}`, error);
        results.push({ uid, error: "failed" });
      }
    }
  }

  if (csvRows.length > 0) {
    fs.appendFileSync(argv.output, `${csvRows.join("\n")}\n`);
  }
  console.log(`Wrote ${csvRows.length} row(s) to ${argv.output}`);

  console.log(
    JSON.stringify({ projectId, apply: argv.apply, results }, null, 2)
  );

  if (!argv.apply) {
    console.log(
      "Dry run: passwords were not changed. Re-run with --apply to write."
    );
  }
} finally {
  await deleteApp(app);
}
