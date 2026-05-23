# Backlog

This is the authoritative roadmap. Keep detailed historical proposals under
`docs/plans/proposed/`; move delivered work to `docs/delivered.md`.

## Current State Snapshot (2026-05-17)

Delivered work is archived in [`docs/delivered.md`](delivered.md) and the
implemented plan directory. Discovery RFC production wiring and scoring
intelligence are implemented via PR #61; the local Temporal stack, DDD /
hexagonal migration, and frontend TanStack migration are also implemented.

The active local-product backlog is the remaining validation and hardening
work below: realtime cache patching beyond apply-run timeline events,
non-apply workflow-run / cancellation parity, cleanup of legacy `jobs.*`
storage fallbacks, profile/materials/browser QA gaps, frontend a11y
deferrals, and tooling / CI enforcement gaps. Hosted product, hosted data,
hosted automation, packaging, and cloud-mode frontend adapters remain
deferred until the local product is solid.

## Local Product Validation

### Frontend/API Parity

- Extend targeted row patching beyond the single `ApplyRunEventRecorded`
  handler. The SSE pipeline and invalidation router are live, and
  `ApplyRunEventRecorded` is the only handler that returns a
  `patchApplyRunEvent(...)` item for `queryClient.setQueryData`; every other
  event handler still returns `invalidate(...)` entries. Per-event
  `setQueryData` patches are the next step for jobs / artifacts / dashboard
  lists so live updates do not lose scroll position or trigger spinners.

### Worker Reliability

- Extend workflow-run projections beyond apply. Global `run_stage` now starts
  `JobPipelineWorkflow` and returns a workflow ID to the API, and apply steps
  inside that pipeline run as child `ApplyWorkflow` executions. However,
  `/v1/workflow-runs` is still backed by apply-run projections. A uniform
  workflow-run projection is still needed if the dashboard should list
  discover/enrich/score/tailor/cover workflow lifecycle rows alongside
  apply runs.
- Add cancellation UX for queued or running non-apply local actions.
  `run_stage` now has a Temporal workflow ID, so cooperative cancellation can
  use `cancel_run`, but the UI still needs a first-class cancel control for
  those pipeline runs. `profile_import` remains synchronous inside the JSON-RPC
  handler and still has no cancel surface.
- Record `score_report` artifacts. PR 7 of the Temporal stack wired
  `state.record_job_artifact` into `apply.launcher.mark_result` so the
  per-worker agent log (`LOG_DIR/worker-{worker_id}.log`) lands in
  `job_artifacts` as kind `apply_log`; tailor / cover_letter / PDF were
  already registering their primary outputs through
  `SqliteMaterialsRepository`. Scoring still writes no on-disk files —
  reasoning lives in `job_scores` only — so a dedicated `score_report`
  artifact requires a behaviour change (introducing a per-job report
  file) that PR 7 deliberately did not take. File this when an operator
  asks for an exportable score report.
