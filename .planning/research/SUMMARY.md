# Project Research Summary

**Project:** JobHunter v1.3 Salary Range Estimator
**Domain:** Local-first compensation evidence, salary estimation, and Jobs triage audit
**Researched:** 2026-06-19
**Confidence:** HIGH for repo integration, audit architecture, posted salary parsing, and source-access constraints; MEDIUM for commercial provider availability until access is confirmed

## Executive Summary

JobHunter v1.3 should make compensation evidence inspectable in the same trust-first style as the existing job and materials audit surfaces. Experts build this kind of feature by separating employer-posted facts from benchmark estimates, preserving source provenance, modeling uncertainty explicitly, and refusing to turn weak compensation data into hidden ranking or apply gates.

The recommended approach is to build an Enrichment-owned compensation assessment path on the existing local-first stack: deterministic posted salary extraction, canonical SQLite compensation/provenance rows, projection-backed Operations read models, typed contracts, and Jobs list/drawer components that render salary facts as audit evidence. The source strategy should be tiered: posted salary first, optional licensed Levels.fyi-style tech benchmarks second, public BLS/O*NET baselines third, optional OFLC corroboration for U.S. employer/location evidence, and no Glassdoor scraping.

The main risks are source legality, false precision, lossy normalization, and projection drift between Python and TypeScript. Mitigate them with a salary-source registry, disabled-by-default external adapters, first-class insufficient-evidence states, separate parse and market confidence, canonical rows before UI rendering, projection parity tests, and QA fixtures that prove market estimates do not silently alter fit score, apply readiness, or queue eligibility.

## Key Findings

### Recommended Stack

Use the current JobHunter architecture. Do not introduce a new service, scraper platform, analytics database, charting library, or frontend-only estimator. Salary facts need canonical provenance and must flow through the same worker/API/projection/UI path as other audit claims.

**Core technologies:**
- Python worker domain services: deterministic posted compensation parser, market estimator, source registry, confidence scoring, and repository orchestration.
- SQLite canonical tables: persisted compensation assessments, posted salary facts, market estimates, and source evidence.
- Existing projection builders: Python and TypeScript projection paths must both emit compensation summary/detail JSON.
- `packages/contracts` and domain types: shared DTOs for compensation ranges, posted facts, market estimates, source evidence, and confidence.
- TanStack Query through Operations hooks: Jobs views consume projected compensation data; views do not recompute salary logic.
- Enrichment frontend context components: reusable salary range, confidence, source trail, and triage panel components composed by Jobs views.

**Recommended source/integration strategy:**
- Posted job salary text is the primary source and should always preserve raw/source text.
- BLS OEWS plus O*NET title/SOC mapping is the safest public default baseline.
- OFLC/H-1B disclosure can be an optional U.S. corroborator, labeled as visa/LCA-biased.
- Levels.fyi is optional and licensed only. Build a disabled adapter seam unless the user has approved API/MCP/CLI/data access.
- Glassdoor must not be scraped. Use only with explicit partner/API access or written permission.
- Unofficial scraper marketplaces should be excluded from v1.3.

### Expected Features

**Must have (table stakes):**
- Posted salary extraction with source text, normalized range, currency, period, compensation type, parse confidence, and warnings.
- Clear separation between "Posted" compensation and "Market estimate".
- Market estimate only when matching evidence supports role, location, seniority, company, and compensation component.
- Source provenance for every market range: source type, captured value, freshness, sample/source count where available, match quality, caveats, and allowed access mode.
- Visible statistical confidence at decision points, with an inspectable factor breakdown in the drawer.
- Profile-floor comparison rendered as an audit concern, not an opaque automatic filter.
- Jobs list triage cell or compact group for posted range, estimate, confidence, missing state, and below/near/above floor.
- Jobs drawer compensation audit section with source trail, assumptions, warnings, and skipped/unavailable reasons.
- Honest empty states for no posted salary, unsupported source access, stale data, insufficient evidence, and unparseable text.

**Should have (differentiators):**
- Source agreement/conflict score when multiple source families exist.
- Comparable-role and seniority mapping assumptions shown in the drawer.
- Freshness decay indicator that lowers confidence and explains stale evidence.
- Compensation component labeling for base, total compensation, OTE, bonus, commission, equity, hourly, monthly, and contract rates.
- "Why not estimated?" explanation for skipped market estimates.
- Source quality registry with access mode, terms URL, license status, attribution, freshness policy, and disabled reason.

