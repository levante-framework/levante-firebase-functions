# Data Contract Change Checklist

Use this checklist for any PR that can alter data consumed downstream by Redivis or `levante-pilots`.

## 1) Contract scope

- Confirm whether this PR changes:
  - Firestore path patterns
  - document ID strategy
  - uniqueness/cardinality assumptions
  - required field names/types
- Explicitly call out impacted entities: `surveyResponses`, `assignments`, `runs`, `trials`.

## 2) Required validation commands

- `npm run contract:check`
- `npx vitest run "__tests__/save-survey-results.contract.test.ts"`
- `Rscript schema_tools/pipeline-contract/validate_fixture_contracts.R` (in `levante-support`)
- `Rscript schema_tools/pipeline-contract/validate_stage02_contracts.R` (in `levante-support`)
- `Rscript schema_tools/pipeline-contract/validate_stage03_contracts.R` (in `levante-support`)
- `Rscript schema_tools/pipeline-contract/validate_stage03_explore_contracts.R` (in `levante-support`)
- `Rscript schema_tools/pipeline-contract/validate_stage04_papers_contracts.R` (in `levante-support`)

Attach command output or CI links in the PR.

## 3) Key/cardinality safety

- Confirm `users/{uid}/surveyResponses/{administrationId}` remains one document per `user+administration`.
- Confirm no changes introduce key collisions or duplicate semantic rows.
- If key semantics changed, provide migration/backfill plan and rollback plan.

## 4) Rollout strategy

- Describe compatibility behavior for existing data.
- Note if checks run in warn-mode and when they become blocking.

## 5) Evidence links

- Link `Pipeline Contract Compatibility` workflow run.
- Link migration ticket/PR (if required).
