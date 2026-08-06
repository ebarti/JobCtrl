# Local TypeScript API

The local Fastify API is the browser-facing boundary for JobCtrl. It serves
projection-backed reads, accepts explicit commands, starts Temporal workflows,
and streams domain-event invalidations to the web app.

**Read this first** for the shape of the API. Follow a route-family link for the
common contracts, or open the [complete field-level contract](api/complete-contract.md)
when implementing or debugging a specific endpoint.

## In 30 Seconds

- Reads come from SQLite-backed projections; clients do not reconstruct domain
  state from raw events.
- Workflow-starting commands normally return `202 Accepted`. That means queued,
  not completed.
- Synchronous reads and commands return `200 OK`; invalid input, unavailable
  workers, and start failures return an error instead of a misleading `202`.
- Browser updates arrive through `GET /v1/events/stream`; TanStack Query exact-
  patches truthful detail payloads and boundedly refetches affected projections
  when membership, aggregation, or missing event data requires reconciliation.
- Credentials are handled through the local credential boundary, never through
  ordinary settings payloads.

## Choose A Route Family

| You need to… | Start here |
| --- | --- |
| Read or update the candidate profile, preferences, discovery settings, or credentials | [Profile & Settings](api/profile-and-settings.md) |
| List jobs, inspect score/material evidence, review applications, or work with contacts | [Jobs & Materials](api/jobs-and-materials.md) |
| Start/cancel workflows, inspect current pipeline operations, inspect health, or consume realtime events | [Operations & Events](api/operations-and-events.md) |
| Check every field, status code, precedence rule, and cadence | [Complete Contract](api/complete-contract.md) |

## API At A Glance

| Boundary | Representative routes | Response model |
| --- | --- | --- |
| Profile and configuration | `/v1/profile`, `/v1/settings`, `/v1/credentials`, `/v1/providers/models`, `/v1/discovery/settings`, `/v1/browser-capabilities`, `/v1/extension/pairing-token` | Synchronous reads and validated patches |
| Jobs and evidence | `/v1/jobs`, `/v1/jobs/:jobKey`, `/v1/evidence-map`, `/v1/artifacts` | Projection-backed reads |
| Scoring keywords and feedback learning | `/v1/scoring/keywords`, `/v1/learning/recommendations`, `/v1/learning/policies/materials` | Current score-version aggregation plus explicit review and versioned policy history |
| Review and outcomes | `/v1/apply/review-queue`, `/v1/jobs/:jobKey/apply-review/decision`, `/v1/jobs/:jobKey/repeat-application/override`, `/v1/outcomes` | Explicit review commands plus read models |
| Workflow operations | `/v1/pipeline/actions/run-stage`, `/v1/pipeline/operations`, `/v1/workflow-runs`, `/v1/health` | `202` for accepted asynchronous work; `200` for projection-backed and runtime-backed reads/sync commands |
| Realtime | `/v1/events/stream` | Server-Sent Events with replay and reconnect support |

## Profile And Preferences

Profile data, preferences, discovery controls, settings, and credentials have
different owners even though the UI presents them together. See
[Profile & Settings](api/profile-and-settings.md) for that ownership map and the
routes used by autosave, resume preview, source administration, and Keychain-backed
credentials.

## Artifacts And Tailoring Audit

Artifact list/detail/preview routes and canonical tailoring evidence are grouped
with job reads in [Jobs & Materials](api/jobs-and-materials.md). The complete
contract documents every generation, template, provenance, layout, and audit
field.

## Jobs Read Model And Lifecycle

The jobs list and detail routes read stable projections. Lifecycle changes—hide,
restore, delete, score correction, stage retry, and per-job actions—are explicit
commands. See [Jobs & Materials](api/jobs-and-materials.md).

On job detail, Enrich stage summaries can carry a separate, allow-listed
`applyUrlOutcome` (`code`, `message`, `retryable`, and `method`). It reports
application-target readiness without changing posting-content trust or stage
success; raw browser/resolver errors are not exposed.

