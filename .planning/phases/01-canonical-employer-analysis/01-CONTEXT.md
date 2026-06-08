# Phase 1: Canonical Employer Analysis - Context

**Gathered:** 2026-06-08
**Status:** Ready for planning

<domain>
## Phase Boundary

Deliver a reasoned, reproducible, **persisted** employer "ideal candidate" analysis that becomes the single source of truth driving all downstream tailoring, replacing the flakey hardcoded `_extract_job_keywords` heuristic.

The analysis is produced by a **3-way agent-SDK ensemble** (Claude Agent SDK + Codex SDK + Antigravity SDK) whose outputs are merged and synthesized into one canonical record. It contains structured requirements (must-have vs nice-to-have + priority weight), reasoned keywords each tied to a quoted job-description evidence span, role framing, and an inferred ideal-candidate narrative. It is persisted as canonical DB rows, cached by snapshot+version, and served through the canonical read path (projection + DTO, TS↔Python parity).

**In scope:** the new analysis call + its persistence + cache + canonical read path + the `analyze_job` trigger, and retiring `_extract_job_keywords`.
**Out of scope (later phases):** per-bullet provenance/grounding (Phase 2), voice pass + final audit (Phase 3), read-model cleanup (Phase 4), inspector UI (Phase 5). Migrating *existing* LLM stages (scoring/tailor/judge/voice) onto agent SDKs is **not** in this phase.

Requirements covered: ANALYSIS-01, ANALYSIS-02, ANALYSIS-03, ANALYSIS-04, ANALYSIS-05, ANALYSIS-06.
</domain>

<decisions>
## Implementation Decisions

### AI Execution Model — agent SDKs only (PROJECT-LEVEL directive)
- **D-01:** All **new** AI usage goes through **agent SDKs**, never raw model APIs. The existing hand-rolled `jobhunter.llm.LLMClient` (httpx over OpenAI-compat + Gemini-native) is **not** the path for new work. This is a project-wide standard going forward.
- **D-02:** Existing, out-of-scope LLM usages (scoring, current tailor/judge/voice, etc.) are **left untouched** this phase — no strangler, no forced migration. They migrate to agent SDKs in their own future work.
- **D-03:** The Phase 1 employer-analysis call runs through **all three SDKs**: **Claude Agent SDK**, **Codex SDK**, **Antigravity SDK**. The point is to mix three diverse models to get better data.
- **D-04:** Auth posture (as stated by the user):
  - Claude Agent SDK → the active Claude Code session / sign-in (already authenticated).
  - Antigravity SDK → `GOOGLE_APPLICATION_CREDENTIALS` (Google application credentials).
  - Codex SDK → existing authenticated subscription.
  - Do **not** introduce metered per-token API-key paths for these; use the SDKs' own auth.
- **D-05:** Supersedes PROJECT.md's current LLM constraint ("default to latest Claude models… keep provider selection explicit… existing 180s client timeout"). PROJECT.md must be updated to record the agent-SDK / ensemble / no-cost / no-timeout stance (flagged as a follow-up; see Deferred).

### Ensemble & Reconciliation
- **D-06:** Mixing strategy = **merge + synthesize**. Run all 3 SDKs in parallel → compute agreement (union of requirements/keywords, flag disagreements, validate every evidence span is a literal JD substring) → a **synthesizer pass reconciles** the three drafts into the final canonical analysis, retaining the agreement/confidence signal.
- **D-07:** The synthesizer is itself an agent-SDK call (recommended: Claude Agent SDK) — exact choice is Claude's discretion / AI-SPEC mechanism.

### Persistence & Audit Trail
- **D-08:** Persist **all three per-model sub-analyses + agreement/confidence + the reconciled canonical final**. Full audit trail — each model's contribution and where they disagreed must be inspectable later. Matches the repo auditability discipline (every displayed claim has an explicit source).
- **D-09:** Canonical **DB rows** (e.g. `job_employer_analysis` + per-model children), **never** `metadata_json`. A **single projection owner** builds the read shape; TS↔Python projection **parity test** is required.

### Lifecycle, Trigger & Reproducibility
- **D-10:** **Two triggers.** (a) Auto `_run_analyze` sub-step at the front of `tailor`; (b) a standalone **`analyze_job` RPC** so the analysis can be produced/inspected independently before a full tailor. RPC + persistence land this phase; the standalone *inspector UI* is deferred to Phase 5.
- **D-11:** **Reproducibility = cache contract.** A 3-way stochastic agent ensemble cannot be byte-identical, so the cache is what makes ANALYSIS-05 "stable across runs" true: compute once, persist, reuse. "Running analysis twice on the same snapshot" returns the cached canonical record.
- **D-12:** **Cache key = posting-snapshot hash + prompt/SDK-set version.** Recompute only when (a) the snapshot hash changes, (b) the prompt or SDK-set version is bumped, or (c) an explicit **force re-analyze** is requested. Superset of ANALYSIS-06. Re-tailor reuses the cached analysis (never re-reasoned).
- **D-13:** A failed/forced re-analyze must **not** destroy the last accepted analysis (generation-versioning / supersede semantics, mirroring `MaterialsSet`) — failed refreshes become audit history. (Re-tailor auditability rule; full enforcement matures in later phases but the data model must allow it now.)

