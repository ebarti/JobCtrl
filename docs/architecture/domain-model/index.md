# Domain Model (DDD)

The canonical DDD + hexagonal architecture the implementation realises (see
`docs/plans/implemented/2026-05-06-ddd-migration.md` for the delivery record).
Section numbering (§1–§11) is preserved across the subpages because code
comments cite it:

- [3. Strategic Design — Bounded Contexts](strategic.md)
- [4. Tactical Design](tactical.md)
- [5. Hexagonal Architecture — Ports & Adapters](ports.md)
- [6. Cross-Context Integration](integration.md)
- [7–8. Persistence, Consistency & Failure Modes](persistence.md)
- [9. Cloud Deployment Architecture](cloud.md)
- [10–11. Risks & Glossary](reference.md)

## 1. Purpose & Non-Goals

### Purpose

This document defines the **canonical domain architecture** for JobHunter,
modeled with Domain-Driven Design (DDD) and Hexagonal Architecture (Ports &
Adapters). It is the authoritative reference for:

- Bounded context boundaries and their relationships
- Aggregate design with invariants and lifecycle rules
- Domain events and cross-context integration contracts
- Port interfaces and adapter seams for all I/O
- The typed integration protocol between the TypeScript API and Python worker
- Persistence boundary design that decouples domain types from storage schema

Every modeling choice includes rationale so a senior engineer joining the team
can re-derive the decision independently.

> **Status — realised, not aspirational.** The DDD + hexagonal domain model in
> this document is implemented in the codebase; the migration that landed it is
> recorded in `docs/plans/implemented/2026-05-06-ddd-migration.md`. Read this as
> a description of the **current** architecture with named hosted seams, not a
> future target. One seam has since crossed from "hosted-future" to "local-now":
> **Temporal is the local orchestrator today** — workflows and activities run
> against a local `temporal server start-dev`, not a cloud-only engine (see
> `docs/architecture.md` and `docs/job-pipeline-architecture.md`). The remaining
> hosted seams named in Section 9 (Postgres, S3, SQS FIFO, Auth0/Cognito,
> Browserbase, Secrets Manager) are still named-not-built.

**Cloud deployment is a hard requirement.** Local-first mode is a validation
gate, not the end state. Every decision in this document is designed
to ship to a hosted multi-tenant cloud deployment. Section 9 remains the target
for those not-yet-built seams; it is no longer accurate for Temporal, which is
already the local execution engine.

### Non-Goals

- **Project history.** This document does not prescribe file moves, PR
  sequences, or rollout phases. Plan records live under `docs/plans/`.
- **Implementation code.** Pseudocode sketches appear where they aid clarity; no
  production code is included.
- **Deployment topology.** Kubernetes manifests, Terraform modules, CI/CD
  pipelines, and region selection are infrastructure engineering, not domain
  modeling. Section 9 names the concrete services and seams but does not design
  the deployment.
- **UI/frontend architecture.** React component structure, state management
  libraries, and routing are not modeled. The Operations context covers
  read-model projections that feed the UI.
- **LLM prompt engineering.** Prompt content for scoring, tailoring, and cover
  letter generation is domain knowledge but not architectural modeling.

---

## 2. Modeling Principles

### DDD Principles Applied

| Principle | How we apply it |
|---|---|
| **Ubiquitous Language** | Every bounded context defines its own glossary. The same term (e.g., "Job") means different things in Discovery vs. Scoring. Code, docs, and UI use identical terminology within each context. |
| **Aggregates chosen by transactional consistency** | An aggregate boundary encloses exactly the data that must be consistent within a single transaction. Cross-aggregate consistency uses domain events and eventual consistency. |
| **Entities have identity; Value Objects have equality-by-value** | `Job` is an entity (identity by `JobId`). `FitScore` is a value object (a score of 8 is the same regardless of where it was computed). |
| **Domain Events are immutable facts** | Named in past tense (`JobDiscovered`, `ResumeApproved`). They record *what happened*, not *what to do*. They are the primary integration mechanism between bounded contexts. |
| **Domain depends on nothing** | Domain types and logic have zero imports from infrastructure (no SQLite, no HTTP, no filesystem). All I/O crosses a port boundary. |
| **Repositories abstract persistence** | Each aggregate root has a repository port. The domain sees an in-memory collection illusion; the adapter translates to SQLite/Postgres/filesystem. |
| **Tenant identity is a first-class domain concept** | Every aggregate identity is scoped by `TenantId`. Every domain event carries `tenantId`. Every repository query, every event publication, every projection is tenant-scoped. In local-first mode, `TenantId` is a singleton constant (`local`); in hosted mode it is the authenticated user's tenant. The domain carries `TenantId`; adapters enforce isolation. |

### Hexagonal Architecture Principles Applied

| Principle | How we apply it |
|---|---|
| **Ports own protocol semantics** | A port defines *what* the application needs (e.g., `LlmPort.complete(prompt, schema) -> Result`) — not *how* it's implemented (Gemini, OpenAI, local). |
| **Adapters are replaceable** | Every driven port has at least two plausible adapters: a local-first adapter (today) and a hosted adapter (SaaS future). The domain is untouched when swapping. |
| **Driving ports are use cases** | Application services expose use cases (`ScoreJob`, `TailorResume`, `SubmitApplication`). External callers (CLI, API, test harness) drive through these ports. |
| **Anti-Corruption Layers guard context boundaries** | When integrating with external systems (job boards, LLM APIs, ATS portals), an ACL translates external models into domain types at the boundary. |

### Evolutionary Architecture

This architecture follows **evolutionary architecture** as the meta-principle.
The cloud target is non-negotiable, but the architecture lets us walk there one
well-defined step at a time — it does not arrive on day one.

> Evolutionary architecture means cloud adapters are named-not-built; local
> implementations stay compact behind ports until a concrete fitness function
> calls for a hosted adapter.

| Principle | How we apply it |
|---|---|
| **Name the evolution, do not pre-build it** | Every driven port names its cloud adapter and technology. No cloud adapter is implemented until the evolution trigger fires. Local adapters stay minimal. |
| **Local-mode adapters stay simple** | Local adapters do not carry hosted concerns (auth context propagation, distributed tracing, tenant enforcement). They accept `TenantId` as a parameter but ignore it. Cloud machinery is absent from local code. |
| **Fitness functions trigger evolution** | Every major design choice has a concrete, testable trigger (Section 9.4). "When concurrent users > 1" is a fitness function; "when we go to the cloud" is not. |
| **Independent context evolution** | Each bounded context's adapters can be swapped independently. Discovery can use Postgres while Scoring remains on SQLite. Section 9.5 describes context-by-context cloud cutover order. |
| **Deliberate trade-offs** | Where we choose local simplicity over cloud-ready flexibility, we name it as a **Trade-off** with the upgrade path documented. We do not pretend the local choice IS the cloud choice. |

### Data-Orientation (Hickey / Wlaschin)

- **Immutable values over mutable objects.** Domain events, value objects, and
  command results are immutable data. Aggregates are the only mutable concept,
  and their mutations are expressed as event emissions.
- **Make illegal states unrepresentable.** Stage state transitions are modeled as
  a sum type / discriminated union — not nullable columns. A job cannot
  simultaneously be `Running` and `Succeeded`.
- **Functions transform data.** Scoring, tailoring, and cover letter generation
  are pure functions `(Input, Profile, Config) -> Result` with I/O pushed to
  the edges via ports.

---
