# 5. Hexagonal Architecture — Ports & Adapters

Every port the domain depends on and the local adapters that implement them.
Part of the [Domain Model](index.md) reference.

A **port** is an interface the domain uses to reach the outside world; an
**adapter** is a concrete implementation of that port. Driving (inbound) ports
are the use cases external callers invoke; driven (outbound) ports are the
infrastructure the domain calls out to. Each context below lists both, with the
local adapter in use today and the hosted adapter named for the cloud future.

**Read this if** you need to know where an external dependency — a database, an
LLM, a browser, the filesystem — plugs into the domain, and what would change to
swap it for a hosted service.

### Port Naming Convention

- **Driving ports** (inbound): named as use cases — `ScoreJobUseCase`, `TailorResumeUseCase`.
- **Driven ports** (outbound): named as capabilities — `JobRepository`, `LlmPort`, `BrowserPort`.

> **Realisation status.** The driving-port use-case names below are the
> conceptual command surface; the implemented application layer under
> `application/` currently exposes about eighteen use cases, and some names
> differ from the idealised ones listed here. A few driven ports in the tables
> below are documented as conceptual seams and are **not realised as distinct
> named types** in the current code: `ProfileSnapshotPort` (the code passes
> `ProfileSnapshot` value objects; see `domain/profile/snapshot.py`),
> `ArtifactStoragePort` (artifacts are written directly to the local filesystem
> and registered in the read model), `EventSubscriber` (the in-process
> `InProcessEventBus` is subscribed directly), and `ReadModelStore` (the
> projection store in `infrastructure/projections/` is the concrete read side).
> They are kept here because each names a real hosted-future seam.

### 5.1 Job Discovery Context

| Port Type | Port | Description |
|---|---|---|
| **Driving** | `DiscoverJobsUseCase` | Trigger discovery for configured search strategies |
| **Driving** | `ImportJobUseCase` | Manually add a single job by URL |
| **Driving** | `DeleteJobUseCase` | Soft-delete a job (tombstone record). Emits `JobDeleted`. |
| **Driving** | `RestoreJobUseCase` | Restore a soft-deleted job. Emits `JobRestored`. |
| **Driven** | `JobBoardScraperPort` | Scrape job postings from external boards |
| **Driven** | `JobRepository` | Persist and retrieve Job aggregates |
| **Driven** | `EventPublisher` | Publish domain events |

| Driven Port | Local Adapter (today) | Hosted Adapter (cloud) |
|---|---|---|
| `JobBoardScraperPort` | `JobSpyAdapter`, `WorkdayApiAdapter`, `SmartExtractAdapter` (Playwright + LLM) | Same adapters, deployed as Kubernetes Jobs behind **AWS SQS** task queue with per-tenant rate limiting |
| `JobRepository` | `SqliteJobRepository` | `PostgresJobRepository` (**AWS RDS Postgres 16** with pgbouncer connection pooling, tenant-scoped via `tenant_id` column + RLS) |
| `EventPublisher` | `InProcessEventBus` (synchronous) | `SqsEventPublisher` (**AWS SQS FIFO** queues, one per bounded context, with message group = tenantId for ordered per-tenant delivery) |

**Seam justification:** Job board scraping is the most brittle integration point
(anti-scraping measures, API changes, rate limits). The port lets us swap
scrapers without touching domain logic. The repository port lets us switch
from SQLite to Postgres without changing Discovery logic.

### 5.2 Job Enrichment Context

| Port Type | Port | Description |
|---|---|---|
| **Driving** | `EnrichJobUseCase` | Enrich a specific job's detail page |
| **Driving** | `EnrichBatchUseCase` | Enrich a batch of jobs |
| **Driven** | `DetailPageFetcherPort` | Navigate to and extract content from job detail pages |
| **Driven** | `LlmPort` | LLM-assisted extraction (Tier 3) |
| **Driven** | `EnrichmentRepository` | Persist enrichment results |
| **Driven** | `EventPublisher` | Publish domain events |

