---
phase: 21-jobs-triage-compensation-rendering
type: context
status: active
depends_on:
  - 20-canonical-read-model-realtime-api
requirements:
  - EST-03
  - EST-05
  - UI-01
  - UI-02
  - UI-05
  - UI-06
---

# Phase 21 Context: Jobs Triage Compensation Rendering

## Goal

Users can scan and inspect persisted compensation evidence in the Jobs table, expanded Jobs detail view, and Apply Review without salary data changing ranking, filtering, apply readiness, blockers, or dispatch.

## User Value

Compensation is useful only when it is tied to the current role at the current company and carries its uncertainty. The UI must expose the posted range, reported company-role market range, and statistical confidence where the user is already deciding whether a job is worth attention.

## Product Invariants

1. Display data comes from Phase 20 projection-backed contracts, not React parsing of salary text.
2. Posted salary and reported company-role market estimates remain separate in every UI surface.
3. Statistical confidence is visible with the range: confidence band, confidence score when projected, source count, sample count, and warning count where available.
4. Missing posted salary, not-requested market estimates, insufficient evidence, and unsupported states are explicit; blank salary cells are not acceptable.
5. Compensation remains warning-only in this slice. It must not affect fit score, sort order, filters, apply readiness, blockers, Apply Review state, or apply dispatch.
6. The UI must avoid leaking raw provider pages, credentials, private payloads, local paths, or user compensation preferences.

## Existing Inputs

- `JobSummary.compensationSummary` is available on Jobs list/detail payloads.
- `JobDetail.compensationAudit` is available on expanded Jobs detail payloads.
- Apply Review queue currently lacks compensation data and needs the compact summary from `job_list_projections`.
- Market audit data already carries confidence score, source count, sample count, confidence factors, source labels, warnings, and reasons.

## In Scope

- Add compact compensation summary rendering to the Jobs table.
- Add a dedicated compensation audit section to the expanded Jobs detail drawer.
- Add compact compensation rendering to Apply Review.
- Add additive Apply Review queue contract/API mapping for `compensationSummary`.
- Add focused UI/API regressions and documentation.

## Out of Scope

- Profile-floor comparison. It remains a Phase 21/22 follow-up until a persisted floor source exists.
- External salary provider fetching or scraping.
- Salary-based ranking, filtering, scoring, readiness, blockers, or automatic apply behavior.
- Any removal of `JobSummary.salary` compatibility.

## Done Means

- Jobs table, expanded Jobs detail, and Apply Review show compensation range plus statistical confidence from persisted compensation contracts.
- Apply Review queue includes `compensationSummary` without extra detail fetches.
- Tests cover the three rendering surfaces and Apply Review queue mapping.
- GSD state, docs, and verification notes are current.
