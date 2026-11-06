# Contracts, types and API boundaries

Python feature packages own business contracts. The transformed application has
one explicit composition root and one canonical writer per feature. HTTP, CLI
and Temporal invoke the same application services; there is no backend JSON-RPC
hop or second TypeScript business implementation.

## Ownership and composition

`jobctrl.features.<owner>` contains that owner's domain values, application
service, real I/O ports/adapters, schema and HTTP adapter. Domain/application
logic does not depend on HTTP, SQLite or Temporal SDK types. Infrastructure is
injected at composition. Cross-feature consumers use immutable public snapshots,
not private imports or tables.

Each `bootstrap.build_feature(runtime, **ports)` returns a plain `Feature`
record: name, public service, normal Starlette routes and explicit durable action
handlers. `app/bootstrap.py` imports selected owners explicitly and injects only
required public dependencies. This record is not dynamic plugin discovery.
Removing an optional owner removes its registration and routes while core
capabilities continue through their own public ports.

Source guards accept a caller-owned transaction at adapter boundaries so an
accepted result is fenced to the exact Profile, posting, requirement, fit or
wording revisions it consumed. Feature-defined semantic schemas and citation
checks remain with the feature.

## HTTP and errors

The API uses explicit `/v1/...` resource routes. Reads and synchronous mutations
return their feature DTOs. Mutations validate input and saved-version
preconditions. Errors use one transport envelope:

```json
{"error":{"code":"revision_conflict","message":"The saved version has changed."}}
```

Optional `details` contains safe structured recovery information. Unexpected
exceptions return a generic error and request ID; raw private values and provider
exception text never enter the response. Credentials use their own local native
store boundary and are absent from settings DTOs.

`POST /v1/actions/{action}` accepts the feature action payload directly and an
optional `Idempotency-Key` header. A confirmed durable start returns 202 with
`runId`, `workflowId` and status. The corresponding run read exposes admission,
execution, result, safe failure code and cancellation state. A repeated key must
bind identical input. A start error can be uncertain and is retried with that
same identity.

## Model authority

`runtime.model.determine` accepts explicit operation, instructions, sources,
response JSON Schema, context, prompt version, lane and optional model selection.
It returns a value plus immutable provider/model/lane/input-fingerprint receipt
provenance. JSON Schema validation is structural. The feature owns exact source
citations, semantic output validation and accepted-artifact binding.

A receipt being structurally successful is not feature acceptance. Feature reads
can retrieve exact receipts or exact fingerprints through the public gateway;
they cannot query shared model tables. Cache/reuse belongs to the owner and must
preserve source/model/prompt authority. No lexical fallback may decide meaning.

## Events and frontend contracts

`GET /v1/events/stream` emits one committed event envelope containing `eventId`,
`type`, `feature`, `aggregateId`, `tenantId`, `occurredAt` and `payload`. The SSE ID
is the integer event ID. Default frames use the named event type;
`?envelope=1` uses an ordinary `message` frame so one browser subscription can
observe every event. `Last-Event-ID` or `after` supplies a replay cursor.

The frontend shell owns one subscription and transport/error handling. Features
own their DTOs, queries, mutations and invalidation rules. Cross-feature pages
compose public panels. Activity reads the same committed event envelopes;
Dashboard combines public feature summaries and durable run reads. Clients do
not infer semantic state from events.

The implementation coordination signatures are recorded in
[the transformation contract](../plans/2026-11-06-python-contracts.md).