### Analysis Content & Evidence Shape
- **D-14:** Requirement weighting = **tier + numeric weight**: classify must-have vs nice-to-have AND assign a 0–1 priority weight (rank within a tier). Both the explicit tier label and the numeric weight are persisted.
- **D-15:** Evidence span = **quoted JD text is canonical** (a literal substring of the persisted posting snapshot); **char offsets are derived** at projection/render time for highlighting (recomputable, never drifts). The grounding validator checks substring membership against the snapshot.
- **D-16:** Analysis depth = **rich ideal-candidate**: role framing/summary + must/nice requirements with priority + reasoned keywords with evidence + inferred seniority + a "what they're really looking for" narrative.
- **D-17:** Each reasoned keyword **links to the requirement it supports** (`requirement_ref`), so later phases join bullet → keyword → requirement → JD-evidence cleanly (sets up Phase 2 provenance FKs). Orphan keywords (no clear parent requirement) are allowed but **flagged**.

### Budget, Effort & Cancellation
- **D-18:** **Quality is the only objective. Cost is no object.** Run max effort / top model on each SDK; no token or turn ceiling.
- **D-19:** **No wall-clock deadline** on the analysis. The historical 180s httpx timeout does not apply (that transport is not used here). The **only** stop is cooperative cancellation. Where an SDK exposes its own timeout / max-turns, set it high or unbounded so nothing kills a healthy run.

### Architecture Placement (carried forward — locked)
- **D-20:** Analysis is a **sub-step of `tailor`** (`_run_analyze` before `_run_tailor`), persisted independently — **not** a new top-level pipeline stage (a new stage forces synchronized edits across ~6 surfaces + the `StageBadge` parity test). Promote to a stage later only if scoring/cover need it.
- **D-21:** **Rip-and-replace** `_extract_job_keywords` outright — no compatibility shim (single-user project convention).

