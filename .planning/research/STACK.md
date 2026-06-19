# Technology Stack Research

**Project:** JobHunter v1.3 Salary Range Estimator  
**Researched:** 2026-06-19  
**Scope:** Posted salary extraction, market compensation sources, statistical confidence, source provenance, and Jobs triage surfacing.  
**Overall confidence:** HIGH for repo integration approach and public/government source constraints; MEDIUM for licensed commercial data availability until the user chooses a provider/account.

## Recommendation

Build v1.3 as a local-first compensation evidence feature on the existing Python worker, SQLite canonical tables, projection-backed TypeScript API, and Jobs drawer/list UI. Do not introduce a new service, queue, scraper platform, or separate analytics store.

The practical stack is:

| Layer | Recommended approach | Why |
| --- | --- | --- |
| Posted salary extraction | Deterministic Python parser in the Discovery/Enrichment domain, backed by canonical salary-fact rows | `JobMetadata.salary` is currently a raw string and scoring has only a private `_salary_max` heuristic. v1.3 needs inspectable parse facts with source text, period, currency, warnings, and confidence. |
| Market salary estimation | New Python compensation/market estimator use case, fed by pluggable source adapters | The Python worker already owns external I/O, source provenance, scoring, and local persistence. Keep source calls out of React and out of the TS read model. |
| Public baseline data | BLS OEWS/O*NET as default public benchmark baseline; optional OFLC/H-1B disclosure import for company/location-specific U.S. tech signal | These are official/public sources with clear access paths and freshness metadata. They are weaker than Levels.fyi for tech leveling, but suitable as legally safe default evidence. |
| Licensed commercial data | Optional Levels.fyi adapter behind an explicit user-provided access configuration | Levels.fyi advertises API/MCP/CLI and data-stream access, but API/data-stream access is gated behind commercial access. Treat it as optional, not table stakes. |
| Glassdoor | Do not scrape. Use only if the user has explicit API-partner access or written permission | Glassdoor Terms prohibit automated agents/scraping/data mining without express written permission. Public developer docs indicate additional APIs are partner-only. |
| Statistics | Pure Python aggregation and confidence scoring; use existing `pandas` only for bulk file imports | v1.3 needs medians/percentiles/source agreement, not a heavy statistics stack. Avoid `numpy`/`scipy` unless later requirements need inferential stats. |
| API/read path | Add compensation DTOs to `packages/contracts`, project them through `job_list_projections` and `job_detail_projections`, and map in `apps/api/src/read-model.ts` | Jobs list/detail already read from projections. Salary facts should travel with the same projection and SSE invalidation model as score/audit facts. |
| UI | Add context-owned salary components composed by Jobs views | `JobOverview.tsx` currently prints `job.salary`; `JobAuditTriage.tsx` owns the audit triage surface. Keep views as composers and avoid direct API calls. |

## Source Strategy

Use a tiered estimator. The UI should show the best available salary evidence and the confidence/source gaps, not force every job through the same source path.

1. **Posted compensation first.** If the posting contains a usable employer-provided range, show it as the highest-provenance fact. Parse from both the existing `jobs.salary` field and compensation windows in `description` / `full_description`.
2. **Licensed tech-market benchmark second.** If configured, query Levels.fyi for role/company/location/level data and store only allowed derived results plus provider provenance, according to the user's license.
3. **Public occupation/location baseline third.** Map job title/seniority to SOC/O*NET, then use BLS OEWS/O*NET wage data as fallback or corroboration.
4. **OFLC/H-1B disclosure as a niche corroborator.** Use for U.S. employer/location/title evidence when imported locally, but label it as visa/LCA-biased and not a general market range.
5. **No opaque ranking/filtering.** Salary evidence can compare against the profile floor and produce warnings, but v1.3 should not auto-block, hide, or downrank jobs from market estimates.

## Salary Data Sources Considered

