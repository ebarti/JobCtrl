# Backlog

This is the authoritative roadmap. Keep detailed historical proposals under
`docs/plans/proposed/`; move delivered work to `docs/delivered.md`.

## Local Product Validation

### Frontend/API Parity

- Add event streaming or targeted row patching so lists do not reload wholesale.

### Worker Reliability

- Make every stage update `job_stage_states` through shared helpers.
- Normalize run records for all local actions.
- Add cancellation where practical for queued or running local actions.
- Record generated logs and reports as artifacts.
- Keep dry-run apply behavior covered by tests.

### Data Model Cleanup

- Introduce a stable `jobKey`.
- Separate original job URL from final application URL.
- Reduce reliance on legacy nullable `jobs` columns in read paths.
- Ensure artifact records are created before files are shown or opened in the UI.
- Split employer/company from source board in the job model so Greenhouse,
  LinkedIn, Talent.com, and direct employer records do not overload `site`.
- Index normalized scoring keywords per job, expose keyword filters/search, and
  add aggregate views or plots for keyword distribution across the pipeline.

### Scoring Intelligence

- Replace raw score reasoning strings with an explanatory score breakdown that
  shows why a job received its exact fit score.
- Let the user correct a job fit score, store the correction and rationale, and
  use that feedback to personalize scoring for the remaining jobs based on
  relevant signals to be defined.

### UI Quality

- Spike the best long-term resume rendering path. Evaluate whether to keep
  LaTeX as the PDF source of truth, switch to Tectonic, replace LaTeX with a
  different document engine such as Typst, or move to an HTML/CSS paged-media
  renderer. The spike should compare PDF fidelity, browser preview quality,
  editable profile UX, local packaging, performance, generated artifact
  compatibility, and migration cost.
- Add React tests for persisted profile field save/discard behavior.
- Add React tests for artifact open behavior.
- Add browser smoke coverage for action buttons and action status polling.
- Preserve user filters, sort, page, and selection during live updates.
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
  `.github/workflows/ci.yml` runs `pnpm -r check`,
  `pnpm --filter @jobhunter/api test`, `pnpm --filter @jobhunter/web build`,
  `pnpm --filter @jobhunter/web storybook:build`, and
  `pnpm --filter @jobhunter/web storybook:test`. The Vitest unit / hook /
  component suite, the type-level tests, and the Playwright specs are
  developer-local only — a regression in any of those does not fail CI
  today. Wire the three jobs into `ci.yml` once the root aliases land.
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
  The QA seed builder should track schema additions made during the
  frontend migration so seeded fixtures cover every read-model field.
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
