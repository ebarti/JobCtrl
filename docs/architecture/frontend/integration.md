# 8–9. Cross-Context Integration & Evolution Paths

Cross-context coordination rules incl. the §8.2 mutation-invalidation matrix,
plus the named-but-not-built cloud-mode adapters (§9). Part of the
[Frontend Architecture](index.md) reference.

## 8. Cross-Context Integration

### 8.1 What "Integration" Means in the Frontend

The backend's bounded contexts integrate via domain events on a
synchronous in-process bus (`docs/ddd-target.md` §6). The frontend's
contexts integrate via:

1. **Shared query keys** — a mutation in `apply/` invalidates a key
   *defined in* `jobs/` because both contexts reference the same registry
   (§4.1).
2. **The SSE event stream + invalidation router** — server-side state
   change in any context fans out invalidations across every affected
   frontend context (§7.4).
3. **Composition in views** — the jobs detail drawer composes components
   from `scoring/`, `materials/`, `apply/`, `pipeline/`. Composition is
   the only place contexts "see" each other directly; even there, they
   see only each other's *components*, never each other's hooks or stores.

### 8.2 Mutation → Invalidation Map

For *synchronous* mutations (return value is the final state):

| Mutation | Invalidates |
|---|---|
| `useDeleteJobMutation({ jobId })` | `jobsKeys.lists(tenantId)`, `jobsKeys.detail(tenantId, jobId)`, `dashboardKeys.summary(tenantId)` |
| `useDeleteJobsBulkMutation(filterOrIds)` | `jobsKeys.lists(tenantId)`, `dashboardKeys.summary(tenantId)` (then optimistically removes from current page) |
| `useRestoreJobMutation({ jobId })` | Same pair, opposite direction |
| `useHideJobsBulkMutation` / `useUnhideJobsBulkMutation` | `jobsKeys.lists(tenantId)`, `dashboardKeys.summary(tenantId)` (optimistic list-page patch) |
| `usePermanentlyDeleteJobsBulkMutation` | `jobsKeys.lists(tenantId)`, `jobsKeys.details(tenantId)`, `dashboardKeys.summary(tenantId)` |
| `useCorrectScoreMutation({ jobId, correctedScore, reason })` | `jobsKeys.detail(tenantId, jobId)`, `jobsKeys.lists(tenantId)`, `dashboardKeys.summary(tenantId)` |
| `useUpdateProfileMutation(body)` | `profileKeys.profile(tenantId)`, `jobsKeys.lists(tenantId)` (scoring depends on profile, but server-side scoring is async — see below), `dashboardKeys.summary(tenantId)` |
| `useUpdateSettingsMutation(body)` | `profileKeys.settings(tenantId)` |
| `useUpdateCredentialMutation(body)` | `profileKeys.credentials(tenantId)` |
| `useDeleteCredentialMutation(key)` | `profileKeys.credentials(tenantId)` |
| `useRetryStageMutation({ jobId, stage, runAfter: false })` | `jobsKeys.detail(tenantId, jobId)`, `jobsKeys.lists(tenantId)` (because `currentStage`/`currentState` change) |
| `useCancelStageMutation({ jobId, stage })` | Same |
| `useMarkAppliedMutation({ jobId })` | `jobsKeys.detail(tenantId, jobId)`, `jobsKeys.lists(tenantId)`, `dashboardKeys.summary(tenantId)` |
| `useMarkSkippedMutation({ jobId })` | Same |
| `useRunPipelineStagesMutation({ stages })` without `apply` | `jobsKeys.lists(tenantId)`, `dashboardKeys.summary(tenantId)`, `workflowRunsKeys.lists(tenantId)`, `applyRunsKeys.lists(tenantId)` on settle after the HTTP 200 worker action results return |

For *async* (202) mutation responses (the queued work's final state arrives
via SSE):

