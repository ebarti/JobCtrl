---
phase: 20-canonical-read-model-realtime-api
type: context
status: active
depends_on:
  - 19-europe-public-market-estimates
requirements:
  - EST-05
  - API-01
  - API-02
  - API-03
  - API-04
  - API-05
---

# Phase 20 Context: Canonical Read Model & Realtime API

## Goal

Users and API consumers receive compensation summaries and audit details from canonical persisted rows, with parity-safe projections and safe event payloads.

## User Value

The Jobs list and detail API should stop forcing consumers to call one-off compensation endpoints or parse the legacy raw salary string. A job response should carry a compact compensation summary and an inspectable audit object sourced from canonical posted-fact and Europe public-market estimate rows.

## Product Invariants

1. `JobSummary.salary` remains the raw discovery string for compatibility.
2. Structured compensation data is additive and preferred over raw salary where available.
3. Posted compensation facts and public market estimates remain separate in contracts and projection JSON.
4. The read model never parses salary text at API read time or in React.
5. Compensation facts are warning/audit data only in v1.3; no ranking, filtering, apply readiness, hard blocker, or auto-apply behavior changes.
6. Event payloads contain only job id, changed section, state, and timestamps. They must not include profile salary preferences, source excerpts, raw benchmark pages, credentials, local paths, or private provider payloads.

## Existing Inputs

- Posted facts live in `job_posted_compensation_facts` from Phase 18.
- Europe public market estimates live in `job_market_compensation_estimates` from Phase 19.
- `jobs.salary` remains the raw fallback.
- Job list/detail responses are served from `job_list_projections` and `job_detail_projections`.
- Python and TypeScript projection builders both materialize projection tables.
- The frontend Operations layer invalidates query keys from `job_events` through SSE.

## In Scope

- Add projection columns for compensation summary and audit JSON.
- Build matching compensation projection JSON in Python and TypeScript.
- Add shared contract types for `compensationSummary` and `compensationAudit`.
- Map additive fields onto job list and job detail read models.
- Add a safe typed compensation update domain event and frontend invalidation route.
- Add parity, API, and event-safety tests.
- Update existing docs that own API/read-model/QA behavior.

## Out of Scope

- Jobs list or drawer visual rendering. Phase 21 owns UI composition.
- Profile-floor comparison. Phase 21 owns warning-only floor display.
- External provider scraping, licensed-source access, or live market data fetching.
- Any change to fit score, ranking, filtering, apply readiness, blockers, or apply dispatch.
- Removing raw `JobSummary.salary` compatibility.

## Done Means

- Job list/detail responses include additive structured compensation fields sourced from projections.
- Python and TypeScript projection builders produce equivalent compensation JSON for the same fixture data.
- Compensation write events invalidate job list/detail through Operations/SSE without unsafe payload data.
- Relevant tests and docs pass/update, and the stack PR is opened on top of Phase 19.
