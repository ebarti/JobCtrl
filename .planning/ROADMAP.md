# Roadmap: JobHunter - Grounded Resume Tailoring

## Milestones

- 🚧 **v1.3 Salary Range Estimator** — Phases 17-22, active planning started 2026-06-19.
- ✅ **v1.2 Apply Review Audit UX - Drawer + Resume Pins** — Phases 12-16, shipped 2026-06-13 ([roadmap archive](milestones/v1.2-ROADMAP.md), [requirements archive](milestones/v1.2-REQUIREMENTS.md), [audit](milestones/v1.2-MILESTONE-AUDIT.md)).
- ✅ **v1.1 shadcn standard-token migration + preset b3F5kqmYd8** — Phases 6-10, shipped before v1.2; final cleanup folded into v1.2 Phase 12.
- ✅ **v1.0 Grounded Resume Tailoring** — Phases 1-5, verified 2026-06-09.

## Overview

v1.3 makes compensation facts inspectable in Jobs triage without turning uncertain salary evidence into hidden ranking, filtering, or apply gates. The milestone first locks source-access policy, then adds posted salary facts, Europe-only public market estimates, canonical read-model/API propagation, Jobs list/drawer UX, and product-path QA that proves the feature stays warning-only and audit-first.

## Phases

**Phase Numbering:**
- Integer phases (17, 18, 19): Planned milestone work continuing after v1.2 Phase 16.
- Decimal phases (17.1, 17.2): Urgent insertions only, if needed later.

- [x] **Phase 17: Source Registry & Access Policy** - Users can inspect which compensation sources are available, licensed, disabled, or blocked.
- [x] **Phase 18: Posted Compensation Facts** - Users can inspect structured posted salary facts with source text, confidence, warnings, and raw fallback.
- [x] **Phase 19: Europe Public Market Estimates** - Users can see Europe-only baseline estimates or explicit insufficient-evidence states with confidence factors.
- [ ] **Phase 20: Canonical Read Model & Realtime API** - Users and API consumers receive compensation audit data from canonical persisted rows safely and consistently.
- [ ] **Phase 21: Jobs Triage UX & Warning-Only Floor** - Users can scan and inspect compensation evidence in Jobs triage without salary data becoming an automatic gate.
- [ ] **Phase 22: Product-Path QA & Safety Release** - Users can rely on v1.3 compensation behavior being verified with synthetic/public data and no prohibited actions.

## Phase Details

### Phase 17: Source Registry & Access Policy
**Goal**: Users can trust which compensation sources are available, licensed, disabled, and safe to use before any estimate is generated.
**Depends on**: Phase 16 (v1.2 shipped baseline)
**Requirements**: SRC-01, SRC-04, SRC-05, SRC-06
**Success Criteria** (what must be TRUE):
  1. User can inspect each configured compensation source's access mode, terms/source URL, license status, source type, freshness policy, attribution requirement, supported fields, and disabled reason.
  2. User can see Levels.fyi and Glassdoor only as disabled or unavailable licensed-source seams unless explicit permitted access is configured.
  3. User is protected from unauthorized Glassdoor and Levels.fyi use because the product does not fetch, scrape, cache, or display either source without permitted access.
  4. User can distinguish unavailable licensed-source seams from Europe public baseline sources in compensation source evidence.
**Plans**: 17-01 Backend Source Registry; 17-02 Settings Source Policy UI

### Phase 18: Posted Compensation Facts
**Goal**: Users can inspect posted salary facts parsed from job postings, including source text, normalized values, confidence, warnings, and legacy raw fallback.
**Depends on**: Phase 17
**Requirements**: COMP-01, COMP-02, COMP-03, COMP-04, COMP-05
**Success Criteria** (what must be TRUE):
  1. User can see whether a job has no posted salary, an unparseable salary, an ambiguous salary, or a parsed posted range.
  2. User can inspect the exact posting field or text excerpt that produced each parsed posted salary fact.
  3. User can see normalized currency, period, component type, minimum, maximum, and annualized values only when annualization assumptions are explicit.
  4. User can see parse confidence and warnings for hourly pay, monthly pay, OTE, bonus, commission, equity, broad ranges, one-sided ranges, missing currency, and missing period.
  5. User can still see the legacy raw salary string when no structured compensation fact exists, without treating that raw string as the normalized source of truth.
**Plans**: 18-01 Parser And Persistence; 18-02 Read API And Inspection Contract

### Phase 19: Europe Public Market Estimates
**Goal**: Users can see Europe-only public market estimates when evidence is strong enough, or explicit explanations when support is weak or unavailable.
**Depends on**: Phase 18
**Requirements**: SRC-02, SRC-03, EST-01, EST-02, EST-03, EST-04, EST-06, EST-07
**Success Criteria** (what must be TRUE):
  1. User can see a market estimate state for each job: not requested, unsupported, insufficient evidence, estimated range, or source unavailable.
  2. User can see Europe-only estimates from Eurostat Structure of Earnings Survey, ESCO occupation mapping, and Spain INE Wage Structure Survey only when role, occupation, geography, seniority, compensation component, and freshness are sufficiently supported.
  3. User can see when a public baseline is an occupation/location aggregate rather than a company-specific market range.
  4. User can see statistical confidence for every market estimate, including band or bucket, source count, sample count when available, freshness, source agreement or dispersion, and factor-level reasons.
  5. User can see assumptions, source conflict warnings, broad aggregate warnings, or insufficient-evidence explanations instead of a precise market range when source support is too weak.
