# Python application integration contract

Frozen foundation contract for transformation #1428, 6 November 2026. This is an
implementation coordination record; feature owners retain their own contracts.

## Files and ownership

The target remains the installable package at `workers/automation/src/jobctrl/`.
Feature owners own `features/<name>/` (`profile`, `jobs`, `discovery`, `companies`,
`requirements`, `fit`, `resumes`, `contacts`, `outreach`, `applications`,
`interviews`, `learning`, `digest`, `compensation`, `offers`). Foundation owns
`app/`, `features/__init__.py`, `pyproject.toml` and the shared architecture/API
documents. Runtime owns the existing CLI and launcher/startup/packaging files.
Feature owners must not edit the composition root or shared dependency files.

## Explicit composition

Each feature exposes the following adapter entry point from its `bootstrap.py`:

```python
from jobctrl.app.contracts import Feature, Runtime

def build_feature(runtime: Runtime, **ports) -> Feature:
    # Construct feature-owned repository, application service and HTTP adapters.
    return Feature(name="profile", service=service, routes=routes, actions=actions)
```

`Feature` is a plain frozen dataclass with `name: str`, `service: object`,
`routes: tuple[starlette.routing.BaseRoute, ...] = ()`, and
`actions: dict[str, ActionHandler]` (empty by default). `routes` are normal
Starlette routes defined by the feature's HTTP adapter. `actions` contains only
explicit durable entry points, named `<feature>.<action>`. It is not a plugin
system: `app/bootstrap.py` imports and calls the selected features explicitly,
then injects only their public services into dependent features. Optional
features are omitted from that composition. A missing required public port
fails startup clearly; it must not fall back to legacy handlers or private SQL.

`Runtime` has `workspace: pathlib.Path`, `database: Database`, `settings: Settings`,
`events: EventStore`, and `model: ModelGateway`. Infrastructure dependencies are passed only to feature
adapters; domain/application code uses feature-owned protocols. Public services
return immutable snapshots or JSON DTO copies. Do not read sibling tables.

## SQLite and committed events

`runtime.database.connect()` returns a fresh configured `sqlite3.Connection`
with `sqlite3.Row`, foreign keys, WAL and a bounded busy timeout. It can be used
as a context manager. `runtime.database.transaction()` is a context manager that
starts `BEGIN IMMEDIATE`, commits on success and rolls back on failure.

Feature schema is declared as `SCHEMA: str` in `features/<name>/schema.py`.
The feature bootstrap calls `runtime.database.initialize_feature(name, SCHEMA)`.
Only feature-owned tables/indexes/triggers may appear there. The database stores
the schema digest and refuses an incompatible declaration; future upgrades need
explicit feature migrations. New target databases are marked with the target
application identity. An existing legacy database is refused without mutation;
the runtime-owned explicit Profile transfer creates a fresh target workspace.

Inside the same canonical transaction as a business mutation call:

```python
runtime.events.append(conn, "ProfileUpdated", {"profileVersion": version},
                      feature="profile", aggregate_id="default")
```

`append` returns the integer event ID. Payloads are bounded invalidations/IDs,
never credentials, raw Profile evidence or generated documents. SSE reads only
committed `app_events` rows, so rollbacks are invisible. Feature repositories own
optimistic-concurrency predicates and raise `ConflictError` for stale versions.

## HTTP and errors

Use existing `/v1/...` paths where their capability survives; new feature paths
are explicit and owned by the feature. HTTP adapters use `await request.json()`
and Starlette `JSONResponse`. `app.errors` exports:

```python
AppError(code: str, message: str, status_code: int = 400, details: dict | None = None)
ConflictError(message: str = "The saved version has changed.", **details)
NotFoundError(message: str = "The requested record does not exist.")
```

