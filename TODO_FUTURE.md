# TODO Future

This file tracks work that is important for a production SaaS version of JobHunter, but is not essential for validating the product locally first.

The near-term priority is local product validation:

- make the automation reliable,
- make per-job state visible and recoverable,
- make retries and actions work from the UI,
- keep local profile/style configuration usable,
- avoid rerunning the whole pipeline when one stage fails,
- keep local artifacts easy to inspect.

The items below should not block that local validation loop unless they expose an immediate local correctness or data-loss problem.

## Guiding Rule

Defer SaaS hardening until the local workflow proves that users can reliably discover jobs, enrich them, score them, tailor materials, generate PDFs, and apply or dry-run apply with clear per-job state.

For now, local guardrails are enough:

- do not commit secrets,
- do not commit local profiles, generated resumes, logs, browser profiles, or `.env` files,
- keep generated user data under the local JobHunter app directory,
- make destructive UI actions explicit and reversible where practical,
- preserve enough logs to debug failed automation runs.

## Deferred SaaS Platform Work

### Multi-Tenant Product Model

Deferred until there is a validated local product loop.

Future work:

- tenants,
- users,
- tenant memberships,
- roles,
- invitations,
- tenant-scoped authorization,
- tenant-aware admin tools,
- tenant-aware support tooling.

Why deferred:

Local validation only needs one user and one local workspace. Adding tenancy early would add schema and authorization complexity before the automation is stable.

Revisit when:

- the product has multiple real users,
- team accounts become a requirement,
- hosted storage is introduced,
- support/admin access is needed.

### Authentication And Authorization

Deferred beyond basic local dashboard access.

Future work:

- auth provider integration,
- session management,
- JWT validation,
- CSRF protection for hosted write routes,
- service tokens,
- API keys,
- role-based permissions.

Why deferred:

A local-first dashboard can run on localhost without a full auth system. Authentication becomes mandatory once the product is hosted or remote-accessible.

Revisit when:

- the API is exposed beyond localhost,
- the app is hosted,
- multiple users share infrastructure,
- a browser session can access another user’s data.

### Billing And Subscription Infrastructure

Deferred.

Future work:

- subscription plans,
- checkout,
- invoices,
- payment webhooks,
- trial state,
- usage ledger,
- quotas,
- entitlement checks,
- budget alerts.

Why deferred:

Billing does not help validate whether the automation and product workflow are useful. It should be designed after the usage model is clearer.

Revisit when:

- pricing is defined,
- the product has external beta users,
- LLM or browser automation costs need enforcement,
- subscription access must gate product features.

### Hosted Deployment Architecture

Deferred.

Future work:

- Cloudflare DNS/WAF/CDN setup,
- hosted frontend deployment,
- containerized product API deployment,
- hosted worker deployment,
- managed Postgres,
- managed object storage,
- managed workflow service,
- production observability stack.

Why deferred:

The fastest feedback loop is local. Production deployment choices should follow from a working local workflow and clearer scale constraints.

Revisit when:

- a hosted alpha is planned,
- local-only usage blocks user testing,
- multiple machines need to coordinate workers,
- uptime and backup requirements become real.

## Deferred Data And Storage Hardening

### Postgres Migration

Deferred for local validation.

Future work:

- migrate from SQLite to Postgres,
- introduce stable UUID/ULID job IDs,
- add tenant IDs to product tables,
- add proper indexes for global filtering and sorting,
- add migration tooling from local databases,
- add backup and restore workflows.

Why deferred:

SQLite is acceptable for validating one local user and local automation reliability. The immediate need is a clear state model and reliable retries, not hosted multi-user storage.

Revisit when:

- concurrent workers need stronger coordination,
- query scale becomes a local bottleneck,
- multiple users or tenants are introduced,
- hosted mode begins.

### Object Storage For Artifacts

Deferred.

Future work:

- store generated resumes, cover letters, reports, and logs in object storage,
- replace local file paths with artifact IDs,
- generate signed preview/download URLs,
- version artifacts,
- implement retention policies,
- delete artifact bytes when rows are deleted.

Why deferred:

Local artifact paths are simpler and useful during automation debugging. They should remain acceptable while validating the local workflow.

Revisit when:

- the product is hosted,
- workers run on different machines,
- users need browser downloads from remote storage,
- artifact deletion and retention become compliance requirements.

### Full Secret Vault Integration

Deferred beyond basic local `.env` hygiene.

Future work:

- encrypted secret storage,
- KMS integration,
- provider key rotation,
- job-site credential storage,
- decrypt audit trail,
- per-tenant secret scoping,
- secret access policies.

Why deferred:

Local validation can rely on local environment variables and uncommitted config files. A vault is necessary for SaaS, but it is not needed to prove the automation loop.

Revisit when:

- the product stores secrets for users,
- workers run remotely,
- secrets are shared across services,
- support/admin tooling can access tenant data.

### Production Log Redaction And Retention

Deferred as a full system, but keep basic local hygiene.

Future work:

- structured log redaction,
- prompt/output retention controls,
- encrypted sensitive run artifacts,
- configurable retention windows,
- deletion workflows for logs and generated files,
- audit-safe logging rules,
- PII classification.

Why deferred:

During local automation development, logs are critical for debugging broken browser runs, failed LLM outputs, and bad parsing. Over-redacting too early will slow down reliability work.

Local guardrail:

