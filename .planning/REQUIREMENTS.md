# Requirements: JobHunter v1.3 Salary Range Estimator

**Defined:** 2026-06-19
**Core Value:** A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.

## v1.3 Requirements

### Compensation Facts

- [ ] **COMP-01**: User can see whether a job has no posted salary, an unparseable salary, an ambiguous salary, or a parsed posted range.
- [ ] **COMP-02**: User can inspect the exact posting field or text excerpt that produced each parsed posted salary fact.
- [ ] **COMP-03**: User can see normalized salary range fields for parsed posted compensation, including currency, period, component type, minimum, maximum, and annualized values only when annualization assumptions are explicit.
- [ ] **COMP-04**: User can see parse confidence and parse warnings for ambiguous compensation text such as hourly pay, monthly pay, OTE, bonus, commission, equity, broad ranges, one-sided ranges, missing currency, or missing period.
- [ ] **COMP-05**: User can still see the legacy raw salary string when no structured compensation fact exists, without treating that raw string as the normalized source of truth.

### Europe Salary Sources

- [ ] **SRC-01**: User can see a salary-source registry entry for every configured compensation source, including access mode, terms/source URL, license status, source type, freshness policy, attribution requirement, supported fields, and disabled reason when unavailable.
- [ ] **SRC-02**: User can use Europe-only public baseline sources for v1.3: Eurostat Structure of Earnings Survey for Europe-wide wage baselines, ESCO for occupation mapping, and Spain INE Wage Structure Survey for Spain-specific wage baselines.
- [ ] **SRC-03**: User can see when a public baseline is an occupation/location aggregate rather than a company-specific market range.
- [ ] **SRC-04**: User can see Levels.fyi and Glassdoor represented only as disabled or unavailable licensed-source seams unless explicit permitted access is configured.
- [ ] **SRC-05**: User is protected from unauthorized Glassdoor scraping because the product does not fetch, scrape, cache, or display Glassdoor-derived salary data without explicit partner/API access or written permission.
- [ ] **SRC-06**: User is protected from unlicensed Levels.fyi use because the product does not fetch, scrape, cache, or display Levels.fyi-derived salary data without an explicitly configured permitted access mode and Europe coverage.

### Market Estimates And Statistical Confidence

- [ ] **EST-01**: User can see a market estimate state for each job: not requested, unsupported, insufficient evidence, estimated range, or source unavailable.
- [ ] **EST-02**: User can see Europe-only market estimates only when the estimator has enough source support for role, occupation, geography, seniority, compensation component, and freshness.
- [ ] **EST-03**: User can see statistical confidence for every market estimate, including confidence band, score or bucket, source count, sample count when available, freshness, source agreement or dispersion, and factor-level reasons.
- [ ] **EST-04**: User can see an explicit insufficient-evidence explanation instead of a market range when source coverage, sample count, geography match, seniority match, or component compatibility is too weak.
- [ ] **EST-05**: User can distinguish posted salary facts from benchmark-derived market estimates in every API and UI surface.
- [ ] **EST-06**: User can see assumptions for remote-Europe, Spain-local, EU-wide, non-EU-Europe, and unknown-location mappings rather than having the system silently pick a market.
- [ ] **EST-07**: User can see source conflict or broad aggregate warnings when public baselines and posted salary ranges diverge or when a range is too wide for precise triage.

### Read Model And API

- [ ] **API-01**: User-facing job list and job detail responses include compensation summary and compensation audit data from canonical persisted rows, not React or API read-time parsing.
- [ ] **API-02**: User can trust compensation projections because Python and TypeScript projection builders produce matching compensation summary/detail JSON for the same canonical fixture.
- [ ] **API-03**: User can see compensation facts update through the existing Operations/SSE invalidation path when a compensation assessment changes.
- [ ] **API-04**: User can rely on existing raw `JobSummary.salary` compatibility while new consumers prefer the structured compensation audit contract.
- [ ] **API-05**: User compensation preferences, local source payloads, credentials, raw benchmark pages, and local paths are not exposed in events, fixtures, logs, or API responses beyond safe comparison facts and allowed excerpts.

### Jobs Triage UX

- [ ] **UI-01**: User can scan posted salary, market estimate state, statistical confidence, and warning count from the Jobs list without opening the drawer.
- [ ] **UI-02**: User can inspect a dedicated compensation audit section in the Jobs drawer showing posted range, market estimate, source trail, confidence factors, assumptions, warnings, and unavailable-source reasons.
- [ ] **UI-03**: User can see profile-floor comparison as a warning-only audit concern, never as a hidden ranking, filtering, apply-readiness, or blocker decision in v1.3.
- [ ] **UI-04**: User can tell whether profile-floor comparison used a posted salary, a market estimate, both, or neither.
- [ ] **UI-05**: User can see missing salary and unsupported market-estimate states explicitly rather than seeing a blank salary cell or silent omission.
- [ ] **UI-06**: User can review compensation source labels, freshness, confidence, and warnings on mobile and desktop without text overlap or layout crowding.

### QA And Safety