**Defer (v2+):**
- Negotiation anchor recommendations.
- Deep equity/RSU vesting math.
- Automatic salary-based ranking, filtering, or blockers from market estimates.
- Broad commercial source marketplace.
- Full currency conversion/PPP system beyond explicit, audited conversions.
- AI-based broad salary extraction unless a later phase proves deterministic parsing is insufficient.

### Architecture Approach

Salary should be a typed Enrichment-owned compensation assessment projected into Operations read models. Keep raw `JobMetadata.salary` as legacy discovery metadata, but do not overload it as the normalized source of truth. Persist canonical salary facts and benchmark observations before adding UI, and keep profile-floor comparison derived for presentation unless requirements demand historical replay.

**Major components:**
1. Compensation value objects and contracts — `CompensationRange`, posted fact union, market estimate union, source evidence, confidence, and audit/summary DTOs.
2. Posted compensation parser — deterministic parser over `jobs.salary`, description snippets, and full posting text with source spans and warnings.
3. Source registry and market-source adapters — disabled-by-default external adapters behind explicit access modes and anti-corruption layers.
4. Market estimator and confidence service — combines evidence volume, source agreement, recency, role/location/seniority/company match, dispersion, and component/currency certainty.
5. Canonical persistence — assessments, posted facts, market estimates, and source evidence rows keyed by tenant/job/version.
6. Projection/read model — `compensation_summary_json` on list projections and `compensation_audit_json` on detail projections, emitted by both Python and TypeScript builders.
7. Jobs triage UI — Enrichment-owned compensation components composed into Jobs list, `JobOverview`, and `JobAuditTriage`.

### Statistical Confidence Model Guidance

Use two independent confidence tracks: posted parse confidence and market estimate confidence. Do not collapse them into one generic badge in the data model.

Parse confidence should increase with explicit salary fields, clear two-sided ranges, known currency/period, exact source spans, and low component ambiguity. It should decrease for body-text-only matches, multiple unrelated numbers, OTE/equity/commission language, missing period/currency, one-sided ranges, broad ranges, hourly/monthly assumptions, and gross/net ambiguity.

Market confidence should be computed from evidence, not provider branding. Inputs should include source count, sample count, data freshness, source agreement/dispersion, company match, role/title match, seniority/level match, location/remote-scope match, compensation component match, currency/period certainty, and source access reliability. Show `insufficient_evidence` rather than a range when minimum thresholds fail. When shown, estimates should be rounded to sensible bands and labeled as benchmark estimates, not offers or truth.

### Critical Pitfalls

1. **Scraping salary sources without a valid access basis** — prevent with a source registry, disabled-by-default adapters, documented terms/access mode, and tests proving unauthorized sources return access-policy unavailable states.
2. **Presenting estimates as truth** — prevent with confidence factors, source/sample counts, wide ranges for weak evidence, and explicit insufficient-evidence states.
3. **Aggressive normalization of currency, period, and compensation type** — preserve original source text, components, assumptions, warnings, and conversion source/date whenever conversion occurs.
4. **Reintroducing opaque gates through market salary data** — only posted salary facts with visible source spans may drive default below-floor blockers; market estimates produce advisory warnings unless a future explicit opt-in changes policy.
5. **Missing source-of-truth audit rows** — do not compute salary claims in React or API read-time helpers; persist canonical backend rows and project them.
6. **Projection drift** — update Python and TypeScript projection builders together and add parity fixtures so either refresher preserves compensation data.
7. **Sensitive data leakage** — keep profile floors, credentials, raw benchmark pages, local paths, source payloads, logs, and fixtures redacted or synthetic.

## Implications for Roadmap

Based on research, suggested phase structure:

### Phase 1: Compensation Domain Model And Source Policy
**Rationale:** The feature needs typed states, provenance, and access rules before parsing or external calls can be trusted.
**Delivers:** Python value objects, TypeScript contract/domain-type mirrors, source registry shape, external source access-policy states, and initial invariants.
**Addresses:** Posted-vs-estimated separation, source provenance, confidence semantics, Glassdoor/Levels handling.
**Avoids:** Scraping by default, overloaded salary vocabulary, and high-confidence estimates with zero sources.

### Phase 2: Posted Salary Extraction And Canonical Persistence
**Rationale:** Posted compensation is the highest-provenance source and provides immediate local value without external dependency.
**Delivers:** Deterministic parser, source spans, raw text preservation, normalized posted facts, parser warnings, canonical SQLite rows, and parser fixtures.
**Addresses:** Structured posted salary extraction, normalized compensation model, parse confidence, honest unparseable/not-found states.
**Avoids:** Existing lossy `_salary_max` behavior becoming the v1.3 audit source.

