# Domain Model

This document is the implementer's quick reference to JobHunter's domain
language. The full specification — invariants, value objects, lifecycle,
domain events, and ports — lives in [`docs/ddd-target.md`](ddd-target.md).
This file summarises the eight bounded contexts and points at the code that
owns each.

## Bounded Contexts (target shape, implemented)

### Job Discovery (§3.1, §4.1)

Owns finding job postings and creating canonical `Job` aggregate records.

- **Aggregate root:** `Job` — `(TenantId, JobId)`
- **Value objects:** `PostingUrl`, `Source(board)`, `Employer(name)`,
  `SearchStrategy`, `JobMetadata`
- **Domain events:** `JobDiscovered`, `JobUpdated`, `JobDeleted`,
  `JobRestored`
- **Code:** `workers/automation/src/jobhunter/domain/discovery/`,
  `workers/automation/src/jobhunter/infrastructure/discovery/`

### Job Enrichment (§3.2, §4.2)

Owns enriching jobs with detail-page data using the 3-tier extractor
(JSON-LD → CSS → LLM).

- **Aggregate root:** `JobEnrichment` — `(TenantId, JobId)`
- **Child entity:** `EnrichmentAttempt`
- **Domain events:** `JobEnriched`, `EnrichmentFailed`
- **Code:** `workers/automation/src/jobhunter/domain/enrichment/`,
  `workers/automation/src/jobhunter/infrastructure/enrichment/`

### Candidate Profile (§3.3, §4.3)

Owns the user's reusable career data, resume baseline, tailoring policy, and
writing style.

- **Aggregate root:** `Profile`
- **Domain events:** `ProfileUpdated`, `ProfileImported`
- **Code:** `workers/automation/src/jobhunter/domain/profile/`,
  `workers/automation/src/jobhunter/infrastructure/profile/`
- **Local adapter:** `SqliteProfileRepository` stores the aggregate in
  normalized `candidate_profile*` tables and can seed them once from legacy
  profile/rendering files when empty.

### Scoring (§3.4, §4.4)

Owns LLM fit scoring and user-corrected scores.

- **Aggregate root:** `JobScore`
- **Domain events:** `JobScored`, `ScoreCorrected`
- **Code:** `workers/automation/src/jobhunter/domain/scoring/`,
  `workers/automation/src/jobhunter/infrastructure/scoring/`

### Materials Generation (§3.5, §4.5)

Owns resume tailoring, cover-letter generation, and PDF rendering for one job.

- **Aggregate root:** `MaterialsSet`
- **Child entities:** `TailoredResume`, `CoverLetter`, `RenderedPdf`
- **Domain events:** `ResumeApproved`, `ResumeFailed`,
  `CoverLetterGenerated`, `PdfRendered`, `MaterialsExhausted`
- **Code:** `workers/automation/src/jobhunter/domain/materials/`,
  `workers/automation/src/jobhunter/infrastructure/materials/`

### Apply Automation (§3.6, §4.6)

Owns Chrome lifecycle, Claude Code subprocess, and apply submission.

- **Aggregate root:** `ApplyRun`
- **Child entities:** `ApplyRunEvent`
- **Domain events:** `ApplyRunStarted`, `ApplyRunEventRecorded`,
  `ApplicationSubmitted`, `ApplicationFailed`
- **Code:** `workers/automation/src/jobhunter/domain/apply/`,
  `workers/automation/src/jobhunter/infrastructure/apply/`

### Pipeline Orchestration (§3.7, §4.7)

Owns per-job stage state, transitions, and the saga that sequences a
multi-stage pipeline run.

- **Aggregate root:** `JobPipelineState`
- **Stages:** `discover → enrich → score → tailor → cover → pdf → apply`
- **States:** `pending`, `queued`, `running`, `succeeded`, `failed`,
  `blocked`, `skipped`, `exhausted`, `stale`, `canceled`
- **Domain events:** `StageStarted`, `StageCompleted`, `StageFailed`,
  `StageBlocked`, `StageSkipped`, `StageReset`, `StageExhausted`,
  `StageCanceled`
- **Code:** `workers/automation/src/jobhunter/domain/pipeline/`,
  `workers/automation/src/jobhunter/infrastructure/pipeline/`,
  `packages/domain-types/src/pipeline/`

### Operations / Read-Side (§3.8, §4.8, §6.6)

Owns no aggregate. Maintains five denormalised projections built from domain
events from every other context.

- **Projections:** `JobListProjection`, `DashboardProjection`,
  `JobDetailProjection`, `ArtifactListProjection`, `ApplyRunProjection`
- **Driven port:** `ReadModelStore`
- **Adapter:** `SqliteProjectionStore`
- **Builders:** `ProjectionBuilder` (Python, `infra/projections/`) +
  `refreshProjections` (TS, `apps/api/src/projections.ts`)
- **Code:** `workers/automation/src/jobhunter/domain/operations/`,
  `workers/automation/src/jobhunter/infrastructure/projections/`

## Cross-Cutting

### Tenancy

`TenantId` is a first-class identity scope. Every aggregate identity, every
domain event, and every repository query is tenant-scoped. Local-first mode
uses the `LOCAL_TENANT` constant (`local`); the hosted-future migration
swaps adapters without changing domain code.

### Domain Events

Domain events are immutable past-tense facts. They flow through the
`InProcessEventBus` (`infrastructure/events/in_process_bus.py`) — local-mode —
or via the future SQS-FIFO outbox in hosted mode (§6.3). Each subscriber runs
in its own transaction scope; handler errors are logged without breaking
peers.

### Integration Protocol (§6.5)

The TS API ↔ Python worker boundary is **JSON-RPC 2.0 over a long-lived
subprocess**. The TS-side `SubprocessJsonRpcAdapter`
(`apps/api/src/json-rpc-adapter.ts`) speaks to the Python `JsonRpcServer`
(`workers/automation/src/jobhunter/infrastructure/rpc/server.py`) launched
via `jobhunter rpc`.

### Stage State Machine

The shared state machine (`packages/domain-types/src/pipeline/state_machine.ts`
+ `workers/automation/src/jobhunter/domain/pipeline/state_machine.py`) defines
valid `StageState` transitions. Both languages derive their checker from the
same TypeSpec-shaped table; the `scripts/check-domain-type-parity.py`
fitness function asserts they stay in sync.

## See Also

- `docs/ddd-target.md` — full architectural target.
- `docs/decisions.md` — ADRs.
- `docs/plans/implemented/2026-05-06-ddd-migration.md` — migration history.
