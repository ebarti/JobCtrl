# Domain Pitfalls

**Domain:** Salary range estimation for a local-first job-search automation app
**Project:** JobHunter v1.3 Salary Range Estimator
**Researched:** 2026-06-19
**Overall confidence:** HIGH for source-access risks and audit architecture; MEDIUM for source-specific data-quality behavior because salary platforms expose limited methodology.

## Research Bottom Line

Build the salary estimator as an audit feature, not a ranking oracle. Posted salary extraction can be deterministic and high-confidence when the source span is visible. External market estimates must be optional, source-licensed, provenance-backed, and shown with explicit uncertainty. Do not scrape Glassdoor or Levels.fyi by default. Treat them as named source adapters that are disabled unless their current terms and access mode allow the specific use.

For JobHunter, the safest design is: `posted compensation fact` first, `licensed/manual market benchmarks` second, `profile-floor comparison` third, and no automatic apply/ranking gate from an opaque market estimate. Persist canonical salary facts and benchmark observations in the owning backend layer, project them into the Jobs detail read model, and render missing/uncertain data explicitly in `JobAuditTriage`.

## Critical Pitfalls

### Pitfall 1: Scraping Salary Sources Without a Valid Access Basis

**What goes wrong:** The estimator silently crawls Glassdoor, Levels.fyi, or a third-party scraper API and stores salary data as if it were freely reusable.

**Why it happens:** Public salary pages feel like ordinary web data, but salary platforms impose source-specific terms, login gates, paywalls, anti-bot rules, attribution rules, and commercial-use restrictions.

**Consequences:** Legal/TOS exposure, brittle integrations, user account lockouts, blocked IPs, unusable roadmap work, and a product surface that cannot explain where a range came from or whether JobHunter was allowed to use it.

**Prevention:**
- Ship a salary-source registry before any external fetcher. Each source must declare `access_mode`, `terms_url`, `license_status`, `attribution_required`, `supports_api`, `supports_manual_entry`, `supports_public_reference`, `allowed_fields`, `freshness_policy`, and `disabled_reason`.
- Default external sources to `disabled` unless the adapter has a documented permitted mode: licensed API/MCP/CLI, official export, user-entered benchmark, or specifically allowed public structured data with attribution.
- Do not use third-party Glassdoor/Levels scraper products as a compliance shortcut. A vendor API may solve transport, but it does not prove JobHunter has rights to use or redistribute the underlying data.
- Store source references and captured values, not raw pages, unless the source terms and privacy posture explicitly allow retention.
- Require an adapter-level test that unauthorized sources return `unavailable_due_to_access_policy` instead of fetching.

**Detection:**
- Code contains raw `fetch`, browser automation, reverse-engineered endpoints, or scraper libraries targeting salary pages.
- A benchmark row lacks `terms_url`, `source_url`, `captured_at`, and `access_mode`.
- UI shows source names without the access status or attribution required by the source.

**Research notes:**
- Glassdoor terms say services are personal/non-commercial unless separately approved and prohibit automated agents or scraping/mining data without express written permission.
- Glassdoor also has a developer registration page, but it requires login and ties keys to a Glassdoor account; do not assume broad public salary API availability without an approved key and current API terms.
- Levels.fyi terms define Salary Data as proprietary, generalized-comparison data with no warranty, and prohibit manual or automated scraping/crawling/spidering pages as a harmful act.
- Levels.fyi separately advertises API/MCP/CLI access through a request form and enterprise data products. That supports a licensed adapter path, not default scraping.
- Some Levels.fyi pages advertise AI-readable structured `.md` resources with attribution and guidelines. Treat that as source-specific public-reference support only after checking the current `robots.txt`/`llms.txt` guidance and terms for the exact intended use.

### Pitfall 2: Presenting Estimates as Truth Instead of Statistical Claims

**What goes wrong:** The UI displays `$180K - $220K market range` as a confident fact when the estimate came from a handful of stale, mismatched, or broad-title observations.

**Why it happens:** Salary products expose polished numbers, but compensation varies by title taxonomy, job family, seniority, company size, location, work arrangement, date, equity liquidity, bonus/commission mix, and source coverage.

**Consequences:** Users over-trust weak estimates, reject good jobs, anchor negotiations incorrectly, or lose faith when a posted salary disagrees with the estimate.

