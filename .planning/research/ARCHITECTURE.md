# Architecture Patterns

**Domain:** JobHunter v1.3 Salary Range Estimator
**Researched:** 2026-06-19
**Scope:** Posted salary extraction, external-source market estimates, statistical confidence, provenance, and Jobs triage only.

## Recommended Architecture

Treat salary as a typed compensation fact owned by the backend domain and projected into Jobs triage. Do not parse salary strings in React, do not overload the existing `jobs.salary` / `JobSummary.salary` field, and do not fold market estimates into the fit score.

The best architectural fit is:

```text
Discovery / Enrichment source text
  -> Enrichment-owned compensation assessment use case
  -> canonical compensation rows + provenance rows
  -> JobCompensationAssessed domain event
  -> Operations projections in Python and TypeScript
  -> typed API contracts
  -> Jobs view composes Enrichment-owned compensation components
```

The estimator should be audit-first and non-gating. Compensation may inform user triage, but v1.3 should not silently rank, hide, block, auto-apply, or make tailoring/apply eligibility decisions from an opaque estimate.

## Proposed Bounded-Context Ownership

| Concern | Owner | Rationale |
| --- | --- | --- |
| Raw `jobs.salary` string from board/listing metadata | Job Discovery | This is discovery-time `JobMetadata.salary` and should remain the legacy raw source, not the new typed fact. |
| Salary text found in full posting content | Job Enrichment | Full description/application URL already belong to Enrichment. Posted compensation spans extracted from the posting are an enrichment of the job posting. |
| Posted salary normalization and parse warnings | Job Enrichment | Parsing source text into structured job facts is enrichment logic; keep it near source snapshots and extraction attempts. |
| External market-source lookup and source registry | Job Enrichment | Market compensation is additional job intelligence gathered from external sources. It needs source adapters, freshness, and provenance, like enrichment. |
| Market estimate aggregation and statistical confidence | Job Enrichment domain service | It transforms compensation evidence into a range and confidence. It is not candidate fit scoring. |
| Candidate profile salary floor | Candidate Profile | The profile owns user expectations such as salary floor/currency. Other contexts receive a snapshot or projection, not mutable profile data. |
| Profile-floor comparison for Jobs triage | Operations read model | It is a derived presentation fact from compensation + current profile snapshot. Persist only if requirements later demand historical comparison audit. |
| Jobs list/detail salary display | Operations projections + frontend Jobs view composition | Operations owns read shapes; Jobs view composes read data and context components. |
| Salary UI components | Frontend `contexts/enrichment/` | Frontend mirrors backend contexts. Since compensation assessment is Enrichment-owned, range/confidence/provenance components belong there. |

Do not create a ninth top-level bounded context for v1.3. A future "Compensation Intelligence" context could be justified if compensation expands into negotiation tracking, offer comparison, longitudinal market analytics, or user-authenticated market-source accounts. The v1.3 scope fits inside Enrichment.

## New/Changed Domain Concepts And Value Objects

Add explicit value objects in Python domain and TypeScript mirrors. Unknown, unparseable, posted, and estimated states should be distinct sum types, not nullable fields around primitive strings.

### CompensationRange

```text
CompensationRange
  min: MoneyAmount | null
  max: MoneyAmount | null
  currency: CurrencyCode
  period: CompensationPeriod
  compensationKind: base | total | ote | hourly | contract | unknown
```

Invariants:

- At least one of `min` or `max` must exist for a known range.
- If both exist, `min <= max`.
- `currency` must be explicit when an amount exists.
- `period` must be explicit; if inferred, record an assumption.
- Display strings are never the source of truth.

### PostedCompensationFact

Use a discriminated union:

```text
PostedCompensationFact =
  | { kind: "not_found"; checkedSources; extractedAt }
  | { kind: "unparseable"; rawText; source; warnings; extractedAt }
  | { kind: "ambiguous"; candidates; source; warnings; extractedAt }
  | { kind: "posted_range"; range; source; confidence; warnings; extractedAt }
```

`posted_range` must have a source span or source field. `not_found` must not have a range. `unparseable` must keep the raw text and warnings so the UI can explain why no normalized range exists.

### MarketCompensationEstimate

Use a discriminated union:

