# DDD Target-State Migration Plan

## 1. Purpose & Scope

### Purpose

This plan describes the **canonical migration path** from JobHunter's current
architecture to the target-state DDD + Hexagonal Architecture defined in
`docs/ddd-target.md`. It sequences every structural change into independently
shippable PRs that ship green end-to-end after each merge.

JobHunter has a single user; migrations are clean rip-and-replace. Steps remove
the legacy code in the same PR that introduces the replacement. No dual-writes,
no soak periods, no compatibility shims.

The plan covers:

- Introduction of shared domain types and the `TenantId` seam.
- Extraction of bounded contexts: Pipeline Orchestration, Candidate Profile,
  Scoring, Materials Generation, Job Discovery, Job Enrichment, Apply
  Automation, and Operations / Read-Side.
- Domain event infrastructure and the in-process event bus.
- Repository ports and SQLite adapters for every aggregate.
- New normalized tables (`job_scores`, `job_materials`, `job_enrichments`)
  populated from the legacy `jobs` columns, with the legacy columns dropped in
  the same step.
- The JSON-RPC 2.0 integration protocol between the TS API and Python worker.
- TS API hosting simple state-transition commands directly (§6.8).
- TS API read-model projection replacement.

### What This Plan Explicitly Defers

- **Cloud adapter implementations.** No Postgres, S3, SQS, Browserbase,
  Temporal, Auth0, Stripe, or Secrets Manager code is written. Only port
  interfaces are defined; cloud adapters are named and documented for future
  implementation (see Section 7).
- **Multi-tenant enforcement.** `TenantId` lands as a domain type with a
  `"local"` singleton. Isolation policies, RLS, and auth middleware are
  deferred.
- **TypeSpec IDL.** The target names TypeSpec as the contract IDL. This plan
  uses Zod schemas (TS) and frozen dataclasses (Python) for the local-first
  phase. A CI compatibility check validates structural parity between the two.
  TypeSpec adoption is triggered when the CI check fails frequently enough to
  justify single-source generation (see Section 7).
- **Resume rendering spike.** The `PdfRendererPort` is introduced, but the
  adapter stays `LatexPdfAdapter` (current `pdflatex`). The spike comparing
  Tectonic/Typst/HTML-CSS is a separate backlog item.
- **UI/frontend changes.** React component restructuring, TanStack Router
  migration, and frontend tests are out of scope unless a plan step changes an
  API contract that requires a client update.

---

## 2. Plan Principles

JobHunter has a single user; migrations are clean rip-and-replace. Steps remove
the legacy code in the same PR that introduces the replacement. No dual-writes,
no soak periods, no compatibility shims.

1. **Ship-each-PR-green.** Every step is independently shippable. The system
   works end-to-end after every merge. `pnpm test`, `pytest`, and the
   `docs/local-reliability-qa.md` matrix never regress.
2. **One aggregate context per PR.** No step requires coordinated changes
   across more than one bounded context. Each context's extraction lands in a
   single PR that introduces the new aggregate, repository, ports, and removes
   the legacy code path it supersedes.
3. **Evolutionary architecture (cloud).** Cloud adapters are named and
   documented per `docs/ddd-target.md` §9.4 evolution triggers, but not built
   in this plan. The architecture supports later substitution without churn.
4. **Target as contract.** Every step cites the target section it advances.
   Steps that supersede existing decisions in `docs/decisions.md` call it out.
5. **AGENTS.md PR conventions still in force.** Small reviewable PRs,
   conventional commits, doc updates per surface, dedicated worktrees per
   step. The "no compatibility removal" rule from AGENTS.md is waived for
   this plan: every step is explicitly authorized to delete the code it
   replaces.
6. **One aggregate per transaction.** Per §8.1, each command modifies exactly
   one aggregate in a single DB transaction. Cross-aggregate consistency uses
   domain events dispatched after the transaction commits. Every step that
   introduces new write paths must honor this rule.
7. **Idempotent command handlers.** Per §8.2, every stage command, event
   handler, and apply run is idempotent. Steps that add new handlers must
   include deduplication logic (attempt number, event ID, or run ID).

---

## 3. Pre-flight Checks

Before Step S-01 begins:

- [ ] `main` is clean and up to date (`git fetch origin main && git switch main && git pull --ff-only`).
- [ ] `pnpm test` passes on main.
- [ ] `uv --project workers/automation run --extra dev pytest -q` passes on main.
- [ ] `uv --project workers/automation run --extra dev ruff check .` passes on main.
- [ ] `git diff --check` is clean.
- [ ] Team has read `docs/ddd-target.md` end-to-end.
- [ ] Team has read this plan end-to-end.
- [ ] This plan is accepted and merged to `main` under `docs/plans/proposed/`.

---

## 4. Phase Breakdown

### Phase 1: Foundation — Shared Domain Types & TenantId Seam

| Attribute | Value |
|---|---|
| **Theme** | Lay the type foundation that every subsequent phase builds on. |
| **Target sections** | §2 (Modeling Principles), §4.1–4.8 (TenantId in aggregate identities), §6.5 (shared contract). |
| **Exit criteria** | Both TS and Python domain types compile/import. Existing tests pass unchanged. `TenantId("local")` usable in new code. Domain event base type defined. Integration point: at least one existing module can `import` the new types without error (verified by a smoke test in CI). |
| **Effort** | Small — pure additions, no behavioral changes. |
| **Dependencies** | Pre-flight checks. |

### Phase 2: Pipeline Orchestration — State Machine & Repository

| Attribute | Value |
|---|---|
| **Theme** | Formalize the stage state machine as a pure function and extract the first repository port. Pipeline Orchestration is the "spine" every other context depends on. |
| **Target sections** | §3.7, §4.7, §5.7, §8.5, §7.4. |
| **Exit criteria** | `StageStateMachine` has dedicated unit tests covering all transitions from §8.5. `PipelineStateRepository` port + SQLite adapter extracted. `Queued` and `Canceled` states added. All existing state tests pass. |
| **Effort** | Medium — refactors `state.py` (~815 LOC) into domain types + repository + ACL. |
| **Dependencies** | Phase 1 (shared types). |

### Phase 3: Infrastructure Backbone — Events, JSON-RPC & TS Simple Commands

| Attribute | Value |
|---|---|
| **Theme** | Stand up the three infrastructure pillars that all subsequent context extraction depends on: (1) the in-process event bus, (2) the JSON-RPC typed protocol between TS and Python, (3) TS API hosting simple commands directly via the shared state machine. This front-loads the cross-process integration contract so that context-specific phases can wire into an established backbone. |
| **Target sections** | §6.1–§6.4 (event bus), §6.5 (JSON-RPC protocol), §6.8 (TS-hosted commands). |
| **Exit criteria** | Events published through `EventPublisher` port. `job_events.event_type` migrated in-place to PascalCase domain event names. Event watermark stub for projection replay. `jobhunter rpc` subcommand reads JSON-RPC from stdin/stdout. TS API performs `resetJobStage`, `markJobApplied`, `markJobSkipped` via `StageStateMachine` from `@jobhunter/domain-types` — no Python roundtrip. |
| **Effort** | Medium — new infrastructure code, JSON-RPC server, TS write-model rewiring. |
| **Dependencies** | Phase 1 (event base types), Phase 2 (stage event types, state machine). |

### Phase 4: Candidate Profile Context — Aggregate & ProfileSnapshot

| Attribute | Value |
|---|---|
| **Theme** | Replace dict-passing of profile data with typed value objects and a repository port. Deliver `ProfileSnapshot` as published language. |
| **Target sections** | §3.3, §4.3, §5.3. |
| **Exit criteria** | All profile consumers use `ProfileSnapshot`. `ProfileRepository` port + `JsonFileProfileRepository` adapter. `profile.json` format unchanged. |
| **Effort** | Medium — touches every module that reads the profile (tailor, cover, scorer, apply, profile_import). Note: these files will be restructured again in their respective context phases (5–8); this phase only changes how they receive profile data, not their internal wiring. |
| **Dependencies** | Phase 1 (shared types). |

### Phase 5: Scoring Context — Extraction & Ports

| Attribute | Value |
|---|---|
| **Theme** | Separate scoring into its own bounded context with typed value objects, a repository port, and an LLM port. |
| **Target sections** | §3.4, §4.4, §5.4, §7.1 (`job_scores` table), §7.3. |
| **Exit criteria** | Scoring writes to `job_scores` table. `LlmPort` for scoring extracted. Legacy `jobs` scoring columns dropped after backfill. All scoring tests pass. |
| **Effort** | Medium — new table, backfill, refactor `scorer.py`. |
| **Dependencies** | Phase 1, Phase 4 (ProfileSnapshot consumed by scoring). |

### Phase 6: Materials Generation Context — Aggregate & Ports

| Attribute | Value |
|---|---|
| **Theme** | Extract the most painful context — tailor/cover/pdf — into a cohesive aggregate with proper port boundaries. |
| **Target sections** | §3.5, §4.5, §5.5, §7.1 (`job_materials` table), §7.3. |
| **Exit criteria** | `MaterialsSet` aggregate with `Artifact` entity. `ContentValidator`, `ResumeAssembler` as pure domain services. `PdfRendererPort`, `ArtifactStoragePort`, `LlmPort` extracted. New `job_materials` table with backfill. Legacy tailor/cover/pdf columns dropped after backfill. |
| **Effort** | Large — the biggest extraction. `tailor.py` (820 LOC), `cover_letter.py`, `pdf.py` all refactored. |
| **Dependencies** | Phase 1, Phase 3 (event bus), Phase 4 (ProfileSnapshot), Phase 5 (FitScore for eligibility). |

### Phase 7: Discovery & Enrichment Contexts

| Attribute | Value |
|---|---|
| **Theme** | Extract Job Discovery and Job Enrichment into their own bounded contexts with aggregate roots, repositories, and port boundaries. Eliminate cross-context imports. |
| **Target sections** | §3.1, §3.2, §4.1, §4.2, §5.1, §5.2, §7.1, §7.3. |
| **Exit criteria** | `Job` aggregate with `PostingUrl`, `Source`, `Employer` separated. `JobEnrichment` aggregate with `ExtractionTier`. New `job_enrichments` table with backfill. `enrichment/detail.py` no longer imports from `discovery/`. |
| **Effort** | Medium — two simpler contexts, new table for enrichment. |
| **Dependencies** | Phase 1, Phase 3 (event bus). |

### Phase 8: Apply Automation Context — Saga & Ports

| Attribute | Value |
|---|---|
| **Theme** | Extract Apply Automation into its own bounded context with the `ApplyRun` aggregate, browser and agent ports, and a process manager pattern. |
| **Target sections** | §3.6, §4.6, §5.6, §8.3 (Apply saga). |
| **Exit criteria** | `ApplyRun` aggregate with `SubmissionResult` discriminated union. `BrowserPort`, `AutonomousAgentPort` extracted. Apply process manager pattern. `ApplyRunRepository` wrapping existing tables. Apply telemetry unified. |
| **Effort** | Large — `launcher.py` (1300 LOC) refactored. Complex subprocess and browser lifecycle. |
| **Dependencies** | Phase 1, Phase 3 (event bus), Phase 4 (ProfileSnapshot). |

### Phase 9: Operations Read-Side & Projections

| Attribute | Value |
|---|---|
| **Theme** | Replace read-time derivation with event-driven projections. Wire the JSON-RPC adapter into `local-actions.ts` to formalize the TS↔Python transport. |
| **Target sections** | §3.8, §4.8, §5.8, §6.6. |
| **Exit criteria** | `ProjectionBuilder` consuming domain events. TS read-model queries projections instead of raw tables + legacy derivation. `SubprocessJsonRpcAdapter` replaces ad-hoc subprocess spawning in `local-actions.ts`. All QA matrix tests pass. |
| **Effort** | Large — rewrites the TS API's core read path and the TS↔Python transport. |
| **Dependencies** | All previous phases (all contexts must publish events for projections to consume). Phase 3 (JSON-RPC protocol defined). |

