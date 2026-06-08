# Architecture Research

**Domain:** Grounded resume tailoring inside an existing DDD/hexagonal local-first pipeline (JobHunter Materials context)
**Researched:** 2026-06-08
**Confidence:** HIGH (grounded in the actual codebase: `domain/materials`, `infrastructure/materials`, `apps/api/src/read-model.ts`, `packages/contracts`, `apps/web/src/contexts/materials`)

> This is a **subsequent-milestone** architecture. It does NOT re-derive the eight-context DDD/hexagonal backbone (see `.planning/codebase/ARCHITECTURE.md`). It specifies HOW the three new capabilities — first-class employer analysis, canonical per-bullet provenance, and per-decision tailoring-control records — slot into the **existing Materials and Operations contexts**, cross the existing TS↔Python boundary, and reach the existing materials/apply-review web surfaces.

## Grounding: what already exists (do not rebuild)

The repo already has most of the *shape* this milestone needs — but in the wrong place (transient JSON, not canonical rows). The milestone is largely a **relocation + canonicalization**, not a greenfield build.

| Already exists | Where | The gap this milestone closes |
|----------------|-------|-------------------------------|
| `TailoringPlan` (job keywords, required/seniority evidence ids, verified metrics, target seniority) | `domain/materials/quality.py::build_tailoring_plan` | Computed **transiently** per tailor run, never persisted as an inspectable artifact. Keyword extraction is the **flakey hardcoded stopword/high-signal lists** (`_LOW_SIGNAL_JOB_KEYWORDS`, `_HIGH_SIGNAL_DESCRIPTION_KEYWORDS`). This becomes the persisted **Employer Analysis** artifact, LLM-reasoned. |
| `TailoringChangeAnnotation` (section, change_type, source_text, tailored_text, rationale, job_signals, controls, evidence_ids) | `domain/materials/quality.py::build_tailoring_change_annotations` | Already nearly per-bullet provenance — but stored inside the artifact's `metadata_json` blob and **recomputed/parsed differently in TS vs Python**, with a file-sibling fallback. Becomes **canonical DB rows**. |
| `ArtifactTailoringExplanation` contract (keywords coverage, evidence, judge, adversarial personas, `annotatedChanges`, models) | `packages/contracts/src/schemas.ts:1315` | Read model **re-parses it out of `metadata_json`** and, on miss, **falls back to a sibling file's `metadata_json`** (`read-model.ts::tailoringExplanationForArtifact`, lines 2054-2082); keyword coverage is **recomputed in TypeScript** against `resumeText` (`textCoverage`). This is exactly the CONCERNS.md "synthesized-from-sibling-files" + "projection duplication" risk. Becomes a projection over canonical rows. |
| `job_materials` + `job_materials_artifacts` tables | `database.py::ensure_materials_tables` (1225) | Everything audit-related is `metadata_json TEXT`. **No per-bullet table, no employer-analysis table.** |
| `TailoringPolicy` value object + `tailoring_policies` table + `TailoringPolicyRepository` | `domain/materials/policy.py`, `database.py::ensure_tailoring_policy_tables`, port in `domain/ports/materials.py` | Records the *active policy snapshot* per generation, but **not which rule governed each individual bullet decision**. Becomes per-decision `controls` on each provenance row (the column already exists on `TailoringChangeAnnotation.controls`). |

**Decision driver:** the data structures are already designed correctly in the domain layer. The pathology is that they are serialized into one opaque `metadata_json` per artifact and reconstituted by two divergent readers (Python projection builder + TS `read-model.ts`) plus a filesystem fallback. The milestone's architectural job is to **make the domain structures first-class persisted rows and project them once**, killing the file-heuristic and the TS-side recompute.

## Standard Architecture

### System Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│ BROWSER (apps/web)                                                        │
│  views/jobs/JobDetailDrawer · views/apply-review/ApplyReviewView         │
│  views/artifacts/                                                         │
│      │ composes                                                           │
│  contexts/materials/components/                                          │
│    EmployerAnalysisPanel (NEW)  BulletProvenanceList (NEW)               │
│    TailoringExplanationSection (EXISTS, extend)                          │
│      │ reads via Operations hooks (NEVER apiClient directly)            │
│  contexts/operations/hooks/                                              │
│    useArtifactDetailQuery (EXISTS) → +employerAnalysis +bulletProvenance │
│    useEmployerAnalysisQuery (NEW, optional standalone)                   │
│  contexts/materials/handlers.ts → +EmployerAnalyzed invalidation        │
└───────────────────────────────┬──────────────────────────────────────────┘
              HTTP (typed api-client) │ + SSE invalidation router