Do not commit local logs or generated artifacts. Keep them under the local app directory and treat them as private user data.

Revisit when:

- logs leave the user’s machine,
- hosted workers write centralized logs,
- users can download or share run logs,
- deletion and retention policies are required.

### Audit Log

Deferred.

Future work:

- audit profile reads/writes,
- audit artifact downloads,
- audit workflow actions,
- audit secret decrypts,
- audit admin/support access,
- audit external application submissions.

Why deferred:

Local validation does not require a formal audit trail. The user can inspect the local database and files while the product is still local-first.

Revisit when:

- hosted mode starts,
- support/admin access exists,
- sensitive data is accessed by services,
- compliance or account recovery requires traceability.

## Deferred Workflow Infrastructure

### Managed Temporal Or Equivalent Hosted Workflow Engine

Deferred as infrastructure, but not as a design direction.

Future work:

- introduce durable workflow orchestration,
- model job workflows and batch workflows,
- add durable retries, cancellation, and heartbeats,
- separate workflow commands from worker execution,
- expose workflow runs in the UI.

Why deferred:

The immediate local goal is reliable stage boundaries and recoverable state. That can be prototyped with the current process model or a local lightweight queue before committing to hosted workflow infrastructure.

Revisit when:

- local stages are reliable enough to formalize,
- multiple workers need coordination,
- runs need crash recovery,
- hosted execution begins.

### Distributed Worker Fleet

Deferred.

Future work:

- containerize Python workers,
- add worker leases,
- add worker heartbeats,
- add worker identity,
- add per-worker concurrency controls,
- add worker deployment and autoscaling.

Why deferred:

A single local worker process is enough to validate product usefulness and automation reliability.

Revisit when:

- local execution is too slow,
- multiple machines need to run workers,
- hosted users need background processing,
- apply automation needs isolated execution environments.

## Deferred Apply Automation Hardening

### Hosted Browser Isolation

Deferred.

Future work:

- isolate browser profiles per user, tenant, run, and worker,
- decide whether cookies are stored at all,
- define consent boundaries,
- prevent cross-user browser state leakage,
- sandbox hosted apply sessions,
- define cleanup behavior for browser profiles.

Why deferred:

Local validation can use the user’s own machine and browser context. Hosted browser automation is a separate security project.

Revisit when:

- apply automation runs outside the user’s machine,
- browser sessions are stored remotely,
- multiple users share worker infrastructure.

### Hosted Apply Compliance And Safety

Deferred.

Future work:

- confirm acceptable use boundaries,
- require explicit apply confirmation where needed,
- enforce dry-run semantics,
- record verifiable final apply results,
- redact apply logs,
- add apply rate limits,
- add site-specific failure policy.

Why deferred:

Local product validation should focus on whether apply automation can reliably complete or explain failures. Hosted compliance and abuse-prevention controls are necessary later.

Revisit when:

- auto-apply is exposed to external users,
- hosted apply workers are introduced,
- billing depends on submitted applications,
- product risk shifts from local experimentation to real user impact.

## Deferred Product Operations

### Admin And Support Tooling

Deferred.

Future work:

- tenant health views,
- stuck workflow recovery,
- usage inspection,
- support impersonation or scoped access,
- admin action audit logs.

Why deferred:

There are no hosted tenants to support during local validation.

Revisit when:

- external users are onboarded,
- support workflows are required,
- hosted incidents need operational tools.

### Production Observability Stack

Deferred beyond local logs and tests.

Future work:

- OpenTelemetry traces,
- central metrics,
- error tracking,
- LLM tracing with redaction,
- worker dashboards,
- alerting,
- uptime monitoring.

Why deferred:

Local development needs direct logs, test failures, and UI visibility first. Production observability should be added when services are deployed.

Revisit when:

- API and workers are deployed as services,
- failures happen outside a local terminal,
- multiple users depend on the system.

### Data Retention And Deletion Policy

Deferred as a formal policy.

Future work:

- retention windows for generated resumes,
- retention windows for cover letters,
- retention windows for prompts and LLM outputs,
- retention windows for apply logs,
- user-triggered data deletion,
- backup deletion windows,
- tombstones for idempotent deletion.

Why deferred:

Local validation can rely on explicit local cleanup and backups. Formal retention policies become mandatory when the product stores user data remotely.

Revisit when:

- data is stored in hosted infrastructure,
- users need account deletion,
- compliance requirements are defined.

## Keep In Scope For Local Validation

These should not be deferred because they directly affect whether JobHunter works locally:

- per-job state machine clarity,
- stage-level retry and reset behavior,
- reliable dry-run behavior,
- avoiding full-pipeline reruns after one stage fails,
- clear failure messages and next actions,
- local UI buttons for retry/apply/generate actions,
- jobs and artifacts pagination/filtering/sorting in the local UI,
- profile editor usability,
- resume style editor usability,
- local artifact open/preview behavior,
- deterministic PDF generation,
- command/action parity between UI and CLI,
- local tests for dashboard and automation regressions,
- basic guardrails to avoid committing private local data.

## Revisit Trigger

Move items out of this file when one of these becomes true:

- a hosted alpha is planned,
- more than one user needs the same deployment,
- workers run outside the user’s machine,
- user data leaves local storage,
- billing or subscriptions are implemented,
- support/admin access is needed,
- compliance or deletion guarantees are required.
