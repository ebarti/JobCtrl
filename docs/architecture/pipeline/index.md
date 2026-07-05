# Job Pipeline

"The pipeline" is the life of one job posting inside JobHunter: from the moment
discovery finds a posting, through enrichment, scoring, and tailored resume and
cover-letter generation, to a supervised apply and the feedback that comes back.
This overview page holds the product stage shape, the execution surfaces that
start work, and the full workflow catalog; the pages below drill into how that
work runs, each answering the next question a newcomer asks:

- [Stage Walkthrough](stages.md) — what does each stage do, from Discover to
  Apply, and what does it persist?
- [Envelope & Activities](envelope.md) — what contract does every workflow obey,
  and how do activities, retries, and the error taxonomy work?
- [Concurrency & Fan-out](concurrency.md) — how much runs at once, and what
  bounds throughput?
- [Operations & Events](operations.md) — how do spend, the discovery schedule,
  persistence, events, and failures behave day to day?

Under the hood, every long-running unit of work is a **Temporal (the workflow
engine) workflow** — one durable workflow per stage family, with activities for
each side effect. There is no in-process pipeline engine and no flag that falls
back to one: the old sequential/threaded runner was deleted. If work takes
longer than an HTTP request, it runs on the Python worker under Temporal.

This section is the deep-dive companion to the
[System Architecture](../index.md) overview: that page names the runtime
boundaries and system topology — the web app, the TypeScript API, the Python
worker, Temporal, SQLite, and the Server-Sent Events (SSE) stream — while these
pages follow the work through them, from a button click or CLI command, across
the JSON-RPC boundary, into workflows and Python activities, and back out through
persistence, events, and projections to the web app. The canonical domain model
is the [Domain Model (DDD)](../domain-model/index.md) section; resume tailoring
has its own deep-dive in [Resume Tailoring Logic](../tailoring.md), and this
section summarizes the Tailor stage and points there for gate depth.

**Read this if** you are changing pipeline behavior, debugging a stuck or
duplicated run, or need to know exactly where a stage persists and how the web
app learns a stage finished.

## Product Shape: Discover → Apply

The user-facing stage order is deliberately small:

```text
discover -> apply
```

`Discover` is the single preparation stage. It finds jobs, enriches usable
postings, and then fans out durable per-job preparation (scoring, tailoring,
cover letters, PDFs) plus artifact suppression for jobs that no longer qualify.
`Apply` is separate because it can submit real applications and carries its own
safety controls.

Internally, preparation still uses a finer stage vocabulary that appears in
stage rows, low-level contracts, CLI maintenance commands, and diagnostics:

```text
discover -> enrich -> score -> tailor -> cover -> apply
```

The product UI folds `enrich`, `score`, `tailor`, and `cover` back under
`Discover` (job timelines and operational views still expose the detail). The
one exception is `cover`: when a tailored resume already exists and `cover` is
the first actionable row, the list projection advances the product stage to
`apply` while keeping `current_substage='cover'` visible for repair.

## Execution Surfaces

Every surface builds the same kind of workflow start spec and starts a workflow
on the JobHunter task queue. They differ only in which entry point is used and
which workflow is selected.