**Prevention:**
- Store confidence as an evidence computation, not a label from one source. Inputs should include sample/source count, recency, role-title match, seniority match, location match, company match, currency/period certainty, source agreement, dispersion, and access reliability.
- Require `confidence_band` plus `confidence_reasons`, not just `high/medium/low`.
- Use wide intervals for weak evidence and show `insufficient evidence` when minimum thresholds fail.
- Never show one precise percentile unless the source provides that percentile and enough provenance to support it.
- Display market estimates as "benchmark estimate", not "salary", "expected offer", "fair pay", or "what they will pay".
- Keep posted salary and market benchmark separate. A posted employer range is a source-backed job fact; a benchmark is an external comparison.

**Detection:**
- UI renders a single market number without sample count/source count.
- Tests can pass with `confidence=high` but zero sources.
- Estimate confidence does not change when role/location/seniority match quality is degraded.

### Pitfall 3: Normalizing Currency, Period, and Compensation Type Too Aggressively

**What goes wrong:** A parser converts `€70k OTE`, `$80/hr`, `£90,000 + equity`, or `up to 120k gross` into a clean annual base salary range without preserving assumptions.

**Why it happens:** Existing `ConstraintChecker` salary parsing already extracts numeric maxima for eligibility checks, but v1.3 needs a richer compensation model than "max annual number".

**Consequences:** Incorrect profile-floor blockers, misleading comparisons across countries, loss of bonus/equity semantics, and hard-to-debug user complaints.

**Prevention:**
- Model compensation components explicitly: `base`, `total_comp`, `OTE`, `bonus`, `commission`, `equity`, `hourly`, `monthly`, `annual`, `gross`, `net`, `unknown`.
- Preserve the original source span and parse warnings for every normalized fact.
- Do not convert hourly/monthly/contract rates to annual unless hours, months, or working schedule assumptions are explicit and displayed.
- Currency conversion must store `from_currency`, `to_currency`, `rate`, `rate_source`, `rate_date`, and whether the conversion is spot FX or PPP/cost-of-living adjusted.
- Prefer ECB reference rates for EUR-based spot FX display and label them informational. Prefer OECD/World Bank PPP only for optional purchasing-power context, never as the canonical offered salary.
- Keep gross/net unknown visible, especially for Europe.

**Detection:**
- A test fixture with hourly, monthly, OTE, equity, and ambiguous `k` values produces no parse warnings.
- Converted values lack exchange-rate source/date.
- Profile-floor comparison uses a converted estimate without showing the basis.

### Pitfall 4: Reintroducing Opaque Gates Through Salary Data

**What goes wrong:** Market estimates silently affect job ranking, apply readiness, or blockers, contradicting the v1.3 requirement to keep uncertain compensation audit-first.

**Why it happens:** The current scoring path already has deterministic compensation blocker logic against posted salary/profile minimums. It is tempting to extend that to external estimates.

**Consequences:** Jobs disappear or look blocked because of weak market data; users cannot tell whether a job failed due to the employer-posted range or a third-party benchmark.

**Prevention:**
- Only a parsed posted salary with a visible source span should be eligible for deterministic `below profile floor` blocker behavior.
- External benchmark estimates may produce warnings or comparison copy, not blockers, unless the user explicitly opts into salary-based filtering and the source confidence meets documented thresholds.
- Render lifecycle labels: `posted salary parsed`, `market estimate computed`, `market estimate unavailable`, `below profile floor based on posted range`, `below profile floor based on user opt-in market estimate`.
- Update scoring QA to prove market estimates do not change `fitScore`, `applyAudit.state`, or apply readiness by default.

**Detection:**
- A job with no posted salary but a low market estimate becomes blocked.
- Changing a market source fixture changes fit-score color, apply readiness, or queue eligibility.
- JobAuditTriage cannot tell whether floor comparison used posted salary or market data.

### Pitfall 5: Missing Source-of-Truth Audit Rows

**What goes wrong:** Salary facts are computed in the TypeScript read model or React component from raw job text and benchmark payloads instead of persisted canonical rows.

**Why it happens:** The Jobs drawer is already a convenient composer and current salary parsing in scoring is utility-style. That path is too shallow for v1.3 auditability.

**Consequences:** TS/Python drift, stale projections, UI-only facts with no event history, impossible regression fixtures, and a repeat of prior audit risks where read-time recomputation diverged from generated artifacts.

