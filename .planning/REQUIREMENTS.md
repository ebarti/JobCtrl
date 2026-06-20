# Requirements: JobHunter v1.3 Salary Range Estimator

**Defined:** 2026-06-19
**Core Value:** A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.

## v1.3 Requirements

### Compensation Facts

- [x] **COMP-01**: User can see whether a job has no posted salary, an unparseable salary, an ambiguous salary, or a parsed posted range.
- [x] **COMP-02**: User can inspect the exact posting field or text excerpt that produced each parsed posted salary fact.
- [x] **COMP-03**: User can see normalized salary range fields for parsed posted compensation, including currency, period, component type, minimum, maximum, and annualized values only when annualization assumptions are explicit.
- [x] **COMP-04**: User can see parse confidence and parse warnings for ambiguous compensation text such as hourly pay, monthly pay, OTE, bonus, commission, equity, broad ranges, one-sided ranges, missing currency, or missing period.
- [x] **COMP-05**: User can still see the legacy raw salary string when no structured compensation fact exists, without treating that raw string as the normalized source of truth.

### Reported Compensation Sources

- [x] **SRC-01**: User can see a salary-source registry entry for every configured compensation source, including access mode, terms/source URL, license status, source type, freshness policy, attribution requirement, supported fields, and disabled reason when unavailable.
- [x] **SRC-02**: User can use reported compensation observations from Levels.fyi, Glassdoor, and manual local imports as company-role benchmark evidence when the rows are supplied through a permitted local import path.
- [x] **SRC-03**: User can see when an estimate is an exact company-role match, an adjacent-role company fallback, or a trimodal tier-role fallback.
- [x] **SRC-04**: User can see Levels.fyi and Glassdoor represented as reported-compensation sources, with automated provider access still gated by explicit permitted access configuration.
- [x] **SRC-05**: User is protected from unauthorized Glassdoor scraping because the product does not fetch, scrape, cache, or display Glassdoor-derived salary data without explicit partner/API access or written permission.
- [x] **SRC-06**: User is protected from unlicensed Levels.fyi use because the product does not fetch, scrape, cache, or display Levels.fyi-derived salary data without an explicitly configured permitted access mode and Europe coverage.

### Company-Role Estimates And Statistical Confidence

- [x] **EST-01**: User can see a market estimate state for each job: not requested, unsupported, insufficient evidence, estimated range, or source unavailable.
- [x] **EST-02**: User can see company-role market estimates only when the estimator has enough reported-observation support for company, role, level, location compatibility, compensation component, freshness, sample count, source agreement, and trimodal company tier.
- [x] **EST-03**: User can see statistical confidence for every market estimate, including confidence band, score or bucket, source count, sample count when available, freshness, source agreement or dispersion, and factor-level reasons.
- [x] **EST-04**: User can see an explicit insufficient-evidence explanation instead of a market range when company match, role match, source coverage, sample count, level match, location compatibility, or component compatibility is too weak.
- [x] **EST-05**: User can distinguish posted salary facts from benchmark-derived market estimates in every API and UI surface.
- [x] **EST-06**: User can see trimodal compensation-tier context, including when a tier is supplied by the observation rows or inferred from reported compensation.
- [x] **EST-07**: User can see source conflict, low-sample, stale-source, location-mismatch, or fallback warnings when reported compensation and posted salary ranges diverge or when support is too weak for precise triage.

### Read Model And API

- [x] **API-01**: User-facing job list and job detail responses include compensation summary and compensation audit data from canonical persisted rows, not React or API read-time parsing.
- [x] **API-02**: User can trust compensation projections because Python and TypeScript projection builders produce matching compensation summary/detail JSON for the same canonical fixture.
- [x] **API-03**: User can see compensation facts update through the existing Operations/SSE invalidation path when a compensation assessment changes.
- [x] **API-04**: User can rely on existing raw `JobSummary.salary` compatibility while new consumers prefer the structured compensation audit contract.
- [x] **API-05**: User compensation preferences, local source payloads, credentials, raw benchmark pages, and local paths are not exposed in events, fixtures, logs, or API responses beyond safe comparison facts and allowed excerpts.

### Jobs Triage UX

- [x] **UI-01**: User can scan posted salary, market estimate state, statistical confidence, and warning count from the Jobs list without opening the drawer.
- [x] **UI-02**: User can inspect a dedicated compensation audit section in the Jobs drawer showing posted range, market estimate, source trail, confidence factors, assumptions, warnings, and unavailable-source reasons.
- [ ] **UI-03**: User can see profile-floor comparison as a warning-only audit concern, never as a hidden ranking, filtering, apply-readiness, or blocker decision in v1.3.
- [ ] **UI-04**: User can tell whether profile-floor comparison used a posted salary, a market estimate, both, or neither.
- [x] **UI-05**: User can see missing salary and unsupported market-estimate states explicitly rather than seeing a blank salary cell or silent omission.
- [x] **UI-06**: User can review compensation source labels, freshness, confidence, and warnings on mobile and desktop without text overlap or layout crowding.

### QA And Safety

