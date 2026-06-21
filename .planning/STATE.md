---
gsd_state_version: 1.0
milestone: v1.3
milestone_name: Salary Range Estimator
status: Awaiting next milestone
stopped_at: Completed 22-04-PLAN.md
last_updated: "2026-06-21T03:13:27.204Z"
last_activity: 2026-06-21 — Milestone v1.3 completed and archived
progress:
  total_phases: 6
  completed_phases: 6
  total_plans: 17
  completed_plans: 17
  percent: 100
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-21)

**Core value:** A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.
**Current focus:** Planning the next milestone

## Current Position

Phase: Milestone v1.3 complete
Plan: —
Status: Awaiting next milestone
Last activity: 2026-06-21 — Milestone v1.3 completed and archived

## Latest Milestone Summary

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
| 21 | Jobs Triage UX & Warning-Only Floor | Complete | UI-01..UI-06 |
| 22 | Product-Path QA & Safety Release | Complete | QA-01..QA-06 |

Next command: `/gsd-new-milestone`.

## Performance Metrics

**Velocity:**

- Total plans completed: 17
- Average duration: n/a
- Total execution time: 0 hours

**By phase:**

- Phase 17: 2/2 plans complete.
- Phase 18: 2/2 plans complete.
- Phase 19: 2/2 plans complete.
- Phase 20: 2/2 plans complete.
- Phase 21: 5/5 plans complete.
- Phase 22: 4/4 plans complete.

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
- [Phase 21]: Python floorComparison parity mirrors the TypeScript contract while using only numeric profile floor data and structured compensation ranges.
- [Phase 21]: Jobs list compensation scan columns remain display-only: no sortable/filterable column config, route search fields, or API query fields.
- [Phase 21]: Market cells expose compensationSummary.market confidenceBand and sourceCount directly in the Jobs list scan.
- [Phase 21]: 21-04 kept compensation evidence warning-only and out of Apply concerns, readiness, ranking, filtering, and dispatch controls. — Plan 21-04 implemented the drawer-only audit surface and boundary tests without modifying filters, ranking, or apply controls.
- [Phase 21]: 21-04 placed the Jobs drawer compensation audit immediately after JobAuditTriage and before Description. — The UI spec required the compensation audit to be the first source-backed evidence section after triage.
- [Phase 21]: 21-05 closed Jobs compensation triage with synthetic Playwright/browser QA and explicit human approval, without using real ~/.jobhunter data or worker-backed apply jobs. — The Phase 21 validation contract requires product-path evidence while preserving the local-first and no-apply safety boundary.
- [Phase 21]: 21-05 verified compensation warnings remain absent from Apply concerns, prerequisites, blockers, fit score, ranking controls, filters, and dispatch/apply controls. — The milestone requires compensation facts to remain warning-only in v1.3.
- [Phase ?]: [Phase 22]: 22-01 established matrix-first release QA with QA22-FX fixture IDs mapped to requirements, owner layers, commands, threat refs, and final verification evidence.
- [Phase ?]: [Phase 22]: 22-01 kept release validation synthetic/manual-only and explicitly excluded auto-apply, browser submission, mailbox scanning, real material regeneration, destructive data actions, real external scraping, and worker-backed apply jobs.
- [Phase 22]: 22-02 treats sub-threshold reported compensation samples as insufficient evidence rather than precise ranges. — Task 1 RED showed low sample count still emitted an estimated range at the minimum confidence threshold.
- [Phase 22]: 22-02 lets trimodal tier fallback use target-company tier context while keeping the estimate confidence-limited. — Task 1 RED showed tier-role fallback was degraded to insufficient evidence because same-company scoring overrode tier context.
- [Phase 22]: 22-03 renders source-conflict market warning codes inside the Jobs drawer Compensation audit while keeping them out of triage, Apply controls, sorting, and filtering.
- [Phase 22]: 22-04 completed the release matrix with all rows green and no skipped or blocked release gate commands.

### Pending Todos

- Define the next milestone requirements and roadmap.

### Blockers/Concerns

- No active blocker.
- Main risks to keep visible: UI false precision, audit trail loss, source legality, mobile layout crowding, stale projection display, and sensitive data leakage.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Licensed sources | Levels.fyi and Glassdoor enabled integrations | Future milestone unless permitted access is confirmed | 2026-06-19 |
| Geography | Non-European public baselines | Out of active product direction; JobHunter is Europe-first | 2026-06-19 |
| Product behavior | Salary-based ranking, filtering, hard blockers, and negotiation anchors | Future milestone | 2026-06-19 |
| Corrections | User correction and refresh loop for salary facts | Future milestone unless v1.3 planning reopens it | 2026-06-19 |
| Phase 21 P02 | 3m25s | 2 tasks | 2 files |
| Phase 21 P03 | 17m | 2 tasks | 5 files |
| Phase 21 P04 | 10m03s | 3 tasks | 6 files |
| Phase 21 P05 | 32m | 2 tasks | 3 files |
| Phase 22 P01 | 6min | 2 tasks | 2 files |
| Phase 22 P02 | 5min | 2 tasks | 5 files |
| Phase 22 P03 | 6min | 2 tasks | 6 files |
| Phase 22 P04 | 5min | 2 tasks | 4 files |
| v1.3 closeout | non-blocking tech debt | provider import authorization remains an operator-policy control; Phase 17/18 validation files remain plan-style artifacts | 2026-06-21 |

## Session Continuity

Last session: 2026-06-21T02:44:27Z
Stopped at: Completed 22-04-PLAN.md
Latest phase completed: Phase 22 - Product-Path QA & Safety Release
Latest milestone completed: v1.3 - Salary Range Estimator
Resume file: None

## Operator Next Steps

- Start the next milestone with /gsd-new-milestone
