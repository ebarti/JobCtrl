# Project Research Summary

**Project:** JobHunter — Grounded Resume Tailoring
**Domain:** Grounded, inspectable, provenance-tracked LLM resume tailoring on an existing DDD/hexagonal local-first pipeline
**Researched:** 2026-06-08
**Confidence:** HIGH (stack + architecture), MEDIUM-HIGH (pitfalls), MEDIUM (features — competitor specifics directional)

## Executive Summary

This is a **subsequent milestone on a mapped, shipping codebase**, not a greenfield build. The repo already contains almost the exact data shapes this milestone needs — `TailoringPlan`, `TailoringChangeAnnotation`, and the `ArtifactTailoringExplanation` contract are near-perfect — but they live in the wrong place: serialized into opaque `metadata_json` blobs, recomputed divergently in TypeScript vs Python, and back-filled from sibling files on disk. The flakey keyword extraction users complain about is a pair of hardcoded stopword/high-signal lists in `quality.py::_extract_job_keywords`. So the dominant character of the work is **relocation + canonicalization**: make the existing domain structures first-class persisted rows (`job_employer_analysis`, `job_bullet_provenance`), project them once, and rip out the file-heuristic and TS-side recompute (single-user rip-and-replace, no compat shims).

The recommended technique stack is deliberately minimal and provider-agnostic: keep the existing hand-rolled `LlmPort`/`httpx` client (no LangChain/agent frameworks), add **Pydantic v2** typed models feeding the already-supported `response_schema`, **validator-driven re-ask** to make "never fabricate" a machine-checked invariant, **quote-first/span-anchored extraction** to cure flakey keywords, and **rapidfuzz** for deterministic coverage/provenance verification against the actual generated text. A critical fork must be decided up front: the codebase default model is **Gemini (`gemini:gemini-3.5-flash`), not Claude** as PROJECT.md's constraint assumed. Claude's two strongest grounding features (native Structured Outputs and Citations) require adding an Anthropic Messages adapter, **cannot be combined in one call**, and prefill is removed on Claude 4.6+. The research recommends the **portable validator-based path** as the core (works on Gemini and Claude-via-compat today), with the Anthropic adapter as an optional accelerator for the high-stakes analysis/provenance calls.

The risk profile is dominated by **auditability integrity** — exactly the discipline CLAUDE.md mandates. The five must-not-violate invariants: (1) provenance is FK bindings to canonical profile-evidence and requirement IDs, never model-authored free text; (2) coverage = analysis-keywords minus present-in-final-rendered-text, computed at generation time, never inferred from the JD; (3) the voice pass must run **before** the final audit so audited text equals rendered text; (4) re-tailor must version generations and never destroy the last accepted artifact; (5) the inspector must render missing/embarrassing states explicitly, never mask them. A hard prerequisite blocks everything user-facing: per-job `generate-materials` currently returns 400 / button disabled / E2E fixme'd — the inspector UI is unreachable until that vertical slice is wired.

## Key Findings

### Recommended Stack

The existing TS/React/Fastify/Python/Temporal/SQLite stack is out of scope. This milestone adds only *techniques and lightweight libraries* to the Python LLM pipeline. The client already supports JSON-Schema structured output (`chat_json(response_schema=...)`) over OpenAI-compat and Gemini-native paths — harden and use it, do not replace the transport. See `STACK.md`.

**Core technologies:**
- **Pydantic v2**: typed models for job-analysis, provenance, and tailoring-decision records — `model_json_schema()` feeds the existing `response_schema`; validators enforce grounding. Already idiomatic in the DDD code.
- **Validator-driven re-ask** (hand-rolled, or optionally **Instructor**): rejects ungrounded output and re-asks — turns "never fabricate metrics/dates" into a machine-checked invariant, not a prompt hope.
- **rapidfuzz**: deterministic verification that a bullet's cited span exists in profile/JD text, and that coverage is computed against the *actual generated resume text*.
- **Quote-first / span-anchored extraction + temperature=0 + XML-tagged prompts**: Anthropic's grounding recipe; the direct cure for "flakey/random" keywords.
- **Optional Anthropic Messages adapter** (Claude Structured Outputs + Citations): strongest provenance fidelity, but provider-locked, two features cannot share a call, and not reachable through today's transport.