| Driven Port | Local Adapter (today) | Hosted Adapter (cloud) |
|---|---|---|
| `DetailPageFetcherPort` | `PlaywrightBrowserAdapter` (local Playwright instance) | `BrowserbaseAdapter` (**Browserbase** managed browser fleet; sessions allocated per-tenant with concurrency cap; fallback: headless Chromium in **Kubernetes pods** with Playwright) |
| `LlmPort` | A single `LlmAdapter` (`infrastructure/llm/llm_client.py`) that selects the provider from the model-spec prefix (`gemini:` / `openai:` / `local:`) and wraps the legacy `LLMClient` — there is no per-provider adapter class | `CloudLlmGatewayAdapter` (internal gateway service fronting Anthropic Claude / Google Gemini / OpenAI APIs with per-tenant token metering, rate limiting, and cost attribution via **Billing** context) |
| `EnrichmentRepository` | `SqliteEnrichmentRepository` | `PostgresEnrichmentRepository` (RDS Postgres, tenant-scoped) |

**Seam justification:** Enrichment's Playwright dependency is the primary
obstacle to horizontal scaling. The `DetailPageFetcherPort` lets us swap local
Playwright for a hosted browser fleet without changing extraction logic.

### 5.3 Candidate Profile Context

| Port Type | Port | Description |
|---|---|---|
| **Driving** | `GetProfileUseCase` | Retrieve the current profile snapshot |
| **Driving** | `UpdateProfileUseCase` | Update profile sections |
| **Driving** | `ImportProfileUseCase` | Import profile from a resume PDF |
| **Driven** | `ProfileRepository` | Persist and retrieve the Profile aggregate |
| **Driven** | `PdfParserPort` | Extract text and structure from resume PDFs |
| **Driven** | `EventPublisher` | Publish domain events |

| Driven Port | Local Adapter (today) | Hosted Adapter (cloud) |
|---|---|---|
| `ProfileRepository` | `SqliteProfileRepository` (normalized `candidate_profile*` tables; explicit saves and resume imports populate profile/rendering rows) | `PostgresProfileRepository` (RDS Postgres, keyed by `(tenant_id, profile_id)`) |
| `PdfParserPort` | `PyPdfAdapter` | `PyPdfAdapter` (same library, runs in worker pod; no cloud service needed) |

**Seam justification:** Profile storage is isolated behind the repository port:
local SQLite and hosted Postgres adapters expose the same aggregate contract.

### 5.4 Scoring Context

| Port Type | Port | Description |
|---|---|---|
| **Driving** | `ScoreJobUseCase` | Score one job against the candidate profile |
| **Driving** | `ScoreBatchUseCase` | Score a batch of jobs |
| **Driving** | `CorrectScoreUseCase` | User overrides a score |
| **Driven** | `LlmPort` | LLM scoring (prompt + response parsing) |
| **Driven** | `ScoreRepository` | Persist JobScore aggregates |
| **Driven** | `ProfileSnapshotPort` | Read-only access to the current profile |
| **Driven** | `EventPublisher` | Publish domain events |

| Driven Port | Local Adapter (today) | Hosted Adapter (cloud) |
|---|---|---|
| `LlmPort` | A single `LlmAdapter`, prefix-dispatched by model spec (see Enrichment) | `CloudLlmGatewayAdapter` (see Enrichment; shared gateway service) |
| `ScoreRepository` | `SqliteScoreRepository` | `PostgresScoreRepository` (RDS Postgres, tenant-scoped) |
| `ProfileSnapshotPort` | `LocalProfileSnapshotAdapter` (reads the SQLite-backed Profile repository) | `ProfileServiceGrpcClient` (internal **gRPC** call to Profile service; tenant context propagated via gRPC metadata) |

### 5.5 Materials Generation Context

| Port Type | Port | Description |
|---|---|---|
| **Driving** | `TailorResumeUseCase` | Generate a tailored resume for one job |
| **Driving** | `GenerateCoverLetterUseCase` | Generate a cover letter for one job |
| **Driving** | `RenderPdfUseCase` | Render documents to PDF |
| **Driving** | `TailorBatchUseCase` | Batch tailor + cover + PDF for multiple jobs |
| **Driven** | `LlmPort` | LLM for tailoring and cover letter generation |
| **Driven** | `AnalysisDraftPort` / `AnalysisSynthesizerPort` | Employer/company analysis via the 3-SDK agent ensemble (second LLM path) |
| **Driven** | `PdfRendererPort` | Render LaTeX or HTML to PDF |
| **Driven** | `ArtifactStoragePort` | Write and register generated files |
| **Driven** | `MaterialsRepository` | Persist MaterialsSet aggregates |
| **Driven** | `ProfileSnapshotPort` | Read-only access to the current profile |
| **Driven** | `EventPublisher` | Publish domain events |