| Source | Access method | Constraints | Freshness expectation | Recommendation |
| --- | --- | --- | --- | --- |
| Posted job salary text | Existing discovery/enrichment fields and full posting text | Raw board salary strings are inconsistent; descriptions can contain unrelated numbers, OTE, hourly rates, contract rates, equity, or benefits. | Fresh at discovery/enrichment time; refresh when posting snapshot changes. | **Use by default.** Store parse source text, source field, normalized range, period, currency, parse warnings, and confidence. |
| Levels.fyi | Official paid data/API/MCP/CLI/data-stream access or approved embeds | API/data-stream access is commercial. Public page advertises request access, paid benchmark plans, data stream, API/MCP access, and restrictions on transferred data. Do not scrape or redistribute raw data unless license permits. | Levels.fyi markets data as real-time/live, daily-refreshing for paid data, with recent trailing-data products. | **Optional licensed adapter.** Best fit for tech roles, company/level granularity, and total compensation breakdowns. Gate behind config and requirements decision. |
| Glassdoor | Partner API or express written permission only | Glassdoor Terms prohibit automated agents used to scrape/strip/mine data without express written permission. Jobs API docs say additional APIs are not public and are available to API partners. Public salary pages may show useful numbers, but scraping is not acceptable for this milestone. | Current visible pages can be fresh, but usable automated access is uncertain without a partner agreement. | **Do not integrate in v1.3 unless the user already has licensed access.** Record as a requirements decision, not an implementation default. |
| BLS OEWS | Official BLS tables/downloads; BLS Public Data API for series where appropriate | OEWS is occupation/location aggregate data, not company or seniority specific. API series IDs can be awkward; tables/downloads may be easier for local cache. | Current OEWS documentation is May 2025, last modified May 15, 2026. Annual estimates for about 830 occupations across national, state, metro, and nonmetro areas. | **Use as default public baseline.** Good for floor/market sanity and public provenance. |
| O*NET Web Services / O*NET OnLine | Registered developer REST API; O*NET OnLine displays wage/employment data sourced from BLS OEWS | Requires registration for API credentials. O*NET is best for occupation matching/crosswalk and readable occupation labels; wage data ultimately traces to BLS. | O*NET Web Services uses current O*NET database releases; O*NET OnLine wage data references BLS 2025 OEWS updated June 17, 2026. | **Use for title-to-SOC/O*NET mapping.** Use BLS as canonical wage source when possible. |
| DOL OFLC/H-1B disclosure | Official quarterly/fiscal-year XLSX disclosure files imported locally | Biased toward visa-sponsored roles, certified/offered wage records, and employer-submitted fields. Files are large XLSX; not a simple live API. | OFLC released FY2026 Q2 disclosure data on May 15, 2026, covering Oct 1, 2025 through Mar 31, 2026. | **Optional local import/corroborator.** Useful for company/location/title evidence, but never sole market estimate. |
| Salary.com DaaS / CompAnalyst APIs | Commercial APIs | Commercial model; likely requires customer relationship. More employer/HR-oriented than local job seeker MVP. | Vendor-managed. | **Defer.** Consider only if user wants commercial provider support beyond Levels.fyi. |
| Scraper marketplaces / unofficial APIs | Apify, Bright Data, Piloterr, OpenWeb Ninja, similar | Legal/licensing ambiguity, provenance dilution, possible ToS conflict with source sites, and more infra than needed. | Vendor-dependent. | **Do not add for v1.3.** They undermine the audit-first trust model unless separately licensed and approved. |

## Stack Additions

### Add Python Domain Modules, Not New Infrastructure

Recommended new worker-side modules:

| Module | Responsibility |
| --- | --- |
| `domain/compensation/value_objects.py` | `MoneyAmount`, `SalaryPeriod`, `SalaryRangeFact`, `MarketSalaryEstimate`, `SalarySource`, `SalaryConfidence`, parse warning enums. |
| `domain/compensation/services.py` | Deterministic parser, range normalization, annualization, source-agreement scoring, confidence formula. |
| `domain/ports/compensation.py` | `SalaryBenchmarkSourcePort` and `OccupationMatcherPort` interfaces. |
| `infrastructure/compensation/bls_oews.py` | Local BLS/OEWS table loader/cache and/or API client. |
| `infrastructure/compensation/onet.py` | O*NET occupation search/crosswalk adapter if API credentials are configured. |
| `infrastructure/compensation/levels_fyi.py` | Optional licensed adapter; disabled unless configured. |
| `infrastructure/compensation/oflc.py` | Optional local XLSX disclosure importer using existing `pandas`. |

Keep the estimator deterministic where possible. Use LLMs only if a later phase explicitly needs ambiguous seniority/role classification beyond existing title and employer-analysis signals.

### Use Existing Dependencies

| Existing dependency | Use |
| --- | --- |
| `httpx` | BLS/O*NET/Levels API calls with timeouts, retries, and source metadata. |
| `pandas` | Bulk XLSX/CSV import for BLS/OEWS or OFLC files if table downloads are chosen. |
| `pydantic` | DTO validation for external source payload adapters if useful. |
| SQLite | Canonical compensation facts, source observations, cache metadata, and projection columns. |
| TanStack Query/Table | Jobs list refresh and triage surfacing through existing Operations hooks. |