---

## 5. Step-by-Step Plan

### Phase 1: Foundation — Shared Domain Types & TenantId Seam

---

#### S-01: feat: add `packages/domain-types` with shared value objects and TenantId

| Attribute | Detail |
|---|---|
| **Phase** | 1 — Foundation |
| **Bounded context** | Cross-cutting |
| **Target sections** | §2 (Modeling Principles — TenantId first-class), §4.1 (TenantId in Job identity), §4.7 (Stage, StageState types). |
| **Pain points** | Briefing #1 (no domain model — this starts one). |

**Files touched:**

- `packages/domain-types/` — **new** package directory.
- `packages/domain-types/package.json` — **new**.
- `packages/domain-types/tsconfig.json` — **new**.
- `packages/domain-types/src/index.ts` — **new** barrel export.
- `packages/domain-types/src/tenant.ts` — **new** `TenantId` value object.
- `packages/domain-types/src/pipeline.ts` — **new** `Stage`, `StageState` discriminated union.
- `packages/domain-types/src/identifiers.ts` — **new** `JobId` branded type.
- `packages/domain-types/src/events.ts` — **new** `DomainEvent` base type.
- `pnpm-workspace.yaml` — **refactor** to add `packages/domain-types`.

**Approach:**
Create a new `packages/domain-types` TypeScript package that owns the shared
domain vocabulary. Define `TenantId` as a branded string type with a
`LOCAL_TENANT` constant (`"local"`). Define `Stage` as a union literal type
(matching existing `STAGES` in `packages/contracts`). Define `StageState` as a
discriminated union (per §8.5 target state machine). Define `JobId` as a
branded string. Define `DomainEvent` as a base interface with `eventType`,
`tenantId`, `occurredAt`, and `payload`. These are pure type definitions with
no runtime behavior. The existing `packages/contracts/src/schemas.ts` `STAGES`
and `STAGE_STATES` arrays remain for Zod validation; `packages/domain-types`
provides the domain-layer types that processing code imports.

**Tenancy implications:** Introduces `TenantId` as a domain type with
`LOCAL_TENANT = "local"` default. No enforcement code.

**Tests added:**
- Unit: `packages/domain-types/test/tenant.test.ts` — `TenantId` creation,
  `LOCAL_TENANT` value.
- Unit: `packages/domain-types/test/pipeline.test.ts` — `Stage` and
  `StageState` type completeness.

**Verification commands:**

```bash
pnpm test
pnpm --filter @jobhunter/domain-types build
pnpm --filter @jobhunter/domain-types test
```

**Risk:** Low. Pure addition. If the package is misconfigured in the pnpm
workspace, other packages won't resolve it. Mitigation: verify with
`pnpm install` and `pnpm test` after creation.

**Dependencies:** None (first step).

**Out of scope:** Runtime validation (Zod schemas stay in `packages/contracts`).
TypeSpec IDL. Cloud adapter types.

---

#### S-02: feat: add Python domain types module with TenantId and stage types

| Attribute | Detail |
|---|---|
| **Phase** | 1 — Foundation |
| **Bounded context** | Cross-cutting |
| **Target sections** | §2 (Modeling Principles), §6.5 (shared contract, Python side). |
| **Pain points** | Briefing #1 (no domain model in the worker). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/` — **new** package directory.
- `workers/automation/src/jobhunter/domain/__init__.py` — **new** barrel.
- `workers/automation/src/jobhunter/domain/tenant.py` — **new** `TenantId` value object.
- `workers/automation/src/jobhunter/domain/pipeline.py` — **new** `Stage`, `StageState` enums/types.
- `workers/automation/src/jobhunter/domain/identifiers.py` — **new** `JobId` type.
- `workers/automation/src/jobhunter/domain/events.py` — **new** `DomainEvent` base dataclass.

**Approach:**
Create `workers/automation/src/jobhunter/domain/` as the Python domain types
package mirroring the TS `packages/domain-types`. `TenantId` is a
`NewType(str)` with a `LOCAL_TENANT` constant. `Stage` is a string enum
matching the TS `Stage` union. `StageState` is defined as frozen dataclasses
for each state variant (Pending, Queued, Running, Succeeded, Failed, Blocked,
Skipped, Exhausted, Stale, Canceled) following the data-orientation principle
from §2. `DomainEvent` is a frozen dataclass base with `event_type`,
`tenant_id`, `occurred_at`, and `payload`. These types are pure data — no I/O
imports, no database imports.

**Tenancy implications:** Same as S-01 — introduces `TenantId` with
`LOCAL_TENANT = "local"`.

**Tests added:**
- Unit: `workers/automation/tests/test_domain_types.py` — `TenantId` creation,
  `Stage` completeness against `state.STAGE_ORDER`, `StageState` variant
  construction.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_domain_types.py -q
uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/domain/
```

**Risk:** Low. Pure addition.

**Dependencies:** None (can run in parallel with S-01).

**Out of scope:** Context-specific value objects. Repository ports. Event bus.

---

#### S-03: feat: add domain event schemas for all bounded contexts

| Attribute | Detail |
|---|---|
| **Phase** | 1 — Foundation |
| **Bounded context** | Cross-cutting |
| **Target sections** | §4.1–§4.8 (all domain event definitions), §6.1 (integration backbone). |
| **Pain points** | Briefing #13 (no event-driven integration — this defines the event vocabulary). |

**Files touched:**

- `packages/domain-types/src/events/` — **new** subdirectory.
- `packages/domain-types/src/events/discovery.ts` — **new** `JobDiscovered`, `JobUpdated`, `JobDeleted`, `JobRestored`.
- `packages/domain-types/src/events/enrichment.ts` — **new** `JobEnriched`, `EnrichmentFailed`.
- `packages/domain-types/src/events/scoring.ts` — **new** `JobScored`, `ScoreCorrected`.
- `packages/domain-types/src/events/materials.ts` — **new** `ResumeApproved`, `ResumeFailed`, `CoverLetterGenerated`, `PdfRendered`, `MaterialsExhausted`.
- `packages/domain-types/src/events/apply.ts` — **new** `ApplicationSubmitted`, `ApplicationFailed`, `ApplyRunStarted`, `ApplyRunEventRecorded`.
- `packages/domain-types/src/events/orchestration.ts` — **new** `StageStarted`, `StageCompleted`, `StageFailed`, `StageExhausted`, `StageReset`, `StageBlocked`, `StageSkipped`.
- `packages/domain-types/src/events/profile.ts` — **new** `ProfileUpdated`, `ProfileImported`.
- `packages/domain-types/src/events/index.ts` — **new** barrel.
- `workers/automation/src/jobhunter/domain/events/` — **new** Python mirror of above.

**Approach:**
Define every domain event from §4.1–§4.8 as a TypeScript interface and a
matching Python frozen dataclass. Each event extends `DomainEvent` (from S-01
and S-02) and adds context-specific fields. All events carry `tenantId` as
mandated by §2. Event names use past tense per §2. Events carry identifiers
(`jobId`, `runId`, `artifactId`) but not file paths (paths are infrastructure
concerns per §4.5 design note). Both language implementations are structurally
parallel; CI will validate they match in a future step.

**CI parity check:** Add `scripts/check-domain-type-parity.sh` (or
`.ts`/`.py`) that verifies TS `packages/domain-types` exports and Python
`jobhunter.domain` exports have matching type names and event field sets.
Fails CI if a type exists in one language but not the other. This serves as
the sensor for the TypeSpec evolution trigger in §7 — without it, two-language
drift (Risk §10.5) can happen silently.

**Tenancy implications:** Every event type includes `tenantId` field.

**Tests added:**
- Unit: `packages/domain-types/test/events.test.ts` — event construction,
  required fields present, `tenantId` always set.
- Unit: `workers/automation/tests/test_domain_events.py` — same for Python.
- CI: `scripts/check-domain-type-parity` — verifies TS and Python domain type
  exports match (type names, event field sets). TypeSpec evolution sensor.

**Verification commands:**

```bash
pnpm test
uv --project workers/automation run --extra dev pytest tests/test_domain_events.py -q
scripts/check-domain-type-parity
```

**Risk:** Low. Only events explicitly listed in §4 sections are defined.

**Dependencies:** S-01 (TS base type), S-02 (Python base type).

**Out of scope:** Event bus wiring. Event persistence changes. Event versioning.

---

### Phase 2: Pipeline Orchestration — State Machine & Repository

---

#### S-04: feat: extract `StageStateMachine` as a pure function with transition tests

| Attribute | Detail |
|---|---|
| **Phase** | 2 — Pipeline Orchestration |
| **Bounded context** | Pipeline Orchestration |
| **Target sections** | §4.7 (`StageStateMachine` domain service), §8.5 (state machine diagram and transition table). |
| **Pain points** | Briefing #1 (no domain model). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/orchestration/` — **new** directory.
- `workers/automation/src/jobhunter/domain/orchestration/__init__.py` — **new**.
- `workers/automation/src/jobhunter/domain/orchestration/state_machine.py` — **new** `StageStateMachine`.
- `packages/domain-types/src/orchestration/state-machine.ts` — **new** TS mirror.

**Approach:**
Extract the stage state transition logic from `state.py`'s `set_stage_state()`
into a pure, standalone `StageStateMachine` module. The machine is a function
`transition(current: StageState, trigger: Trigger) -> StageState | InvalidTransition`.
Implement every row from the §8.5 transition table. Add `Queued` and `Canceled`
to the valid state set. The function has zero I/O. Existing `set_stage_state()`
in `state.py` is NOT changed in this step.

**Tenancy implications:** None — pure logic.

**Tests added:**
- Unit: `workers/automation/tests/test_stage_state_machine.py` — one test per
  transition row in §8.5. Invalid transitions verify rejection.
- Unit: `packages/domain-types/test/state-machine.test.ts` — TS mirror tests.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_stage_state_machine.py -v
pnpm --filter @jobhunter/domain-types test
```

**Risk:** Low. Transition table is well-defined in §8.5.

**Dependencies:** S-01 (StageState types), S-02 (Python StageState types).

**Out of scope:** Wiring into `state.py` (S-06). PipelineScheduler. Streaming mode.

---

#### S-05: feat: define `PipelineStateRepository` port and `SqlitePipelineStateRepository` adapter

| Attribute | Detail |
|---|---|
| **Phase** | 2 — Pipeline Orchestration |
| **Bounded context** | Pipeline Orchestration |
| **Target sections** | §5.7 (`PipelineStateRepository` port), §7.4 (`job_stage_states` mapping). |
| **Pain points** | Briefing #2 (persistence model = domain model). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/orchestration/ports.py` — **new** `PipelineStateRepository` protocol.
- `workers/automation/src/jobhunter/infrastructure/orchestration/` — **new** directory.
- `workers/automation/src/jobhunter/infrastructure/__init__.py` — **new**.
- `workers/automation/src/jobhunter/infrastructure/orchestration/__init__.py` — **new**.
- `workers/automation/src/jobhunter/infrastructure/orchestration/sqlite_pipeline_state.py` — **new** adapter.

**Approach:**
Define `PipelineStateRepository` as a Python `Protocol` with methods:
`get(tenant_id, job_id) -> JobPipelineState | None`,
`save(tenant_id, state: JobPipelineState)`,
`list_by_stage(tenant_id, stage, state_filter?) -> list[JobPipelineState]`.
The port wraps CRUD operations against `job_stage_states`. The
`SqlitePipelineStateRepository` adapter reads/writes the existing
`job_stage_states` table without schema changes.

**Tenancy implications:** Repository accepts `TenantId` but ignores it locally.

**Tests added:**
- Unit: `workers/automation/tests/test_pipeline_state_repository.py` — round-trip
  save/get, list by stage, NULL edge cases.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_pipeline_state_repository.py -q
