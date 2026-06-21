# Milestones

## v1.3 Salary Range Estimator (Shipped: 2026-06-21)

**Delivered:** Inspectable posted compensation facts, reported company-role market estimates, projection-backed compensation audit data, and warning-only Jobs triage UI with synthetic product-path release QA.

**Phases completed:** 17-22 (17 plans total, 16 tasks recorded)

**Key accomplishments:**

- Added a read-only source policy surface that exposes compensation-source availability, licensing, disabled reasons, and safety boundaries without adding provider fetch/scrape/cache paths.
- Persisted structured posted compensation facts with parse state, source excerpt, normalized range fields, confidence, warnings, and legacy raw salary fallback.
- Added company-role reported market estimates with exact/adjacent/tier fallback states, confidence factors, source conflict handling, and explicit insufficient-evidence states.
- Propagated compensation summary/audit data through canonical projections, API contracts, Python/TypeScript parity, and safe SSE invalidation.
- Added Jobs list and drawer compensation audit UI that keeps posted salary, market estimates, warning counts, floor comparisons, and source trails visible but display-only.
- Closed the milestone with matrix-first release QA, code review, UI review, QA validation, and cross-phase integration validation.

**Known deferred items at close:** 3 non-blocking tech-debt items; see `.planning/milestones/v1.3-MILESTONE-AUDIT.md`.

**What's next:** Define the next milestone with `$gsd-new-milestone`.

---

## v1.2 Apply Review Audit UX - Drawer + Resume Pins (Shipped: 2026-06-13)

**Phases completed:** 5 phases, 10 plans, 0 tasks

**Key accomplishments:**

- Folded the remaining v1.1 cleanup into Phase 12, removed unused `lucide-react`, and normalized the Tailwind 4/shadcn token baseline.
- Added a shared `ApplyAudit` readiness, blocker, eligibility, and source-fact contract across `JobDetail` and `ApplyReviewQueueItem`.
- Reframed the Jobs drawer around ranking rationale, readiness, blockers, eligibility concerns, and same-job handoff to Apply Review.
- Centered Apply Review on the rendered resume/material surface with source-backed line and claim inspection.
- Verified the user product path with targeted unit, type, build, and Playwright checks, including the repaired Jobs drawer to Apply Review same-job handoff.

---
