# Backlog

This is the authoritative roadmap. Keep detailed historical proposals under
`docs/plans/proposed/`; move delivered work to `docs/delivered.md`.

## Local Product Validation

### Frontend/API Parity

- Extend targeted row patching beyond the single `ApplyRunEventRecorded`
  handler at `apps/web/src/contexts/operations/invalidation-router.ts:128`.
  The SSE pipeline and invalidation router landed in Phase 5; every other
  event still triggers `invalidateQueries` (full list reload). Per-event
  `setQueryData` patches are the next step for jobs / artifacts / dashboard
  lists so live updates do not lose scroll position or trigger spinners.

### Worker Reliability

- Eliminate the second stage-state write path in
  `workers/automation/src/jobhunter/infrastructure/pipeline/sqlite_repository.py:249,296`
  that issues ad-hoc `UPDATE/INSERT INTO job_stage_states`. The canonical
  helper `state.set_stage_state` is used by every stage runner
  (`enrichment/detail.py:436`, `scoring/scorer.py:171`, `apply/launcher.py`,
  RPC handlers, …) — the repository should route through it too so all
  writes share validation and event emission.
- Extend the `apply_runs` canonical run-record table to non-apply local
  actions. Today only `apply` produces a row; `run_stage`, `profile_import`,
  and other JSON-RPC fire-and-forget actions only emit `job_events` and
  return an in-memory `LocalActionResult` (`workers/automation/src/jobhunter/actions.py:48`).
  Without a uniform run record, the dashboard cannot show running / queued /
  failed status for non-apply work.
- Add cancellation for queued or running local actions. `cancel_stage`
  (`workers/automation/src/jobhunter/infrastructure/rpc/handlers.py:112`)
  only flips the stage row to `canceled`; the JSON-RPC `fire_and_forget`
  thread (`server.py:90-96`) keeps no handle and the apply launcher has no
  cooperative cancel check. Add a cancel token surface (queue-side and
  in-process) so the UI cancel buttons actually interrupt work.
- Record generated logs and reports as artifacts. `record_job_artifact`
  (`workers/automation/src/jobhunter/state.py:304`) exists but is never
  called; apply log files are only kept on disk and stored as a string in
  `apply_runs.log_path`. Wire the helper into the apply / materials /
  scoring writers so logs and reports show up in the artifacts list.

### Workflow Orchestration (Local Temporal)

Adopt Temporal as the orchestration engine for the Python worker, run
**locally** for now (Temporal dev server / `docker compose` profile, no
managed service). The trigger is that several Worker Reliability items
above are converging on a small, badly-scaled workflow engine —
re-implementing durable retries, cancellation, and run records inside
SQLite is more expensive than adopting Temporal and pointing it at the
existing aggregates.

This work subsumes three of the Worker Reliability items above:

- "Add cancellation for queued or running local actions" — native
  workflow + activity cancellation.
- "Extend the `apply_runs` canonical run-record table to non-apply
  local actions" — the Temporal workflow execution ID becomes the
  canonical run record for every action.
- The ad-hoc `fire_and_forget` thread in
  `apps/api → workers/automation/.../server.py:90-96` and the TS
  `BackgroundQueue` go away — JSON-RPC starts a workflow instead and
  returns the workflow ID as the run handle.

Scope:

- Add `temporalio` to `workers/automation/pyproject.toml` and a
  `temporal` service to a local `docker compose` profile (or document
  the `temporal server start-dev` workflow in
  `docs/local-development.md`).
- Each pipeline stage (discover, enrich, score, tailor, cover, pdf,
  apply) becomes a Temporal **Activity** owned by its bounded context
  under `workers/automation/src/jobhunter/<context>/activities.py`.
- A `JobPipelineWorkflow` (one per `(TenantId, JobId)`) orchestrates
  the stages, owns the retry policies that today live in
  `state.set_stage_state` defaults, and consults the existing
  `StageStateMachine` for transition validity.
- `apply_runs` collapses into a workflow run; the read-side projection
  sources from a Temporal completion sink (or workflow history query)
  rather than the bespoke table.
- The `JsonRpcServer.fire_and_forget` path in
  `workers/automation/src/jobhunter/infrastructure/rpc/server.py:90`
  starts a workflow and returns the workflow ID; the existing JSON-RPC
  contract (`run_stage`, `apply`, `profile_import`, …) is preserved.
- Add a Workflow Runs view in the UI that surfaces in-progress /
  failed / completed runs with a deep-link to the Temporal Web UI
  (`http://127.0.0.1:8233` by default) for live debugging during the
  local-dev phase.

Out of scope (stays in [`TODO_FUTURE.md`](../TODO_FUTURE.md)):