**Do NOT use:** LangChain/agent frameworks; Claude response **prefilling** (400 on 4.6+); `budget_tokens` (deprecated, use `effort`); combining Citations + Structured Outputs in one call (400); inferring coverage from the JD alone; provider-default temperature for extraction.

### Expected Features

The category baseline is "keyword match + rewrite"; JobHunter's moat is **inspectability-first** — exposing *why* each line exists and *how aggressively* it may transform. See `FEATURES.md`.

**Must have (table stakes):**
- Structured, reasoned JD requirement extraction (must-have vs nice-to-have) replacing the flakey scrape
- Reasoned keywords tied to JD evidence; coverage computed on actual generated text
- Per-bullet rewrite anchored to a real profile fact + the JD requirement it serves
- Never-fabricate guardrail recorded as the *rule that produced the bullet*
- Diff view (original → tailored); editable output; PDF render (exists)
- Preserve last accepted artifact across re-tailor (CLAUDE.md mandate)
- **Per-job generate-materials wiring — currently broken; prerequisite for the inspector to be reachable**

**Should have (competitive differentiators):**
- Persisted, inspectable "ideal candidate" employer analysis (the flagship upstream fix)
- Full per-bullet provenance card: evidence × requirement × transform-type × human rationale
- Transform-type taxonomy + granular control model with the governing rule recorded per decision
- Voice/authenticity controls as recorded transforms; in-app inspector exposing analysis + provenance + policy

**Defer (v2+):**
- Formal eval / golden-fixture harness (explicitly the planned *next* milestone)
- Cover-letter tailoring on the shared analysis; voice calibration from user samples; multi-resume variants
- Anti-features to refuse: auto-invented metrics, keyword stuffing, single ATS headline score, mass auto-apply, suppressing missing-keyword lists, sibling-file synthesized artifacts

### Architecture Approach

Everything stays inside the **Materials + Operations** contexts — no new bounded context, no new top-level pipeline stage. Employer analysis is modeled as `AnalyzeJobUseCase` run as a `_run_analyze` sub-step at the front of `_run_tailor` (adding a stage would force synchronized edits across 6 surfaces + the StageBadge parity test). The architectural job is to convert existing transient/`metadata_json` structures into canonical DB rows projected by a single owner, eliminating the TS↔Python divergence and the sibling-file fallback. See `ARCHITECTURE.md`.

**Major components:**
1. **`EmployerAnalysis` aggregate + `AnalyzeJobUseCase`** — persisted "ideal candidate": role framing, prioritized must/nice requirements, reasoned keywords each tied to a quoted JD span. Replaces `_extract_job_keywords`. New `job_employer_analysis` table, keyed by `(tenant, job, generation)` + snapshot hash for caching.
2. **`BulletProvenance` entity** — one canonical row per generated bullet: evidence FK × requirement FK × transform-type enum × control × rationale, with `generated_text` as the coverage anchor. New `job_bullet_provenance` table. Reuses existing `build_tailoring_change_annotations` logic — the change is *persist its output as rows* computed against the selected candidate's rendered text.
3. **Single-owner projection + read-model cleanup** — project new rows in `projection_builder.py` with `apps/api/projections.ts` parity; `read-model.ts` serves rows only; **delete** the `tailoringExplanationForArtifact` sibling-file fallback and the TS `textCoverage` recompute.
4. **Inspector UI** — `EmployerAnalysisPanel` + `BulletProvenanceList` in `contexts/materials/components/`, composed by jobs/apply-review views, consumed via Operations hooks; new events flow through `handlers.ts` + `every-event-has-handler.test.ts` parity.

