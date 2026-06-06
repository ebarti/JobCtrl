# Job Pipeline Architecture

This document explains how JobHunter's job pipeline executes today. It is the
deep-dive companion to [`architecture.md`](architecture.md): the top-level
architecture doc names the runtime boundaries, while this document follows each
pipeline phase through the UI, API, JSON-RPC worker boundary, Python stage
runner, persistence, events, and projections.

The canonical domain model remains [`ddd-target.md`](ddd-target.md). This file
documents the implemented local execution shape.

Use the first sections for the shared execution model. Each phase section then
uses the same shape: purpose and boundary, sequence diagram, component diagram,
data/events, and failure behavior. Component diagrams include concrete classes
where the code has them and module/use-case components where the implementation
is intentionally function-based.

## Pipeline Phases

The user-facing stage order is:

```text
discover -> apply
```

`Discover` is the single preparation stage. It finds jobs, enriches usable
postings, and then drains internal preparation work for scoring, tailoring, and
artifact suppression. `Apply` stays separate because it can submit applications
and has its own safety controls.

The persisted/internal stage vocabulary still includes the preparation
substatuses:

```text
discover -> enrich -> score -> tailor -> cover -> apply
```

Those names remain in stage rows, low-level contracts, CLI maintenance paths,
and diagnostics. Job list projections and the product UI map `enrich`, `score`,
`tailor`, and `cover` back to `Discover` while still exposing their detail in
job timelines and operational views.

Discovery preparation runs these internal steps:

1. Detail enrichment fetches full descriptions and application URLs.
2. `score_job` work items call the Scoring context with the current scoring
   policy.
3. Tailor eligibility is recomputed from persisted scores, hard blockers, the
   live fit-score threshold, and the current tailoring policy.
4. `suppress_tailored_artifacts` work items soft-hide active materials that no
   longer qualify; `tailor_resume` work items call Materials Generation for
   eligible jobs missing current-policy active artifacts.

`apply` is deliberately separate at workflow execution, not at pipeline action
dispatch. The Pipelines UI still sends `discover` and `apply` through
`POST /v1/pipeline/actions/run-stage`; the TS API dispatches JSON-RPC
`run_stage` and starts `JobPipelineWorkflow`. Non-apply stages enter the
synchronous `pipeline.runner` stage functions as Temporal activities. When the
selected stage is `apply`, `JobPipelineWorkflow` delegates to child
`ApplyWorkflow`, which reports lifecycle progress through apply-specific events
and projections. The dedicated JSON-RPC `apply` method is reserved for per-job
apply and retry actions.

## Execution Surfaces

There are five execution surfaces. They share the same Python stage
implementations where possible, but they differ in orchestration.

| Surface | Entry point | Execution model | Stages |
| --- | --- | --- | --- |
| Pipelines UI | `POST /v1/pipeline/actions/run-stage` | TS API sends `discover` or `apply` through JSON-RPC `run_stage`. `discover` starts one `JobPipelineWorkflow` and drains preparation subwork; `apply` stays on `JobPipelineWorkflow` and delegates to child `ApplyWorkflow`. | User-facing Discover and Apply |
| Jobs view pending pickup | `POST /v1/jobs/:jobKey/actions/run-stage` | Viewing Jobs can start one visible `pending` internal preparation substage (`enrich`, `score`, `tailor`, or `cover`) for the selected job without resetting stage state. The web page paces pickup to one unchanged list snapshot, and the API refreshes projections plus gates dispatch on observable stage eligibility before starting a job-scoped `JobPipelineWorkflow`. | Internal preparation pickup |
| CLI batch run | `jobhunter run ...` | Python `run_pipeline()` executes selected stages sequentially or streaming. `jobhunter discover` / `jobhunter run discover` is the normal preparation path; low-level `score`, `tailor`, and `cover` remain maintenance/diagnostic commands. | Discover plus internal maintenance stages |
| Temporal pipeline workflow | `JobPipelineWorkflow` | Serial workflow that dispatches selected non-apply stages as Temporal activities and delegates `apply` to child `ApplyWorkflow`. A Discover activity owns enrichment plus preparation queue drain. | Discover and Apply |
| Temporal apply workflow | `ApplyWorkflow` | Per-job apply workflow with one activity and apply-specific retry policy. | Apply |

### End-To-End UI/API Call Path

```mermaid
sequenceDiagram
    autonumber
    participant User
    participant Web as Web UI<br/>Pipelines tab
    participant Api as TS API<br/>server.ts
    participant Dispatcher as defaultActionDispatcher
    participant JsonRpc as SubprocessJsonRpcAdapter
    participant Rpc as jobhunter rpc<br/>JsonRpcServer
    participant Temporal as Temporal
    participant Activity as Stage activity
    participant Runner as pipeline.runner
    participant Prep as preparation_work_items
    participant Scoring as Scoring context
    participant Materials as Materials context
    participant DB as SQLite
    participant SSE as SSE / projections

    User->>Web: Click Run stage
    Web->>Api: POST /v1/pipeline/actions/run-stage
    Api->>Dispatcher: Build ActionCommandPayload per stage

    Dispatcher->>JsonRpc: call("run_stage", ordered stages)
    JsonRpc->>Rpc: JSON-RPC line over stdin/stdout
    Rpc->>Temporal: start JobPipelineWorkflow(stages)
    Temporal-->>Rpc: workflow handle
    Rpc-->>JsonRpc: {runId, workflowId}

    alt discover preparation
        Temporal->>Activity: execute discover activity
        Activity->>Runner: run_pipeline(stages=[stage])
        Runner->>DB: discovery/enrichment writes and events
        Runner->>Prep: enqueue and drain score/tailor/suppress work
        Prep->>Scoring: score_job with current policy
        Prep->>Materials: tailor_resume or suppress artifacts
        Scoring-->>DB: scores and score events
        Materials-->>DB: materials/suppression events
    else apply step
        Temporal->>Temporal: execute child ApplyWorkflow
        Temporal->>DB: ApplyRun* events while workflow runs
    end

    JsonRpc-->>Dispatcher: dispatch result

    Dispatcher-->>Api: action response
    Api-->>Web: 202 if workflow queued, 200 if start failed
    DB->>SSE: projections refresh / events stream
    SSE-->>Web: invalidate query cache and update UI
```

