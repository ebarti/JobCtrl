---
phase: 02-per-bullet-provenance-controls
verified: 2026-06-09T19:20:00Z
status: passed
score: 5/5 must-haves verified
mode: reconcile-merged
notes: >
  Goal-backward verification of ALREADY-MERGED code (PR #142, plus follow-on
  fixes folded in via the merge). Worktree /tmp/jobhunter-gsd-reconcile ==
  main @ e36ffb1. No prior VERIFICATION.md existed (work done outside the GSD
  loop). Every verdict is grounded in code + executed tests, not PR claims.
gaps: []
deferred: []
---

# Phase 2: Per-Bullet Provenance + Granular Controls — Verification Report

**Phase Goal:** Every generated resume bullet carries a canonical, FK-bound
provenance record (evidence × requirement × transform × control × rationale)
consuming Phase 1's analysis, with never-fabricate enforced by a deterministic
detector independent of the prompt.

**Verified:** 2026-06-09T19:20:00Z (worktree @ e36ffb1)
**Status:** PASS (5/5)
**Re-verification:** No — initial verification of merged code.
**Requirements covered:** GROUND-01..05, CONTROL-01..03.

## Goal Achievement

### Observable Truths (Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Each bullet has a `job_bullet_provenance` row linking canonical evidence + the requirement it serves, with a transform from the closed taxonomy and a human-readable rationale | ✓ PASS | Schema + write path + tests below |
| 2 | Provenance is FK bindings, not free text — a fabricated evidence/requirement ID is hard-rejected at generation time | ✓ PASS | `ProvenanceBindingError` + reject tests below |
| 3 | The governing control rule is recorded per bullet | ✓ PASS | `ControlRule` enum + `_resolve_control` + test below |
| 4 | A deterministic numeric/date/title detector runs independently of the prompt; metrics-hungry job + numberless profile yields zero unsourced numerics | ✓ PASS | `fabrication_detector.py` (pure code) + fixtures below |
| 5 | Provenance is generation-versioned and superseded with its artifact; a failed re-tailor never destroys the last accepted generation's provenance | ✓ PASS | Repo supersede-not-destroy + accept-gating + tests below |

**Score:** 5/5 truths verified.

---

### Criterion 1 — Per-bullet FK-bound provenance row with taxonomy + rationale — PASS

- **Table schema (canonical rows, not metadata blob):**
  `workers/automation/src/jobhunter/database.py:1564-1590`. Table
  `job_bullet_provenance` with `PRIMARY KEY (job_url, generation, bullet_id)` and
  a real DB-level `FOREIGN KEY (job_url, generation) REFERENCES
  job_materials(job_url, generation) ON DELETE CASCADE`. Columns:
  `evidence_ids_json`, `requirement_ids_json`, `transform_type`, `control`,
  `rationale`, `generated_text`.
- **Domain entity:** `BulletProvenance` —
  `workers/automation/src/jobhunter/domain/materials/provenance.py:49-124`. Carries
  `evidence_ids` (FK), `requirement_ids` (FK), `transform_type: TransformType`,
  `control: ControlRule`, `rationale`, and `generated_text` (the coverage anchor);
  `__post_init__` enforces types up front.
- **Closed transform taxonomy (GROUND-04):** `TransformType` —
  `value_objects.py:87-120`. All five required arms present (`VERBATIM`,
  `REPHRASE`, `REFRAME`, `SYNTHESIZE_FROM_RELATED`, `QUANTIFY_FROM_EVIDENCE`) plus
  a Phase-3 `VOICE` arm.
- **Write path computes against the SHIPPED rendered line:**
  `provenance_builder.py:239-390` (`build_bullet_provenance`) emits one row per
  rendered executive-profile / experience / skills line; `_rendered_line`
  (lines 73-88) sanitises identically to the assembler so `generated_text` is
  byte-identical to what ships. Requirement binding is verified against the
  generated text (`_served_requirements`, lines 137-173), never inferred from the
  job description.
- **Tests:** `tests/test_bullet_provenance.py::test_provenance_has_one_row_per_rendered_bullet_with_closed_taxonomy`
  (:230); `::test_matched_keywords_and_requirement_ids_bind_to_analysis` (:368);
  `::test_provenance_generated_text_is_byte_identical_to_sanitized_shipped_line`
  (:325). Integration:
  `tests/test_tailor_provenance_integration.py::test_accepted_resume_records_provenance_and_publishes_event`
  (:289) asserts `req_latency in experience.requirement_ids` (FK bound) and the
  three sections present. All passing.

### Criterion 2 — FK bindings hard-rejected on fabricated ID — PASS

