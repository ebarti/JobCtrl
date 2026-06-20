---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Salary Range Estimator
status: active
last_updated: "2026-06-20T08:46:30Z"
last_activity: 2026-06-20
progress:
  total_phases: 6
  completed_phases: 4
  total_plans: 9
  completed_plans: 8
  percent: 67
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-19)

**Core value:** A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.
**Current focus:** Phase 21 - Jobs Triage Compensation Rendering is in progress.

## Current Position

Phase: 21 of 22 (5 of 6 in v1.3)
Plan: 21-01 Compensation Rendering In Jobs And Apply Review
Status: Phase 21 rendering slice verified; profile-floor comparison remains pending
Last activity: 2026-06-20 - Phase 21 rendering branch verified compensation range/confidence rendering in Jobs table, expanded Jobs detail, and Apply Review with focused tests and browser QA.
Progress: [#######---] 67%

## Active Milestone Summary

Milestone v1.3 makes compensation facts inspectable in Jobs triage by combining posted salary extraction with company-role reported compensation estimates. The milestone keeps salary evidence audit-first and warning-only: confidence, source gaps, unknowns, and profile-floor comparisons must be visible, but v1.3 must not silently rank, filter, block, or apply based on salary facts or market estimates.

Scoped source strategy:

- Reported v1.3 benchmark sources: Levels.fyi, Glassdoor, and manual local reported-compensation imports keyed by company and role.
- Levels.fyi and Glassdoor automated provider access remains gated by explicit permitted access; local imports must use permitted/exported rows.
- Profile-floor comparison: warning-only in v1.3.

## Roadmap

| Phase | Name | Status | Requirements |
|-------|------|--------|--------------|
| 17 | Source Registry & Access Policy | Complete | SRC-01, SRC-04, SRC-05, SRC-06 |
| 18 | Posted Compensation Facts | Complete | COMP-01..COMP-05 |
| 19 | Company-Role Reported Market Estimates | Complete | SRC-02, SRC-03, EST-01..EST-04, EST-06, EST-07 |
| 20 | Canonical Read Model & Realtime API | Complete | EST-05, API-01..API-05 |
| 21 | Jobs Triage UX & Warning-Only Floor | Active | UI-01..UI-06 |
| 22 | Product-Path QA & Safety Release | Not started | QA-01..QA-06 |

Next command: `/gsd-plan-phase 21`.

## Performance Metrics

**Velocity:**
- Total plans completed: 8
- Average duration: n/a
- Total execution time: 0 hours

**By phase:**
- Phase 17: 2/2 plans complete.
- Phase 18: 2/2 plans complete.
- Phase 19: 2/2 plans complete.
- Phase 20: 2/2 plans complete.
- Phase 21: 0/1 plans complete.

## Accumulated Context

### Decisions

- v1.3 starts at Phase 17 because v1.2 ended at Phase 16.
- v1.3 uses reported company-role compensation observations from Levels.fyi, Glassdoor, and manual imports; it does not estimate from title/location aggregates alone.
- Levels.fyi and Glassdoor automated access remains disabled unless permitted access exists; no unauthorized scraping, fetching, caching, or display.
- Profile-floor comparison is warning-only and must not affect ranking, filtering, apply readiness, blockers, or auto-apply behavior.
- Phase 17 exposes compensation source policy through a deterministic metadata-only API and Settings panel; no provider network path was added.
- Phase 18 persists posted compensation facts in `job_posted_compensation_facts`, keeps `jobs.salary` as raw fallback, and exposes a read-only inspection API without changing job list/detail compensation summaries, ranking, filtering, scoring, apply readiness, or apply dispatch.
- Phase 19 persists deterministic company-role reported compensation estimates in `job_market_compensation_estimates`, canonicalizes safe source metadata on stale reads, supports the temporary `jobhunter compensation-refresh` import trigger, and exposes a read-only inspection API without changing Jobs UI, ranking, filtering, scoring, apply readiness, or apply dispatch.
- Phase 20 projects compensation summary/audit JSON from canonical posted-fact and market-estimate rows, exposes additive job list/detail API fields, and emits safe `CompensationFactsUpdated` events that invalidate Operations job list/detail reads without including source text, private preferences, local paths, credentials, or unsafe source payloads.

### Pending Todos

- Open the Phase 21 rendering PR on top of Phase 20.
- Plan or execute the remaining profile-floor warning comparison requirements (UI-03/UI-04) after the persisted floor source is defined.

### Blockers/Concerns

- Phase 21 must render compensation evidence without salary data changing ranking, filtering, scoring, apply readiness, blockers, or apply dispatch.
- Main risks to keep visible: UI false precision, audit trail loss, source legality, mobile layout crowding, stale projection display, and sensitive data leakage.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Licensed sources | Levels.fyi and Glassdoor enabled integrations | Future milestone unless permitted access is confirmed | 2026-06-19 |
| Geography | Non-European public baselines | Out of active product direction; JobHunter is Europe-first | 2026-06-19 |
| Product behavior | Salary-based ranking, filtering, hard blockers, and negotiation anchors | Future milestone | 2026-06-19 |
| Corrections | User correction and refresh loop for salary facts | Future milestone unless v1.3 planning reopens it | 2026-06-19 |

## Session Continuity

Last session: 2026-06-19
Stopped at: Phase 20 complete and ready for stacked PR
Latest phase completed: Phase 20 - Canonical Read Model & Realtime API
Resume file: None
