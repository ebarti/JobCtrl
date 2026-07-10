# 9. Cloud Deployment Architecture

The hosted-future seams: what changes when JobCtrl runs multi-tenant in the
cloud, and the fitness functions that guard the path. Part of the
[Domain Model](index.md) reference.

**Read this if** you want to know which parts of the system are built for the
cloud today, which are named-but-not-built seams, and the concrete trigger that
tells the team when to swap a local adapter for its hosted equivalent.

Cloud deployment is a **hard requirement**, not a future aspiration. The
local-first phase validates the product; this section defines the target
deployment model that ships to production.

> **What already landed locally.** Temporal is no longer a hosted-future item —
> it is the local orchestration engine today (`temporal server start-dev`). The
> genuinely-unbuilt hosted seams that remain are: the multi-tenant `TenantId`
> source (constant → JWT), remote managed providers (Postgres/RDS, S3, SQS FIFO,
> Browserbase, the LLM gateway, Secrets Manager), the hosted read-model store,
> and the platform contexts (Identity, Billing, Audit, Secrets). Read the
> Temporal rows below as *scale-out of an existing engine*, not *introduction of
> a new one*.

## What Changes

| Concern | Local-First (validation) | Cloud (target) | Concrete Technology |
|---|---|---|---|
| **Database** | SQLite with WAL mode | Postgres with connection pooling | **AWS RDS Postgres 16** + **pgbouncer**. Tenant isolation via Row-Level Security (RLS) with `tenant_id` column on every table. Schema migrations via **Flyway**. |
| **File storage** | Local filesystem (`~/.jobctrl/`) | Object storage with tenant-prefixed keys | **AWS S3** with bucket `jobctrl-artifacts`. Key pattern: `{tenantId}/{jobId}/{artifactType}/{filename}`. Presigned URLs for browser download (1-hour TTL). Lifecycle policy: move to Glacier after 90 days. |
| **Event bus** | In-process synchronous dispatcher | Durable message queue with transactional outbox | **AWS SQS FIFO** queues (one per bounded context). Transactional outbox in Postgres (same DB as aggregate). Outbox poller runs as a sidecar process. Message group ID = `tenantId` for per-tenant ordering. Dead-letter queue for failed events. |
| **Browser automation** | Local Chrome on CDP ports | Managed browser fleet | **Browserbase** managed sessions (primary). Fallback: headless Chromium in **Kubernetes pods** with Playwright, one pod per apply run, auto-scaled. Per-tenant concurrency cap enforced by Billing entitlements. |
| **LLM calls** | Direct API calls (Gemini, OpenAI) | Managed LLM gateway | Internal **LLM Gateway Service** (FastAPI). Fronts Anthropic Claude API, Google Gemini, OpenAI. Per-tenant token metering, rate limiting, cost attribution. Gateway publishes `LlmUsageRecorded` events to Billing context. |
| **Worker execution** | Local Temporal (`temporal server start-dev`) + a single local worker | Same Temporal programming model, scaled out | **Temporal already runs locally**: each pipeline run is a workflow, each stage an activity, with retry/timeout/visibility/finalize. The cloud change is the *deployment*, not the engine — a hosted Temporal cluster (self-hosted on Kubernetes or Temporal Cloud) with a worker fleet auto-scaled via **KEDA**. |
| **Identity & auth** | Single user, no auth | Multi-tenant JWT/OAuth | **Auth0** (or AWS Cognito) for authentication. JWT tokens with `tenant_id` and `user_id` claims. API gateway validates JWT and injects `TenantContext` into every request. |
| **Secrets** | macOS Keychain / `.env` | Encrypted vault | **AWS Secrets Manager**. Credentials for LLM APIs, job board accounts, and ATS login stored per-tenant. `SecretPort` adapter fetches at runtime; secrets never persisted in application state. |
| **API binding** | Loopback (127.0.0.1) | Public endpoint with TLS + auth | **AWS ALB** → **Kubernetes Ingress** → Fastify API pods. TLS termination at ALB. Rate limiting via **AWS WAF**. |
| **Audit log** | None (local trust model) | Append-only audit trail | **AWS CloudWatch Logs** structured JSON + dedicated `audit_events` Postgres table. Every write operation (command) is logged with `tenantId`, `userId`, `action`, `resourceId`, `timestamp`, `ipAddress`. Immutable; no DELETE access. |
| **Billing** | None | Usage-based billing | **Stripe** for subscription and usage-based billing. Billing context tracks: LLM token usage, apply run count, browser session minutes, storage bytes. Entitlement checks gate pipeline execution (e.g., max apply runs per month). |
| **Data residency** | Local disk (user controls) | Multi-region with tenant-level residency | Tenant metadata includes `data_region` (e.g., `us-east-1`, `eu-west-1`). Repository adapters route to region-specific RDS instances. S3 bucket replication configured per region. Cross-region queries prohibited at the adapter level. |