### Shared Components

```mermaid
classDiagram
    class StageTriggerPanel {
      +activeStage
      +stage options
      +submit run-stage request
    }
    class FastifyApi {
      +POST /v1/pipeline/actions/run-stage
      +build ActionCommandPayload
    }
    class DefaultActionDispatcher {
      +toJsonRpcCall()
      +map JSON-RPC response
    }
    class SubprocessJsonRpcAdapter {
      +spawn uv run jobhunter rpc
      +write JSON-RPC request
      +resolve pending response
    }
    class JsonRpcServer {
      +register sync handlers
      +register workflow handlers
      +dispatch request
    }
    class JobPipelineWorkflow {
      +run ordered stages
      +execute stage activities
      +delegate apply child workflow
    }
    class DiscoverActivity {
      +run_pipeline(stages=["discover"])
      +heartbeat while blocking
    }
    class PipelineRunner {
      +run_pipeline()
      +_run_stage_observed()
      +_run_discover()
      +drain_discovery_preparation()
      +_run_enrich()
      +_run_score()
      +_run_tailor()
      +_run_cover()
      +_run_pdf()
    }
    class ApplyWorkflow {
      +run ApplyActivity
    }
    class OperationsReadSide {
      +refreshProjections()
      +SSE invalidation
    }

    StageTriggerPanel --> FastifyApi
    FastifyApi --> DefaultActionDispatcher
    DefaultActionDispatcher --> SubprocessJsonRpcAdapter
    SubprocessJsonRpcAdapter --> JsonRpcServer
    JsonRpcServer --> JobPipelineWorkflow : run_stage
    JsonRpcServer --> ApplyWorkflow : per-job apply
    JobPipelineWorkflow --> DiscoverActivity : discover
    JobPipelineWorkflow --> ApplyWorkflow : apply child workflow
    DiscoverActivity --> PipelineRunner
    PipelineRunner --> OperationsReadSide : events
    ApplyWorkflow --> OperationsReadSide : events
```

## Shared Stage Mechanics

### Stage Observation

Non-apply stages run under `_run_stage_observed()` in
`workers/automation/src/jobhunter/pipeline/runner.py`. That wrapper:

- emits `StageStarted`, `StageCompleted`, or `StageFailed` lifecycle rows to
  `job_events`;
- emits OpenTelemetry/Langfuse spans named `pipeline.stage.<stage>`;
- converts runner results into a stage status (`ok`, `partial`, or `error`);
- keeps the JSON-RPC caller informed even when downstream projections refresh
  later.

Discover source steps use `_run_discovery_source()`, a source-level variant that
also emits `DiscoveryRunStarted`, `DiscoveryRunCompleted`, and
`DiscoveryRunFailed` rows for source-quality aggregation. Long-running sources
own durable progress through the same discovery-run aggregate. For example,
JobSpy reports completed search combinations, current query/location, observed
raw rows, accepted new rows, duplicates, filtered rows, and source errors while
the crawl is still running. The dashboard progress read model renders that
source-level detail instead of only showing the coarse stage count.

Discover has a no-overlap Temporal policy. The source stage is allowed to run
longer than the default 30-minute activity window, and the workflow does not
retry the whole Discover activity after timeout/cancellation. Source adapters
are responsible for idempotency, source-quality retry, progress, and
cooperative cancellation. This prevents a still-running external crawl from
being duplicated by an automatic activity retry.

When a user stops a running Discover workflow, the API emits a failed progress
event and terminalizes the matching `discovery_runs` row so the UI, audit log,
and source-quality projections agree that the source is no longer active.
Worker startup recovery applies the same terminal state to stale source runs
left running by a prior worker process.

### Dry Run

For non-apply stages, `dryRun=true` is passed through the workflow activity into
`run_pipeline()`. The runner returns planned stage metadata and records dry-run
operational attempts before executing any stage implementation.

For apply, `dryRun` is passed into `ApplyWorkflowInput` and down to the apply
launcher. The workflow still starts, but the launcher follows the dry-run path
instead of submitting applications.

### Limit

`limit` is forwarded to every stage. The meaning is stage-specific:

- Discover: global cap for observed jobs across scheduled sources. When set,
  Discover runs sources sequentially and skips remaining sources once the cap is
  consumed; the same value is also used by the internal detail-enrichment queue
  drain and the internal preparation work-item drains.
- Score: internal/maintenance cap for jobs selected for scoring after retrieval
  preselection.
- Tailor: internal/maintenance cap for eligible high-fit jobs to tailor.
- Cover: internal/maintenance cap for eligible jobs needing cover letters.
- PDF: cap for pending PDF render jobs.
- Apply: cap for apply attempts unless `continuous=true`, in which case the
  apply launcher runs continuously.

### Sequential And Streaming

`run_pipeline()` has two Python execution modes:

- Sequential: stages run one at a time in canonical stage order.
- Streaming: each selected stage runs in its own thread. Downstream stages poll
  for pending work and finish only when their upstream producers are done and
  they have no remaining work.

