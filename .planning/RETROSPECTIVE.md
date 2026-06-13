# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.2 — Apply Review Audit UX - Drawer + Resume Pins

**Shipped:** 2026-06-13
**Phases:** 5 | **Plans:** 10

### What Was Built

- Folded the remaining v1.1 cleanup into Phase 12 and removed obsolete visual-system remnants, including unused `lucide-react`.
- Added a shared `ApplyAudit` contract so Jobs drawer and Apply Review consume the same readiness, blocker, eligibility, and source-fact data.
- Reframed the Jobs drawer around rank rationale, readiness, hard blockers, eligibility concerns, and handoff to Apply Review.
- Centered Apply Review on rendered resume/material inspection with source-backed line and claim audit details.
- Repaired the Jobs drawer to Apply Review handoff so it preserves the selected job through `/apply-review?jobKey=<jobKey>`.

### What Worked

- Starting with a shared API/read-model contract prevented Jobs drawer and Apply Review from inventing separate readiness logic.
- Keeping Jobs responsible for ranking and Apply Review responsible for generated-material proof kept the UX split clear.
- Product-path QA caught the difference between independently working surfaces and a truly continuous cross-surface workflow.

### What Was Inefficient

- The milestone initially appeared complete while the Jobs drawer handoff lost selected-job identity at the route boundary.
- Verification frontmatter drift (`pass` / body-only status) made `stats.json` underreport completion until normalized.
- The milestone archive command captured base artifacts but still required manual PROJECT, ROADMAP, retrospective, and phase-directory cleanup.

### Patterns Established

- Cross-view audit handoffs should carry the owning entity identity in route search state and have a route-level regression.
- Auditability features need source-of-truth checks across source data, API/read model, route state, and UI rendering.
- Milestone audits should treat "two surfaces work independently" as insufficient when the user workflow crosses between them.

### Key Lessons

1. Product invariants should be stated before accepting milestone completion; here, the invariant was same-job continuity from Jobs drawer to Apply Review.
2. GSD status surfaces need metadata normalization before archive, otherwise completed work can still look partially executed.
3. Playwright product-path checks are most valuable when they start from the user's entry point, not only the destination page.

### Cost Observations

- Model mix: not measured.
- Sessions: multiple closeout and correction passes.
- Notable: a lightweight integration-checker pass found the route-boundary issue that file-level completion checks missed.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
|-----------|----------|--------|------------|
| v1.2 | Multiple | 5 | Added product-path invariant checking before milestone archive |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.2 | Targeted unit, type, build, and Playwright handoff checks | Route-boundary product path covered | 0 |

### Top Lessons (Verified Across Milestones)

1. Completion has to be checked across `STATE.md`, `ROADMAP.md`, requirements, verification metadata, and actual product paths.
2. Audit UI work is only done when the displayed claim has a source of truth and the navigation path preserves the entity under review.