| Mutation | Immediate invalidation | Eventual invalidation (via SSE) |
|---|---|---|
| `useGenerateMaterialsMutation({ jobId })` | `jobsKeys.detail(tenantId, jobId)` (to show "queued" state) | `ResumeApproved` → invalidate same + `artifactsKeys.lists`; `MaterialsExhausted` → same |
| `useApplyJobMutation({ jobId })` | `jobsKeys.detail(tenantId, jobId)`, `applyRunsKeys.list(tenantId)` (to show new run as "starting") | `ApplyRunStarted` → optimistic cache patch with worker info; `ApplicationSubmitted`/`ApplicationFailed` → invalidate `jobsKeys.detail`, `dashboardKeys.summary` |
| `useDryRunApplyMutation({ jobId })` | Same | Same |
| `useRetryStageMutation({ jobId, stage, runAfter: true })` | `jobsKeys.detail(tenantId, jobId)` | Same as the async equivalent |
| `useRescoreCurrentPolicyMutation` / `useRescoreJobMutation` | `jobsKeys.lists`, `dashboardKeys.summary`, `workflowRunsKeys.lists` (queued) | `JobScored` / `ScoreRescoreRequested` → invalidate `jobsKeys` + `dashboardKeys` |
| `useRetailorCurrentPolicyMutation` / `useRetailorJobMutation` | `jobsKeys.lists`, `workflowRunsKeys.lists` (queued) | `TailorRetailorRequested`, then `ResumeApproved` / `PdfRendered` → invalidate `jobsKeys` + `artifactsKeys` |
| `useCancelWorkflowRunMutation({ runId })` | `workflowRunsKeys.detail(tenantId, runId)`, `workflowRunsKeys.lists(tenantId)` | `WorkflowCanceled` / `WorkflowTerminated` → invalidate `workflowRunsKeys` + `jobsKeys` + `dashboardKeys` |
| `useRunPipelineStagesMutation({ stages })` when `apply` queues | `jobsKeys.lists(tenantId)`, `dashboardKeys.summary(tenantId)`, `workflowRunsKeys.lists(tenantId)`, `applyRunsKeys.lists(tenantId)` on settle after the 202 response | Apply events fan out through the invalidation router; preceding non-apply stage results were already returned synchronously |

### 8.3 The Hybrid Strategy (resolves §6 question 5)

**Decision:** Hybrid by mutation type:

- **Sync mutations:** optimistic updates where applicable (§5.3) +
  `invalidateQueries` on settle. The user sees instant feedback; the cache
  reconciles to the server response. Global/batch pipeline stage starts
  without `apply` are in this bucket: the API returns HTTP 200 with worker
  action results, and the mutation uses normal settled invalidation.
- **Async mutations (202 Accepted):** *no* eager invalidation of "the
  result." A small immediate invalidation of "the request queued" view
  (so the user sees "queued" state). The real result arrives via the SSE
  invalidation router. Global/batch pipeline requests enter this bucket only
  when the `apply` dispatch actually queues; earlier non-apply stages in the
  same request have already completed synchronously.
- **Default mutation options** do *not* invalidate broadly. Each mutation
  declares its invalidation set. The reasons:
  - "Invalidate everything" thrashes the network.
  - "Per-mutation" makes the data dependency explicit at each site.
  - "SSE-driven only" loses optimistic feedback.

### 8.4 Event → Invalidation Map (Full)

