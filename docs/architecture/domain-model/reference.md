# 10–11. Risks & Glossary

Open risks and questions (§10) and the ubiquitous-language glossary (§11).
Part of the [Domain Model](index.md) reference.

## 10. Risk & Open Questions

### Risks

1. **Event schema evolution.** As domain events become the integration backbone,
   backward-compatible event schema evolution becomes critical. Breaking changes
   to event payloads could corrupt read-model projections. **Mitigation:**
   Adopt event versioning (e.g., `JobScored.v1`, `JobScored.v2`) and use
   upcasters to transform old events to new schemas.

2. **SQLite single-writer bottleneck.** The local-first architecture relies on
   SQLite's WAL mode for concurrent reads, but writes are still serialized.
   Under heavy apply workloads (multiple parallel workers), write contention
   could degrade performance. **Mitigation:** Keep transactions short (one
   aggregate per transaction). Use `PRAGMA busy_timeout=10000` (already in place).
   Monitor for `SQLITE_BUSY` errors.

3. **Local data cutover complexity.** Existing local databases can contain years
   of data. Moving a context to a hosted adapter requires careful handling of
   NULL semantics, inconsistent timestamps, and partial state. **Mitigation:**
   Each context cutover ships a one-shot, idempotent backfill script that runs
   against a staging database before the production cutover.

4. **In-process event bus reliability.** The synchronous in-process event bus
   means a crash between "command succeeded" and "projection updated" leaves
   the read model stale. **Mitigation:** On startup, run a reconciliation pass
   that replays unprocessed events. Keep the event store (`job_events`) as the
   source of truth for rebuilding projections.

5. **Two-language domain model drift.** TypeScript and Python domain types can
   drift if not kept in sync. **Mitigation:** `packages/domain-types` is the
   shared authority — hand-authored TypeScript mirrored byte-for-byte by the
   Python registry — and tests plus a release check enforce that the two stay in
   lockstep (the 99-entry domain event registry is the canonical example).

6. **Over-engineering risk.** DDD + hexagonal architecture adds indirection. For
   a local-first single-user product, this indirection must pay for itself in
   testability and maintainability. **Mitigation:** Start with the contexts
   that have the most pain (Materials Generation, Apply Automation, Pipeline
   Orchestration). Leave simpler contexts (Discovery, Profile) with lightweight
   port/adapter structure.

7. **Materials Generation aggregate size.** Grouping tailor + cover + pdf in one
   aggregate could make it too large if many artifact versions accumulate.
   **Mitigation:** The aggregate tracks only the *current generation*; superseded
   artifacts are owned by the `ArtifactStoragePort` and queryable through the
   Operations read model.

8. **Temporal operational complexity.** Self-hosting Temporal on Kubernetes adds
   significant operational surface: Cassandra/Postgres persistence backend,
   history service sizing, worker fleet tuning, visibility store queries.
   **Mitigation:** Start with Temporal Cloud (managed) to defer ops burden.
   Migrate to self-hosted only if cost or compliance requires it. Keep workflow
   definitions simple (sequential activities, not deeply nested child workflows).

9. **Row-Level Security (RLS) performance.** Postgres RLS policies add a
   predicate to every query. On tables with millions of rows across hundreds
   of tenants, poorly indexed `tenant_id` columns or complex RLS policies can
   degrade query performance significantly. **Mitigation:** Ensure `tenant_id`
   is the leading column in all composite indexes. Use partition-by-tenant for
   the `jobs` and `job_stage_states` tables if a single tenant exceeds 1M rows.
   Benchmark RLS overhead in staging before production.

10. **Outbox poller lag and ordering.** The transactional outbox pattern
    introduces latency between aggregate commit and event delivery (poller
    interval). Under high write throughput, the poller can fall behind.
    **Mitigation:** Configure poller interval at 100ms with adaptive batching
    (up to 100 events per poll). SQS FIFO's message group ID (`tenantId`)
    guarantees per-tenant ordering; cross-tenant ordering is not required.
    Monitor outbox table size; alert if unprocessed rows exceed 1000.

11. **Cross-region data residency.** Tenant-level data residency
    (e.g., EU tenants in `eu-west-1`) complicates deployment: region-specific
    RDS instances, S3 buckets, and Temporal namespaces. Cross-region queries
    are prohibited, but global features (admin dashboards, aggregate billing)
    need data from all regions. **Mitigation:** Global-only data (billing
    summaries, tenant metadata) lives in a single "control plane" region.
    Domain data stays in the tenant's home region. Fan-out events publish to
    a global SQS queue for billing/audit aggregation.

12. **Secret rotation disruption.** Per-tenant secrets in AWS Secrets Manager
    must be rotated without disrupting active pipeline runs. A rotation during
    an apply run that uses ATS credentials could cause mid-flow login failure.
    **Mitigation:** SecretPort adapter caches secrets with a TTL (5 min).
    Rotation uses a staged approach: new version becomes `AWSCURRENT` while
    old version remains as `AWSPREVIOUS`. Adapters fall back to `AWSPREVIOUS`
    on auth failure before surfacing errors.

