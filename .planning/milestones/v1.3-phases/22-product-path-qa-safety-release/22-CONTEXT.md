# Phase 22: Product-Path QA & Safety Release - Context

**Gathered:** 2026-06-21
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 22 is the v1.3 release QA and safety phase for compensation behavior. It proves the full product path with synthetic jobs and synthetic/manual reported-compensation observations, then records release evidence that posted compensation, market estimates, source quality, and profile-floor warnings remain inspectable without changing scoring, ranking, filtering, apply readiness, Apply Review handoff, auto-apply behavior, browser submission, mailbox scanning, material regeneration, destructive profile/database actions, real external scraping, or worker-backed apply jobs.

This phase should add or extend deterministic tests, fixtures, and QA documentation where gaps remain. It should not add new compensation product features, new provider access, new salary-based ranking/filtering, new apply gates, new profile preference editing, or new correction workflows.

</domain>

<decisions>
## Implementation Decisions

### Fixture Matrix
- Cover every QA-01 scenario in one traceable release matrix: below-floor posted salary, above-floor posted salary, missing posted salary, unparseable salary, broad posted range, OTE/equity ambiguity, exact company-role reported compensation, adjacent-role fallback, trimodal tier fallback, stale source, source conflict, low-confidence estimate, and insufficient evidence.
- Use synthetic jobs plus synthetic/manual reported compensation observations only. Automated provider seams such as Levels.fyi and Glassdoor unavailable states must be simulated or fixture-backed, not exercised against live providers.
- Map each fixture case to the owning layer that proves it: parser confidence, market confidence, canonical API/projection data, Jobs list rendering, Jobs drawer audit rendering, or product-path safety boundary.
- Keep the human-verifier path usable from the existing Jobs compensation triage smoke: `/jobs` seeded data should demonstrate the visible states without requiring real `~/.jobhunter` data.

### Automation Split
- Prefer automated API, projection, worker-domain, and web tests for deterministic invariants; use manual QA only for release-level visual/product-path confirmation that cannot be usefully asserted as a unit test.
- Reuse and extend existing compensation coverage in `workers/automation/tests/test_posted_compensation_parser.py`, `workers/automation/tests/test_market_compensation_estimator.py`, `apps/api/test/projections.test.ts`, `apps/api/test/server.test.ts`, `apps/web/src/views/jobs/JobsView.test.tsx`, `apps/web/src/views/jobs/JobDetailDrawer.test.tsx`, and `apps/web/e2e/tests/jobs-drawer.spec.ts`.
- Keep Playwright evidence seeded and disposable. It should exercise the Jobs list and drawer states, table horizontal scroll, drawer ordering, explicit missing/unavailable states, warning-only copy, and absence of compensation sort/filter controls.
- Do not make full-stack worker execution a prerequisite for Phase 22 QA. Worker-backed apply jobs and real generated-material regeneration are explicitly prohibited by QA-06.

### Product Safety Boundary
- Compensation facts and market estimates remain display/audit-only in v1.3. Phase 22 must prove they do not affect fit score, scoring policy, ranking, route search, filters, apply readiness, missing prerequisites, hard blockers, Apply Review concerns, Apply Review handoff, or dispatch/apply controls.
- Product-path checks should compare the same job state with compensation data present, weak, unavailable, or absent, and assert the non-compensation fields and controls stay governed by the existing scoring/apply audit contracts.
- Safety evidence must mention prohibited actions directly: no auto-apply, no browser submission, no mailbox scanning, no real generated-material regeneration, no destructive profile/database actions, no real external scraping, and no worker-backed apply jobs.
- Sensitive local data stays out of fixtures, screenshots, docs, and logs. Do not expose profile data, resumes, generated PDFs, application logs, SQLite database contents, credentials, OAuth data, or provider payloads.

### Release Evidence
- Produce a Phase 22 verification artifact that maps QA-01 through QA-06 to exact fixture cases, tests, commands, and manual QA evidence.
- Update `docs/local-reliability-qa.md` narrowly if the Phase 22 release matrix becomes reusable QA procedure beyond this milestone.
- Mark remaining QA requirements complete only after the verification artifact includes command results and safety-boundary evidence.
- Residual risks should be explicit if broad gates such as full `pnpm test`, `web:build`, or complete Python test suites are skipped for time or unrelated failures.