- [ ] **QA-01**: User-facing compensation behavior is covered by synthetic fixtures for below-floor posted salary, above-floor posted salary, missing posted salary, unparseable salary, broad posted range, OTE/equity ambiguity, exact company-role reported compensation, adjacent-role company fallback, trimodal tier fallback, stale source, source conflict, low-confidence estimate, and insufficient evidence.
- [ ] **QA-02**: Product-path QA proves salary estimates do not change fit score, apply readiness, apply-review handoff, ranking, filtering, or auto-apply behavior in v1.3.
- [ ] **QA-03**: Backend tests prove parser confidence and market confidence degrade when source quality, sample count, freshness, company match, role match, level match, location compatibility, or component compatibility is weak.
- [ ] **QA-04**: API and projection tests prove compensation audit data comes from canonical rows and remains parity-safe across Python and TypeScript projection refreshers.
- [ ] **QA-05**: Frontend tests prove Jobs list and Jobs drawer render posted, estimated, unavailable, insufficient-evidence, warning-only floor comparison, and source-conflict states.
- [ ] **QA-06**: QA uses synthetic jobs and synthetic/manual reported compensation observations only and does not run auto-apply, browser submission, mailbox scanning, real generated-material regeneration, destructive profile/database actions, real external scraping, or worker-backed apply jobs.

## Future Requirements

### Licensed Source Expansion

- **SRC-F01**: User can connect a licensed Levels.fyi data source when access, Europe coverage, retention, attribution, and redistribution terms are confirmed.
- **SRC-F02**: User can connect Glassdoor only when explicit partner/API access or written permission exists for the intended use.
- **SRC-F03**: User can add other licensed compensation providers through the salary-source registry and source-port model.

### Europe Expansion

- **GEO-F01**: User can deepen European public baseline coverage with additional national statistical institutes and region-specific source policies.
- **GEO-F02**: User can compare spot-FX and purchasing-power converted European salary ranges with source/date attribution.

### Product Expansion

- **UX-F01**: User can receive negotiation-anchor suggestions from compensation evidence.
- **UX-F02**: User can opt into salary-based ranking, filtering, or hard blockers after confidence thresholds and source policy are validated.
- **UX-F03**: User can correct parsed salary facts and market-source mappings, with corrections preserved as audit history.
- **UX-F04**: User can model equity, bonus, OTE, and total compensation beyond base/gross wage baselines.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Glassdoor scraping | Glassdoor terms require express permission for automated scraping/mining; v1.3 supports local import of permitted reported rows, not unauthorized scraping. |
| Unlicensed Levels.fyi scraping | Levels.fyi data/API access must be permitted and licensed before use; v1.3 supports local import of permitted reported rows, not unauthorized scraping. |
| Non-European public baselines | JobHunter is Europe-first; non-European salary baselines are not part of the active product direction. |
| Automatic salary ranking/filtering/blockers | The user chose warning-only floor behavior for v1.3. |
| Employer-side compensation screening | JobHunter is applicant-side local triage, not an employer-side selection system. |
| Deep equity/RSU/bonus/OTE modeling | v1.3 stores total compensation ranges when reported rows provide them, but detailed component modeling remains future work. |
| Real external scraping in QA | QA must use synthetic/manual reported compensation fixtures and must not hit real salary pages or private account data. |
| Frontend-only salary estimation | Every displayed compensation claim needs persisted provenance and an owning backend source of truth. |

## Traceability

Which phases cover which requirements.

| Requirement | Phase | Status |
|-------------|-------|--------|
| COMP-01 | Phase 18 | Complete |
| COMP-02 | Phase 18 | Complete |
| COMP-03 | Phase 18 | Complete |
| COMP-04 | Phase 18 | Complete |
| COMP-05 | Phase 18 | Complete |
| SRC-01 | Phase 17 | Complete |
| SRC-02 | Phase 19 | Complete |
| SRC-03 | Phase 19 | Complete |
| SRC-04 | Phase 17 | Complete |
| SRC-05 | Phase 17 | Complete |
| SRC-06 | Phase 17 | Complete |
| EST-01 | Phase 19 | Complete |
| EST-02 | Phase 19 | Complete |
| EST-03 | Phase 19 | Complete |
| EST-04 | Phase 19 | Complete |
| EST-05 | Phase 20/21 | Complete |
| EST-06 | Phase 19 | Complete |
| EST-07 | Phase 19 | Complete |
| API-01 | Phase 20 | Complete |
| API-02 | Phase 20 | Complete |
| API-03 | Phase 20 | Complete |
| API-04 | Phase 20 | Complete |
| API-05 | Phase 20 | Complete |
| UI-01 | Phase 21 | Complete |
| UI-02 | Phase 21 | Complete |
| UI-03 | Phase 21 | Pending |
| UI-04 | Phase 21 | Pending |
| UI-05 | Phase 21 | Complete |
| UI-06 | Phase 21 | Complete |
| QA-01 | Phase 22 | Pending |
| QA-02 | Phase 22 | Pending |
| QA-03 | Phase 22 | Pending |
| QA-04 | Phase 22 | Pending |
| QA-05 | Phase 22 | Pending |
| QA-06 | Phase 22 | Pending |

**Coverage:**
- v1.3 requirements: 35 total
- Mapped to phases: 35
- Unmapped: 0
- Duplicate mappings: 0

---
*Requirements defined: 2026-06-19*
*Last updated: 2026-06-20 during Phase 21 compensation rendering*
