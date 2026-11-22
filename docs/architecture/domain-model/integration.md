# Integration and Event Boundaries

The target application is one Python modular application. HTTP, CLI and the
Temporal worker compose the same feature services and invoke the same canonical
business actions. There is no Fastify business API, TypeScript/Python JSON-RPC
hop, forwarding bridge or alternate business writer at cutover. This target is
being implemented and still requires integrated verification.

## Explicit composition

The foundation contract defines a plain `Feature` record with a public service,
feature HTTP routes and named durable actions. The composition root imports and
builds selected features explicitly, injecting public dependencies. Feature
packages remain independently removable where their contracts permit it. An
absent required dependency fails clearly; it is not substituted with a legacy
handler or a sibling table read.

## Commands and durable execution

Short requests use feature HTTP adapters. Durable work is submitted to the
Python application and acknowledged as accepted only after Temporal accepts it.
The worker dispatches the registered feature action to the same application
service; workflow retries and cancellation obey feature-owned source, approval
and external-effect fences. CLI is another adapter to that application.
See [pipeline](../pipeline/index.md) and the
[foundation contract](../../plans/2026-11-06-python-contracts.md) for the
workstream interface.

## Committed events and read models

Feature-owned mutations and their bounded invalidation events commit together.
SSE may expose committed events only, never a rolled-back write. Consumers join
recorded IDs to the owning public query; events are not an alternate source of
facts and must omit credentials, Profile evidence and generated document text.
The frontend shell owns one event connection and feature handlers own their
query invalidations. Read models must not create a second canonical writer.

The specific route, event and action inventory remains provisional until the
integrated implementation and real entry points are checked. See the
[API reference](../../api/complete-contract.md).