### Phase 3: Projection Path And Profile-Floor Comparison
**Rationale:** Jobs list/drawer must consume projected audit facts, not recompute compensation in UI or API read helpers.
**Delivers:** `compensation_summary_json`, `compensation_audit_json`, read-model DTOs, Operations hook types, SSE invalidation for compensation assessment, projection parity tests, and profile-floor comparison states.
**Addresses:** Jobs list triage, drawer audit source of truth, below/near/above floor display, legacy raw salary compatibility.
**Avoids:** Projection drift, UI-only audit claims, and hidden compensation gates.

### Phase 4: Public Baseline And Optional Licensed Adapter Seams
**Rationale:** Market estimates require provider constraints, source matching, and insufficient-evidence states before UI can make them useful.
**Delivers:** Market source port, BLS/O*NET baseline path or cache strategy, optional OFLC import seam, disabled Levels.fyi adapter shape, explicit Glassdoor blocked/unavailable handling, source evidence rows, and estimator confidence scoring.
**Addresses:** Market salary estimation, source trail, source count/sample count, freshness, agreement/conflict, "why not estimated" states.
**Avoids:** Unlicensed Glassdoor/Levels usage, false precision, geography/seniority mismatch, and slow/brittle Discover failures.

### Phase 5: Jobs Triage UI And Product QA
**Rationale:** UI should land after contracts/projections so every displayed claim has an owning source of truth.
**Delivers:** Enrichment-owned compensation components, Jobs table/list salary cell, `JobOverview` structured display, `JobAuditTriage` compensation panel, stories/component tests/a11y checks, and product-path QA with synthetic seeded jobs.
**Addresses:** User-facing table stakes, confidence at point of decision, source trail, missing states, mobile/desktop rendering, audit-first floor comparison.
**Avoids:** Salary estimates looking like hard truth, layout crowding, and market estimates changing fit/apply readiness.

### Phase 6: Refresh And User Correction Loop
**Rationale:** Manual refresh and corrections are useful only after the base audit model is stable.
**Delivers:** Optional refresh mutation, on-demand market estimation workflow, parse correction persistence or deferral decision, cache freshness behavior, and retry/failure UI.
**Addresses:** Freshness decay, user correction loop, source outage handling, future provider expansion.
**Avoids:** Making Discover slow or brittle and replacing accepted audit facts with failed refresh attempts.

### Phase Ordering Rationale

- Model/source policy first because Levels.fyi, Glassdoor, public data, and manual/licensed sources have different legality, provenance, and display constraints.
- Posted extraction before market estimation because it is local, auditable, and the only compensation signal appropriate for default below-floor blockers.
- Projection/read-model work before UI because audit surfaces must render persisted source-of-truth data.
- Market adapters after projection because unsupported/insufficient states need the same read-path as successful estimates.
- UI and QA last because the product-path tests should exercise the real contracts and seeded projection states.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 4:** External integration details. Confirm current BLS/OEWS table/API strategy, O*NET access credentials, Levels.fyi license/access mode, OFLC import scope, and whether Glassdoor is explicitly licensed.
- **Phase 4:** Statistical thresholds. Define minimum source/sample counts, freshness decay windows, agreement/dispersion bands, remote-location assumptions, and confidence bucket boundaries.
- **Phase 6:** Correction and refresh policy. Decide whether user corrections become canonical facts, annotations, or deferred backlog.

Phases with standard patterns (skip research-phase):
- **Phase 1:** Local value objects/contracts/source registry shape follows established JobHunter DDD and contract patterns.
- **Phase 2:** Deterministic parser fixtures and SQLite persistence are standard local-first domain work.
- **Phase 3:** Projection/read-model/SSE invalidation follows existing Operations architecture, though parity tests are required.
- **Phase 5:** Jobs view composition and context-owned frontend components follow existing frontend target architecture.

## Concrete Requirement Implications For v1.3

