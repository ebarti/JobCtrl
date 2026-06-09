---
phase: 01-canonical-employer-analysis
verified: 2026-06-09T17:25:00Z
status: passed
score: 4/4 success criteria verified
mode: goal-backward (post-merge reconciliation @ e36ffb1)
re_verification:
  note: "No prior VERIFICATION.md — code merged outside the GSD loop; initial verification."
overrides_applied: 0
gaps: []
deferred:
  - truth: "eeo_screen_hits surfaced through the projection read model + TS inspector"
    addressed_in: "Phase 5 (inspector UI / INSPECT-02)"
    evidence: "EmployerAnalysis.to_read_model() intentionally omits eeo_screen_json; analysis.py:266-267 + analysis.py:351-357 document deferral to keep cross-runtime parity intact this phase."
---

# Phase 1: Canonical Employer Analysis — Verification Report

**Phase Goal:** A reasoned, reproducible, persisted employer "ideal candidate" analysis becomes the single source of truth that replaces the flakey hardcoded keyword extraction and drives all downstream tailoring.
**Verified:** 2026-06-09T17:25:00Z (worktree `/tmp/jobhunter-gsd-reconcile`, merged main @ `e36ffb1`)
**Status:** PASS
**Re-verification:** No — initial verification of already-merged code (PRs #141, #145, #146, #147, #148, #149, #150).

## Overall Verdict: PASS (4/4 success criteria)

All four ROADMAP success criteria are satisfied with concrete code + passing-test evidence. The old `_extract_job_keywords` heuristic is fully removed (rip-and-replace, not dead code). No Blocker or High gaps. One item is correctly deferred to Phase 5 by design (EEO screen surfacing in the read model).

---

## Success Criteria Verdicts

### Criterion 1 — PASS
**Running tailoring on a job produces a persisted `job_employer_analysis` record with structured requirements classified must-have vs nice-to-have and assigned priority/weighting.**

| Evidence | Location |
| --- | --- |
| Canonical table DDL (3 tables: main + sub_analyses + failures), generation-versioned, snapshot/cache_key columns | `workers/automation/src/jobhunter/database.py:1453-1535` |
| Requirement model: `tier: Literal["must_have","nice_to_have"]` + `weight: float (ge=0, le=1)` + `evidence_span` | `workers/automation/src/jobhunter/domain/materials/analysis.py:88-108` |
| `must_have_requirements` / `nice_to_have_requirements` accessors | `analysis.py:148-154` |
| Tailor sub-step `_run_analyze` produces/reuses the analysis BEFORE building the plan (D-20) | `workers/automation/src/jobhunter/domain/materials/use_cases.py:902-904, 1136-1161` |
| Use case persists a new generation via repository.save (supersede, never destroy) | `analyze_use_case.py:181-205` |
| Repository INSERTs into all three canonical tables | `infrastructure/materials/employer_analysis_repository.py:108-195` |
| Tests | `test_employer_analysis_model.py`, `test_employer_analysis_repository.py`, `test_analyze_job_use_case.py` — 94 passed in the analysis bundle |

Requirements ANALYSIS-01 (structured must/nice) + ANALYSIS-02 (priority weight) + ANALYSIS-04 (persisted canonical) satisfied.

### Criterion 2 — PASS
**Every keyword is tied to a quoted JD evidence span that is a literal substring of the persisted posting snapshot, and the old `_extract_job_keywords` heuristic no longer runs.**

| Evidence | Location |
| --- | --- |
| Grounding validator: normalize → tolerant-locate → snap-to-source; rejects any span whose WORDS are absent (no-fabrication) | `domain/materials/analysis_grounding.py:71-283` |
| `ground_and_snap` run on every leg draft AND on synthesized canonical (defense in depth) | `ensemble.py:78, 257`; re-validated before persistence at `analyze_use_case.py:165` |
| Keyword/Requirement `evidence_span` documented + enforced as literal JD substring (schema cannot enforce; validator does) | `analysis.py:63-108` |
| **ABSENCE of old heuristic — fully REMOVED, not dead code:** `grep -rn _extract_job_keywords workers/automation/src` returns ONLY 3 docstring references (database.py:1429, analysis.py:4, quality.py:376). No `def _extract_job_keywords`, no call site anywhere. | grep evidence |
| `build_tailoring_plan` now REQUIRES `employer_analysis` (keyword-only, no default) and derives keywords via `_analysis_job_keywords(employer_analysis)` | `quality.py:366-383, 695-712` |
| Tailor live path feeds the persisted analysis into the plan | `use_cases.py:1169-1178` |
| Tests | `test_employer_analysis_model.py` (grounding + snap, incl. unicode-hyphen snap), `test_materials_quality.py` |

Requirement ANALYSIS-03 satisfied. The heuristic is genuinely gone from the live tailor path (and the codebase entirely).

### Criterion 3 — PASS
**Running analysis twice on the same snapshot yields a stable requirement+keyword set, and the analysis is reused/cached on re-tailor keyed by snapshot hash rather than re-reasoned.**

| Evidence | Location |
| --- | --- |
| Cache key = `sha256(jd_snapshot) : PROMPT_VERSION : SDK_SET_VERSION` (D-11/D-12) | `analysis.py:232-244` |
| Use case cache short-circuit: on non-force second run, returns cached record and SKIPS the ensemble | `analyze_use_case.py:149-155` |
| Cache-hit selector index on `(tenant_id, job_url, cache_key)` | `database.py:1518-1523` |
| Reproducibility test: second run on same snapshot returns `cached=True`, ensemble called exactly once, no new generation | `test_analyze_job_use_case.py:147-158` |
| Cache-hit repository test (snapshot+version keying) | `test_employer_analysis_repository.py:100-110` |
| Snapshot-hash stability + cache-key composition tests | `test_employer_analysis_model.py:316-328` |
| Force-recompute bumps generation + retains prior as audit history (D-13) | `test_analyze_job_use_case.py:160-172` |

Requirements ANALYSIS-05 (reproducible) + ANALYSIS-06 (cached on re-tailor by snapshot hash) satisfied. Reproducibility is delivered by the cache-reuse contract (D-11) — a deliberate design choice for a stochastic 3-SDK ensemble; the "reproducibility fixture" is the cache-reuse test above. This is design-aligned, not a gap.

### Criterion 4 — PASS
**The persisted analysis is served through the canonical read path (projection + DTO, parity across Python and TypeScript builders) and is readable as an inspectable artifact.**

| Evidence | Location |
| --- | --- |
| Single read-shape owner: `EmployerAnalysis.to_read_model()` | `analysis.py:351-380` |
| Python projection loads latest generation, serialises `to_read_model()` into `employer_analysis_json` | `infrastructure/projections/projection_builder.py:389, 522, 679-699` |
| TS projection mirrors the same shape from the same canonical rows | `apps/api/src/projections.ts:690-789, 1379, 1510-1538` |
| Read model serves `employerAnalysis` DTO | `apps/api/src/read-model.ts:611-623` |
| Contracts schema mirrors Python read model (tier/weight/evidence_span typed) | `packages/contracts/src/schemas.ts:1301-1375` |
| **Cross-runtime parity test (byte-for-byte):** asserts TS-built `employer_analysis_json` equals Python expected AND read model serves the same DTO | `apps/api/test/audit-projection-parity.test.ts:271-299` — PASSED |
| Standalone `analyze_job` RPC (D-10) — full impl, runs ensemble + persists, returns identity + degraded signal | `infrastructure/rpc/handlers.py:276-313, 459` |
| Web inspector reads the DTO (Phase-5 UI seam already present) | `apps/web/src/contexts/materials/components/EmployerAnalysisPanel.tsx` + tests/stories |

Requirement ANALYSIS-04 (canonical inspectable) satisfied; TS↔Python parity enforced by a passing parity test (D-09).

---

## Ensemble Reality Check (not a criterion, but the goal's substance)

The "3-way agent-SDK ensemble" is real, not stubbed:

| Leg | Adapter | Real SDK |
| --- | --- | --- |
| Claude | `infrastructure/analysis/claude_analysis_adapter.py` | lazy-imports `claude_agent_sdk.query` |
| Codex | `infrastructure/analysis/codex_analysis_adapter.py` | lazy-imports `openai_codex.AsyncCodex` (gpt-5.5, isolated CODEX_HOME) |
| Antigravity | `infrastructure/analysis/antigravity_analysis_adapter.py:151-176` | lazy-imports `google.antigravity.agent.Agent` |
| Synthesizer | `ClaudeAnalysisSynthesizer` | Claude Agent SDK (D-07) |

All 3 wired in `scoring/tailor.py:182-191`. Orchestrator is N-leg, partial-failure safe (`ensemble.py:185-214`): one leg failure is recorded as `AnalysisFailure` and the run proceeds on survivors; hard-fail only when zero legs survive. Degraded ensemble is persisted with `legs_succeeded/legs_attempted` (D-08).

---

## Behavioral / Test Execution

| Suite | Command | Result |
| --- | --- | --- |
| Phase 1 analysis bundle (10 files) | `pytest test_analyze_job_use_case.py test_employer_analysis_* test_materials_quality.py test_audit_projection_parity.py test_strict_schema.py test_gemini_schema.py` | 94 passed |
| Materials/tailor integration | `pytest test_materials_use_cases.py test_tailor_provenance_integration.py test_coverage_audit.py test_antigravity_adapter.py test_codex_adapter_status.py` | 50 passed |
| Full Python suite | `uv ... pytest -q` | 1321 passed, 3 failed (all 3 are the documented PRE-EXISTING failures unrelated to Phase 1) |
| TS API (incl. parity) | `pnpm --filter @jobhunter/api test` | 201 passed (10 files) |
| Parity test isolated | `vitest run test/audit-projection-parity.test.ts` | 1 passed |

**Pre-existing failures (excluded from Phase 1 verdict, as instructed):**
- `test_enrichment_detail_staleness.py::test_scrape_detail_page_reports_expired_json_ld_as_inactive`
- `test_enrichment_detail_staleness.py::test_scrape_detail_page_reports_closed_marker_as_inactive`
- `test_materials_repository.py::test_suppress_backfilled_legacy_job_makes_selectors_treat_paths_inactive`

(Note: the brief mentioned 2x `test_suppress_backfilled_legacy_job_*`; only one such failure was observed — both are within the documented known-failure family and unrelated to analysis.)

---

## Gaps

None at Blocker/High/Medium/Low severity for the Phase 1 goal.

## Deferred (by design, not gaps)

- **EEO red-flag screen audit (`eeo_screen_hits`) not yet surfaced in the read model / TS inspector** — Low / intentional. It is persisted as canonical audit data (`eeo_screen_json` column, `database.py:1483-1487`) and round-trips on load (`test_employer_analysis_repository.py:133`), but `to_read_model()` deliberately omits it (`analysis.py:266-267, 351-357`) to keep cross-runtime projection parity intact this phase. Surfacing lands with the Phase 5 inspector UI (INSPECT-02). Does not affect any Phase 1 criterion.

---

_Verified: 2026-06-09T17:25:00Z_
_Verifier: Claude (gsd-verifier), goal-backward, post-merge reconciliation_