## What Does NOT Change

| Concern | Why it survives the transition | Verified? |
|---|---|---|
| **Domain types and logic** | Zero infrastructure imports. All I/O goes through ports. | Yes — every aggregate, value object, and domain service in Sections 4.1–4.8 has no infrastructure dependency. |
| **Aggregate boundaries and invariants** | Transactional consistency rules are infrastructure-agnostic. Tenant scoping is already in the aggregate identity. | Yes — `TenantId` is threaded through all aggregate identities in this doc. |
| **Domain events and their schemas** | Event shapes are domain facts. `tenantId` is already a first-class field. Only the transport changes (in-process dispatch → SQS FIFO). | Yes — every event definition includes `tenantId`. |
| **Driven port interfaces** | `JobRepository.save(tenantId, job)` is the same contract for SQLite and Postgres. | Yes — the port interface is parameterized by `TenantId`; only the adapter implementation changes. |
| **Stage state machine** | State transitions are pure logic, no infrastructure dependency. | Yes — `StageStateMachine` is a pure function. |
| **Content validation** | Banned words, fabrication checks, structural validation are pure functions. | Yes — `ContentValidator`, `ScoreParser`, `ResumeAssembler` have no I/O. |
| **Ubiquitous language** | Domain terminology is infrastructure-independent. | Yes — glossary terms are identical across environments. |
| **JSON-RPC application protocol** | Same message shapes over different transports. | Yes — Section 6.5 defines transport-independent JSON-RPC messages. |

**Moved from "does not change" to "changes":**
- **Use case interfaces (driving ports):** Use case signatures *mostly* survive,
  but the `tenantId` parameter is explicit in every use case call. In local
  mode it was implicit (singleton). This is a signature change, not a logic
  change. The domain logic inside the use case is unchanged.

## Platform Bounded Contexts (Cloud-Only)

These contexts do not exist in local-first mode. They are **cross-cutting
platform services** that interact with the core domain through well-defined
seams.

### Identity & Access Context

**Purpose:** Authenticate users, issue JWT tokens, manage tenant membership,
enforce authorization policies.

**Integration pattern:** Middleware / API gateway filter. The Fastify API (or
its cloud successor) validates the JWT on every request and injects a
`TenantContext { tenantId, userId, roles }` into the request context. All
downstream use case calls receive `TenantContext` as their first parameter.

**Technology:** Auth0 (managed) or AWS Cognito. RBAC with roles:
`owner | admin | member | viewer`.