┌───────────────────────────────▼──────────────────────────────────────────┐
│ LOCAL API (apps/api) — read side + RPC bridge                            │
│  read-model.ts: artifactDetail → reads PROJECTION rows                   │
│    (REMOVE sibling-file fallback + TS keyword recompute)                 │
│  projections.ts: refresh employer-analysis + provenance projections     │
│  local-actions.ts → RPC: analyze_job / tailor_job (extended)            │
│  contracts: schemas.ts (DTOs) + rpc.ts (methods)                         │
└───────────────────────────────┬──────────────────────────────────────────┘
            JSON-RPC subprocess │ (newline-delimited, contracts/rpc.ts)
┌───────────────────────────────▼──────────────────────────────────────────┐
│ PYTHON WORKER (workers/automation) — DDD + hexagonal                     │
│  pipeline/runner.py: _run_analyze (NEW sub-step) → _run_tailor          │
│  domain/materials/                                                        │
│    EmployerAnalysis aggregate/VO (NEW)   AnalyzeJobUseCase (NEW)         │
│    BulletProvenance entity (NEW)         TailorResumeUseCase (extend:    │
│    use_cases.py (consume analysis)         emit canonical provenance)    │
│    services.py / quality.py (provenance computed vs GENERATED text)      │
│  domain/events/materials.py: +EmployerAnalyzed +BulletProvenanceRecorded│
│  domain/ports/materials.py: +EmployerAnalysisRepository                  │
│  infrastructure/materials/sqlite_repository.py: new tables               │
│  infrastructure/projections/projection_builder.py: project new rows     │
└───────────────────────────────┬──────────────────────────────────────────┘
                                 ▼
        SQLite ~/.jobhunter/jobhunter.db
   job_employer_analysis (NEW, canonical)
   job_bullet_provenance (NEW, canonical, computed vs generated text)
   *_projection rows (NEW read-model)   job_events (audit backbone)