- Managed Temporal Cloud,
- distributed worker fleet (multi-machine task queues),
- cross-tenant isolation in workflows,
- Temporal-specific production observability stack.

### Data Model Cleanup

- Cut the `jobs` table over from URL primary key to `JobId`. Domain has
  `JobId` (`workers/automation/src/jobhunter/domain/identifiers.py:12`) and
  the projections expose `jobKey`, but the storage layer still uses
  `jobs.url TEXT PRIMARY KEY` (`database.py:97`) with cross-aggregate FKs
  on `job_url` (`database.py:262, 345, 372, 385, 680, 787, 804`). The
  read-model resolves `jobKey` via URL fallback (`apps/api/src/read-model.ts:266-280`).
  Until the cut-over, `jobKey` is a projection alias for the URL, not a
  stable independent identity.
- Drop the legacy `jobs.application_url` column and the COALESCE fallback
  at `apps/api/src/projections.ts:726`. Domain TS already separates
  `Job.postingUrl` from `Enrichment.applicationUrl`
  (`packages/domain-types/src/discovery/job.ts:110`,
  `packages/domain-types/src/enrichment/enrichment.ts:108`); the storage
  layer should follow.
- Stop projection BUILDERS from sourcing legacy nullable `jobs.*` columns.
  `apps/api/src/projections.ts:700-742` and the Python builder at
  `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py:208`
  still fall back to `jobs.fit_score`, `jobs.application_url`,
  `jobs.tailored_resume_path`, `jobs.cover_letter_path`, `jobs.applied_at`,
  `jobs.apply_status`. The read-side already moved to projections in
  Phase 9 (S-33); the build-side is the remaining half.
- Stop `apps/api/src/projections.ts:946-975` from synthesising phantom
  `*_pdf` artifact rows from sibling `.txt` files with no DB record. Only
  real DB-backed artifacts should be exposed; the file-existence check at
  `server.ts:358` is the only guard today and the synthesised rows are
  indistinguishable from real ones in the UI.
- Persist domain `Source.board` and `Employer.name` directly. The domain
  types are split (`packages/domain-types/src/discovery/job.ts:44-52,111`)
  and the projection table has both columns, but the values are still
  populated from `jobs.site` (`projections.ts:725, 791`) and `companyName()`
  infers the employer from URL slugs because the domain `Employer` is
  never persisted. Until the storage layer captures both, "filter by
  board" + "filter by employer" cannot be separated.
- Index normalized scoring keywords per job. `keywords_json` is written
  and read in `workers/automation/src/jobhunter/infrastructure/scoring/sqlite_repository.py`
  but is unindexed, has no contract field
  (`packages/contracts/src/schemas.ts` has zero `keywords` references),
  no API filter, and no UI. The web parses keywords from a free-text
  reasoning string (`apps/web/src/contexts/scoring/lib/parse-reasoning.ts:9`)
  as a stop-gap. Promote keywords to a typed contract, expose
  filter/search, and add aggregate views.

### Scoring Intelligence

- Populate and expose the typed `ScoreBreakdown` dimensions
  (`technical_fit` / `experience_fit` / `role_fit`,
  `workers/automation/src/jobhunter/domain/scoring/value_objects.py:103-105`).
  Today the parser leaves the components at zero
  (`scoring/services.py:86-94, 174`); the contract only ships
  `scoreReasoning: string` (`packages/contracts/src/schemas.ts:498`); and
  the frontend `ScoreBreakdown.tsx` just wraps free text. Write the
  components in the scorer, add them to the contract, and render them in
  the jobs drawer.
- Wire the user-correctable score path end-to-end. The `ScoreCorrected`
  domain event and `JobScore.with_correction` exist; the frontend has a
  handler (`apps/web/src/contexts/scoring/handlers.ts:13`); but
  `useCorrectScoreMutation` throws `NotImplementedError`
  (`apps/web/src/contexts/scoring/hooks/useCorrectScoreMutation.ts:19`),
  there is no API endpoint in `apps/api/src/server.ts`, and no UI form.
  Once the surface lands, define which signals (job text, employer, score
  delta, rationale tokens) feed back into scoring for remaining jobs.

### UI Quality

- Spike the best long-term resume rendering path. Evaluate whether to keep
  LaTeX as the PDF source of truth, switch to Tectonic, replace LaTeX with a
  different document engine such as Typst, or move to an HTML/CSS paged-media
  renderer. The spike should compare PDF fidelity, browser preview quality,
  editable profile UX, local packaging, performance, generated artifact
  compatibility, and migration cost.
