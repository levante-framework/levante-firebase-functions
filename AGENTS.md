# LEVANTE Firebase Functions

Backend for [LEVANTE](https://github.com/levante-framework), a web assessment platform for studying how children learn. These are [Cloud Functions for Firebase](https://firebase.google.com/docs/functions) that mediate Firestore access for a Vue SPA.

## Layout

- `functions/levante-admin/` — Primary Cloud Functions (TypeScript). **All new work goes here.**
- `__tests__/e2e/` — End-to-end tests run against emulator. Add or update tests here when working on `levante-admin` functions. Agents must not run them — only humans.
- `functions/local/` — One-off scripts for DB admin tasks. Not deployed. **Agents must not execute these scripts** — only humans run them.
- `emulator_scripts/` — seed scripts for the local Firebase emulator.
- `functions/levante-assessment/` — **deprecated. Do not edit or reference.**

## Dev commands

Run from the project root to check your work.

```bash
npm run format    # Format code
npm run test:unit # Run unit tests
npm run build     # Check syntax by compiling Typescript
```

## Legacy names

This project was forked from ROAR. ROAR's naming convention persists in Firestore but must not leak into TypeScript code or function interfaces.

**Rule: use the ROAR names only in Firestore queries. Use the LEVANTE name everywhere else** — variables, parameters, interfaces, comments, logs.

The refactor is ongoing, so ROAR names may appear anywhere in existing code. Treat them as tech debt; use the LEVANTE name in any code you write or touch.

| ROAR name | LEVANTE name |
|---|---|
| `districts` | `site` |
| `students` | `child` |
| `parents` | `caregiver` |
| `groups` | `cohort` |

`group` docs use `parentOrgId` / `parentOrgType: "districts"` to reference their site. Map these at the query boundary:

```ts
const cohorts = db
  .collection("groups")
  .where("parentOrgId", "==", siteId)
  .get()
  .docs.map((d) => ({
    id: d.id,
    siteId: d.get("parentOrgId"),
    // ...
  }));
```

### `administration` vs `assignment` vs `assessment` (distinct concepts, not renames)

All three co-exist. Disambiguate by Firestore location, not vocabulary.

| Term | Lives at | What it is |
|---|---|---|
| Administration | `administrations/{id}` | The admin-authored definition: a named set of assessments assigned to orgs over a `dateOpened`–`dateClosed` window. Interface `Administration`. |
| Assignment | `users/{uid}/assignments/{administrationId}` (doc id == administration id) | The per-user instance of an administration: the subset of assessments that user qualifies for, plus their progress (`startedOn`/`completedOn`, runs). |
| Assessment | an entry in an `assessments[]` array (e.g. `egma-math`) | A single task with `taskId`, `variantId`, `params`, and `conditions`. Lives in the administration (definition) and, filtered per user, inside each assignment. |

**Don't** treat `administration` as the ROAR name for `assignment` — it is not a rename. **Do** read top-level `administrations/*` as the definition and `users/*/assignments/*` as the per-user instance.

## Reference files (load on demand)

- `functions/levante-admin/src/index.ts` — every exported function is registered here.
- `functions/levante-admin/src/firestore-schema.ts` — canonical Firestore document interfaces (`Administration`, `District`, `Class`, `Claims`, etc.). Reuse; don't redeclare.
- `functions/levante-admin/src/interfaces.ts` — shared TS interfaces for callable inputs/outputs. **Migration to `levante-zod` in-progress.**
- `functions/levante-admin/src/utils/permission-helpers.ts` — auth/permission checks.
- `functions/levante-admin/firestore.indexes.json` — composite indexes.

## Project-specific rules

- **Don't** use Firebase Functions v1 (`functions.https.onCall`, `functions.config()`). **Do** import from `firebase-functions/v2/https`, `firebase-functions/v2/firestore`, `firebase-functions/v2/tasks`, and configure runtime with `setGlobalOptions({...})` in `index.ts`.
- **Don't** treat admin and assessment as separate Firebase projects. **Do** use a single `getFirestore()` from `firebase-admin/firestore`; ignore old code that references a separate assessment app.
- **Don't** assume background triggers fire exactly once. **Do** make Firestore/Tasks/Schedule triggers idempotent with a check-then-write or a transaction.
- **Don't** redeclare `District`, `Administration`, `Claims`, etc. **Do** import from `firestore-schema.ts`.
- **Don't** read `users/{uid}` from Firestore to inspect `userType` or `roles` for auth. **Do** use `getAuth().getUser(uid)` + `buildPermissionsUserFromAuthRecord` — the matrix is driven by Auth custom claims.
- **Don't** `console.log`. **Do** use `logger` from `firebase-functions/v2` with structured fields as the second arg — `console.log` is harder to query in Cloud Logging.
- **Don't** use `new Date()` for `createdAt` / `updatedAt`. **Do** use `FieldValue.serverTimestamp()`.

## Firestore gotchas (project-specific)

- **Querying user orgs uses `FieldPath`.** Org membership lives at `users.{districts|schools|classes|groups}.current` (an array). Query with `new FieldPath("districts", "current")` + `array-contains`. See `src/users/` for examples.
- **Transactions vs batches.** Use a transaction for read-modify-write that must be atomic (claim a slot, conditional increment). Use a batch when you just need many writes to commit together. Both have a 500-op limit.