```

### Component Responsibilities

| Component | Responsibility | Typical Implementation |
|-----------|----------------|------------------------|
| `EmployerAnalysis` (NEW aggregate/VO, Materials context) | The persisted "ideal candidate" understanding: role framing, must-have vs nice-to-have requirements with priority/weight, reasoned keywords each tied to a job-description evidence span. Generation-versioned and tied to the enrichment snapshot it was reasoned from. | `domain/materials/employer_analysis.py` — frozen dataclass aggregate, `RequirementItem` / `ReasonedKeyword` value objects, `to_dict`/`from_dict` for the repo |
| `AnalyzeJobUseCase` (NEW use case) | Owns the transaction: load enrichment snapshot, build LLM prompt, parse to structured analysis, persist `EmployerAnalysis`, publish `EmployerAnalyzed`. Replaces `_extract_job_keywords` heuristic. | `domain/materials/use_cases.py` (new class beside `TailorResumeUseCase`), depends on `LlmPort`, `EmployerAnalysisRepository`, `EventPublisher` |
| `BulletProvenance` (NEW entity, Materials context) | One canonical record per generated bullet (and the executive-profile lines): the profile evidence id it came from, the requirement/keyword it serves, transform type, governing control/rule, human rationale. Computed **at generation time against the actual generated bullet text**. | `domain/materials/entities.py` (new entity); a tuple hangs off the `MaterialsSet`/artifact generation |
| `EmployerAnalysisRepository` (NEW port) | Persist/load employer analysis per `(tenant, job_id, generation)`. | `domain/ports/materials.py` protocol; SQLite adapter in `infrastructure/materials/sqlite_repository.py` |
| `TailorResumeUseCase` (EXTEND) | Consume the persisted `EmployerAnalysis` instead of the inline heuristic plan; emit canonical `BulletProvenance` rows + `controls` per bullet; stop relying on `metadata_json` as the audit source of truth. | `domain/materials/use_cases.py` |
| Projection builder (EXTEND) | Project canonical employer-analysis + provenance rows into read-model tables; this is the **single** owner of the inspector read shape. | `infrastructure/projections/projection_builder.py` + parity in `apps/api/src/projections.ts` |
| API read model (EXTEND) | Serve `employerAnalysis` + `bulletProvenance` in `ArtifactDetail`/job-detail from **projection rows only**. Remove sibling-file fallback + TS keyword recompute. | `apps/api/src/read-model.ts` |
| Web inspector (EXTEND) | `EmployerAnalysisPanel` + `BulletProvenanceList` in `contexts/materials/components/`; composed by jobs + apply-review views; consumed via Operations hooks. | `apps/web/src/contexts/materials/` + `views/apply-review`, `views/jobs` |

## Recommended Project Structure (delta only — new/changed files)

```
workers/automation/src/jobhunter/
├── domain/materials/
│   ├── employer_analysis.py      # NEW: EmployerAnalysis aggregate + RequirementItem/ReasonedKeyword VOs
│   ├── entities.py               # EXTEND: BulletProvenance entity (evidence×requirement×transform×control×rationale)
│   ├── use_cases.py              # EXTEND: AnalyzeJobUseCase (NEW); TailorResumeUseCase consumes analysis + emits provenance
│   ├── quality.py                # EXTEND: provenance computed vs GENERATED text; retire _extract_job_keywords heuristic
│   └── value_objects.py          # EXTEND: TransformType, ControlRule enums (closed enumerations)
├── domain/ports/materials.py     # EXTEND: EmployerAnalysisRepository protocol (+ provenance persistence if separate)
├── domain/events/materials.py    # EXTEND: EmployerAnalyzed, BulletProvenanceRecorded payloads + factories
├── infrastructure/materials/sqlite_repository.py  # EXTEND: EmployerAnalysis + BulletProvenance adapters
├── infrastructure/projections/projection_builder.py # EXTEND: project analysis + provenance rows
├── database.py                   # EXTEND: ensure_employer_analysis_tables, ensure_bullet_provenance_tables
├── pipeline/runner.py            # EXTEND: _run_analyze sub-step feeding _run_tailor
└── infrastructure/rpc/handlers.py# EXTEND: analyze_job; tailor_job already exists

packages/
├── contracts/src/schemas.ts      # EXTEND: EmployerAnalysis DTO, BulletProvenance DTO, extend ArtifactTailoringExplanation
├── contracts/src/rpc.ts          # EXTEND: AnalyzeJob method (params/result); tailor methods already present
├── domain-types/src/             # EXTEND: mirror EmployerAnalyzed/BulletProvenanceRecorded event types
└── api-client/src/client.ts      # EXTEND: typed client methods if standalone analysis endpoint added

apps/api/src/
├── read-model.ts                 # EXTEND artifactDetail/jobDetail; REMOVE sibling-file fallback + TS keyword recompute
├── projections.ts               # EXTEND: refresh new projections (parity with Python builder)
└── server.ts                    # EXTEND: route(s) if standalone analysis read endpoint