- Add React component tests for persisted profile field save/discard
  behavior. `apps/web/src/contexts/profile/forms/` only has `*.a11y.test.tsx`
  files today (axe-only); the `useUpdateProfileMutation` /
  `useUpdateSettingsMutation` hooks are tested in isolation but no test
  drives the form's save and reset interactions together.
- Add browser smoke for action-status polling. Bulk action buttons are
  already covered by `apps/web/e2e/tests/jobs-bulk.spec.ts`; nothing
  exercises the status-poll loop. `apps/web/e2e/tests/materials.spec.ts`
  is `test.fixme`'d pending the generate-materials backend enablement
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

17 Storybook stories defer the a11y bar (`a11y: { test: "off" }`) because
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
| `apps/web/src/contexts/profile/components/StructuredProfileEditor.tsx` | Bare `<select>` elements with no labels; icon-only buttons missing accessible names. | `StructuredProfileEditor.stories.tsx`, `ProfileEditor.stories.tsx` (composes it) |
| `apps/web/src/contexts/apply/components/ApplyHistory.tsx` | TanStack Router `<Link>` rendered as a button without an accessible name. | `ApplyHistory.stories.tsx` |
| Radix `DropdownMenu` portal | `aria-hidden-focus` violation reported during the open animation (Radix transient internal state). | `dropdown-menu.stories.tsx` |
| Radix `Select` portal | `aria-hidden-focus` violation during the open transition. | `select.stories.tsx` |
| Radix `Popover` portal | Portal role / ARIA labelling requirements not satisfied by the stock Radix wrapper. | `popover.stories.tsx` |
| Radix `ScrollArea` viewport | `scrollable-region-focusable` axe rule fires because the viewport is not focusable. | `scroll-area.stories.tsx` |
| `cmdk` initial mount | `aria-required-children` violation during initial mount of the command palette. | `command.stories.tsx` |

Production fixes for the in-repo files (`data-table.tsx`, `toast.tsx`,
`JobFilterBar.tsx`, `ArtifactFilterBar.tsx`, `StructuredProfileEditor.tsx`,
`ApplyHistory.tsx`) unblock 13 of the 17 deferrals immediately. The four
remaining (Radix transient internals + cmdk) need either upstream fixes
or local wrappers with the missing ARIA plumbing.

## Frontend Tooling + CI Backlog (Phase 1–8 Deferrals)

These items were explicitly deferred during the frontend TanStack migration
and are tracked here per the migration plan §"Deferred follow-ups":

- **ESLint setup** — `no-restricted-imports` to forbid `@jobhunter/api-client`
  and `@jobhunter/contracts` outside the `contexts/operations/types.ts` ACL,
  plus `dependency-cruiser` to enforce view → context one-way direction
  (deferred from Phase 3, S-15).
- **CI grep guards for cut-over invariants** — `grep` rules in CI to fail
  on regressions of the rip-and-replace cut-overs: no `useState<JobSummary>`
  / `useState<DashboardSummary>` (server data in `useState`), no
  `useEffect(() => fetch(...))` (data fetching outside hooks), no
  `window.dispatchEvent` (cross-component coordination outside the URL /
  router / cache), no `useRef(0)` for stale-response dedup (TanStack Query
  handles this).
- **Root-level `pnpm web:test` / `web:test:watch` / `web:test:coverage` /
  `web:test-d` / `web:e2e` / `web:e2e:headed` aliases** in `package.json` —
  the migration plan and `docs/frontend-target.md` §10.9 reference these
  commands as if they were aliased at the root, but Phase 6 only added the
  `apps/web/package.json` scripts. Today, these run via
  `pnpm --filter @jobhunter/web <script>` (documented in
  [`docs/local-development.md`](local-development.md)).
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
  `job_stage_states`, `job_artifacts`, `job_events`, `apply_runs`). It is
  missing `job_scores` (read at `apps/api/src/projections.ts:484`),
  `job_materials` + `job_materials_artifacts` (lines 437, 442, 451),
  `jobhunter_deleted_jobs` (line 598), and `job_enrichments`. The seeded
  `job_stage_states` row also omits the `metadata_json` and `version`
  columns expected at `projections.ts:114-115`.
- **Generate-materials backend enablement** — `docs/frontend-target.md`
  §3.6 / migration plan §7. The `useGenerateMaterialsMutation` hook
  exists; the backend `GenerateMaterialsUseCase` exposure on the JSON-RPC
  / HTTP surface is the gating dependency.
- **`DryRunComplete` event addition to `DomainEventUnion`** — Phase 6
  reviewer note. The dry-run apply path completes via the generic
  `ApplicationSubmitted` / `ApplicationFailed` events today; a dedicated
  `DryRunComplete` event would let the frontend distinguish dry-run
  outcomes from real submissions in the activity feed and the apply-run
  card without payload-shape inspection.