**Plans**: 19-01 Market Estimate Domain And Persistence; 19-02 Market Estimate Inspection API

### Phase 20: Canonical Read Model & Realtime API
**Goal**: Users and API consumers receive compensation summaries and audit details from canonical persisted rows, with parity-safe projections and safe event payloads.
**Depends on**: Phase 19
**Requirements**: EST-05, API-01, API-02, API-03, API-04, API-05
**Success Criteria** (what must be TRUE):
  1. User-facing job list and job detail responses include compensation summary and compensation audit data from canonical persisted rows, not client or read-time parsing.
  2. Posted salary facts and benchmark-derived market estimates remain clearly separate in every compensation API/read-model contract.
  3. Python and TypeScript projection builders produce matching compensation summary/detail JSON for the same canonical fixture.
  4. User can see compensation facts update through the existing Operations/SSE invalidation path while existing raw `JobSummary.salary` compatibility remains intact.
  5. User compensation preferences, local source payloads, credentials, raw benchmark pages, local paths, and unsafe source details are excluded from events, fixtures, logs, and API responses beyond safe comparison facts and allowed excerpts.
**Plans**: TBD

### Phase 21: Jobs Triage UX & Warning-Only Floor
**Goal**: Users can scan and inspect compensation evidence in Jobs list and drawer triage without salary facts silently changing ranking, filtering, apply readiness, or blockers.
**Depends on**: Phase 20
**Requirements**: UI-01, UI-02, UI-03, UI-04, UI-05, UI-06
**Success Criteria** (what must be TRUE):
  1. User can scan posted salary, market estimate state, statistical confidence, and warning count from the Jobs list without opening the drawer.
  2. User can inspect a dedicated compensation audit section in the Jobs drawer showing posted range, market estimate, source trail, confidence factors, assumptions, warnings, and unavailable-source reasons.
  3. User can see profile-floor comparison as a warning-only audit concern and can tell whether it used posted salary, market estimate, both, or neither.
  4. User can see missing salary and unsupported or insufficient-evidence market-estimate states explicitly instead of blank salary cells or silent omissions.
  5. User can review compensation source labels, freshness, confidence, and warnings on mobile and desktop without text overlap or layout crowding.
**Plans**: TBD
**UI hint**: yes

### Phase 22: Product-Path QA & Safety Release
**Goal**: Users can rely on v1.3 compensation behavior because the full path is verified with synthetic/public data and the feature does not trigger prohibited actions.
**Depends on**: Phase 21
**Requirements**: QA-01, QA-02, QA-03, QA-04, QA-05, QA-06
**Success Criteria** (what must be TRUE):
  1. Human verifier can exercise synthetic fixtures for below-floor posted salary, above-floor posted salary, missing posted salary, unparseable salary, broad posted range, OTE/equity ambiguity, Europe public baseline, Spain INE baseline, unsupported geography, stale source, source conflict, low-confidence estimate, and insufficient evidence.
  2. Product-path QA shows salary estimates do not change fit score, apply readiness, apply-review handoff, ranking, filtering, or auto-apply behavior in v1.3.
  3. Backend, API, projection, and frontend tests prove parser confidence, market confidence, and canonical compensation data behave correctly across weak source quality and parity refresh paths.
  4. Frontend checks prove the Jobs list and Jobs drawer render posted, estimated, unavailable, insufficient-evidence, warning-only floor comparison, and source-conflict states.
  5. QA evidence confirms synthetic or public aggregate data only, with no auto-apply, browser submission, mailbox scanning, real generated-material regeneration, destructive profile/database actions, real external scraping, or worker-backed apply jobs.
**Plans**: TBD
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 17 -> 18 -> 19 -> 20 -> 21 -> 22

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 17. Source Registry & Access Policy | 2/2 | Complete | 2026-06-19 |
| 18. Posted Compensation Facts | 2/2 | Complete | 2026-06-19 |
| 19. Europe Public Market Estimates | 2/2 | Complete | 2026-06-19 |
| 20. Canonical Read Model & Realtime API | 0/TBD | Not started | - |
| 21. Jobs Triage UX & Warning-Only Floor | 0/TBD | Not started | - |
| 22. Product-Path QA & Safety Release | 0/TBD | Not started | - |

## Completed Milestone Summary

<details>
<summary>✅ v1.2 Apply Review Audit UX - Drawer + Resume Pins (Phases 12-16) — SHIPPED 2026-06-13</summary>

- [x] Phase 12: Folded Cleanup + Verification Baseline — 2/2 plans
- [x] Phase 13: Shared Apply Audit Contract — 2/2 plans
- [x] Phase 14: Jobs Drawer Audit Triage — 2/2 plans
- [x] Phase 15: Apply Review Resume Pins — 2/2 plans
- [x] Phase 16: Product-Path QA + Documentation — 2/2 plans

Artifacts:

- [Roadmap archive](milestones/v1.2-ROADMAP.md)
- [Requirements archive](milestones/v1.2-REQUIREMENTS.md)
- [Milestone audit](milestones/v1.2-MILESTONE-AUDIT.md)
- [Phase execution archive](milestones/v1.2-phases/)

</details>

## Coverage

- v1.3 requirements: 35 total
- Mapped to phases: 35
- Unmapped: 0
- Duplicate mappings: 0

---
*Last updated: 2026-06-19 after Phase 19 verification*