| Event | Contexts whose queries invalidate |
|---|---|
| `JobDiscovered` | jobs (lists), dashboard (summary) |
| `JobUpdated` | jobs (lists, detail) |
| `JobDeleted` | jobs (lists, detail), dashboard |
| `JobRestored` | jobs (lists, detail), dashboard |
| `JobEnriched` | jobs (lists, detail), dashboard |
| `EnrichmentFailed` | jobs (lists, detail), dashboard |
| `JobScored` | jobs (lists, detail), dashboard |
| `ScoreCorrected` | jobs (lists, detail), dashboard |
| `ResumeApproved` | jobs (lists, detail), artifacts (lists), dashboard |
| `ResumeFailed` | jobs (lists, detail), dashboard |
| `CoverLetterGenerated` | jobs (lists, detail), artifacts (lists), dashboard |
| `PdfRendered` | jobs (lists, detail), artifacts (lists), dashboard |
| `MaterialsExhausted` | jobs (lists, detail), dashboard |
| `ResumeTemplateVersionSaved` | profile (resume templates), jobs (lists), artifacts (lists) |
| `ResumeTemplateDefaultChanged` | profile (resume templates), jobs (lists), artifacts (lists), apply review |
| `JobResumeTemplateAssigned` | jobs (lists, detail), artifacts (lists), apply review |
| `ResumeTemplateRefreshCompleted` | jobs (lists, detail), artifacts (lists), apply review, dashboard |
| `ResumeTemplateRefreshFailed` | jobs (lists, detail), apply review |
| `ApplyRunStarted` | apply-runs (lists), jobs (lists, detail), dashboard |
| `ApplyRunEventRecorded` | apply-runs (detail) — patched via `setQueryData`, not invalidated |
| `ApplicationSubmitted` | jobs (lists, detail), apply-runs (lists, detail), dashboard |
| `ApplicationFailed` | jobs (lists, detail), apply-runs (lists, detail), dashboard |
| `StageStarted` | jobs (lists, detail) |
| `StageCompleted` | jobs (lists, detail), dashboard |
| `StageFailed` | jobs (lists, detail), dashboard |
| `StageBlocked` | jobs (lists, detail), dashboard |
| `StageSkipped` | jobs (lists, detail), dashboard |
| `StageReset` | jobs (lists, detail) |
| `StageCanceled` | jobs (lists, detail) |
| `StageExhausted` | jobs (lists, detail), dashboard |
| `ProfileUpdated` | profile (profile) |
| `ProfileImported` | profile (profile) |
| `TailoringPolicyUpdated` | profile (profile), jobs (lists) |
| `ScoreRescoreRequested` | jobs (lists, detail), dashboard |
| `JobSourceObserved`, `CanonicalJobIdentityResolved`, `DuplicateJobLinked`, `DuplicateJobLinkRejected` | jobs (lists, detail) |
| `DiscoveryRunStarted` / `Completed` / `Failed`, `DiscoveryFeedbackRecorded` | dashboard, discovery reads |
| `SourceLocationCandidateDiscovered` / `Promoted`, `SourceRegistryEntryCreated` / `Updated`, `SourceStateChanged` | discovery reads (source registry / locator) |
| `PostingContentSnapshotCaptured` / `Failed`, `JobActiveStateChanged`, `ContentDuplicateCandidateDetected` | jobs (lists, detail) |
| `CompensationFactsUpdated` | jobs (lists, detail), compensation reads |
| `EmployerAnalyzed`, `BulletProvenanceRecorded`, `TailorRetailorRequested`, `TailoredArtifactsSuppressed` | jobs (lists, detail), artifacts (lists) |
| `PreparationWorkItemQueued` / `Started` / `Completed` / `Failed` | jobs (lists, detail), dashboard |
| `ApplySubmitIntended`, `ApplicationEmailFeedbackIngested` | apply-runs, jobs (detail), apply review |
| `WorkflowStarted` / `Completed` / `Failed` / `Canceled` / `TimedOut` / `Terminated` | workflow-runs (lists, detail), jobs (lists, detail), dashboard |

The `DomainEventUnion` has **68** arms today (grouped above where several
share an invalidation target). This table is representative; the
authoritative registry is the set of per-context `handlers.ts` files wired
through `contexts/operations/invalidation-router.ts`, and the
`every-event-has-handler.test.ts` parity test (§10.2) guarantees every one
of the 68 has a handler. A new backend event means a handler in the owning
context and a matching row (or grouped entry) here.

Beyond the per-event targets above, the router appends
`activityKeys.lists(tenantId)` (the Debug activity feed) to **every**
event's invalidation set — except `ApplyRunEventRecorded`, which returns
early to patch `applyRunsKeys.detail` via `setQueryData` (§7.5) and so does
not invalidate the activity list.

### 8.5 Composition Patterns

The cross-context UI surfaces (jobs drawer, dashboard activity feed,
artifacts grouped by job) follow the same rule: **the composer owns
layout; each context owns its slice**. Concretely:

