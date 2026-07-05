# 5–6. State Architecture & Frontend Ports

The three state layers (server / URL / client) in detail (§5) and the hexagonal
frontend ports with local + hosted adapters (§6). Part of the
[Frontend Architecture](index.md) reference.

## 5. State Architecture (Detailed)

### 5.1 Layer Boundaries — What Goes Where

The three-layer model from §2.1 needs concrete rules. The table below
is the canonical decision matrix.

| Datum | Layer | Why |
|---|---|---|
| Jobs list filters (`stage`, `state`, `q`, `deleted`) | **URL** | Bookmarkable; survives refresh; copy-paste shareable. |
| Sort field & direction | **URL** | Same reasons. |
| Page index, page size | **URL** | Same. |
| Selected job (drawer open) | **URL** | Refresh restores the drawer. |
| Currently active route | **URL** (path) | Trivially. |
| Global text search ("Filter jobs, errors, companies...") | **URL** | Bookmarkable searches. |
| Bulk-selection set (checked job keys) | **Component** (`useState`) | Intentionally ephemeral; selecting 50 jobs and refreshing should not preserve the selection. Documented exception. |
| Theme (light/dark) | **Client** (Zustand+persist) | User preference; not URL-bound; persists across sessions. |
| Density (compact/regular/comfy) | **Client** (Zustand+persist) | Same. |
| Tenant identity | **Client** (context fed by Zustand+session in cloud) | Determined by session; not navigation-controlled. |
| Toast queue | **Client** (Zustand) | Transient, cross-cutting. |
| Profile data | **Server** (Query) | Fetched, cached, mutation-invalidated. |
| Settings / credentials | **Server** (Query) | Same. |
| Dashboard summary | **Server** (Query) | Same. |
| Jobs list response | **Server** (Query) | Same. |
| Job detail | **Server** (Query) | Same. |
| Artifacts list / detail | **Server** (Query) | Same. |
| Apply run live timeline | **Server** (Query) — appended via `setQueryData` from SSE | High-frequency; see §7.5. |
| Resume import wizard step state (uploaded file metadata, parsed draft) | **Client** (Zustand+persist) | Cross-step, refresh-safe, but not URL-bound (the URL identifies *which step*, not *the data*). |
| Form drafts (profile, settings) | **Form library state** (TanStack Form) | Owned by the form until submit; mutates the server via the mutation hook. |
| Connection status to API ("local API live"/"offline") | **Server** (Query: `useHealthQuery({ refetchInterval: ... })`) | Polling the health endpoint, not a manual `useState`. |

### 5.2 URL ↔ Query Cache Binding

Search params drive query keys. The pattern is:

```ts
// routes/jobs.tsx (loader)
loader: async ({ deps: { search }, context: { queryClient, tenantId } }) =>
  queryClient.ensureQueryData({
    queryKey: jobsKeys.list(tenantId, search),
    queryFn: () => apiClient.jobs(search),
  }),
```

The route's loader prefetches based on the typed search params. The
component reads via `useJobsListQuery(useSearch(...))`, which builds the
same query key. The cache hit rate is maximal because the URL is the
single key derivation source.

**Pagination + sort changes** mutate the URL (via `navigate({ search: { ...,
page: 2 } })`); the URL change triggers a re-render with new search
params; the new search params produce a new query key; React Query
fetches the new page (or returns it from cache if visited recently).

### 5.3 Optimistic Updates

The mutation invalidation strategy (§8.3) separates synchronous HTTP results
from *async* (202) actions. **Synchronous mutations** (delete job, restore
job, mark applied, mark skipped, retry stage with `runAfter: false`, cancel
stage, update profile, update settings, update/delete credential) take the
**optimistic update** path:

1. `onMutate`: snapshot affected query data; apply the optimistic patch.
2. `mutationFn`: call the API.
3. `onError`: roll back to the snapshot.
4. `onSettled`: invalidate the affected keys (forces a re-fetch to
   reconcile any drift with the server).

This pattern is implemented in each context's mutation hooks via the
`createOptimisticMutation` helper (`shared/lib/createOptimisticMutation.ts`),
which has 23 call sites today: 19 supply a real `onMutate` patcher +
rollback, and 4 are deliberately settle-only (`applyJob`, `dryRun`,
`cancelApply`, `importResume` — no meaningful pre-response patch, so they
invalidate on settle only). The `onMutate` patcher is a pure function; it
is unit-tested separately from the hook.

Synchronous mutations that do not patch a specific cached row still reconcile
through `onSettled` invalidation. Non-apply-only global/batch pipeline stage
starts use that path: the API returns HTTP 200 with worker action results, then
the mutation invalidates operational reads on settle.

### 5.4 Stale Time and Garbage Collection

**Defaults:**

- `staleTime: 30_000` — 30s. After 30s, a remount triggers a background
  refetch; the user sees stale data instantly while the network catches up.
- `gcTime: 5 * 60_000` — 5 min. Inactive cache entries garbage-collect
  after 5 minutes.
