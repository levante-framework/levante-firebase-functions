# Emulator & dev project seed scripts

## Emulator (local)

- **Seed:** `npm run emulator:seed` — populates the local emulator (run with emulator started).
- **Clear:** `npm run emulator:clear` — wipes Auth + Firestore in the emulator.
- **Reset:** `npm run emulator:reset` — clear then seed.

## Live project (from firebaseconfig.js or env)

`seed:dev` and `clear:dev` use **projectId** from (in order): env `SEED_PROJECT` / `FIREBASE_PROJECT`, or the repo root file `firebaseconfig.js`. Locally, copy `firebaseconfig.example.js` to `firebaseconfig.js` and fill in values; that file is gitignored.

- **Seed:** `npm run seed:dev` — seeds the project (Auth + Firestore). Use Application Default Credentials (e.g. `gcloud auth application-default login`).
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