The UI `run-stage` endpoint preserves request order by starting one
`JobPipelineWorkflow` for the selected stage list. The product stage trigger
normally sends only `discover` or `apply`. Non-apply stages run serially as
Temporal activities; each activity still enters the Python runner as a
single-stage `run_pipeline(stages=[stage])` invocation. `apply` remains the
dedicated `ApplyWorkflow`, executed as a child workflow when it appears in the
ordered pipeline list.

## Phase 1: Discover

### Purpose And Boundary

Discover finds postings from configured sources and creates canonical job
records plus source observations. It owns source scheduling, source-quality
feedback, canonical identity, idempotent source-control refresh, manual-capture
queue entries for protected sources, dedupe against existing jobs, and the
detail-enrichment queue drain for jobs that pass the initial title/location
filter. After enrichment, it orchestrates durable preparation work; Scoring and
Materials still own the score and artifact writes.

### Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Api as TS API
    participant Rpc as JSON-RPC run_stage
    participant Workflow as JobPipelineWorkflow
    participant Activity as discover_activity
    participant Runner as _run_discover
    participant QueryPlanner as Target query planner
    participant Scheduler as DiscoveryScheduler
    participant JobSpy
    participant ATS as Canonical ATS APIs
    participant Workday
    participant Smart as Smart Extract
    participant Detail as Detail enrichment queue
    participant Prep as Preparation queue
    participant Scoring as Scoring context
    participant Materials as Materials context
    participant DB as SQLite
    participant Ops as Operations projections

    Api->>Rpc: run_stage(stage="discover", limit, workers)
    Rpc->>Workflow: start JobPipelineWorkflow(stages=["discover"])
    Workflow->>Activity: execute discover_activity(payload)
    Activity->>Runner: run_pipeline(stages=["discover"])
    Runner->>DB: init_db
    Runner->>DB: refresh source-control rows idempotently
    Runner->>QueryPlanner: compile profile target roles and locations
    QueryPlanner-->>Runner: exact queries plus recall query filters
    Runner->>Scheduler: plan(registry, source quality, global limit)
    Scheduler-->>Runner: DiscoverySchedule

    Runner->>JobSpy: run_discovery(cfg with exact plus recall queries)
    JobSpy->>DB: insert jobs, broad-board observations, learned source candidates
    Runner->>ATS: enumerate scheduled canonical sources and filter internally
    ATS->>DB: create canonical jobs and source observations
    Runner->>Workday: enumerate configured employers and filter internally
    Workday->>DB: insert/update jobs and observations
    Runner->>Smart: source-first scrape or search-only query fanout
    Smart->>DB: insert jobs, quarantine, manual-capture queue
    Runner->>Detail: run_enrichment(limit, workers)
    Detail->>DB: persist full descriptions, apply URLs, attempts/errors
    Runner->>Prep: enqueue score_job for enriched pending scores
    Prep->>Scoring: score_job current scoring policy
    Scoring->>DB: persist JobScore and score events
    Runner->>Prep: recompute TailorEligibility
    Prep->>Materials: tailor_resume or suppress_tailored_artifacts

    Runner->>DB: DiscoveryRun*, Stage*, and operational attempt metrics
    DB->>Ops: source-quality and dashboard projections refresh
    Ops-->>Api: API reads show new jobs/source health
```

### Components

```mermaid
classDiagram
    class RunDiscover {
      +_run_discover(workers, limit)
      +source_results
      +bounded_workers
    }
    class DiscoveryScheduler {
      +plan(registry, quality, global_limit)
    }
    class TargetQueryPlanner {
      +build_target_role_queries(roles)
      +query_applies_to_source(query, source)
      +title_matches_any_query(title, queries)
    }
    class DiscoverySchedule {
      +for_prefix(prefix)
      +for_kinds(kind)
      +budget_for_prefix(prefix)
    }
    class SourceRegistryEntry {
      +source_id
      +kind
      +priority
      +state
      +adapter_config
    }
    class JobSpyAdapter {
      +run_discovery(cfg, limit, run_id)
    }
    class AtsApiScheduler {
      +run_scheduled_ats_sources()
    }
    class WorkdayAdapter {
      +run_workday_discovery()
    }
    class SmartExtractAdapter {
      +run_smart_extract()
    }
    class DiscoveryRunRepository {
      +record started/completed/failed
    }

    RunDiscover --> DiscoveryScheduler
    RunDiscover --> TargetQueryPlanner
    DiscoveryScheduler --> DiscoverySchedule
    DiscoverySchedule --> SourceRegistryEntry
    RunDiscover --> JobSpyAdapter
    RunDiscover --> AtsApiScheduler
    RunDiscover --> WorkdayAdapter
    RunDiscover --> SmartExtractAdapter
    RunDiscover --> DiscoveryRunRepository
