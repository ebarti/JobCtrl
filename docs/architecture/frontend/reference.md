# 12–15. Risks, Glossary & Resolutions

Risks (§12), glossary (§13), open-question resolutions (§14), and what the
architecture deliberately does not decide (§15). Part of the
[Frontend Architecture](index.md) reference.

**Read this if** you are assessing a frontend design risk, looking up a term,
or checking whether an open question was already resolved.

## 12. Risks

The frontend has its own concrete risk surface. This section enumerates
the risks the architecture creates or amplifies, with the mitigation
each design choice provides. It mirrors the backend domain model [§10](../domain-model/reference.md) "Risks"
list in shape and rigor.

### R1. Cache-invalidation correctness — the router is a single point of failure

The invalidation router (§7.4) is the contract between every backend
event and every frontend cache key. A missed handler silently breaks a
context's freshness; a wrong handler can over- or under-invalidate.

**Mitigations:**
- Compile-time `Record<DomainEventType, InvalidationHandler>` typing
  forces a handler entry for every event variant (§7.4 fitness function).
- Runtime parity test (`every-event-has-handler.test.ts`, §10.2) catches
  obvious empty stubs that pass TypeScript.
- Per-event unit tests (§10.2: "the most important unit test in the
  app") assert exact `invalidateQueries`/`setQueryData` calls per event;
  regressions in the routing rules fail CI.
- The router is a *pure function*; no React, no network, no QueryClient
  internals — easy to reason about and easy to fork in a debugger.

### R2. Optimistic-update rollback bugs

Synchronous mutations (§5.3) optimistic-patch the cache in `onMutate`
and roll back in `onError`. A patch that does not symmetrically reverse
leaves the cache in an invalid state.

**Mitigations:**
- The `onMutate` patcher is a **pure function**; the rollback simply
  restores the snapshot, never re-derives.
- Mutation hooks have unit tests (§10.3) that assert: (a) the optimistic
  shape after `onMutate`, (b) the rolled-back shape after `onError`,
  (c) the reconciled shape after `onSettled` invalidates and refetches.
- The standard pattern (snapshot → patch → rollback → invalidate) is
  encoded in a small helper (`createOptimisticMutation` in
  `shared/lib/`); per-mutation code provides only the patcher and the
  affected key set, not the full ceremony.

### R3. SSE delivery gaps under reverse-proxy / CDN buffering

Even with `Last-Event-ID`, a reverse proxy or CDN that buffers
`text/event-stream` responses can delay events long enough that the
client perceives the stream as silent. A connection drop combined with a
buffer flush can cause events to arrive out of order or be dropped if
the upstream advances its watermark before redelivery.

**Mitigations:**
- The 30s "connection lost — events paused" UI banner (§7.7) makes the
  failure visible to the user.
- On reconnect, the `EventStreamProvider` triggers a one-shot
  `queryClient.invalidateQueries()` (full cache invalidation) as a
  backstop; `Last-Event-ID` covers the common case, the full
  invalidation covers the long-gap case.
- The endpoint sets `X-Accel-Buffering: no` (§7.1) to disable nginx /
  proxy buffering at the edge.
- The client periodically receives `event: heartbeat` (every 30s)
  carrying the current event-id watermark; a stale watermark
  (`> 60s` behind expected) marks the stream `degraded` and triggers
  reconnect.

### R4. Route-loader prefetch racing with mutations

A loader-driven `ensureQueryData(...)` runs before navigation
finalizes; a mutation invalidating the same key mid-navigation can
cause the loader to return a stale snapshot.

**Mitigations:**
- Loaders use `ensureQueryData`, not `fetchQuery` — `ensureQueryData`
  honors stale state and triggers a background refetch when needed.
- Mutations that change a route's data set explicitly call
  `router.invalidate()` after the mutation settles, forcing the affected
  routes' loaders to re-run.
- Mutations have a `meta: { affectsRoutes: ['/jobs', '/dashboard'] }`
  field consumed by a small middleware that calls `router.invalidate()`
  for the affected routes.

### R5. `exactOptionalPropertyTypes` adoption surfaces latent bugs

Adopting `exactOptionalPropertyTypes: true` (§2.5) turns `{ x: undefined }`
and `{}` into distinct types. Existing code in `@jobctrl/contracts`
consumers may rely on the conflated form and break.

**Mitigations:**
- The strict-TypeScript adoption is part of the same change that adopts
  the new architecture; there is no parallel old/new code path to
  reconcile (`feedback_no_strangler.md`).
- The compiler errors are exhaustive at adoption time; nothing escapes
  to runtime.
- Where the strictness conflicts with API ergonomics (e.g., a setter
  that wants to clear a field), the explicit `field: undefined` shape is
  used and the type is narrowed to `T | undefined` rather than `T?`.

### R6. `window.dispatchEvent` deletion regression risk

The current `App.tsx` uses untyped custom events
(`jobctrl:set-jobs-filter`) for cross-component coordination. The
target deletes these in favor of URL navigation, Zustand stores, and
the query cache. A missed callsite means a button silently no-ops.

**Mitigations:**
- A grep guard in CI (`! grep -rE "dispatchEvent\\(new CustomEvent" apps/web/src`)
  fails the build if the pattern reappears.
- An ESLint rule (`no-restricted-syntax`) flags `CustomEvent`
  construction in feature code (allowing only `shared/ports/adapters/`).
- The Playwright smoke flow exercises the dashboard-KPI →
  jobs-filter-prefill flow that the custom event powered; deletion regression is
  caught in E2E.

### R7. Drift between `@jobctrl/domain-types` events and SSE payloads

The backend writes `payload_json`; the frontend consumes it against the
`@jobctrl/domain-types` event union. That union is **plain TypeScript,
not Zod** (§7.2): `parseDomainEvent` only checks that `eventType` is in
`DOMAIN_EVENT_TYPES` and that the payload parses to an object — it does
**not** validate the payload *shape*. So an out-of-shape or under-populated
payload is not rejected at runtime; the compiler trusts the declared type.

**Mitigations:**
- A new *event type* is caught: an unknown `eventType` is dropped at the
  boundary, and adding a backend event forces a `DomainEventUnion` arm +
  an invalidation handler (compile-time `Record<DomainEventType, …>` +
  the parity test, §7.4/§10.2).
- The backend's `scripts/check-domain-type-parity.py` enforces TS↔Python
  parity on the taxonomy, so the event *set* cannot silently diverge.
- Payload *field* drift is not runtime-validated (no Zod). The discipline
  is: change the shared type first, the writer second, the reader third,
  in one atomic PR — cheap for a single-user product. Adding runtime
  payload validation (e.g., a Zod layer in `parseDomainEvent`) is the
  named escalation if field drift ever bites.

### R8. View-vs-context boundary erosion

The architecture forbids contexts from depending on views, and views
from depending on each other. As features grow, the temptation to import
a view component into a context (or to share helpers between two views
"just for now") will rise.

**Mitigations:**
- An ESLint dependency-cruiser rule enforces the dependency direction:
  `contexts/*` cannot import from `views/*`; `views/*` cannot import
  from other `views/*`.
- The CODEOWNERS file routes `contexts/` and `views/` to the same
  reviewer, ensuring boundary-crossing PRs get explicit attention.
- The legacy-named `JobDetailDrawer` route-workspace example (§8.5) is the canonical reference for
  composition; new cross-context UI surfaces follow the same pattern.

### R9. Aggressive `staleTime` defaults masking SSE-router bugs

The `staleTime` defaults (§5.4) are intentionally generous (30s default,
0 for dashboard). If the SSE router fails silently (per R1), the user
sees stale data for up to `staleTime` even with the
`refetchOnWindowFocus: true` backstop.

**Mitigations:**
- The SSE connection-status dot/glyph plus text (§7.7) makes degraded state visible.
- The dashboard's `staleTime: 0` ensures the most-watched surface is
  always fresh on remount.
- The router's parity test (R1 mitigations) prevents the silent-failure
  mode in the first place.

### R10. Bundle-size growth as features compound

Per-route code splitting (§4.3) limits initial-load cost, but a single
large route (e.g., the jobs view with the full data-grid machinery + all
column renderers from every context) can dwarf others.

**Mitigations:**
- The CI step `pnpm web:build` reports bundle sizes per route; a
  ratchet (TBD threshold) fails CI on regression beyond X% of the
  previous main commit's size.
- Heavy components (e.g., the resume PDF iframe, the Storybook story
  loader) are dynamically imported behind `React.lazy`.
- The "evolution to RSC" path (§9.2) has its own fitness function that
  triggers when this risk becomes blocking.

### R11. Wizard-store persistence corruption

The resume-import wizard stores draft state in Zustand+persist
(`localStorage`). A schema change to the draft shape between deploys
can leave a half-completed wizard in an unparseable state.

**Mitigations:**
- The Zustand `persist` middleware uses a `version` field; the version handler
  discards the persisted state on schema change rather than attempting to
  transform it (single-user app, the wizard is restartable).
- The wizard's first step (`/profile/import/upload`) clears the store
  on entry if `version` is stale.
- The store's read path narrows the parsed shape with a Zod schema;
  parse failures discard.

### R12. JSON-RPC `runId` correlation gaps

Async (202) mutations return a `runId` from the JSON-RPC adapter; the
frontend stores this and waits for the SSE event to invalidate. If the
SSE event arrives before the mutation's promise resolves (race), the
invalidation may be dropped because the cache key for the
"in-flight" state is not yet populated.

**Mitigations:**
- Mutations write the optimistic "in-flight" cache entry in `onMutate`,
  *before* the network call. The SSE handler can therefore find a
  cache entry to invalidate / patch even if the event arrives mid-flight.
- The `runId` is included in the request payload (idempotency key) and
  echoed in events; the frontend correlates by `runId`, not by
  request-response timing.

### R13. API job-key compatibility — `apps/api` still accepts `jobKey: string`

The frontend's domain language is `JobId` per backend domain model [§4.1](../domain-model/tactical.md). The API
client still accepts `jobKey: string` for compatibility:
`apiClient.deleteJob(jobKey: string, ...)`.

**Mitigations:**
- The frontend ACL (§6.5) is the single mapping site:
  `useDeleteJobMutation({ jobId })` calls `apiClient.deleteJob(jobId, ...)`
  with the `JobId` value passed as the API's currently-named `jobKey`
  parameter. When the backend rename lands, only the ACL changes; every
  call site is already on `jobId: JobId`.
- A `JobId` value is brand-typed (`string & { __brand: "JobId" }`) so
  passing a raw string fails TypeScript at the boundary — the developer
  must explicitly construct via `createJobId(...)` from
  `@jobctrl/domain-types`.

### R14. Materials-set generation invalidation under concurrent re-tailoring

If the user clicks "Generate Materials" twice in rapid succession, two
runs may interleave with their `ResumeApproved` events. The
invalidation router invalidates `jobsKeys.detail` on each event, which
is correct, but the optimistic "queued" indicator can briefly show the
wrong run's status if the second mutation's `onMutate` runs before the
first's reconciliation.

**Mitigations:**
- The optimistic patcher records `runId` in the cache entry; the SSE
  handler matches by `runId` before applying.
- The "Generate Materials" button is `disabled` when a generation is
  in flight (`useIsMaterialsRunInFlight(jobId)` selector reads the
  cache).

---

## 13. Glossary

| Term | Context | Definition |
|---|---|---|
| **ACL (Frontend)** | Architecture | The thin Anti-Corruption Layer in `contexts/operations/types.ts` that re-exports backend projection types into frontend code. Provides a single point to refine or override types as the frontend evolves. |
| **ApiClientPort** | Frontend (Hexagonal) | The interface through which feature code reaches the backend HTTP API. Local adapter wraps `@jobctrl/api-client`; hosted adapter adds JWT injection. |
| **AppliedAction** | Frontend (Apply context) | UI affordance to manually mark a job as applied without running the apply automation. Surfaces `MarkAppliedUseCase`. |
| **ApplyRunBadge** | Frontend (Apply context) | Legacy-named status component that renders a compact dot/glyph plus text in dashboard ledgers and run detail workspaces to summarize an `ApplyRun`'s current `SubmissionResult`. |
| **ApplyRunTimeline** | Frontend (Apply context) | Live-updating timeline of `ApplyRunEvent` rows; updates via SSE `setQueryData` (not `invalidate`) for high-frequency events. |
| **AppShell** | Frontend (Layout) | The persistent chrome around the route content: a grouped left rail (14 destinations in 5 groups via `SideRail`) that users can collapse to accessible icons on desktop with the choice persisted in `jh:ui-preferences`; mobile uses a separate navigation sheet. A slim topbar provides the desktop rail trigger, global job search that navigates to `/jobs?q=…`, density and theme toggles, and inline connection-status dot/glyph plus text. Lives in `shared/layout/AppShell.tsx`. |
| **Bounded Context (Frontend)** | Architecture | A folder under `contexts/` mirroring a backend bounded context (one of the nine: Discovery, Enrichment, Profile, Scoring, Materials, Apply, Pipeline, Operations, Contact & Outreach). Owns its query keys (where applicable), hooks, components, forms, selectors, and event handlers. Imports from `shared/` and from other contexts' *components* only. |
| **CacheKey (Profile HTML)** | Frontend (Profile) | A monotonically increasing token derived from the profile mutation count, appended as `?v=...` to the Profile baseline resume HTML preview URL to refresh the Plate editor after each profile mutation. |
| **ClipboardPort** | Frontend (Hexagonal) | Port abstracting `navigator.clipboard`, exposed so feature code does not depend on `window`. |
| **CommandPalette** | Frontend (Shared) | A `cmd-k` style palette rendered above all routes, backed by a Zustand store; named-not-built (deferred until needed). |
| **Composer (View)** | Frontend (Pattern) | A view component (e.g., `JobDetailDrawer`) that imports rendering components from multiple contexts. Composers own layout, never data fetching across contexts (except read hooks from Operations). Lives under `views/`, not under `contexts/`. |
| **CopyableCommand** | Frontend (Shared UI) | `<CopyableCommand command={...} />` primitive in `shared/ui/`. Renders a CLI command with a copy-to-clipboard affordance. Preserves the "copyable commands stay" behavior from `docs/decisions.md` (2026-05-03) — buttons call structured mutations, but the CLI string remains visible for transparency / debugging. |
| **DashboardProjection** | Operations (Frontend mirror) | The shape of the dashboard summary returned by `apiClient.dashboardSummary()`; defined in `@jobctrl/domain-types` (`operations/`) and re-exported through `@jobctrl/contracts`. |
| **Density** | Frontend (UI Preferences) | Row-spacing preference: `compact | regular | comfy`. Persisted to `localStorage` via Zustand. |
| **Discovery (Frontend)** | Frontend (Bounded Context) | The frontend folder mirroring backend Job Discovery. Owns job-lifecycle mutations (delete / hide / restore / permanent-delete + `useImportJobMutation`), discovery-source administration (settings, source registry, quarantine, manual capture, feedback), the `<DiscoveryProductControls>` UI, and 17 discovery-event invalidation handlers. |
| **DomainEvent (Frontend mirror)** | Operations | The event taxonomy streamed via SSE. In `@jobctrl/domain-types` this is a **plain TypeScript** discriminated union `DomainEventUnion`; `DomainEvent<T, P>` is the generic base, `DomainEventType` the discriminant union, and `DOMAIN_EVENT_TYPES` the canonical runtime array. No Zod. |
| **Detail Route** | Frontend (Routing) | A child route (e.g., `routes/jobs.$jobId.tsx`) that renders a full `RouteWorkspace` with a back action. URL-owned list state survives so returning restores the underlying list. |
| **Enrichment (Frontend)** | Frontend (Bounded Context) | The frontend folder mirroring backend Job Enrichment. Owns `useEnrichmentRetryMutation`, the compensation-refresh mutations, the compensation-evidence components, and the enrichment/compensation invalidation handlers. |
| **Event-Handler Parity Test** | Frontend (Testing) | The local Vitest parity test that iterates the `DomainEventType` union and asserts a handler is registered for every variant in `contexts/operations/invalidation-router.ts`. Backstops the compile-time `Record<DomainEventType, InvalidationHandler>` typing (the CI-enforced half, via `pnpm -r check`); web Vitest is not yet CI-gated (CI gating tracked in `docs/backlog.md`). Mirrors backend `scripts/check-domain-type-parity.py`. |
| **EventStreamPort** | Frontend (Hexagonal) | Port abstracting the SSE connection. Local adapter is `SseEventStreamAdapter`; hosted alternative is `WebSocketEventStreamAdapter`. |
| **EventStreamProvider** | Frontend (Provider) | Component mounted in `__root.tsx` that opens the event-stream subscription, wires it to the invalidation router, and exposes connection status. |
| **FeatureFlagPort** | Frontend (Hexagonal) | Port for feature gating. Local adapter is `StaticFeatureFlagAdapter` (always returns defaults); hosted adapter is backend-served via `apiClient.featureFlags()` and cached in Query. The seam exists today; no flags ship now. |
| **Frontend Bounded Context** | Architecture | See "Bounded Context (Frontend)." |
| **InvalidationRouter** | Frontend (Operations) | Pure function mapping `DomainEvent` to a list of cache operations (`invalidateQueries` / `setQueryData`). The single contract surface between the backend's event taxonomy and the frontend's query cache. |
| **JobActions** | Frontend (Pipeline composer) | Toolbar component composing per-stage / per-action buttons (`<RetryStageButton />`, `<GenerateMaterialsButton />`, `<ApplyButton />`, `<MarkAppliedButton />`, etc.). |
| **JobDetailDrawer** | Frontend (Jobs view) | Legacy filename/component name for the full `RouteWorkspace` in `views/jobs/` that opens when a job is selected. It composes the header ledger, ruled evidence sections, inspector, score, stages, artifacts, apply history, and actions from the contexts that own each. It is not a detached drawer or side sheet. |
| **JobId** | Domain (shared) | The system-generated stable identifier for a job per backend domain model [§3.1](../domain-model/strategic.md) / [§4.1](../domain-model/tactical.md). Branded type (`string & { __brand: "JobId" }`) constructed via `createJobId(...)` from `@jobctrl/domain-types`. The frontend uses `JobId` as its domain term throughout; the API client's currently-named `jobKey: string` parameter is a transport detail mapped at the ACL boundary ([§6.5](../domain-model/integration.md)). |
| **JobsTable** | Frontend (Jobs view) | The shared data-grid instance in `views/jobs/JobsTable.tsx` rendering the jobs list; receives data from `useJobsListQuery` (Operations) and column cell components from `contexts/scoring/`, `contexts/pipeline/`, etc. |
| **KPI** | Frontend (Dashboard) | A top-line metric in the dashboard's continuous ruled ledger. |
| **LayerSeparation** | Frontend (Modeling) | The architectural rule that every datum lives in exactly one of three layers: server (Query), URL (Router), or client (Zustand/Context). See §2.1. |
| **Loader (Route)** | Frontend (Routing) | A function on a TanStack Router route that prefetches data via `queryClient.ensureQueryData(...)` before the component renders. |
| **LOCAL_TENANT** | Domain (shared) | The singleton `TenantId` used in local mode. Threaded through every query key and SSE subscription. |
| **MutationInvalidationStrategy** | Frontend (Operations) | The hybrid policy: optimistic updates for synchronous mutations; SSE-driven invalidation for async (202) mutations. See §8.3. |
| **OpenInOsPort** | Frontend (Hexagonal) | Port for "open this artifact in the OS default app" — a local-only feature. The hosted adapter returns "Unsupported" and the UI offers a download instead. |
| **Operations (Frontend)** | Frontend (Bounded Context) | The frontend's read-side kernel. Owns query-key registry, projection-typed hooks, SSE subscription, and the invalidation router. Mirrors the backend's Operations / Read-Side context. |
| **Optimistic Update** | Frontend (Mutations) | Cache patch applied immediately in `onMutate`, rolled back in `onError`, reconciled in `onSettled` via `invalidateQueries`. Used for synchronous mutations only. |
| **PdfExportPort** | Frontend (Hexagonal) | Browser capability that converts the currently mounted Plate resume document into a direct PDF download. The adapter uses a browser-rasterized visual layer plus invisible searchable text, receives a DOM element rather than a local path, and does not save editor state or register an artifact. |
| **Port (Frontend)** | Frontend (Hexagonal) | An interface in `shared/ports/`. Feature hooks depend on the interface; concrete adapters bind to it via `<PortsProvider />`. Enables test mocking and named-not-built cloud evolution. |
| **PortsProvider** | Frontend (Provider) | The React context that supplies concrete port adapters to the entire app. Tests can pass mocks. |
| **Projection** | Operations | A denormalized read shape (e.g., `JobListProjection`) returned by the backend's projection-backed query layer. The frontend's Query cache stores projections; components consume them as `readonly` data. |
| **QueryKeyFactory** | Frontend (Operations) | A per-context object (e.g., `jobsKeys`) whose methods produce hierarchical, tenant-prefixed query keys. Enables type-safe and surgical invalidation. |
| **QueryKeyRegistry** | Frontend (Operations) | The `contexts/operations/queryKeys.ts` module that re-exports every context's factory, providing a single import surface for cross-context invalidation. |
| **ResumeImportWizard** | Frontend (Profile) | The multi-step nested-route flow for importing a profile from a resume PDF. Step state persists in a Zustand+persist store. |
| **RouteGuard** | Frontend (Routing, Future) | A wrapper (e.g., `<RequireAuth />`) applied to a route group to enforce session presence. Named-not-built; surfaces when `JwtSessionAdapter` ships. |
| **SearchParamSchema** | Frontend (Routing) | The Zod schema declared on a route that types its URL search params. Inferred type drives `useSearch()`. |
| **SessionPort** | Frontend (Hexagonal) | Port resolving `TenantId` and `UserId`. Local adapter returns `LOCAL_TENANT`; hosted adapter parses JWT. |
| **Shared Data Grid (`FilterableDataGrid`)** | Frontend (UI Primitive) | The custom table primitive in `shared/ui/filterable-data-grid.tsx`, used by the jobs, artifacts, runs, and debug/activity tables via per-view `DataGridColumn<T>[]` column models. Provides sort, per-column filter, pagination, row selection, and row activation. `@tanstack/react-table` is a types-only dependency (`RowSelectionState` / `SortingState`); the shadcn `data-table.tsx` wrapper is unused. |
| **SseEventStreamAdapter** | Frontend (Adapter) | Concrete `EventStreamPort` implementation using the browser's `EventSource` API against `GET /v1/events/stream`. |
| **StageBadge** | Frontend (Pipeline context) | Legacy-named status component rendering a `StageState` as a compact dot/glyph plus text via exhaustive `switch` on `state.kind`. Located in `contexts/pipeline/components/StageBadge.tsx`; it is not a colored pill. |
| **Stage-State Parity Test** | Frontend (Testing) | The local Vitest parity test that iterates `STAGE_STATE_KINDS` and asserts `<StageBadge>` renders a non-default arm for every kind. Backstops the exhaustive `switch` on `state.kind`. (Web Vitest is not yet CI-gated; CI gating tracked in `docs/backlog.md`.) |
| **StageTimeline** | Frontend (Pipeline context) | Vertical list of stages for a job, rendered from `JobDetailProjection.stages`. |
| **StoragePort** | Frontend (Hexagonal) | Port abstracting persistent client-side storage. Local adapter is `localStorage`; hosted alternative is IndexedDB. |
| **TanStack Form** | Frontend (Library) | Headless form library with field-level subscriptions, used for all forms (profile, settings, credentials, wizard). |
| **TanStack Query** | Frontend (Library) | The server-state cache. All projection reads, mutations, and SSE-driven invalidations route through it. |
| **TanStack Router** | Frontend (Library) | The routing library. File-based routes via Vite plugin; typed search params via Zod schemas; per-route loaders for prefetching. |
| **TanStack Start** | Frontend (Evolution) | The SSR/RSC framework built on TanStack Router and Query. Named as the SSR evolution path; not built today. |
| **TelemetryPort** | Frontend (Hexagonal) | Port for emitting frontend telemetry. Local adapter is no-op + console; hosted adapter is `OpenTelemetryWebAdapter`. |
| **TenantPrefix** | Frontend (Query keys) | The first segment of every query key: `["tenant", tenantId, ...]`. Ensures cache isolation across tenants from day one. |
| **TenantProvider** | Frontend (Provider) | Context that exposes `useTenantId()`. Today reads from `LocalSessionAdapter`; tomorrow from JWT. |
| **ThemeProvider** | Frontend (Provider) | Context exposing `useTheme()`; reads from the `ui-preferences` Zustand store and writes `data-theme="..."` on `<html>`. |
| **ToastQueue** | Frontend (Shared) | The Zustand store driving the shadcn `<Toaster />`. Mutations call `toast({ ... })` from `onError`. |
| **Typed Search Params** | Frontend (Routing) | URL search params declared by a Zod schema on a route, inferred-typed for `useSearch()`. The replacement for component-local filter `useState`. |
| **URL State** | Frontend (Modeling) | Filter, sort, pagination, and selected-detail state stored in the URL via typed search params. One of the three layers (§2.1). |
| **View** | Frontend (Composition) | A composer under `views/` (today: `dashboard/`, `jobs/`, `artifacts/`, `apply-review/`, `runs/`, `pipelines/`, `discovery/`, `debug/`). Owns layout, URL binding, and ephemeral view-local state; consumes hooks from `contexts/operations/` and components / mutations from aggregate contexts. **Not** a bounded context. |
| **View Composition Layer** | Frontend (Architecture) | The `views/` folder; sibling of `contexts/`. Holds the view composers (Dashboard, Jobs, Artifacts, Apply Review, Runs, Pipelines, Discovery, Contacts, Debug, and others) and is the only layer permitted to import from multiple contexts in one file. |
| **Zustand** | Frontend (Library) | Lightweight client-state store. Five today: `ui-preferences`, `toasts`, `command-palette`, the resume-import wizard draft (`profile-import`), and the pipeline `stage-trigger-config`; three persist (`jh:ui-preferences`, `jh:profile-import`, `jh:stage-trigger-config`). |

---

## 14. Open Questions Resolution Summary

For convenience, here is a single-table summary of the 15 open questions
called out in the briefing (§6) with the resolution location:

| # | Question | Decision | Rationale section |
|---|---|---|---|
| 1 | TanStack Router file-based vs code-based | **File-based** (Vite plugin) | §4.3 |
| 2 | Frontend primitive boundary | **shadcn Rhea/Base** (owned Base UI + Tailwind wrappers; no direct Radix imports) | §4.7 |
| 3 | Zustand vs React context for cross-cutting client state | **Hybrid:** context for static identity providers, Zustand for everything else | §4.9 |
| 4 | Query key design: flat vs factory | **Factory pattern**, per-context | §4.1 |
| 5 | Mutation invalidation strategy | **Hybrid:** optimistic for sync mutations, SSE-driven for async (202) | §8.3 |
| 6 | Theme/density: context vs Zustand+persist | **Zustand+persist** as source of truth, context as ergonomic surface | §4.10 |
| 7 | Profile preview pattern | **Plate editor fed by `/v1/profile/preview.html` keyed on a `cacheKey` derived from the profile mutation count** | §4.4.4 |
| 8 | Resume import wizard: TanStack Form / Zustand wizard / nested route | **Nested route** for steps; **Zustand+persist** for draft state | §4.4.4 |
| 9 | SSE consumer: `setQueryData` vs `invalidateQueries` | **Hybrid:** `invalidateQueries` by default; `setQueryData` only for high-frequency `ApplyRunEventRecorded` | §7.5 |
| 10 | Tenant-scoping in query keys | **Always tenant-first** (`["tenant", tenantId, ...]`); use `LOCAL_TENANT` from `@jobctrl/domain-types` in local mode | §4.1 |
| 11 | Error handling: global vs per-query | **Three layers:** global `QueryCache.onError` → toast; per-mutation `onError`; route error boundaries | §4.11 |
| 12 | Bundle splitting | **Per-route via TanStack Router file-based** (free with the Vite plugin) | §4.3 |
| 13 | TypeScript strictness for routes | **Strict mode +** `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess` + **route-level Zod schemas** | §2.5 / §4.3 |
| 14 | Testing what: hooks vs E2E | **Both.** Hook tests with MSW + Playwright smoke for critical flows | §10.3 / §10.4 |
| 15 | Feature flags / config | **`FeatureFlagPort` exists; static no-op adapter today; no flags ship now** | §6.1 |

---

## 15. What This Doc Does Not Decide

To make the boundary with the planning team explicit, this doc does
**not** decide:

- Which change introduces TanStack Router.
- Whether the SSE endpoint and consumer ship together or separately.
- Which user-facing feature is built first.
- The precise commit messages, branch names, or PR titles.
- The CI step ordering (this doc names the steps; the plan owns the
  pipeline file).
- Visual design token values (this doc names the CSS-first `tokens.css`
  and `@theme inline` contract; design owns the exact values).

This doc *does* decide the **structural shape** the planning team
implements toward.
