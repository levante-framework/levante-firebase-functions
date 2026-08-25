#!/usr/bin/env bash
set -euo pipefail

PROJECT="${1:-hs-levante-admin-dev}"
DATASET="levante_audit"
LOCATION="US"
TABLE="writes_journal"
DLQ_TOPIC="levante-audit-journal-dlq"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! bq show --format=none "${PROJECT}:${DATASET}" >/dev/null 2>&1; then
  bq --location="$LOCATION" mk --dataset \
    --description "LEVANTE Firestore write journal and audit tables" \
    "${PROJECT}:${DATASET}"
fi

if ! bq show --format=none "${PROJECT}:${DATASET}.${TABLE}" >/dev/null 2>&1; then
  bq mk --table \
    --time_partitioning_field commit_timestamp \
    --time_partitioning_type DAY \
    --clustering_fields resource_path,operation \
    --description "Append-only journal of Firestore writes" \
    "${PROJECT}:${DATASET}.${TABLE}" \
    "${SCRIPT_DIR}/writes_journal_schema.json"
fi

if ! gcloud pubsub topics describe "$DLQ_TOPIC" \
  --project "$PROJECT" >/dev/null 2>&1; then
  gcloud pubsub topics create "$DLQ_TOPIC" \
    --project "$PROJECT"
fi