- `refetchOnWindowFocus: true`, `refetchOnReconnect: true`,
  `refetchOnMount: "always"` only for the dashboard query (it is the
  landing surface and freshness matters most).

These defaults are overridable per-query. The dashboard summary uses
`staleTime: 0` because it is the highest-touch surface; the artifacts
list uses `staleTime: 60_000` because it changes less.

**Realtime (§7) is the primary freshness mechanism, not polling.** The
`refetchOnWindowFocus` is a backstop for cases where the SSE connection
dropped silently.

---

## 6. Hexagonal Boundaries — Frontend Ports & Adapters

The frontend has its own hexagonal architecture. Components and feature
hooks depend only on **ports** (interfaces); concrete adapters bind to the
ports in `shared/providers/`. This makes feature code testable without
hitting the network and gives a clear seam for cloud evolution.

### 6.1 Port Inventory

| Port | Purpose | Local-mode adapter | Hosted-mode adapter (named, not built) |
|---|---|---|---|
| `ApiClientPort` | HTTP requests against `apps/api` | `FetchApiClientAdapter` (wraps `@jobhunter/api-client`) | Same adapter; baseUrl from env, JWT auth header injected by `AuthInterceptor` |
| `EventStreamPort` | Subscribe to a stream of `DomainEvent`s | `SseEventStreamAdapter` (`new EventSource(...)`) | `WebSocketEventStreamAdapter` (if SSE proves limiting at scale) or same SSE adapter behind CDN with edge buffering |
| `StoragePort` | Persist client preferences and wizard drafts | `LocalStorageAdapter` (browser `localStorage`) | `IndexedDbAdapter` (when client-side cache exceeds 5 MB) |
| `SessionPort` | Resolve `TenantId` and `UserId` for the current request | `LocalSessionAdapter` (returns `LOCAL_TENANT` + a stub user) | `JwtSessionAdapter` (Auth0 / Cognito; reads JWT, exposes `useSession()`) |
| `ClipboardPort` | Copy CLI commands to clipboard | `NavigatorClipboardAdapter` (`navigator.clipboard.writeText`) | Same adapter |
| `OpenInOsPort` | Open an artifact in the OS default app (local-only feature) | `OpenArtifactAdapter` (POSTs to `/v1/artifacts/:id/open`) | **Disabled** in hosted mode — port returns `Unsupported`; the UI surfaces a "download" affordance instead. (Cloud users get presigned S3 URLs.) |
| `TelemetryPort` | Emit frontend telemetry (errors, route timings, mutation latencies) | `ConsoleTelemetryAdapter` (no-op + dev-tools logs) | `OpenTelemetryWebAdapter` → OTLP collector → backend tracing pipeline |
| `FeatureFlagPort` | Read feature-gate values | `StaticFeatureFlagAdapter` (always returns the default; the seam exists, no flags ship today) | Backend-served via `apiClient.featureFlags()`; cached in Query |

> Resolves §6 question 15: the `FeatureFlagPort` seam exists today as a
> static no-op adapter; no feature flags are introduced now. When the
> first flag becomes useful, swap the local adapter for the
> backend-served adapter without touching feature code.

### 6.2 Port Wiring

Ports are bound at the application root via dependency-injection through
React context:

```ts
// shared/providers/ports.tsx
const PortsContext = createContext<{
  api: ApiClientPort;
  eventStream: EventStreamPort;
  storage: StoragePort;
  session: SessionPort;
  clipboard: ClipboardPort;
  openInOs: OpenInOsPort;
  telemetry: TelemetryPort;
  featureFlags: FeatureFlagPort;
} | null>(null);

export function PortsProvider({ children, ports }: ...) { /* ... */ }
export function usePorts(): Ports { /* throws if missing */ }
```

Concrete adapters are constructed in `main.tsx`:

```ts
const api = new FetchApiClientAdapter(import.meta.env.VITE_JOBHUNTER_API_BASE_URL);
const eventStream = new SseEventStreamAdapter(api);
const storage = new LocalStorageAdapter("jh:");
const session = new LocalSessionAdapter();
// ...
```

In tests, `PortsProvider` accepts mocks. Components depend on the port
*interfaces*, not concrete classes.

### 6.3 `ApiClientPort` Detail

```ts
export interface ApiClientPort {
  jobs(query?: Partial<JobListQuery>): Promise<PaginatedResponse<JobSummary>>;
  job(jobKey: string): Promise<JobDetail>;
  // ... one method per api-client method (~90 today)
}
```

