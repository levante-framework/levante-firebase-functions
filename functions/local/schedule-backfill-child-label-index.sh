#!/usr/bin/env bash
# Wait until 05:00 Europe/London on 9 Sep 2026, then apply the childLabelIndex
# backfill against prod. Re-reads live Firestore (does not use the dry-run CSV).
#
# From functions/local:
#   chmod +x schedule-backfill-child-label-index.sh
#   nohup ./schedule-backfill-child-label-index.sh > backfill-apply.log 2>&1 &
#   echo $!
#
# Cancel before 05:00: kill that pid (or pkill -f schedule-backfill-child-label-index).

set -euo pipefail

cd "$(dirname "$0")"

RUN_AT="2026-09-09 05:00:00"
TZ_NAME="Europe/London"
ENV_FILE="../../.env"
OUTPUT_FILE="backfill-child-label-index-prod-apply.csv"

START=$(TZ="$TZ_NAME" date -j -f '%Y-%m-%d %H:%M:%S' "$RUN_AT" +%s)
NOW=$(date +%s)
DELAY=$((START - NOW))

if (( DELAY <= 0 )); then
  echo "Target time $RUN_AT $TZ_NAME is in the past (DELAY=${DELAY}s). Exiting." >&2
  exit 1
fi

HOURS=$((DELAY / 3600))
MINS=$(((DELAY % 3600) / 60))
echo "$(date '+%Y-%m-%d %H:%M:%S %Z'): sleeping ${DELAY}s (${HOURS}h ${MINS}m) until ${RUN_AT} ${TZ_NAME}"
echo "Will then run: npm run backfill-child-label-index -- --env prod --env-file ${ENV_FILE} --apply --outputFile ${OUTPUT_FILE}"

if command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i sleep "$DELAY"
else
  sleep "$DELAY"
fi

echo "$(date '+%Y-%m-%d %H:%M:%S %Z'): starting apply"
npm run backfill-child-label-index -- --env prod --env-file "$ENV_FILE" --apply --outputFile "$OUTPUT_FILE"
echo "$(date '+%Y-%m-%d %H:%M:%S %Z'): finished with exit $?"