**Prevention:**
- Add canonical backend tables/records for salary facts and benchmark observations before UI work.
- Projection builders in Python and TypeScript must produce the same read-model JSON from canonical rows.
- Job detail should expose salary audit data through Operations read hooks; `JobAuditTriage` should only render the projected contract.
- Every displayed range needs `source_kind`, `source_label`, `source_url_or_reference`, `captured_at`, `freshness`, `raw_value`, `normalized_value`, `warnings`, and `confidence`.

**Detection:**
- `JobAuditTriage` imports parser functions or computes currency/seniority matching.
- Salary UI tests seed only component props, not canonical salary projection fixtures.
- API response contains salary display strings but no audit facts behind them.

## Moderate Pitfalls

### Pitfall 1: Bias From Crowdsourced and Platform-Specific Data

**What goes wrong:** The estimator treats self-reported compensation data as representative of the labor market.

**Prevention:**
- Track source type: employer-posted, user-reported, verified user-reported, government survey, licensed benchmark, manual user note.
- Show representativeness warnings for narrow samples, self-selected crowdsourced data, tech-heavy sources, missing non-tech sectors, and small-company rows.
- Cross-check multiple source types before showing medium/high confidence.
- Do not use salary estimates for employer-side screening. JobHunter is applicant-side triage; README already warns against employer-side selection without governance.

### Pitfall 2: Geography and Work-Arrangement Mismatch

**What goes wrong:** Remote-US, Spain-local, Europe-remote, city, metro, country, and global benchmarks are blended into one range.

**Prevention:**
- Normalize location at multiple levels: city, metro/region, country, remote scope, and source-specific market.
- Confidence should drop when a benchmark is only country-level for a city-specific role or when remote scope is unknown.
- For Spain/Europe target workflows, treat US-heavy Levels.fyi/software-engineering data as low confidence unless the source supports the exact country/region and role.

### Pitfall 3: Seniority and Level Taxonomy Drift

**What goes wrong:** `Senior Software Engineer`, `Staff`, `Engineering Manager`, `Tech Lead`, and local title variants are mapped to the wrong benchmark level.

**Prevention:**
- Store title match and seniority match separately.
- Persist assumptions: `assumed_seniority`, `source_level`, `mapping_confidence`, `mapping_reason`.
- Use "not enough level evidence" instead of falling back to a broad role average for senior roles.
- QA should include fixtures where title and level disagree, such as `Lead Engineer` IC vs manager.

### Pitfall 4: Posted Range Compliance Overreach

**What goes wrong:** The UI implies a missing or broad salary range is illegal.

**Prevention:**
- Show "no posted range found" or "range is broad/ambiguous", not legal conclusions.
- If jurisdictional context is added later, gate it behind a specific legal-source module. The EU pay transparency rules are taking effect across the EU and require employers to inform job seekers about starting salary or pay range in the vacancy notice or before interview, but implementation and enforcement remain jurisdiction-specific.

### Pitfall 5: Freshness Decay Is Ignored

**What goes wrong:** A 2022 benchmark is shown beside a 2026 posting without warning.

**Prevention:**
- Store `observed_at`, `published_at`, `source_updated_at`, and `captured_at` separately when available.
- Degrade confidence by age and show stale-source warnings.
- For sources that update daily or expose "last updated", retain that in provenance.

## Minor Pitfalls

### Pitfall 1: Overloaded "Salary" Vocabulary

**What goes wrong:** Users cannot tell whether a range means base pay, total compensation, OTE, or posted employer range.

**Prevention:** Use component-specific labels: `Posted base range`, `Posted total/OTE`, `Market total-comp estimate`, `Market base estimate`, `Profile floor comparison`.

### Pitfall 2: False Precision in Display Formatting

**What goes wrong:** Converted estimates render as `$183,247 - $219,812`, implying precision the data does not support.

**Prevention:** Round benchmark estimates to sensible buckets, preserve exact raw values in the audit drawer, and show exactness only for parsed posted values when the source text is exact.

### Pitfall 3: Sensitive Data in Fixtures, Logs, and Telemetry

**What goes wrong:** Salary source payloads, user profile floor, raw job text, or benchmark rows leak into committed fixtures, logs, screenshots, or Langfuse traces.

**Prevention:** Use synthetic salary fixtures only; redact raw source pages; log identifiers/counts/warnings rather than raw compensation payloads; never include user profile salary preferences in domain events beyond safe comparison facts.

## Security And Privacy Risks