13. **Entitlement check latency.** Every expensive operation (LLM call, apply
    run, artifact store) must check entitlements before proceeding. Synchronous
    calls to the Billing context add latency to the hot path. **Mitigation:**
    Cache entitlement state per-tenant with 60-second TTL. Billing publishes
    `EntitlementChanged` events; the cache invalidates on receipt. The
    entitlement check is a fast in-memory lookup in the common case.

### Open Questions

1. **JobId format.** Should `JobId` be a UUID, a content-hash of
   `(source, employer, title, postingUrl)`, or a sequential ID? UUIDs are
   simplest but lose deduplication-by-content. Content hashes enable
   cross-source dedup but are brittle to title changes. *Needs product input.*

2. **Score correction feedback loop.** The backlog mentions using score
   corrections to "personalize scoring for remaining jobs." How should this
   work? Options: (a) fine-tune the scoring prompt with correction examples,
   (b) adjust scoring rubric weights, (c) use corrections as few-shot examples.
   *Needs product input.*

3. **Resume rendering rollout.** The engine decision is HTML/CSS + Playwright,
   and `HtmlResumePdfAdapter` is the renderer. Layout-map persistence and Apply
   Review layout-box consumption are in place for new artifacts; historical
   `latex_pdf` rows remain migration/inspection data only.

4. **Event streaming to the frontend.** The backlog calls for "event streaming or
   targeted row patching so lists do not reload wholesale." Should this be SSE,
   WebSocket, or polling with ETags? The Operations context's `EventSubscriber`
   port supports all three; the choice is a UX/infrastructure decision. *Needs
   product input.*

5. **Apply telemetry granularity.** How much of the Claude Code conversation
   should be captured in `ApplyRunEvent`s? Full transcript? Summary events only?
   Token/cost totals? Current code captures cost totals; more granularity adds
   observability but increases storage. *Needs product input.*

---

## 11. Glossary

Terms are listed alphabetically. The **Context** column names the bounded
context — or cross-cutting platform concern — that owns each term.

