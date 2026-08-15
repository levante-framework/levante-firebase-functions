# Firestore Write Journal

## What This Does

`journalWrite` is a Firebase Cloud Functions v2 Firestore trigger that records application writes from the default Firestore database into a BigQuery append-only journal. Each row includes the Firestore event ID, document path, operation, commit time, ingest time, before/after payloads, and optional `_audit.actor` and `_audit.request_id` metadata when callers stamp it on the document. `getAuditJournalRows` is a super-admin-only callable for reading bounded slices of the journal from dashboard tooling.

## Coverage And Known Gaps

This first slice is intended for `hs-levante-admin-dev` only. Do not deploy it to production until the dev volume test has run and the team has agreed on retention and cost thresholds.

The trigger covers writes in the default Firestore database for the project where the function is deployed. It does not cover named databases such as `levante-tools-data`; that requires a separate trigger declaration.

`FirestoreAdmin.ImportDocuments` restore/import operations do not fire document write triggers. Anyone using bulk import or restore paths must follow the bulk restore runbook below.

Read-side auditing is not handled here. It should be covered separately by enabling Cloud Audit Data Access logs through infrastructure.

This PR does not stamp `_audit.request_id` or `_audit.actor` in the dashboard, Node helpers, or Python helpers. Those are cross-repo follow-ups.

## Row Schema

The BigQuery schema is checked in at `functions/levante-admin/scripts/audit/writes_journal_schema.json`.

The table is partitioned by `commit_timestamp` and clustered by `resource_path,operation`. `before_json` and `after_json` are nullable JSON columns. Payloads larger than 256 KiB are replaced with null JSON values and a stable `payload_sha256` so the journal keeps change-detection value without storing oversized documents.

## Query Endpoint

`getAuditJournalRows` is an HTTPS callable intended for super-admin dashboard tooling. It accepts optional filters for `startTime`, `endTime`, `resourcePath`, `resourcePathPrefix`, `operation`, `actor`, `requestId`, `payloadTruncated`, `includePayloads`, `limit`, and `pageToken`.

The callable defaults to the last 24 hours, caps `limit` at 100 rows, and returns payload columns as `null` unless `includePayloads` is explicitly `true`. Keep dashboard views metadata-first and require an explicit expand action before showing `before_json` or `after_json`, because those payloads may contain PII.

## Deploy

Create the dataset, table, and DLQ topic before deploying the function:

```bash
functions/levante-admin/scripts/audit/create_dataset.sh hs-levante-admin-dev
```

Deploy only the dev audit functions:

```bash
firebase deploy --only functions:levante-admin:journalWrite,functions:levante-admin:getAuditJournalRows --project hs-levante-admin-dev
```

Do not run a production deploy for this PR.

## IAM

Apply these grants once for the functions runtime service account in the target project. Keep the grants in the infra runbook; do not apply them from application code.

- `roles/bigquery.dataEditor` on dataset `levante_audit`.
- `roles/bigquery.jobUser` on project `hs-levante-admin-dev` so the query endpoint can run BigQuery jobs.
- `roles/pubsub.publisher` on topic `levante-audit-journal-dlq`.

No new Firestore role is required for the trigger. Eventarc/Functions v2 provides Firestore event delivery through the standard trigger wiring.

## Volume Test Plan

Deploy to `hs-levante-admin-dev` and let the trigger run for 3 to 7 days. Check the following before promoting to production:

- Daily row count and byte volume in `levante_audit.writes_journal`.
- Fraction of rows with `payload_truncated = true`.
- Any messages or publish failures for `levante-audit-journal-dlq`.
- P95 trigger latency in Cloud Logging.

Promotion criteria:

- Less than 1% truncation rate on real dev traffic.
- Zero sustained DLQ errors.
- Daily BigQuery ingest cost is within the budget agreed on by the team.

Table retention is intentionally left at the BigQuery default in this PR. Decide the partition expiration, such as 400 days, in the follow-up production PR after the audit retention policy is agreed on.

## Runbook: Bulk Restores

Firestore import and restore operations do not fire this trigger. Anyone running `FirestoreAdmin.ImportDocuments` must, in the same change ticket, run the future `scripts/audit/journal_backfill.ts` companion after the import completes. That script should read the imported document IDs and write synthetic journal rows with `actor = "import:<ticket-id>"`.

`journal_backfill.ts` is not implemented in this PR. Track it as a follow-up before relying on import/restore paths for complete audit history.

## Follow-Ups

- Cross-repo PRs to stamp `_audit.request_id` and `_audit.actor` in Web, Node, and Python Firestore client helpers.
- Second trigger for the `levante-tools-data` named database.
- Production deploy after the dev volume test.
- `journal_backfill.ts` for import and restore paths.
- Log-based alert on `google.firestore.admin.v1.FirestoreAdmin.ImportDocuments` in infra.
- Log-based alert on `severity=ERROR AND jsonPayload.component="audit.journalWrite"`.
- DLQ replay tool.
- Retention and partition-expiration decision.