Errors serialize as `{"error": {"code": str, "message": str, "details": object?}}`.
Feature adapters validate input and translate their own domain errors; unexpected
errors expose a generic 500 and a request ID. No exception text/secret leakage.
Foundation owns host/origin/peer/token checks, request size, security headers,
`/v1/health`, `/v1/settings`, `/v1/credentials`, `/v1/events/stream`,
`/v1/actions/{action}`, `/v1/action-runs/{run_id}`, and static assets. Features
must not claim those paths. Ordinary HTTP reads/writes return 200/201; durable
submission returns 202 only after Temporal accepted the workflow.

## Shared application and durable execution

```python
from jobctrl.app.contracts import ActionContext

async def execute(context: ActionContext, payload: dict) -> dict:
    ...  # call the same feature application action used by HTTP/CLI
```

`ActionContext` contains `run_id: str`, `request_id: str`, `cancelled()` and
`heartbeat(details: dict | None = None)`. Only adapters depend on this runtime
type. Each action is a real application function, never a forwarded JSON-RPC
method. External-effect features retain their own exact approval, durable intent,
receipt and ambiguous-outcome guards. Temporal retries must not invent renewed
external authorization. `app.worker` hosts the worker and executes this exact
composition; HTTP and CLI use `app.bootstrap.create_application(workspace, ...)`.

Entrypoints owned by foundation:

```text
python -m jobctrl.app.server --host 127.0.0.1 --port 8766 --workspace PATH [--static-dir PATH]
python -m jobctrl.app.worker --workspace PATH [--temporal-address localhost:7233]
```

`JOBCTRL_DIR`, `JOBCTRL_API_HOST`, `JOBCTRL_API_PORT`, `JOBCTRL_TEMPORAL_ADDRESS`,
`JOBCTRL_TEMPORAL_NAMESPACE`, and `JOBCTRL_TEMPORAL_TASK_QUEUE` are supported.
The runtime owner wires source and installed launch to those entrypoints.
No dependency installation or legacy-runtime bridge is part of feature work.

## Source-bound model gateway

```python
result = await runtime.model.determine(
    operation="requirements.extract",
    instructions="Decide only from the supplied sources ...",
    sources=[{"source_id": "posting:1", "text": "...", "revision": 2}],
    response_schema=ResultSchema.model_json_schema(),
    context={"entity_id": "job-id"},  # optional
    prompt_version="1",            # default
    lane="requirements",           # default interactive; feature lanes allowed
    model=None,                    # saved provider/model selection
    require_accounting=False,      # True for an owner-enforced monetary cap
)
```

`ModelResult` is a frozen record with `value: dict` and `provenance: dict`.
Provenance contains `receipt_id` (UUID), `provider`, `model`, `lane`,
`prompt_version`, `input_fingerprint` (64 hex), and `created_at`.
`runtime.model.receipt(receipt_id)` reads the persisted attempt receipt.
The gateway validates JSON Schema, performs lane/spend preflight, records actual
provider usage and preserves unresolved accounting. It never interprets source
meaning or caches semantic output. The feature owns citation/domain validation,
reuse, and atomic acceptance of the receipt with its own source-revision guards.
Do not use legacy determination repositories or old global budget writers.

Feature HTTP adapters can submit durable work through
`await request.app.state.application.submit(action, payload,
idempotency_key=request.headers.get("idempotency-key"),
request_id=request.state.request_id)` and return that receipt with 202.

The SQLite identity is application ID `0x4A435354` (decimal `1245926228`),
`user_version=1`, and `app_metadata.application=jobctrl-python`.

## Pricing, activity and operational reads

Settings `modelPricingQuotes` is an explicitly authored map from the exact
`provider:modelId` to `{inputUsdPerMillion, outputUsdPerMillion, source, revision}`.
The gateway snapshots that quote before dispatch. When a provider cannot report
monetary cost and no quote is saved, a finite daily monetary cap refuses the call
before provider dispatch with `cost_accounting_unavailable`. Setting
`dailyBudgetUsd=0` explicitly disables that monetary cap; lane token accounting
remains independent. Cost estimates retain their quote source and are labeled
`configured_pricing_estimate`; provider-reported costs use `provider_reported`.
Claude SDK monetary totals are client-side estimates labeled `sdk_estimate`,
with `cost_provenance` recording the installed SDK, known CLI version (or null),
and bundled-price source. They are not billed provider charges. No model-name
guessing supplies a rate.

