# Phase 19: Europe Public Market Estimates - Research

**Researched:** 2026-06-19  
**Domain:** Europe-only public compensation market estimates, deterministic fixtures/imports, SQLite canonical facts, read-only API inspection  
**Confidence:** MEDIUM

## User Constraints (from CONTEXT.md)

All bullets in this section are copied verbatim from `.planning/phases/19-europe-public-market-estimates/19-CONTEXT.md`. [VERIFIED: repo grep]

### Locked Decisions

#### Source Scope
- Use only Europe-first public baselines in v1.3: Eurostat Structure of Earnings Survey, ESCO occupation taxonomy, and Spain INE Wage Structure Survey.
- Do not fetch, scrape, import, cache, or display Glassdoor, Levels.fyi, or non-European salary baselines in Phase 19.
- Treat ESCO as occupation mapping evidence only; it never provides salary observations or sample counts.
- Represent Eurostat and INE baselines as public occupation/location aggregates, not company-specific market ranges.

#### Estimation States
- Model market estimates as persisted immutable facts with a discriminated state, not nullable range fields.
- Use `not_requested` when no estimate request/backfill has been attempted for a job.
- Use `unsupported` for out-of-scope geography, unsupported component, missing occupation mapping, or non-Europe location.
- Use `source_unavailable` when a configured public source required for an estimate is unavailable or stale beyond policy.
- Use `insufficient_evidence` when sources exist but confidence thresholds are not met.
- Use `estimated_range` only when role/occupation, geography, seniority, component, freshness, and source support all pass threshold.

#### Confidence And Warnings
- Confidence must be inspectable by factor: occupation match, geography match, seniority match, component compatibility, freshness, sample support, and source agreement or dispersion.
- Do not emit precise-looking ranges for weak support; emit explicit insufficient-evidence reasons instead.
- Include warnings for aggregate baselines, broad aggregate bands, source conflict with posted salary, stale source snapshots, low sample count, remote-Europe assumptions, Spain-local assumptions, EU-wide assumptions, non-EU-Europe assumptions, and unknown-location assumptions.
- If posted salary and public baseline diverge materially, record a warning only; do not affect score, ranking, filtering, apply readiness, or apply dispatch.

#### Data And Persistence
- Start with deterministic local public-baseline fixture/import data so tests and local runs do not depend on live external network calls.
- Persist market estimate facts in a canonical SQLite table separate from `job_posted_compensation_facts` and separate from Phase 20 projection tables.
- Store safe source identifiers, release year/snapshot version, aggregate bucket, allowed attribution, sample count when available, and bounded factor reasons.
- Do not store raw benchmark pages, credentials, private account payloads, local paths, or user compensation preferences in market estimate rows.

#### API And Contracts
- Add typed DTOs to `packages/contracts` and a narrow read-only API endpoint so Phase 19 can be inspected before Phase 20 projection propagation.
- The endpoint may return `not_requested` for existing jobs without a persisted market estimate row, but it must not compute, backfill, or persist estimates during GET reads.
- Keep posted salary facts and market estimates separate in the API contract even when both are available for one job.
- Preserve all existing job list/detail shape and compatibility until Phase 20.

### the agent's Discretion
- Choose exact confidence thresholds and source-support scoring, provided tests prove weak evidence degrades to `insufficient_evidence` instead of a precise range.
- Choose whether the first deterministic baseline rows live in Python fixtures, seed helpers, or repository tests, provided no live external fetch path is added.

### Deferred Ideas (OUT OF SCOPE)
- Projection-backed compensation summaries, job list/detail API fields, and SSE invalidation belong to Phase 20.
- Jobs list/drawer compensation UX and profile-floor comparison belong to Phase 21.
- End-to-end product-path QA fixtures and release evidence belong to Phase 22.
- Licensed Levels.fyi or Glassdoor market data remains future work unless permitted access and Europe coverage are explicitly configured.

## Project Constraints (from AGENTS.md)

- Use repo-grounded decisions from `README.md`, `docs/local-reliability-qa.md`, `docs/local-ts-api.md`, `docs/architecture.md`, `docs/job-pipeline-architecture.md`, `docs/ddd-target.md`, `docs/frontend-target.md`, `docs/decisions.md`, `package.json`, and `workers/automation/pyproject.toml` before architecture, workflow, or QA decisions. [VERIFIED: AGENTS.md]
- Do not run auto-apply, browser submission, destructive profile/database actions, or commands that submit applications unless explicitly requested. [VERIFIED: AGENTS.md]
- When behavior changes, add or update unit tests for changed logic; when user-facing API/product behavior changes, include a QA stage that exercises the product path. [VERIFIED: AGENTS.md]
- Payloads, local generated artifacts, job/application data, credentials, resumes, cover letters, generated PDFs, browser profiles, SQLite databases, and logs are sensitive and must not be exposed unless explicitly requested. [VERIFIED: AGENTS.md]
- Every displayed auditability claim must have an explicit source of truth, and missing audit data should be computed or persisted at the owning layer instead of hidden at the UI. [VERIFIED: AGENTS.md]
- Every implementation task must happen in a dedicated worktree and not on `main`; `main` must not be left dirty. [VERIFIED: AGENTS.md]
- The existing frontend architecture forbids direct feature-code `apiClient`, `localStorage`, `navigator.clipboard`, and `EventSource` access; feature code must go through ports and context/operations boundaries. [VERIFIED: AGENTS.md]

## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SRC-02 | Use Europe-only public baseline sources: Eurostat SES, ESCO, and Spain INE Wage Structure Survey. [VERIFIED: .planning/REQUIREMENTS.md] | Source registry already exposes those three as available public sources, and official docs confirm Eurostat/INE aggregate wage datasets plus ESCO taxonomy use. [VERIFIED: apps/api/src/compensation-source-policy.ts] [CITED: https://ec.europa.eu/eurostat/web/microdata/collections-research/structure-of-earnings-survey] [CITED: https://esco.ec.europa.eu/en/about-esco/what-esco] [CITED: https://www.ine.es/dyngs/INEbase/en/operacion.htm?c=Estadistica_C&cid=1254736177025&idp=1254735976596] |
| SRC-03 | Show when a public baseline is an occupation/location aggregate rather than company-specific market range. [VERIFIED: .planning/REQUIREMENTS.md] | Store `aggregate_bucket`, `geography_scope`, `source_type`, and `attribution` in each evidence row and surface aggregate warnings in the DTO. [ASSUMED] |
| EST-01 | Show one market estimate state per job. [VERIFIED: .planning/REQUIREMENTS.md] | Use a discriminated `MarketEstimateState` persisted in a canonical SQLite table, mirroring Phase 18's explicit posted fact states. [VERIFIED: workers/automation/src/jobhunter/domain/compensation/posted.py] |
| EST-02 | Estimate only when role, occupation, geography, seniority, component, and freshness are sufficiently supported. [VERIFIED: .planning/REQUIREMENTS.md] | Compute inspectable factor scores before range output; any hard-gate failure returns `unsupported`, `source_unavailable`, or `insufficient_evidence`. [ASSUMED] |
| EST-03 | Show confidence band/score, source count, sample count when available, freshness, dispersion, and factor-level reasons. [VERIFIED: .planning/REQUIREMENTS.md] | Persist factor JSON plus normalized scalar columns for state, confidence, source count, sample count, and range bounds. [ASSUMED] |
| EST-04 | Show explicit insufficient-evidence explanations instead of market range when support is weak. [VERIFIED: .planning/REQUIREMENTS.md] | Keep range columns null unless `state = estimated_range`; require `insufficient_reasons_json` for `insufficient_evidence`. [ASSUMED] |
| EST-06 | Show assumptions for remote-Europe, Spain-local, EU-wide, non-EU-Europe, and unknown-location mappings. [VERIFIED: .planning/REQUIREMENTS.md] | Represent geography assumptions as warning codes and factor reasons, not hidden inference. [ASSUMED] |
| EST-07 | Show source conflict or broad aggregate warnings. [VERIFIED: .planning/REQUIREMENTS.md] | Compare posted annualized range to market range only to emit warnings; never feed the warning into score/ranking/apply readiness. [VERIFIED: 19-CONTEXT.md] |

## Summary

Phase 19 should implement market estimates as Python-owned, deterministic domain facts persisted to a new canonical SQLite table and inspected through a narrow TypeScript GET endpoint. [VERIFIED: 19-CONTEXT.md] [VERIFIED: docs/architecture.md] The closest existing pattern is Phase 18 posted compensation: pure Python domain logic, SQLite repository persistence, contract DTOs in `packages/contracts`, API mapping in `apps/api`, and tests that prove GET routes do not write on read. [VERIFIED: workers/automation/src/jobhunter/domain/compensation/posted.py] [VERIFIED: workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py] [VERIFIED: apps/api/test/posted-compensation-facts.test.ts]