| Risk | Impact | Prevention |
| --- | --- | --- |
| User credentials for salary platforms stored in JobHunter | Account compromise and TOS exposure | Do not collect Glassdoor/Levels credentials. Use official API keys/contracts only, stored like other secrets in local `.env`, never in SQLite events/projections. |
| Raw benchmark pages retained locally | Copyright/privacy retention risk | Store normalized observations, source URL/reference, and small allowed excerpts only when permitted. |
| Profile compensation floor exposed in UI events/logs | Sensitive personal preference leak | Keep floor comparison local, redact in event payloads, and avoid telemetry export of full profile compensation fields. |
| External requests include job/profile context | Job search privacy leak to providers | Query only role/location/seniority/company fields needed for benchmark lookup; never send resume, generated materials, or application status. |
| Third-party scraper dependencies | Supply-chain and legal ambiguity | Avoid scraper dependencies. If a licensed vendor is used later, isolate behind a port and record license/source provenance. |
| Currency-rate or source API outages | Stale or missing estimates | Fail closed with `market estimate unavailable`, not cached stale values pretending to be current. |

## Preventive Requirements

1. **Salary source registry:** Every external source must have explicit access mode, terms URL, attribution requirement, license status, freshness policy, supported fields, and disabled reason.
2. **Canonical salary facts:** Persist posted salary facts and market benchmark observations before projection/UI rendering.
3. **Source provenance contract:** Every displayed range must identify source type, source label, source URL/reference, captured value, normalized value, captured date, freshness, confidence, sample/source count when available, warnings, and assumptions.
4. **Confidence model:** Confidence must combine evidence volume, recency, source agreement, dispersion, role match, seniority match, location match, currency/period certainty, and source access reliability.
5. **No opaque gating:** Market estimates must not block, hide, rank, or apply-filter jobs by default. Posted salary/profile-floor blockers must name the posted source span.
6. **Currency/location normalization:** FX or PPP conversions must retain rate source/date and be labeled. Location scope and work arrangement must be explicit.
7. **Component separation:** Base, total compensation, OTE, bonus, commission, and equity must remain distinct until a source explicitly supports total-comp comparison.
8. **Privacy by design:** Do not store credentials for consumer salary sites, raw pages, raw profile salary preferences in events, or sensitive source payloads in fixtures/logs.
9. **Adapter failure states:** Unsupported, paywalled, access-denied, rate-limited, stale, and insufficient-evidence outcomes must be first-class user-visible states.
10. **Attribution:** If a source requires attribution, the UI and exported audit data must include it automatically.

## QA Recommendations

### Backend/domain tests

- Posted salary parser fixtures for exact range, single value, `k` suffix, European decimals, hourly, monthly, OTE, equity, bonus, commission, gross/net unknown, multiple currencies, and no salary.
- Market confidence fixtures where confidence degrades for low sample count, stale data, broad geography, wrong seniority, source disagreement, missing currency basis, and unauthorized source access.
- Source registry tests proving Glassdoor/Levels-style sources are disabled without explicit allowed access mode.
- Profile-floor tests proving only posted salary facts can create default blockers; market estimates create warnings unless a future user opt-in says otherwise.
- Projection parity fixture for salary facts and benchmark observations across Python and TypeScript projection builders.

### API/read-model tests

- `JobDetail` exposes salary audit facts from canonical rows, not UI recomputation.
- Missing benchmark data returns explicit `unavailable` reasons.
- API responses redact raw pages, profile salary preferences, secrets, local paths, and source payloads beyond allowed excerpts.
- SSE invalidation covers salary fact/benchmark updates so the Jobs drawer refreshes without manual reload.

### Frontend tests

- `JobAuditTriage` renders posted salary, market estimate, confidence, warnings, source trail, freshness, and profile-floor comparison from the Operations read hook contract.
- Low-confidence benchmark renders as uncertain and does not change fit-score badge, apply readiness, or Apply Review handoff.
- Missing salary and missing benchmark states are visible, not blank.
- Long source labels, currency strings, and warning text fit in the drawer at mobile and desktop widths.
- Accessibility test for expanded salary audit details.

### Product-path QA

- Seed synthetic jobs with: posted salary below floor, posted salary above floor, no posted salary plus low-confidence benchmark, high-confidence licensed benchmark, stale benchmark, currency conversion, OTE-only role, and Europe remote role.
- Open `/jobs`, select each row, and verify the drawer explains which compensation facts are posted vs estimated and whether any floor comparison is based on posted data.
- Confirm no apply/browser automation, mailbox scanning, real external scraping, or real generated-material workflow is triggered by salary QA.