apps/web/src/
├── contexts/materials/
│   ├── components/EmployerAnalysisPanel.tsx     # NEW (+ .test.tsx + .stories.tsx + .a11y.test.tsx)
│   ├── components/BulletProvenanceList.tsx      # NEW (per-bullet evidence×requirement×control×rationale)
│   ├── components/TailoringExplanationSection.tsx # EXTEND (compose the two new panels)
│   ├── handlers.ts              # EXTEND: EmployerAnalyzed/BulletProvenanceRecorded → invalidation
│   └── queryKeys.ts            # EXTEND if standalone analysis query key needed
├── contexts/operations/hooks/useArtifactDetailQuery.ts # EXTEND result shape
└── contexts/operations/every-event-has-handler.test.ts # parity: must cover new events
```

### Structure Rationale

- **Stays inside Materials + Operations.** Employer analysis is a Materials concern (it exists only to drive tailoring this milestone; cover-letter reuse is explicitly deferred in PROJECT.md). No new bounded context — that would violate the 1:1 backend↔frontend context mirror and the "thin contexts keep their folder" rule.
- **Analysis as a sub-step of tailor, not a new top-level pipeline stage.** The canonical stage order (`discover, enrich, score, tailor, cover, apply`) is mirrored across `state.py`, `pipeline_types.py`, `state_machine.py`, `packages/domain-types/src/pipeline.ts`, `STAGES` in contracts, and the `StageBadge` parity test. Adding a new top-level stage forces a synchronized change across **all** of those plus UI badges — high blast radius for a step that is logically "the front half of tailoring." Model it as `AnalyzeJobUseCase` run at the start of `_run_tailor` (a `_run_analyze` helper), persisted independently so it is inspectable and reusable without re-running the LLM tailor pass. (If product later wants employer analysis to drive scoring/cover too, promoting it to a stage is a clean follow-up.)
- **Canonical rows, not `metadata_json`.** New `job_employer_analysis` and `job_bullet_provenance` tables make every displayed inspector claim have an explicit source of truth (the auditability discipline), and let projections be built deterministically by one owner — eliminating the TS/Python divergence and the sibling-file synthesis.

## Architectural Patterns

### Pattern 1: Persisted analysis artifact feeding tailoring (replace transient plan)

**What:** `AnalyzeJobUseCase` produces and persists an `EmployerAnalysis` aggregate keyed by `(tenant_id, job_id, generation)` and tied to the enrichment snapshot hash it reasoned from. `TailorResumeUseCase` loads it (or triggers it if absent/stale) and uses its reasoned keywords + ranked requirements where today it calls `build_tailoring_plan`'s heuristic `_extract_job_keywords`.

**When to use:** Always, this milestone — it is the root-cause fix for "flakey keywords" and "shallow understanding."

**Trade-offs:** One extra LLM call per tailor (latency/cost — within the existing 180s client budget; cache by snapshot hash so re-tailor on the same posting reuses the analysis). Gains: reproducible, inspectable, evidence-tied keywords; analysis survives independently of any one resume generation.

**Example (Python domain shape):**
```python
@dataclass(frozen=True)
class ReasonedKeyword:
    term: str
    importance: str            # "must_have" | "nice_to_have"
    weight: float              # 0..1 priority
    evidence_span: str         # quoted from the job description — the source of truth
    rationale: str

@dataclass(frozen=True)
class EmployerAnalysis:        # aggregate, generation-versioned like MaterialsSet
    tenant_id: TenantId
    job_id: JobId
    generation: int
    snapshot_hash: str         # ties analysis to the enrichment snapshot it reasoned from
    role_framing: str
    requirements: tuple[RequirementItem, ...]
    keywords: tuple[ReasonedKeyword, ...]
    model: str
    prompt_version: str
    created_at: str
```

### Pattern 2: Canonical per-bullet provenance computed against generated text

**What:** When `TailorResumeUseCase` assembles the final resume text, it emits one `BulletProvenance` row per generated bullet (and executive-profile line), each carrying: `evidence_id` (canonical profile fact), `requirement_id`/`keyword` (from the persisted `EmployerAnalysis`), `transform_type` (closed enum), `control` (the governing rule), `rationale`. Coverage/keyword-match is computed **against the actual generated bullet text**, never inferred from job keywords alone (the auditability rule). Persisted in `job_bullet_provenance`, not in `metadata_json`.

**When to use:** Every accepted resume generation. Reuse the existing `build_tailoring_change_annotations` logic — it already produces `source_text`/`tailored_text`/`rationale`/`controls`/`evidence_ids`; the change is **persist its output as rows** and compute it from the *selected* candidate's rendered text.

**Trade-offs:** New write per generation and a tighter coupling between the assembler and provenance emission. Gains: kills the read-time recompute and the sibling-file fallback; provenance is generation-versioned and superseded with its artifact (mirror `MaterialsSet.supersede_all` / `suppress_active_artifacts` so a failed re-tailor never destroys the last accepted artifact's provenance — the re-tailor auditability rule).

**Example (entity shape):**
```python
@dataclass(frozen=True)
class BulletProvenance:
    bullet_id: str             # stable within (job, generation, section, index)
    section: str               # "executive_profile" | "experience" | "skills"
    source_id: str | None      # experience_entry_id
    evidence_ids: tuple[str, ...]
    requirement_ids: tuple[str, ...]   # FK into EmployerAnalysis.requirements
    matched_keywords: tuple[str, ...]  # verified against generated text
    transform_type: str        # "preserved"|"rephrased"|"reframed"|"drafted_adjacent"
    control: str               # the governing rule that permitted this decision
    rationale: str
    generated_text: str        # the actual rendered bullet — the anchor for coverage