- **Reject mechanism:** `ProvenanceBindingError` —
  `provenance_builder.py:91-134`. `_sources` builds valid evidence/requirement id
  sets from the plan + persisted analysis; `_validated_evidence_ids` /
  `_validated_requirement_ids` raise *before any row is constructed* on any id not
  in those sets.
- **Use-case gating:** `use_cases.py:1861-1867` catches `ProvenanceBindingError`
  and returns a `fabrication_error`, which downgrades the `ValidationResult` to
  failed (`use_cases.py:987-991`) so the resume is not approved and no provenance
  is written.
- **Tests (the required fabricated-ID fixtures):**
  `tests/test_bullet_provenance.py::test_fabricated_requirement_id_is_rejected_before_any_row_is_built`
  (:415) and `::test_fabricated_evidence_id_is_rejected` (:434). Passing.

### Criterion 3 — Governing control rule recorded per bullet — PASS

- **Enum:** `ControlRule` — `value_objects.py:123-149` (rephrase-allowed,
  invent-closely-related, never-fabricate metrics/titles/dates/employers).
- **Resolution per bullet:** `_resolve_control` —
  `provenance_builder.py:176-190` maps the bullet's transform to the governing
  rule; stored in every row's `control` column.
- **Test:** `tests/test_bullet_provenance.py::test_control_recorded_per_bullet_reflects_governing_rule`
  (:399). Passing.

### Criterion 4 — Deterministic, prompt-independent never-fabricate detector — PASS

- **Detector is pure code, not a prompt:**
  `workers/automation/src/jobhunter/domain/materials/fabrication_detector.py`
  (entire module). Regex token extraction (`_NUMERIC_RE`, `_DATE_RE`,
  `_TITLE_TOKEN_RE`, `_EMPLOYER_RE`) + literal containment against an
  `EvidenceCorpus` built from canonical profile data (`build_evidence_corpus`,
  :249-319). Module docstring + code confirm "NO LLM call and NO I/O". Numeric
  grounding is kind+magnitude-keyed (`_normalize_numeric`, :150-193) so a
  digit-collision (`$35M` vs profile `35%`) is not silently grounded.
- **Runs independently of the judge:** `use_cases._compute_provenance`
  (:1838-1882) runs `scan_resume_bullets` against the actual generated text; on
  any finding it returns a hard-reject error regardless of judge verdict.
- **Tests (the metrics-hungry / numberless fixture):**
  `tests/test_bullet_provenance.py::test_metrics_hungry_job_with_numberless_profile_yields_zero_unsourced_numerics`
  (:589) — every injected number (40%, 5 million, 12, 99.99%) is flagged and none
  trace to the numberless corpus. Plus
  `::test_detector_flags_digit_colliding_fabrication_with_different_unit` (:482),
  `::test_detector_grounds_equivalent_money_renderings` (:520),
  `::test_detector_flags_suffixed_bare_magnitude_against_numberless_profile`
  (:548), `::test_detector_flags_fabricated_title_and_employer` (:619),
  `::test_detector_flags_fabricated_date` (:668). End-to-end proof the detector
  gates past a passing judge:
  `tests/test_tailor_provenance_integration.py::test_suffixed_bare_magnitude_is_hard_rejected_by_detector_and_writes_no_provenance`
  (:328) — judge PASSes, detector rejects `10M`, resume not approved, no
  provenance persisted. All passing.
- **Known, documented limitation (acceptable):** bare-name employers with no
  corporate suffix ("at Netflix") are deferred to the LLM judge by design
  (`fabrication_detector.py:91-108`, pinned by
  `::test_detector_defers_bare_name_employer_to_judge` :634). The structured
  per-entry employer field is code-injected from the master resume, so this path
  cannot fabricate the employer field. Precision-over-recall is a reasoned
  decision, not a gap.

### Criterion 5 — Generation-versioned, supersede-not-destroy, gated on clean approval — PASS

- **Generation-versioned set:** `BulletProvenanceSet` —
  `provenance.py:127-200` (`generation >= 1`, bound to `artifact_id`).
- **Repository supersede-not-destroy:** `SqliteBulletProvenanceRepository.save`
  (`bullet_provenance_repository.py:92-147`) deletes only THIS generation's rows
  before insert (idempotent re-save); a higher generation leaves prior rows
  intact. Empty set = no-op (lines 100-101).
- **Persistence gated on clean approval:** `use_cases.py:1078-1084` — provenance
  is recorded only when `materials.is_resume_approved and provenance_rows`. A
  detected fabrication / binding error has already downgraded validation
  (`:987-991`), so a failed re-tailor writes no rows and the last accepted
  generation survives. Prior generation is re-saved on approval (`:1068-1069`).