| Driven Port | Local Adapter (today) | Hosted Adapter (cloud) |
|---|---|---|
| `LlmPort` | A single `LlmAdapter`, prefix-dispatched by model spec (see Enrichment) | `CloudLlmGatewayAdapter` (shared gateway; see Enrichment) |
| `AnalysisDraftPort` / `AnalysisSynthesizerPort` | The 3-SDK agent ensemble (`infrastructure/analysis/`): `ClaudeAnalysisAdapter`, `CodexAnalysisAdapter`, and `AntigravityAnalysisAdapter` draft employer/company analysis in parallel; `ClaudeAnalysisSynthesizer` merges them via `run_ensemble`. This is a **second LLM path**, distinct from the prefix-dispatched `LlmPort` above | Same ensemble fronted by the cloud LLM gateway, with per-tenant token metering |
| `PdfRendererPort` | `HtmlResumePdfAdapter` (default structured resume HTML/CSS + Playwright renderer with layout boxes), `LatexPdfAdapter` (`pdflatex` compatibility renderer), `PlaywrightHtmlPdfAdapter` (cover letters) | HTML/CSS + Playwright/Chromium resume rendering; keep LaTeX/Tectonic only for compatibility if required. Cover letters: `WeasyPrintAdapter` (pure-Python HTML→PDF, no browser needed in cloud) |
| `ArtifactStoragePort` | `LocalFilesystemAdapter` (writes to `~/.jobhunter/tailored_resumes/`, etc.) | `S3ArtifactAdapter` (**AWS S3** with tenant-prefixed keys: `s3://jobhunter-artifacts/{tenantId}/{jobId}/`; presigned URLs for browser download; lifecycle policy for cost control) |
| `MaterialsRepository` | `SqliteMaterialsRepository` | `PostgresMaterialsRepository` (RDS Postgres, tenant-scoped) |

**Seam justification:** The `PdfRendererPort` absorbed the renderer swap:
HTML/CSS + Playwright is the production default for resume PDFs, emits
layout boxes for Apply Review, and keeps LaTeX as an explicitly selected
compatibility adapter without touching materials domain logic. The
`ArtifactStoragePort` absorbs the local-to-cloud transition for generated files.

### 5.6 Apply Automation Context

| Port Type | Port | Description |
|---|---|---|
| **Driving** | `SubmitApplicationUseCase` | Launch an apply run for one job |
| **Driving** | `SubmitBatchUseCase` | Batch apply for multiple jobs |
| **Driven** | `BrowserPort` | Manage Chrome lifecycle (launch, CDP, cleanup) |
| **Driven** | `AutonomousAgentPort` | Spawn and manage Claude Code subprocess with MCP |
| **Driven** | `ApplyRunRepository` | Persist ApplyRun aggregates |
| **Driven** | `ArtifactStoragePort` | Read materials (resume PDF, cover letter PDF) |
| **Driven** | `ProfileSnapshotPort` | Read candidate application defaults |
| **Driven** | `EventPublisher` | Publish domain events |

| Driven Port | Local Adapter (today) | Hosted Adapter (cloud) |
|---|---|---|
| `BrowserPort` | `LocalChromeAdapter` (launch Chrome on isolated CDP ports) | `BrowserbaseAdapter` (**Browserbase** managed sessions; per-tenant session pool with concurrency limits enforced by Billing entitlements; alternative: headless Chromium sidecars in **Kubernetes pods** with CDP exposed via localhost) |
| `AutonomousAgentPort` | `ClaudeCodeCliAdapter` (subprocess + Playwright MCP) | `ClaudeApiAgentAdapter` (**Anthropic Claude API** with tool use / computer use; direct Playwright API calls from a managed agent container; apply prompt unchanged, transport switches from CLI subprocess to API request) |
| `ApplyRunRepository` | `SqliteApplyRunRepository` | `PostgresApplyRunRepository` (RDS Postgres, tenant-scoped) |

**Seam justification:** Apply Automation is the most infrastructure-heavy context.
The `BrowserPort` and `AutonomousAgentPort` isolate the two most complex
infrastructure dependencies (Chrome lifecycle and Claude Code subprocess) behind
clean interfaces. This is essential for the hosted future where browsers and
agents are managed fleet resources.

### 5.7 Pipeline Orchestration Context

