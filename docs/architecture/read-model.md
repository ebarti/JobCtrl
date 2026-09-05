# Apply Feedback & Projections

Domain writes become durable events and canonical rows; projection builders turn
them into stable reads for the API and web app. Apply decisions and outcomes use
the same pattern, with extra safeguards around approval, submission, and private
feedback.

**Read this if** you are changing Apply Review, outcomes, analytics, contacts,
outreach, or any projection-backed list/detail view.

## At A Glance

```mermaid
flowchart LR
    WRITE@{ icon: "tabler:pencil", form: "rounded", label: "Workflow or<br/>API write", h: 64 }
    CANON@{ shape: "cyl", label: "Canonical rows<br/>+ job_events" }
    PROJECT@{ icon: "tabler:refresh", form: "rounded", label: "Python or TypeScript<br/>projection builder", h: 64 }
    READ@{ shape: "cyl", label: "Projection<br/>tables" }
    API@{ icon: "tabler:api", form: "rounded", label: "TypeScript API", h: 64 }
    SSE@{ icon: "tabler:bell", form: "rounded", label: "SSE<br/>invalidation", h: 64 }
    CACHE@{ icon: "tabler:stack-2", form: "rounded", label: "TanStack Query<br/>cache", h: 64 }
    VIEW@{ icon: "tabler:browser", form: "rounded", label: "Web views", h: 64 }

    WRITE -->|commit| CANON
    CANON -->|source data| PROJECT
    PROJECT -->|materializes| READ
    READ -->|read DTOs| API
    CANON -->|domain event| SSE
    SSE -->|invalidate or patch| CACHE
    API -->|fetched data| CACHE
    CACHE -->|renders| VIEW
```

The read path never reconstructs domain state from raw events during a request.
It reads precomputed projections; SSE only tells the client which projection to
refetch or safely patch.

## Apply Review And Outcome Feedback

```mermaid
flowchart LR
    REVIEW@{ icon: "tabler:user-check", form: "rounded", label: "Apply Review<br/>decision", h: 64 }
    CLAIM@{ icon: "tabler:lock", form: "rounded", label: "Atomic<br/>apply claim", h: 64 }
    INTENT@{ icon: "tabler:clipboard-list", form: "rounded", label: "Submit-intent<br/>checkpoint", h: 64 }
    SUBMIT@{ icon: "tabler:send", form: "rounded", label: "Owned email<br/>submission", h: 64 }
    OUTCOME@{ shape: "docs", label: "Reviewed<br/>outcome" }
    GMAIL@{ icon: "tabler:brand-gmail", form: "rounded", label: "Bounded Gmail<br/>evidence", h: 64 }
    SUGGEST@{ icon: "tabler:message", form: "rounded", label: "Outcome<br/>suggestion", h: 64 }

    REVIEW -->|approved| CLAIM
    CLAIM -->|exact-approved email| INTENT
    INTENT -->|records immediately before send| SUBMIT
    SUBMIT -->|terminal evidence| OUTCOME
    GMAIL -->|bounded evidence| SUGGEST
    SUGGEST -->|user accepts or corrects| OUTCOME
```

### Approval And At-Most-Once Submission

With `applyApprovalRequired` enabled (the default), the Python launcher checks
the latest `approve_submit` decision inside the atomic claim transaction. A UI,
API, or RPC caller cannot bypass that committed decision. Dry-run claims do not
need approval because browser-layer guards block submission.

Model-driven browser runs are transport-locked and final browser submit remains
manual. For an exact-approved email candidate, the saga rechecks the active
capability and records `ApplySubmitIntended` immediately before invoking the
owned Gmail sender. If the run dies after that checkpoint without a terminal
result, or the provider raises with an ambiguous outcome, JobCtrl parks it in
`needs_verification` instead of retrying. A run that never reached submit intent
can return safely to `pending`.

::: warning Live submission is an explicit trust boundary
Turning off `applyApprovalRequired` removes the claim-time review gate, but it
does not grant browser-submit authority or bypass the owned email sender's exact
recipient/attachment approval. The Preferences UI keeps that state visibly
warned.
:::

### Resume Review Drafts

Apply Review edits are a feedback layer, not in-place mutations of an accepted
Materials generation. The API stores revisions, line deltas, comment threads,
replies, and feedback signals in `resume_review_*` and
`tailoring_feedback_signals` tables.

Promotion follows three steps:

1. validate and render the saved draft;
2. write a new `job_materials` generation with replacement HTML/PDF artifacts
   and layout boxes;
3. mark unresolved comments as residual after acceptance.

The previous accepted artifact stays visible until step 2 succeeds. A failed
validation or render therefore cannot destroy reviewable materials.

### Outcomes And Gmail Suggestions

`application_outcomes` stores reviewed manual or suggestion-derived outcomes.
Interview reflections may link to the prep generation they followed. Notes stay
in that local table; events carry presence flags and safe references, not note
text.

The Gmail feedback scanner searches bounded post-application windows using
known application anchors. It reads a body only after metadata reaches the
link-confidence threshold, then stores evidence locally and proposes a
classification. The user accepts, corrects, or declines the suggestion.

Raw mail bodies never enter events, broad projections, logs, telemetry, or the
scan API response.

## Projection Catalog