Internal list/detail identity is the tenant-scoped stable `JobId`; posting URLs
are locators resolved only at explicit import or API boundaries. Employer and
Source remain independent facts. `GET /v1/scoring/keywords` aggregates indexed,
normalized keywords from the current score version, and `GET /v1/jobs` accepts
an exact `normalizedScoreKeyword` filter using those returned keys.

## Feedback Learning And Policy History

`GET /v1/learning/recommendations` and its evidence route expose only bounded,
privacy-safe derived evidence. The review route requires an explicit accepted
or rejected decision. Acceptance creates a versioned Materials policy revision;
rejection changes no policy. `GET /v1/learning/policies/materials` exposes the
allowlisted current/superseded history, while the rollback route appends a new
user-requested revision that restores an earlier version. These routes never
start scoring, tailoring, Apply, or artifact work. See
[Jobs & Materials](api/jobs-and-materials.md#feedback-learning-and-materials-policy).

## Dashboard, Analytics, And Operational Metrics

`GET /v1/dashboard/summary`, `GET /v1/analytics/outcomes`, `GET /v1/digest`, and
`GET /v1/debug/activity` expose read-side summaries. Their exact filters and
shapes live in the [complete contract](api/complete-contract.md#dashboard-analytics-and-operational-metrics).

`GET /v1/pipeline/operations` is the dedicated current-operations read model.
It selects the active or draining Discover execution, falling back to the
latest terminal execution, and combines immutable execution membership,
pipeline-step and per-job stage projections, fresh worker capacity, approximate
Temporal task-queue statistics, bounded active-work detail, and a conservative
typed ETA. It is a current snapshot, not a historical reconstruction endpoint.
See [Operations & Events](api/operations-and-events.md#pipeline-operations-snapshot).

## Discovery Controls

Source registry, quarantine, locator candidates, manual capture, schedules, and
role-match feedback are covered in
[Profile & Settings](api/profile-and-settings.md#discovery-controls).

## Compensation

Posted compensation, market estimates, source controls, and refresh actions are
job evidence. Start with [Jobs & Materials](api/jobs-and-materials.md#compensation).

## Workflow Runs

List, detail, cancel, and workflow-start semantics are in
[Operations & Events](api/operations-and-events.md#workflow-runs).

`GET /v1/workflow-runs` accepts the normal pagination and sort parameters plus
an exact `workflowType` match, inclusive `startedSince`, and exclusive
`startedBefore`. Timestamp bounds must be UTC ISO-8601 timestamps; malformed
optional filter values are ignored. The list response echoes the effective
filters in its `filter` object (`null` when an optional filter is inactive).

Discover, job preparation, and Apply share the same statuses, lifecycle
timeline, terminal-state rules, and cancellation command. Cancellation is
cooperative and idempotent: repeated requests do not replace terminal results
or emit duplicate cancellation transitions.

## Profile Resume Preview

`GET /v1/profile/preview.html` and `GET /v1/profile/preview.pdf` render the
baseline profile resume. Per-job generated artifacts use the artifact preview
routes described in [Jobs & Materials](api/jobs-and-materials.md#artifacts-and-resume-templates).

## Apply Review And Outcomes

Apply review is a user decision boundary, not a background side effect. The
review queue, editable resume-review drafts, approval decisions, outcomes, and
bounded Gmail suggestion flow are summarized in
[Jobs & Materials](api/jobs-and-materials.md#apply-review-and-outcomes).

The queue and job-detail read models include `repeatApplication`: its current
status, summary, evaluation time, evidence fingerprint, related confirmed prior
applications, matching reason and identity evidence, matching one-attempt
override, and bounded audit trail. `POST
/v1/jobs/:jobKey/repeat-application/override` accepts
`evidenceFingerprint`, `priorJobKey`, a 10–400 character `reason`, and
`confirmedBy`; it records intent but does not dispatch Apply. Stale evidence,
prior mismatch, already-consumed confirmation, and live apply without required
confirmation return `409` with stable repeat-application error codes. Dry-run
dispatch does not require this confirmation because it cannot submit.

## Contacts

Contact facts, supervised research, candidate confirmation, outreach drafts,
send logs, and follow-ups share one route family. See
[Jobs & Materials](api/jobs-and-materials.md#contacts-and-outreach).

<a id="contact-research"></a>
<a id="outreach-drafts"></a>

## Pipeline And Preparation Actions

Global and per-job stage runs, rescore/re-tailor, retry, mark-applied, and
mark-skipped commands are summarized in
[Operations & Events](api/operations-and-events.md#starting-work).

## Discovery Target Search

Discovery reads the saved profile target, location, and work-model preferences.
The precedence and filter details remain in the
[complete contract](api/complete-contract.md#discovery-target-search).

## Worker Runtime And Health

Use `GET /v1/health` before starting work that needs Temporal and the Python
worker. See [Operations & Events](api/operations-and-events.md#health-and-json-rpc)
for the readiness boundary.

## Settings And Credentials

Ordinary settings and secrets deliberately use separate routes and storage.
See [Profile & Settings](api/profile-and-settings.md#settings-and-credentials).
`GET /v1/providers/models` returns sanitized ready-provider catalogs through
the Python JSON-RPC boundary. `PATCH /v1/settings` accepts `preferredModels`,
validates every non-null choice against that current catalog, and persists only
the canonical `preferred_models` provider/model mapping; `null` clears one
provider without requiring it to be ready.

`GET/PATCH /v1/settings` also carries effective-source and activation metadata
for launch controls. Environment-owned fields are read-only. Discovery runtime
and schedule controls use `GET/PATCH /v1/discovery/settings`; browser adoption
uses `GET /v1/browser-capabilities` plus capability-specific `POST` enable,
disable, and profile-copy routes. Standard default profiles can be selected by
opaque detected-browser ID; write-only filesystem paths are an advanced
fallback. Extension pairing uses
`GET /v1/extension/pairing-token` and `POST /v1/extension/pairing-token/rotate`.

## Related Packages

The contracts package owns shared API types, the API-client package owns typed
browser calls, and `apps/api` owns HTTP/JSON-RPC/SSE transport. Source pointers
are collected in [Operations & Events](api/operations-and-events.md#implementation-map).

## Commands

Use `corepack pnpm api:dev` for the API, `corepack pnpm web:dev` for the web app,
and `corepack pnpm dev` for the complete attached local stack. The full setup and
verification sequence is in [Local Development](local-development.md).

## Server-Sent Events — `GET /v1/events/stream`

The endpoint tails tenant-scoped `job_events`, emits typed SSE frames, and uses
event IDs for replay. The browser invalidation router maps each event type to the
smallest safe query-key set. See
[Operations & Events](api/operations-and-events.md#server-sent-events) and the
[frontend realtime architecture](architecture/frontend/realtime.md).

### Request

The browser opens one long-lived `GET` request. A reconnect may include
`Last-Event-ID`; the server resumes after that event when it is still available.

### Response Framing

Frames include an `id`, typed `event`, JSON `data`, and a reconnect cadence.
Clients validate the payload before dispatching it to the invalidation router.

### Tenant Filtering (COALESCE On The Row, Not The Request)

Tenant compatibility is resolved against each stored row. The request tenant is
never broadened to turn a tenant-scoped stream into an unscoped one.

### Resume-Position Precedence

Resume and replay positions follow the explicit request/header contract before
falling back to the current tail. See the complete contract for the exact order.

### Cadences

The server polls for durable events and sends keepalive traffic on separate,
bounded cadences so quiet connections remain observable.

### Reconnect Backstop

Native `EventSource` reconnect plus durable event IDs is the normal recovery
path. Projection refetches remain the correctness backstop if a client misses an
invalidation.
