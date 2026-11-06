# 7. Realtime — SSE Consumer Architecture

The shell owns one connection to the Python application's committed-event stream. Features declare the names they handle and export their cache effects; the application explicitly composes those handlers. This is ordinary application composition, not a plugin framework. Multiple features can subscribe to the same upstream event when their reads depend on it.

## 7.1 The Endpoint — `GET /v1/events/stream`

The stream emits named events with an integer `id:` and a JSON envelope containing `eventId`, `type`, `feature`, `aggregateId`, `tenantId`, `occurredAt`, recorded `level` and `stage`, and object `payload`. The browser requests `?envelope=1&after=latest`, which emits each new event as an ordinary `message` carrying its type in the envelope; this lets the shell observe events without a registered handler and avoids replaying the whole history on a fresh mount. Events are published only after the associated transaction commits. `Last-Event-ID` takes precedence on reconnect; a numeric `after` also selects replay after a cursor, in ascending order. Heartbeat comments keep the stream alive. Payloads carry bounded identifiers and invalidation information, never credentials, profile evidence or generated documents. The application contract is recorded in [Python integration](../../plans/2026-11-06-python-contracts.md).

## 7.2 Typed Event Schemas

The browser validates the frame and dispatches declared event names to feature handlers. A feature validates the fields it needs and owns its event-to-query mapping. Shell registration must include every event used by mounted features, including upstream changes that make a derived read stale. An invalid frame, unclaimed event or handler failure triggers conservative reconciliation and observable, content-free telemetry; it must not leave stale data presented as current.

## 7.3 The `EventStreamProvider`

The provider opens the single port subscription for the current tenant, publishes connection status and closes it on unmount or tenant change. On initial connection and reconnect it reconciles cached tenant reads, including reads that were already in flight. Reconciliation must preserve in-flight optimistic ownership and the accepted cache value. Disabled locally patched timelines are not turned into unsupported reads.

## 7.4 The Invalidation Router

The application composition supplies feature handlers to the provider. Handlers invalidate their own tenant-first query keys or apply a safe, identity-bound patch when sufficient information is available. They use `invalidateQueriesWithOptimisticOwnership` for invalidation that may overlap an optimistic mutation. Activity and cross-feature views refresh through their own public invalidations; a feature does not reach into a sibling's private cache.

## 7.7 Reconnect / Backoff

The browser `EventSource` supplies reconnect and cursor handling. Connection status is visible; a gap causes reconciliation rather than an assumption that all events arrived. A workspace identity change must be surfaced as such rather than silently accepting an unrelated history.
