# Phase 19: Europe Public Market Estimates - Context

**Gathered:** 2026-06-19
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 19 adds canonical Europe-only public market estimate facts and confidence decisions. It turns configured public sources from Phase 17 and posted compensation facts from Phase 18 into persisted estimate states: `not_requested`, `unsupported`, `insufficient_evidence`, `estimated_range`, and `source_unavailable`. This phase owns source support, occupation/geography/seniority/component/freshness confidence, aggregate-source warnings, and insufficient-evidence explanations. It does not add Jobs list/detail read-model propagation, SSE invalidation, profile-floor comparison, or final Jobs triage UI; those remain Phase 20 and Phase 21.

</domain>

<decisions>
## Implementation Decisions

### Source Scope
- Use only Europe-first public baselines in v1.3: Eurostat Structure of Earnings Survey, ESCO occupation taxonomy, and Spain INE Wage Structure Survey.
- Do not fetch, scrape, import, cache, or display Glassdoor, Levels.fyi, or non-European salary baselines in Phase 19.
- Treat ESCO as occupation mapping evidence only; it never provides salary observations or sample counts.
- Represent Eurostat and INE baselines as public occupation/location aggregates, not company-specific market ranges.

### Estimation States
- Model market estimates as persisted immutable facts with a discriminated state, not nullable range fields.
- Use `not_requested` when no estimate request/backfill has been attempted for a job.
- Use `unsupported` for out-of-scope geography, unsupported component, missing occupation mapping, or non-Europe location.
- Use `source_unavailable` when a configured public source required for an estimate is unavailable or stale beyond policy.
- Use `insufficient_evidence` when sources exist but confidence thresholds are not met.
- Use `estimated_range` only when role/occupation, geography, seniority, component, freshness, and source support all pass threshold.

### Confidence And Warnings
- Confidence must be inspectable by factor: occupation match, geography match, seniority match, component compatibility, freshness, sample support, and source agreement or dispersion.
- Do not emit precise-looking ranges for weak support; emit explicit insufficient-evidence reasons instead.
- Include warnings for aggregate baselines, broad aggregate bands, source conflict with posted salary, stale source snapshots, low sample count, remote-Europe assumptions, Spain-local assumptions, EU-wide assumptions, non-EU-Europe assumptions, and unknown-location assumptions.
- If posted salary and public baseline diverge materially, record a warning only; do not affect score, ranking, filtering, apply readiness, or apply dispatch.

### Data And Persistence
- Start with deterministic local public-baseline fixture/import data so tests and local runs do not depend on live external network calls.
- Persist market estimate facts in a canonical SQLite table separate from `job_posted_compensation_facts` and separate from Phase 20 projection tables.
- Store safe source identifiers, release year/snapshot version, aggregate bucket, allowed attribution, sample count when available, and bounded factor reasons.
- Do not store raw benchmark pages, credentials, private account payloads, local paths, or user compensation preferences in market estimate rows.

### API And Contracts
- Add typed DTOs to `packages/contracts` and a narrow read-only API endpoint so Phase 19 can be inspected before Phase 20 projection propagation.
- The endpoint may return `not_requested` for existing jobs without a persisted market estimate row, but it must not compute, backfill, or persist estimates during GET reads.
- Keep posted salary facts and market estimates separate in the API contract even when both are available for one job.
- Preserve all existing job list/detail shape and compatibility until Phase 20.

### the agent's Discretion
- Choose exact confidence thresholds and source-support scoring, provided tests prove weak evidence degrades to `insufficient_evidence` instead of a precise range.
- Choose whether the first deterministic baseline rows live in Python fixtures, seed helpers, or repository tests, provided no live external fetch path is added.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/api/src/compensation-source-policy.ts` already defines the public Europe source policy entries and disabled licensed-source seams.
- `workers/automation/src/jobhunter/domain/compensation/posted.py` and `workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py` provide the Phase 18 domain/persistence style for canonical compensation facts.
- `workers/automation/src/jobhunter/database.py` owns SQLite table creation and is the right migration point for canonical local rows.
- `packages/contracts/src/schemas.ts`, `packages/api-client/src/client.ts`, and `apps/api/src/server.ts` are the existing contract/API/client integration points.
- `apps/api/test/posted-compensation-facts.test.ts` and `workers/automation/tests/test_posted_compensation_repository.py` provide close test patterns.

### Established Patterns
- Domain logic should be deterministic and pure; persistence belongs in SQLite repositories.
- API inspection endpoints read canonical rows and return safe DTOs; they do not do write-on-read backfills.
- Contracts use explicit string unions and DTO interfaces to make illegal states hard to represent.
- Tests use local synthetic data and temporary SQLite databases; no real network, browser, mailbox, or provider calls.

### Integration Points
- Python domain: market estimate state, source evidence, confidence factors, and warning value objects.
- Python infrastructure: SQLite table/repository and deterministic estimate/backfill helper.
- TypeScript contracts/API: read-only market estimate DTO and route by job key.
- Documentation: `docs/local-ts-api.md`, `docs/architecture.md`, and `docs/local-reliability-qa.md` own the Phase 19 behavior and QA notes.

</code_context>

<specifics>
## Specific Ideas

- The user explicitly clarified that JobHunter is not U.S.-first; Phase 19 should say Europe first and avoid U.S. public baselines.
- The strongest first slice is a deterministic local estimator over public aggregate fixture rows, not a downloader for live Eurostat/INE endpoints.
- Spain-local estimates should prefer Spain INE when a supported Spain row exists; broader Europe/EU rows are fallback aggregate warnings, not company-specific intelligence.
- Remote-Europe and unknown-location cases should be explicit assumptions or unsupported/insufficient-evidence states.

</specifics>

<deferred>
## Deferred Ideas

- Projection-backed compensation summaries, job list/detail API fields, and SSE invalidation belong to Phase 20.
- Jobs list/drawer compensation UX and profile-floor comparison belong to Phase 21.
- End-to-end product-path QA fixtures and release evidence belong to Phase 22.
- Licensed Levels.fyi or Glassdoor market data remains future work unless permitted access and Europe coverage are explicitly configured.

</deferred>
