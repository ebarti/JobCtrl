---
phase: 03-voice-pass-final-audit
verified: 2026-06-09T17:20:00Z
status: passed
score: 4/4 success criteria verified
mode: goal-backward (reconciliation — already-merged PR #143)
verified_against: e36ffb1 (merged main; PR #143 == 947a2d9)
requirements: [GROUND-06, VOICE-01, VOICE-02, VOICE-03]
gaps: []
human_verification: []
---

# Phase 3: Voice Pass + Final Audit Against Rendered Text — Verification Report

**Phase Goal:** An explicit voice/de-buzzword transform runs BEFORE the final audit so audited + coverage text equals rendered/PDF text, with provenance and fabrication re-validated after voice and coverage computed honestly against the final canonical text.

**Verified:** 2026-06-09T17:20:00Z
**Status:** PASSED — 4/4 success criteria verified with code + test evidence
**Re-verification:** No — initial (post-merge reconciliation; no prior VERIFICATION.md)
**Implemented by:** PR #143 (commit `947a2d9`)

## Overall Verdict

**PASS.** All four success criteria are achieved in the merged code, each anchored to substantive implementation AND passing regression tests. The voice pass is a real Claude Agent SDK transform gated by deterministic proxies; it runs before the final audit; voice edits are recorded as a `VOICE` transform class in provenance; provenance + the never-fabricate detector are re-run against the voiced text; coverage is computed against the rendered text both renderers consume, with a round-trip fixture against the ACTUAL LaTeX renderer; and coverage counts a keyword only when it appears (word-boundary) in a provenance-backed grounded bullet.

32/32 Phase-3 Python tests pass; 16/16 API projection tests pass; full Python suite is 1321 passed / 3 failed — and the 3 failures are the documented pre-existing unrelated ones (2× enrichment staleness, 1× materials suppression backfill).

## Success Criteria Verdicts

| # | Criterion | Verdict | Key Evidence |
|---|-----------|---------|--------------|
| 1 | Explicit voice de-buzzword + structure variance via deterministic proxies, runs BEFORE the audit | ✓ PASS | `voice.py`, `voice_metrics.py`, `use_cases.py:965-995` |
| 2 | Voice recorded as a transform class in provenance; provenance + fabrication re-validated AFTER voice | ✓ PASS | `use_cases.py:469-490, 1953-1980`, `value_objects` `TransformType.VOICE` |
| 3 | Coverage computed vs the actual rendered text both renderers consume; round-trip fixture asserts audited == rendered; missing never suppressed/JD-inferred | ✓ PASS | `coverage_audit.py`, `scoring/tailor.py:347`, round-trip LaTeX fixture |
| 4 | A keyword counts as covered only in a provenance-backed grounded bullet; no stuffing / substring false positives | ✓ PASS | `coverage_audit.py:41-51,122-155`, `quality.py:_contains_term` |

---

### Criterion 1 — Explicit voice pass with deterministic proxies, before the audit — PASS

**The voice transform exists and is substantive:**
- `workers/automation/src/jobhunter/domain/materials/voice.py` — pure domain model: `VoicePayload` (SDK structured-output schema), `VoiceRequest`/`VoiceResult`, `build_voice_request` (extracts mutable prose only — executive profile + experience bullets; skills deliberately excluded), and `apply_voice_to_payload` (deep-copy fold-back; replaces bullets 1:1 only on equal-count match so per-bullet identity is preserved).
- `workers/automation/src/jobhunter/infrastructure/materials/voice_adapter.py:86-125` — `ClaudeVoiceAdapter` (`VoicePort`), a real Claude Agent SDK call with native structured output (`output_format` json_schema), `max_turns=None` (no timeout, per directive). Not a stub.

**Deterministic proxies (the measurable VOICE-01 gate):**
- `workers/automation/src/jobhunter/domain/materials/voice_metrics.py`:
  - Buzzword density (`_count_buzzwords` over a focused lexicon = `BANNED_WORDS` ∪ `ANTI_AI_VOICE_MARKERS`, dedup, longest-first; word-boundary for single words, substring for phrases) — `voice_metrics.py:69-85,129-139`.
  - Structural variety = mean of opening-token diversity + normalised length variance (coefficient of variation capped at 1.0) — `voice_metrics.py:141-173`.
  - `VoiceMetricsDelta.improved` (`voice_metrics.py:194-201`): accept only when buzzword density reduced OR variety increased.

**Ordering — voice runs BEFORE the final audit:**
- `use_cases.py:965-995`: after candidate selection, `_voice_and_audit(...)` is called (lines 975-986) to produce `final_payload`, then the rendered text is assembled from `final_payload` (line 995). The audit (provenance + coverage) is computed inside `_voice_and_audit` against the voiced text.
- `_run_voice` (`use_cases.py:1982-2024`) applies the deterministic gate: `measure_voice_delta(before_bullets, after_bullets)` and only returns the voiced payload when `delta.improved`; otherwise returns `None` and the pre-voice candidate ships (line 2022-2023).

**Tests:** `test_voice_runs_before_audit_and_provenance_anchors_to_voiced_text` (integration:318) asserts `experience.generated_text == "Owned the API and cut latency 40% with Python."` and `"spearheaded" not in generated_text` — i.e. the audit/provenance saw the voiced wording. `test_voice_metrics.py` (passing) pins the proxies. `test_voice_did_not_improve` path covered by `test_voice_failure_falls_back_to_pre_voice_candidate` / no-op fallbacks.

---

### Criterion 2 — Voice recorded as a transform class; provenance + fabrication re-validated AFTER voice — PASS

**Voice recorded as an inspectable transform class (not a hidden prompt tweak):**
- `TransformType.VOICE` added to `domain/materials/value_objects.py` (referenced `use_cases.py:114,487`).
- `_mark_voiced_rows` (`use_cases.py:469-490`): compares voiced rows vs pre-voice rows by `bullet_id`; any row whose `generated_text` changed is re-marked `transform_type = TransformType.VOICE` (the outermost/shipped transform, VOICE-02).
- `VoicePassRecord` (`voice.py:179-225`) is persisted with `ran`/`accepted`/`model`/`prompt_version`/`proxy_delta`/`reason` — the proxy delta that justified acceptance is inspectable. It rides on `BulletProvenanceSet` and is projected to the read model (`voice_pass_json` → `voicePass`).

**Provenance + fabrication re-validated AFTER the voice pass (VOICE-03):**
- `_voice_and_audit` (`use_cases.py:1953-1980`): after the voice pass produces `voiced_payload`, `_compute_provenance(...)` is re-run on the VOICED payload — which re-runs `build_bullet_provenance` (FK-binding gate) AND `scan_resume_bullets` (deterministic never-fabricate detector) against the voiced text (`_compute_provenance`, `use_cases.py:1838-1882`).
- If the voiced text introduced a fabrication / broke a binding (`voiced_error is not None`, line 1959), the voiced payload is DISCARDED and the clean pre-voice candidate ships, with the failed voice kept as audit history (`reason="voice_introduced_fabrication: ..."`, lines 1963-1972) — the last-accepted material is never destroyed (CLAUDE.md re-tailor invariant).

**Tests:**
- `test_voiced_bullet_is_recorded_as_voice_transform` (:354) asserts `experience.transform_type is TransformType.VOICE`.
- `test_voice_introduced_fabrication_is_rejected_and_pre_voice_ships` (:383) asserts the fabricated token ("10m") is absent from all saved rows AND no row carries `TransformType.VOICE` (pre-voice shipped).
- `test_voice_failure_falls_back_to_pre_voice_candidate` (:570) asserts a voice SDK error yields `voice.ran and not voice.accepted` with the pre-voice bullet shipping.

---

### Criterion 3 — Coverage vs rendered text both renderers consume; round-trip fixture; missing never suppressed/JD-inferred — PASS

**Single final canonical text both renderers consume:**
- `TailorOutcome.final_payload` (`use_cases.py:823-829`) is the single voiced payload. The plain-text resume is assembled from it (`use_cases.py:995`), provenance `generated_text` is computed from it, coverage is computed over those rows, AND the PDF renderer consumes it: `scoring/tailor.py:347` — `parsed_payload = outcome.final_payload or _selected_candidate_payload(...)` is passed to `pdf_renderer.render_resume_to_pdf`. The two render paths cannot diverge.

**Coverage computed against the rendered grounded text:**
- `coverage_audit.py:122-155` `compute_keyword_coverage`: consults only grounded provenance rows' `generated_text` (the byte-identical rendered line); `computed_against = "rendered_text"`. `missing = analysis_keywords − covered` (line 149) — computed, never derived from the JD, never suppressed.

**Round-trip fixtures (audited == rendered):**
- `test_round_trip_audited_bullet_text_equals_rendered_text` (integration:453) asserts every persisted provenance row's `generated_text` appears in the shipped plain-text resume.
- `test_round_trip_audited_bullet_text_equals_rendered_latex` (integration:489) — the load-bearing one: renders `outcome.final_payload` through the REAL `build_latex` (the only resume renderer the user ships; `PlaywrightHtmlPdfAdapter.render_resume_to_pdf` raises `NotImplementedError`) and asserts each accepted row's `generated_text` — LaTeX-escaped with the same `_escape_latex_light` the renderer uses — appears in the rendered LaTeX body. Also guards the pre-voice draft ("spearheaded") is ABSENT and the `%` is genuinely LaTeX-escaped (`cut latency 40\% with Python.`), proving the assertion is against renderer presentation, not plain text.

**Read-model serves canonical generation-time truth (not JD-inferred):**
- `apps/api/src/read-model.ts:2061-2098` — `coverageAudit`/`voicePass` served from `coverage_audit_json`/`voice_pass_json`; `keywordsBlockFromCoverageAudit` derives the displayed keywords block from the canonical coverage audit, not the job description.
- `apps/api/test/projections.test.ts:1421-1557` — TS↔Python parity: API read model serves the SAME `coverageAudit` + `voicePass`, including PDF artifact resolving coverage from the sibling row (`pdfExplanation.coverageAudit?.covered == ["latency"]`, `voicePass?.accepted == true`).

**Tests:** `test_coverage_is_computed_against_rendered_text_and_provenance_backed` (integration:421) asserts `coverage.computed_against == "rendered_text"`, both analysis keywords covered, `missing == ()`. `test_missing_list_is_never_empty_when_a_keyword_is_absent` (coverage_audit:123). 16/16 API projection tests pass.

---

### Criterion 4 — Covered only when in a provenance-backed grounded bullet; no stuffing / substring false positives — PASS

**Grounded-only counting:**
- `coverage_audit.py:41-51` `_is_grounded`: a row counts only when it carries a real `evidence_ids` OR `requirement_ids` FK binding (validated against canonical profile/analysis before the row is built). `compute_keyword_coverage` filters to `grounded_rows` only (`coverage_audit.py:136`).

**No substring false positives:**
- Coverage uses `_contains_term` (`quality.py:1040-1046`): word-boundary regex `(?<![a-z0-9+#./-])TERM(?![a-z0-9+#./-])` for single-word terms, so `java` does not match `javascript`.

**Tests (all passing):**
- `test_keyword_in_grounded_bullet_counts_as_covered` (coverage_audit:83).
- `test_keyword_only_in_ungrounded_skills_dump_is_missing_not_covered` (:92) — keyword-stuffing an ungrounded skills line does NOT count as covered.
- `test_substring_false_positive_does_not_count` (:106) — `java` inside `javascript` is missing, not covered.
- `test_covered_records_the_grounded_bullet_it_was_found_in` (:115) — `covered_by` maps keyword → grounded bullet_id (inspectable).

---

## Anti-Pattern Scan

No blocker anti-patterns in Phase-3 source. Checked `voice.py`, `voice_metrics.py`, `coverage_audit.py`, `voice_adapter.py`, `use_cases.py` (Phase-3 sections), `scoring/tailor.py`:
- No `TBD`/`FIXME`/`XXX` debt markers in Phase-3 code.
- `voice_adapter.py:35` carries a benign comment "Re-confirm the id at impl time; model ids drift." (`CLAUDE_VOICE_MODEL = "claude-opus-4-8"`); this is informational, not a debt marker, and the model id is set. ℹ️ Info only.
- Empty-collection returns (`return ()`, coverage `None` on ungrounded) are intentional, documented neutral states, not stubs (verified: each is overwritten/derived by real computation or guards a meaningful absence).

## Test Execution Evidence

| Suite | Command | Result |
|-------|---------|--------|
| Phase-3 Python | `pytest -q test_coverage_audit test_voice_metrics test_voice_payload test_voice_adapter test_tailor_voice_audit_integration` | 32 passed |
| API projections | `vitest run test/projections.test.ts` | 16 passed |
| Full Python suite | `pytest -q` | 1321 passed, 3 failed |

The 3 full-suite failures are the documented PRE-EXISTING unrelated ones and are NOT counted against this phase:
- `test_enrichment_detail_staleness.py::test_scrape_detail_page_reports_expired_json_ld_as_inactive`
- `test_enrichment_detail_staleness.py::test_scrape_detail_page_reports_closed_marker_as_inactive`
- `test_materials_repository.py::test_suppress_backfilled_legacy_job_makes_selectors_treat_paths_inactive`

(A Temporal gRPC connection warning appears in the full run — environmental, no dev server running — and is unrelated to Phase 3.)

## Gaps

None. No Blocker or High gaps. No human verification required for the verified invariants (all are deterministically asserted by passing tests against the real renderer/read-model).

---

_Verified: 2026-06-09T17:20:00Z_
_Verifier: Claude (gsd-verifier) — goal-backward reconciliation of merged PR #143_
