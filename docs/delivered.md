# Delivered

This is the per-PR delivery archive. It records what changed and where to find
the detailed implementation plan or QA notes.

## 2026-05-06: DDD + Hexagonal Migration (9 phases)

Plan: `docs/plans/implemented/2026-05-06-ddd-migration.md`

Delivered (Phases 1–9):

- **Phase 1 (S-01..S-04):** shared `TenantId`, `JobId`, `Stage`, and
  `StageState` value objects in `packages/domain-types` (TS) and
  `workers/automation/src/jobhunter/domain/` (Python); domain event base
  type + per-context catalog (`domain/events/`).
- **Phase 2 (S-05..S-07):** `JobPipelineState` aggregate, `StageStateMachine`
  shared between TS and Python via the parity check, and
  `PipelineStateRepository` port + SQLite adapter.
- **Phase 3 (S-08..S-13):** `EventPublisher` port + `InProcessEventBus`,
  `event_watermarks` table, JSON-RPC 2.0 message types + server +
  default handler set (`reset_stage`, `mark_applied`, `mark_skipped`,
  `cancel_stage`, `run_stage`, `apply`, `profile_import`), TS-side
  state-machine mirror, and the `jobhunter rpc` CLI command.
- **Phase 4 (S-14..S-15):** `Profile` aggregate, `ProfileRepository` port,
  `JsonFileProfileRepository` adapter, and `ProfileSnapshotPort`.
- **Phase 5 (S-16..S-19):** `JobScore` aggregate, `ScoreRepository`,
  `LlmPort`, scorer refactor through use cases.
- **Phase 6 (S-20..S-25):** `MaterialsSet` aggregate, `MaterialsRepository`,
  `PdfRendererPort`, `ArtifactStoragePort`, tailor + cover refactors.
- **Phase 7 (S-26..S-27):** `Job` discovery aggregate (separating
  `Source.board` from `Employer`), `JobEnrichment` aggregate,
  `EnrichmentRepository`, decoupled `enrichment/detail.py`.
- **Phase 8 (S-28..S-31):** `ApplyRun` aggregate, `ApplyRunRepository`,
  `BrowserPort`, `AutonomousAgentPort`, apply saga / process manager,
  `LocalChromeAdapter`, `ClaudeCodeCliAdapter`, launcher refactor.
- **Phase 9 (S-32..S-35):** Operations / Read-Side projections
  (`JobListProjection`, `DashboardProjection`, `JobDetailProjection`,
  `ArtifactListProjection`, `ApplyRunProjection`); Python
  `ProjectionBuilder` + TS `refreshProjections` mirror; `read-model.ts`
  refactored to flat SELECTs against `*_projections` tables (legacy
  LEFT-JOIN-with-COALESCE helpers deleted); `SubprocessJsonRpcAdapter`
  replacing per-call `uv run jobhunter action ...` subprocess spawning;
  full architecture / domain-model / decisions / AGENTS.md doc sweep.

Cross-cutting outcomes:

- 8 bounded contexts named, with aggregates / repositories / ports /
  adapters per the target spec.
- TenantId carried through every aggregate identity and every event payload.
- Domain events are the integration backbone; both processes refresh
  projections idempotently via the shared
  `event_watermarks.operations_projections` watermark.
- TS↔Python protocol is JSON-RPC 2.0 over a long-lived subprocess
  (`jobhunter rpc`); no per-call subprocess spawning remains.
- Test coverage: 588 Python tests + 55 TS tests (was 564 + 48 baseline).

## 2026-04-29: Job State Dashboard

Plan: `docs/plans/implemented/2026-04-29-job-state-dashboard.md`

Delivered:

- normalized job stage state tables
- event and artifact recording helpers
- operations dashboard data contract
- retryable stage model
- regression coverage for dry-run apply, apply timeout, targeted apply, PDF
  target selection, cover-letter requirements, and dashboard rendering

## PR #8: Local TypeScript API Scaffold

Plan: `docs/plans/implemented/2026-05-02-local-ts-api.md`

Delivered:

- `apps/api` Fastify API scaffold
- `packages/contracts` shared schemas and DTOs
- `packages/api-client` typed client
- local SQLite read endpoints for health, dashboard, jobs, artifacts, profile,
  and settings
- API host loopback validation
- pagination, filtering, and global sorting for list endpoints

## PR #9: React Frontend Shell

Delivered:

- `apps/web` React/Vite app
- dashboard, jobs, artifacts, and profile views
- typed client usage through `@jobhunter/api-client`
- web typecheck/build included in `pnpm test`
- request staleness guards and visible load errors
- filter/page reset behavior for list views

## PR #10: Canonical Stage State

Delivered:

- `job_stage_states` preferred as dashboard truth
- legacy state materialization and placeholder hydration
- targeted backfill instead of broad state-table scans
- discover placeholder correction for old rows

## PR #11: Local Action Entrypoints

Delivered:

- `jobhunter action ...` command surface
- structured local action result model
- JSON-safe failure handling around runtime bootstrap and event writes
- profile PDF import action support
- effective apply limit handling

## PR #12: Structured Dashboard Actions

Delivered:

- local UI retry/stage/apply buttons routed through structured actions
- copyable CLI commands retained
- long-running local actions queued in background threads
- action status polling for long-running local commands

## PR #13: Local Reliability QA Gate

Plan: `docs/plans/implemented/2026-05-03-local-reliability-qa.md`

Delivered:

- repeatable local reliability command checklist
- regression matrix for high-risk local workflows
- React browser smoke checklist
- React/API product checks for artifact opening, profile/style save, discard,
  and resume PDF import drafts

## 2026-05-03: Local TS Product API + Python Workers Architecture

Plan: `docs/plans/implemented/2026-05-01-ts-product-api-python-workers-architecture.md`

Delivered:

- TypeScript API structured job action endpoints for retry, material
  generation, dry-run apply, cancel, mark-applied, and mark-skipped
- safe artifact-open action for known local artifacts only
- profile/style/template writes and resume-import draft endpoint through the
  typed API
- React job drawer action buttons, artifact open controls, and persistent
  profile save/discard/import controls
