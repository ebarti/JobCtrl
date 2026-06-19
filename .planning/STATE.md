---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Salary Range Estimator
status: planning
last_updated: "2026-06-19T09:39:10Z"
last_activity: 2026-06-19
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-19)

**Core value:** A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.
**Current focus:** Phase 17 - Source Registry & Access Policy is ready to plan.

## Current Position

Phase: 17 of 22 (1 of 6 in v1.3)
Plan: TBD
Status: Ready to plan
Last activity: 2026-06-19 - v1.3 roadmap created with 6 phases and 35/35 requirements mapped.
Progress: [----------] 0%

## Active Milestone Summary

Milestone v1.3 makes compensation facts inspectable in Jobs triage by combining posted salary extraction with Europe-only public market salary baselines. The milestone keeps salary evidence audit-first and warning-only: confidence, source gaps, unknowns, and profile-floor comparisons must be visible, but v1.3 must not silently rank, filter, block, or apply based on salary facts or market estimates.

Scoped source strategy:

- Public v1.3 baselines: Eurostat Structure of Earnings Survey, ESCO occupation mapping, and Spain INE Wage Structure Survey.
- Levels.fyi and Glassdoor: disabled/unavailable seams only unless explicit permitted access exists.
- Profile-floor comparison: warning-only in v1.3.

## Roadmap

| Phase | Name | Status | Requirements |
|-------|------|--------|--------------|
| 17 | Source Registry & Access Policy | Not started | SRC-01, SRC-04, SRC-05, SRC-06 |
| 18 | Posted Compensation Facts | Not started | COMP-01..COMP-05 |
| 19 | Europe Public Market Estimates | Not started | SRC-02, SRC-03, EST-01..EST-04, EST-06, EST-07 |
| 20 | Canonical Read Model & Realtime API | Not started | EST-05, API-01..API-05 |
| 21 | Jobs Triage UX & Warning-Only Floor | Not started | UI-01..UI-06 |
| 22 | Product-Path QA & Safety Release | Not started | QA-01..QA-06 |

Next command: `/gsd-plan-phase 17`.

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: n/a
- Total execution time: 0 hours

**By phase:** none yet.

## Accumulated Context

### Decisions

- v1.3 starts at Phase 17 because v1.2 ended at Phase 16.
- v1.3 uses Europe-only public baselines: Eurostat SES, ESCO, and Spain INE.
- Levels.fyi and Glassdoor remain disabled unless permitted access exists; no unauthorized scraping, fetching, caching, or display.
- Profile-floor comparison is warning-only and must not affect ranking, filtering, apply readiness, blockers, or auto-apply behavior.

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 19 planning must define public-data import/API strategy, statistical thresholds, remote-Europe assumptions, freshness windows, and confidence buckets.
- Main risks to keep visible: source legality, false precision, lossy normalization, projection drift, and sensitive data leakage.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Licensed sources | Levels.fyi and Glassdoor enabled integrations | Future milestone unless permitted access is confirmed | 2026-06-19 |
| Geography | Non-European public baselines | Out of active product direction; JobHunter is Europe-first | 2026-06-19 |
| Product behavior | Salary-based ranking, filtering, hard blockers, and negotiation anchors | Future milestone | 2026-06-19 |
| Corrections | User correction and refresh loop for salary facts | Future milestone unless v1.3 planning reopens it | 2026-06-19 |

## Session Continuity

Last session: 2026-06-19
Stopped at: v1.3 roadmap created
Latest phase completed: Phase 16 - Product-Path QA + Documentation (v1.2)
Resume file: None
