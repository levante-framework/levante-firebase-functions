# Emulator & dev project seed scripts

## Emulator (local)

- **Seed:** `npm run emulator:seed` — populates the local emulator through Firebase callable functions.
- **Legacy seed:** `npm run emulator:seed:legacy` — legacy direct Auth/Firestore seed.
- **Functions seed:** `npm run emulator:seed:functions` — signs in as the bootstrapped super admin and creates visible dashboard data by invoking Firebase callable functions.
- **UI seed:** `npm run emulator:seed:ui` — drives the researcher dashboard through Cypress in `../levante-support` to create realistic groups, users, and assignments. Videos are disabled by default.
- **Start seeded dashboard:** `npm run emulator:start:dashboard` — starts Auth/Firestore/Functions emulators, bootstraps only permissions/admin/tasks, creates visible seed data through callable Firebase Functions, starts the local dashboard, then prints login credentials and keeps everything running for manual use.
- **Admin login smoke test:** `npm run emulator:test:admin-login` — starts Auth/Firestore/Functions emulators, bootstraps permissions, task variants, and a super-admin user, starts the local dashboard, then verifies the seeded super admin can log in through Cypress. Videos are disabled.
- **Clear:** `npm run emulator:clear` — wipes Auth + Firestore in the emulator.
- **Reset:** `npm run emulator:reset` — clear then seed.

`emulator:seed:ui` first bootstraps only data the dashboard cannot create itself: system permissions, a super-admin user/claims, and task variants. Cypress then signs in as that user, creates a Site through the dashboard UI, selects it, then creates realistic school/class/cohort/users/assignment data through the UI. Override the support repo path with `LEVANTE_SUPPORT_DIR=/path/to/levante-support` if the repos are not siblings.

`emulator:seed:functions` and `emulator:start:dashboard` use the same minimal bootstrap assumptions as the Cypress UI seed. The bootstrap creates only data the dashboard cannot create itself: system permissions, a super-admin user/claims, and task variants. Visible test fixtures are then created through the same callable Firebase Functions used by the dashboard (`setUidClaims`, `upsertOrg`, `createUsers`, `linkUsers`, and `upsertAdministration`).

`emulator:start:dashboard` provides these default credentials unless overridden with `E2E_AI_SUPER_ADMIN_EMAIL` and `E2E_AI_SUPER_ADMIN_PASSWORD`:

```text
Email: superadmin@levante.test
Password: super123
```

## Live project (from firebaseconfig.js or env)

`seed:dev` and `clear:dev` use **projectId** from (in order): env `SEED_PROJECT` / `FIREBASE_PROJECT`, or the repo root file `firebaseconfig.js`. Locally, copy `firebaseconfig.example.js` to `firebaseconfig.js` and fill in values; that file is gitignored.

- **Seed:** `npm run seed:dev` — seeds through Firebase callable functions. Use Application Default Credentials (e.g. `gcloud auth application-default login`).
- **Legacy seed:** `npm run seed:dev:legacy` — legacy direct Auth/Firestore seed.
- **Clear:** `CONFIRM_CLEAR=1 npm run clear:dev` — wipes Auth + Firestore in that project. Requires `CONFIRM_CLEAR=1` to avoid accidental runs.
- **Reset:** `npm run reset:dev` — clear (with confirmation) then seed.

To target a different project without changing the file, set `SEED_PROJECT`:

```bash
SEED_PROJECT=my-other-project npm run seed:dev
CONFIRM_CLEAR=1 SEED_PROJECT=my-other-project npm run clear:dev
```

## Keeping keys out of the repo (CI / public repo)

- **Do not commit** real keys or `firebaseconfig.js`. It is listed in `.gitignore`. If it was already committed, run `git rm --cached firebaseconfig.js` and commit to stop tracking it (keeps your local file).
- **Committed:** `firebaseconfig.example.js` — copy to `firebaseconfig.js` locally and fill in; never commit the copy.
- **CI (e.g. GitHub Actions):** Do not rely on `firebaseconfig.js` in the runner. Use env only:
  - **SEED_PROJECT** or **FIREBASE_PROJECT** — Firebase project ID (set as a repository variable or secret).
  - **FIREBASE_SERVICE_ACCOUNT_SEED_DEV** — Service account JSON key (repository secret) for Admin SDK auth. Write it to a file and set `GOOGLE_APPLICATION_CREDENTIALS` to that path before running the seed script.
- A workflow example lives in `.github/workflows/seed-dev.yml.example`. Rename to `seed-dev.yml`, add the secrets, and run manually (workflow_dispatch).