```tsx
// views/jobs/JobDetailDrawer.tsx — view composer; not a bounded context
export function JobDetailDrawer({ jobId }: { jobId: JobId }) {
  const { data: job, isLoading } = useJobDetailQuery(jobId);   // operations
  if (isLoading || !job) return <DrawerSkeleton />;

  return (
    <Sheet open onOpenChange={(open) => !open && navigate({ to: "/jobs" })}>
      <SheetContent side="right">
        <JobOverview job={job} />                {/* views/jobs (this view) */}
        <JobActions jobId={jobId}/>              {/* contexts/pipeline composer */}
        <CompensationAuditSection job={job}/>    {/* contexts/enrichment */}
        <StageTimeline stages={job.stages}/>     {/* contexts/pipeline */}
        <EmployerAnalysisPanel analysis={...}/>  {/* contexts/materials */}
        <ApplyHistory jobId={jobId}/>            {/* contexts/apply */}
        <JobOutcomePanel jobId={jobId}/>         {/* contexts/apply */}
        <JobAuditHistory jobId={jobId}/>         {/* contexts/operations */}
      </SheetContent>
    </Sheet>
  );
}
```

**Constraint:** the drawer file (a view composer) imports *components* from
contexts. It does not import their hooks, query keys, or stores. The
components encapsulate their own data dependencies. The drawer's only
direct hook call is `useJobDetailQuery` from Operations — the view's read
side.

---

## 9. Evolution Paths (Cloud-Mode Adapters Named, Not Built)

Each evolution below has a **fitness function** — a concrete, testable
trigger that initiates the swap. We do not build the cloud variant
until its trigger fires; we do not make decisions today on calendar
dates ("Q4 2026"); we make them on observable conditions.

### 9.1 SSR / TanStack Start

**Local-mode:** Vite SPA. Static `index.html` + JS chunks.

**Hosted-mode named adapter:** **TanStack Start** (the SSR framework
built on the same router/query primitives).

**Why named-not-built:**
- Single-user app with cold-start once-per-day usage. SSR pays for itself
  when many cold loads compete for fast first paint or shareable links
  that need crawler indexing.
- TanStack Start keeps the same Router and Query primitives when SSR or RSC
  becomes valuable. The upgrade cost stays low because the architecture is
  shaped around those primitives.

**Fitness function:** **Trigger when**
- p50 cold-load Time-to-Interactive on the dashboard exceeds 1s on a
  representative network profile (Fast 3G), measured against a hosted
  deployment, **OR**