| Surface | Entry point | What it starts |
| --- | --- | --- |
| Pipelines UI | `POST /v1/pipeline/actions/run-stage` | The TypeScript API dispatches JSON-RPC `run_stage`. A `discover`-only request starts `DiscoverWorkflow`; anything else starts `JobPipelineWorkflow` (which delegates `discover` and `apply` to child workflows). |
| Jobs view pending pickup | `POST /v1/jobs/:jobKey/actions/run-stage` | Starts a job-scoped `JobPipelineWorkflow` for one visible `pending` internal substage (`enrich`/`score`/`tailor`/`cover`), gated by the API on observable eligibility. |
| Jobs bulk pending prep | `POST /v1/jobs/bulk-run-pending-preparation` | Groups selected job URLs by their first eligible pending substage and dispatches bounded `run_stage` workflows. |
| Jobs bulk failed retry | `POST /v1/jobs/bulk-retry-failed` | Resets retryable failed stages and, with `runAfter: true`, dispatches batch `run_stage` workflows for the reset job URLs. |
| CLI | `jobhunter <command>` | Builds the same spec, starts Temporal, waits for the handle, and exits non-zero on workflow failure. `jobhunter discover` / `run discover` is the normal path; `score`/`tailor`/`cover` are maintenance commands. |
| Temporal schedule | `jobhunter-discovery-local` | Optional cron schedule that starts `DiscoverWorkflow`. Off by default (see [Discovery Schedule](operations.md#discovery-schedule)). |

### Entry Points → JSON-RPC → Workflow Selection

The TypeScript API never runs pipeline logic itself. It maps UI/CLI intent to a JSON-RPC
method over a long-lived `jobhunter rpc` subprocess (stdin/stdout, one JSON
envelope per line). The method registry in
`workers/automation/src/jobhunter/infrastructure/rpc/handlers.py` marks each
method as either `mode="workflow"` (start a workflow, return its ids) or
`mode="sync"` (run inline, return the result). The server also supports a
`streaming` generator mode; no default method currently uses it.

| JSON-RPC method | Mode | Workflow selected |
| --- | --- | --- |
| `run_stage` | workflow | `DiscoverWorkflow` if stages are exactly `["discover"]`, else `JobPipelineWorkflow` |
| `apply` | workflow | `ApplyWorkflow` (per-job, `apply-{tenant}-{jobKey}`) |
| `rescore_job`, `rescore_jobs_not_on_current_scoring_policy` | workflow | `JobPreparationWorkflow` / `JobPipelineWorkflow` (score) |
| `tailor_job`, `retailor_job`, `retailor_current_policy` | workflow | `JobPreparationWorkflow` (`tailor`,`cover`,`pdf`) |
| `refresh_compensation` | workflow | `CompensationRefreshWorkflow` |
| `profile_import` | workflow | `ProfileImportWorkflow` |
| `analyze_job` | sync | none (inline read) |
| `cancel_run` | sync | none (issues a Temporal cancel to a running handle) |

Workflow selection for `run_stage` lives in
`workers/automation/src/jobhunter/workflow_specs.py`
(`build_run_stage_workflow_spec` and `build_apply_workflow_spec`).

### Async vs Sync (202 vs 200)

The distinction matters for anyone reading the API or the UI:

- **Workflow-mode methods are asynchronous.** The method returns
  `{ runId, workflowId }` the moment Temporal accepts the start, and the HTTP
  route answers **202 Accepted**. The outcome is *not* in that response — it
  arrives later in the read model and is pushed to the UI via SSE invalidation.
  A failure to *start* (bad input, worker unreachable) returns an error status,
  not a 202; a request the API resolves **without** starting a workflow — an
  ineligible stage or a pure stage reset — answers **200 OK**, not 202.
- **Sync-mode methods block for their result** and answer **200 OK** with the
  payload inline. Only `analyze_job` and `cancel_run` are synchronous.

So a green "Run stage" click that returns 202 means "queued and running", not
"done". This is why the UI reconciles later through projections and SSE.

### End-to-End Call Path

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Web as Web UI
    participant Api as TypeScript API (Fastify)
    participant Rpc as jobhunter rpc (JSON-RPC)
    participant T as Temporal
    participant WF as Workflow (worker)
    participant DB as SQLite
    participant SSE as SSE poller (250ms)

    User->>Web: Run stage (discover / apply)
    Web->>Api: POST /v1/pipeline/actions/run-stage
    Api->>Rpc: run_stage(stages, limit, workers)
    Rpc->>T: start workflow (spec + deterministic id)
    T-->>Rpc: {runId, workflowId}
    Rpc-->>Api: accepted
    Api-->>Web: 202 Accepted (runId, workflowId)
    Note over WF,DB: work runs asynchronously on the worker
    WF->>DB: WorkflowStarted, business activities, terminal Workflow*
    DB-->>SSE: new job_events rows
    SSE-->>Web: invalidate TanStack Query caches, UI updates
```

## Workflow Catalog

Six workflows are registered in
`workers/automation/src/jobhunter/infrastructure/temporal/registry.py`
(`WORKFLOWS`). All timeouts and retry policies below are set at the workflow's
activity call sites.

| Workflow | Business activities | Key timeouts | Retry |
| --- | --- | --- | --- |
| `DiscoverWorkflow` | `plan_discovery_sources`, `discovery_source_family` (per family), `discovery_enrichment`, `discovery_preparation_fanout` | source/enrichment 6 h; plan/fanout 30 min; heartbeat 2 min | source & enrich: 5 s→60 s ×3 |
| `JobPipelineWorkflow` | serial stage dispatch; `discover`→child `DiscoverWorkflow`, `enrich`/`score`/`tailor`/`cover`→activities, `apply`→child `ApplyWorkflow` | stage activities 30 min; heartbeat 2 min | enrich/score 5 s→60 s ×3; tailor/cover 10 s→120 s ×3 |
| `JobPreparationWorkflow` | `score_job`, `tailor_job`, `cover_letter`, `render_pdf` in fixed order | each 30 min; heartbeat 2 min | score ×3; tailor ×3; cover/pdf ×3 |
| `ApplyWorkflow` | `apply_activity` | 2 h batch / 1 h continuous batch; heartbeat 60 s | live: 1 attempt; dry-run: 2 attempts |
| `ProfileImportWorkflow` | `profile_import_activity` | 10 min | 2 attempts |
| `CompensationRefreshWorkflow` | `refresh_compensation_activity` | 20 min | 2 attempts |

A few catalog details worth calling out:

- **`JobPipelineWorkflow` is the serial batch driver.** It runs the requested
  stages in canonical order as activities, but hands `discover` and `apply` to
  child workflows so a mixed request like `score → tailor → apply` still
  preserves order while every unit runs under Temporal. After a batch `tailor`
  succeeds it derives the approved job URLs and scopes the following `cover`
  stage to exactly those jobs.
- **`JobPreparationWorkflow` reorders and validates steps.** Requested steps are
  intersected with the canonical order `("score","tailor","cover","pdf")`; an
  unknown step is a non-retryable error. Only `score`/`tailor`/`cover` trigger
  the spend preflight (`pdf` is deterministic rendering).
- **`ApplyWorkflow` continuous mode uses `continue_as_new`.** In continuous mode
  each iteration runs the launcher with an activity limit of 25; when a batch
  applies to zero jobs it sleeps 30 s before continuing-as-new, giving a
  run-forever poller with bounded history.

## Source Files

Primary implementation files (repo-relative):

- `apps/api/src/server.ts` — `/v1/pipeline/actions/run-stage`, the bulk job
  routes, and `GET /v1/events/stream`.
- `apps/api/src/local-actions.ts` — maps UI commands to JSON-RPC methods.
- `apps/api/src/json-rpc-adapter.ts` — long-lived subprocess JSON-RPC adapter.
- `apps/api/src/projections.ts` — TS projection builder (`refreshProjections`).
- `packages/domain-types/src/events/` — the 68-type `DomainEventType` union.
- `workers/automation/src/jobhunter/infrastructure/rpc/handlers.py` — JSON-RPC
  method registry (workflow vs sync modes).
- `workers/automation/src/jobhunter/workflow_specs.py` — `run_stage` / `apply`
  workflow selection and deterministic IDs.
- `workers/automation/src/jobhunter/infrastructure/temporal/registry.py` — the
  six workflows and nineteen activities.
- `workers/automation/src/jobhunter/infrastructure/temporal/finalize.py` — the
  workflow envelope (`record_workflow_started` / `record_workflow_outcome`).
- `workers/automation/src/jobhunter/infrastructure/temporal/run_in_activity.py`
  — `run_blocking_with_heartbeat`.
- `workers/automation/src/jobhunter/infrastructure/temporal/runtime_guard.py` —
  `assert_activity_runtime`.
- `workers/automation/src/jobhunter/discovery/workflow.py`,
  `.../discovery/activities.py` — `DiscoverWorkflow` and its four activities.
- `workers/automation/src/jobhunter/pipeline/workflow.py` — `JobPipelineWorkflow`.
- `workers/automation/src/jobhunter/pipeline/preparation.py` — target derivation
  and root preparation fan-out.
- `workers/automation/src/jobhunter/preparation/workflow.py` —
  `JobPreparationWorkflow`.
- `workers/automation/src/jobhunter/apply/workflow.py`,
  `.../apply/activities.py`, `.../apply/launcher.py` — apply workflow, activity,
  and browser/agent launcher (safety invariants).
- `workers/automation/src/jobhunter/scoring/` and `.../domain/scoring/` — scoring
  runner, employer-analysis ensemble, BM25 retrieval, `chat_json` scoring.
- `workers/automation/src/jobhunter/llm.py` — httpx `LLMClient`,
  `check_spend_budget`, and the `llm_spend` ledger.
- `workers/automation/src/jobhunter/domain/errors.py` — the error taxonomy.
- `workers/automation/src/jobhunter/cli.py` — `worker`, `rpc`, the worker
  heartbeat/reconciler loop, and `_reconcile_discovery_schedule`.
- `workers/automation/src/jobhunter/infrastructure/projections/` — Python
  projection builders.
