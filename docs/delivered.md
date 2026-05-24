# Delivered

This is the per-PR delivery archive. It records what changed and where to find
the detailed implementation plan or QA notes.

## 2026-05-22: Proposed Plan Status Reconciliation

Plans:

- `docs/plans/implemented/2026-05-17-jobhunter-backlog-item-add-root.md`
- `docs/plans/implemented/2026-05-19-calibrated-scoring-policy-rfc.md`

Delivered:

- Root web test aliases now exist in `package.json` for unit, watch,
  coverage, type-level, e2e, and headed e2e web test commands.
- The calibrated scoring policy stack is implemented across the Python scoring
  domain, SQLite adapters, TypeScript API write/read models, contracts, web
  scoring components, invalidation handlers, and local eval/governance tests.
- `docs/backlog.md` no longer lists the scoring policy RFC as active
  implementation work, and its CI follow-up now assumes the root web aliases
  already exist.

## 2026-05-14: Discovery RFC + Scoring Intelligence Completion

Plans:

- `docs/plans/implemented/2026-05-12-job-search-discovery-rfc.md`
- `docs/plans/implemented/2026-05-10-job-scoring-intelligence.md`

Delivered (PR #61, integrating #59 and #60):

- Discovery RFC production wiring: worker-created source locator candidates,
  manual-capture queues, quarantine/source-control rows, and API-visible
  product controls.
- Manual-capture import bridge from the TypeScript API into the Python worker
  import path, with Discovery identity/dedupe, Enrichment snapshot persistence,
  active-state evidence, provenance, and scoring handoff eligibility.
- Canonical ATS scheduling for Greenhouse/Lever/Ashby through Discovery use
  cases, preserving partial successes and carrying failed source IDs into
  Python and TypeScript source-quality projections.
- Recurring posting snapshots and source-quality attribution from enrichment
  using configured source IDs rather than display-site labels.
- Barcelona/Spain tech-leadership acceptance fixture covering lead yield,
  locator/manual-action queues, canonical verification, quarantine, source
  quality, and scoring handoff evidence.
- Criteria-aware scoring with persisted criteria snapshots, structured
  eligibility/hard blockers, gaps, transferable signals, confidence, fit band,
  and metadata-only score traces.
- End-to-end score corrections through API, contracts, web mutation/UI, events,
  projections, optimistic rollback, and SSE invalidation.
- Local scoring evaluation harness with parse validity, band, blocker, ranking,
  and feedback-agreement coverage.
- Feedback-adjusted production ranking/selection plus downstream blocker gates
  for tailoring, cover generation, apply acquisition, and targeted single-job
  material generation.
- Live-data hardening for legacy-enriched rows whose canonical enrichment stage
  is already `succeeded`, keeping enrichment runners aligned with the stage
  state machine.

Validation:

- PR review/QA gates passed for #59, #60, and final #61 with no unresolved
  Blocker/High inline threads.
- `corepack pnpm test`, `corepack pnpm check`, web unit tests, web type-level
  tests, and Playwright e2e passed locally.
- Real local `~/.jobhunter` smoke covered limited non-apply `discover`,
  `enrich`, and `score` stages plus API/web rendering with `LANGFUSE_DISABLE=1`.

## 2026-05-07: Temporal + Worker Reliability Stack

Plan: `docs/plans/implemented/2026-05-07-temporal-and-worker-reliability-stack.md`

Delivered (PRs #34-#40 plus follow-up hardening):

- Local Temporal foundation, worker bootstrap, `jobhunter worker`, and doctor checks.
- Pipeline activities, `JobPipelineWorkflow`, and `ApplyWorkflow`.
- JSON-RPC workflow dispatch for apply plus cooperative `cancel_run`.
- `apply_runs` / `apply_run_events` collapse into workflow-backed `apply_run_projections`.
- Workflow Runs API, web view, Temporal Web UI deep links, and workflow-run invalidation keys.
- Canonical stage-state writer cleanup and apply-log artifact registration.
- OpenTelemetry / Langfuse wiring for LLM, Temporal, and JSON-RPC spans.

## 2026-05-06: Frontend TanStack Migration (8 phases)

Plan: `docs/plans/implemented/2026-05-06-frontend-tanstack-migration.md`

Delivered (Phases 1–8):

- **Phase 1 — Foundation (PR #24):** New `apps/web` shell — Vite + React 19,
  Tailwind 4 + design tokens, shadcn/ui primitives in `shared/ui/`,
  TanStack Router file-based routes, ports inventory in `shared/ports/`
  with the local-mode adapters (`FetchApiClientAdapter`,
  `LocalStorageAdapter`, `LocalSessionAdapter`, …) wired through
  `<PortsProvider />`. `EventStreamPort` lands as a stub
  (`status: "stub"`).
- **Phase 2 — Routes + View Composers (PR #25):** Route tree
  (`/dashboard`, `/jobs(/$jobId)`, `/artifacts(/$artifactId)`, `/profile`,
  `/settings`) with route-level Zod search-param schemas. The three view
  folders (`views/dashboard/`, `views/jobs/`, `views/artifacts/`)
  populated with extracted view bodies; cross-context coordination
  forced through the URL (no `window.dispatchEvent`).
- **Phase 3 — Operations Read-Side + Per-Context Mutations (PR #26):**
  `contexts/operations/` ships with the projection-typed read hooks
  (`useDashboardSummaryQuery`, `useJobsListQuery`, `useJobDetailQuery`,
  `useArtifactsListQuery`, `useArtifactDetailQuery`,
  `useApplyRunsListQuery`, `useApplyRunQuery`, `useHealthQuery`); the
  per-context query-key factories (`jobsKeys`, `dashboardKeys`,
  `artifactsKeys`, `applyRunsKeys`, `healthKeys`, `profileKeys`) live
  with their owning context and re-export through
  `contexts/operations/queryKeys.ts`. Per-aggregate mutation hooks for
  Discovery, Profile, Materials, Apply, and Pipeline. Invalidation router
  scaffolded with empty handler bodies and a compile-time
  `Record<DomainEvent["eventType"], InvalidationHandler>` typing.
  `EventStreamProvider` mounted but consumes the stub adapter.
- **Phase 4 — Forms + Tables + Drawers (PR #27):** TanStack Form + Zod
  `safeParse` for the profile editor, settings form, credential form,
  and the resume-import wizard (nested routes with a Zustand+persist
  draft store). Shared table/data-grid models power `JobsTable`,
  `ArtifactsTable`, and `RunsTable` with column models in
  `views/<view>/columns.tsx` and cell renderers composed from
  context-owned components.
- **Phase 5 — SSE Endpoint + Real EventStream Adapter + Populated Router
  (PR #28):** `GET /v1/events/stream` ships on `apps/api/` with the
  COALESCE tenant filter, `Last-Event-ID` resume, `retry: 5000`,
  15 s keepalive, and 30 s heartbeat. Real `SseEventStreamAdapter`
  replaces the stub. Invalidation-router handler bodies populated per
  target §8.4; `setQueryData` path for `ApplyRunEventRecorded`. 30 s
  "connection lost" banner; one-shot full `invalidateQueries()`
  backstop on reconnect.
- **Phase 6 — Test Pyramid (PR #29):** Vitest + React Testing Library +
  MSW handlers; per-event invalidation-router unit tests; the two
  parity tests (`every-event-has-handler.test.ts` in
  `contexts/operations/` and `every-stage-state-has-badge.test.tsx` in
  `contexts/pipeline/components/`); type-level tests for the Operations
  read hooks via Vitest's `typecheck` mode (under `apps/web/test/types/`,
  `vitest.types.config.ts`) — superseding the original `tsd` plan;
  `axe-core` / `jest-axe` for form / dialog components; Playwright
  headless specs for the eight critical flows (dashboard, dry-run,
  jobs-bulk, jobs-drawer, materials, profile-edit, settings, wizard;
  `materials.spec.ts` is `fixme`'d pending the
  `GenerateMaterialsUseCase` backend exposure).
- **Phase 7 — Storybook + a11y Baseline (PR #30):** Storybook with
  `addon-msw` and `addon-a11y` (critical+serious axe violations fail
  CI). Per-primitive stories for every shadcn primitive in `shared/ui/`,
  per-context stories for every domain component, per-view stories for
  the dashboard / jobs / artifacts / profile composers. 17 stories
  carry an explicit `a11y: { test: "off" }` deferral with attribution
  to the underlying production a11y defect; each deferral is tracked
  in `docs/backlog.md`.
- **Phase 8 — Documentation (this PR):** Frontend architecture
  codified in `docs/architecture.md`, four ADRs appended to
  `docs/decisions.md` (TanStack adoption, frontend hexagonal ports,
  SSE realtime contract + invalidation router, view-vs-context
  dichotomy), `docs/local-development.md` and `docs/local-ts-api.md`
  and `docs/local-reliability-qa.md` updated with the frontend
  commands / SSE contract / test pyramid, `docs/INDEX.md` and
  `docs/backlog.md` updated, `AGENTS.md` extended with a Frontend
  Conventions section, and the migration plan moved from `proposed/`
  to `implemented/`.

Cross-cutting outcomes:

- Three-layer state separation (server / URL / client) enforced by
  construction; the pre-migration 2,527-line `App.tsx` with
  `useState<View>` switching, manual `requestSeq` ref dedup, and
  `window.dispatchEvent` cross-component coordination is gone.
- Eight frontend bounded contexts mirror the backend's eight 1:1; views
  are composers, not contexts; ubiquitous language matches end-to-end.
- Hexagonal ports in place from day one; cloud-mode adapters named in
  `docs/backlog.md` ("Frontend Cloud-Mode Adapters") with fitness
  functions per `docs/frontend-target.md` §9.
- Realtime via SSE + pure-function invalidation router; new backend
  events are a one-row schema addition + a one-row router handler.
- Test counts: 70 vitest files (≈291 tests), 9 type tests, 8 Playwright
  specs, 9 a11y suites; Storybook test runner is the gate for stories
  + critical a11y bar.

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