```

**Risk:** Medium. Complex NULL handling in `job_stage_states`.

**Dependencies:** S-02 (Python domain types), S-04 (StageState types).

**Out of scope:** Wiring into `state.py` (S-06).

---

#### S-06: refactor: wire `state.py` to use `StageStateMachine` and `PipelineStateRepository` internally

| Attribute | Detail |
|---|---|
| **Phase** | 2 — Pipeline Orchestration |
| **Bounded context** | Pipeline Orchestration |
| **Target sections** | §4.7 (orchestration aggregate), §5.7 (repository port). |
| **Pain points** | Briefing #1 (no domain model), #2 (persistence = domain model). |

**Files touched:**

- `workers/automation/src/jobhunter/state.py` — **refactor** to delegate to `StageStateMachine` and `PipelineStateRepository`.

**Approach:**
Refactor `set_stage_state()` to: (1) read current state via repository, (2)
compute new state via `StageStateMachine.transition()`, (3) persist via
repository. External signature unchanged — callers still call
`set_stage_state(job_url, stage, state, **kwargs)`. Invalid transitions now
raise descriptive errors. Default `SqlitePipelineStateRepository` created if
none provided (dependency injection via optional parameter). Per §8.1, each
call modifies only the `JobPipelineState` aggregate in its own transaction.

**Tenancy implications:** `TenantId` parameter added internally with default
`LOCAL_TENANT`.

**Tests added:**
- Integration: update existing state tests to verify transitions through machine.
- Unit: invalid transitions raise errors.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest -q
pnpm test
```

**Risk:** Medium-high. `state.py` is called by every stage module — if the new
machine rejects a transition that the old code silently allowed, every caller
that depends on that path breaks. Mitigation: the parity test in S-04 covers
the §8.5 transition table; if a regression slips through, revert this PR — the
domain types from S-04 stay in place and the next attempt can adjust.

**Dependencies:** S-04 (state machine), S-05 (repository).

**Out of scope:** Refactoring callers.

---

#### S-07: feat: add `Queued` and `Canceled` states to pipeline state model

| Attribute | Detail |
|---|---|
| **Phase** | 2 — Pipeline Orchestration |
| **Bounded context** | Pipeline Orchestration |
| **Target sections** | §8.5 (state machine — both are target states). |
| **Pain points** | Gap: current `STATE_VALUES` lacks `canceled`. |

**Files touched:**

- `workers/automation/src/jobhunter/state.py` — **refactor** add `"queued"` and `"canceled"` to `STATE_VALUES`.
- `workers/automation/src/jobhunter/domain/pipeline.py` — **refactor** add `Queued` and `Canceled` variants.
- `packages/domain-types/src/pipeline.ts` — already includes both (from S-01).
- `packages/contracts/src/schemas.ts` — already includes both in `STAGE_STATES`.
- `workers/automation/src/jobhunter/database.py` — **refactor** document new state values (no schema change; TEXT column).
- `apps/api/src/write-model.ts` — **verify** `cancelJobAction` can use `canceled` state.
- `apps/api/src/read-model.ts` — **verify** state filters handle new values.

**Approach:**
Add `"queued"` and `"canceled"` to `STATE_VALUES` in `state.py`. The
`StageStateMachine` from S-04 already handles transitions. `Queued` is not
actively used yet (no queue infrastructure locally) but must exist for state
machine completeness. `Canceled` enables the cancel action path. Verify
`packages/contracts/src/schemas.ts` already includes both.

**Tenancy implications:** None.

**Tests added:**
- Unit: verify `STATE_VALUES` is a superset of `StageStateMachine` valid states.
- Integration: cancel action path uses `canceled` state.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest -q
pnpm test
```

**Risk:** Low. Adding enum values to a TEXT column is safe.

**Dependencies:** S-04 (state machine), S-06 (state.py refactored).

**Out of scope:** Queue infrastructure. Active `Queued` usage. Cancel for running stages.

---

### Phase 3: Infrastructure Backbone — Events, JSON-RPC & TS Simple Commands

---

#### S-08: feat: define `EventPublisher` port and `InProcessEventBus` adapter

| Attribute | Detail |
|---|---|
| **Phase** | 3 — Infrastructure Backbone |
| **Bounded context** | Cross-cutting |
| **Target sections** | §6.1 (integration backbone), §6.3 (in-process synchronous bus). |
| **Pain points** | Briefing #13 (no event-driven integration). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/ports/__init__.py` — **new** ports package.
- `workers/automation/src/jobhunter/domain/ports/events.py` — **new** `EventPublisher`, `EventSubscriber` protocols.
- `workers/automation/src/jobhunter/infrastructure/events/__init__.py` — **new**.
- `workers/automation/src/jobhunter/infrastructure/events/in_process_bus.py` — **new** `InProcessEventBus`.

**Approach:**
Define `EventPublisher` and `EventSubscriber` protocols. Implement
`InProcessEventBus` as a synchronous singleton. Per §6.3, event dispatch
happens **after** the producing transaction commits — the bus does not own
the transaction. This upholds the one-aggregate-per-transaction rule (§8.1):
each handler runs its own transaction. Handler errors are caught and logged
without breaking other handlers. Per §8.2, handlers must be idempotent.

**Tenancy implications:** Events carry `tenantId` from `DomainEvent` base.

**Tests added:**
- Unit: `tests/test_event_bus.py` — publish, subscribe, handler invocation,
  error isolation.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_event_bus.py -q
```

**Risk:** Low. Simple in-process bus.

**Dependencies:** S-02 (DomainEvent base), S-03 (event schemas).

**Out of scope:** Wiring existing code (S-09). Cloud event bus adapter.

---

#### S-09: refactor: wire `record_job_event` through `EventPublisher` and standardize event types

| Attribute | Detail |
|---|---|
| **Phase** | 3 — Infrastructure Backbone |
| **Bounded context** | Cross-cutting |
| **Target sections** | §6.4 (`job_events` as event store, standardized `event_type`). |
| **Pain points** | Briefing #13 (no event-driven integration). |

**Files touched:**

- `workers/automation/src/jobhunter/state.py` — **refactor** `record_job_event()` to publish through `EventPublisher`.
- `workers/automation/src/jobhunter/infrastructure/events/event_store.py` — **new** handler persisting events to `job_events`.

**Approach:**
Refactor `record_job_event()` to construct typed `DomainEvent` instances and
publish through `InProcessEventBus`. Register a default handler that persists
to `job_events`. Event type values are migrated in-place from snake_case
(`stage_started`) to PascalCase domain event names (`StageStarted`); the same
PR runs a one-shot `UPDATE job_events SET event_type = ...` migration over
existing rows and updates every reader to expect the PascalCase names.
External `record_job_event` signature unchanged.

**Tenancy implications:** Events carry `tenant_id = LOCAL_TENANT`.

**Tests added:**
- Unit: verify `record_job_event` publishes through bus.
- Integration: existing event queries return rows after the rename migration.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest -q
pnpm test
```

**Risk:** Medium. The rename touches every reader of `job_events.event_type`;
if a query is missed, that view goes empty. Mitigation: grep audit for the
old snake_case strings as part of the PR; the migration script is idempotent
so re-running is safe. If a reader is missed in production data, revert the
PR and the migration script is reversible (PascalCase → snake_case is a pure
mapping).

**Dependencies:** S-08 (event bus).

**Out of scope:** Wiring all stage modules to publish typed events directly
(per-context phases).

---

#### S-10: feat: add event watermark tracking for projection reconciliation

| Attribute | Detail |
|---|---|
| **Phase** | 3 — Infrastructure Backbone |
| **Bounded context** | Cross-cutting |
| **Target sections** | §6.3 (crash recovery — startup reconciliation pass). |
| **Pain points** | Briefing #13 (enables future projection replay). |

**Files touched:**

- `workers/automation/src/jobhunter/infrastructure/events/watermark.py` — **new** `WatermarkTracker`.
- `workers/automation/src/jobhunter/database.py` — **refactor** add `event_watermarks` table.

**Approach:**
Add `event_watermarks` table: `(projection_name TEXT PRIMARY KEY, last_event_id INTEGER, updated_at TEXT)`. The `WatermarkTracker` reads and updates watermarks.
Projections (Phase 9) will track their last processed event ID. On startup,
reconciliation replays events with `event_id > last_event_id`. This step only
creates the table and tracker; projection wiring happens in Phase 9.

**Tenancy implications:** None (watermarks are per-projection, not per-tenant locally).

**Tests added:**
- Unit: `test_watermark.py` — read/update watermark, initial watermark is 0.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_watermark.py -q
```

**Risk:** Low. New table, no behavioral change.

**Dependencies:** S-09 (event store wiring).

**Out of scope:** Projection builders (Phase 9). Startup reconciliation loop.

---

#### S-11: feat: define JSON-RPC 2.0 protocol and `jobhunter rpc` subcommand

| Attribute | Detail |
|---|---|
| **Phase** | 3 — Infrastructure Backbone |
| **Bounded context** | Cross-cutting (TS API ↔ Python Worker) |
| **Target sections** | §6.5 (JSON-RPC 2.0 protocol, transport adapters, dispatch modes). |
| **Pain points** | Briefing #7 (no typed contract between TS and Python), #9 (stringly-typed actions). |

**Files touched:**

- `packages/domain-types/src/protocol/` — **new** directory.
- `packages/domain-types/src/protocol/json-rpc.ts` — **new** JSON-RPC request/response types.
- `packages/domain-types/src/protocol/methods.ts` — **new** method definitions (`executeStage`, `importProfile`, etc.).
- `workers/automation/src/jobhunter/rpc/` — **new** directory.
- `workers/automation/src/jobhunter/rpc/__init__.py` — **new**.
- `workers/automation/src/jobhunter/rpc/server.py` — **new** JSON-RPC request handler.
- `workers/automation/src/jobhunter/rpc/methods.py` — **new** method registry.
- `workers/automation/src/jobhunter/cli.py` — **refactor** add `jobhunter rpc` subcommand.

**Approach:**
Define JSON-RPC 2.0 protocol per §6.5. TS types define request/response
envelopes and method-specific params/results. Python implements a
`json_rpc_handler(request_json) -> response_json` dispatcher. Add
`jobhunter rpc` CLI subcommand that reads JSON-RPC from stdin and writes to
stdout (local subprocess transport per §6.5). Three dispatch modes from §6.5:
synchronous (profile_import), fire-and-forget (apply, discover), streaming
(pipeline run). This step does NOT change `local-actions.ts` — that happens
in Phase 9 (S-34). The protocol is front-loaded here so context extraction
phases can define their RPC methods alongside their domain logic.

**Tenancy implications:** All RPC methods accept `tenantId` in params.

**Tests added:**
- Unit: `tests/test_rpc_handler.py` — request parsing, method routing, error
  responses, `tenantId` injection.
- Unit: `packages/domain-types/test/protocol.test.ts` — type validation.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_rpc_handler.py -q
pnpm test
```

**Risk:** Medium. New protocol layer. Mitigation: keep initial method set small.

**Dependencies:** S-01 (TS types), S-02 (Python types).

**Out of scope:** Replacing `local-actions.ts` (S-34, Phase 9). HTTP transport.
Temporal transport.

---

#### S-12: refactor: TS API hosts simple state-transition commands directly

| Attribute | Detail |
|---|---|
| **Phase** | 3 — Infrastructure Backbone |
| **Bounded context** | Pipeline Orchestration (hosted in TS) |
| **Target sections** | §6.8 (TS API write operations — domain logic hosting). |
| **Pain points** | Briefing #7 (roundtrip through Python for simple state changes). |

**Files touched:**

- `apps/api/src/write-model.ts` — **refactor** to use `StageStateMachine` from `@jobhunter/domain-types` for `resetJobStage`, `markJobApplied`, `markJobSkipped`.
- `apps/api/src/contracts.ts` — **refactor** import state machine types.
- `apps/api/package.json` — **refactor** add `@jobhunter/domain-types` dependency.

