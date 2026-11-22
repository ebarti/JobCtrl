# 7. Realtime — SSE Consumer Architecture

The shell owns one subscription to the Python application's committed-event stream. The local browser adapter shares one upstream EventSource across tabs with the same worker script version, browser origin, API target and tenant through a module SharedWorker. Tabs left on an older application build retain their own worker until they close or reload. Sharing leaves browser HTTP connection capacity available for ordinary reads and writes even when many tabs are open. Features declare the names they handle and export their cache effects; the application explicitly composes those handlers. This is ordinary application composition, not a plugin framework. Multiple features can subscribe to the same upstream event when their reads depend on it.

## 7.1 The Endpoint — `GET /v1/events/stream`

The stream emits named events with an integer `id:` and a JSON envelope containing `eventId`, `type`, `feature`, `aggregateId`, `tenantId`, `occurredAt`, recorded `level` and `stage`, and object `payload`. The browser requests `?envelope=1&after=latest`, which emits each new event as an ordinary `message` carrying its type in the envelope; this lets the shell observe events without a registered handler and avoids replaying the whole history on a fresh mount. Events are published only after the associated transaction commits. `Last-Event-ID` takes precedence on reconnect; a numeric `after` also selects replay after a cursor, in ascending order. Heartbeat comments keep the stream alive. Payloads carry bounded identifiers and invalidation information, never credentials, profile evidence or generated documents. The application contract is recorded in [Python integration](../../plans/2026-11-06-python-contracts.md).

## 7.2 Typed Event Schemas

The worker fans out raw frames and connection status; every page's adapter still validates the frame and dispatches declared event names to feature handlers. A feature validates the fields it needs and owns its event-to-query mapping. Shell registration must include every event used by mounted features, including upstream changes that make a derived read stale. An invalid frame, unclaimed event or handler failure triggers conservative reconciliation and observable, content-free telemetry; it must not leave stale data presented as current.

## 7.3 The `EventStreamProvider`

The provider opens the single port subscription for the current tenant, publishes connection status and closes it on unmount or tenant change. On initial connection and reconnect it reconciles cached tenant reads, including reads that were already in flight. Reconciliation must preserve in-flight optimistic ownership and the accepted cache value. Disabled locally patched timelines are not turned into unsupported reads.

Each page owns only its worker message port. Unsubscribe and page hide release
that port without interrupting peers; a page restored from the back/forward cache
reconnects and reconciles. The last subscriber closes the upstream immediately.
Five-second heartbeats and 90-second worker leases bound abandoned-port cleanup;
expiry or a missing worker heartbeat reconnects the page through the shared path.

## 7.4 The Invalidation Router

The application composition supplies feature handlers to the provider. Every committed envelope reaches its handlers, which identify the affected tenant-first query keys. The provider immediately marks the matching cached queries stale and coalesces overlapping keys into one refresh per query per 250 ms window. A read already underway can finish and receives one trailing refresh for events that arrived during it. Hidden tabs keep recording invalidations and resume event-driven reads when visible. Refreshes use `invalidateQueriesWithOptimisticOwnership` to retain unsettled optimistic writes. Activity and cross-feature views register their own dependencies.

## 7.7 Reconnect / Backoff

The browser `EventSource` supplies reconnect and cursor handling. The shared
worker retains that EventSource across page subscription changes, and an idle
upstream reopen uses its last recorded numeric event cursor. A terminated worker
starts a fresh stream and every reconnected page reconciles canonical reads.
An observed workspace change remains terminal for each affected page subscription.
Connection status is visible; a gap causes reconciliation rather than an assumption
that all events arrived. A workspace identity change must be surfaced as such
rather than silently accepting an unrelated history.

Browsers without SharedWorker or worker EventSource support retain the direct
EventSource adapter. Supported-worker load, runtime or protocol failures report a
closed connection and retry the shared transport with a one-to-30-second bounded
backoff. They never silently create per-tab fallback streams, which would recreate
connection saturation. Visibility alone is not a sharing boundary: some in-app
browsers report every background tab as visible.