```

### Pattern 3: Per-decision control recording threaded through the use case

**What:** The granular tailoring rules (rephrase always allowed; invention only for closely-related experience; never fabricate metrics/dates) already live as `TailoringPolicy` fields + `claim_mode` + `allow_adjacent_achievement_drafts`. Thread the *resolved* control into each provenance row's `control` field at the point the use case decides what transform a bullet underwent. The aggregate-level `TailoringPolicy` snapshot stays (which policy version produced this generation); the per-row `control` answers "which rule produced *this* bullet."

**When to use:** Whenever a bullet is emitted — the control is determined by the transform applied and the claim mode in force.

**Trade-offs:** Requires the assembler/annotation step to know the governing rule per change (it largely does via `TailoringChangeAnnotation.controls`). Gains: the UI can show "this bullet: rephrased under claim_mode=evidence_reframing" with a DB-backed source.

### Pattern 4: Single-owner projection + remove the file-heuristic read path (rip-and-replace)

**What:** Build the inspector read shape (`employerAnalysis`, `bulletProvenance`, the extended `ArtifactTailoringExplanation.annotatedChanges`) in **one** projection owner (`projection_builder.py`), persisted to read-model tables. `read-model.ts` reads those rows directly. **Delete** `tailoringExplanationForArtifact`'s sibling-file fallback (lines ~2062-2082) and the TypeScript `textCoverage` recompute — per single-user rip-and-replace, no compat shim.

**When to use:** As the canonicalization lands. This directly retires two named CONCERNS.md risks (projection duplication, synthesized-from-sibling-files artifacts).

**Trade-offs:** Projection parity TS↔Python remains a required test surface (CONCERNS.md flags it). Mitigate with a cross-runtime projection fixture for the new tables. Gains: one source of truth; no embarrassing-data masking; no file heuristic.

## Data Flow

### Generation flow (write path)

```
UI "Tailor" / "Retailor"  (contexts/materials button → mutation hook)
  → apps/api/src/local-actions.ts maps to RPC tailor_job/retailor_job
  → json-rpc-adapter.ts → infrastructure/rpc/handlers.py → WorkflowStartSpec
  → pipeline/workflow.py → pipeline/runner.py::_run_tailor
        ├─ _run_analyze: AnalyzeJobUseCase
        │     load enrichment snapshot → LLM reason → EmployerAnalysis
        │     repo.save(analysis) ; publish EmployerAnalyzed
        ├─ TailorResumeUseCase.execute(analysis=...)
        │     candidates → validate → judge → adversarial (UNCHANGED gate)
        │     on accept: assemble text → compute BulletProvenance vs generated text
        │     repo.save(MaterialsSet) ; repo.save(provenance rows)
        │     publish ResumeApproved + BulletProvenanceRecorded
  → in_process_bus fan-out → ProjectionBuilder writes analysis/provenance projections
  → state.py records job_events rows (audit backbone)
```

### Inspector flow (read path)

```
Job detail / Apply-review opens
  → Operations hook useArtifactDetailQuery / useJobDetailQuery (typed api-client)
  → apps/api/src/server.ts route → projections.ts refresh (incremental)
  → read-model.ts artifactDetail:
        employerAnalysis  ← job_employer_analysis projection row
        bulletProvenance  ← job_bullet_provenance projection rows
        tailoringExplanation ← projection (NO sibling-file fallback, NO TS recompute)
  → DTO (contracts/schemas.ts) → api-client → TanStack Query cache
  → contexts/materials components render EmployerAnalysisPanel + BulletProvenanceList
```

### Realtime invalidation flow

```
Python writes job_events (EmployerAnalyzed, BulletProvenanceRecorded, ResumeApproved)
  → event-stream.ts tails job_events → SSE
  → SseEventStreamAdapter → EventStreamProvider → invalidation-router.ts
  → contexts/materials/handlers.ts maps new eventTypes → invalidate artifact/job-detail keys
  → every-event-has-handler.test.ts MUST cover the new DomainEvent arms (compile-time + runtime parity)