```text
MarketCompensationEstimate =
  | { kind: "not_requested"; reason }
  | { kind: "unsupported"; query; reasons; sourceAttempts }
  | { kind: "insufficient_evidence"; query; sourceCount; sampleCount; gaps }
  | { kind: "estimated_range"; query; range; confidence; sources; assumptions; computedAt }
```

`estimated_range` must have at least one supporting source and a confidence object. It should be impossible to represent a high-confidence estimate with zero source support.

### SalarySourceEvidence

```text
SalarySourceEvidence
  sourceId
  sourceKind: posting_salary_field | posting_description_span | levels_fyi | glassdoor | other_market_source
  label
  url: string | null
  capturedAt
  observedAt: string | null
  freshness
  capturedRange: CompensationRange | null
  sampleCount: number | null
  supportsRole: supported | partial | unsupported | unknown
  supportsLocation: supported | partial | unsupported | unknown
  supportsSeniority: supported | partial | unsupported | unknown
  warnings: string[]
  snapshotHash: string | null
```

This is the provenance backbone. Every displayed posted or market range should point at one or more of these records.

### CompensationConfidence

```text
CompensationConfidence
  level: low | medium | high
  score: number  // 0..1
  method: posted_parse | source_agreement | fallback_prior
  sourceCount: number
  sampleCount: number | null
  agreement: low | medium | high | unknown
  freshness: fresh | aging | stale | unknown
  warnings: string[]
```

Keep parser confidence and statistical market confidence separate in code, even if the UI renders both with the same badge component.

### JobCompensationAssessment

Persist a versioned Enrichment-owned record keyed by `(tenantId, jobId, version)`:

```text
JobCompensationAssessment
  tenantId
  jobId
  version
  posted: PostedCompensationFact
  market: MarketCompensationEstimate
  selectedDisplay: posted | market | none
  assumptions: string[]
  warnings: string[]
  assessedAt
```

It should publish `JobCompensationAssessed` when a new version is saved.

## Persistence, Projection, And Read-Model Flow

### Canonical Tables

Use canonical rows, not `metadata_json`, for compensation audit data.

| Table | Purpose |
| --- | --- |
| `job_compensation_assessments` | One row per `(tenant_id, job_url, version)` with posted/market status, selected display kind, assessed timestamp, assumptions/warnings JSON. |
| `job_posted_compensation_facts` | Posted extraction result for an assessment version, including raw text, source kind/path/span, normalized range fields, parser confidence, and warnings. |
| `job_market_compensation_estimates` | Market estimate result for an assessment version, including query shape, normalized range fields, confidence fields, source/sample counts, agreement, and freshness. |
| `job_compensation_sources` | One row per supporting/attempted source with source type, URL/hash, captured range, support flags, sample count, freshness, and warnings. |

JSON columns are acceptable for arrays such as warnings, assumptions, and source gaps, but range, currency, period, status, confidence score, source count, sample count, and timestamps should be queryable columns.

### Events

Add a domain event:

```text
JobCompensationAssessed {
  tenantId,
  jobId,
  assessmentVersion,
  postedKind,
  marketKind,
  selectedDisplay,
  assessedAt
}
```

Do not put the full source trail in the event payload. Projections should follow the existing derive-from-canonical pattern: the event marks the job dirty, and both projection builders re-read canonical compensation rows.

### Operations Projections

Extend both projection builders:

- Python: `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`
- TypeScript: `apps/api/src/projections.ts`

Add matching columns:

```text
job_list_projections.compensation_summary_json TEXT
job_detail_projections.compensation_audit_json TEXT
```

The list projection should contain compact triage facts:

```text
JobCompensationSummary
  status: unknown | posted | estimated | insufficient_evidence | unparseable
  displayRange: CompensationRange | null
  displaySource: posted | market | none
  confidenceLevel: low | medium | high | unknown
  profileFloorComparison: below_floor | meets_floor | above_floor | unknown | no_profile_floor
  freshness: fresh | aging | stale | unknown
  warningCount
```

The detail projection should contain the full audit shape:

```text
JobCompensationAudit
  posted: PostedCompensationFact
  market: MarketCompensationEstimate
  sources: SalarySourceEvidence[]
  profileFloorComparison
  assumptions
  warnings
  assessedAt
```

Keep `JobSummary.salary` as the legacy raw string for compatibility during v1.3. New UI should prefer `JobSummary.compensation`; old raw salary can remain visible only as a fallback or in the provenance trail.