| Port Type | Port | Description |
|---|---|---|
| **Driving** | `RunPipelineUseCase` | Execute pipeline stages for a batch of jobs |
| **Driving** | `RetryStageUseCase` | Reset and retry a specific stage for a job |
| **Driving** | `CancelStageUseCase` | Cancel a running stage |
| **Driving** | `MarkAppliedUseCase` | Manually mark a job as applied (no apply run). Transitions apply stage to `Succeeded`. |
| **Driving** | `SkipJobUseCase` | Skip a job at relevant stages (e.g., below score threshold, not interested). Transitions specified stages to `Skipped`. |
| **Driven** | `PipelineStateRepository` | Persist JobPipelineState aggregates |
| **Driven** | `EventPublisher` | Publish domain events |

| Driven Port | Local Adapter (today) | Hosted Adapter (cloud) |
|---|---|---|
| `PipelineStateRepository` | `SqlitePipelineStateRepository` | `PostgresPipelineStateRepository` (RDS Postgres, tenant-scoped) |

> **Stage dispatch is Temporal, not an in-process seam.** Earlier drafts routed
> stage commands through a `StageCommandDispatcher` port with an
> `InProcessDispatcher` local adapter and a Temporal *hosted* adapter. That seam
> no longer exists: **Temporal is the local orchestrator.** A pipeline run is a
> `JobPipelineWorkflow` (starter-generated random id `run-{uuid4}`, no
> overlap/dedup control); per-job preparation is a
> `JobPreparationWorkflow` (`prep-{idempotency_key}`); each stage is a Temporal activity
> with retry, timeout, heartbeat, and finalize semantics. For the concrete
> execution model see the [System Architecture overview](../index.md) and the
> [Job Pipeline section](../pipeline/index.md).

### 5.8 Operations / Read-Side Context

| Port Type | Port | Description |
|---|---|---|
| **Driving** | `GetDashboardUseCase` | Dashboard summary query |
| **Driving** | `ListJobsUseCase` | Paginated, filtered job list |
| **Driving** | `GetJobDetailUseCase` | Full job detail with stages and artifacts |
| **Driving** | `ListArtifactsUseCase` | Artifact listing with provenance |
| **Driving** | `GetApplyRunsUseCase` | Apply run telemetry queries |
| **Driven** | `ReadModelStore` | Query read-model projections |
| **Driven** | `EventSubscriber` | Subscribe to domain events for projection updates |

| Driven Port | Local Adapter (today) | Hosted Adapter (cloud) |
|---|---|---|
| `ReadModelStore` | `SqliteReadModelStore` (same DB, denormalized views) | `PostgresReadModelStore` (**AWS RDS Postgres read replica**; tenant-scoped queries via RLS; optional **ElastiCache Redis** for dashboard aggregation caching) |
| `EventSubscriber` | `InProcessEventBus` | `SqsEventConsumer` (**AWS SQS FIFO** consumer; reads from per-context queues; processes events in tenant-ordered batches; dead-letter queue for failed projections) |

### 5.9 Contact & Outreach Context

Phase 1 realises the `Contact` aggregate's ports; the research-task and
outreach-thread ports land with their aggregates in later phases.

| Port Type | Port | Description |
|---|---|---|
| **Driving** | `CreateContactUseCase` | Create a contact linked to an employer and/or application, with user-entered provenance |
| **Driving** | `UpdateContactUseCase` | Update a contact's link, role, or attributes |
| **Driving** | `ImportContactsUseCase` | Import a user-provided CSV contact list (CSV only), tagging every fact `user_imported_list` |
| **Driving** | `DeleteContactUseCase` | Soft-delete a contact |
| **Driven** | `ContactRepository` | Persist and retrieve the `Contact` aggregate (tenant-scoped) |
| **Driven** | `EventPublisher` | Publish contact domain events |

| Driven Port | Local Adapter (today) | Hosted Adapter (cloud) |
|---|---|---|
| `ContactRepository` | `SqliteContactRepository` (publisher-injected; writes `contacts` + `contact_attributes`, then records contact events to `job_events`) | `PostgresContactRepository` (RDS Postgres, tenant-scoped) |

**Hosting.** Phase 1's contact state-transition commands (create / update / CSV
import / soft-delete) are simple, LLM-free, and browser-free, so they are hosted
directly in the TypeScript API (`apps/api/src/contacts.ts`) per
[§6.8](integration.md); the Python worker exposes the same use cases and
`SqliteContactRepository`, writing the same canonical tables and event types.

**Seam justification:** the repository port isolates contact storage exactly like
every other aggregate — local SQLite today, hosted Postgres tomorrow — with no
change to the contact domain logic.

---