### Claude's Discretion
- Exact internal mechanism of structured output through each agent SDK (e.g., constraining each SDK to a single `submit_analysis(schema)` tool call vs the SDK's native structured-output mode) — design in AI-SPEC.
- Which SDK performs the synthesizer/reconciliation pass.
- Pydantic model shapes, table DDL, projection column layout, event names — planner's call, consistent with research/ARCHITECTURE.md.
- Agreement/confidence scoring method (voting threshold, fuzzy match for span/keyword equivalence across models).
</decisions>

<canonical_refs>
## Canonical References

**Downstream agents (AI-SPEC researcher, planner) MUST read these before planning or implementing.**

### Project planning (this milestone)
- `.planning/PROJECT.md` — milestone scope, Pillar A, Context, Constraints. NOTE: its LLM constraint is superseded by D-01..D-05/D-18/D-19.
- `.planning/REQUIREMENTS.md` — ANALYSIS-01…ANALYSIS-06 (and downstream GROUND/CONTROL/VOICE/INSPECT for context).
- `.planning/ROADMAP.md` §"Phase 1: Canonical Employer Analysis" — goal + 4 success criteria.
- `.planning/research/ARCHITECTURE.md` — where analysis slots into Materials/Operations, build order, data flow, anti-patterns. **Caveat:** assumes the httpx transport; the agent-SDK directive (D-01..D-07) supersedes its transport recommendations, not its placement/persistence guidance.
- `.planning/research/STACK.md` — quote-first grounding, validator-driven re-ask, reproducibility techniques, what-not-to-use. **Caveat:** its "portable JSON-Schema over httpx" core is superseded by agent SDKs; the *grounding techniques* (quote-first, span validation, temp/determinism, prompt-chaining) still apply.
- `.planning/research/PITFALLS.md`, `.planning/research/SUMMARY.md` — latency/cost framing now mostly moot (cost no object), but the auditability/repro pitfalls still hold.

### Codebase maps
- `.planning/codebase/ARCHITECTURE.md` — eight bounded contexts, projection-backed read model, JSON-RPC TS↔Python.
- `.planning/codebase/CONCERNS.md` — projection duplication TS↔Python, sibling-file synthesis, 180s LLM timeout, no per-call RPC timeout.
- `.planning/codebase/STACK.md`, `.planning/codebase/INTEGRATIONS.md`, `.planning/codebase/STRUCTURE.md` — stack, env/integration points, layout.

### Repo discipline + architecture docs
- `CLAUDE.md` — root-cause & auditability discipline (explicit source of truth per displayed claim; coverage computed against generated text; re-tailor must not destroy current artifact).
- `docs/architecture.md`, `docs/job-pipeline-architecture.md`, `docs/ddd-target.md` — DDD/hexagonal target, pipeline execution, bounded contexts.

### Key code touchpoints
- `workers/automation/src/jobhunter/domain/materials/quality.py` — `build_tailoring_plan`, `_extract_job_keywords` (the heuristic to **replace**), `build_tailoring_change_annotations`.
- `workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py` — **precedent** for driving an agent via its CLI/SDK in this codebase.
- `workers/automation/src/jobhunter/llm.py` — existing httpx client (the path being moved away from for new AI; do not extend it for analysis).
- `workers/automation/src/jobhunter/pipeline/runner.py` — `_run_tailor` (add `_run_analyze`).
- `workers/automation/src/jobhunter/infrastructure/rpc/handlers.py`, `database.py`, `domain/events/materials.py`, `infrastructure/projections/projection_builder.py`.
- `apps/api/src/read-model.ts` (`tailoringExplanationForArtifact`), `apps/api/src/projections.ts`, `packages/contracts/src/schemas.ts`, `packages/contracts/src/rpc.ts`.

### MUST research in AI-SPEC (no doc in-repo yet)
- **Claude Agent SDK**, **Codex SDK**, **Antigravity SDK** — official docs for: programmatic/headless invocation, structured/typed output mechanism, determinism controls, cancellation, max-turns/timeout config, and auth (Claude Code session; `GOOGLE_APPLICATION_CREDENTIALS`; Codex subscription). These are the single biggest knowledge gap for planning.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `claude_code_cli.py`: existing in-repo pattern for invoking an agent toolchain from the Python worker — a template for the Claude Agent SDK adapter and, by analogy, the Codex/Antigravity adapters.
- `build_tailoring_change_annotations` / `TailoringChangeAnnotation` (`domain/materials/quality.py`): already produces source/tailored/rationale/controls/evidence_ids — relevant shape reuse for later phases, and confirms the domain already "thinks" in evidence terms.
- `MaterialsSet` generation-versioning / `supersede_all` / `suppress_active_artifacts`: the model to mirror for analysis versioning (D-13).
- Projection backbone + `job_events` audit + SSE invalidation router: the canonical read/realtime path the analysis plugs into.

### Established Patterns
- DDD + hexagonal: aggregate/VO + repository port + SQLite adapter; use case owns the transaction and publishes a domain event.
- JSON-RPC TS↔Python subprocess for actions (`rpc.ts` ↔ `handlers.py`).
- Projection parity: any new read-model field must be built identically by the Python builder AND `apps/api/projections.ts`, served by `read-model.ts`, typed in `schemas.ts` — enforced by a parity/contract test.
- Snapshot-hash keying for caching (already idiomatic in enrichment).

### Integration Points
- `pipeline/runner.py::_run_tailor` → add `_run_analyze` front-half.
- New RPC `analyze_job` → `contracts/rpc.ts` + `local-actions.ts` + `domain/rpc/messages.py` + `infrastructure/rpc/handlers.py`.
- New event `EmployerAnalyzed` → Python factory + persist/publish + `packages/domain-types` mirror + web `contexts/materials/handlers.ts` + `every-event-has-handler.test.ts`.
- New tables in `database.py`; new aggregate/port in `domain/materials` + `domain/ports/materials.py`; projection in `projection_builder.py` (+ TS parity).
</code_context>

<specifics>
## Specific Ideas

- "Mix the 3 LLMs to get better data." — the ensemble exists for **quality**, not redundancy; the agreement signal across Claude/Codex/Antigravity is itself valuable audit data worth persisting.
- "I do not care about how much we consume. I need QUALITY." — the governing tradeoff for every knob: pick the higher-quality option; never optimize for cost or latency.
- Auth is already in place (Claude Code session, `GOOGLE_APPLICATION_CREDENTIALS`, Codex subscription) — adapters should consume existing auth, not add key management.
</specifics>

<deferred>
## Deferred Ideas

- **Migrate existing LLM stages (scoring / current tailor / judge / voice) to agent SDKs** — project-wide direction (D-01) but explicitly **not this phase**; its own future work.
- **Standalone employer-analysis inspector UI** — Phase 5 (INSPECT-02). Phase 1 lands the `analyze_job` RPC + persistence only.
- **Update PROJECT.md** to record the agent-SDK / 3-way-ensemble / no-cost / no-timeout stance and retire the "latest Claude / explicit provider / 180s timeout" constraint (D-05). Suggest doing this at phase transition or now as a small doc edit.
- **Formal eval / quality-measurement harness** — already deferred this milestone in PROJECT.md; noted tension since a 3-way ensemble "for quality" has no scored quality gate yet. The AI-SPEC will define a *lightweight* eval strategy regardless.

</deferred>

---

*Phase: 1-Canonical Employer Analysis*
*Context gathered: 2026-06-08*