```

### Data And Events

- Reads source registry data from packaged YAML plus local
  `source_registry_entries`.
- Reads source-quality snapshots to schedule and budget sources.
- Reads board/runtime discovery settings from SQLite `discovery_settings`, then
  overlays target search from `candidate_profiles`. Target roles remain exact
  role guidance. Target tracks, seniority floors, role areas, and
  specializations add structured intent for deterministic recall expansion.
  Discovery settings store normalized track values (`ic`, `management`,
  `executive`) and normalized engineering seniority-floor values before the
  worker expands them. Resume import may suggest those structured fields, but
  existing user-entered profile values win.
- Compiles target roles into two query kinds:
  - exact queries, copied from the saved profile role text after note stripping;
  - recall queries, generated from the same target-role intent and marked with
    `match_mode=recall`, `generated_from=target_roles`, `target_track`, and
    `seniority_floor`.
- Recall query matching is a retrieval guard, not a relevance score. It enforces
  target track and seniority before scoring: IC targets stay IC, management
  targets stay management, executive targets stay executive, and candidates who
  configure multiple tracks get per-track recall.
- Applies exact-plus-recall intent to every discovery source family, but the
  execution shape differs by source type. JobSpy is a broad-board retrieval
  provider, so exact and recall queries are sent as external search probes.
  Direct ATS, Workday, and source-first Smart Extract sources are known
  boards/employers/pages, so they enumerate the source once per location and run
  normalized query/location acceptance through the shared discovery intake
  before any job row or delete tombstone is persisted.
  exact-plus-recall title matching internally instead of multiplying
  `queries x sources`. Smart Extract search-only sources still fan out by query
  when the source has no useful browse/all-jobs page.
- Canonical ATS adapters only emit usable postings: title, target location,
  and a non-empty description must all be present before a posting reaches the
  discovery write boundary. Greenhouse uses the public board API's content
  payload so discovered rows are not created with blank descriptions.
- Runs posting staleness and source hygiene checks before source execution:
  verified unavailable, expired, removed, or location-incompatible postings move
  to the closed lifecycle state, while active rows from JobSpy, direct ATS,
  Workday, and Smart Extract are rechecked against the current title, location,
  and description contract and soft-deleted when they no longer pass.
- Upserts source registry control rows, source locator candidates, and
  manual-capture queue entries for protected/manual sources. Existing
  `imported` or `dismissed` manual-capture entries keep their status.
- Writes `jobs`, source observations, canonical identity rows, source-learning
  registry updates, review queue entries, quarantine entries, discovery run
  rows, `job_events`, and source-level operational attempt metrics.
- Emits stage events and source-level discovery events.
- Enqueues and drains `PreparationWorkItemQueued`,
  `PreparationWorkItemStarted`, `PreparationWorkItemCompleted`, and
  `PreparationWorkItemFailed` events for internal scoring, tailoring, and
  suppression work after enrichment.
- Treats JobSpy result URLs as broad-board observations and JobSpy direct URLs
  as owner-source evidence. Runnable ATS direct URLs are promoted into
  `source_registry_entries`; ambiguous direct URLs and ATS URLs that still need
  adapter configuration are surfaced through source locator/manual-capture
  review instead of being ignored.
- Classifies JobSpy board observations as `source_role=lead_generator` and
  root employer/ATS/API sources as `source_role=canonical_source`, so board
  discovery metrics do not collapse into canonical employer source health.

### Failure And Limits

Each source family is isolated. A failed JobSpy, ATS, Workday, or Smart Extract
step records failure information and lets the caller see a partial source
result. With `limit > 0`, the stage uses sequential source execution and skips
remaining source families once the new-job cap is consumed. All discovery source
families treat the cap as a new-job budget: existing rediscoveries record
observations but do not consume the remaining budget, so exact-query duplicates
do not prevent later recall queries or sources from running. If internal
preparation work fails after enrichment, the durable work item remains failed or
retryable and the Discover result reports partial preparation status without
collapsing the owning Scoring or Materials failure into Discovery state.

## Internal Discovery Subphase: Detail Enrichment

### Purpose And Boundary

Detail enrichment turns discovered jobs into usable job records by fetching
full descriptions, application URLs, and detail-page metadata. It owns
detail-page fetching and extraction. It is not a top-level user-run pipeline
stage; Discovery starts the queue drain and passes the same `workers` value to
the enrichment runner. It does not score fit or generate materials.

### Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Runner as _run_discover
    participant Detail as run_enrichment
    participant Fetcher as Detail fetchers
    participant Extractor as JSON-LD/CSS/LLM extraction
    participant DB as SQLite
    participant Ops as Operations projections

    Runner->>DB: discovery sources insert pending JobEnrichment rows
    Runner->>Detail: run_enrichment(limit, workers)
    Detail->>DB: select pending discovered jobs
    Detail->>Fetcher: fetch posting detail pages
    Fetcher-->>Extractor: raw HTML / page content
    Extractor->>DB: persist full description, apply URL, attempts/errors
    Detail->>Fetcher: for LinkedIn misses, retry with authenticated Chrome
    Fetcher-->>DB: persist external company apply URL when captured
    Runner->>DB: enrich stage/job events for retry visibility
    DB->>Ops: job detail/list projections refresh
```

### Components

```mermaid
classDiagram
    class RunDiscover {
      +_run_discover(workers, limit)
      +internal enrichment worker
    }
    class EnrichmentRunner {
      +run_enrichment(limit, workers)
    }
    class DetailPageFetcherPort {
      +fetch(url)
    }
    class LlmPort {
      +complete(prompt, schema)
    }
    class JobEnrichment {
      +description
      +application_url
      +attempts
    }
    class EnrichmentRepository {
      +save(enrichment)
    }

    RunDiscover --> EnrichmentRunner
    EnrichmentRunner --> DetailPageFetcherPort
    EnrichmentRunner --> LlmPort
    EnrichmentRunner --> JobEnrichment
    EnrichmentRunner --> EnrichmentRepository
```

### Data And Events

- Reads pending jobs from SQLite selectors.
- Writes enriched description/application fields and canonical enrichment rows
  where available.
- Retries LinkedIn rows that are failed or enriched without an application URL
  with a bounded authenticated Chrome pass. The pass may click the LinkedIn
  apply control to capture an external company URL, but it stops before forms
  or submission.
- Records detail scrape timestamps and errors for retry/debug visibility.
- Records enrich job/stage events for retry/debug visibility without exposing
  Enrich as a top-level pipeline action.
- Updates job list/detail projections so the UI can show richer job content.

### Failure And Limits

`limit` caps pending detail jobs. `workers` controls concurrent detail work.
Individual detail failures are recorded on the job so later runs can retry or
surface the error without crashing unrelated jobs.

## Internal Discovery Preparation Work

