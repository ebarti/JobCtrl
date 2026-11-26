# Python application runtime

The transformed source application has one Python authority for HTTP, CLI and
durable business actions. This describes the source candidate; it does not
announce a new installed release. The native launcher owns process lifetime,
local PostgreSQL and release selection. Python owns application state and decisions.

## Processes and entrypoints

| Process | Entry | Responsibility |
| --- | --- | --- |
| HTTP | `python -m jobctrl.app.server` | Loopback HTTP, feature routes, committed events, settings, credentials, readiness and built frontend assets. |
| Durable worker | `python -m jobctrl.app.worker` | The same explicit feature composition, DBOS action execution, cancellation and product schedules. |
| PostgreSQL | Local workspace database | Application data and DBOS durable execution state. |
| Browser | React frontend | User interaction, feature-owned HTTP reads/actions and one SSE subscription. |

The API defaults to `127.0.0.1:8766`. The API and worker select the same
workspace and PostgreSQL database. `JOBCTRL_DIR` selects the workspace and
`JOBCTRL_DATABASE_URL` selects its database connection. The launcher owns its
local database lifecycle; development and QA must use owned isolated workspaces.

`app/bootstrap.py` constructs feature repositories and services explicitly.
There is no package scanning, forwarding to old business handlers, Fastify
business writer or TypeScript/Python JSON-RPC transport. Optional features are
omitted from composition; required dependencies fail visibly. Features receive
only public owner services. Examples are Jobs source snapshots for Requirements,
Profile and Requirements snapshots for Fit, and approved source snapshots for
Resumes. A source guard accepts the caller's PostgreSQL transaction through its
adapter so dependent owners can publish against a revision atomically.

## Admission and readiness

The server binds only loopback. Every request checks the actual peer and Host;
proxy headers are not trusted. Browser mutations require a configured local
first-party Origin/Referer and compatible fetch metadata. Native clients use the
private local capability token without browser metadata. Extension origins are
allowed only at extension routes with the paired token; task administration
adds a worker-only admission check. Tokens and credentials never enter ordinary
settings, event payloads or application logs.

`GET /v1/health` reports workspace identity, database and DBOS readiness,
model accounting and worker status. Setup diagnostics include PostgreSQL, DBOS
and worker checks. Configuration presence and successful live checks remain
distinct facts. The supported upgrade is an explicit, validated import of the
current Python workspace; startup does not reset real data automatically.

## Durable actions and recovery

Feature actions have stable workspace and action identities. Domain acceptance
and DBOS dispatch share the workspace database transaction. An idempotency key
binds to the exact action and input; a changed input is rejected. Worker
replacement resumes durable work without creating a new external intent.
Feature owners retain stage and receipt bindings for previously accepted work.

Cancellation is persisted. A running external operation still reports its
truthful settlement or ambiguity. Approval, final source validation, external
intent and send/submit receipts remain with Applications and Outreach; recovery
never grants additional authorization. Schedules retain explicit product policy:
recurring Discovery searches find new jobs, and saved-posting rechecks remain
manual. Failed refreshes preserve accepted artifacts and unresolved accounting.

## Model execution and shutdown

The shared model gateway accepts a source-bound request and strict JSON Schema.
It performs saved policy, lane capacity and spend checks, then calls the selected
native provider adapter. Each attempt has a durable receipt with provider,
model, lane, prompt version, exact input fingerprint, result status and observed
usage. Feature owners validate citations and meaning-specific structure before
accepting that receipt with their own source revisions.

Known failures before provider dispatch are recorded with
`provider_started=false` and no fabricated zero charge. Interrupted or uncertain
provider execution retains unresolved accounting. Unknown cost or token usage
cannot be reported as complete. Provider-reported and explicitly sourced cost
estimates have separate cost authority; model-name guessing is not pricing
provenance. Model failures preserve the feature's accepted artifact.
Claude SDK dollar totals are client-side estimates, labeled `sdk_estimate` with
SDK and available CLI provenance. Cached and newly processed input tokens both
count toward lane limits. Unknown or placeholder SDK counters remain unknown.
Finite monetary caps require either reported cost or an explicit exact-model
quote before dispatch; quote availability and capture share the admission
transaction. A zero monetary cap explicitly disables that cap while lane/token
accounting remains enforced independently. Spend summaries distinguish live
calls, interrupted/unsettled calls, and completed calls whose provider supplied
no monetary amount. Missing terminal cost is unavailable, not an unresolved
operation; missing tokens cannot invalidate a known monetary total. An unknown
total remains null, with any known subtotal named separately. Re-enabling a
finite monetary cap still refuses dispatch against prior missing monetary
receipts; finite token lanes retain their own missing-token refusal. Read-only accounting
blockers derive from the same saved policy and receipt snapshot: positive money
limits require historical monetary evidence; positive token limits require
historical token evidence only in affected lanes. Unknown history with no
applicable enabled limit is informational, with null totals and original receipts
preserved. This does not settle interrupted actions or infer cancellation
ownership; execution recovery remains with canonical action/run owners.

Provider process reuse is bounded by the shared SDK runtime service. API and
worker shutdown close that service explicitly and join provider cleanup.
Credentials are loaded only at the provider boundary and remain outside prompts.
The E2E-only external provider seam requires an exact private workspace marker
and capability token, literal loopback HTTP, no redirects and no ambient proxy.
It replaces only the external provider call; application, database, worker and
renderer are real.

### Workspace and worker identity

The worker and API must use the same workspace database and compatible build.
Worker readiness is separate from database availability; a reachable database
alone does not prove that queued work can execute.