- a feature requires shareable public URLs (e.g., "share this jobs
  filter view with a recruiter coach"), **OR**
- SEO becomes a goal (currently no goal).

**Bootstrap rule:** when this fires, the SPA bootstrap switches to the Start
bootstrap in one change. There is no "render both server-side and client-side
during transition" period.

### 9.2 React Server Components (RSC)

**Local-mode:** Client components only.

**Hosted-mode named adapter:** RSC under TanStack Start (when Start
ships RSC support; today it's experimental). The candidate components
are `ScoreBreakdown`, `StageTimeline`, the activity feed — render-only,
no interactivity.

**Why named-not-built:**
- RSC reduces client bundle and removes round-trip latency for static
  panels. JobHunter's panels are not yet large enough to warrant the
  added build complexity.
- The architecture (clean separation of read-only renderers from
  interactive controls) is RSC-shaped already; we will not need to
  refactor when it lands.

**Fitness function:** **Trigger when** the JS bundle gzipped exceeds
500 KB on the largest route, AND TanStack Start RSC is stable.

### 9.3 AuthProvider for Hosted Auth

**Local-mode:** `LocalSessionAdapter` returns `LOCAL_TENANT`. No
`<SessionProvider />` is mounted.

**Hosted-mode named adapter:** `JwtSessionAdapter` (Auth0 / AWS Cognito —
matches the backend's `docs/ddd-target.md` §9 choice). Surfaces:
`<SessionProvider />`, `<RequireAuth />` route guard,
`useSession()` hook returning `{ tenantId, userId, roles, expiresAt }`.

**Why named-not-built:**
- Local app needs no auth.
- The seam — `SessionPort` (§6) — already has the right shape. Wiring
  in JWT-derived values is the implementation.

**Fitness function:** **Trigger when** the API is exposed beyond
`127.0.0.1`. (This is also the trigger for the backend Identity & Access
context per `docs/ddd-target.md` §9.4.)

### 9.4 Tenant-Scoped Routing (Multi-Tenant Switcher)

**Local-mode:** `useTenantId()` returns `LOCAL_TENANT`. URL has no
tenant segment.

**Hosted-mode named adapter:** A `/t/$tenantId/*` route prefix
(via TanStack Router's layout routes). `<TenantProvider />` reads from
the path segment first, JWT default tenant second. A tenant-switcher in
the AppShell calls `navigate({ to: "/t/$tenantId/...", params: { tenantId: "..." } })`.

**Why named-not-built:**
- Today only one tenant exists.
- Query keys already start with tenant (§4.1), so cache isolation is
  free. The hosted route layout adds the URL prefix; everything
  downstream already accepts `tenantId` as input.

**Fitness function:** **Trigger when** a single user belongs to more than
one tenant.

### 9.5 Audit-Log Streaming

**Local-mode:** No audit; the `TelemetryPort` no-ops.

**Hosted-mode named adapter:** `OpenTelemetryWebAdapter` — emits OTLP
spans for route navigations, mutation calls, error boundaries; sent to
the backend's audit pipeline (`docs/ddd-target.md` §9 Audit Log context).

**Fitness function:** **Trigger when** SOC2 / GDPR access-log
requirements arise. The port exists; the adapter swap is ~50 LOC.

### 9.6 CDN-Cached Projection Reads

**Local-mode:** All `apiClient.*` calls hit `127.0.0.1`; cache control
is irrelevant.

**Hosted-mode named adapter:** `apps/api` sets `Cache-Control: private,
max-age=10, stale-while-revalidate=60` on projection endpoints.
CloudFront or Cloudflare caches per-tenant per-query. The frontend's
TanStack Query layer remains the same; the *adapter* (the API itself)
benefits from edge caching.

**Why this is in the frontend doc:** because the frontend's `staleTime`
defaults (§5.4) interact with the server's cache headers. We document
the contract here so API and frontend QA gates can verify both ends.

**Fitness function:** **Trigger when** dashboard or jobs-list median
latency exceeds 200 ms p50 from the client.

### 9.7 IndexedDB Persistence for the Query Cache

**Local-mode:** Query cache lives in memory; refresh re-fetches.

**Hosted-mode named adapter:** `@tanstack/query-sync-storage-persister`
backed by IndexedDB (via the `StoragePort`'s IDB binding) for instant
warm starts.

**Fitness function:** **Trigger when** average session duration >5 min
*and* p95 cold-load TTI exceeds 800 ms. Both must hold; persistence has
a cost (cache validity bugs become harder to reason about).

### 9.8 WebSocket EventStreamPort

**Local-mode:** `SseEventStreamAdapter`.

**Hosted-mode named adapter:** `WebSocketEventStreamAdapter` (same port
interface; different transport).

**Fitness function:** **Trigger when** SSE proves to drop connections
behind common reverse proxies (CDN observation), **OR** the frontend
needs to send messages over the same channel (interactive worker control).

### 9.9 Summary Table

| Concern | Local-mode | Hosted-mode named adapter | Fitness function |
|---|---|---|---|
| App shell | Vite SPA | TanStack Start (SSR) | p50 cold TTI > 1s on Fast 3G OR shareable URLs needed OR SEO |
| Server components | All client | RSC under TanStack Start | bundle gzipped > 500 KB AND RSC stable |
| Auth | `LocalSessionAdapter` (LOCAL_TENANT) | `JwtSessionAdapter` (Auth0/Cognito) | API exposed beyond `127.0.0.1` |
| Tenant routing | implicit | `/t/$tenantId/*` prefix + switcher | user belongs to > 1 tenant |
| Telemetry / audit | console | OpenTelemetry-Web → OTLP | SOC2/GDPR requirement |
| Edge caching | n/a | server-side cache headers + CDN | dashboard p50 latency > 200 ms |
| Cache persistence | in-memory | IndexedDB-persisted Query | session > 5 min AND cold TTI > 800 ms p95 |
| EventStream | SSE | WebSocket | SSE proxy drops, OR duplex needed |

---