### Purpose And Boundary

Preparation work items are the durable bridge between the user-facing Discover
stage and the internal Scoring and Materials bounded contexts. The queue makes
post-enrichment work idempotent, restartable, and observable without letting
Discovery write scores or artifacts directly.

Work item kinds are:

- `score_job`: score one enriched job with the current scoring policy.
- `tailor_resume`: create current-policy tailored materials for an eligible
  job.
- `suppress_tailored_artifacts`: soft-hide active tailored artifacts when the
  job no longer satisfies the live threshold or hard-blocker eligibility.

### Event Flow

```mermaid
sequenceDiagram
    autonumber
    participant Discover as Discover runner
    participant Queue as preparation_work_items
    participant Scoring as Scoring context
    participant Materials as Materials Generation context
    participant Ops as Operations projections + SSE

    Discover->>Queue: enqueue score_job(target=scoring policy version)
    Queue-->>Ops: PreparationWorkItemQueued
    Queue->>Scoring: score_job_by_url(job, current policy)
    Scoring-->>Ops: JobScored
    Queue-->>Ops: PreparationWorkItemCompleted

    Discover->>Discover: recompute TailorEligibility from persisted scores
    alt eligible and no current active artifact
        Discover->>Queue: enqueue tailor_resume(target=tailoring policy version)
        Queue->>Materials: tailor_job_by_url(job, current policy)
        Materials-->>Ops: ResumeApproved / ResumeFailed
        opt resume approved
            Queue->>Materials: run_cover_letters(job)
            Materials-->>Ops: CoverLetterGenerated / CoverLetterFailed
        end
        Queue-->>Ops: PreparationWorkItemCompleted or Failed
    else ineligible with active artifacts
        Discover->>Queue: enqueue suppress_tailored_artifacts(target=threshold)
        Queue->>Materials: SuppressTailoredArtifactsUseCase
        Materials-->>Ops: TailoredArtifactsSuppressed
        Queue-->>Ops: PreparationWorkItemCompleted
    end
```

### Data And Events

- `preparation_work_items` keys work by tenant, job, kind, target version,
  source event, and idempotency key so reruns do not duplicate in-flight work.
- `target_version` is the scoring policy version for `score_job`, the tailoring
  policy version for `tailor_resume`, and the live fit-score threshold for
  `suppress_tailored_artifacts`.
- `source_event_id` ties each item to the latest discovery/enrichment/source
  fact that made the work necessary.
- Successful `tailor_resume` work immediately invokes the job-scoped cover
  stage. Cover failures are recorded on the cover stage for retry without
  forcing the tailored resume work item to regenerate the resume.
- Viewing the Jobs page is also a pickup signal: eligible visible rows whose
  current state is `pending` and whose current substage is `enrich`, `score`,
  `tailor`, or `cover` can dispatch a job-scoped run from that substage without
  resetting attempts or failure metadata. The API route is the safety boundary:
  known-ineligible rows return `not_eligible` and do not start worker activity.
- Work item lifecycle events are part of the SSE catalog, so Operations can
  invalidate dashboard, job detail, artifact, and activity projections while
  Discover is still running.
- Scoring policy changes do not silently rescore existing jobs. Current-version
  actions use `rescore_job` or
  `rescore_jobs_not_on_current_scoring_policy`.
- Tailoring policy changes do not silently regenerate existing artifacts.
  Current-version actions use `retailor_job` or `retailor_current_policy`.
- Threshold changes are live eligibility changes, not scoring policy changes:
  lowering the threshold can enqueue `tailor_resume` from persisted scores;
  raising it can enqueue `suppress_tailored_artifacts`. Neither path invokes
  the scoring LLM.

### Failure And Limits

Each work item is claimed, completed, failed, or retried independently. A
failed score does not block unrelated tailoring/suppression work for other jobs,
and a failed tailoring job can be retried without rediscovering the posting.
`limit` bounds each drain pass so local debug runs can stay small.

## Internal Preparation Context: Score

### Purpose And Boundary

Score assigns applicant-side fit scores and structured reasoning to enriched
jobs. It owns retrieval preselection, scoring criteria, LLM parsing, score
versioning, and user-corrected score history. It does not tailor materials.
In the product flow this is Discover subwork; explicit rescore actions are
maintenance controls.

### Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Api as TS API
    participant Rpc as JSON-RPC current-policy action
    participant Prep as Preparation queue
    participant Runner as _run_score
    participant Scorer as run_scoring
    participant Retrieval as Hybrid retrieval
    participant Profile as Profile repository
    participant LLM as LLMClient
    participant Repo as Scoring repository
    participant DB as SQLite
    participant Ops as Operations projections

    Api->>Rpc: rescore_job or rescore_jobs_not_on_current_scoring_policy
    Prep->>Runner: score_job work item during Discover
    Rpc->>Runner: run_pipeline(stages=["score"]) for low-level maintenance
    Runner->>Scorer: run_scoring(limit, rescore, workers)
    Scorer->>DB: select enriched jobs needing score
    Scorer->>Retrieval: rank candidate pool
    Scorer->>Profile: load current profile snapshot
    Scorer->>LLM: score selected jobs against profile/criteria
    LLM-->>Scorer: structured fit score and reasoning
    Scorer->>Repo: save JobScore version
    Repo->>DB: job_scores + events
    Runner->>DB: StageCompleted or StageFailed
    DB->>Ops: score fields in projections refresh