**Approach:**
Per §6.8, simple state-transition commands (`resetJobStage`, `markJobApplied`,
`markJobSkipped`, `softDeleteJob`, `restoreJob`) are hosted directly in the TS
API. Import `StageStateMachine` from `packages/domain-types` (S-04's TS mirror)
and call `transition()` before writing to `job_stage_states`. Invalid
transitions return typed errors. Complex commands (pipeline run, discovery,
scoring, tailoring, apply) continue to go through Python. This step is
front-loaded alongside JSON-RPC because it establishes the TS↔Python boundary:
simple = TS, complex = Python (via JSON-RPC). The `StageStateMachine` exists
in both TS and Python (hand-mirrored); a CI compatibility check validates they
produce identical transitions for the same inputs.

**Tenancy implications:** State machine accepts `TenantId` (ignored locally).

**Tests added:**
- Unit: `apps/api/test/write-model.test.ts` — valid transitions succeed,
  invalid return error.
- CI: `tests/test_state_machine_parity.ts` — run identical test cases against
  both TS and Python implementations, verify outputs match.
- Regression: `apps/api/test/server.test.ts` — action endpoints unchanged.

**Verification commands:**

```bash
pnpm test
pnpm api:test
```

**Risk:** Medium. Rejecting invalid transitions could break UI flows.
Mitigation: review current `write-model.ts` tests for edge cases.

**Dependencies:** S-04 (StageStateMachine TS mirror), S-01 (TS domain types).

**Out of scope:** Hosting complex commands in TS. TypeSpec IDL.

---

### Phase 4: Candidate Profile Context — Aggregate & ProfileSnapshot

---

#### S-13: feat: define `Profile` aggregate with value objects

| Attribute | Detail |
|---|---|
| **Phase** | 4 — Candidate Profile |
| **Bounded context** | Candidate Profile |
| **Target sections** | §3.3, §4.3 (Profile aggregate, invariants, value objects). |
| **Pain points** | Briefing #8 (profile is dict-passing). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/profile/` — **new** directory.
- `workers/automation/src/jobhunter/domain/profile/__init__.py` — **new**.
- `workers/automation/src/jobhunter/domain/profile/aggregate.py` — **new** `Profile` aggregate root.
- `workers/automation/src/jobhunter/domain/profile/value_objects.py` — **new** `ExperienceEntry`, `EducationEntry`, `SkillCategory`, `TailoringPolicy`, `WritingStyle`, `ApplicationDefaults`, `ExecutiveProfile`, `ResumeConstraints`.
- `workers/automation/src/jobhunter/domain/profile/snapshot.py` — **new** `ProfileSnapshot` published language.

**Approach:**
Define the `Profile` aggregate per §4.3 with value objects. `ProfileSnapshot`
is the published language — a frozen, immutable copy for consumption by
Scoring, Materials, and Apply contexts. The snapshot is hand-mirrored in both
Python (frozen dataclass) and TS (readonly interface in `packages/domain-types`);
a CI check validates structural compatibility. Value objects are designed to
map cleanly to/from `profile.json` schema.

**Tenancy implications:** Profile identity is `(TenantId, ProfileId)`.
`ProfileId = "default"` locally.

**Tests added:**
- Unit: `tests/test_profile_aggregate.py` — invariant enforcement, snapshot
  creation, snapshot immutability.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_profile_aggregate.py -q
```

**Risk:** Low. Pure types.

**Dependencies:** S-02 (Python domain types, TenantId).

**Out of scope:** Repository port and consumer migration (S-14).

---

#### S-14: feat: introduce `ProfileRepository` and switch all consumers to `ProfileSnapshot`

| Attribute | Detail |
|---|---|
| **Phase** | 4 — Candidate Profile |
| **Bounded context** | Candidate Profile (and consumers: Scoring, Materials, Apply) |
| **Target sections** | §3.3 (Conformist relationships), §4.3 (ProfileSnapshot published language), §5.3 (`ProfileRepository` port, `JsonFileProfileRepository` adapter). |
| **Pain points** | Briefing #8 (profile dict-passing), #5 (implicit filesystem I/O). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/profile/ports.py` — **new** `ProfileRepository` protocol.
- `workers/automation/src/jobhunter/infrastructure/profile/` — **new** directory.
- `workers/automation/src/jobhunter/infrastructure/profile/__init__.py` — **new**.
- `workers/automation/src/jobhunter/infrastructure/profile/json_file.py` — **new** `JsonFileProfileRepository`.
- `workers/automation/src/jobhunter/scoring/scorer.py` — **refactor** receive `ProfileSnapshot` only.
- `workers/automation/src/jobhunter/scoring/tailor.py` — **refactor** receive `ProfileSnapshot` only.
- `workers/automation/src/jobhunter/scoring/cover_letter.py` — **refactor** receive `ProfileSnapshot` only.
- `workers/automation/src/jobhunter/apply/launcher.py` — **refactor** receive `ProfileSnapshot` only.
- `workers/automation/src/jobhunter/resume_profile.py` — **refactor** accessors operate on `ProfileSnapshot` (dict path removed).
- `workers/automation/src/jobhunter/profile_import.py` — **refactor** return `Profile` aggregate.
- `workers/automation/src/jobhunter/config.py` — **refactor** `load_profile()` removed; callers go through `ProfileRepository.get_snapshot()`.

**Approach:**
Define `ProfileRepository` Protocol: `get()`, `save()`, `get_snapshot()`. The
`JsonFileProfileRepository` reads/writes `profile.json` (and
`resume_style.json`, `resume_template.tex`). Extra fields not modeled in the
aggregate are preserved on write (forward compatibility). `get_snapshot()`
creates an immutable `ProfileSnapshot`. In the same PR, every caller of the
old `config.load_profile()` raw-dict accessor is converted to receive a
`ProfileSnapshot` from the repository, and `config.load_profile()` is deleted.
Pipeline entry points create the `ProfileSnapshot` once and pass it through.

**Important:** The consumer files modified here (`scorer.py`, `tailor.py`,
`cover_letter.py`, `launcher.py`) will be restructured further in their
respective context phases (5, 6, 8). This step only changes how they receive
profile data — it does not refactor their internal wiring. The dict-passing
path is fully removed in this PR.

**Tenancy implications:** Repository accepts `TenantId` but ignores it locally.
`ProfileSnapshot` carries `tenant_id` (ignored by consumers).

**Tests added:**
- Unit: `tests/test_profile_repository.py` — round-trip, snapshot creation,
  extra fields preserved.
- Unit: update tailor, cover, scorer tests with `ProfileSnapshot` input.
- Integration: profile import → `ProfileSnapshot` → tailor flow.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest -q
```

**Risk:** Medium-high. Touches every profile consumer in one PR — if any caller
is missed, it will fail to import. Mitigation: grep audit for the old
`config.load_profile` symbol in CI; the test suite exercises every consumer
path. Roll back the PR if a hidden caller is discovered after merge.

**Dependencies:** S-13 (Profile aggregate).

**Out of scope:** TS-side profile operations.

---

### Phase 5: Scoring Context — Extraction & Ports

---

#### S-15: feat: define `JobScore` aggregate and scoring value objects

| Attribute | Detail |
|---|---|
| **Phase** | 5 — Scoring |
| **Bounded context** | Scoring |
| **Target sections** | §4.4 (JobScore aggregate, invariants, value objects). |
| **Pain points** | Briefing #12 (cross-context coupling). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/scoring/` — **new** directory.
- `workers/automation/src/jobhunter/domain/scoring/__init__.py` — **new**.
- `workers/automation/src/jobhunter/domain/scoring/aggregate.py` — **new** `JobScore` aggregate.
- `workers/automation/src/jobhunter/domain/scoring/value_objects.py` — **new** `FitScore`, `ScoreBreakdown`, `MatchedKeywords`, `ScoreCorrection`, `ScoringCriteria`.
- `workers/automation/src/jobhunter/domain/scoring/services.py` — **new** `ScoreParser`, `EligibilityChecker`.

**Approach:**
Define `FitScore` as constrained value object (int, [1,10]). `ScoreBreakdown`
replaces raw reasoning strings with `technicalFit`, `experienceFit`,
`reasoning` fields. Extract `_parse_score_response()` from `scorer.py` into
`ScoreParser` domain service. Define `EligibilityChecker` per §4.4.

**Tenancy implications:** `JobScore` identity includes `TenantId`.

**Tests added:**
- Unit: `tests/test_scoring_domain.py` — `FitScore` range, `ScoreParser`
  output, `EligibilityChecker` threshold, aggregate invariants.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_scoring_domain.py -q
```

**Risk:** Low. Pure types.

**Dependencies:** S-02 (domain types).

**Out of scope:** Repository (S-16). LLM port (S-17). Scorer refactor (S-18).

---

#### S-16: feat: add `job_scores` table, `ScoreRepository` port, and SQLite adapter with backfill

| Attribute | Detail |
|---|---|
| **Phase** | 5 — Scoring |
| **Bounded context** | Scoring |
| **Target sections** | §5.4 (`ScoreRepository`), §7.1 (`job_scores` table), §7.2, §7.3. |
| **Pain points** | Briefing #2 (persistence = domain model). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/scoring/ports.py` — **new** `ScoreRepository` protocol.
- `workers/automation/src/jobhunter/infrastructure/scoring/` — **new** directory.
- `workers/automation/src/jobhunter/infrastructure/scoring/sqlite_score.py` — **new** adapter.
- `workers/automation/src/jobhunter/database.py` — **refactor** add `job_scores` table + one-shot backfill migration.

**Approach:**
Add `job_scores` table per §7.2. Idempotent one-shot backfill from the legacy
columns: `INSERT OR IGNORE INTO job_scores SELECT url, 1, fit_score, ... FROM jobs WHERE fit_score IS NOT NULL`. The legacy columns are dropped in S-18
when the scorer is rewired to write only to `job_scores`.

**Tenancy implications:** No `tenant_id` column yet. Port accepts `TenantId`
but adapter ignores it.

**Tests added:**
- Unit: `tests/test_score_repository.py` — save, get, version incrementing,
  backfill from legacy data fixtures.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_score_repository.py -q
```

**Risk:** Medium. Backfill must handle NULL rows.

**Dependencies:** S-15 (JobScore aggregate).

**Out of scope:** Updating `scorer.py` (S-18). TS read-model changes (Phase 9).

---

#### S-17: feat: define `LlmPort` protocol for scoring context

| Attribute | Detail |
|---|---|
| **Phase** | 5 — Scoring |
| **Bounded context** | Scoring |
| **Target sections** | §5.4 (`LlmPort`), §2 (ports own protocol semantics). |
| **Pain points** | Briefing #5 (implicit ports — LLM imported directly). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/ports/llm.py` — **new** `LlmPort` protocol.
- `workers/automation/src/jobhunter/infrastructure/llm/` — **new** directory.
- `workers/automation/src/jobhunter/infrastructure/llm/current_adapter.py` — **new** thin wrapper over `jobhunter.llm.get_client()`.

**Approach:**
Define `LlmPort` as Protocol: `complete(prompt, system, schema) -> str`.
Shared across scoring, materials, and enrichment contexts. `CurrentLlmAdapter`
wraps existing unified LLM client. `llm.py` is left in place because every
adapter currently delegates to it; subsequent context PRs replace direct
`llm.get_client()` callers with `LlmPort` injection.

**Tenancy implications:** None locally. Cloud: LLM gateway accepts `TenantId`.

**Tests added:**
- Unit: `tests/test_llm_port.py` — adapter satisfies protocol, mock test.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_llm_port.py -q
```

**Risk:** Low. Thin wrapper.

**Dependencies:** S-02 (domain types).

**Out of scope:** Per-context LLM config. Cloud LLM gateway.

---

#### S-18: refactor: update `scorer.py` to use scoring domain types, `ScoreRepository`, and `LlmPort`

| Attribute | Detail |
|---|---|
| **Phase** | 5 — Scoring |
| **Bounded context** | Scoring |
| **Target sections** | §3.4, §4.4, §5.4. |
| **Pain points** | Briefing #5 (implicit ports), #12 (cross-context coupling). |

**Files touched:**

- `workers/automation/src/jobhunter/scoring/scorer.py` — **refactor** to write `job_scores` only.
- `workers/automation/src/jobhunter/database.py` — **refactor** drop legacy `fit_score`, `score_reasoning`, `scored_at` columns from `jobs`.
- `apps/api/src/read-model.ts` — **refactor** read scoring fields from `job_scores`.

**Approach:**
Refactor `scorer.py` to use `ProfileSnapshot` (from S-14), `LlmPort` (S-17),
`ScoreParser` (S-15), `ScoreRepository` (S-16), and publish `JobScored` events
via `EventPublisher` (S-08). The scorer writes only to `job_scores`. In the
same PR, drop the legacy `jobs.fit_score`, `jobs.score_reasoning`,
`jobs.scored_at` columns and update `read-model.ts` to read scoring fields
from `job_scores`. Dependency injection via optional parameters with local
defaults. Per §8.2, scoring is idempotent: rescoring the same job creates a
new version.

**Tenancy implications:** Uses `LOCAL_TENANT`.

**Tests added:**
- Unit: update scorer tests to verify `job_scores` populated.
- Integration: mock LLM, verify score → domain → repository flow.
- Integration: read-model returns scoring fields from `job_scores` after the
  column drop.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest -q
pnpm test
```

**Risk:** Medium. The column drop is irreversible without a fresh migration —
if the new repository or read-model query has a bug, scoring values disappear
from the dashboard. Mitigation: the `test_score_repository.py` parity test
from S-16 validates the new repository against the same fixtures the legacy
columns held; if a bug is found post-merge, revert and re-attempt.

**Dependencies:** S-14 (ProfileSnapshot), S-15, S-16, S-17.

**Out of scope:** Score corrections.

---

### Phase 6: Materials Generation Context — Aggregate & Ports

---

#### S-19: feat: define `MaterialsSet` aggregate and materials value objects

| Attribute | Detail |
|---|---|
| **Phase** | 6 — Materials Generation |
| **Bounded context** | Materials Generation |
| **Target sections** | §4.5 (MaterialsSet aggregate, invariants, lifecycle). |
| **Pain points** | Briefing #4 (tailor.py mixed concerns). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/materials/` — **new** directory.
- `workers/automation/src/jobhunter/domain/materials/__init__.py` — **new**.
- `workers/automation/src/jobhunter/domain/materials/aggregate.py` — **new** `MaterialsSet`.
- `workers/automation/src/jobhunter/domain/materials/value_objects.py` — **new** `TailoredResume`, `CoverLetter`, `ValidationResult`, `JudgeVerdict`, `ArtifactType`, `ArtifactStatus`, `RenderFormat`.
- `workers/automation/src/jobhunter/domain/materials/entities.py` — **new** `Artifact` child entity.

**Approach:**
Define `MaterialsSet` with identity `(TenantId, JobId, generation)` per §4.5.
Lifecycle: `ResumeInProgress → ResumeApproved → CoverLetterReady → Complete`.
Invariants from §4.5 enforced: resume before cover, docs before PDF, no banned
words, no fabrication. Generation lifecycle per §4.5: new `MaterialsSet` for
re-tailoring, previous artifacts marked `superseded`.

**Tenancy implications:** Aggregate identity includes `TenantId`.

**Tests added:**
- Unit: `tests/test_materials_domain.py` — lifecycle, invariants, artifact status.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_materials_domain.py -q
```

**Risk:** Low. Pure types.

**Dependencies:** S-02 (domain types).

**Out of scope:** Repository (S-20). Ports (S-21, S-22). Tailor refactor (S-23).

---

#### S-20: feat: add `job_materials` table, `MaterialsRepository` port, and SQLite adapter with backfill

| Attribute | Detail |
|---|---|
| **Phase** | 6 — Materials Generation |
| **Bounded context** | Materials Generation |
| **Target sections** | §5.5, §7.1, §7.3. |
| **Pain points** | Briefing #2 (persistence = domain model). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/materials/ports.py` — **new** `MaterialsRepository`, `ArtifactStoragePort`, `PdfRendererPort` protocols.
- `workers/automation/src/jobhunter/infrastructure/materials/` — **new** directory.
- `workers/automation/src/jobhunter/infrastructure/materials/sqlite_materials.py` — **new** adapter.
- `workers/automation/src/jobhunter/infrastructure/materials/local_storage.py` — **new** `LocalFilesystemAdapter`.
- `workers/automation/src/jobhunter/database.py` — **refactor** add `job_materials` table + `generation` column on `job_artifacts` + backfill.

**Approach:**
Add `job_materials` and one-shot backfill from legacy columns. Add `generation`
column to `job_artifacts` (ALTER TABLE, default 1). Define repository,
artifact storage, and PDF renderer port protocols. `LocalFilesystemAdapter`
wraps current writes to `~/.jobhunter/tailored_resumes/` etc. Legacy
tailor/cover/pdf columns are dropped in S-23 when the tailor pipeline is
rewired to write only to `job_materials`.

**Tenancy implications:** No `tenant_id` column locally.

**Tests added:**
- Unit: `tests/test_materials_repository.py` — save, get, generation, backfill.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_materials_repository.py -q
uv --project workers/automation run --extra dev pytest -q
```

**Risk:** Medium. Backfill NULLs, ALTER TABLE idempotency.

**Dependencies:** S-19 (MaterialsSet aggregate).

**Out of scope:** Tailor/cover/pdf refactoring (S-23, S-24).

---

#### S-21: feat: extract `ContentValidator` and `ResumeAssembler` as pure domain services

| Attribute | Detail |
|---|---|
| **Phase** | 6 — Materials Generation |
| **Bounded context** | Materials Generation |
| **Target sections** | §4.5 (`ContentValidator`, `ResumeAssembler`). |
| **Pain points** | Briefing #4 (tailor.py mixes validation with I/O). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/materials/services.py` — **new** `ContentValidator`, `ResumeAssembler`.
- `workers/automation/src/jobhunter/scoring/validator.py` — **deleted** (logic moved to `ContentValidator`).
- All callers of `scoring/validator.py` — **refactor** to import `ContentValidator` from the materials domain service.

**Approach:**
Move pure validation functions from `scoring/validator.py` into
`ContentValidator` domain service (zero I/O). Move resume assembly logic from
`tailor.py` into `ResumeAssembler`. Delete `scoring/validator.py` and update
every importer in the same PR.

**Tenancy implications:** None.

**Tests added:**
- Unit: `tests/test_content_validator.py` — banned words, fabrication, structure.
- Unit: `tests/test_resume_assembler.py` — header/education injection.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest -q
```

**Risk:** Low-medium. Pure extraction. `scoring/validator.py` deletion in this PR is a hard cut-over — every importer is updated in the same PR, so no shim remains.

**Dependencies:** S-19 (value objects for ValidationResult).

**Out of scope:** None — this is a self-contained extraction.

---

#### S-22: feat: extract `LatexPdfAdapter` and `PlaywrightHtmlPdfAdapter` behind `PdfRendererPort`

| Attribute | Detail |
|---|---|
| **Phase** | 6 — Materials Generation |
| **Bounded context** | Materials Generation |
| **Target sections** | §5.5 (`PdfRendererPort`, adapters). |
| **Pain points** | Briefing #5 (subprocess in business logic). |

**Files touched:**

- `workers/automation/src/jobhunter/infrastructure/materials/latex_pdf.py` — **new** `LatexPdfAdapter`.
- `workers/automation/src/jobhunter/infrastructure/materials/playwright_html_pdf.py` — **new** `PlaywrightHtmlPdfAdapter`.
- `workers/automation/src/jobhunter/scoring/pdf.py` — **deleted** (logic lives in adapters).
- `workers/automation/src/jobhunter/scoring/tailor.py` — **refactor** swap `from .pdf import …` for `PdfRendererPort` injection (rest of the tailor rewrite is S-23).
- `workers/automation/src/jobhunter/scoring/cover_letter.py` — **refactor** swap `from .pdf import …` for `PdfRendererPort` injection (rest is S-24).

**Approach:**
Move `pdflatex` subprocess logic into `LatexPdfAdapter` and Playwright
HTML-to-PDF into `PlaywrightHtmlPdfAdapter`. Delete `scoring/pdf.py` and
update the two callers (`tailor.py`, `cover_letter.py`) to take a
`PdfRendererPort` parameter (default-injected to the appropriate adapter)
instead of importing `scoring/pdf.py`. The rest of the tailor and cover
rewrites — domain types, repository, event publication — stay in S-23 and
S-24 respectively. `PdfRendererPort` absorbs any future rendering spike.

**Tenancy implications:** None.

**Tests added:**
- Unit: `tests/test_pdf_adapters.py` — interface compliance, error handling.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_pdf_adapters.py -q
```

**Risk:** Medium. Subprocess and temp file management.

**Dependencies:** S-20 (PdfRendererPort protocol).

**Out of scope:** Rendering spike. Tectonic/Typst adapters.

---

#### S-23: refactor: update `tailor.py` to use materials domain types, repository, and ports

| Attribute | Detail |
|---|---|
| **Phase** | 6 — Materials Generation |
| **Bounded context** | Materials Generation |
| **Target sections** | §3.5, §4.5, §5.5. |
| **Pain points** | Briefing #4 (tailor.py 820 LOC — main extraction). |

**Files touched:**

- `workers/automation/src/jobhunter/scoring/tailor.py` — **refactor**.
- `workers/automation/src/jobhunter/database.py` — **refactor** drop legacy `tailored_resume_path`, `tailored_at`, `tailor_attempts` columns from `jobs`.
- `apps/api/src/read-model.ts` — **refactor** read tailor fields from `job_materials` + `job_artifacts`.

**Approach:**
Restructure `tailor.py` to use `MaterialsSet` aggregate, `MaterialsRepository`,
`LlmPort`, `PdfRendererPort`, `ArtifactStoragePort`, `ProfileSnapshot`,
`ContentValidator`, `ResumeAssembler`. The tailor writes only to
`job_materials` + `job_artifacts`. In the same PR, drop the legacy
`tailored_resume_path`, `tailored_at`, `tailor_attempts` columns and update
`read-model.ts` to read tailor fields from `job_materials`. Per §8.1, each
tailor invocation modifies only its `MaterialsSet` aggregate; the pipeline
state update happens via a `ResumeApproved` event handler in its own
transaction. Per §8.2, re-tailoring creates a new generation (idempotent for
the same generation).

**Tenancy implications:** Uses `LOCAL_TENANT`.

**Tests added:**
- Integration: mock LLM, verify tailor → validate → store → repository.
- Regression: `test_cover_requirements.py`, `test_pdf_targets.py` must pass.
- Integration: read-model returns tailor metadata from the new tables.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest -q
pnpm test
```

**Risk:** High. Most complex module — and the column drop is irreversible. If
the new aggregate, repository, or read-model query has a bug, tailor metadata
disappears from the dashboard and re-tailoring may produce inconsistent
artifacts. Mitigation: the `test_materials_repository.py` parity test from
S-20 validates round-trip against legacy fixtures; full
`test_cover_requirements.py` and `test_pdf_targets.py` regression suites must
stay green. Revert the PR if a bug is found post-merge.

**Dependencies:** S-14 (ProfileSnapshot), S-19–S-22.

**Out of scope:** Changing prompt logic.

---

#### S-24: refactor: update `cover_letter.py` to use materials domain types and ports

| Attribute | Detail |
|---|---|
| **Phase** | 6 — Materials Generation |
| **Bounded context** | Materials Generation |
| **Target sections** | §3.5, §4.5, §5.5. |
| **Pain points** | Briefing #12 (tailor imports pdf — decoupled here). |

**Files touched:**

- `workers/automation/src/jobhunter/scoring/cover_letter.py` — **refactor**.
- `workers/automation/src/jobhunter/database.py` — **refactor** drop legacy `cover_letter_path`, `cover_letter_at`, `cover_attempts` columns from `jobs`.
- `apps/api/src/read-model.ts` — **refactor** read cover-letter fields from `job_materials` + `job_artifacts`.

**Approach:**
Same pattern as S-23: `cover_letter.py` receives `ProfileSnapshot`, uses
`LlmPort`, validates with `ContentValidator`, stores via
`ArtifactStoragePort`, updates `MaterialsSet`, publishes events. PDF
rendering is delegated to `PdfRendererPort` (the implementation lives in the
adapters introduced in S-22). In the same PR, drop the legacy
`cover_letter_path`, `cover_letter_at`, `cover_attempts` columns and update
`read-model.ts` to read cover-letter fields from `job_materials`.

**Tenancy implications:** Uses `LOCAL_TENANT`.

**Tests added:**
- Regression: `test_cover_requirements.py`, `test_pdf_targets.py`.
- Integration: mock LLM, verify cover → validate → store flow.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest -q
pnpm test
```

**Risk:** Medium. Cover and PDF are simpler than tailor, but the column drop
is irreversible. Mitigation: same fixture-based parity tests as S-23; revert
the PR if dashboard cover metadata regresses.

**Dependencies:** S-23 (tailor refactored first; same column-drop pattern).

**Out of scope:** Rendering spike.

---

### Phase 7: Discovery & Enrichment Contexts

---

#### S-25: feat: define `Job` aggregate and discovery value objects

| Attribute | Detail |
|---|---|
| **Phase** | 7 — Discovery & Enrichment |
| **Bounded context** | Job Discovery |
| **Target sections** | §3.1, §4.1. |
| **Pain points** | Briefing #1 (no domain model). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/discovery/` — **new** directory.
- `workers/automation/src/jobhunter/domain/discovery/aggregate.py` — **new** `Job` aggregate.
- `workers/automation/src/jobhunter/domain/discovery/value_objects.py` — **new** `PostingUrl`, `Source`, `Employer`, `SearchStrategy`, `JobMetadata`.
- `workers/automation/src/jobhunter/domain/discovery/ports.py` — **new** `JobRepository`, `JobBoardScraperPort` protocols.

**Approach:**
Define `Job` aggregate per §4.1: identity `(TenantId, JobId)`. `Employer`
separated from `Source` (maps `jobs.company` to `Employer.name`, `jobs.site`
to `Source.board`). URL remains temporary `JobId` (stable `jobKey` deferred).
`JobBoardScraperPort` defined for future adapter extraction.

**Tenancy implications:** Aggregate includes `TenantId`.

**Tests added:**
- Unit: `tests/test_discovery_domain.py` — aggregate creation, invariants,
  Employer ≠ Source.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_discovery_domain.py -q
```

**Risk:** Low. Pure types.

**Dependencies:** S-02.

**Out of scope:** `JobId` migration. Discovery module refactoring. The
`SqliteJobRepository` adapter is deferred — the existing `jobs` table and
`database.py` queries serve as the implicit adapter until Discovery is fully
extracted. See §7 Out-of-Scope.

---

#### S-26: feat: define `JobEnrichment` aggregate, `job_enrichments` table, and adapter with backfill

| Attribute | Detail |
|---|---|
| **Phase** | 7 — Discovery & Enrichment |
| **Bounded context** | Job Enrichment |
| **Target sections** | §3.2, §4.2, §5.2, §7.1, §7.3. |
| **Pain points** | Briefing #12 (enrichment imports discovery). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/enrichment/` — **new** directory.
- `workers/automation/src/jobhunter/domain/enrichment/aggregate.py` — **new** `JobEnrichment`.
- `workers/automation/src/jobhunter/domain/enrichment/value_objects.py` — **new** VOs.
- `workers/automation/src/jobhunter/domain/enrichment/ports.py` — **new** `EnrichmentRepository`, `DetailPageFetcherPort`.
- `workers/automation/src/jobhunter/infrastructure/enrichment/sqlite_enrichment.py` — **new** adapter.
- `workers/automation/src/jobhunter/database.py` — **refactor** add `job_enrichments` table + backfill.

**Approach:**
Add `job_enrichments` table and one-shot backfill from legacy columns.
`JobEnrichment` aggregate per §4.2 with `EnrichmentAttempt` child entities.
`DetailPageFetcherPort` abstracts the three-tier extraction cascade. The
legacy `full_description`, `application_url`, `detail_scraped_at`,
`detail_error` columns on `jobs` are dropped in S-27 when `enrichment/detail.py`
is rewired to write only to `job_enrichments`.

**Tenancy implications:** Aggregate includes `TenantId`.

**Tests added:**
- Unit: `tests/test_enrichment_domain.py`, `tests/test_enrichment_repository.py`.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_enrichment_domain.py tests/test_enrichment_repository.py -q
```

**Risk:** Medium. Backfill NULL handling.

**Dependencies:** S-02.

**Out of scope:** Refactoring `detail.py` (S-27). Decoupling discovery imports.

---

#### S-27: refactor: decouple `enrichment/detail.py` from `discovery/` imports and wire ports

| Attribute | Detail |
|---|---|
| **Phase** | 7 — Discovery & Enrichment |
| **Bounded context** | Job Enrichment |
| **Target sections** | §3.2 (boundary — eliminate cross-context coupling). |
| **Pain points** | Briefing #12 (detail.py imports discovery/smartextract and discovery/jobspy). |

**Files touched:**

- `workers/automation/src/jobhunter/enrichment/detail.py` — **refactor** remove discovery imports.
- `workers/automation/src/jobhunter/infrastructure/enrichment/playwright_fetcher.py` — **new** `PlaywrightDetailPageFetcher`.

**Approach:**
Extract shared functionality into `DetailPageFetcherPort` adapter. Proxy
parsing moves to adapter internals. After this step, `detail.py` imports only
from `jobhunter.domain/` and `jobhunter.infrastructure/enrichment/`. Writes
go only to `job_enrichments` via repository; events published via
`EventPublisher`. In the same PR, drop the legacy `full_description`,
`application_url`, `detail_scraped_at`, `detail_error` columns from `jobs`,
and update `apps/api/src/read-model.ts` to read enrichment fields from
`job_enrichments`.

**Tenancy implications:** Uses `LOCAL_TENANT`.

**Tests added:**
- Unit: verify no imports from `jobhunter.discovery.*`.
- Regression: enrichment state tests pass.
- Integration: read-model returns enrichment fields from `job_enrichments`
  after the column drop.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest -q
pnpm test
python -c "import ast; tree = ast.parse(open('workers/automation/src/jobhunter/enrichment/detail.py').read()); imports = [n for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))]; assert not any('discovery' in (getattr(n, 'module', '') or '') for n in imports), 'Cross-context import found'"
```

**Risk:** Medium. `detail.py` is 950 LOC and the column drop is irreversible.
If the new `EnrichmentRepository` or read-model query has a bug, enrichment
metadata disappears from the dashboard. Mitigation: the
`test_enrichment_repository.py` parity test from S-26 covers round-trip
against legacy fixtures; revert the PR if regression is observed.

**Dependencies:** S-26 (enrichment domain types and repository).

**Out of scope:** Refactoring discovery modules. Extraction algorithm changes.

---

### Phase 8: Apply Automation Context — Saga & Ports

---

#### S-28: feat: define `ApplyRun` aggregate and apply domain types

| Attribute | Detail |
|---|---|
| **Phase** | 8 — Apply Automation |
| **Bounded context** | Apply Automation |
| **Target sections** | §3.6, §4.6 (ApplyRun aggregate, SubmissionResult). |
| **Pain points** | Briefing #4 (launcher.py 1300 LOC), #10 (telemetry split). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/apply/` — **new** directory.
- `workers/automation/src/jobhunter/domain/apply/aggregate.py` — **new** `ApplyRun`.
- `workers/automation/src/jobhunter/domain/apply/value_objects.py` — **new** `SubmissionResult` (discriminated union), `BrowserWorkerConfig`, `ApplyPrompt`, `TokenUsage`.
- `workers/automation/src/jobhunter/domain/apply/services.py` — **new** `ApplyEligibilityChecker`.
- `workers/automation/src/jobhunter/domain/apply/ports.py` — **new** `BrowserPort`, `AutonomousAgentPort`, `ApplyRunRepository`.

**Approach:**
Define `ApplyRun` aggregate per §4.6 with `SubmissionResult` discriminated
union. Enforce invariants: valid `JobId`, materials present, one `in_progress`
per job, dry run never marks applied. Per §8.2, apply runs use `run_id` as
idempotency key with upsert semantics.

**Tenancy implications:** Aggregate includes `TenantId`.

**Tests added:**
- Unit: `tests/test_apply_domain.py` — lifecycle, SubmissionResult, eligibility,
  dry-run invariant.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_apply_domain.py -q
```

**Risk:** Low. Pure types.

**Dependencies:** S-02.

**Out of scope:** Launcher refactoring (S-30). Process manager (S-31).

---

#### S-29: feat: extract `LocalChromeAdapter` and `ClaudeCodeCliAdapter` behind ports

| Attribute | Detail |
|---|---|
| **Phase** | 8 — Apply Automation |
| **Bounded context** | Apply Automation |
| **Target sections** | §5.6 (`BrowserPort`, `AutonomousAgentPort`, seam justification). |
| **Pain points** | Briefing #5 (Chrome and Claude Code subprocess in business logic). |

**Files touched:**

- `workers/automation/src/jobhunter/infrastructure/apply/` — **new** directory.
- `workers/automation/src/jobhunter/infrastructure/apply/local_chrome.py` — **new** `LocalChromeAdapter`.
- `workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py` — **new** `ClaudeCodeCliAdapter`.
- `workers/automation/src/jobhunter/infrastructure/apply/sqlite_apply_run.py` — **new** `SqliteApplyRunRepository`.
- `workers/automation/src/jobhunter/apply/chrome.py` — **deleted** (Chrome lifecycle moved to `LocalChromeAdapter`).
- `workers/automation/src/jobhunter/apply/launcher.py` — **refactor** swap `from .chrome import …` for `BrowserPort` / `AutonomousAgentPort` injection (the rest of the launcher rewrite is S-30).

**Approach:**
Move Chrome lifecycle from `apply/chrome.py` into `LocalChromeAdapter`. Move
Claude Code subprocess logic into `ClaudeCodeCliAdapter`. Delete
`apply/chrome.py` and update `launcher.py` to receive injected
`BrowserPort` / `AutonomousAgentPort` instances (default-bound to the local
adapters). `SqliteApplyRunRepository` wraps existing `apply_runs` +
`apply_run_events` tables (already well-structured per §7.4).

**Tenancy implications:** None locally.

**Tests added:**
- Unit: `tests/test_apply_adapters.py` — interface compliance, repository
  round-trip.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_apply_adapters.py -q
```

**Risk:** Medium. Chrome and subprocess management are complex.

**Dependencies:** S-28 (apply domain types).

**Out of scope:** Launcher refactoring (S-30). Cloud adapters.

---

#### S-30: refactor: update `launcher.py` to use apply domain types, repository, and ports

| Attribute | Detail |
|---|---|
| **Phase** | 8 — Apply Automation |
| **Bounded context** | Apply Automation |
| **Target sections** | §3.6, §4.6, §5.6, §6.7 (apply result reporting). |
| **Pain points** | Briefing #4 (launcher.py 1300 LOC), #10 (telemetry split), #12 (coupling). |

**Files touched:**

- `workers/automation/src/jobhunter/apply/launcher.py` — **refactor**.

**Approach:**
Refactor `launcher.py` to use `ApplyRun` aggregate, `BrowserPort`,
`AutonomousAgentPort`, `ApplyRunRepository`, `ProfileSnapshot`,
`EventPublisher`. Rich dashboard continues working (presentation adapter).
Telemetry writes go through `ApplyRunRepository`. Per §8.1, launcher modifies
only the `ApplyRun` aggregate; pipeline state updated via
`ApplicationSubmitted` event handler. In the same PR, drop the legacy
`applied_at`, `apply_status`, `apply_error`, `apply_attempts`, `agent_id`
columns from `jobs` and update `apps/api/src/read-model.ts` to read apply
fields from `apply_runs`. DI with defaults.

**Tenancy implications:** Uses `LOCAL_TENANT`.

**Tests added:**
- Regression: `test_apply_regressions.py`.
- Unit: mock ports, verify apply flow with domain types.
- Integration: read-model returns apply fields from `apply_runs` after the
  column drop.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest -q
pnpm test
```

**Risk:** High. Most complex module — Chrome lifecycle, Claude Code subprocess,
and telemetry all change in one PR, plus the column drop is irreversible. If
the new repository or read-model query has a bug, apply status disappears
from the dashboard or the launcher fails to start a run. Mitigation: full
`test_apply_regressions.py` must stay green; the apply-run repository
fixtures from S-29 cover round-trip parity. Revert the PR if a regression is
observed.

**Dependencies:** S-14 (ProfileSnapshot), S-28, S-29.

**Out of scope:** Process manager (S-31). Dashboard refactoring.

---

#### S-31: feat: formalize apply process manager with compensation actions

| Attribute | Detail |
|---|---|
| **Phase** | 8 — Apply Automation |
| **Bounded context** | Apply Automation |
| **Target sections** | §8.3 (apply saga / process manager). |
| **Pain points** | Briefing #4 (apply business rules tangled with infrastructure). |

**Files touched:**

- `workers/automation/src/jobhunter/domain/apply/process_manager.py` — **new** `ApplyProcessManager`.

**Approach:**
Formalize the apply flow from §8.3 as `ApplyProcessManager`: AcquireJob →
LaunchBrowser → StartAgent → Monitoring → ParseResult → Cleanup → Report.
Compensation actions: Chrome failure → cleanup + report; timeout → kill + cleanup;
crash recovery → detect orphaned `in_progress` runs → transition to `failed`
with `ORPHANED` error. `launcher.py` from S-30 is updated in the same PR to
delegate to the new process manager.

**Tenancy implications:** None.

**Tests added:**
- Unit: `tests/test_apply_process_manager.py` — happy path, browser failure,
  timeout, orphaned run detection.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_apply_process_manager.py -q
```

**Risk:** Low. Pure addition.

**Dependencies:** S-28, S-29.

**Out of scope:** Full `launcher.py` rewrite. Temporal workflow.

---

### Phase 9: Operations Read-Side & Projections

---

#### S-32: feat: define read-model projections and `ProjectionBuilder`

| Attribute | Detail |
|---|---|
| **Phase** | 9 — Operations & Projections |
| **Bounded context** | Operations / Read-Side |
| **Target sections** | §3.8, §4.8, §6.6. |
| **Pain points** | Briefing #11 (state derivation duplicated in TS). |

**Files touched:**

- `workers/automation/src/jobhunter/infrastructure/operations/` — **new** directory.
- `workers/automation/src/jobhunter/infrastructure/operations/projection_builder.py` — **new** `ProjectionBuilder`.
- `workers/automation/src/jobhunter/infrastructure/operations/projections.py` — **new** projection definitions.
- `workers/automation/src/jobhunter/database.py` — **refactor** add projection tables.

**Approach:**
Add `job_list_view` and `dashboard_stats` projection tables.
`ProjectionBuilder` subscribes to domain events from `InProcessEventBus` and
updates projections. One-time backfill populates from existing data. On
startup, replays from watermark (S-10). Per §8.2, projection updates are
idempotent (check `eventId` watermark). The TS read-model swap to query the
projections is S-33.

**Tenancy implications:** Not tenant-scoped locally.

**Tests added:**
- Unit: `tests/test_projection_builder.py` — event → projection for each type.

**Verification commands:**

```bash
uv --project workers/automation run --extra dev pytest tests/test_projection_builder.py -q
```

**Risk:** Medium. Projection correctness depends on all events handled.

**Dependencies:** S-08, S-09, S-10, all event publishers from Phases 5–8.

**Out of scope:** TS read-model changes (S-33). Event streaming to frontend.

---

#### S-33: refactor: update TS `read-model.ts` to query projections and use shared domain types

| Attribute | Detail |
|---|---|
| **Phase** | 9 — Operations & Projections |
| **Bounded context** | Operations / Read-Side |
| **Target sections** | §3.8, §5.8, §6.6. |
| **Pain points** | Briefing #6 (two writers one DB), #11 (duplicated state derivation). |

**Files touched:**

- `apps/api/src/read-model.ts` — **refactor** to query projection tables.
- `apps/api/src/contracts.ts` — **refactor** import shared types.

**Approach:**
Rewrite `read-model.ts` queries to use `job_list_view` and `dashboard_stats`
projections. Replace the legacy state-derivation code path with simple
SELECTs against the projection tables. Import `Stage`, `StageState` from
`@jobhunter/domain-types`. The legacy derivation code is deleted in this PR.
The S-32 backfill ensures projections are non-empty on first deploy.

**Tenancy implications:** Types include `TenantId` for future use.

**Tests added:**
- Integration: existing read-model tests pass with projection-backed queries.
- Unit: assert legacy derivation helpers are removed (`grep` check in CI).

**Verification commands:**

```bash
pnpm test
pnpm api:test
```

**Risk:** High. Core read path — if a projection is missing data the S-32
backfill should have populated, the dashboard goes blank. Mitigation: the
S-32 step ships its own backfill verification; this PR includes a smoke test
that compares row counts in `job_list_view` against expected values from
`jobs` joined with `job_stage_states`. Revert if mismatch is found.

**Dependencies:** S-32 (projections), S-01 (shared types).

**Out of scope:** Event streaming.

---

#### S-34: refactor: replace `local-actions.ts` subprocess spawning with JSON-RPC adapter

| Attribute | Detail |
|---|---|
| **Phase** | 9 — Operations & Projections |
| **Bounded context** | Cross-cutting (TS API ↔ Python Worker) |
| **Target sections** | §6.5 (SubprocessJsonRpcAdapter). |
| **Pain points** | Briefing #7 (no typed contract), #9 (stringly-typed actions). |

**Files touched:**

- `apps/api/src/local-actions.ts` — **refactor** to use `SubprocessJsonRpcAdapter`.
- `apps/api/src/json-rpc-adapter.ts` — **new** `SubprocessJsonRpcAdapter`.

**Approach:**
Create `SubprocessJsonRpcAdapter` that spawns `uv run jobhunter rpc` (S-11),
writes JSON-RPC request to stdin, reads response from stdout. Replace
`defaultActionDispatcher` outright; the old ad-hoc subprocess dispatcher is
deleted in this PR. For fire-and-forget (apply, retry-stage), spawn detached
and return `runId`. For synchronous (profile_import), wait for response.
`buildActionResponse` is updated to consume the JSON-RPC response shape.

**Tenancy implications:** JSON-RPC requests include `tenantId: "local"`.

**Tests added:**
- Integration: action endpoints work with JSON-RPC.
- Unit: `apps/api/test/json-rpc-adapter.test.ts` — request/response handling.

**Verification commands:**

```bash
pnpm test
pnpm api:test
```

**Risk:** Medium-high. Every action endpoint switches transport in one PR; if
the JSON-RPC adapter has a bug, every action button fails. Mitigation: the
S-11 RPC server has its own integration tests; this PR covers each method via
`apps/api/test/json-rpc-adapter.test.ts`. Revert the PR if any action
regresses.

**Dependencies:** S-11 (JSON-RPC server).

**Out of scope:** HTTP JSON-RPC transport. Temporal transport.

---

#### S-35: docs: update architecture, domain-model, and decisions for DDD migration

| Attribute | Detail |
|---|---|
| **Phase** | 9 — Operations & Projections |
| **Bounded context** | Documentation |
| **Target sections** | All — documentation sweep. |
| **Pain points** | None — documentation hygiene. |

**Files touched:**

- `docs/architecture.md` — **refactor** reflect hexagonal architecture.
- `docs/domain-model.md` — **refactor** reference `docs/ddd-target.md`.
- `docs/decisions.md` — **refactor** add DDD migration ADRs.
- `docs/local-reliability-qa.md` — **refactor** update QA matrix.
- `docs/backlog.md` — **refactor** mark completed, add discovered items.
- `docs/delivered.md` — **refactor** add migration PR entries.

**Approach:**
Comprehensive documentation update per AGENTS.md requirements. New ADR
entries: DDD + Hexagonal adopted, TenantId introduced, domain events as
integration backbone, JSON-RPC protocol, projection-based read model.

**Tests added:** None.

**Verification commands:**

```bash
git diff --check
```

**Risk:** Low. Documentation only.

**Dependencies:** All previous steps.

**Out of scope:** This plan is not moved to `docs/plans/implemented/` until
all steps are delivered.

---

## 6. Cross-Cutting Workstreams

### 6.1 TenantId Rollout

| Step | What it does |
|---|---|
| S-01 | Introduces `TenantId` type in TS with `LOCAL_TENANT`. |
| S-02 | Introduces `TenantId` type in Python with `LOCAL_TENANT`. |
| S-03 | All domain events carry `tenantId`. |
| S-05 | `PipelineStateRepository` port accepts `TenantId`. |
| S-11 | JSON-RPC methods accept `tenantId` in params. |
| S-12 | TS write-model passes `TenantId` to state machine. |
| S-14 | `ProfileRepository` port accepts `TenantId`. |
| S-16 | `ScoreRepository` port accepts `TenantId`. |
| S-20 | `MaterialsRepository` port accepts `TenantId`. |
| S-26 | `EnrichmentRepository` port accepts `TenantId`. |
| S-29 | `ApplyRunRepository` port accepts `TenantId`. |

### 6.2 Domain Event Bus Introduction

| Step | What it does |
|---|---|
| S-08 | Defines `EventPublisher` port and `InProcessEventBus`. |
| S-09 | Wires `record_job_event` through the bus. Standardizes event types (snake_case → PascalCase rename migration). |
| S-10 | Adds event watermark tracking for projection reconciliation. |
| S-18 | Scoring publishes `JobScored` events. |
| S-23 | Materials publishes `ResumeApproved`, `ResumeFailed` events. |
| S-24 | Materials publishes `CoverLetterGenerated`, `PdfRendered` events. |
| S-27 | Enrichment publishes `JobEnriched`, `EnrichmentFailed` events. |
| S-30 | Apply publishes `ApplicationSubmitted`, `ApplicationFailed` events. |
| S-32 | `ProjectionBuilder` subscribes to all events. |

### 6.3 Repository Extraction Per Aggregate

| Aggregate | Port Step | Adapter Step | Table |
|---|---|---|---|
| `JobPipelineState` | S-05 | S-05 | `job_stage_states` (existing) |
| `Profile` | S-14 | S-14 | `profile.json` (existing) |
| `JobScore` | S-16 | S-16 | `job_scores` (new) |
| `MaterialsSet` | S-20 | S-20 | `job_materials` (new) + `job_artifacts` (existing) |
| `JobEnrichment` | S-26 | S-26 | `job_enrichments` (new) |
| `ApplyRun` | S-29 | S-29 | `apply_runs` + `apply_run_events` (existing) |
| `Job` (Discovery) | S-25 | Deferred | `jobs` (existing, narrowed) |

### 6.4 Stage State Machine Consolidation

| Step | What it does |
|---|---|
| S-04 | Defines `StageStateMachine` as pure function in Python and TS. |
| S-06 | Wires `state.py` to use the state machine internally. |
| S-07 | Adds `Queued` and `Canceled` states. |
| S-12 | TS write-model uses TS state machine for transition validation. |

### 6.5 TS↔Python Typed Application Protocol

| Step | What it does |
|---|---|
| S-11 | Defines JSON-RPC 2.0 protocol and `jobhunter rpc` subcommand. |
| S-12 | TS API hosts simple commands directly (no Python roundtrip). |
| S-34 | Replaces `local-actions.ts` with `SubprocessJsonRpcAdapter`. |

### 6.6 Apply Saga / Process Manager

| Step | What it does |
|---|---|
| S-28 | Defines `ApplyRun` aggregate with `SubmissionResult`. |
| S-29 | Extracts `BrowserPort` and `AutonomousAgentPort`. |
| S-30 | Wires `launcher.py` to use domain types and ports. |
| S-31 | Formalizes apply process manager with compensation actions. |

### 6.7 Documentation and ADR Updates

| Step | What it does |
|---|---|
| S-35 | Comprehensive documentation update. New ADR entries. |

Note: Per AGENTS.md, individual PRs for steps S-04 through S-34 should include
narrow doc updates for the specific surfaces they change. S-35 is the final
sweep that ensures consistency across all docs.

---

## 7. Out-of-Scope (Deferred)

Each item below is explicitly deferred. The evolution trigger from §9.4 is
cited where applicable.

| Deferred item | Target section | Evolution trigger (§9.4) | Notes |
|---|---|---|---|
| `PostgresJobRepository` and all Postgres adapters | §5.1–5.8 | Concurrent users > 1 OR DB > 10 GB OR multi-process writes | Ports defined; only SQLite adapters implemented. |
| `S3ArtifactAdapter` | §5.5 | Multi-node deployment OR artifact > 1 GB/tenant | `ArtifactStoragePort` defined in S-20. |
| `SqsEventPublisher` + transactional outbox | §6.3 | Multi-process deployment (> 1 API or worker) | `EventPublisher` defined in S-08. |
| `BrowserbaseAdapter` | §5.6 | Any cloud deployment (day-1 blocker) | `BrowserPort` defined in S-28. |
| `ClaudeApiAgentAdapter` | §5.6 | Worker fleet > 1 machine | `AutonomousAgentPort` defined in S-28. |
| `TemporalWorkflowAdapter` | §5.7 | Worker fleet > 1 machine OR pipeline > 30 min | `StageCommandDispatcher` port deferred; pipeline.py remains procedural. |
| Auth0 / Cognito JWT | §9 | Any public-facing deployment | `TenantId` seam in place from Phase 1. |
| Stripe billing / `EntitlementPort` | §9 | First paying customer | No-op adapter not yet created. |
| Audit log / `AuditSink` | §9 | First compliance requirement (SOC2, GDPR) | No-op adapter not yet created. |
| AWS Secrets Manager / `SecretPort` | §9 | Non-macOS deployment OR multi-tenant OR credential rotation | macOS Keychain / `.env` unchanged. |
| TypeSpec IDL | §6.5 | `scripts/check-domain-type-parity` (S-03) fails frequently | Zod + frozen dataclasses + CI check for now. |
| `JobId` migration (URL → UUID) | §4.1 | Product decision on deduplication strategy | Open question in §10. URL remains PK. |
| Score correction feedback loop | §4.4 | Product decision on personalization | Open question in §10. |
| Resume rendering spike | §5.5 | Blocked on spike results OR cloud (TeX Live 4 GB) | `PdfRendererPort` defined; `LatexPdfAdapter` stays. |
| Event streaming to frontend (SSE/WS) | §3.8 | Product decision on UX approach | Open question in §10. |
| `StageCommandDispatcher` port | §5.7 | Pipeline refactoring beyond scope | `pipeline.py` remains procedural. |
| Materialized `job_list_view` replacing all `jobs` reads | §4.8, §6.6 | All contexts publishing events reliably | Projections in S-32; full replacement deferred. |
| `pdflatex` → Tectonic/Typst | §5.5 | Rendering spike conclusion OR cloud deployment | `PdfRendererPort` absorbs any engine. |
| `TenantId` from JWT (multi-tenant) | §9 | Multi-tenant deployment | Domain types carry TenantId; only source changes (constant → JWT). |
| No-op `EntitlementPort` adapter | §9 (Billing) | Feature gate before first paying customer | All entitlements return `Allowed` locally. |

---

## 8. QA & Reliability Gates

### Phase 1: Foundation

- **QA addition:** None. Pure types. Existing tests pass unchanged.
- **Integration point:** Verify at least one existing module imports from the new
  domain types package without error.
- **Verification:** `pnpm test`, `pytest -q`.

### Phase 2: Pipeline Orchestration

- **QA addition:** `test_stage_state_machine.py` — comprehensive transition
  table coverage. Add to `docs/local-reliability-qa.md` matrix:
  "State machine rejects invalid transitions" → `test_stage_state_machine.py`.
- **Verification:** `pnpm test`, `pytest -q`.

### Phase 3: Infrastructure Backbone

- **QA addition:** `test_event_bus.py`, `test_watermark.py`,
  `test_rpc_handler.py`, `apps/api/test/write-model.test.ts` (transition
  validation). State machine parity test (TS vs Python).
  Add to matrix: "Events persist through bus" → `test_event_bus.py`.
  "JSON-RPC roundtrip" → `test_rpc_handler.py`.
  "TS/Python state machine parity" → `test_state_machine_parity.ts`.
- **Verification:** `pnpm test`, `pytest -q`.

### Phase 4: Profile

- **QA addition:** `test_profile_aggregate.py`, `test_profile_repository.py`.
  Existing profile import tests must pass. Add:
  "Profile snapshot preserves all fields" → `test_profile_repository.py`.
- **Verification:** `pytest -q`.

### Phase 5: Scoring

- **QA addition:** `test_scoring_domain.py`, `test_score_repository.py`. Add:
  "Scores written to and read from `job_scores`" → `test_score_repository.py`.
- **Verification:** `pnpm test`, `pytest -q`.

### Phase 6: Materials

- **QA addition:** `test_materials_domain.py`, `test_materials_repository.py`,
  `test_content_validator.py`, `test_resume_assembler.py`,
  `test_pdf_adapters.py`. Existing `test_cover_requirements.py` and
  `test_pdf_targets.py` must pass. Add: "Materials written to and read from
  `job_materials`" → `test_materials_repository.py`.
- **Verification:** `pnpm test`, `pytest -q`.

### Phase 7: Discovery & Enrichment

- **QA addition:** `test_discovery_domain.py`, `test_enrichment_domain.py`,
  `test_enrichment_repository.py`. Add: "No cross-context imports" → S-27 import audit.
- **Verification:** `pnpm test`, `pytest -q`.

### Phase 8: Apply

- **QA addition:** `test_apply_domain.py`, `test_apply_adapters.py`,
  `test_apply_process_manager.py`. Existing `test_apply_regressions.py` must
  pass. Add: "Apply compensation cleans up browser" →
  `test_apply_process_manager.py`.
- **Verification:** `pnpm test`, `pytest -q`.

### Phase 9: Operations & Projections

- **QA addition:** `test_projection_builder.py`, `apps/api/test/json-rpc-adapter.test.ts`.
  All existing API tests must pass.
  Add: "Projections match legacy read model" → comparison test.
- **Full QA gate:** `pnpm test`, `pnpm qa:test`, `pytest -q`, `ruff check .`,
  `git diff --check`, browser smoke (per `docs/local-reliability-qa.md`).

---

## 9. Documentation Plan

| Step | Docs updated | What changes |
|---|---|---|
| S-01 | None | Pure addition. |
| S-04 | None | Internal domain logic. |
| S-06 | `docs/architecture.md` | Note state machine formalization. |
| S-07 | `docs/domain-model.md` | Add `Queued` and `Canceled` to canonical states. |
| S-08 | `docs/architecture.md` | Note event bus introduction. |
| S-11 | `docs/architecture.md`, `docs/decisions.md` | JSON-RPC protocol ADR. |
| S-12 | `docs/decisions.md` | TS-hosted commands ADR. |
| S-14 | None | Internal refactor. |
| S-16 | `docs/architecture.md` | Note `job_scores` table. |
| S-18 | `docs/decisions.md` | New ADR: "Scoring context with repository port." |
| S-20 | `docs/architecture.md` | Note `job_materials` table. |
| S-26 | `docs/architecture.md` | Note `job_enrichments` table. |
| S-33 | `docs/architecture.md` | Projection-based read model. |
| S-35 | All docs | Comprehensive final sweep. |

**New ADR entries** (in `docs/decisions.md`):

1. "DDD + Hexagonal Architecture adopted" — date of S-35 merge.
2. "TenantId introduced as domain type" — date of S-01 merge.
3. "Domain events as integration backbone" — date of S-08 merge.
4. "JSON-RPC 2.0 as TS↔Python protocol" — date of S-11 merge.
5. "TS API hosts simple state-transition commands" — date of S-12 merge.
6. "Projection-based read model" — date of S-33 merge.

**Superseded decisions:**
- "Stage State Is The Operational Source Of Truth" (2026-05-02) is **advanced,
  not superseded** — state machine formalization (S-04–S-07) strengthens it.

---

## 10. Worktree & Branching Convention

Per AGENTS.md:

- **Every step = one worktree = one PR.** S-01 through S-35 each get a dedicated
  worktree on their own branch.
- Branch naming: `ddd/s-{step_number}-{short-description}` (e.g.,
  `ddd/s-01-domain-types`, `ddd/s-04-state-machine`).
- Worktree created from up-to-date `main`.
- Never edit code on `main`.
- Each step is one PR with a conventional-commits title.
- Steps within the same phase are stacked PRs (each rebased on the previous
  step's merge to `main`).
- Steps in different phases that have no dependency can run in parallel.

**Parallel execution opportunities:**

- S-01 and S-02 (TS and Python types are independent).
- S-13 and S-15 (Profile and Scoring aggregates depend only on S-02).
- S-25, S-26, and S-28 (Discovery, Enrichment, and Apply aggregates are
  independent, all depend only on S-02).

The canonical execution order is the step numbering (S-01 → S-35).

---

## 11. Glossary Diff

**Terms introduced by this plan:**

| Term | Definition |
|---|---|
| `LOCAL_TENANT` | The constant `TenantId` value (`"local"`) used in local-first mode. |
| `packages/domain-types` | New TS package for shared domain value objects, event schemas, and state machine types. |
| `jobhunter.domain` | New Python package for domain types, aggregates, value objects, and ports. |
| `jobhunter.infrastructure` | New Python package for adapter implementations (SQLite, filesystem, LLM, browser). |
| `jobhunter.rpc` | New Python package for JSON-RPC request handling. |
| `InProcessEventBus` | The local-first synchronous event bus adapter for `EventPublisher`. |
| `WatermarkTracker` | Infrastructure component tracking per-projection event processing progress. |
| `ProjectionBuilder` | Infrastructure component subscribing to events and updating read-model projections. |
| `SubprocessJsonRpcAdapter` | TS adapter that spawns `jobhunter rpc` and communicates via JSON-RPC over stdin/stdout. |
| `CurrentLlmAdapter` | Thin adapter wrapping `jobhunter.llm.get_client()` behind `LlmPort`. |

**Renaming from current code:**

| Current name | Target name | Step |
|---|---|---|
| `state.STATE_VALUES` tuple | `Stage` enum + `StageState` discriminated union | S-02, S-04 |
| `state.STAGE_ORDER` tuple | `Stage` enum with canonical order | S-02 |
| `config.load_profile()` → raw dict | `ProfileRepository.get_snapshot()` → `ProfileSnapshot` | S-14 |
| `record_job_event()` with string event_type | `EventPublisher.publish()` with typed `DomainEvent` | S-08, S-09 |
| `_parse_score_response()` in scorer.py | `ScoreParser` domain service | S-15 |
| `defaultActionDispatcher` in local-actions.ts | `SubprocessJsonRpcAdapter` | S-34 |
