# Fix disappearing assignments

## Issue summary

Some assignment creation flows appeared to succeed in the UI, but one or more user assignment documents were missing under:

- `users/{uid}/assignments/{administrationId}`

This was reported as "disappearing assignments".

## What we found

Two different behaviors were mixed together:

1. Expected non-assignment due to conditions
   - Some administrations intentionally assign only users that match an `assigned` condition (for example `userType == student`).
   - In those cases, parent/teacher users are correctly not assigned.

2. Real backend risk in async fan-out
   - Assignment fan-out runs asynchronously in `updateAssignmentsForOrgChunk`.
   - If the payload includes undefined values or malformed org arrays, Firestore writes can fail and prevent some assignment docs from being written.

## Why this can look like a UI success

Administration creation and assignment fan-out are separate phases:

1. administration doc is created/updated
2. fan-out tasks are enqueued and processed later

If phase 1 succeeds and phase 2 partially fails, users can see successful creation while assignment docs are incomplete.

## Changes in this fix

### 1) Harden upsert payloads (`src/upsertAdministration.ts`)

- Normalize org ID arrays (`districts`, `schools`, `classes`, `groups`) to non-empty string IDs only.
- Strip undefined recursively from assessments and legal fields.
- Normalize assessment `params` to an object.
- Validate required assessment fields (`taskId`, `variantId`, `variantName`).
- Reject invalid dates explicitly.
- Ensure update payload preserves a valid `createdBy` value.

These changes reduce malformed data entering downstream fan-out.

### 2) Harden assignment writes (`src/assignments/assignment-utils.ts`)

- Use cleaned assessments when building assignment docs.
- Sanitize assignment documents before `transaction.set(...)` in both add and update flows.

This prevents transaction failures caused by nested undefined fields.

### 3) Improve recursive sanitizer (`src/utils/utils.ts`)

- `removeUndefinedFields()` now recursively cleans nested arrays, not only top-level array items.

This closes a gap where undefined values inside array objects could survive and break Firestore writes.

## Why this fixes disappearing assignments

The core failure mode was bad shape/undefined data reaching Firestore write paths in async fan-out.
By normalizing and validating input early and sanitizing assignment payloads immediately before write, task execution is significantly less likely to fail partway through chunk processing.

## Operational recommendation

- Monitor `updateAssignmentsForOrgChunk` error rates and alert on repeated payload-shape failures.
- Keep an audit test that compares expected eligible users against actual assignment docs.