- **Tests:** `tests/test_bullet_provenance.py::test_failed_retailor_never_destroys_last_accepted_generation`
  (:745), `::test_saving_empty_provenance_set_is_a_noop` (:761),
  `::test_repository_round_trip_preserves_canonical_fields` (:731). Integration
  no-provenance-on-reject: `test_tailor_provenance_integration.py:328`, `:365`.
  All passing.

---

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `workers/automation/src/jobhunter/domain/materials/provenance.py` | ✓ VERIFIED | Entity + generation-versioned set |
| `.../domain/materials/value_objects.py` (`TransformType`, `ControlRule`) | ✓ VERIFIED | Closed enums |
| `.../domain/materials/provenance_builder.py` | ✓ VERIFIED | FK-validated write path + reject |
| `.../domain/materials/fabrication_detector.py` | ✓ VERIFIED | Pure deterministic detector |
| `.../infrastructure/materials/bullet_provenance_repository.py` | ✓ VERIFIED | Supersede-not-destroy |
| `database.py` `ensure_bullet_provenance_tables` | ✓ VERIFIED | Canonical table + real FK |
| `.../domain/materials/use_cases.py` (wiring) | ✓ VERIFIED | Emit-on-accept, downgrade-on-fabrication, gate |

### Key Link Verification

| From | To | Via | Status |
|------|----|-----|--------|
| `TailorResumeUseCase` | `build_bullet_provenance` / detector | `_compute_provenance` (:1861-1882) | ✓ WIRED |
| fabrication finding | resume rejection | `ValidationResult.failure` (:987-991) | ✓ WIRED |
| accepted generation | `job_bullet_provenance` rows | `_record_provenance` (:1078-1089, :2056-2089) | ✓ WIRED |
| provenance record | `BulletProvenanceRecorded` event | `_publish_provenance` (:2091-2113) | ✓ WIRED |
| `job_bullet_provenance` | API read model DTO | `read-model.ts:2053-2143`, `schemas.ts:1581-1584` | ✓ WIRED |
| Python projection | TS projection | `apps/api/src/projections.ts:798-876` | ✓ WIRED |
| event | web invalidation handler | `apps/web/src/contexts/materials/handlers.ts:2,66` | ✓ WIRED |

### Behavioral / Test Execution

| Suite | Command | Result |
|-------|---------|--------|
| Provenance + integration + parity (py) | `pytest -q test_bullet_provenance.py test_tailor_provenance_integration.py test_audit_projection_parity.py` | 31 passed |
| Adjacent materials/coverage/voice (py) | `pytest -q test_coverage_audit.py test_tailor_voice_audit_integration.py test_materials_use_cases.py` | 47 passed |
| Cross-runtime audit projection parity (ts) | `vitest run test/audit-projection-parity.test.ts` | 1 passed |

Pre-existing unrelated failures (enrichment staleness ×2, materials suppression)
were NOT exercised by the runs above and are explicitly out of Phase 2 scope.

### Anti-Patterns Found

None. No `TODO`/`FIXME`/`XXX`/placeholder markers in any of the five core
Phase-2 files. The one documented detector limitation (bare-name employers) is a
reasoned precision decision with a pinning test and a judge backstop, not debt.

### Requirements Coverage

| Requirement | Status | Evidence |
|-------------|--------|----------|
| GROUND-01 (bullet → evidence) | ✓ SATISFIED | `evidence_ids` FK, builder + table |
| GROUND-02 (bullet → requirement) | ✓ SATISFIED | `requirement_ids` FK verified vs generated text |
| GROUND-03 (provenance entry w/ rationale) | ✓ SATISFIED | `rationale` column + rationale builders |
| GROUND-04 (closed transform taxonomy) | ✓ SATISFIED | `TransformType` enum |
| GROUND-05 (FK bindings, fabricated id rejected) | ✓ SATISFIED | `ProvenanceBindingError` + tests |
| CONTROL-01 (granular rules) | ✓ SATISFIED | `ControlRule` enum semantics |
| CONTROL-02 (rule recorded per bullet) | ✓ SATISFIED | `control` column + `_resolve_control` |
| CONTROL-03 (deterministic detector) | ✓ SATISFIED | `fabrication_detector.py` + fixtures |

### Human Verification Required

None for the Phase-2 grounding contract — every criterion is provable by code +
deterministic tests, all of which were executed and pass.

### Gaps Summary

No gaps. All five success criteria are achieved in the merged code with
file:line evidence and passing tests. The phase goal — canonical FK-bound
per-bullet provenance with a prompt-independent deterministic never-fabricate
detector and supersede-not-destroy versioning — is realised.

---

_Verified: 2026-06-09T19:20:00Z_
_Verifier: Claude (gsd-verifier) — reconcile mode, merged main @ e36ffb1_
