# Local ROAR Firebase Admin Functions

## Setup

These functions can use either service-account credentials or Google ADC.

- Preferred: set `LEVANTE_ADMIN_FIREBASE_CREDENTIALS` (admin project JSON key).
- Optional: set `ROAR_ASSESSMENT_FIREBASE_CREDENTIALS` if a script needs the assessment project.

See the [admin-SDK setup instructions](https://firebase.google.com/docs/admin/setup/#initialize_the_sdk_in_non-google_environments) for more details on service accounts and ADC.

It might be helpful to set these environment variables in your `.zshrc` file (or similar shell setup files).
For example,

```bash
export ROAR_ADMIN_FIREBASE_CREDENTIALS=path/to/credentials/for/admin/project.json
export ROAR_ASSESSMENT_FIREBASE_CREDENTIALS=path/to/credentials/for/assessment/project.json`
```

## Functions

This section describes each of the npm scripts available to you.

- `npm run set-superadmin` sets Firebase Auth custom claims `super_admin=true` and `admin=true` for a target user and ensures role mappings (`roles`, `rolesSet`, `siteRoles`, `siteNames`) are consistent. By default it is a dry-run; add `-- --apply` to write. The user must sign out/sign back in to refresh their ID token.

  ```bash
  # PROD (dry-run)
  npm run set-superadmin -- --environment prod --email someone@stanford.edu
  # PROD (apply)
  npm run set-superadmin -- --environment prod --email someone@stanford.edu --apply
  ```

- `npm run rebuild-custom-claims` rebuilds the role-mapping fields inside Firebase Auth custom claims from `users/<uid>.roles` (does not grant superadmin). It normalizes role strings and sets `useNewPermissions` when missing. By default it is a dry-run; add `-- --apply` to write.

  ```bash
  npm run rebuild-custom-claims -- --environment prod --email someone@stanford.edu
  npm run rebuild-custom-claims -- --environment prod --email someone@stanford.edu --apply
  ```

- `npm run inspect-admin-access` prints a quick view of a user's Auth custom claims vs Firestore `users` / `userClaims` / `system/permissions` docs for debugging. Use `--format json` for full output.

  ```bash
  npm run inspect-admin-access -- --environment prod --email someone@stanford.edu
  npm run inspect-admin-access -- --environment prod --email someone@stanford.edu --format json
  ```

- `npm run list-superadmins` lists SuperAdmins (based on Firestore `userClaims.claims.super_admin`) and shows whether Firebase Auth custom claims agree, to help find mismatches.

  ```bash
  npm run list-superadmins -- --environment prod
  npm run list-superadmins -- --environment prod --format json
  ```

- `npm run normalize-user-roles` normalizes `users/<uid>.roles` entries (e.g. "site admin" -> "site_admin") and updates `userClaims/<uid>.claims` to keep `roles`, `rolesSet`, `siteRoles`, `siteNames`, and `useNewPermissions` in sync. By default it is a dry-run; add `-- --apply` to write. You can target a single user by email or UID.

  ```bash
  npm run normalize-user-roles -- --database prod
  npm run normalize-user-roles -- --database prod --apply
  npm run normalize-user-roles -- --database prod --email someone@stanford.edu --apply
  npm run normalize-user-roles -- --database prod --uid ROAR_UID --apply
  ```

- `npm run list-admin-roles` exports a CSV of admin roles (Email, site, role) for the specified environment.

  ```bash
  npm run list-admin-roles -- --database prod
  npm run list-admin-roles -- --database prod --out /tmp/admin-roles.csv
  ```

- `npm run list-roles-by-email` prints roles for specific email addresses.

  ```bash
  npm run list-roles-by-email -- --database prod --emails user1@example.com user2@example.com
  ```

- `npm run toggle-super-admin` will toggle the `super_admin` custom claim for a given ROAR UID. You must pass the ROAR UID as an argument to this script using the following syntax:

  ```bash
  # Note the space separating the -- from the ROAR_UID argument
  npm run toggle-super-admin -- ROAR_UID
  ```