```

### Components

```mermaid
classDiagram
    class RunScore {
      +_run_score(limit, rescore, workers)
    }
    class ScoringRunner {
      +run_scoring(limit, rescore, workers)
    }
    class HybridRetrievalService {
      +rank_jobs(profile, jobs)
    }
    class ScoreJobUseCase {
      +execute(job, profile, criteria)
    }
    class LLMClient {
      +chat(messages, schema)
    }
    class JobScore {
      +fit_score
      +fit_band
      +criteria_json
      +trace_json
    }
    class ScoringRepository {
      +save(JobScore)
      +load latest
    }

    RunScore --> ScoringRunner
    ScoringRunner --> HybridRetrievalService
    ScoringRunner --> ScoreJobUseCase
    ScoreJobUseCase --> LLMClient
    ScoreJobUseCase --> JobScore
    ScoreJobUseCase --> ScoringRepository
```

### Data And Events

- Reads enriched job content and profile target preferences.
- Writes versioned `job_scores` rows with criteria and trace metadata.
- Writes versioned `scoring_policies` rows when user corrections create
  correction-derived calibration anchors; current behavior preserves rubric
  weights and thresholds while making later score traces cite the new policy
  version and anchor IDs.
- Marks comparable latest uncorrected scores stale in `job_score_staleness`
  when a correction creates a newer scoring policy version. Corrected score
  versions are excluded. Successful uncorrected rescores under the newer policy
  resolve the stale marker; the local API can also reset active stale markers
  for explicit `jobhunter run score --rescore` processing.
- Supports a local, non-sensitive scoring governance report for QA. The report
  summarizes current policy version, rubric version, anchor count, unresolved
  and resolved stale-marker counts, correction count, and correction agreement
  signal without emitting raw job URLs, correction rationales, anchor IDs,
  resumes, generated artifacts, or local paths.
- Updates legacy-compatible score fields where needed by queue selectors.
- Publishes score events consumed by Pipeline and Operations.
- Refreshes dashboard score distributions and job list score badges.

### Failure And Limits

`limit` applies after retrieval preselection. `rescore=true` allows jobs with
existing scores back into the candidate pool. Parser warnings and failed LLM
calls are recorded so score failures do not masquerade as successful low-fit
results. Scoring prompt, model, schema, rubric, or policy changes must run the
local scoring eval gate documented in `docs/local-reliability-qa.md`; the gate
checks deterministic policy resolution separately from the raw LLM score and
pins stale-score exclusion until explicit reset/rescore.

## Internal Preparation Context: Tailor

### Purpose And Boundary

Tailor creates job-specific resume materials for high-fit jobs. It owns resume
generation, validation mode, retry/retailor decisions, and resume artifact
registration. It does not submit applications. In the product flow this is
Discover subwork. First-time manual tailoring is exposed on the job detail
tailor stage for the selected job; explicit re-tailor actions remain
current-policy regeneration controls for jobs that already have tailored
artifacts.

### Weaknesses Addressed

The previous tailoring path could pass local validation while still producing a
resume that was not good enough to send. The important gaps were:

- One generator call owned both drafting and self-approval, so there was no
  independent quality gate.
- `approved_with_judge_warning` counted as stage success, which hid weak
  tailored resumes behind a green pipeline status.
- The JSON validator checked fields before rendering, but rendered text could
  still carry banned phrases, unsupported claims, or missing required evidence.
- Model routing rejected per-call model choices, so CLI/UI/API controls could
  not safely fan out across providers or run a separate judge.
- The job blob used the source board as company fallback, which could leak
  source names into generated materials.
- Artifact/report metadata did not identify the selected generator, judge
  result, prompt version, or schema version, making audit and retry decisions
  weak.

Tailoring now treats generation and judgment as separate steps: multiple
provider/model specs can draft candidates, validation runs per candidate, and a
structured judge must return `PASS` above the configured threshold before the
resume is approved. `lenient` mode remains available for local low-cost runs,
but normal and strict modes are quality-gated.

### Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Api as TS API
    participant Rpc as JSON-RPC current-policy action
    participant Prep as Preparation queue
    participant Runner as _run_tailor
    participant Tailor as run_tailoring
    participant Profile as Profile repository
    participant Scores as Scoring data
    participant LLM as LLMClient
    participant Materials as Materials repository
    participant Files as Local files
    participant DB as SQLite

    Api->>Rpc: tailor_job, retailor_job, or retailor_current_policy
    Prep->>Runner: tailor_resume work item during Discover
    Rpc->>Runner: run_pipeline(stages=["tailor", "cover"]) for job-scoped actions
    Runner->>Tailor: run_tailoring(...)
    Tailor->>DB: select scored jobs meeting minScore
    Tailor->>Profile: load resume baseline and tailoring rules
    Tailor->>Scores: load score context/reasoning
    Tailor->>LLM: generate structured candidates across configured generators
    LLM-->>Tailor: structured resume candidate JSON
    Tailor->>Tailor: validate each candidate independently
    Tailor->>LLM: structured judge scores valid candidates
    LLM-->>Tailor: verdict, score, criterion scores, issues
    Tailor->>Materials: save MaterialsSet / TailoredResume
    Tailor->>Files: write resume artifacts
    Tailor->>DB: stage/material events
```

### Components

```mermaid
classDiagram
    class RunTailor {
      +_run_tailor(min_score, limit, validation_mode, workers, retailor)
    }
    class TailoringRunner {
      +run_tailoring(...)
    }
    class ProfileRepository {
      +load default profile
    }
    class MaterialsSet {
      +TailoredResume
      +CoverLetter
      +RenderedPdf
    }
    class MaterialsRepository {
      +save(materials)
      +list pending PDF
    }
    class LLMClient {
      +chat(messages, schema)
    }
    class ArtifactStore {
      +tailored_resumes directory
    }

    RunTailor --> TailoringRunner
    TailoringRunner --> ProfileRepository
    TailoringRunner --> LLMClient
    TailoringRunner --> MaterialsSet
    TailoringRunner --> MaterialsRepository
    TailoringRunner --> ArtifactStore
```