```

### Key Data Flows

1. **Analysis → tailoring:** persisted `EmployerAnalysis` replaces the transient heuristic plan; `requirement_id`/keyword references flow into provenance rows so the UI can join bullet → requirement → job-description evidence span.
2. **Generated text → provenance → coverage:** coverage is computed once, server-side, against the selected candidate's rendered text at generation time; the read path never recomputes it (removes the divergent TS `textCoverage`).

## Suggested Build Order (respecting cross-cutting sync rules)

Each step is a vertical slice that keeps the documented sync surfaces consistent. Order is dependency-driven; the auditability/canonical-data rule is honored before any UI work so the UI never masks missing data.

1. **Canonical employer analysis (backend-first vertical).**
   `database.py` table → `EmployerAnalysis` aggregate/VOs + `EmployerAnalysisRepository` port → SQLite adapter → `AnalyzeJobUseCase` + `_run_analyze` in runner → `EmployerAnalyzed` event (Python + `domain-types` mirror) → projection (Python builder + `apps/api/projections.ts` parity) → `read-model.ts` + `schemas.ts` DTO → RPC `analyze_job` (`rpc.ts` + handlers) → Python use-case + projection tests + cross-runtime projection fixture. **Replace** `_extract_job_keywords` heuristic outright (no shim).

2. **Canonical per-bullet provenance (backend-first vertical).**
   `job_bullet_provenance` table → `BulletProvenance` entity + transform/control enums → extend `TailorResumeUseCase` to emit rows computed vs generated text (reuse `build_tailoring_change_annotations`) and consume the persisted analysis → `BulletProvenanceRecorded` event (+ mirror) → projection (both runtimes) → extend `ArtifactTailoringExplanation`/`ArtifactDetail` DTO to read from rows. Generation-version + supersede provenance with its artifact; never destroy the last accepted generation on a failed re-tailor.

3. **Per-decision control wiring.**
   Thread the resolved governing control into each provenance row's `control` field; keep aggregate-level `TailoringPolicy` snapshot. Add fixtures proving the displayed control matches the rule that produced the bullet.

4. **Remove the file-heuristic + TS recompute (rip-and-replace cleanup).**
   Delete `tailoringExplanationForArtifact` sibling-file fallback and the TS `textCoverage` recompute; `read-model.ts` serves projection rows only. Add a regression fixture reproducing the old embarrassing state from canonical data to prove parity.

5. **Inspector UI (frontend vertical).**
   `EmployerAnalysisPanel` + `BulletProvenanceList` in `contexts/materials/components/` (with `.test.tsx`, `.stories.tsx` per state, `.a11y.test.tsx`) → compose into `TailoringExplanationSection`, jobs detail, apply-review → extend `useArtifactDetailQuery` result → `contexts/materials/handlers.ts` invalidation for the new events → `every-event-has-handler.test.ts` parity. Reads only through Operations hooks; no direct `apiClient`.

**Hard sync checklist per step (from `.planning/codebase` architecture rules):**
- New event ⇒ Python factory + persist/publish + `domain-types` mirror + `handlers.ts` + `every-event-has-handler.test.ts`.
- New read-model field ⇒ Python projection builder **and** `apps/api/projections.ts` **and** `read-model.ts` **and** `schemas.ts` **and** web rendering (the projection-duplication trap).
- New RPC ⇒ `contracts/rpc.ts` + `local-actions.ts` + `domain/rpc/messages.py` + `infrastructure/rpc/handlers.py`.
- Do **not** touch the stage enumeration set (analysis is a tailor sub-step, not a new stage) — avoids the 6-surface stage-parity change.

## Anti-Patterns

### Anti-Pattern 1: Keeping audit data in `metadata_json` and parsing it at read time

**What people do:** Add the new analysis/provenance to the artifact's `metadata_json` blob (the path of least resistance, since `tailoring_metadata` already exists).
**Why it's wrong:** Reproduces the exact CONCERNS.md pathology — two divergent readers (Python builder + `read-model.ts`), a filesystem fallback, and read-time recompute. The auditability discipline requires an explicit canonical source per displayed claim.
**Do this instead:** Canonical rows in dedicated tables; one projection owner; read model reads rows.

### Anti-Pattern 2: Inferring keyword "misses" from job keywords instead of generated text

**What people do:** Compute covered/missing keywords by diffing job keywords against the plan.
**Why it's wrong:** Explicitly forbidden by CLAUDE.md — coverage must be computed against the actual generated resume text or recorded at generation time.
**Do this instead:** Compute coverage once, server-side, against the selected candidate's rendered text; persist it on provenance/analysis rows.

### Anti-Pattern 3: Promoting employer analysis to a new top-level pipeline stage now

**What people do:** Add `analyze` to `STAGES` for cleanliness.
**Why it's wrong:** Forces synchronized edits across `state.py`, `pipeline_types.py`, `state_machine.py`, `domain-types/pipeline.ts`, contracts `STAGES`, and the `StageBadge` parity test — large blast radius for a step that is logically the front half of tailoring and scoped resume-only this milestone.
**Do this instead:** `AnalyzeJobUseCase` run as `_run_analyze` inside `_run_tailor`, persisted independently. Promote to a stage later only if scoring/cover need it.

### Anti-Pattern 4: Destroying the last accepted artifact/provenance on re-tailor

**What people do:** Overwrite or delete provenance when a re-tailor runs or fails.
**Why it's wrong:** Violates the re-tailor auditability rule — failed refreshes must remain audit history and must not destroy the current reviewable material.
**Do this instead:** Generation-version analysis + provenance; supersede/suppress like `MaterialsSet` does; surface failed generations as history.

## Integration Points

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Web ↔ API | typed `api-client` over loopback HTTP + SSE | Reads via Operations hooks only; new events flow through invalidation router |
| API ↔ Python | JSON-RPC subprocess (`rpc.ts` ↔ `handlers.py`) | `tailor_job`/`retailor_*` exist; add `analyze_job` if standalone trigger desired. No per-call timeout today (CONCERNS) — keep analysis within existing client budget |
| Tailor sub-step ↔ analysis repo | in-process domain port | `AnalyzeJobUseCase` writes; `TailorResumeUseCase` reads via `EmployerAnalysisRepository` |
| Write side ↔ read side | `job_events` + projections | New events + projections; parity required across TS+Python builders |

### External Services

| Service | Integration Pattern | Notes |
|---------|---------------------|-------|
| LLM provider | `LlmPort.chat_json` with response schema | Analysis is a new structured LLM call; reuse the schema-constrained pattern already used for tailor/judge; cache by snapshot hash to bound cost/latency |
| Langfuse (optional) | OTLP export of prompts/completions | Analysis prompts/responses will be exported when enabled (CONCERNS security note) — same sensitivity posture as existing tailor spans |

## Confidence & Gaps

- **HIGH** on component placement, data flow, and build order — grounded directly in the existing `domain/materials`, contracts, read-model, and web context code.
- **Gap (defer to phase research):** exact provenance granularity for the executive-profile section vs experience bullets, and whether provenance is a child of `MaterialsSet` (saved transactionally with it) or a sibling table keyed by generation — both are viable; transactional-with-aggregate is preferred for consistency. Confirm against `with_resume_attempt` transaction boundary when implementing.
- **Gap:** keyword↔evidence-span linking format (offset vs quoted text) — quoted `evidence_span` is simplest and matches the auditability "explicit source" rule.

## Sources

- `.planning/codebase/ARCHITECTURE.md`, `STRUCTURE.md`, `CONCERNS.md` (existing architecture + tech-debt) — HIGH
- `workers/automation/src/jobhunter/domain/materials/{use_cases.py,quality.py,aggregate.py,value_objects.py}` — HIGH
- `workers/automation/src/jobhunter/domain/events/materials.py`, `database.py::ensure_materials_tables` — HIGH
- `packages/contracts/src/schemas.ts` (`ArtifactTailoringExplanation`), `rpc.ts` (tailor methods) — HIGH
- `apps/api/src/read-model.ts::tailoringExplanationForArtifact` / `parseTailoringExplanation` (sibling-file fallback + TS recompute) — HIGH
- `apps/web/src/contexts/materials/` (existing inspector components) — HIGH
- CLAUDE.md root-cause/auditability discipline; PROJECT.md milestone scope — HIGH

---
*Architecture research for: grounded resume tailoring within JobHunter's Materials/Operations contexts*
*Researched: 2026-06-08*