**What it does NOT own:** Domain authorization (e.g., "can this user retry this
stage?"). That is the domain's responsibility via entitlement checks. Identity
& Access only answers "who is this user and what tenant are they in?"

### Billing & Entitlements Context

**Purpose:** Track usage, enforce subscription limits, meter costs, manage
Stripe subscriptions.

**Integration pattern:** The Billing context exposes an `EntitlementPort` driven
port that processing contexts call before executing expensive operations:

```
EntitlementPort.check(tenantId, operation: "apply_run") -> Allowed | Denied(reason)
EntitlementPort.check(tenantId, operation: "llm_call", tokens: 50000) -> Allowed | Denied(reason)
```

Usage is metered asynchronously via domain events: `LlmUsageRecorded`,
`ApplyRunCompleted`, `ArtifactStored`. The Billing context subscribes to these
events and updates usage counters.

**Technology:** Stripe Billing with usage-based pricing. Internal usage ledger
in Postgres.

### Audit Log Context

**Purpose:** Provide an immutable, append-only record of all write operations
for compliance, debugging, and support.

**Integration pattern:** Event sink. The Audit context subscribes to **all**
domain events (fan-out from SQS) and writes structured audit records. It also
receives HTTP request metadata (IP, user agent, etc.) from the API gateway
middleware.

**Technology:** Postgres `audit_events` table (immutable, no UPDATE/DELETE
grants) + AWS CloudWatch Logs for real-time streaming + optional S3 export for
long-term retention.

### Secret Management Context

**Purpose:** Store and retrieve per-tenant credentials (LLM API keys, job board
accounts, ATS login credentials) securely.

**Integration pattern:** Driven port `SecretPort` consumed by Discovery,
Enrichment, and Apply Automation:

```
SecretPort.get(tenantId, secretName: "openai_api_key") -> SecretValue
SecretPort.get(tenantId, secretName: "greenhouse_login") -> SecretValue
```

Local adapter reads from `.env` / macOS Keychain. Cloud adapter reads from
AWS Secrets Manager with tenant-scoped paths
(`/jobctrl/{tenantId}/{secretName}`).

**Technology:** AWS Secrets Manager with IAM-based access control. Secrets
cached in-memory for 5 minutes (configurable TTL). Never logged or persisted
outside Secrets Manager.

## How the Seams Absorb the Change

1. **Database migration:** Swap `SqliteJobRepository` for `PostgresJobRepository`.
   The repository port interface is unchanged. Postgres adapter adds: connection
   pooling (pgbouncer), RLS for tenant isolation, Flyway migrations, and
   `tenant_id` column on every table.

2. **File storage migration:** Swap `LocalFilesystemAdapter` for `S3ArtifactAdapter`.
   The `ArtifactStoragePort` interface is unchanged. S3 adapter adds: presigned
   URLs, tenant-prefixed keys, lifecycle policies, and cross-region replication.

3. **Event bus migration:** Swap `InProcessEventBus` for transactional outbox +
   SQS FIFO. The `EventPublisher` and `EventSubscriber` port interfaces are
   unchanged. Outbox guarantees no events are lost between aggregate commit and
   queue delivery.

4. **Browser fleet migration:** Swap `LocalChromeAdapter` for `BrowserbaseAdapter`.
   The `BrowserPort` interface is unchanged. Hosted adapter adds: session pool
   management, per-tenant concurrency limits, and automatic cleanup on timeout.

5. **Worker fleet migration:** Temporal already runs locally, so this is a
   scale-out, not a swap. Move from a single local worker against
   `temporal server start-dev` to an auto-scaled worker fleet against a hosted
   Temporal cluster. The workflow and activity definitions are unchanged; there
   is no `InProcessDispatcher` to replace.

6. **Multi-tenancy:** `TenantId` is already a first-class domain concept in
   every aggregate identity, every domain event, and every port call (see
   Sections 4 and 6). Repository adapters enforce isolation via Postgres RLS.
   S3 adapters enforce isolation via tenant-prefixed keys. SQS enforces
   per-tenant ordering via message group IDs.

7. **Auth, billing, audit, secrets:** These are new platform contexts with their
   own bounded context boundaries, not modifications to existing domain
   contexts. They interact through well-defined ports (`EntitlementPort`,
   `SecretPort`, `AuditSink`) and middleware (`TenantContext` injection).

## 9.4 Evolution Triggers (Fitness Functions)

Each local-mode design choice has a **concrete, testable trigger** that
initiates the evolution to its cloud variant. These triggers are the fitness
functions that tell the team *when* to swap adapters — not "when we go to the
cloud" (circular), but measurable conditions.

| Local design choice | Cloud equivalent | Evolution trigger | Notes |
|---|---|---|---|
| SQLite with WAL mode | AWS RDS Postgres 16 + pgbouncer | Concurrent active users > 1 **OR** DB size > 10 GB **OR** multi-process writes required | SQLite's single-writer lock is the hard limit. 10 GB is a practical performance ceiling for WAL mode with full-text queries. |
| In-process synchronous event bus | Transactional outbox + SQS FIFO | Multi-process deployment (> 1 API instance **OR** > 1 worker instance) | In-process dispatch cannot cross process boundaries. The outbox pattern is the minimum viable distributed event bus. |
| Subprocess JSON-RPC (`uv run jobctrl rpc`) | HTTP JSON-RPC to a Python worker service | TypeScript API and worker deployed as separate services **OR** worker fleet > 1 machine | Only the JSON-RPC *transport* changes (subprocess stdio → HTTP POST); the message shapes are identical. Durable workflow execution is already provided locally by Temporal. |
| Local Chrome on CDP ports | Browserbase managed sessions | **Any** cloud deployment | Chrome requires elevated container privileges or `--no-sandbox` (security risk). Browserbase eliminates this entirely. This is a day-1 cloud blocker, not a gradual migration. |
| SQLite Candidate Profile tables | Postgres `profiles` + child profile tables | Multi-tenant deployment **OR** concurrent profile editors | Local SQLite has a single-writer limit; hosted profile editing needs tenant-scoped concurrency control. |
| `LocalFilesystemAdapter` (tailored resumes, PDFs) | S3 with tenant-prefixed keys | Multi-node deployment (no shared filesystem) **OR** artifact size > 1 GB per tenant | Local filesystem doesn't span nodes. |
| macOS Keychain / `.env` | AWS Secrets Manager | Non-macOS deployment **OR** multi-tenant **OR** credential rotation requirement | Keychain is macOS-only. `.env` is unencrypted. |
| `TenantId = "local"` (constant) | `TenantId` from JWT claims | Multi-tenant deployment | Domain types already carry `TenantId`. Only the source of the value changes (constant → JWT). Mechanical change. |
| No auth | Auth0 / Cognito JWT | Any public-facing deployment | Local loopback assumption breaks when API is remotely accessible. |
| No billing / entitlements | Stripe + `EntitlementPort` | First paying customer | Until then, all entitlements return `Allowed`. The `EntitlementPort` exists as a no-op adapter locally. |
| No audit log | Postgres `audit_events` + CloudWatch | First compliance requirement (SOC2, GDPR data access log) | The `AuditSink` port is a no-op locally. |
| HTML/CSS + Playwright resume PDFs | Hosted browser/PDF rendering service | Multi-node deployment **OR** browser sandbox hardening requirement | `PdfRendererPort` absorbs the engine and keeps generated artifacts typed as resume PDFs. |

## 9.5 Cloud Migration Order

When the cloud trigger fires (per §9.4), bounded contexts migrate to their
cloud adapters in a defined order. Migration is **incremental for
reviewability**, not for parallel-path safety: JobCtrl is a single-user
product, so each context cutover is "stop the worker, migrate data, restart
on the new adapter." There is no parallel old/new traffic.

**Migration order (recommended):**

1. **Pipeline Orchestration** — First: the `job_stage_states` table is already
   well-structured and maps cleanly to a standalone repository. Migrate this
   context to Postgres first to establish the RDS infrastructure.

2. **Scoring** — Second: move `job_scores` data into Postgres. Scoring context
   reads and writes Postgres exclusively after the cutover.

3. **Materials Generation** — Third: move `job_materials` and `job_artifacts`
   into Postgres. Artifact storage swaps from local filesystem to S3 in the
   same change.

4. **Job Enrichment** — Fourth: move `job_enrichments` into Postgres. Detail
   fetcher port swaps to Browserbase.

5. **Job Discovery** — Fifth: move the narrowed `jobs` table into Postgres.

6. **Apply Automation** — Sixth: move `job_events` and workflow-run
   projections for apply telemetry into Postgres. Browser port and agent port
   swap to cloud adapters.

7. **Operations** — Last: switches from SQLite read model to Postgres read
   replica once all write-side contexts are on Postgres.

**Per-context cutover:** Each context migration is a single deployment that
stops the worker process, migrates data with a one-shot script, and restarts
on the new adapter. The repository port interface is unchanged; only the
adapter binding changes. There is no dual-publish or dual-write — this is a
single-user system.

---
