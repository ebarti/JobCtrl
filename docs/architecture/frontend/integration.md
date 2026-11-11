# 8–9. Cross-Feature Integration

## 8. Cross-Context Integration

Features expose public panels, read helpers, mutation hooks, keys and event invalidation registrations. The shell and views compose them explicitly. A feature can accept another owner's immutable public snapshot as an input but must not reach into the other owner's private hooks or store. Independent queries run concurrently and bulk endpoints are preferred to a request per row.

## 8.2 Mutation → Invalidation Map

The feature that owns a write refreshes the affected reads and records any local optimistic patch and rollback. Each consumer of upstream events declares its own dependencies: for example, a changed posting can stale requirements and fit, and a changed Profile can stale fit and wording. The event stream then invokes all relevant public handlers. A failed refresh retains previously accepted artifacts and exposes the failure.

## 8.4 Event → Invalidation Map (Full)

The source of truth is the explicit feature registration and its actual Python event names, not a prose event-count table. An event handler must target the tenant and relevant query keys, guard data needed for a patch, and use safe invalidation when it cannot reconcile a partial event. See [realtime](realtime.md).

## 8.5 Composition Patterns

Dashboard, Activity, Settings and Evidence Map compose public feature contributions. Job Detail accepts shell-provided optional sections and actions; core does not import the optional features. Mounted contributions and navigation check the Python application's health-reported feature list; unknown health does not imply an optional feature exists. A feature can be removed by removing its registration and its source without breaking unrelated core routes. No generic runtime plugin registry or alternate business data kernel is introduced.

The Pipeline view composes public Preparation cohorts and action runs with the bounded telemetry read. Stage counts describe recorded checkpoints and declared but unrecorded work separately; worker-slot occupancy stays unknown when the worker has not reported it. Model-lane counts describe recorded calls and configured admission capacity, with monetary and provider-readiness caveats. A remaining-time range appears only when the service can join sufficient matching committed start and completion evidence; its basis, sample count and limitations remain visible. Discovery source-family counts describe recorded units, not a complete future fan-out. The telemetry read polls only while the page is in the foreground and also invalidates on committed owner events.

In the Original redesign, the primary job task composes one Prepare action with
its existing preparation command/progress/recovery interfaces, the actual Resume
panel and separately owned application/outcome contributions. The retained
Preparation/Task history/Recorded events views remain diagnostic entries under
Settings. They do not own a second launcher or become mandatory steps.

Search preferences composes Profile targets/place bindings with Discovery's
board/limit/source controls and explicit search admission. Settings return state
brings the user back without dispatching work. Visit-preserving panes and
version-fenced browser drafts keep unsaved text separate from newly accepted
server snapshots. Appearance uses browser-local UI preferences and actual font
resources, with resume document style isolated.

The Requirements composition joins canonical IDs/revisions, recorded Fit
assessments/coverage, separate user associations and public Profile
achievements/wording. Its list/detail/filter and exact Profile return links are
navigation state; manual links and revision restoration are explicit writes.
They cannot initiate semantic assessment or transfer an exact approval.

## 9. Evolution Paths (Cloud-Mode Adapters Named, Not Built)

The local application is the active target. Ports keep browser I/O, tenant identity and transport replaceable without introducing speculative hosted infrastructure or changing feature ownership.

The Jobs header composes Discovery's public `SavedDiscoverySearch` action and
feedback with saved Profile/Discovery readiness. Discovery owns admission,
exact-key recovery, canonical action/run reads and stop; no route/view acquires
HTTP or Query authority. Shared compact and one-off controls use the same
controller. Saved preference readers key and fence their reads by database
incarnation, retaining editor drafts separately; launch revalidates that same
incarnation before creating its request identity. The server serializes
workspace search admission so two simultaneous tabs cannot both enqueue work.