### the agent's Discretion
- Choose whether the release matrix is represented as markdown tables, test case names, fixture constants, or a combination, provided every QA scenario is traceable.
- Choose the smallest test additions that prove the missing invariants without duplicating coverage already proven by Phase 21.
- Choose exact command grouping for verification, but include the high-signal API, contracts, Python, web unit/a11y, Playwright, typecheck, and diff hygiene gates relevant to touched surfaces.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `.planning/phases/21-jobs-triage-ux-warning-only-floor/21-VERIFICATION.md` already records passing Jobs compensation triage QA and residual gaps to carry into release verification.
- `docs/local-reliability-qa.md` already owns local QA expectations and includes a Jobs Compensation Triage Smoke section with commands, visual checks, and prohibited actions.
- `apps/web/e2e/tests/jobs-drawer.spec.ts` seeds synthetic compensation rows and verifies Jobs list columns, drawer audit ordering, warning-only copy, source trail visibility, missing/unavailable states, and absence of sort/filter controls.
- `apps/web/src/views/jobs/JobsView.test.tsx` covers compact table states, explicit unavailable/insufficient states, accessible dashes, warning counts, and display-only compensation columns.
- `apps/web/src/views/jobs/JobDetailDrawer.test.tsx` covers posted/market missing and weak states, floor comparison bases, and keeping compensation warnings out of apply concerns and readiness controls.
- `apps/api/test/projections.test.ts` and `workers/automation/tests/test_projection_builder.py` cover canonical compensation projection behavior, including warning-only floor comparison and TypeScript/Python projection parity.

### Established Patterns
- Phase work should stay scoped and additive: views compose Operations data, API/read models serve projection-backed canonical rows, and Python/TypeScript projection builders must stay parity-safe.
- User-facing QA uses synthetic or seeded data and browser/product-path evidence when Jobs, drawer, Apply Review, or audit surfaces are touched.
- Compensation behavior from Phases 20 and 21 is locked as warning-only: structured compensation is additive to raw salary compatibility and must not become a ranking, filtering, scoring, readiness, blocker, or apply-dispatch input.
- Tests are colocated for web components, API tests live under `apps/api/test`, Python tests live under `workers/automation/tests`, and Playwright specs live under `apps/web/e2e/tests`.

### Integration Points
- Requirements source: `.planning/REQUIREMENTS.md` QA-01 through QA-06.
- Phase source: `.planning/ROADMAP.md` Phase 22 and `.planning/STATE.md` current v1.3 decisions.
- API/read-model owners: `apps/api/src/read-model.ts`, `apps/api/src/projections.ts`, `apps/api/src/server.ts`, and shared schemas in `packages/contracts/src/schemas.ts`.
- Worker/domain owners: `workers/automation/src/jobhunter/domain/compensation`, compensation repositories, CLI refresh paths, and projection builder code under `workers/automation/src/jobhunter/infrastructure/projections/`.
- Frontend owners: `apps/web/src/views/jobs/`, Operations query hooks, and existing Jobs drawer/list tests.

</code_context>

<specifics>
## Specific Ideas

- Treat Phase 22 as release confidence and auditability work, not as a new compensation capability.
- Build the evidence around a single QA matrix so a human reviewer can see which exact scenario proves each remaining QA requirement.
- Reuse existing Phase 21 synthetic Jobs drawer/list coverage and extend only where QA-01 through QA-06 still have gaps.
- Keep the safety boundary visible in tests and documentation, especially the fact that compensation warnings must not appear in Apply concerns, missing prerequisites, blockers, fit score, ranking controls, filters, apply readiness, or dispatch/apply controls.

</specifics>

<deferred>
## Deferred Ideas

- Live Levels.fyi or Glassdoor provider access, scraping, credentials, caching, or import automation remains deferred until explicit permitted access exists.
- Salary-based ranking, filtering, hard blockers, negotiation anchors, and apply gating remain out of v1.3.
- Compensation correction workflows and profile salary preference editing remain future scope unless a later milestone reopens them.

</deferred>