### Contracts And Domain Type Mirrors

Update in lockstep:

- `packages/contracts/src/schemas.ts`: add `CompensationRange`, `PostedCompensationFact`, `MarketCompensationEstimate`, `SalarySourceEvidence`, `JobCompensationSummary`, and `JobCompensationAudit`.
- `packages/domain-types/src/operations/index.ts`: mirror projection fields.
- `packages/domain-types/src/discovery/job.ts`: keep `JobMetadata.salary` as raw discovery metadata; do not replace it with the new fact.
- Python value objects: add Enrichment/compensation value objects rather than placing parsed facts in `discovery/value_objects.py`.

The TypeScript API read model should deserialize projection JSON like employer analysis and requirement fit already do: parse projected JSON, do not recompute compensation in `apps/api/src/read-model.ts`.

## Ports And Adapters

Add Enrichment-owned ports:

| Port | Local adapter | Hosted future | Notes |
| --- | --- | --- | --- |
| `PostedCompensationParser` | Pure parser over `jobs.salary`, description snippet, and full description | Same domain service | No network. Should return explicit unparseable/ambiguous states. |
| `MarketCompensationSourcePort` | Source adapters for researched market sources | Managed source connectors or licensed data providers | Requirements must settle source legality and access. |
| `CompensationRepository` | SQLite canonical tables | Postgres Enrichment repository tables | Tenant scoped, versioned. |
| `EventPublisher` | In-process event bus | SQS event publisher | Existing pattern. |

The external adapters must be anti-corruption layers. They translate source-specific concepts from Levels.fyi, Glassdoor, or other sources into `SalarySourceEvidence` and never leak scraped/provider-native payloads into the domain model.

## Pipeline Integration

Do not add a new user-facing pipeline stage for v1.3. Keep Discover as the user-facing preparation stage.

Recommended execution:

1. Discovery stores raw listing salary in `JobMetadata.salary` as today.
2. Enrichment captures full description/application URL.
3. Discover preparation queues or invokes `assess_compensation` after enrichment, before or alongside scoring.
4. Compensation assessment persists canonical rows and publishes `JobCompensationAssessed`.
5. Operations marks the job dirty and refreshes list/detail projections.

Compensation assessment failures should be non-blocking by default. A market-source outage should produce `market.kind = "unsupported"` or `"insufficient_evidence"` plus audit warnings, not fail scoring, tailoring, or apply readiness.

Requirements should decide whether compensation assessment is automatic for every enriched job, on-demand for the selected Jobs drawer job, or automatic only for jobs that pass an initial fit-score threshold. For MVP architecture, automatic posted extraction plus on-demand market estimation is the safest build: it gives immediate value from local source text while limiting external-source cost and brittleness.

## Frontend Ownership And View Composition

### Ownership

| Frontend location | Responsibility |
| --- | --- |
| `contexts/operations/` | Read hooks and types for `JobSummary.compensation` and `JobDetail.compensationAudit`; query invalidation for compensation events. |
| `contexts/enrichment/components/` | `CompensationRangeDisplay`, `CompensationConfidenceBadge`, `CompensationSourceTrail`, `CompensationTriagePanel`. |
| `contexts/enrichment/hooks/` | Optional `useRefreshCompensationMutation` if requirements include manual refresh. |
| `views/jobs/` | Compose compensation components in Jobs table, `JobOverview`, and `JobAuditTriage`; own layout only. |

`JobAuditTriage.tsx` should not inspect source arrays or calculate confidence itself. It should receive `detail.compensationAudit` and render an Enrichment-owned component.

`JobOverview.tsx` should stop showing only `{job.salary || "-"}` once the typed projection exists. Prefer the typed display range and expose raw salary as source detail.

### Suggested UI Composition

```text
JobOverview
  ScoreBadge
  CompensationRangeDisplay(summary=detail.job.compensation)
  Apply readiness

JobAuditTriage
  Ranking metrics
  CompensationTriagePanel(audit=detail.compensationAudit)
  Apply concerns
```

Jobs table can add a compact compensation column once the contract exists. The cell renderer should live in `contexts/enrichment/components/`, while the column definition remains in `views/jobs/columns.tsx`.

## Suggested Build Order

1. **Type model and canonical persistence**
   - Add Python value objects and TypeScript contract/domain-type mirrors.
   - Add SQLite tables and repository.
   - Add invariants for range/currency/period/confidence states.