| Term | Context | Definition |
|---|---|---|
| **Aggregate** | DDD | A cluster of entities and value objects treated as a unit for data changes, with a single root entity. |
| **AntiCorruptionLayer** | DDD | A translation layer that prevents external models from corrupting the internal domain model. Used at bounded context boundaries. |
| **ApplicationUrl** | Enrichment | The direct URL where a candidate submits their application; may differ from the posting URL. |
| **ApplyRun** | Apply Automation | A single attempt to submit a job application through browser automation. |
| **Artifact** | Materials Generation | Any generated file (resume, cover letter, PDF) with provenance metadata. |
| **ArtifactStatus** | Materials Generation | Lifecycle of an artifact: `candidate`, `approved`, `rejected`, `superseded`. |
| **Attempt** | Pipeline Orchestration | A numbered try at completing a pipeline stage for a job. |
| **AuditSink** | Platform (Audit Log) | A driven port that receives structured audit records for every write operation. Cloud adapter writes to Postgres `audit_events` + CloudWatch Logs. |
| **BlockedReason** | Pipeline Orchestration | Why a stage cannot proceed (upstream dependency not met). |
| **BrowserWorker** | Apply Automation | An isolated Chrome instance allocated for one apply run. |
| **CoverLetter** | Materials Generation | A job-specific cover letter generated from the profile and tailored resume. |
| **DataRegion** | Platform (Identity) | The AWS region where a tenant's data resides (e.g., `us-east-1`, `eu-west-1`). Determines which RDS instance, S3 bucket, and Temporal namespace serve the tenant. |
| **DomainEvent** | DDD | An immutable record of something important that happened in the domain, named in past tense. |
| **DryRun** | Apply Automation | An apply attempt that navigates the ATS but does not submit the application. |
| **Employer** | Discovery | The hiring company, distinct from the source board where the job was found. |
| **EnrichmentAttempt** | Enrichment | A child entity within `JobEnrichment`; records one try at extracting full description and application URL from a job's detail page. |
| **Entitlement** | Platform (Billing) | A tenant's right to perform a specific operation (e.g., apply run, LLM call) based on their subscription plan and current usage. |
| **EntitlementPort** | Platform (Billing) | A driven port that processing contexts call to check whether a tenant is allowed to perform an expensive operation before executing it. |
| **EvolutionTrigger** | Evolutionary Architecture | A concrete, testable condition that initiates migration from a local-mode adapter to its cloud equivalent. See Section 9.4. |
| **ExtractionTier** | Enrichment | The method used to extract job details: JSON-LD (Tier 1), CSS selectors (Tier 2), LLM-assisted (Tier 3). |
| **FitScore** | Scoring | A 1-10 integer rating of candidate-job match quality. |
| **FullDescription** | Enrichment | The complete job posting text extracted from the detail page. |
| **Job** | Discovery | A job posting discovered from an external source, identified by a stable `JobId`. |
| **JobEnrichment** | Enrichment | The aggregate root for enrichment of a single job. Contains multiple `EnrichmentAttempt` child entities. Identity: `(TenantId, JobId)`. |
| **JobId** | Discovery | A system-generated stable identifier for a job. |
| **JobPipelineState** | Pipeline Orchestration | The collection of stage states for one job across all pipeline stages. |
| **JudgeVerdict** | Materials Generation | LLM-as-judge evaluation of a tailored resume's quality and faithfulness. |
| **MatchedKeywords** | Scoring | ATS keywords from the job description that match the candidate's profile. |
| **MaterialsSet** | Materials Generation | The grouped artifacts (tailored resume, cover letter, PDFs) for one job application, tracked as a single aggregate. |
| **McpConfig** | Apply Automation | Playwright MCP server configuration for a browser automation session. |
| **MessageGroupId** | Platform (Events) | SQS FIFO message group ID, set to `tenantId` to guarantee per-tenant event ordering in the cloud event bus. |
| **NextAction** | Pipeline Orchestration | The recommended CLI command or UI action to advance a blocked or failed stage. |
| **OutboxPoller** | Platform (Events) | A sidecar process that reads uncommitted domain events from the Postgres `outbox` table and publishes them to SQS FIFO. Guarantees at-least-once delivery with crash-consistency. |
| **Pipeline** | Pipeline Orchestration | The canonical sequence of stages: discover → enrich → score → tailor → cover → apply. |
| **Port** | Hexagonal Architecture | An interface through which the application communicates with the outside world. Driving ports are use cases; driven ports are infrastructure dependencies. |
| **PostingUrl** | Discovery | The original URL where a job was found on an external board. Dedup is global within a tenant (not per-source). |
| **Profile** | Candidate Profile | The complete candidate data document: resume baseline, experience, education, skills, tailoring policy, writing style. |
| **ProfileSnapshot** | Candidate Profile | An immutable, validated copy of the Profile provided to consuming contexts. |
| **PublishedLanguage** | DDD | Types and schemas that a bounded context exports for consumption by other contexts. `ProfileSnapshot` and domain event schemas are examples. |
| **Repository** | DDD | A port that provides the illusion of an in-memory collection of aggregates, abstracting persistence. |
| **RetryPolicy** | Pipeline Orchestration | Configuration for max attempts and backoff rules per pipeline stage. |
| **ScoreBreakdown** | Scoring | Structured explanation of why a job received its fit score. |
| **ScoreCorrection** | Scoring | A user-provided override of an LLM-generated score, with rationale. |
| **SearchStrategy** | Discovery | The extraction method used to find jobs: `jobspy`, `workday_api`, `smart_extract`, `manual`. |
| **SecretPort** | Platform (Secrets) | A driven port for retrieving per-tenant credentials. Local adapter reads `.env`/Keychain; cloud adapter reads AWS Secrets Manager. |
| **Source** | Discovery | The origin board or career site where a job was found (e.g., LinkedIn, Greenhouse). |
| **Stage** | Pipeline Orchestration | A named step in the pipeline: `discover`, `enrich`, `score`, `tailor`, `cover`, `pdf`, `apply`. |
| **StageState** | Pipeline Orchestration | The current status of a job within a stage. The domain model represents each variant as a typed value (PascalCase: `Pending`, `Queued`, `Running`, `Succeeded`, `Failed`, `Blocked`, `Skipped`, `Exhausted`, `NeedsVerification`, `Stale`, `Canceled` — eleven variants, see §4.7). The lowercase forms (`pending`, `queued`, `running`, `succeeded`, `failed`, `blocked`, `skipped`, `exhausted`, `needs_verification`, `stale`, `canceled`) are the serialized representation written to `job_stage_states.state`, emitted in event payloads, and exposed through the API DTOs. |
| **SubmissionResult** | Apply Automation | The outcome of an apply attempt: `applied`, `failed`, `captcha`, `login_issue`, `expired`, `manual`, `dry_run`. |
| **TailoredResume** | Materials Generation | A resume customized for a specific job, derived from the master baseline via LLM. |
| **TailoringPlan** | Materials Generation | Deterministic constraints derived from profile evidence, tailoring policy, job text, and fit score before resume generation and validation. |
| **TailoringPolicy** | Candidate Profile | Rules governing what the LLM may modify during resume tailoring, including claim mode, auto-approval boundaries, adjacent achievement drafts, rewrite permissions, and writing controls. |
| **TenantContext** | Platform (Identity) | A request-scoped value object containing `tenantId`, `userId`, and `roles`, injected by the API gateway / auth middleware into every use case call. |
| **TenantId** | Platform (Identity) | A globally unique identifier for a tenant (organization or individual account). First-class domain concept threaded through all aggregates, events, and port calls. In local mode, a singleton constant. |
| **TokenUsage** | Apply Automation | LLM token consumption and cost tracking for an apply run. |
| **TransactionalOutbox** | Platform (Events) | A Postgres table (`outbox`) where domain events are written in the same transaction as the aggregate mutation, guaranteeing crash-consistent event delivery. |
| **ValidationResult** | Materials Generation | Output of content validation: banned words check, fabrication check, structural integrity check. |
| **WritingStyle** | Candidate Profile | Stylistic constraints for generated content: tone, verbosity, bullet style, keyword density. |