### Critical Pitfalls

1. **Hallucinated provenance** — model invents plausible evidence/requirement IDs. Avoid: provenance is FK bindings into pre-supplied canonical ID sets, validated at generation time (fabricated ID → hard reject); quoted JD spans verified as literal substrings of the snapshot.
2. **Reproducible-looking but non-reproducible keywords** — "reasoning costume" over invisible randomness. Avoid: anchor every keyword to a JD span, temperature=0, and a reproducibility fixture asserting stable keyword set + must/nice split across two runs on the same snapshot.
3. **Fabricated metrics leak past prompt rules** — defense-in-depth, not prompt-only: a deterministic numeric/date detector requiring every number to trace to profile evidence; per-decision control recorded.
4. **Provenance/coverage drifts from rendered text** — audit computed on early JSON goes stale after repair/voice/render. Avoid: sequence voice **before** final audit; compute coverage against the final canonical text both renderers consume; carry stable bullet identity through transforms; round-trip fixture.
5. **Audit synthesized from heuristics/sibling files** (the existing tech-debt habit) — capture at generation time, persist canonically; missing keywords = analysis − present-in-final-text; remove sibling/legacy sources.
6. **Re-tailor destroys accepted artifact** — version generations; the "current" pointer advances only on approval; failed runs become history.
7. **Prose still reeks of AI** — voice is an explicit pass with deterministic proxies (buzzword density, structure/length variance); re-validate provenance + fabrication after the voice pass.
8. **Latency/cost blowup** — cache/persist the analysis (reused on re-tailor), per-stage budgets + total-call cap, prefer deterministic checks over judge calls, bound loops.
9. **Inspector masks missing data** — render distinct present/missing/covered/missing-must-have states; per-state Storybook stories as the gate.
10. **Coverage gamed by keyword stuffing** — count covered only when in a provenance-backed grounded bullet; token/lemma-aware matching; surface stuffing as a voice smell.

## Implications for Roadmap

Based on combined research, the dependency-driven ordering is forced: **A (employer analysis) → B+C (provenance + controls, sharing the transform-type taxonomy) → D (voice, before final audit) → E (inspector UI)**, with the broken generate-materials path wired before E is reachable. Backend canonicalization must land before any UI so the inspector never masks missing data.

### Phase 1: Canonical Employer Analysis (root-cause fix)
**Rationale:** A is the keystone — B, C, D, E all consume the persisted analysis; it is the named root-cause fix for flakey keywords and shallow understanding.
**Delivers:** `job_employer_analysis` table, `EmployerAnalysis` aggregate + `AnalyzeJobUseCase` + `_run_analyze`, `EmployerAnalyzed` event (+ domain-types mirror), projection (both runtimes) + DTO, `analyze_job` RPC. **Replaces `_extract_job_keywords` outright (no shim).**
**Addresses:** A1–A4 (reasoned extraction, must/nice + priority, evidence-tied keywords, persisted inspectable artifact).
**Uses:** Pydantic + `response_schema`, quote-first span anchoring, temperature=0, validator re-ask; cache by snapshot hash.
**Avoids:** Pitfall 2 (non-reproducible keywords) — reproducibility + span-anchoring fixtures are the gate; Pitfall 8 (cache analysis).

### Phase 2: Canonical Per-Bullet Provenance + Controls
**Rationale:** B requires A's requirement IDs; C requires B's transform taxonomy (the shared seam). Provenance and controls land together because the governing rule is recorded per provenance row.
**Delivers:** `job_bullet_provenance` table, `BulletProvenance` entity + `TransformType`/`ControlRule` enums, extended `TailorResumeUseCase` emitting rows computed vs generated text and consuming the persisted analysis, `BulletProvenanceRecorded` event + projection + DTO extension; per-decision `control` threaded through; generation-versioned + superseded with its artifact.
**Addresses:** B1–B4, C1.
**Implements:** `BulletProvenance` component; reuses `build_tailoring_change_annotations`.
**Avoids:** Pitfall 1 (FK bindings + ID validation), Pitfall 3 (numeric/date detector + per-decision rule), Pitfall 5 (generation-time canonical capture), Pitfall 6 (generation versioning, non-destructive re-tailor).