- Refactor non-apply stage runners to accept a single `job_url` so
  `JobPipelineWorkflow` can drive per-job batches. Today the runners are
  batch-only — they walk DB selectors over the entire `jobs` table — and
  only `ApplyWorkflow` is truly per-job. Driver path: `discovery`,
  `enrichment`, `scoring`, `materials/tailor`, `materials/cover`,
  `materials/pdf`. Once the runners take a `job_url`, the workflow can
  expose `(TenantId, JobId)` semantics and PR 4's `apply_runs → workflow
  runs` collapse can extend uniformly to the non-apply stages.

### Scoring Calibration

- Implement the calibrated scoring policy RFC in
  [`docs/plans/proposed/2026-05-19-calibrated-scoring-policy-rfc.md`](plans/proposed/2026-05-19-calibrated-scoring-policy-rfc.md).
  Current scoring stores rich evidence and corrections, but the LLM still
  returns one absolute 1..10 score per job. Corrections should become
  calibration anchors in a versioned scoring policy, future scoring should use
  that policy immediately, comparable uncorrected scores should be marked
  stale, and bulk rescoring should remain explicit/user-triggered.

### Workflow Orchestration (Local Temporal)

Delivered by
[`docs/plans/implemented/2026-05-07-temporal-and-worker-reliability-stack.md`](plans/implemented/2026-05-07-temporal-and-worker-reliability-stack.md).
The local Temporal foundation, activity registry, `ApplyWorkflow`, JSON-RPC
workflow mode, `cancel_run`, `apply_runs` collapse, Workflow Runs view,
canonical stage-state writer cleanup, apply-log artifact registration, and
Langfuse/OpenTelemetry wiring have landed.

Remaining local reliability work is tracked in the Worker Reliability bullets
above: non-apply `run_stage` now uses Temporal but still needs workflow-run
projection parity and UI cancellation; `profile_import` remains the synchronous
JSON-RPC local action.

Out of scope for the local stack (stays in [`TODO_FUTURE.md`](../TODO_FUTURE.md)):

- Managed Temporal Cloud,
- distributed worker fleet (multi-machine task queues),
- cross-tenant isolation in workflows,
- Temporal-specific production observability stack.

### Data Model Cleanup

- Cut the `jobs` table over from URL primary key to `JobId`. Domain has
  `JobId` (`workers/automation/src/jobhunter/domain/identifiers.py:12`) and
  the projections expose `jobKey`, but the storage layer still uses
  `jobs.url TEXT PRIMARY KEY` (`workers/automation/src/jobhunter/database.py`)
  with cross-aggregate FKs on `job_url`. The read-model and projections still
  use URL-shaped `job_id` / `jobKey` values.
  Until the cut-over, `jobKey` is a projection alias for the URL, not a
  stable independent identity.
- Drop the legacy `jobs.application_url` column and the COALESCE fallback
  in `apps/api/src/projections.ts`. Domain TS already separates
  `Job.postingUrl` from `Enrichment.applicationUrl`; the storage layer should
  follow.
- Stop projection BUILDERS from sourcing legacy nullable `jobs.*` columns.
  `apps/api/src/projections.ts` and the Python builder at
  `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`
  still fall back to `jobs.fit_score`, `jobs.application_url`,
  `jobs.tailored_resume_path`, `jobs.cover_letter_path`, `jobs.applied_at`,
  `jobs.apply_status`. The read-side already moved to projections in
  Phase 9 (S-33); the build-side is the remaining half.
- Stop `apps/api/src/projections.ts` from synthesising phantom `*_pdf`
  artifact rows from sibling `.txt` files with no DB record. Only real
  DB-backed artifacts should be exposed; the synthesized rows are
  indistinguishable from real ones in the UI.
- Persist domain `Source.board` and `Employer.name` directly. The domain
  types are split and the projection table has both columns, but the values
  are still populated from `jobs.site` and `companyName()` infers the employer
  from source labels or URL slugs because the domain `Employer` is never
  persisted. Until the storage layer captures both, "filter by board" +
  "filter by employer" cannot be separated.
- Index normalized scoring keywords per job. `keywords_json` is written
  and read in `workers/automation/src/jobhunter/infrastructure/scoring/sqlite_repository.py`
  and is projected through typed `scoreKeywords`, but it is unindexed and has
  no API filter/search or aggregate view. The web still parses keywords out of
  legacy free-text reasoning as a compatibility path. Promote keywords to a
  searchable/indexed contract field with aggregate views.

### UI Quality

- Add saved table views for high-density operational tables, starting with
  Discovery source registry and Jobs. A view should persist column visibility,
  column order, sort order, filters, row density, and any active grouping or
  color rules under a user-named view, with a quick switcher in the table
  toolbar. Filters should include both distinct-value multi-select and text
  predicates such as "contains" and "does not contain" for text-like fields.
- Add configurable jobs-table columns. The default Jobs table should keep
  critical operational columns such as Source visible, but users need a
  first-class control for choosing which columns are shown and hidden, with
  persisted preferences per local profile or workspace.
- Spike the best long-term resume rendering path. Evaluate whether to keep
  LaTeX as the PDF source of truth, switch to Tectonic, replace LaTeX with a
  different document engine such as Typst, or move to an HTML/CSS paged-media
  renderer. The spike should compare PDF fidelity, browser preview quality,
  editable profile UX, local packaging, performance, generated artifact
  compatibility, and migration cost.
- Auto-suggest target roles, target locations, and work-model preferences in
  the Profile preferences editor based on the candidate's experience entries,
  current title, location history, and imported resume text. Keep suggestions
  optional and user-editable so the target-search lists remain explicit
  profile data.
- Add React component tests for persisted profile field save/discard
  behavior. `apps/web/src/contexts/profile/forms/profile-form.test.tsx` now
  covers form structure, validation, target-search controls, and preference
  editing affordances, and the update hooks are tested in isolation. What is
  still missing is a component test that drives a successful persisted save and
  then verifies discard/reset behavior against fresh initial data.
- Add browser smoke for action-status polling. Bulk action buttons are
  covered by `apps/web/e2e/tests/jobs-bulk.spec.ts`, `dry-run.spec.ts` covers
  the SSE connection/activity path, and `runs.spec.ts` covers the Workflow
  Runs list. No browser flow starts a stage and observes the action-status
  loop from queued/running to terminal. `apps/web/e2e/tests/materials.spec.ts`
  remains `test.fixme`'d pending the generate-materials backend enablement
  below.
- Decide whether row selection should be URL-persisted or kept as client
  state. Filters, sort, and page already survive live updates by virtue
  of the TanStack Router URL-state architecture; selection lives in
  `useState` in `apps/web/src/views/jobs/JobsView.tsx:51-66`, survives
  SSE invalidations (TanStack Table preserves `rowSelection` across query
  updates), and is cleared only on filter / sort / page change. If
  shareable selections become a requirement, promote to URL state.
- Add side-by-side artifact comparison in the app, including AI-assisted
  comparison for resume and cover-letter variants.
- Add AI-assisted improvement suggestions for resume items marked Required,
  starting with experience bullets. Suggestions should cover grammar and
  wording, relevance to a target job, achievement framing, evidence strength,
  and whether the item deserves required placement in the final resume.

## SaaS And Commercialization

These items are intentionally deferred until local validation is solid.

### Hosted Product

- Multi-tenant account model.
- Authentication and authorization.
- Subscription billing and entitlement checks.
- SaaS admin and support tooling.
- Hosted deployment architecture.

### Hosted Data

- Postgres migration plan.
- Object storage for generated artifacts.
- Encrypted secret vault.
- Audit log.
- Data retention policy.
- Export and deletion workflows.

### Hosted Automation

- Hosted browser isolation.
- Worker fleet orchestration.
- Queue service.
- Per-tenant concurrency and rate limits.
- Policy controls for auto-apply and CAPTCHA-adjacent behavior.

### Packaging And Distribution

- Signed local desktop package.
- Auto-update channel.
- License/entitlement check in the local app.
- Clear local/cloud boundary in user-facing documentation.

## Frontend Cloud-Mode Adapters

These are the named-not-built cloud adapters from
[`docs/frontend-target.md`](frontend-target.md) §9. The seam exists today;
the adapter swap is gated by the fitness function. Per the no-strangler
memo, when a fitness function fires the adapter swap is rip-and-replace —
no dual-mount, no compatibility shim.

- **TanStack Start (SSR) — replaces the Vite SPA bootstrap.** §9.1.
  Fitness function: p50 cold-load Time-to-Interactive on the dashboard
  exceeds 1 s on Fast 3G against a hosted deployment, OR a feature
  requires shareable public URLs (e.g., share a jobs filter view), OR
  SEO becomes a goal.
- **React Server Components (RSC) under TanStack Start.** §9.2.
  Candidates: `<ScoreBreakdown>`, `<StageTimeline>`, the activity feed.
  Fitness function: gzipped JS bundle exceeds 500 KB on the largest
  route AND TanStack Start RSC is stable.
- **`JwtSessionAdapter` (Auth0 / Cognito) for the `SessionPort`.** §9.3.
  Surfaces `<SessionProvider />`, `<RequireAuth />` route guard, and a
  `useSession()` hook returning `{ tenantId, userId, roles, expiresAt }`.
  Fitness function: the API is exposed beyond `127.0.0.1` (also the
  trigger for the backend Identity & Access context per
  `docs/ddd-target.md` §9.4).
- **Tenant-scoped routing prefix `/t/$tenantId/*`.** §9.4.
  TanStack Router layout route; tenant switcher in the AppShell;
  `<TenantProvider />` reads the path segment first, JWT default tenant
  second. Cache isolation is already free (query keys are tenant-first
  per `docs/frontend-target.md` §4.1). Fitness function: a single user
  belongs to more than one tenant.
- **`OpenTelemetryWebAdapter` for the `TelemetryPort`.** §9.5.
  Emits OTLP spans for route navigations, mutation calls, and error
  boundaries; sent to the backend's audit pipeline. Fitness function:
  SOC2 / GDPR access-log requirements arise.
- **CDN-cached projection reads.** §9.6.
  `apps/api` sets `Cache-Control: private, max-age=10,
  stale-while-revalidate=60` on projection endpoints; CloudFront /
  Cloudflare caches per-tenant per-query; the frontend's `staleTime`
  defaults align with the server cache headers. Fitness function:
  dashboard or jobs-list median latency exceeds 200 ms p50 from the
  client.
- **IndexedDB persistence for the Query cache (`StoragePort` IDB
  binding + `@tanstack/query-sync-storage-persister`).** §9.7.
  Uses the `?since=<persistedWatermark>` query string on the SSE
  endpoint to hydrate from the persisted watermark on first connect.
  Fitness function: average session duration > 5 min AND p95 cold-load
  TTI > 800 ms (both must hold; persistence has a cost — cache validity
  bugs become harder to reason about).
- **`WebSocketEventStreamAdapter` for the `EventStreamPort`.** §9.8.
  Same port interface; different transport. Fitness function: SSE drops
  connections behind common reverse proxies (CDN observation), OR the
  frontend needs to send messages over the same channel (e.g.,
  interactive worker control).
- **Web Push notifications via a `NotificationsPort`.** §7.9.
  For "your apply run completed" while the tab is closed. Fitness
  function: a user explicitly asks for background completion alerts AND
  the app is installed as a PWA / standalone shell.
- **Visual regression (Chromatic / Loki) over the existing Storybook
  bundle.** Fitness function: a visual regression escapes the Storybook
  test runner + a11y addon and lands in `main`. The snapshotter swap is
  a one-line CI change because every story already accepts the MSW
  addon and renders deterministically.

## Frontend Accessibility Backlog (Phase 7 Deferrals)

18 Storybook stories defer the a11y bar (`a11y: { test: "off" }`) because
they exercise pre-existing production accessibility defects that are scoped
out of the Phase 7 baseline. Each defect needs a follow-up production fix;
once fixed, the deferral is removed from the corresponding story
parameters.

| Production file | Defect | Stories that defer |
| --- | --- | --- |
| `apps/web/src/shared/ui/data-table.tsx` | Missing `role="row"` on table rows; missing `aria-sort` on sortable column headers. | `data-table.stories.tsx`, `JobsTable.stories.tsx`, `ArtifactsTable.stories.tsx` |
| `apps/web/src/shared/ui/toast.tsx` | `ToastClose` icon-only button has no accessible name (`button-name` axe rule). | `toast.stories.tsx`, `toaster.stories.tsx` |
| `apps/web/src/views/jobs/JobFilterBar.tsx` | Bare `<select>` element with no associated label (`select-name` axe rule). | `JobFilterBar.stories.tsx` |
| `apps/web/src/views/artifacts/ArtifactFilterBar.tsx` | Bare `<select>` element with no associated label. | `ArtifactFilterBar.stories.tsx` |
| `apps/web/src/views/jobs/JobsView.tsx` (composes the above) | Inherits `DataTable` + `JobFilterBar` defects. | `JobsView.stories.tsx` |
| `apps/web/src/views/artifacts/ArtifactsView.tsx` (composes the above) | Inherits `DataTable` + `ArtifactFilterBar` defects. | `ArtifactsView.stories.tsx` |
| `apps/web/src/views/runs/RunsView.tsx` (composes `DataTable`) | Inherits `DataTable` defects. | `RunsView.stories.tsx` |
| `apps/web/src/contexts/profile/components/StructuredProfileEditor.tsx` | Bare `<select>` elements with no labels; icon-only buttons missing accessible names. | `StructuredProfileEditor.stories.tsx`, `ProfileEditor.stories.tsx` (composes it) |
| `apps/web/src/contexts/apply/components/ApplyHistory.tsx` | TanStack Router `<Link>` rendered as a button without an accessible name. | `ApplyHistory.stories.tsx` |
| Radix `DropdownMenu` portal | `aria-hidden-focus` violation reported during the open animation (Radix transient internal state). | `dropdown-menu.stories.tsx` |
| Radix `Select` portal | `aria-hidden-focus` violation during the open transition. | `select.stories.tsx` |
| Radix `Popover` portal | Portal role / ARIA labelling requirements not satisfied by the stock Radix wrapper. | `popover.stories.tsx` |
| Radix `ScrollArea` viewport | `scrollable-region-focusable` axe rule fires because the viewport is not focusable. | `scroll-area.stories.tsx` |
| `cmdk` initial mount | `aria-required-children` violation during initial mount of the command palette. | `command.stories.tsx` |

Production fixes for the in-repo files (`data-table.tsx`, `toast.tsx`,
`JobFilterBar.tsx`, `ArtifactFilterBar.tsx`, `StructuredProfileEditor.tsx`,
`ApplyHistory.tsx`) unblock 13 of the 18 deferrals immediately. The five
remaining deferrals (Radix transient internals + cmdk) need either upstream
fixes or local wrappers with the missing ARIA plumbing.

## Frontend Tooling + CI Backlog (Phase 1–8 Deferrals)

These items were explicitly deferred during the frontend TanStack migration
and are tracked here per the migration plan §"Deferred follow-ups":

- **ESLint + dependency-boundary setup** — no ESLint config, lint script, or
  dependency-cruiser config exists today. Add `no-restricted-imports` /
  dependency-cruiser rules for the frontend architecture boundaries, then
  reconcile the currently direct `@jobhunter/contracts` imports in feature
  code with the intended Operations ACL before making the rule blocking
  (deferred from Phase 3, S-15).
- **CI grep guards for cut-over invariants** — `grep` rules in CI to fail
  on regressions of the rip-and-replace cut-overs: no `useState<JobSummary>`
  / `useState<DashboardSummary>` (server data in `useState`), no
  `useEffect(() => fetch(...))` (data fetching outside hooks), no
  `window.dispatchEvent` (cross-component coordination outside the URL /
  router / cache), no `useRef(0)` for stale-response dedup (TanStack Query
  handles this).
- **`pnpm web:lint` script** — named in the migration plan (S-15 / S-28
  exit criteria) but never landed. There is no ESLint config in
  `apps/web/` today, and no `lint` script in either the web package or
  the root. Lands together with the ESLint setup item above.
- **CI does not run `web:test`, `web:test-d`, or `web:e2e`.**
  `.github/workflows/typescript.yml` runs `pnpm -r check`,
  `pnpm --filter @jobhunter/api test`, `pnpm --filter @jobhunter/web build`,
  `pnpm --filter @jobhunter/web storybook:build`, and
  `pnpm --filter @jobhunter/web storybook:test` (with Playwright Chromium
  installed for the Storybook test runner). The Vitest unit / hook /
  component suite, the type-level tests, and the standalone Playwright e2e
  specs at `apps/web/e2e/` are developer-local only — a regression in any
  of those does not fail CI today. Wire the three jobs into
  `typescript.yml` once the root aliases land.
- **Frontend ACL `JobId` is unbranded** —
  `apps/web/src/contexts/operations/types.ts` exports
  `type JobId = string` rather than re-exporting the branded
  `string & { readonly [__jobIdBrand]: "JobId" }` from
  `@jobhunter/domain-types`. Intentional ACL simplification today (every
  user input flows through Zod schemas anyway), but the brand becomes
  load-bearing once tenants have multiple users — promote the ACL alias
  to the branded type then.
- **`data-testid` attributes on dashboard / jobs row selectors** — Phase 6
  reviewer follow-up. Playwright specs currently rely on text content for
  row selection, which is brittle as copy evolves.
- **`apps/api/test/qa-seed.ts` schema bump** — Phase 6 reviewer follow-up.
  The seed currently creates only the legacy tables (`jobs`,
  `job_stage_states`, `job_artifacts`, `job_events`,
  `apply_run_projections`). It is missing `job_scores`, `job_materials`,
  `job_materials_artifacts`, `jobhunter_deleted_jobs`, and
  `job_enrichments`. The seeded `job_stage_states` row also omits
  `metadata_json` and `version`, so it no longer represents the production
  projection schema closely enough.
- **Generate-materials backend enablement** — `docs/frontend-target.md`
  §3.6 / migration plan §7. The `useGenerateMaterialsMutation` hook
  still throws `NotImplementedError`, the button is disabled, and the HTTP
  route exists only to return `unsupported_per_job_material_action` (400).
  The gating dependency is a real targeted materials generation workflow /
  JSON-RPC command plus a 202 HTTP surface that the hook can call.
- **`DryRunCompleted` event addition to `DomainEventUnion`** — Phase 6
  reviewer note. The worker emits `DryRunCompleted`, and the apply-run
  projection maps it to `dry_run_complete`, but the frontend
  `DomainEventUnion` / SSE adapter does not include or listen for that event
  type. Add the typed event so the frontend can distinguish dry-run outcomes
  from real submissions without payload-shape inspection.