Use Eurostat SES and Spain INE as aggregate wage evidence only, and use ESCO solely for occupation mapping evidence. [VERIFIED: 19-CONTEXT.md] Eurostat SES covers EU, candidate, and EFTA countries and has pay variables by worker/employer characteristics including occupation and location, but it is a statistical survey with anonymisation and aggregation constraints. [CITED: https://ec.europa.eu/eurostat/web/microdata/collections-research/structure-of-earnings-survey] INE's Wage Structure Survey is Spain-scoped, publishes occupation and geography wage aggregates, and documents sample-size suppression/variability thresholds that should drive low-sample handling. [CITED: https://www.ine.es/dyngs/INEbase/en/operacion.htm?c=Estadistica_C&cid=1254736177025&idp=1254735976596&menu=metodologia] ESCO is a multilingual European classification of occupations and skills, not a salary dataset. [CITED: https://esco.ec.europa.eu/en/about-esco/what-esco]

**Primary recommendation:** implement `job_market_compensation_estimates` plus a deterministic Python estimator over local fixture/import rows, then expose `GET /v1/jobs/:jobKey/compensation/market` as read-only inspection before Phase 20 projections. [ASSUMED]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| Public source support policy | API / Backend | Browser / Client | `GET /v1/compensation/sources` already owns safe source policy metadata. [VERIFIED: apps/api/src/compensation-source-policy.ts] |
| Occupation/geography/component confidence | Python Domain | SQLite / Storage | Existing compensation parsing domain is deterministic Python logic and persistence is SQLite repository-backed. [VERIFIED: workers/automation/src/jobhunter/domain/compensation/posted.py] [VERIFIED: workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py] |
| Market estimate persistence | Database / Storage | Python Infrastructure | Phase context requires canonical SQLite rows separate from posted facts and projections. [VERIFIED: 19-CONTEXT.md] |
| Read-only market estimate inspection | API / Backend | Packages / Contracts | Phase context requires typed DTOs and a narrow endpoint, while projections are deferred. [VERIFIED: 19-CONTEXT.md] |
| Jobs list/detail compensation summaries | Out of Scope | Phase 20 | Phase 20 owns projection-backed job list/detail propagation and SSE invalidation. [VERIFIED: .planning/ROADMAP.md] |
| Jobs triage UX | Out of Scope | Phase 21 | Phase 21 owns Jobs list/drawer compensation presentation. [VERIFIED: .planning/ROADMAP.md] |

## Standard Stack

### Core

| Library / Surface | Version | Purpose | Why Standard |
|-------------------|---------|---------|--------------|
| Python stdlib dataclasses / `typing.Literal` / `json` / `sqlite3` | Python 3.14.4 available locally | Pure domain objects, discriminated string unions, JSON factor fields, SQLite persistence. [VERIFIED: local command] | Phase 18 compensation facts already use these surfaces. [VERIFIED: workers/automation/src/jobhunter/domain/compensation/posted.py] |
| SQLite | 3.51.0 available locally | Canonical local fact table and fixture-backed tests. [VERIFIED: local command] | Existing JobHunter canonical rows and projections live in SQLite. [VERIFIED: docs/architecture.md] |
| Zod / TypeScript contracts | Existing workspace dependency | DTO validation and exported unions/interfaces for API/client consumers. [VERIFIED: packages/contracts/src/schemas.ts] | Existing compensation source and posted compensation contracts live in `packages/contracts`. [VERIFIED: packages/contracts/src/schemas.ts] |
| Fastify API route | Existing API stack | Narrow read-only inspection endpoint. [VERIFIED: apps/api/src/server.ts] | Existing posted compensation endpoint uses Fastify route + helper mapper. [VERIFIED: apps/api/src/server.ts] |

### Supporting

| Surface | Purpose | When to Use |
|---------|---------|-------------|
| Deterministic fixture module, e.g. `workers/automation/src/jobhunter/domain/compensation/market_fixtures.py` | Small public aggregate rows for repeatable tests and local seed/imports. [ASSUMED] | Use for Phase 19's first slice; do not add live fetchers. [VERIFIED: 19-CONTEXT.md] |
| API helper, e.g. `apps/api/src/market-compensation-estimates.ts` | Map SQLite rows to safe DTOs with warning messages. [ASSUMED] | Mirror `posted-compensation-facts.ts` without mixing posted and market facts. [VERIFIED: apps/api/src/posted-compensation-facts.ts] |

### Package Legitimacy Audit

No new external packages are recommended for Phase 19. [ASSUMED] Package legitimacy gate is not required unless implementation later proposes an install. [VERIFIED: package_legitimacy_protocol]

**Installation:**
```bash
# No install recommended.
```

## Recommended Domain Types

```python
# Source: repo Phase 18 compensation style + Phase 19 context.
MarketEstimateState = Literal[
    "not_requested",
    "unsupported",
    "insufficient_evidence",
    "estimated_range",
    "source_unavailable",
]

MarketSourceId = Literal[
    "eurostat_structure_of_earnings",
    "esco_occupation_taxonomy",
    "spain_ine_salary_structure",
]

MarketEstimateWarningCode = Literal[
    "aggregate_baseline",
    "broad_aggregate_band",
    "source_conflict_with_posted_salary",
    "stale_source_snapshot",
    "low_sample_count",
    "remote_europe_assumption",
    "spain_local_assumption",
    "eu_wide_assumption",
    "non_eu_europe_assumption",
    "unknown_location_assumption",
]
```

Recommended immutable domain object fields: `tenant_id`, `job_url`, `state`, `currency`, `period`, `component`, `minimum_amount`, `maximum_amount`, `confidence_band`, `confidence_score`, `source_count`, `sample_count`, `occupation_factor`, `geography_factor`, `seniority_factor`, `component_factor`, `freshness_factor`, `sample_factor`, `agreement_factor`, `sources`, `warnings`, `insufficient_reasons`, `estimator_version`, `estimated_at`. [ASSUMED]

Use `component = base_salary` and `period = year` for first-slice estimates unless a fixture explicitly represents gross monthly salary and the annualization basis is stored. [ASSUMED] Eurostat SES includes gross annual, monthly, and hourly earnings variables. [CITED: https://ec.europa.eu/eurostat/web/microdata/collections-research/structure-of-earnings-survey] INE reports gross annual earnings and occupation/activity/geography breakdowns. [CITED: https://www.ine.es/dyngs/Prensa/en/EAES2024.htm]

## Recommended Table Shape

Use one canonical estimate table and keep imported aggregate baselines as deterministic fixtures or test seed rows unless Phase 19 implementation needs a reusable import table. [ASSUMED]

```sql
CREATE TABLE IF NOT EXISTS job_market_compensation_estimates (
  tenant_id TEXT NOT NULL DEFAULT 'local',
  job_url TEXT NOT NULL,
  estimate_state TEXT NOT NULL,
  currency TEXT,
  period TEXT NOT NULL DEFAULT 'year',
  component TEXT NOT NULL DEFAULT 'base_salary',
  minimum_amount INTEGER,
  maximum_amount INTEGER,
  confidence_band TEXT NOT NULL DEFAULT 'none',
  confidence_score REAL NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  sample_count INTEGER,
  aggregate_bucket TEXT,
  geography_scope TEXT,
  occupation_code TEXT,
  occupation_label TEXT,
  seniority_label TEXT,
  source_snapshot_json TEXT NOT NULL DEFAULT '[]',
  factor_reasons_json TEXT NOT NULL DEFAULT '[]',
  insufficient_reasons_json TEXT NOT NULL DEFAULT '[]',
  warnings_json TEXT NOT NULL DEFAULT '[]',
  estimator_version TEXT NOT NULL,
  estimated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, job_url),
  FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_job_market_compensation_state
ON job_market_compensation_estimates (tenant_id, estimate_state);
```

Range fields must be null unless `estimate_state = 'estimated_range'`. [ASSUMED] `source_snapshot_json` should store only safe identifiers, release year/snapshot version, attribution text, source URL, geography/occupation bucket, and sample count when available. [VERIFIED: 19-CONTEXT.md] Do not store raw benchmark pages, credentials, private account payloads, local paths, or user compensation preferences. [VERIFIED: 19-CONTEXT.md]

## Confidence Factors And Thresholds

Recommended factor model: each factor returns `{ score: 0..1, band: none|low|medium|high, reason, hard_gate }`, then the estimator takes the minimum hard-gated factor plus source-agreement penalties to avoid high overall confidence hiding a weak dimension. [ASSUMED]

| Factor | Pass Recommendation | Failure State | Reasoning |
|--------|---------------------|---------------|-----------|
| Occupation match | ESCO mapping exact/preferred/known synonym >= 0.75. [ASSUMED] | `unsupported` for no mapping; `insufficient_evidence` for weak mapping. [ASSUMED] | ESCO is taxonomy evidence only, so it gates occupation compatibility but adds no salary observation. [VERIFIED: 19-CONTEXT.md] [CITED: https://esco.ec.europa.eu/en/about-esco/what-esco] |
| Geography match | Spain exact rows prefer INE; EU/Europe aggregate rows allowed only with warnings. [ASSUMED] | `unsupported` for non-Europe; `insufficient_evidence` for unknown location. [VERIFIED: 19-CONTEXT.md] | Phase context requires Europe-only handling and explicit remote/unknown assumptions. [VERIFIED: 19-CONTEXT.md] |
| Seniority match | Explicit seniority bucket or neutral aggregate fallback >= 0.60 with broad-aggregate warning. [ASSUMED] | `insufficient_evidence`. [ASSUMED] | Public aggregate surveys may not provide role-specific seniority slices at software-job precision. [ASSUMED] |
| Component compatibility | `base_salary` / gross wage compatible only; OTE, equity, bonus, commission unsupported in v1. [ASSUMED] | `unsupported`. [ASSUMED] | Current posted parser distinguishes base, OTE, bonus, commission, and equity; public wage baselines are not total compensation models. [VERIFIED: workers/automation/src/jobhunter/domain/compensation/posted.py] |
| Freshness | Source snapshot within 60 months for Eurostat SES and 24 months for INE annual rows. [ASSUMED] | `source_unavailable` when required source is stale beyond policy. [VERIFIED: 19-CONTEXT.md] | Eurostat SES is 4-yearly through 2022; INE annual latest data page shows final 2024 published 2026-05-28. [CITED: https://ec.europa.eu/eurostat/web/microdata/collections-research/structure-of-earnings-survey] [CITED: https://www.ine.es/dyngs/INEbase/en/operacion.htm?c=Estadistica_C&cid=1254736177025&idp=1254735976596] |
| Sample support | `>= 500` high; `100..499` low with warning; `< 100` insufficient/unavailable for INE-derived rows. [CITED: https://www.ine.es/dyngs/Prensa/en/EAES2024.htm] | `insufficient_evidence` for low support. [ASSUMED] | INE marks 100-500 observations as high variability and withholds fewer than 100. [CITED: https://www.ine.es/dyngs/Prensa/en/EAES2024.htm] |
| Source agreement / dispersion | If two wage sources exist, range midpoint dispersion <= 25% passes; > 25% warns and caps confidence at low/medium. [ASSUMED] | `insufficient_evidence` if dispersion is too high for a precise range. [ASSUMED] | Source conflict must be visible as warning, not hidden precision. [VERIFIED: 19-CONTEXT.md] |

Recommended overall thresholds: `estimated_range` requires all hard gates pass, no required source unavailable, overall score >= 0.72, and no critical factor below 0.60. [ASSUMED] `confidence_band = high` requires score >= 0.85 and no aggregate/stale/low-sample warning; `medium` requires >= 0.72; `low` is persisted only for `insufficient_evidence` or warning-heavy rows without range. [ASSUMED]

## API Shape

Add `GET /v1/jobs/:jobKey/compensation/market`. [ASSUMED] It should read `jobs` first, return `404` for unknown jobs, return `recordStatus: "not_requested"` for known jobs without a market row, and never compute/backfill/write during GET. [VERIFIED: 19-CONTEXT.md] [VERIFIED: apps/api/test/posted-compensation-facts.test.ts]

```typescript
export type MarketEstimateState =
  | "not_requested"
  | "unsupported"
  | "insufficient_evidence"
  | "estimated_range"
  | "source_unavailable";

export interface MarketCompensationEstimateResponse {
  ok: true;
  recordStatus: "recorded" | "not_requested";
  jobKey: string;
  estimate?: MarketCompensationEstimate;
}
```

For `estimated_range`, include `currency`, `period`, `component`, `minimumAmount`, `maximumAmount`, `confidence`, `sources`, `factors`, and `warnings`. [ASSUMED] For all non-range states, omit range fields and include `insufficientReasons`, `unsupportedReasons`, or `sourceUnavailableReasons` as applicable. [ASSUMED] Keep this endpoint separate from `GET /v1/jobs/:jobKey/compensation/posted` and do not add compensation fields to `/v1/jobs` or `/v1/jobs/:key` in Phase 19. [VERIFIED: 19-CONTEXT.md] [VERIFIED: docs/local-ts-api.md]

## Architecture Patterns

### System Architecture Diagram

```text
Local deterministic fixture/import rows
        |
        v
Python market estimator
  - ESCO occupation mapping gate
  - Europe geography gate
  - component/freshness/sample/agreement gates
        |
        +--> unsupported / source_unavailable / insufficient_evidence
        |
        +--> estimated_range with factors + warnings
        v
SQLite job_market_compensation_estimates
        |
        v
Fastify GET /v1/jobs/:jobKey/compensation/market
        |
        v
Typed contracts + API client inspection
```

### Recommended Project Structure

```text
workers/automation/src/jobhunter/domain/compensation/
├── market.py              # Market estimate value objects and deterministic estimator. [ASSUMED]
└── fixtures.py            # Deterministic Europe public aggregate rows for tests/imports. [ASSUMED]

workers/automation/src/jobhunter/infrastructure/compensation/
└── sqlite_market_repository.py  # SQLite save/get/backfill helper. [ASSUMED]

apps/api/src/
└── market-compensation-estimates.ts  # Read-only row-to-DTO mapper. [ASSUMED]

apps/api/test/
└── market-compensation-estimates.test.ts  # API inspection and no-write-on-read tests. [ASSUMED]
```

### Pattern 1: Discriminated Facts, Not Nullable Ranges

**What:** market estimate rows carry a state, and range fields are meaningful only for `estimated_range`. [VERIFIED: 19-CONTEXT.md]  
**When to use:** every market estimate read/write path in Phase 19. [VERIFIED: 19-CONTEXT.md]  
**Example:** posted facts already branch DTO shape by `parse_state` and omit normalized range fields for non-range states. [VERIFIED: apps/api/src/posted-compensation-facts.ts]

### Pattern 2: Write During Backfill/Command, Never During GET

**What:** API inspection reads canonical rows and returns explicit missing state; it does not compute or persist on demand. [VERIFIED: docs/local-ts-api.md]  
**When to use:** `GET /v1/jobs/:jobKey/compensation/market`. [ASSUMED]  
**Example:** posted compensation API tests assert no row is written when returning `not_recorded`. [VERIFIED: apps/api/test/posted-compensation-facts.test.ts]

### Anti-Patterns to Avoid

- **Frontend-only estimation:** forbidden because every displayed compensation claim needs persisted provenance and an owning backend source of truth. [VERIFIED: .planning/REQUIREMENTS.md] [VERIFIED: AGENTS.md]
- **ESCO as salary source:** forbidden because ESCO is occupation taxonomy evidence only in the locked phase scope. [VERIFIED: 19-CONTEXT.md] [CITED: https://esco.ec.europa.eu/en/about-esco/what-esco]
- **Licensed-source placeholders in estimates:** forbidden because Glassdoor and Levels.fyi must not be fetched, scraped, cached, imported, or displayed in Phase 19. [VERIFIED: 19-CONTEXT.md] [VERIFIED: apps/api/src/compensation-source-policy.ts]
- **Read-time backfill:** forbidden because the Phase 19 endpoint must not compute, backfill, or persist during GET reads. [VERIFIED: 19-CONTEXT.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Live public-data downloading | Ad hoc Eurostat/INE HTTP clients in Phase 19. [ASSUMED] | Deterministic local fixture/import rows. [VERIFIED: 19-CONTEXT.md] | Phase requires no live network dependence and repeatable tests. [VERIFIED: 19-CONTEXT.md] |
| Salary parsing | A second parser inside market estimation. [ASSUMED] | Existing `PostedCompensationFact` for posted salary conflict warnings. [VERIFIED: workers/automation/src/jobhunter/domain/compensation/posted.py] | Posted and market facts must remain separate but comparable. [VERIFIED: 19-CONTEXT.md] |
| Source policy | New source-policy logic in estimator. [ASSUMED] | Existing `compensation-source-policy.ts` identifiers and availability vocabulary. [VERIFIED: apps/api/src/compensation-source-policy.ts] | Keeps public/licensed source semantics consistent. [VERIFIED: apps/api/src/compensation-source-policy.ts] |
| Projection propagation | Jobs list/detail compensation fields. [VERIFIED: 19-CONTEXT.md] | Defer to Phase 20. [VERIFIED: .planning/ROADMAP.md] | Phase 19 is inspection-only before read-model propagation. [VERIFIED: 19-CONTEXT.md] |

## Common Pitfalls

### Pitfall 1: Precise Range From Weak Aggregates
**What goes wrong:** broad public aggregates appear as exact job-level market salary. [ASSUMED]  
**Why it happens:** aggregate occupation/location rows are easier to display than factor-level uncertainty. [ASSUMED]  
**How to avoid:** emit `insufficient_evidence` or warnings when geography, occupation, seniority, sample, freshness, or dispersion is weak. [VERIFIED: 19-CONTEXT.md]  
**Warning signs:** range fields appear with `source_count = 1`, low sample count, unknown location, or broad aggregate bucket. [ASSUMED]

### Pitfall 2: Mixing Posted Salary And Market Estimate Contracts
**What goes wrong:** consumers cannot tell employer-posted compensation from public benchmark estimates. [VERIFIED: 19-CONTEXT.md]  
**Why it happens:** both are salary-like facts attached to a job. [ASSUMED]  
**How to avoid:** separate tables, separate endpoints, separate DTOs, and explicit source type labels. [VERIFIED: 19-CONTEXT.md]  
**Warning signs:** `/v1/jobs` or `/v1/jobs/:key` shape changes in Phase 19. [VERIFIED: 19-CONTEXT.md]

### Pitfall 3: Licensed Or Non-European Data Leakage
**What goes wrong:** disabled Glassdoor/Levels seams or US taxonomies leak into public estimate output. [VERIFIED: 19-CONTEXT.md]  
**Why it happens:** source registry includes disabled licensed providers for policy transparency. [VERIFIED: apps/api/src/compensation-source-policy.ts]  
**How to avoid:** allowlist exactly the three Phase 19 source IDs in estimator fixtures and API output. [VERIFIED: 19-CONTEXT.md]  
**Warning signs:** serialized API response contains `glassdoor`, `levels`, `onet`, `soc`, `bls`, `salary.com`, or local paths. [ASSUMED]

## Code Examples

### Read-Only API Pattern

```typescript
// Source: apps/api/src/server.ts and apps/api/src/posted-compensation-facts.ts
app.get<{ Params: { jobKey: string } }>(
  "/v1/jobs/:jobKey/compensation/market",
  async (request, reply) =>
    withDb(reply, options.dbPath, (db) => {
      const response = getMarketCompensationEstimate(db, decodeRouteParam(request.params.jobKey));
      if (!response) {
        void reply.code(404);
        return { ok: false, error: "job_not_found" };
      }
      return response;
    }),
);
```

### Estimator Branching Pattern

```python
# Source: workers/automation/src/jobhunter/domain/compensation/posted.py style
if not occupation.supported:
    return MarketCompensationEstimate(state="unsupported", unsupported_reasons=("missing_occupation_mapping",))
if source_snapshot.stale:
    return MarketCompensationEstimate(state="source_unavailable", source_unavailable_reasons=("stale_source_snapshot",))
if confidence.score < ESTIMATED_RANGE_THRESHOLD:
    return MarketCompensationEstimate(state="insufficient_evidence", insufficient_reasons=confidence.reasons)
return MarketCompensationEstimate(state="estimated_range", minimum_amount=low, maximum_amount=high, warnings=warnings)
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Use licensed/private salary sites as convenient benchmark sources. [ASSUMED] | Use only Eurostat SES, ESCO taxonomy, and Spain INE public aggregates in Phase 19. [VERIFIED: 19-CONTEXT.md] | Phase 19 context gathered 2026-06-19. [VERIFIED: 19-CONTEXT.md] | The estimator must be Europe-only and public-data-only. [VERIFIED: 19-CONTEXT.md] |
| Nullable salary range fields imply missing/weak estimates. [ASSUMED] | Persist discriminated states with explicit reasons. [VERIFIED: 19-CONTEXT.md] | Phase 19 context gathered 2026-06-19. [VERIFIED: 19-CONTEXT.md] | Weak evidence becomes inspectable instead of silently blank or misleading. [VERIFIED: 19-CONTEXT.md] |
| Live data fetch during estimate read. [ASSUMED] | Deterministic local fixtures/imports and no write-on-read GET. [VERIFIED: 19-CONTEXT.md] | Phase 19 context gathered 2026-06-19. [VERIFIED: 19-CONTEXT.md] | Tests and local runs stay repeatable and network-free. [VERIFIED: 19-CONTEXT.md] |

**Deprecated/outdated:** US-first salary baselines, O*NET/BLS/SOC wage sources, Glassdoor scraping, and Levels.fyi scraping are out of scope for Phase 19. [VERIFIED: 19-CONTEXT.md]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | First-slice fixture rows should live in Python domain/test helpers rather than a reusable imported baseline table. | Standard Stack / Project Structure | Planner may need to add a baseline table if imports must be operator-editable in Phase 19. |
| A2 | Overall `estimated_range` threshold should be score >= 0.72 with no critical factor below 0.60. | Confidence Factors And Thresholds | Too strict may hide useful ranges; too loose may create misleading precision. |
| A3 | Eurostat freshness policy should allow 60 months and INE annual rows 24 months. | Confidence Factors And Thresholds | Policy may need product confirmation if the user expects stricter freshness. |
| A4 | Dispersion over 25% should warn/cap confidence or degrade. | Confidence Factors And Thresholds | Source conflict sensitivity may need tuning after fixtures. |
| A5 | The inspection endpoint should be `/v1/jobs/:jobKey/compensation/market`. | API Shape | Naming could change before implementation, but separation from posted facts should remain. |

## Open Questions

1. **Should Phase 19 include an operator-facing import command or only repository/test fixtures?** [ASSUMED]
   - What we know: deterministic local fixture/import data is required, and no live fetch path is allowed. [VERIFIED: 19-CONTEXT.md]
   - What's unclear: whether the user expects a CLI-visible import command in Phase 19. [ASSUMED]
   - Recommendation: start with seed helpers and repository backfill; add CLI only if the plan needs operator workflow validation. [ASSUMED]

2. **Should unknown-location jobs be `unsupported` or `insufficient_evidence`?** [ASSUMED]
   - What we know: unknown-location assumptions must be visible, and non-Europe locations are unsupported. [VERIFIED: 19-CONTEXT.md]
   - What's unclear: whether unknown location should be treated as potentially Europe but weak, or out of scope until location is known. [ASSUMED]
   - Recommendation: use `insufficient_evidence` for unknown location when occupation/source data exists, and `unsupported` only for known non-Europe geography. [ASSUMED]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | TypeScript contracts/API tests | yes | v25.9.0 [VERIFIED: local command] | None needed |
| pnpm | Workspace scripts | yes | 10.24.0 [VERIFIED: local command] | None needed |
| npm | Registry/version checks if packages were added | yes | 11.12.1 [VERIFIED: local command] | None needed |
| uv | Python test/lint commands | yes | 0.11.7 [VERIFIED: local command] | None needed |
| Python | Python domain/repository tests | yes | 3.14.4 [VERIFIED: local command] | None needed |
| sqlite3 CLI | Schema inspection/manual debugging | yes | 3.51.0 [VERIFIED: local command] | Python sqlite3 module |

**Missing dependencies with no fallback:** none found. [VERIFIED: local command]  
**Missing dependencies with fallback:** none found. [VERIFIED: local command]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Python framework | pytest via `uv --project workers/automation run --extra dev pytest -q`. [VERIFIED: package.json] |
| API framework | Vitest via `corepack pnpm --filter @jobhunter/api test`. [VERIFIED: package.json] |
| Typecheck | `corepack pnpm api:check` and package contract checks through root `check`. [VERIFIED: package.json] |
| Quick run command | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimates.py && corepack pnpm --filter @jobhunter/api test -- market-compensation-estimates.test.ts`. [ASSUMED] |
| Full suite command | `corepack pnpm test`. [VERIFIED: package.json] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| SRC-02 | Allow only Eurostat SES, ESCO, and Spain INE source IDs. | unit | `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimates.py -x` | No, Wave 0. [ASSUMED] |
| SRC-03 | Aggregate baseline warnings and source metadata are emitted. | API/unit | `corepack pnpm --filter @jobhunter/api test -- market-compensation-estimates.test.ts` | No, Wave 0. [ASSUMED] |
| EST-01 | All five market estimate states round-trip through SQLite and DTOs. | unit/API | same as above | No, Wave 0. [ASSUMED] |
| EST-02 | Weak role/geography/seniority/component/freshness support blocks range output. | unit | same as above | No, Wave 0. [ASSUMED] |
| EST-03 | Confidence factors, sample count, freshness, and dispersion are inspectable. | unit/API | same as above | No, Wave 0. [ASSUMED] |
| EST-04 | Weak evidence returns `insufficient_evidence` with no range fields. | unit/API | same as above | No, Wave 0. [ASSUMED] |
| EST-06 | Remote-Europe, Spain-local, EU-wide, non-EU-Europe, and unknown-location assumptions are explicit. | unit | same as above | No, Wave 0. [ASSUMED] |
| EST-07 | Posted-vs-market conflict creates warning only and does not affect score/apply fields. | unit/API | same as above plus existing score/apply route regression if touched. [ASSUMED] | No, Wave 0. [ASSUMED] |

### Sampling Rate

- **Per task commit:** run the Python market tests or API market test relevant to touched surface. [ASSUMED]
- **Per wave merge:** run `corepack pnpm api:test`, `corepack pnpm api:check`, and `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_market_compensation_estimates.py workers/automation/tests/test_market_compensation_repository.py`. [ASSUMED]
- **Phase gate:** run `corepack pnpm test` before verification. [VERIFIED: package.json]

### Wave 0 Gaps

- [ ] `workers/automation/tests/test_market_compensation_estimates.py` for estimator states, thresholds, warnings, Europe-only source allowlist, and no licensed/US source leakage. [ASSUMED]
- [ ] `workers/automation/tests/test_market_compensation_repository.py` for schema creation, upsert/get, JSON factor preservation, and cascade behavior. [ASSUMED]
- [ ] `apps/api/test/market-compensation-estimates.test.ts` for recorded/non-requested/404/no-write-on-read/private-data-leak tests. [ASSUMED]
- [ ] Contract type additions in `packages/contracts/src/schemas.ts` and API client method in `packages/api-client/src/client.ts`. [ASSUMED]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | Local API currently uses loopback/local trust controls rather than user auth for this surface. [VERIFIED: apps/api/src/server.ts] |
| V3 Session Management | no | No browser session state is introduced in Phase 19. [ASSUMED] |
| V4 Access Control | yes | Keep endpoint read-only and mutation-free; unsafe methods are already guarded by local-origin checks. [VERIFIED: apps/api/src/server.ts] |
| V5 Input Validation | yes | Decode route param, query canonical `jobs`, and map only allowlisted DB columns/JSON warning codes. [VERIFIED: apps/api/src/posted-compensation-facts.ts] |
| V6 Cryptography | no | No secrets or cryptographic operations are introduced. [ASSUMED] |
| V9 Communications | no | Phase implementation must not add network fetch/scrape paths. [VERIFIED: 19-CONTEXT.md] |
| V12 Files and Resources | yes | Do not expose local paths, raw provider payloads, credentials, or raw benchmark pages. [VERIFIED: 19-CONTEXT.md] |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Sensitive payload leakage in API JSON | Information Disclosure | DTO allowlist, warning-code allowlist, and API tests asserting no local paths/private descriptions/licensed provider names leak. [VERIFIED: apps/api/test/posted-compensation-facts.test.ts] |
| Write-on-read backfill | Tampering | GET endpoint must query only and test row count before/after. [VERIFIED: apps/api/test/posted-compensation-facts.test.ts] |
| Source-policy bypass | Tampering | Estimator allowlists only Eurostat SES, ESCO, and Spain INE source IDs. [VERIFIED: 19-CONTEXT.md] |
| Misleading precision | Integrity | Hard-gate weak factors to `insufficient_evidence` and omit range fields. [VERIFIED: 19-CONTEXT.md] |

## Sources

### Primary (HIGH confidence)
- `.planning/phases/19-europe-public-market-estimates/19-CONTEXT.md` - locked Phase 19 boundaries and decisions. [VERIFIED: repo grep]
- `.planning/ROADMAP.md` - Phase 19 goal, success criteria, and deferred Phase 20/21 ownership. [VERIFIED: repo grep]
- `.planning/REQUIREMENTS.md` - SRC/EST/API/UI/QA requirements and future exclusions. [VERIFIED: repo grep]
- `docs/architecture.md` - SQLite canonical facts and Phase 18/20 compensation boundary. [VERIFIED: repo grep]
- `docs/local-ts-api.md` - source registry and posted compensation read-only endpoint contract. [VERIFIED: repo grep]
- `apps/api/src/compensation-source-policy.ts` - allowed public Europe source policy and disabled licensed seams. [VERIFIED: repo grep]
- `workers/automation/src/jobhunter/domain/compensation/posted.py` - deterministic posted compensation domain style. [VERIFIED: repo grep]
- `workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py` - SQLite repository style. [VERIFIED: repo grep]
- `workers/automation/src/jobhunter/database.py` - canonical table creation pattern. [VERIFIED: repo grep]
- `apps/api/src/posted-compensation-facts.ts` and `apps/api/test/posted-compensation-facts.test.ts` - read-only API mapping and no-write-on-read test pattern. [VERIFIED: repo grep]

### Secondary (MEDIUM confidence)
- Eurostat SES official page - coverage, survey scope, microdata years, and earnings variables. [CITED: https://ec.europa.eu/eurostat/web/microdata/collections-research/structure-of-earnings-survey]
- ESCO official page - taxonomy purpose, occupation/skill counts, available download/API, and version. [CITED: https://esco.ec.europa.eu/en/about-esco/what-esco]
- ESCO download page - free dataset downloads and formats. [CITED: https://esco.ec.europa.eu/en/use-esco/download]
- INE Wage Structure Survey latest data - 2024 release and wage aggregate coverage. [CITED: https://www.ine.es/dyngs/INEbase/en/operacion.htm?c=Estadistica_C&cid=1254736177025&idp=1254735976596]
- INE methodology page - sample size, national scope, reference period, and sampling method. [CITED: https://www.ine.es/dyngs/INEbase/en/operacion.htm?c=Estadistica_C&cid=1254736177025&idp=1254735976596&menu=metodologia]
- INE 2024 press release - occupation aggregates, median/mode, and sample variability/suppression notes. [CITED: https://www.ine.es/dyngs/Prensa/en/EAES2024.htm]

### Tertiary (LOW confidence)
- None used for recommendations except assumptions logged above. [ASSUMED]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - based on existing repo code, scripts, and local tool availability. [VERIFIED: repo grep]
- Architecture: HIGH - Phase 19 boundaries and Phase 18 patterns are explicit in context, docs, and code. [VERIFIED: 19-CONTEXT.md]
- Public source characterization: MEDIUM - official pages were checked, but exact imported fixture rows and source-release files are not yet selected. [CITED: https://ec.europa.eu/eurostat/web/microdata/collections-research/structure-of-earnings-survey] [CITED: https://www.ine.es/dyngs/INEbase/en/operacion.htm?c=Estadistica_C&cid=1254736177025&idp=1254735976596]
- Thresholds: LOW - recommended policy values are assumptions and need planner/user acceptance or tests proving conservative behavior. [ASSUMED]

**Research date:** 2026-06-19  
**Valid until:** 2026-06-26 for source freshness claims; architecture guidance remains valid until Phase 20 changes compensation projections. [ASSUMED]

## RESEARCH COMPLETE
