# Python application runtime

The transformed source application has one Python authority for HTTP, CLI and
durable business actions. This describes the source candidate; it does not
announce a new installed release. The native launcher owns process lifetime,
Temporal and release selection. Python owns application state and decisions.

## Processes and entrypoints

| Process | Entry | Responsibility |
| --- | --- | --- |
| HTTP | `python -m jobctrl.app.server` | Loopback HTTP, feature routes, committed events, settings, credentials, readiness and built frontend assets. |
| Durable worker | `python -m jobctrl.app.worker` | The same explicit feature composition, Temporal action execution, cancellation and product schedules. |
| Temporal | Native supervised local server | Durable workflow history and activity recovery. |
| Browser | React frontend | User interaction, feature-owned HTTP reads/actions and one SSE subscription. |

The API defaults to `127.0.0.1:8766`. `--workspace`, `--host`, `--port`,
`--static-dir` and `--features` are explicit server options. The worker accepts
`--workspace`, `--temporal-address` and `--features`. Environment equivalents
include `JOBCTRL_DIR`, `JOBCTRL_API_HOST`, `JOBCTRL_API_PORT`, `JOBCTRL_WEB_DIR`,
`JOBCTRL_FEATURES`, `JOBCTRL_TEMPORAL_ADDRESS`,
`JOBCTRL_TEMPORAL_NAMESPACE` and `JOBCTRL_TEMPORAL_TASK_QUEUE`. The default task
queue includes a hash of the canonical workspace path, preventing accidental
cross-workspace dispatch to a worker using different state.

`app/bootstrap.py` constructs feature repositories and services explicitly.
There is no package scanning, forwarding to old business handlers, Fastify
business writer or TypeScript/Python JSON-RPC transport. Optional features are
omitted from composition; required dependencies fail visibly. Features receive
only public owner services. Examples are Jobs source snapshots for Requirements,
Profile and Requirements snapshots for Fit, and approved source snapshots for
Resumes. A source guard accepts the caller's SQLite transaction through its
adapter so dependent owners can publish against a revision atomically.

## Admission and readiness

The server binds only loopback. Every request checks the actual peer and Host;
proxy headers are not trusted. Browser mutations require a configured local
first-party Origin/Referer and compatible fetch metadata. Native clients use the
private local capability token without browser metadata. Extension origins are
allowed only at extension routes with the paired token; task administration
adds a worker-only admission check. Tokens and credentials never enter ordinary
settings, event payloads or application logs.

`GET /v1/health` reports the workspace identity, selected features, database
schema, model accounting and actual worker heartbeat. A worker is healthy only
when the recorded PID is live, its heartbeat is recent and its task queue matches
this workspace. Native lifecycle admission additionally verifies process
ownership. `GET /v1/setup/status` composes public Profile, provider, browser,
Temporal and policy diagnostics. Configuration presence and successful live
checks remain distinct facts.

Startup checks the SQLite file header before opening an existing database. A
legacy database receives `profile_transfer_required` without SQLite creating
WAL companions. The explicit Profile-only transfer belongs to the stopped
runtime cutover path. Development and E2E use fresh owned synthetic workspaces;
startup never resets a real workspace automatically.

## Durable actions and recovery

Feature actions are explicit names such as `requirements.refresh` or
`resumes.compose`. The HTTP boundary persists a run identity and input digest,
starts one Temporal `JobCtrlAction` workflow and returns 202 only when start is
confirmed. The workflow invokes the registered Python action directly. The CLI
uses those same public actions or routes.

An idempotency key binds to the exact action and input. Reusing it with changed
input fails with 409. A failed start confirmation can be uncertain; retrying the
same key reuses the same Temporal workflow identity. It must not create a fresh
external intent. Worker restart preserves the run ID. The worker heartbeats
while an action is executing, and Temporal can retry after an interrupted
worker. Feature owners persist stage/receipt bindings so a recovered action
returns accepted work rather than repeating an already accepted side effect.

Cancellation is persisted before Temporal cancellation is requested. A queued
run can become cancelled before execution; a running external operation reports
its truthful settlement or ambiguous outcome through its owning feature.
Approvals, final source validation, external intent and send/submit receipts
remain Applications/Outreach responsibilities. Temporal retry never grants
additional authorization.

The worker also reconciles nonterminal local run receipts against their exact
Temporal execution. This settles cancellation or exhausted retries after a
worker dies without invoking the activity again. Missing or unreachable history
does not imply completion, and recovery does not rewrite feature artifacts or
provider accounting.
Retries acquire the same per-run OS execution custody as the original activity.
A heartbeat timeout cannot admit a concurrent feature invocation while the first
process remains alive. Waiting retries heartbeat without blocking their event
loop; OS descriptor release, rather than a PID-only timer, permits recovery.

The worker reconciles explicit Discovery, Compensation and approved-Applications
schedules. Discovery reads its public schedule definition. Compensation uses
its stale-evidence action and committed Job events; a public settings switch
can disable automatic refresh. Approved-Applications recurrence is disabled by
default and must be explicitly enabled; it consumes only exact existing
approvals. There is no arbitrary workflow/plugin framework.

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
accounting remains enforced independently.

Provider process reuse is bounded by the shared SDK runtime service. API and
worker shutdown close that service explicitly and join provider cleanup.
Credentials are loaded only at the provider boundary and remain outside prompts.
The E2E-only external provider seam requires an exact private workspace marker
and capability token, literal loopback HTTP, no redirects and no ambient proxy.
It replaces only the external provider call; application, database, worker and
renderer are real.
