---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Salary Range Estimator
status: active
last_updated: "2026-06-19T16:03:26Z"
last_activity: 2026-06-19
progress:
  total_phases: 6
  completed_phases: 3
  total_plans: 6
  completed_plans: 6
  percent: 50
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-19)

**Core value:** A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.
**Current focus:** Phase 20 - Canonical Read Model & Realtime API is ready to plan.

## Current Position

Phase: 20 of 22 (4 of 6 in v1.3)
Plan: TBD
Status: Phase 19 complete; Phase 20 ready to plan
Last activity: 2026-06-19 - Phase 19 delivered deterministic Europe public market estimates and a read-only inspection API.
Progress: [#####-----] 50%

## Active Milestone Summary

Milestone v1.3 makes compensation facts inspectable in Jobs triage by combining posted salary extraction with Europe-only public market salary baselines. The milestone keeps salary evidence audit-first and warning-only: confidence, source gaps, unknowns, and profile-floor comparisons must be visible, but v1.3 must not silently rank, filter, block, or apply based on salary facts or market estimates.

Scoped source strategy:

- Public v1.3 baselines: Eurostat Structure of Earnings Survey, ESCO occupation mapping, and Spain INE Wage Structure Survey.
- Levels.fyi and Glassdoor: disabled/unavailable seams only unless explicit permitted access exists.
- Profile-floor comparison: warning-only in v1.3.

## Roadmap

| Phase | Name | Status | Requirements |
|-------|------|--------|--------------|
| 17 | Source Registry & Access Policy | Complete | SRC-01, SRC-04, SRC-05, SRC-06 |
| 18 | Posted Compensation Facts | Complete | COMP-01..COMP-05 |
| 19 | Europe Public Market Estimates | Complete | SRC-02, SRC-03, EST-01..EST-04, EST-06, EST-07 |
| 20 | Canonical Read Model & Realtime API | Not started | EST-05, API-01..API-05 |
| 21 | Jobs Triage UX & Warning-Only Floor | Not started | UI-01..UI-06 |
| 22 | Product-Path QA & Safety Release | Not started | QA-01..QA-06 |

Next command: `/gsd-plan-phase 20`.

## Performance Metrics

**Velocity:**
- Total plans completed: 6
- Average duration: n/a
- Total execution time: 0 hours

**By phase:**
- Phase 17: 2/2 plans complete.
- Phase 18: 2/2 plans complete.
- Phase 19: 2/2 plans complete.

## Accumulated Context

### Decisions

- v1.3 starts at Phase 17 because v1.2 ended at Phase 16.
- v1.3 uses Europe-only public baselines: Eurostat SES, ESCO, and Spain INE.
- Levels.fyi and Glassdoor remain disabled unless permitted access exists; no unauthorized scraping, fetching, caching, or display.
- Profile-floor comparison is warning-only and must not affect ranking, filtering, apply readiness, blockers, or auto-apply behavior.
- Phase 17 exposes compensation source policy through a deterministic metadata-only API and Settings panel; no provider network path was added.
- Phase 18 persists posted compensation facts in `job_posted_compensation_facts`, keeps `jobs.salary` as raw fallback, and exposes a read-only inspection API without changing job list/detail compensation summaries, ranking, filtering, scoring, apply readiness, or apply dispatch.
- Phase 19 persists deterministic Europe public market estimates in `job_market_compensation_estimates`, canonicalizes safe source metadata on stale reads, keeps ESCO as occupation mapping only, and exposes a read-only inspection API without changing projections, Jobs UI, ranking, filtering, scoring, apply readiness, or apply dispatch.

### Pending Todos

- Phase 20 must project posted facts and market estimates into canonical job list/detail read models with Python/TypeScript parity and safe SSE invalidation payloads.

### Blockers/Concerns

- Phase 20 planning must keep posted facts and market estimates separate in every read-model/API contract while preserving raw `JobSummary.salary` compatibility.
- Main risks to keep visible: projection drift, source legality, false precision, lossy normalization, stale-row sanitization, and sensitive data leakage.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Licensed sources | Levels.fyi and Glassdoor enabled integrations | Future milestone unless permitted access is confirmed | 2026-06-19 |
| Geography | Non-European public baselines | Out of active product direction; JobHunter is Europe-first | 2026-06-19 |
| Product behavior | Salary-based ranking, filtering, hard blockers, and negotiation anchors | Future milestone | 2026-06-19 |
| Corrections | User correction and refresh loop for salary facts | Future milestone unless v1.3 planning reopens it | 2026-06-19 |

## Session Continuity

Last session: 2026-06-19
Stopped at: Phase 19 complete and ready for stacked PR
Latest phase completed: Phase 19 - Europe Public Market Estimates
Resume file: None