### Data And Events

- Reads jobs with score >= `minScore`; a per-job `tailor_job` user action can
  override that floor only for the selected job and then continue into the
  job-scoped cover stage.
- Reads profile resume baseline, skills, writing style, and tailoring rules.
- Writes tailored resume records and local artifacts under the JobHunter app
  directory.
- Persists safe quality metadata with the artifact/report: selected generator,
  candidate summaries, judge model, judge score/verdict/issues, and
  prompt/schema versions. Provider URLs, API keys, and raw credential config
  are never stored.
- Emits material-generation events and pipeline lifecycle events.
- Updates artifact and job detail projections.

### Failure And Limits

`validationMode` controls strictness of generated-material validation.
`retailor=true` allows existing tailored materials to be regenerated. First-time
manual tailoring uses `retailor=false` and records an audit event before worker
dispatch so the user's intent is visible even if the worker later skips or fails.
`workers` controls parallel tailoring work. `tailorModels` can fan out candidate
generation across provider/model specs, and `tailorJudgeModel` selects the
structured judge independently from apply's browser-action model. By default,
validator-passing resumes still fail the tailor stage unless the structured
judge returns `PASS` above the configured score threshold; `lenient` mode skips
the judge for local low-cost runs. Failures are tracked per job/material so the
stage can be retried without losing successful materials.

## Internal Material Context: Cover

### Purpose And Boundary

Cover creates job-specific cover letters for jobs that already have sufficient
score/material context. It owns cover-letter text generation and persistence.
It also renders the cover-letter PDF, so the stage outputs the artifacts Apply
needs without relying on a later PDF-only phase. It is surfaced as Discover
diagnostic state in the product UI rather than a primary preparation stage.

### Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Api as TS API
    participant Rpc as JSON-RPC run_stage
    participant Runner as _run_cover
    participant Cover as run_cover_letters
    participant Profile as Profile repository
    participant Materials as Materials repository
    participant LLM as LLMClient
    participant Files as Local files
    participant DB as SQLite

    Api->>Rpc: run_stage(stage="cover", minScore, limit, validationMode)
    Rpc->>Runner: run_pipeline(stages=["cover"])
    Runner->>Cover: run_cover_letters(...)
    Cover->>DB: select eligible jobs/materials
    Cover->>Profile: load profile and writing style
    Cover->>Materials: load tailored resume/material context
    Cover->>LLM: generate cover letter
    Cover->>Materials: save CoverLetter
    Cover->>Files: write cover letter artifact
    Cover->>Files: render cover-letter PDF
    Cover->>DB: cover/material/stage events
```

### Components

```mermaid
classDiagram
    class RunCover {
      +_run_cover(min_score, limit, validation_mode)
    }
    class CoverLetterRunner {
      +run_cover_letters(...)
    }
    class ProfileRepository {
      +load default profile
    }
    class MaterialsRepository {
      +load MaterialsSet
      +save CoverLetter
      +save CoverLetterPdf
    }
    class LLMClient {
      +chat(messages, schema)
    }
    class CoverLetter {
      +content
      +artifact_path
    }
    class PlaywrightHtmlPdfAdapter {
      +render cover-letter PDF
    }

    RunCover --> CoverLetterRunner
    CoverLetterRunner --> ProfileRepository
    CoverLetterRunner --> MaterialsRepository
    CoverLetterRunner --> LLMClient
    CoverLetterRunner --> CoverLetter
    CoverLetterRunner --> PlaywrightHtmlPdfAdapter
```

### Data And Events

- Reads score, job, profile, and existing materials context.
- Writes cover-letter material rows plus local cover-letter text and PDF files.
- Publishes cover-letter generation and PDF-rendered events.
- Refreshes artifact and job detail projections.

### Failure And Limits

`limit` caps eligible jobs. `validationMode` controls cover-letter validation.
Failures are local to individual jobs so a retry can continue from the remaining
pending cover letters.

## Phase 2: Apply

### Purpose And Boundary

Apply drives browser/agent automation to submit or dry-run applications. It is
the riskiest and longest-running phase, so the batch pipeline `run_stage` route
keeps orchestration in Temporal and `JobPipelineWorkflow` delegates the selected
`apply` stage to child `ApplyWorkflow` instead of a synchronous runner activity.
It owns apply-run lifecycle, browser execution, dry-run submission safety,
cancellation, and apply artifacts/logs.

### Sequence

```mermaid
sequenceDiagram
    autonumber
    participant Web as Web UI
    participant Api as TS API
    participant JsonRpc as SubprocessJsonRpcAdapter
    participant Rpc as JsonRpcServer
    participant Temporal as Temporal service
    participant PipelineWorkflow as JobPipelineWorkflow
    participant Workflow as ApplyWorkflow
    participant Activity as apply_activity
    participant Launcher as apply.launcher.main
    participant Browser as Browser / agent automation
    participant DB as SQLite
    participant Ops as Apply projections / SSE

    Web->>Api: POST /v1/pipeline/actions/run-stage with apply selected
    Api->>JsonRpc: call("run_stage", params)
    JsonRpc->>Rpc: JSON-RPC request
    Rpc->>Temporal: start JobPipelineWorkflow(stages=["apply"])
    Temporal-->>Rpc: workflow handle
    Rpc-->>Api: {runId, workflowId}
    Api-->>Web: 202 queued

    Temporal->>PipelineWorkflow: run(stages=["apply"])
    PipelineWorkflow->>Workflow: execute child ApplyWorkflow(payload)
    Workflow->>Activity: execute apply_activity(payload)
    Activity->>Launcher: apply_main(limit, min_score, dry_run, headless, model, continuous)
    Launcher->>DB: acquire apply stage lock and publish ApplyRunStarted
    Launcher->>Browser: open/fill/submit or dry-run application
    Browser-->>Launcher: result / error
    Launcher->>DB: ApplyRunEventRecorded and final status
    DB->>Ops: apply_run_projections rebuild
    Ops-->>Web: SSE invalidates apply run and job views