### Phase 3: Voice Pass + Final Audit Against Rendered Text
**Rationale:** Voice must run **before** the final audit so audited/coverage text equals rendered/PDF text; coverage drift (Pitfall 4) is the highest-alignment auditability risk.
**Delivers:** explicit voice/de-buzzword transform stage with deterministic proxies (buzzword density, structure/length variance), provenance + fabrication re-validation after voice, coverage computed once against the final canonical text both renderers consume; stable bullet identity through transforms.
**Addresses:** Pillar D; honest coverage table stakes.
**Avoids:** Pitfall 4 (round-trip fixture: audited bullet text == rendered text), Pitfall 7 (voice proxies + re-validation), Pitfall 10 (coverage gaming — covered only when provenance-backed).

### Phase 4: Read-Model Cleanup (rip-and-replace)
**Rationale:** With canonical rows landed, retire the divergent read paths — directly closes two named CONCERNS.md risks (projection duplication, sibling-file synthesis).
**Delivers:** delete `tailoringExplanationForArtifact` sibling-file fallback + TS `textCoverage` recompute; `read-model.ts` serves projection rows only; cross-runtime projection parity fixture; a regression fixture reproducing the old embarrassing state from canonical data.
**Avoids:** Pitfall 5; projection-parity drift.
*(May fold into Phase 2/3 tails if the slices are small; kept distinct so the cleanup is an explicit gate.)*

### Phase 5: Per-Job Generate-Materials Wiring + Inspector UI
**Rationale:** The inspector is unreachable until the broken per-job generate-materials path (400 / disabled button / E2E fixme) is wired. UI comes last so it only ever renders honest, canonical backend data.
**Delivers:** wire the generate-materials vertical slice; `EmployerAnalysisPanel` + `BulletProvenanceList` (+ `.test.tsx`, per-state `.stories.tsx`, `.a11y.test.tsx`) composed into `TailoringExplanationSection`, jobs detail, apply-review; `useArtifactDetailQuery` extension; `handlers.ts` invalidation + `every-event-has-handler.test.ts` parity; diff view; current-vs-history surfacing.
**Addresses:** Pillar E; per-job invocation; diff view; preserve-on-re-tailor visibility.
**Avoids:** Pitfall 9 (per-state stories proving missing/embarrassing states render explicitly, not blank).

### Phase Ordering Rationale

- **Dependency-forced:** A is consumed by everything; B's requirement IDs gate the B2 edge; C's controls attach to B4's transform taxonomy; voice must precede the final audit; E depends on canonical A4/B3/C1 persistence + the generate-materials fix.
- **Auditability-first:** every backend canonicalization lands before UI so the inspector cannot mask missing data — directly honoring CLAUDE.md.
- **Cross-cutting sync per slice:** each phase keeps the documented sync surfaces consistent — new event ⇒ Python factory + domain-types mirror + handlers + parity test; new read-field ⇒ both projection builders + read-model + schemas + web; new RPC ⇒ rpc.ts + local-actions + messages.py + handlers.py. **Do not touch the stage enumeration set.**

### Research Flags