2. **Posted salary extraction**
   - Parse `jobs.salary`, discovery snippet, and full description.
   - Persist posted fact versions and source spans.
   - Publish `JobCompensationAssessed`.

3. **Operations projection path**
   - Extend Python and TypeScript projection builders together.
   - Add `compensation_summary_json` and `compensation_audit_json`.
   - Extend `JobSummary` and `JobDetail`.
   - Add cross-runtime projection parity tests.

4. **Profile-floor comparison**
   - Read current profile salary floor from Candidate Profile data.
   - Derive comparison in the read model with explicit `no_profile_floor` and `unknown` states.
   - Do not persist a historical comparison unless requirements demand audit replay.

5. **Market-source adapters and estimator**
   - Add `MarketCompensationSourcePort`.
   - Implement source registry and aggregation with explicit insufficient-evidence states.
   - Start with one reliable source path plus fixture-backed adapter tests before adding multiple sources.

6. **Jobs triage UI**
   - Add Enrichment-owned salary display/provenance components.
   - Compose them into `JobOverview`, `JobAuditTriage`, and optionally Jobs table columns.
   - Add component tests/stories and a product-path QA fixture with posted, estimated, unknown, and unparseable jobs.

7. **Refresh/on-demand workflow**
   - Add manual refresh mutation only if requirements need it.
   - If added, own it in `contexts/enrichment/` and invalidate Operations job list/detail keys through the event router.

## Architecture Risks And Decisions To Settle In Requirements

### External Source Access

Levels.fyi and Glassdoor may not provide stable, permitted, or affordable APIs for this use case. Requirements must settle which sources are allowed, whether scraping is permitted, whether manual/user-provided data is acceptable, and how source failures appear in the UI.

### Confidence Semantics

"Confidence" can mean parser confidence, statistical confidence, source agreement, freshness, or role/location/seniority support. Requirements must define the displayed confidence rubric so the product does not imply precision it does not have.

### Range Normalization

Salary ranges can be annual, monthly, hourly, contract, OTE, base, total compensation, equity-inclusive, or currency-mixed. Requirements must define conversion rules, especially whether hourly/monthly values are normalized to annual equivalents or displayed in original period only.

### Source Freshness

Market data decays. Requirements must define freshness thresholds and whether stale-but-useful sources are displayed as low confidence, excluded from estimates, or shown only in provenance.

### Profile Salary Floor

The profile currently exposes salary expectation fields in API contracts. Requirements must decide the canonical profile field for "floor", whether blank means unknown or no floor, and whether profile-floor comparison uses annualized base pay only or total compensation.

### Pipeline Cost And Latency

Market lookups can make Discover slow and brittle. Requirements should decide whether market estimates run automatically, on demand, or behind a threshold. The architecture should treat external-source failure as salary audit degradation, not a pipeline blocker.

### Projection Drift

Both Python `ProjectionBuilder` and TypeScript `refreshProjections` write the same projection tables. Any compensation projection change must land in both runtimes with parity tests, or the API may erase/omit compensation data depending on which refresher last advanced the watermark.

### Legacy Salary Field

`JobMetadata.salary`, `job_list_projections.salary`, and `JobSummary.salary` are raw strings today. Requirements should explicitly name them legacy raw source fields and forbid UI logic from treating them as normalized compensation.

### Sorting And Filtering

Salary-based sorting/filtering is tempting but should be deferred unless requirements define how unknown, posted-only, estimated-only, currency-mixed, and low-confidence jobs compare. For v1.3, display and audit are safer than ranking policy.

## Sources

- `.planning/PROJECT.md`
- `docs/architecture.md`
- `docs/ddd-target.md`
- `docs/frontend-target.md`
- `docs/job-pipeline-architecture.md`
- `packages/domain-types/src/discovery/job.ts`
- `packages/domain-types/src/operations/index.ts`
- `packages/contracts/src/schemas.ts`
- `workers/automation/src/jobhunter/domain/discovery/value_objects.py`
- `workers/automation/src/jobhunter/domain/scoring/services.py`
- `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`
- `apps/api/src/projections.ts`
- `apps/api/src/read-model.ts`
- `apps/web/src/views/jobs/JobAuditTriage.tsx`
- `apps/web/src/views/jobs/JobOverview.tsx`