```

### Components

```mermaid
classDiagram
    class ApplyAction {
      +apply_action(params)
      +WorkflowStartSpec
    }
    class ApplyWorkflowInput {
      +tenant_id
      +job_url
      +dry_run
      +headless
      +model
      +min_score
      +workers
      +limit
      +continuous
    }
    class ApplyWorkflow {
      +execute apply_activity
      +retry policy
    }
    class ApplyActivity {
      +apply_activity(payload)
      +run blocking launcher with heartbeat
    }
    class ApplyLauncher {
      +select eligible jobs
      +acquire stage lock
      +drive browser automation
      +persist apply events
    }
    class ApplyRunProjection {
      +status
      +timeline
      +artifact links
    }

    ApplyAction --> ApplyWorkflowInput
    ApplyAction --> ApplyWorkflow
    ApplyWorkflow --> ApplyActivity
    ApplyActivity --> ApplyLauncher
    ApplyLauncher --> ApplyRunProjection
```

### Data And Events

- Reads eligible jobs, score/materials, posting or direct application URL data,
  and profile facts.
- Writes canonical apply stage state and `ApplyRunStarted`,
  `ApplyRunEventRecorded`, `ApplicationSubmitted`, or `ApplicationFailed`
  events.
- Writes apply logs/artifacts where available.
- Rebuilds `apply_run_projections` from lifecycle events.

### Failure, Retry, And Cancellation

`ApplyWorkflow` uses an apply-specific retry policy and a two-hour activity
timeout. Transient activity failures can retry through Temporal. Operator
errors such as no eligible job fail fast. `cancel_run` signals the workflow
runtime to cancel an in-flight run; `cancel_stage` is the post-hoc SQLite state
transition for marking a stage canceled.

## Operations Read-Side

The UI does not read directly from stage internals. It reads projection-backed
API endpoints owned by Operations:

`job_list_projections.current_stage` is a product-stage field. Projection
builders write only `discover` or `apply` there, even when the first actionable
internal row is `enrich`, `score`, `tailor`, or `cover`. The full internal
stage list remains in `job_detail_projections.stages_json` for review,
diagnostics, and repair decisions. Cover is the exception that can advance the
product stage: when the first actionable internal row is `cover` and a tailored
resume exists, the list projection writes `current_stage='apply'` while keeping
`current_substage='cover'` and the cover state visible for retry or repair.

```mermaid
flowchart LR
    Events["job_events<br/>domain + lifecycle facts"]
    Metrics["operational_attempt_metrics<br/>stage/source/apply facts"]
    StageRows["job_stage_states"]
    Aggregates["aggregate tables<br/>jobs, scores, materials, apply events"]
    Builder["ProjectionBuilder / refreshProjections"]
    JobList["job_list_projections"]
    Dashboard["dashboard_projections"]
    Detail["job_detail_projections"]
    Artifacts["artifact projections"]
    ApplyRuns["apply_run_projections"]
    Api["TS API read endpoints"]
    SSE["GET /v1/events/stream"]
    UI["React views + TanStack Query"]

    Events --> Builder
    Metrics --> Builder
    StageRows --> Builder
    Aggregates --> Builder
    Builder --> JobList
    Builder --> Dashboard
    Builder --> Detail
    Builder --> Artifacts
    Builder --> ApplyRuns
    JobList --> Api
    Dashboard --> Api
    Detail --> Api
    Artifacts --> Api
    ApplyRuns --> Api
    Events --> SSE
    Api --> UI
    SSE --> UI
```

This separation is why a stage can complete before every UI card visibly
changes: the write path records durable facts first, then projection refresh and
SSE invalidation make those facts visible to the frontend.

Operational metrics are append-only rows written at pipeline boundaries rather
than inferred from dashboard labels or free-form event messages. Rows include
`stage`, `source_id`, source role, adapter, attempt kind, outcome,
operational/scrape/retryable flags, counts, durations, `error_class`,
`error_message`, `run_id`, and `job_url` when known. Discovery, enrichment,
scoring, tailoring, preparation work items, cover generation, apply dry-runs,
and orphan cleanup all record structured attempts so
`discovery_runs.status='failed'` no longer has to carry unrelated failure
causes by itself.

## Source Files

Primary implementation files:

- `apps/api/src/server.ts`: `/v1/pipeline/actions/run-stage`.
- `apps/api/src/local-actions.ts`: maps UI commands to JSON-RPC methods and
  interprets results.
- `apps/api/src/json-rpc-adapter.ts`: long-lived subprocess JSON-RPC adapter.
- `workers/automation/src/jobhunter/infrastructure/rpc/handlers.py`: JSON-RPC
  method registry.
- `workers/automation/src/jobhunter/actions.py`: local action wrapper for
  `run_stage` and `profile_import`.
- `workers/automation/src/jobhunter/pipeline/runner.py`: non-apply stage
  orchestration.
- `workers/automation/src/jobhunter/pipeline/workflow.py`: non-apply Temporal
  workflow path.
- `workers/automation/src/jobhunter/apply/workflow.py`: apply workflow.
- `workers/automation/src/jobhunter/apply/activities.py`: apply activity.
- `workers/automation/src/jobhunter/apply/launcher.py`: apply browser/agent
  launcher.
- `apps/api/src/projections.ts` and
  `workers/automation/src/jobhunter/infrastructure/projections/`: Operations
  read-side projection builders.