Phases likely needing deeper research during planning (`/gsd-plan-phase --research-phase`):
- **Phase 1:** the **provider-model fork** must be decided here — portable validator path (Gemini/Claude-compat today) vs adding an Anthropic Messages adapter (native Structured Outputs/Citations, two-features-can't-combine, prefill removed). This decision conditions the LLM-call design for every later phase.
- **Phase 2:** provenance granularity for executive-profile vs experience bullets, and whether provenance is a child of `MaterialsSet` (transactional) or a sibling table keyed by generation (gap flagged in ARCHITECTURE.md; transactional preferred). Confirm against the `with_resume_attempt` boundary.
- **Phase 3:** concrete deterministic voice-proxy thresholds and the exact "final canonical text" artifact both renderers consume.

Phases with standard/well-documented patterns (lighter research):
- **Phase 4:** mechanical rip-and-replace of read paths grounded directly in `read-model.ts` line references.
- **Phase 5:** follows established frontend conventions (contexts/components/hooks/handlers/stories) once the broken route is diagnosed.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Techniques verified against current Anthropic platform docs (2025–2026) and Instructor docs, cross-checked against the actual LLM client (`llm.py`, `model_defaults.py`). |
| Features | MEDIUM | Grounded in PROJECT.md/CONCERNS.md/CLAUDE.md (HIGH), but competitor specifics are training-knowledge directional (web search unavailable in the research env). |
| Architecture | HIGH | Grounded directly in `domain/materials`, contracts, `read-model.ts`, and the web materials context; component placement and build order verified against existing code. |
| Pitfalls | MEDIUM-HIGH | HIGH where repo-grounded (CONCERNS.md, CLAUDE.md discipline); MEDIUM where based on general grounded-LLM/RAG domain knowledge (external post-mortems not citable in-env). |

**Overall confidence:** HIGH — the milestone is canonicalization of existing, well-understood structures; the main open *decision* (not gap) is the provider-model fork.

### Gaps to Address

- **Provider-model fork (decision, not gap):** resolve in Phase 1 planning — portable JSON-Schema + validator re-ask vs Anthropic adapter. PROJECT.md assumed Claude; the codebase default is Gemini. Pick the portable core; treat Citations/Structured-Outputs as an optional accelerator (and never combine them in one call).
- **Provenance persistence boundary:** transactional-with-`MaterialsSet` vs sibling-table-by-generation — confirm during Phase 2 against `with_resume_attempt`.
- **Keyword↔evidence-span link format:** quoted `evidence_span` vs char offsets — quoted text is simplest and matches the "explicit source" rule; confirm in Phase 1.
- **Latency/cost budgets:** the multi-step chain risks the 180s timeout; per-stage budgets + analysis caching + bounded loops should be designed in, with metering surfaced in the Operations view.
- **Cross-runtime projection parity:** new audit tables must have a single migration source or schema-contract test to avoid the feedback-schema drift precedent.

## Sources

### Primary (HIGH confidence)
- `.planning/PROJECT.md` — milestone scope, pillars A–E, constraints, key decisions
- `.planning/codebase/{ARCHITECTURE.md,STRUCTURE.md,CONCERNS.md}` — existing architecture + tech-debt
- `CLAUDE.md` — root-cause/auditability discipline
- Repo code: `domain/materials/{use_cases,quality,value_objects}.py`, `database.py`, `infrastructure/llm/llm_client.py`, `model_defaults.py`, `packages/contracts/src/schemas.ts`, `apps/api/src/read-model.ts`, `apps/web/src/contexts/materials/`
- platform.claude.com — Structured Outputs, Citations, prompt-engineering best practices (quote-first, XML tags, prefill removal, `effort`)
- python.useinstructor.com — Pydantic validator re-ask, `from_provider`, retry semantics

### Secondary (MEDIUM confidence)
- AI resume-tailoring category knowledge (Jobscan, Teal, Rezi, Kickresume, Enhancv, ChatGPT/Claude workflows) — directional competitor analysis
- General grounded-LLM / RAG-faithfulness domain knowledge — provenance-as-binding, fabrication detection, Goodhart/coverage-gaming, voice-as-separate-pass

### Tertiary (LOW confidence)
- Specific competitor feature internals — not live-verified (web search unavailable in research env)

---
*Research completed: 2026-06-08*
*Ready for roadmap: yes*