No new runtime dependency is required for MVP salary parsing. If a parser later needs locale-aware currency formatting, prefer a small, isolated formatter or existing app formatting helpers before adding Babel or a money library.

## Suggested Data Model

Use canonical rows rather than `metadata_json` blobs, consistent with the v1.2 audit direction.

| Table/shape | Purpose |
| --- | --- |
| `job_salary_facts` | One row per parsed posted compensation fact: `tenant_id`, `job_url`, `source_kind`, `source_field`, `source_text_excerpt`, `currency`, `period`, `min_amount`, `max_amount`, `annual_min`, `annual_max`, `confidence`, `warnings_json`, `parsed_at`, `snapshot_hash`. |
| `salary_market_sources` | Registry/cache of external source captures: provider id, query parameters, freshness timestamp, license/access mode, source URL/API endpoint label, sample/source count, provider confidence metadata. |
| `job_salary_estimates` | One latest estimate per job/version: normalized market range, source count, source agreement, confidence, assumptions, profile-floor comparison, stale/fresh status, and source refs. |
| Projection columns | Add `posted_salary_fact_json` and `market_salary_estimate_json` to job list/detail projections, or a single `salary_audit_json` if the UI should consume one grouped contract. |

Prefer a single contract field in `JobSummary`/`JobDetail`, for example:

```typescript
interface SalaryAudit {
  posted: PostedSalaryFact | null;
  market: MarketSalaryEstimate | null;
  profileFloor: ProfileSalaryFloor | null;
  comparison: "above_floor" | "below_floor" | "overlaps_floor" | "unknown";
  summary: string;
  confidence: "high" | "medium" | "low" | "unknown";
  sources: SalarySourceSummary[];
  warnings: SalaryWarning[];
}
```

This keeps Jobs triage from reconstructing salary logic in React.

## Confidence Model

Use explainable confidence bands instead of pretending external salary data is precise.

Recommended first-pass factors:

| Factor | Raises confidence | Lowers confidence |
| --- | --- | --- |
| Posted salary extraction | Explicit salary field, two-sided range, currency/period present, exact source text | Description-only match, many unrelated numbers, OTE/equity ambiguity, missing period, one-sided range |
| Role match | O*NET/SOC or Levels role matches title and inferred seniority | Generic title, mixed management/IC signal, no seniority match |
| Location match | Same metro/country/remote market | State/national fallback, remote geography unclear |
| Company match | Same company in licensed source or OFLC | Industry/occupation-only baseline |
| Source freshness | Posted snapshot current; provider data has captured/updated date | Old imported file, unknown provider timestamp |
| Source agreement | Posted and market ranges overlap; multiple sources agree | Wide divergence or only one weak source |
| Sample count | Source exposes sample count/count bucket and it clears threshold | Missing count, tiny count, or source cannot support sample claim |

Display `confidence`, `source_count`, `sample_count` where available, `freshness`, `assumptions`, and parse warnings. Never show a precise-looking single number without range/provenance.

## Integration Points In JobHunter

| Area | Current state | v1.3 integration |
| --- | --- | --- |
| Discovery value object | `JobMetadata.salary` is an optional raw string. | Preserve raw value; add parsed salary fact generation when job metadata or enriched description changes. |
| Scoring constraints | `ConstraintChecker` has private regex helpers for `_salary_max` and profile minimum blocker. | Replace or delegate this heuristic to canonical posted salary facts. Scoring should consume salary audit facts, not re-parse ad hoc. |
| Pipeline | Discover drains enrichment and preparation work. | Salary extraction should run after discovery/enrichment writes and before scoring uses compensation blockers. Market estimation can be a preparation work item or enrichment substep, depending on whether external access is configured. |
| SQLite/projections | `job_list_projections.salary` stores raw string; `JobSummary.salary` exposes it. | Add canonical tables plus projection JSON for posted/market salary audit. Keep raw `salary` for compatibility. |
| TypeScript contracts | `JobSummary` has `salary: string`; no salary audit DTO. | Add `SalaryAudit` DTOs in `packages/contracts/src/schemas.ts` and re-export through Operations types. |
| API read model | `rowToJobSummary` maps raw salary only. | Parse projection JSON into `job.salaryAudit`; include on list and detail. |
| Jobs overview | Displays `location · salary`. | Replace or augment raw salary with posted range label plus confidence/source indicator. Keep raw source text inspectable. |
| Jobs audit triage | Shows ranking, fit confidence, eligibility, score metadata, apply concerns. | Add a compensation section with posted range, market estimate, profile-floor comparison, source trail, and warnings. |
| UI invalidation | Existing SSE invalidation handles job updates by event type. | Add `SalaryFactsExtracted` / `MarketSalaryEstimated` events and register handlers in the operations invalidation router. |

