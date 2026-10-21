# Agent Runtime Ownership

JobCtrl uses `agent-runtime-kit` for Codex, Claude and Antigravity generation,
analysis, synthesis, review and voice execution. JobCtrl retains model routing,
product lanes, spend admission, strict result parsing and accepted-artifact
persistence. Provider setup and model-catalog reads use the native APIs where
the kit has no corresponding introspection operation.

## Process and event-loop lifetime

Each Python process lazily owns one persistent async event loop and runtime
cache. Synchronous activity threads and asynchronous callers submit independent
kit tasks to that loop. Context variables carry the caller's product lane and
trace context. SDK clients never move between temporary `asyncio.run` loops.

A cached runtime serves one request at a time. Simultaneous requests lease
independent runtimes, preserving pipeline and worker admission rather than
adding a model-call queue. The configured worker activity capacity at service
creation is also the maximum number of idle runtimes retained per Python process. Excess
completed runtimes close. This idle retention bound does not limit pipeline
internal fanout or allocate extra Temporal activity slots.

The worker drains its activity executors, closes agent runtimes, then flushes
telemetry. Other Python entry points also register process-exit cleanup.
Cancellation waits for the actual request and SDK cleanup to settle before its
lease can be reused. SDK-originated cancellation, budget errors and typed
provider failures retain their identity across the loop boundary.

## Provider contracts

### Codex

The kit owns reusable app-server clients. Each request creates a distinct
**ephemeral thread**; generation and judging never resume each other's
conversations. Reuse keys include the exact model, reasoning effort, isolated
configuration and an authentication fingerprint. Changed keys replace idle
resources, and the kit verifies loaded named permission profiles before reuse.

The configuration keeps JobCtrl's isolated credential home, deny-all approvals,
disabled shell/apps/plugins and named filesystem profile. Model commands cannot
read credentials or arbitrary root paths. The profile permits only the owned
workspace, minimal runtime paths and the canonical Codex executable.

The generated workspace is a private empty Git project root, created with
stdlib filesystem operations without requiring a Git executable. The immutable
`project_root_markers=[".git"]` override keeps app-server project discovery and
the kit's policy inspection at that same boundary, even beneath a retained user
home with unrelated Codex configuration. Initialization is serialized across
processes and publishes complete metadata by directory rename. Symlinks, Windows reparse points,
gitfiles, partial or unfamiliar metadata fail closed and remain unchanged.
The isolated credential-home, system and workspace-local configuration layers
remain subject to native policy validation; ancestor configuration outside the
project is excluded.

A narrow SDK facade consumes the public turn stream. The native convenience
`run` method loses structured `TurnError` fields; the facade retains JobCtrl's
bounded provider-error envelope and observed token accounting while the kit
owns process lifecycle. Startup is shielded and joined before cancellation can
tear down a partially published SDK process. Completed raw output still reaches
JobCtrl's strict parser, preserving its distinct schema/citation repair paths.
A kit schema failure is never treated as an accepted artifact.

### Claude

The kit dispatches the native query with a fresh conversation, tool-free
options, strict permissions and the existing supported credential/bare-runtime
configuration. It does not reuse a conversational client across independent
artifact generators and judges. Native terminal messages remain available to
the owner so usage is accounted before failure classification and parsing.

### Antigravity

The kit owns the agent lifecycle and keeps each independent task isolated.
JobCtrl supplies the native Gemini-compatible schema, supported API-key/Vertex
configuration and owned runtime directories. Kit-selected capabilities,
policies and workspace restrictions are applied to that configuration. Only
`FINISH` is available and subagent delegation is disabled. The native chunk
stream is drained before reading final structured output or text.

The kit's task-isolated process key prevents implicit conversation reuse for
Antigravity tasks. Its metadata records the actual reuse behavior; reusable
runtime objects alone are not evidence of a reused provider process.

## Bundled provider upgrades

The kit and its schema-validation dependencies belong to the core Python
closure. The generated provider lock removes dependencies now owned by core;
activation still rejects core/provider overlap.

Provider installations use the SDK version plus the SHA-256 identity of the
signed wheel specification. This permits a new closure under the same SDK
version while preserving the previous installation. Activation schema 2 records
that installation key, but the reader derives and compares it against the
signed payload rather than following a mutable path. Legacy schema-1 version
directories remain readable when their complete retained wheels, metadata and
tree match the current signed specification. All existing signature, wheel,
symlink, digest and provider-overlap checks remain required.

## Model and artifact authority

Saved models and per-model reasoning effort keep their existing precedence.
The integration does not select a faster model, change grades, bypass provider
availability, skip a review, or resume an earlier conversation. Product-lane
and spend preflight still precede each admitted provider attempt. Determination
IDs, source citations and accepted artifact bindings remain the canonical
read authority. Failed refreshes preserve the last accepted artifact.

Draft generation, voice changes and their dependent factual/quality checks keep
the [Tailoring Contract](tailoring.md). Runtime reuse removes repeated process
startup; model reasoning and artifact dependencies still contribute to duration.

## Verification

The lifecycle and actual-kit transport tests cover repeated requests, distinct
threads, concurrent fanout above the idle-retention count, changed keys, typed
failure eviction, context propagation, SDK-startup cancellation and shutdown.
A configured-provider probe in an owned synthetic workspace separately proves
real process reuse and fresh conversation IDs. Provider doubles test protocols
and model authority; they do not grade semantic quality or replay saved model
outputs. See [Reliability & QA](../local-reliability-qa.md).