- [ ] **QA-01**: User-facing compensation behavior is covered by synthetic fixtures for below-floor posted salary, above-floor posted salary, missing posted salary, unparseable salary, broad posted range, OTE/equity ambiguity, Europe public baseline, Spain INE baseline, unsupported geography, stale source, source conflict, low-confidence estimate, and insufficient evidence.
- [ ] **QA-02**: Product-path QA proves salary estimates do not change fit score, apply readiness, apply-review handoff, ranking, filtering, or auto-apply behavior in v1.3.
- [ ] **QA-03**: Backend tests prove parser confidence and market confidence degrade when source quality, sample count, freshness, role match, seniority match, geography match, or component compatibility is weak.
- [ ] **QA-04**: API and projection tests prove compensation audit data comes from canonical rows and remains parity-safe across Python and TypeScript projection refreshers.
- [ ] **QA-05**: Frontend tests prove Jobs list and Jobs drawer render posted, estimated, unavailable, insufficient-evidence, warning-only floor comparison, and source-conflict states.
- [ ] **QA-06**: QA uses synthetic or public aggregate data only and does not run auto-apply, browser submission, mailbox scanning, real generated-material regeneration, destructive profile/database actions, real external scraping, or worker-backed apply jobs.

## Future Requirements

### Licensed Source Expansion

- **SRC-F01**: User can connect a licensed Levels.fyi data source when access, Europe coverage, retention, attribution, and redistribution terms are confirmed.
- **SRC-F02**: User can connect Glassdoor only when explicit partner/API access or written permission exists for the intended use.
- **SRC-F03**: User can add other licensed compensation providers through the salary-source registry and source-port model.

### Geography Expansion

- **GEO-F01**: User can add U.S. public baselines such as BLS/OEWS, O*NET, and OFLC in a later milestone.
- **GEO-F02**: User can add non-European public baselines with region-specific source policies and confidence rules.
- **GEO-F03**: User can compare spot-FX and purchasing-power converted salary ranges with source/date attribution.

### Product Expansion

- **UX-F01**: User can receive negotiation-anchor suggestions from compensation evidence.
- **UX-F02**: User can opt into salary-based ranking, filtering, or hard blockers after confidence thresholds and source policy are validated.
- **UX-F03**: User can correct parsed salary facts and market-source mappings, with corrections preserved as audit history.
- **UX-F04**: User can model equity, bonus, OTE, and total compensation beyond base/gross wage baselines.

## Out of Scope

| Feature | Reason |
|---------|--------|
| Glassdoor scraping | Glassdoor terms require express permission for automated scraping/mining; v1.3 only supports disabled/licensed seams. |
| Unlicensed Levels.fyi scraping | Levels.fyi data/API access must be permitted and licensed before use; v1.3 only supports disabled/licensed seams. |
| U.S. public baselines | The scoped milestone is Europe-only. BLS/O*NET/OFLC can be added later. |
| Automatic salary ranking/filtering/blockers | The user chose warning-only floor behavior for v1.3. |
| Employer-side compensation screening | JobHunter is applicant-side local triage, not an employer-side selection system. |
| Deep equity/RSU/bonus/OTE modeling | Public Europe baselines are wage/salary aggregates; total compensation modeling needs licensed structured data. |
| Real external scraping in QA | QA must use synthetic/public aggregate fixtures and must not hit real salary pages or private account data. |
| Frontend-only salary estimation | Every displayed compensation claim needs persisted provenance and an owning backend source of truth. |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| COMP-01 | TBD | Pending |
| COMP-02 | TBD | Pending |
| COMP-03 | TBD | Pending |
| COMP-04 | TBD | Pending |
| COMP-05 | TBD | Pending |
| SRC-01 | TBD | Pending |
| SRC-02 | TBD | Pending |
| SRC-03 | TBD | Pending |
| SRC-04 | TBD | Pending |
| SRC-05 | TBD | Pending |
| SRC-06 | TBD | Pending |
| EST-01 | TBD | Pending |
| EST-02 | TBD | Pending |
| EST-03 | TBD | Pending |
| EST-04 | TBD | Pending |
| EST-05 | TBD | Pending |
| EST-06 | TBD | Pending |
| EST-07 | TBD | Pending |
| API-01 | TBD | Pending |
| API-02 | TBD | Pending |
| API-03 | TBD | Pending |
| API-04 | TBD | Pending |
| API-05 | TBD | Pending |
| UI-01 | TBD | Pending |
| UI-02 | TBD | Pending |
| UI-03 | TBD | Pending |
| UI-04 | TBD | Pending |
| UI-05 | TBD | Pending |
| UI-06 | TBD | Pending |
| QA-01 | TBD | Pending |
| QA-02 | TBD | Pending |
| QA-03 | TBD | Pending |
| QA-04 | TBD | Pending |
| QA-05 | TBD | Pending |
| QA-06 | TBD | Pending |

**Coverage:**
- v1.3 requirements: 35 total
- Mapped to phases: 0
- Unmapped: 35

---
*Requirements defined: 2026-06-19*
*Last updated: 2026-06-19 after v1.3 requirements definition*