- Every displayed salary range must identify whether it is employer-posted, parsed from posting text, benchmark-derived, public baseline, licensed commercial, manual, or unavailable.
- Glassdoor is out of default scope unless explicit partner/API access or written permission exists. Requirements should state "do not scrape Glassdoor."
- Levels.fyi support should be a disabled optional adapter unless a license/API/MCP/CLI/data-stream arrangement is confirmed. Do not store or redistribute raw data beyond license permissions.
- Public baselines should be labeled as occupation/location aggregates, not company-specific market truth.
- The MVP should support `not_found`, `unparseable`, `ambiguous`, `posted_range`, `not_requested`, `unsupported`, `insufficient_evidence`, and `estimated_range` states.
- Profile-floor comparison must name whether it used posted salary or market estimate. Default blockers may use posted salary only; market estimates are advisory warnings.
- Currency, period, base/total/OTE/equity/bonus/hourly/monthly/gross/net assumptions must be preserved and rendered as warnings when ambiguous.
- The Jobs drawer must show source text or allowed excerpt for posted facts and source evidence rows for market estimates.
- API events should mark compensation assessments dirty but should not include raw source payloads, secrets, or profile salary preferences.
- QA must include synthetic fixtures for below-floor posted salary, above-floor posted salary, no posted salary, unparseable salary, broad range, OTE/equity ambiguity, low-confidence benchmark, high-confidence licensed benchmark, stale source, source conflict, currency/period ambiguity, and Europe/remote location mismatch.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Strong repo fit: existing Python worker, SQLite, projections, contracts, Operations hooks, and Jobs audit surfaces support the feature without new infrastructure. |
| Features | HIGH | Table stakes are consistent across posted salary UX, pay transparency expectations, benchmark-source behavior, and JobHunter's audit-first product direction. |
| Architecture | HIGH | Recommended ownership aligns with current DDD/frontend target architecture and avoids a premature ninth bounded context. Projection parity remains a known implementation risk. |
| Pitfalls | HIGH | Source-access, false precision, normalization, gating, audit-source, and privacy risks are well supported by official source terms and repo constraints. |
| External providers | MEDIUM | Glassdoor restrictions are clear enough to exclude default scraping; Levels.fyi licensed access is plausible but requires a user/provider decision before implementation. |
| Statistical thresholds | MEDIUM | Confidence factors are clear, but exact bucket boundaries and minimum source/sample thresholds need requirements-level decisions. |

**Overall confidence:** HIGH for roadmap direction; MEDIUM for provider-specific implementation until access and licensing are confirmed.

### Gaps to Address

- Levels.fyi access: confirm whether the user has or wants paid/API/MCP/CLI/data-stream access and what retention/redistribution is allowed.
- Glassdoor access: confirm whether explicit partner/API access or written permission exists; otherwise exclude it from implementation.
- Geography: define whether v1.3 targets U.S.-only public baselines or must support Spain/Europe roles with separate public sources or low-confidence unsupported states.
- Compensation scope: decide whether estimates are base salary only, total compensation, OTE, or component-separated display.
- Remote mapping: define how remote U.S., Europe remote, global remote, and company-HQ markets should affect estimates.
- Profile floor: decide which profile field is canonical for "floor" and whether comparisons use annualized base pay only.
- Confidence thresholds: define minimum source/sample counts, freshness cutoffs, role/location/seniority match requirements, and rounding bands.
- Market workflow: decide whether market estimation is automatic for every enriched job, on-demand in the drawer, or automatic only after a fit-score threshold.

## Sources

### Primary (HIGH confidence)
- `.planning/PROJECT.md` — v1.3 goal, target features, active requirements, local-first/audit constraints.
- `.planning/research/STACK.md` — recommended source strategy, stack additions, data model, confidence model, and integration points.
- `.planning/research/FEATURES.md` — table stakes, differentiators, anti-features, UX facts, and MVP recommendation.
- `.planning/research/ARCHITECTURE.md` — bounded-context ownership, domain model, persistence/projection/read-model flow, ports, pipeline integration, and build order.
- `.planning/research/PITFALLS.md` — critical/moderate/minor pitfalls, source constraints, privacy/security risks, preventive requirements, and QA recommendations.
- JobHunter architecture docs cited by researchers: `docs/architecture.md`, `docs/frontend-target.md`, `docs/job-pipeline-architecture.md`, `docs/local-ts-api.md`, `docs/local-reliability-qa.md`.
- Official source constraints cited by researchers: Glassdoor Terms of Use, Levels.fyi Terms/API/data offering, BLS OEWS, O*NET Web Services, DOL OFLC disclosure data, ECB FX reference rates, OECD/World Bank PPP references, and European Commission pay-transparency explainer.

### Secondary (MEDIUM confidence)
- Glassdoor salary behavior/help/blog sources — useful for user-facing salary UX patterns, but not an implementation license.
- Levels.fyi public salary/product pages — useful for role/level/TC/freshness patterns, but API/data use requires licensed access confirmation.
- LinkedIn/Indeed/pay-transparency examples — useful for market UX expectations and missing/broad salary handling.
- Nielsen Norman Group and UK Government uncertainty guidance — useful for communicating ranges and uncertainty.

### Tertiary (LOW confidence)
- Unofficial scraper marketplaces or reverse-engineered salary data APIs — excluded from v1.3 because they do not resolve underlying source rights and add brittle infrastructure.

---
*Research completed: 2026-06-19*
*Ready for roadmap: yes*
