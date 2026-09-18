# Seed `variantParamSpecs`

One-time migration that creates `variantParamSpecs/{paramName}` documents from
`params` on existing `tasks/{taskId}/variants/{variantId}` docs.

This matches the emulator seeder in
`emulator_scripts/seeders/variant-param-specs.js`. By default the script is
additive: existing spec documents are not overwritten. Pass `--overwrite` to
delete the current `variantParamSpecs` collection and seed from scratch.

## Prerequisites

From `functions/local`:

```bash
cd functions/local
npm install
```

You need a Firebase Admin service account JSON for the target project:

| Environment | Project ID | Credential env var |
| --- | --- | --- |
| `dev` | `hs-levante-admin-dev` | `LEVANTE_ADMIN_DEV_FIREBASE_CREDENTIALS` |
| `prod` | `hs-levante-admin-prod` | `LEVANTE_ADMIN_PROD_FIREBASE_CREDENTIALS` |

Fallback (either environment): `LEVANTE_ADMIN_FIREBASE_CREDENTIALS`.

Put the path in `.env.local` (gitignored) under `functions/local` or the repo
root:

```bash
LEVANTE_ADMIN_DEV_FIREBASE_CREDENTIALS=/absolute/path/to/hs-levante-admin-dev.json
LEVANTE_ADMIN_PROD_FIREBASE_CREDENTIALS=/absolute/path/to/hs-levante-admin-prod.json
```

Or export the variable in your shell before running.

## Run

Always dry-run first. Dry-run is the default (`--dryRun` is `true` unless you
pass `--dryRun false`).

```bash
cd functions/local

# DEV dry-run
npx tsx migrations/seed-variant-param-specs.ts --environment dev

# DEV apply (additive)
npx tsx migrations/seed-variant-param-specs.ts --environment dev --dryRun false

# DEV overwrite: delete existing specs, then seed
npx tsx migrations/seed-variant-param-specs.ts --environment dev --overwrite --dryRun false

# PROD dry-run
npx tsx migrations/seed-variant-param-specs.ts --environment prod

# PROD apply (additive)
npx tsx migrations/seed-variant-param-specs.ts --environment prod --dryRun false
```

Optional flags:

- `--overwrite` / `-o` — delete all existing `variantParamSpecs`, then seed from scratch (default `false`)
- `--envFile` / `-f` — env file path (default `.env.local`)
- `--batchSize` / `-b` — Firestore write batch size (default `400`, max `500`)
- `--help` / `-h`

## What it writes

For each unique param key found on any variant:

- Document ID = param name (for example `maxTime`)
- `archived: false`
- `name` and `description` = param name
- `type` inferred from observed values: `boolean`, `number`, `string`, or
  `unknown` (mixed types, objects, or only-null values)
- `createdBy` / `updatedBy` = `migration-seed-variant-param-specs`

Without `--overwrite`, specs that already exist are skipped. Specs that exist
but are not used by any current variant are left unchanged and listed in the
log. With `--overwrite`, every existing spec is deleted first (including unused
ones), then all inferred keys are written.
