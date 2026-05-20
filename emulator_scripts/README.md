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

## Seeding the emulator with a snapshot of variants from dev or prod

By default, `npm run emulator:seed` seeds tasks and variants from `emulator_scripts/seeders/default-variant-seed.json`. To run the emulator against currently registered variants from dev or prod, first export a snapshot, then point the seeder at it.

### 1) Export a variants snapshot from dev or prod

Use the local script `export-registered-variants`. By default the snapshot is written to `emulator_scripts/registered-variants.json` (which is gitignored), so this is enough:

```bash
# from repo root — writes to <repo>/emulator_scripts/registered-variants.json
npm --prefix functions/local run export-registered-variants -- --env dev
# from prod
npm --prefix functions/local run export-registered-variants -- --env prod
```

Pass `--out <path>` to write somewhere else (e.g. outside the working tree):

```bash
npm --prefix functions/local run export-registered-variants -- --env prod --out ~/snapshots/levante-prod-variants.json
```

Flags (yargs):

- `-e, --env, --environment dev | prod` — source project (`hs-levante-admin-dev` or `hs-levante-admin-prod`). Defaults to `dev`.
- `-f, --env-file, --envFile <path>` — env file containing the credentials variable (`LEVANTE_ADMIN_DEV_FIREBASE_CREDENTIALS` / `LEVANTE_ADMIN_PROD_FIREBASE_CREDENTIALS`). Defaults to `.env.local`.
- `-o, --out <path>` — output JSON file path, resolved against the current working directory. Defaults to `<repo>/emulator_scripts/registered-variants.json`.
- `-h, --help` — print usage.

Only variants with `registered: true` are exported. The output is a `{ exportedAt, environment, sourceProject, rows }` JSON file that matches the seeder's expected shape (see `blank-variant-seed.json`).

Authentication uses the local `init-admin.js` utility.

### 2) Seed the emulator from the snapshot

Pass the snapshot path to the seeder via `--variant-seed` (or the `VARIANT_SEED_FILE` env var):

```bash
# from repo root, after `npm run dev` is running in another terminal
npm run emulator:seed -- --variant-seed emulator_scripts/registered-variants.json
```

If no `--variant-seed` is provided, the seeder falls back to `emulator_scripts/seeders/default-variant-seed.json`.

To persist the seeded state across emulator restarts, run `npm run emulator:export` (or rely on `npm run dev`'s `--export-on-exit`).


## Keeping keys out of the repo (CI / public repo)

- **Do not commit** real keys or `firebaseconfig.js`. It is listed in `.gitignore`. If it was already committed, run `git rm --cached firebaseconfig.js` and commit to stop tracking it (keeps your local file).
- **Committed:** `firebaseconfig.example.js` — copy to `firebaseconfig.js` locally and fill in; never commit the copy.
- **CI (e.g. GitHub Actions):** Do not rely on `firebaseconfig.js` in the runner. Use env only:
  - **SEED_PROJECT** or **FIREBASE_PROJECT** — Firebase project ID (set as a repository variable or secret).
  - **FIREBASE_SERVICE_ACCOUNT_SEED_DEV** — Service account JSON key (repository secret) for Admin SDK auth. Write it to a file and set `GOOGLE_APPLICATION_CREDENTIALS` to that path before running the seed script.
- A workflow example lives in `.github/workflows/seed-dev.yml.example`. Rename to `seed-dev.yml`, add the secrets, and run manually (workflow_dispatch).