| Projection | Main read responsibility |
| --- | --- |
| `job_list_projections` | One compact row per job: stage, score, materials, apply state, template, and policy metadata. |
| `job_detail_projections` | Description, stage timeline, employer/requirement audit, compensation, accepted interview prep, and curated history. |
| `dashboard_projections` | Counts, funnel, source/score distribution, and outcome-conversion counts. |
| `artifact_list_projections` | Registered artifacts and their tailoring explanation. |
| `evidence_usage_projections` | Profile evidence inverted into resume, requirement, and coverage usage/gaps. |
| `apply_run_projections` | Apply-run context and event timeline. |
| `workflow_run_projections` | Status, input summary, failure cause, and lifecycle timeline for every Temporal workflow type. |
| `pipeline_step_projections` | Attempt-aware execution-owned source planning/family, reconciliation, fan-out, backlog-sweep, and PDF lifecycle. |
| `source_quality_stats` | Rolling source-health facts used by discovery and the dashboard. |
| `contact_projections` | Contact references, counts, and provenance metadata—never attribute values. |
| `contact_research_task_projections` | Research status, counts, source outcomes, and candidate provenance/kinds—never candidate values. |
| `outreach_thread_projections` | Draft lifecycle, generation, status, and persisted gate outcome—never draft bodies. |
| `due_follow_up_projections` | Scheduled follow-up references and due time; `isDue` is derived at read time. |
| `operational_attempt_metrics` | Append-only attempt outcomes, failure class, retryability, counts, and duration. |

## Cross-Runtime Consistency

Python's `ProjectionBuilder` and TypeScript's `refreshProjections` consume their
tenant's `job_events` using independent `operations_projections:python:<tenant>`
and `operations_projections:typescript:<tenant>` cursors in `event_watermarks`.
Each reads canonical state, rebuilds projections, and advances its cursor in
one transaction. SQLite serializes standalone passes from the initial snapshot
read; nested passes preserve the caller's transaction. The
[consistency contract](data-events-and-projections.md#projection-ownership-and-consistency)
owns replay and failure recovery.

Both runtimes emit the same JSON shapes. Shared parity fixtures guard the
dual-written job, contact, research, outreach, follow-up, compensation, and
audit projections. That makes a one-sided column or shape change a test failure
instead of a client surprise.

With both development toolchains installed, the disposable mixed-runtime
fixture exercises the real builders in both orders, recovers existing open
run rows whose terminal events are behind the legacy cursor, and verifies
repeated refreshes:

```bash
uv --project workers/automation run --no-sync --locked python \
  workers/automation/tests/projection_cross_runtime_fixture.py
```

The ordinary per-language suites cover tenant isolation and transaction
rollback without requiring the other runtime's installed dependencies.

## Pipeline Operations Read Model

`GET /v1/pipeline/operations` composes durable read state with current runtime
telemetry; it is not one more aggregate projection table. The durable half is:

1. `workflow_run_projections` selects the newest Discover execution that is
   active/draining, otherwise the latest terminal execution;
2. `discovery_execution_jobs` supplies exact `(workflow ID, Temporal run ID)`
   membership in `observed_this_run` and `existing_backlog`;
3. `pipeline_step_projections` supplies attempt-aware execution-owned
   orchestration lifecycle;
4. `job_stage_states` supplies canonical per-job enrich/score/tailor/cover
   lifecycle.

The request-time half derives the expected app directory from the configured
database path, filters `worker_runtime_heartbeats` to that resolved
database/app-dir identity, selects the task queue named by the newest matching
heartbeat, and aggregates fresh schema-valid workers from that queue. It then
selects the freshest typed task-queue observation, resolves the bounded safe
active inventory, and computes the conservative ETA. This overlay is why the
endpoint is a **current snapshot**, not a historical run reconstruction. No API
claim is made about what capacity or queue pressure existed at an earlier
timestamp.

The read model keeps three scopes explicit: current execution, that execution's
pre-existing-backlog sweep, and global work outside both cohorts. Source-family
progress and reconciliation are separate summaries rather than a shared
denominator. Per-job stage counts use domain-job units; task-queue backlog uses
approximate infrastructure units and is never relabeled as jobs.

Projection failure and telemetry uncertainty degrade independently. Durable
step rows can be rebuilt from `job_events`; stale, invalid, unsupported, or
unavailable runtime observations remain typed states. The ETA union likewise
returns `calibrating`, `paused`, `stale`, or `unavailable` instead of fabricating
a number when samples, worker freshness, or contention is unknown. Open
membership gates the overall ETA only; scoped per-stage and source-family
estimates can use already-known backlog.

## Sensitive Projection Families

### Contacts, Research, And Outreach

Events and broad projections carry IDs, controlled kinds, counts, timestamps,
and provenance metadata. Contact names, emails, notes, candidate values, fetched
page bodies, draft bodies, gate internals, and claim provenance stay in their
canonical tables and are joined only for authorized detail reads.

Research outcomes such as `robots_disallowed`, `rate_limited`, and
`budget_exhausted` are first-class provenance. A proposed candidate becomes a
contact only after confirmation. Outreach has no send transport: an approved
draft can be copied/exported, and a later send log is an explicit user
attestation.

Follow-up projections contain reminders only. `GET
/v1/outreach/follow-ups/due` computes `isDue` from the stored due time and the
clock; it never sends or acts.

### Evidence, Analytics, And Compensation

The evidence map derives from canonical profile evidence, requirement-fit,
bullet-provenance, and coverage rows. It creates no second generation pipeline
and uses conservative defaults for older databases missing optional metadata.

Outcome conversion stores integer counts. The API derives rates and medians at
read time using one minimum-sample threshold, so small groups keep counts but
return `null` rates/medians. Analytics remain read-only and cannot alter scoring,
ranking, thresholds, or apply eligibility.

Posted compensation and deterministic market estimates are persisted before
they are projected. Projection/API reads do not parse salary text or fetch a
provider. Events carry only the affected job/section/state markers; raw feeds,
credentials, private account state, and local paths stay out.

## User-Facing Audit History

Job detail assembles an allow-listed timeline from lifecycle events and
append-only review/outcome records. It is an audit explanation, not a debug log:
raw event payloads, debug messages, local paths, raw notes, email bodies, and
contact values are excluded.