## What Not To Add For v1.3

| Do not add | Reason |
| --- | --- |
| Glassdoor scraping | Violates/risks source terms without written permission and creates an auditability/legal problem. |
| Unofficial Glassdoor/Levels scraper APIs | They add vendor dependency while inheriting source-access ambiguity. |
| A new hosted backend or external database | JobHunter is local-first; SQLite/projections are enough for v1.3. |
| A new ranking/filter gate from market salary | The milestone explicitly says uncertain compensation should stay audit-first, not opaque gating. |
| Full currency conversion service | Useful later, but v1.3 can normalize only when currency/period is explicit and label unknowns honestly. |
| Equity/bonus/TC modeling as required MVP | Posted salary and BLS are base/wage oriented; Levels.fyi total compensation can be optional source metadata if licensed. |
| Broad AI extraction for all salary parsing | Deterministic parse plus warnings is more auditable. Use LLM only for explicit future ambiguous cases. |
| A frontend-only estimator | Salary facts need canonical provenance and must be visible through the API/read model. |
| New charting library | Jobs triage needs compact labels, ranges, source trail, and warning states; tables/cards/tags are enough. |

## Risks And Requirements Decisions

| Decision needed | Why it matters |
| --- | --- |
| Does the user have or want to buy Levels.fyi data/API access? | Determines whether v1.3 can support company/level-aware tech compensation beyond public baselines. |
| Is Glassdoor explicitly licensed/partner-accessible for this project? | Without written permission or partner API access, Glassdoor should be excluded. |
| What geography is in scope for public baselines? | BLS/O*NET/OFLC are U.S.-centric. Europe/Spain roles need a separate public source decision, or should be labeled unsupported/low-confidence. |
| Is the estimate base salary only or total compensation? | Posted salary and BLS are base/wage oriented; Levels.fyi can include total compensation. Mixing them without labels will mislead users. |
| How should remote jobs map to location? | Remote U.S., Europe remote, global remote, and company HQ produce different ranges. This needs explicit assumptions. |
| What minimum sample/source count is required to show a market range? | Prevents false precision for sparse licensed or OFLC data. |
| Should profile floor comparison use minimum acceptable salary, expectation, or range overlap? | Profile has `salary_expectation`, `salary_range_min`, and `salary_range_max`; UI wording depends on which is authoritative. |

## Implementation Ordering

1. Add compensation domain value objects and deterministic posted salary parser with fixtures.
2. Persist `job_salary_facts` and project posted salary audit into list/detail read models.
3. Replace scoring's ad hoc `_salary_max` path with canonical posted salary facts for profile-floor eligibility warnings/blockers.
4. Add public baseline adapter: O*NET/SOC mapping plus BLS OEWS cache.
5. Add optional provider registry and disabled-by-default Levels.fyi adapter shape.
6. Surface `SalaryAudit` in Jobs overview and audit triage with source trail and unknown states.

## Sources

- JobHunter repo context: `.planning/PROJECT.md`, `docs/architecture.md`, `docs/job-pipeline-architecture.md`, `docs/local-ts-api.md`, `workers/automation/src/jobhunter/domain/discovery/value_objects.py`, `workers/automation/src/jobhunter/domain/scoring/services.py`, `apps/api/src/read-model.ts`, `apps/web/src/views/jobs/JobOverview.tsx`, `apps/web/src/views/jobs/JobAuditTriage.tsx`.
- Levels.fyi API access page: https://www.levels.fyi/api-access/
- Levels.fyi data/benchmarking offering: https://www.levels.fyi/offerings/data/
- Glassdoor Terms of Use: https://www.glassdoor.com/about/terms/
- Glassdoor Jobs API documentation: https://www.glassdoor.com/developer/jobsApiActions.htm
- BLS OEWS home: https://www.bls.gov/oes/
- BLS OEWS documentation: https://www.bls.gov/oes/oes_doc.htm
- BLS Public Data API getting started and FAQ: https://www.bls.gov/developers/home.htm and https://www.bls.gov/developers/api_faqs.htm
- O*NET Web Services and reference manual: https://services.onetcenter.org/ and https://services.onetcenter.org/reference/
- O*NET OnLine external data source freshness: https://www.onetonline.org/help/online/datasources
- DOL OFLC disclosure/performance data: https://www.dol.gov/agencies/eta/foreign-labor/performance
- FLAG prevailing wages: https://flag.dol.gov/programs/prevailingwages
- Salary.com API overview: https://developers.salary.com/apis/welcome
