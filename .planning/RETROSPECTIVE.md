# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.3 — Salary Range Estimator

**Shipped:** 2026-06-21
**Phases:** 6 | **Plans:** 17

### What Was Built

- Added a read-only compensation source policy surface for public, local, licensed, unavailable, disabled, and gated sources.
- Persisted posted compensation facts with parse state, source excerpt, normalized range fields, confidence, warnings, and raw salary fallback.
- Added company-role reported market estimates with exact, adjacent-role, trimodal-tier, stale-source, source-conflict, low-sample, and insufficient-evidence states.
- Propagated compensation summary/audit data through canonical projections, additive API fields, Python/TypeScript parity, and safe marker-only SSE invalidation.
- Added Jobs list and drawer compensation audit UI that keeps salary evidence inspectable but warning-only.
- Closed the release with a Phase 22 matrix mapping synthetic fixtures, requirements, owner layers, commands, threat refs, and prohibited-action evidence.

### What Worked

- Treating compensation as persisted audit data first prevented React-only salary derivation and kept every displayed claim source-backed.
- The warning-only invariant stayed clear across backend, projection, API, UI, and Playwright tests.
- Phase 22's matrix-first release gate made scattered parser, estimator, projection, UI, and e2e evidence reviewable as one product path.

### What Was Inefficient

- `REQUIREMENTS.md` still had Phase 20 rows marked pending after Phase 20 verification had passed, so closeout needed bookkeeping reconciliation.
- Older Phase 17 and 18 validation artifacts remained plan-style files, which made Nyquist metadata look weaker than the actual verification evidence.
- The milestone archive helper generated one noisy accomplishment line and still needed manual ROADMAP, PROJECT, STATE, and retrospective review.

### Patterns Established

- Compensation features need a single explicit warning-only invariant that is tested at every layer touched by the feature.
- Release matrices should name fixture IDs, requirement IDs, owner layers, exact commands, and prohibited actions before final verification.
- Provider-labeled local data can be useful for synthetic QA and permitted imports, but real-row authorization needs to stay visible as an operator-policy control.

### Key Lessons

1. Requirement checkboxes need to be reconciled immediately after phase verification; stale pending rows create false closeout gaps.
2. Synthetic product-path QA is strong enough for safety release when the prohibited-action watcher is explicit and covers apply, material, mailbox, destructive, profile, and RPC requests.
3. Audit milestones should distinguish blocker gaps from non-blocking operational controls so useful residual risk does not stop shipment.

### Cost Observations

- Model mix: not measured.
- Sessions: multiple phase execution, review, QA, audit, and closeout passes.
- Notable: the final integration checker found no broken flow, but it did surface the provider-labeled local import authorization boundary as useful tech debt.

---

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
| v1.3 | Multiple | 6 | Added matrix-first release QA and cross-phase compensation safety audit |
| v1.2 | Multiple | 5 | Added product-path invariant checking before milestone archive |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-Dep Additions |
|-----------|-------|----------|-------------------|
| v1.3 | Targeted Python, API, contracts, web unit/a11y, web build, Playwright, QA, UI review, integration check | Full source-policy -> posted facts -> market estimate -> projection/API/SSE -> Jobs UI product path covered | 0 |
| v1.2 | Targeted unit, type, build, and Playwright handoff checks | Route-boundary product path covered | 0 |

### Top Lessons (Verified Across Milestones)

1. Completion has to be checked across `STATE.md`, `ROADMAP.md`, requirements, verification metadata, and actual product paths.
2. Audit UI work is only done when the displayed claim has a source of truth and the navigation path preserves the entity under review.
3. Safety-sensitive product data should ship as inspectable audit evidence before it is allowed to influence ranking, filtering, readiness, blockers, or dispatch.