## Phase-Specific Warnings

| Phase Topic | Likely Pitfall | Mitigation |
| --- | --- | --- |
| Posted salary extraction | Existing max-salary parser is too lossy for audit | Build structured compensation facts with source spans, components, periods, currencies, and warnings. |
| External benchmark adapter | Scraping or unlicensed access sneaks in | Start with registry + disabled adapters + manual/licensed-source seams before any network fetcher. |
| Confidence scoring | Confidence becomes a subjective label | Derive confidence from recorded evidence dimensions and test degradation cases. |
| Read model | Salary facts recomputed in TS/UI | Persist canonical rows and add projection parity tests. |
| Jobs drawer UI | Salary estimate looks like a hard truth | Label posted vs benchmark, show confidence/warnings/source trail, and avoid ranking/apply gates. |
| Currency/location | Cross-country comparisons become misleading | Store FX/PPP source/date and render location/work-arrangement assumptions. |
| Privacy/security | Sensitive salary preferences leak into logs/events | Use synthetic fixtures and redact profile floors/source payloads from events and telemetry. |

## Sources

- Glassdoor Terms of Use, accessed 2026-06-19: https://www.glassdoor.com/about/terms/
  - Confidence: HIGH. Official source. Key findings: non-commercial default use; automated scraping/mining requires express written permission.
- Glassdoor developer registration/API pages, accessed 2026-06-19: https://www.glassdoor.com/developer/register_input.htm and https://www.glassdoor.com/developer/salariesApiActions.htm
  - Confidence: MEDIUM. Official pages are sparse/currently login-gated; use only to justify treating Glassdoor API access as account/approval-based.
- Glassdoor robots.txt, accessed 2026-06-19: https://www.glassdoor.com/robots.txt
  - Confidence: HIGH for crawl-policy signal, not a complete legal license.
- Levels.fyi Terms and Conditions, accessed 2026-06-19: https://www.levels.fyi/about/terms.html
  - Confidence: HIGH. Official source. Key findings: Salary Data is proprietary, approximate, no-warranty, generalized-comparison data; scraping/crawling/spidering is prohibited.
- Levels.fyi API/MCP/CLI access page, accessed 2026-06-19: https://www.levels.fyi/api-access/
  - Confidence: HIGH. Official source. Key finding: API/MCP/CLI access is request-based.
- Levels.fyi compensation data offering/pricing page, accessed 2026-06-19: https://www.levels.fyi/offerings/data/
  - Confidence: HIGH. Official source. Key findings: paid tiers, enterprise API/MCP access, data granularity, validation claims, and freshness claims.
- Levels.fyi public salary pages indexed with AI-readable `.md` and attribution notices, accessed 2026-06-19 via search results such as https://www.levels.fyi/t/software-engineer
  - Confidence: MEDIUM. Official page snippets indicate structured AI resources and attribution requirements, but implementation should verify current robots/llms guidance before use.
- U.S. Bureau of Labor Statistics OEWS research estimates, accessed 2026-06-19: https://www.bls.gov/oes/oes_research_2024.htm
  - Confidence: HIGH. Official source. Key findings: salary estimates from sample surveys have sampling and nonsampling error; PRSE is used to communicate reliability.
- European Central Bank euro foreign exchange reference rates, accessed 2026-06-19: https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html
  - Confidence: HIGH. Official source. Key findings: updated on working days; informational reference rates, discouraged for transaction use.
- OECD Purchasing Power Parities dataset, accessed 2026-06-19: https://www.oecd.org/en/data/datasets/purchasing-power-parities.html
  - Confidence: HIGH. Official source. Key finding: PPPs equalize purchasing power by eliminating price-level differences and are intended for real cross-country comparisons.
- World Bank PPP indicator, accessed 2026-06-19: https://data.worldbank.org/indicator/PA.NUS.PPP
  - Confidence: HIGH. Official/open-data source with CC BY-4.0 license; useful for PPP availability and attribution.
- European Commission pay transparency explainer, published 2026-06-05, accessed 2026-06-19: https://commission.europa.eu/news-and-media/news/new-eu-rules-pay-transparency-explained-2026-06-05_en
  - Confidence: HIGH. Official source. Key finding: EU rules require job seekers to be informed of starting salary/pay range in the vacancy notice or before interview and prohibit pay-history questions.