`ApiClientPort` has grown to roughly ninety methods spanning the full API
surface: read (`dashboardSummary`, `jobs`/`job`, `artifacts`/`artifact`,
`activity`, `workflowRuns`/`workflowRun`, `applyReviewQueue`,
`applicationOutcomes`, `health`), job lifecycle (delete/hide/restore/
permanent-delete + bulk), discovery-source administration, scoring
(`correctScore`, `rescoreJob`, `retailorJob`, …), materials + resume-review
drafts + resume templates, apply (`applyJob`, `cancelJobAction`,
`markApplied`/`markSkipped`), pipeline (`runPipelineStages`, `retryStage`,
`runJobStage`), and workflow-run control (`cancelWorkflowRun`) — the last
group landed with the Temporal work (P5). Sync URL helpers
(`artifactPreviewPdfUrl`, `profilePreviewHtmlUrl`, …) return strings, not
promises. LLM spend/budget is not a dedicated method; it rides on
`health()` (`ApiHealthResponse.llmSpend`). Methods take `jobKey: string`,
not a branded `JobId` (see R13).

The `FetchApiClientAdapter` delegates to the existing `JobHunterApiClient`
from `@jobhunter/api-client`. The reason we still have a port wrapping it:

1. **Test seam.** Without a port, every test that needs to fake the API
   has to install MSW handlers (slower, more setup). With a port, tests
   pass a mock adapter to `<PortsProvider />`. MSW remains the integration-
   test default; the port enables faster unit tests.
2. **Hosted-mode auth interceptor.** When auth ships, the adapter wraps
   the underlying client with a request interceptor that adds
   `Authorization: Bearer <jwt>`. Without the port, every component that
   calls `apiClient.x()` would need to know about the interceptor.
3. **Tenant prefix.** The hosted adapter can inject `X-Tenant-Id` header
   (or assert that the JWT's tenant claim matches the request) without
   feature code being aware.

### 6.4 `EventStreamPort` Detail

```ts
type EventStreamStatus = "connecting" | "open" | "closed";

export interface DomainEventEnvelope {
  eventType: string;
  tenantId: TenantId;
  payload: unknown;
}
export interface EventStreamSubscription {
  on(handler: (event: DomainEventEnvelope) => void): () => void;
  readonly status: EventStreamStatus;
  onStatusChange(callback: (status: EventStreamStatus) => void): () => void;
  close(): void;
}
export interface EventStreamPort {
  subscribe(opts: { tenantId: TenantId }): EventStreamSubscription;
  readonly status: EventStreamStatus;
}
```

The `SseEventStreamAdapter` (`shared/adapters/local/`) opens an
`EventSource` against `GET /v1/events/stream`. It dispatches each parsed
`DomainEventEnvelope` to all subscribed handlers and exposes connection
status, which `<ConnectionStatusPill>` (in `shared/layout/`, rendered in
the Topbar) renders as a "live"/"reconnecting" indicator.

The hosted-mode `WebSocketEventStreamAdapter` (if the SSE adapter proves
limiting under cross-region or CDN-buffered conditions, see fitness
function §9.4) preserves the same interface; only the transport changes.

### 6.5 `contexts/operations/types.ts` — Frontend ACL

The frontend has an Anti-Corruption Layer too: `contexts/operations/types.ts`
re-exports the projection and API response types and adds frontend-only
refinements (e.g., narrower string-union types over `state` / `stage`
derived from `STAGES` / `STAGE_STATE_KINDS`). The projection shapes are
canonically defined in `@jobhunter/domain-types` (`operations/`) and
re-exported through `@jobhunter/contracts`; the ACL is the intended single
import surface for feature code, though `@jobhunter/contracts` is still
imported directly in places today.

Why an ACL (this thin):

- **Single point of compile-time impact** when a backend projection
  shape changes — the ACL re-export site is the first error; we update
  the frontend only at that boundary.
- **Frontend-only refinements** (string narrowing for exhaustive
  `switch`, branded date types, etc.) are introduced once.
- **Future deviation from contract types** (e.g., a frontend-derived
  computed field) has a natural home.

This is an extremely thin ACL — it is mostly re-exports today. It exists
because the alternative ("just import from `@jobhunter/contracts` directly")
makes a future tightening of types or addition of frontend computed shape
into a sprawling refactor.

### 6.6 No Direct DOM Access from Feature Code

A pattern visible in the current `App.tsx`:

```ts
window.dispatchEvent(new CustomEvent("jobhunter:set-jobs-filter", { detail: target }));
```

This is the canonical anti-pattern the target eliminates. Cross-component
coordination goes through:

- **The URL** (`navigate({ to: "/jobs", search: { state: "failed" } })`) for
  filters, sort, drawers — anything that should be shareable / reflectable.
- **Zustand stores** for ephemeral cross-cutting state (toasts).
- **The query cache and its invalidations** for data dependencies.
- **Ports** for browser APIs (clipboard, notifications, OS-open).

The only `window` access in feature code is via a port (e.g.,
`ports.clipboard.write(text)`).

### 6.7 Driving Ports (Use Cases) — Implicit

The backend names "driving ports" as use cases (`ScoreJobUseCase`). The
frontend's equivalent is **the hooks**: `useApplyJobMutation`,
`useDeleteJobMutation`, etc. They are the application's *driving* surface
because they are what the user (through clicks) drives. We do not
formalize a `UseCase` interface for them — the React conventions
(hook + mutation function) are the de facto driving-port representation.

---