`accounting_capability(model=None, selection=None)` exposes the selected
provider/model, `available`, `costSource` and `pricingQuote` without dispatch.
Owners with a positive per-action monetary cap also pass
`require_accounting=True` to `determine`; the gateway checks that requirement
inside the same transaction that captures the quote. This operational guard does
not alter the semantic input fingerprint. `applyMaxBudgetUsd=0` disables its
monetary cap independently of the daily policy.

`receipt` also exposes `provider_started`, `cost_source`, `pricing_quote` and
`owner_alive`. Definite preparation failures have `provider_started=0`; no zero
usage is invented. Lost or interrupted provider execution stays uncertain.
`find_succeeded(fingerprint, connection=None)` and
`receipts_for(operation, fingerprint, connection=None)` are exact public receipt
reads, not automatic semantic caching.

`GET /v1/activity` (`/v1/events`) returns `{events,nextCursor,hasMore}` newest-first.
It accepts `before`, bounded `limit`, and literal `feature`, `type`, `level`,
`stage`, `aggregateId`, `since` and `until` filters. `q` is a literal substring
search across recorded identifiers and bounded event payloads, with SQL wildcard
characters escaped. Event level/stage are explicit
producer metadata, never inferred from prose or event names. The event envelope
adds `level` and nullable `stage` to the original fields. Activity detail is
`GET /v1/activity/{eventId}`.

`GET /v1/action-runs` uses the same pagination shape with `runs` and a run-ID
cursor and literal `status`, `action`, `since`, `until` filters.
`GET /v1/action-runs/summary` returns recorded status `counts`, `total`,
`active` and `pendingCancellation`, without inferring business-stage meaning.
`GET /v1/action-runs/by-idempotency-key?action=...` accepts the exact
`Idempotency-Key` header and returns that run without its request payload. A 404
means no admission is recorded at that instant; an earlier in-flight request
can still arrive, so absence is not permission to invent a replacement identity.

The root composition explicitly adds the preparation recipe owner after its
required core services and binds the application after construction. Optional
feature schedules are concrete Discovery, Compensation and approved-Applications
policies; they do not enable a generic workflow plugin system.

`app/preparation.py` contains recipe application policy over checkpoint,
settings and action-reader ports. `preparation_store.py` owns SQLite checkpoints
and their transactional events; `preparation_http.py` owns route reads and
`preparation_bootstrap.py` constructs the concrete adapters. Same-operation
Requirements continuations resume their exact saved inputs with cancellation
and heartbeat checks. Preparation reads include `cohortFrozen`, `scope`, the
literal `stagePlan` and `jobConcurrency=1` for the current sequential recipe.

Execution custody is held by a private non-inherited OS file descriptor per
run. Temporal retry waits asynchronously while an earlier live process owns it;
heartbeat expiry does not steal execution. Terminal reconciliation acquires the
same custody through its transaction. Feature source and acceptance guards remain
authoritative, and interrupted provider accounting remains unresolved.

The SSE `after=latest` option snapshots the current committed cursor when no
`Last-Event-ID` header is present. Reconnect headers always take precedence.
HEAD requests use safe GET handling and suppress the body; SSE HEAD terminates
after returning headers. Health exposes `temporal.namespace` and nullable
`temporal.uiBaseUrl`; the latter comes only from explicit
`JOBCTRL_TEMPORAL_UI_URL`, never from guessing a web port.
`databaseInstanceId` hashes the pinned physical database identity with its
workspace path. It remains stable during ordinary writes/restarts and changes on
atomic database replacement; it is a file-incarnation guard, not an eternal UUID.
Clients can bind initial writes and recovery reads/retries to that identity with
`Expected-Database-Instance-Id`. The middleware rejects malformed values with
400 and mismatches with `workspace_changed` 409 before invoking any handler;
ordinary per-connection database identity guards remain enforced as well.
