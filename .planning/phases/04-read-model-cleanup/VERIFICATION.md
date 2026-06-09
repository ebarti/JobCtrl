---
phase: 04-read-model-cleanup
verified: 2026-06-09T17:18:06Z
status: passed
score: 3/3 must-haves verified
verified_against: e36ffb1cc282461321cd0d300a85ca219fc11146
implemented_by: PR #144 (1a72b4a)
requirements: [AUDIT-01, AUDIT-02]
gaps: []
---

# Phase 4: Read-Model Cleanup (rip-and-replace) Verification Report

**Phase Goal:** With canonical analysis + provenance rows landed, retire the divergent read paths so the read model serves ONLY canonical projection rows, with cross-runtime projection parity guaranteed.

**Verified:** 2026-06-09T17:18:06Z (worktree HEAD = merged main @ e36ffb1)
**Status:** PASSED (3/3 success criteria)
**Re-verification:** No — initial verification of already-merged work (PR #144)

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Sibling-FILE fallback + TS-side coverage recompute DELETED; `read-model.ts` serves analysis/provenance/coverage exclusively from canonical projection rows | ✓ VERIFIED | `apps/api/src/read-model.ts:2039-2068`, `:2087-2115`, `:2297` |
| 2 | Regression fixture reproduces old embarrassing/synthesized state from canonical data; new path serves correct audit data with no file-heuristic / legacy-column source | ✓ VERIFIED | `apps/api/test/server.test.ts:2349-2407`, `:2425-2490`, `:2492-2559` |
| 3 | Cross-runtime projection parity/contract test covers new audit tables; Python + TS builders agree (no schema drift) | ✓ VERIFIED | `apps/api/test/audit-projection-parity.test.ts`, `workers/automation/tests/test_audit_projection_parity.py`, shared fixture `packages/domain-types/test/fixtures/audit_projection_parity.json` |

**Score:** 3/3 truths verified

---

### Criterion 1 — Divergent read paths retired (PROVE ABSENCE)

**Verdict: PASS**

`tailoringExplanationForArtifact` (`read-model.ts:2039`) now parses the base explanation from the artifact's OWN `metadata_json` projection column only (`:2051 parseTailoringExplanation(row.metadata_json)`). On a `null` parse it returns `null` (`:2052`) — no neighbour `metadata_json` and no sibling `.txt` file is read.

- **Sibling-FILE fallback: ABSENT.** `grep` for filesystem reads in `read-model.ts` finds only:
  - `readJson` (`:4227`) used solely for `paths.settingsPath` (`:1765`) — dashboard settings, NOT tailoring audit.
  - `localFileSize`/`fs.statSync` (`:4245`) — artifact size reporting, NOT audit content.
  None of the audit-serving functions (`tailoringExplanationForArtifact`, `bulletProvenanceForArtifact`, `coverageAuditForArtifact`, `voicePassForArtifact`) touch the filesystem. The word "sibling" remaining in the file refers exclusively to the **sibling tailored-resume projection ROW** (canonical SQL on `artifact_list_projections`, e.g. `:2129-2143`, `:2198-2211`), which is canonical, not a file.
- **TS-side keyword coverage recompute: ABSENT.** The `keywords` block is now DERIVED from the canonical coverage audit via `keywordsBlockFromCoverageAudit(explanation.coverageAudit)` (`:2067`, body `:2087-2115`). It maps `planned/covered/missing` straight off `coverage_audit_json`, sets `filtered:[]` and `coverageRecorded: coverageAudit !== null` — there is no job-keyword extraction, resume-text matching, or candidate pruning. `parseTailoringExplanation` (`:2297`) explicitly NO LONGER computes the keywords block (docstring `:2288-2296`). No `textCoverage`/`recomputeCoverage`/`computeCoverage` symbols exist anywhere in `apps/api/src/`.
- PR #144 diff removes 464 lines net from `read-model.ts` (`git show 1a72b4a --stat`), consistent with the documented ~290-line read-time keyword-extraction machinery deletion.

The single `tailoringExplanationForArtifact` definition was inspected closely (the earlier probe's "1 file" hit) and confirmed canonical-only.

### Criterion 2 — Regression fixtures reproduce old state from canonical data

**Verdict: PASS**

Three substantive regression tests in `apps/api/test/server.test.ts` reproduce the exact pre-fix embarrassing states from canonical data and assert the honest new behavior:

- `:2349` "serves an empty keyword block when no canonical coverage exists (no read-time recompute)" — seeds a resume FILE + job description FULL of recoverable keywords (AWS, CI/CD, Developer Platform, Observability) but NO canonical coverage row. Asserts `coverageRecorded:false`, all lists empty, and that **none** of the file/JD keywords leak into the served block (`:2401-2404`). This is the exact synthesized state the old recompute produced.
- `:2425` "flags keyword-only tailoring explanations as incomplete audit metadata" — shell metadata + a canonical coverage row; the served keyword block reflects the canonical coverage (not a read-time recompute) AND the incomplete-audit error is still flagged.
- `:2492` "does not synthesize a PDF artifact's audit from a sibling artifact's metadata" — a PDF with shell metadata whose sibling text resume carries a COMPLETE audit blob; asserts the PDF serves ONLY its own (incomplete) metadata and is honestly flagged, never borrowing the sibling's audit (`:2549-2556`).

These prove the new path serves correct audit data with no file-heuristic / legacy-column / sibling-synthesis source.

### Criterion 3 — Cross-runtime projection parity/contract test

**Verdict: PASS**

A genuine TS↔Python drift guard driven from ONE shared fixture:

- Shared fixture: `packages/domain-types/test/fixtures/audit_projection_parity.json` (canonical rows + a single `expected` projection-column block).
- TS half (`apps/api/test/audit-projection-parity.test.ts`): seeds the canonical rows, triggers the REAL TS projection builder via a read, then asserts the materialised `job_detail_projections.employer_analysis_json` and `artifact_list_projections.{bullet_provenance_json,coverage_audit_json,voice_pass_json}` equal the fixture `expected` block (`:274-292`), plus the read-model DTO round-trip (`:299-356`).
- Python half (`workers/automation/tests/test_audit_projection_parity.py`): seeds the SAME canonical rows, runs the REAL `ProjectionBuilder(...).refresh()` (`:198`), and asserts the same projection columns equal the SAME fixture `expected` block (`:208`, `:219-221`).

Because both builders are checked against one canonical-derived expectation, a serialization/schema drift in EITHER runtime fails its test. This is a true cross-runtime contract (unlike the earlier Phase-3 test that hand-seeded projection JSON on the TS side only).

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `apps/api/src/read-model.ts` | Canonical-only audit serving; fallback + recompute deleted | ✓ VERIFIED | `tailoringExplanationForArtifact` + helpers canonical-only; no fs reads for audit; -464 net lines |
| `apps/api/test/server.test.ts` | Criterion-2 regression tests | ✓ VERIFIED | 3 tests at `:2349`, `:2425`, `:2492` reproduce old state from canonical data |
| `apps/api/test/audit-projection-parity.test.ts` | TS half of parity guard | ✓ VERIFIED | Real builder + read model asserted vs shared fixture |
| `workers/automation/tests/test_audit_projection_parity.py` | Python half of parity guard | ✓ VERIFIED | Real `ProjectionBuilder.refresh()` asserted vs same shared fixture |
| `packages/domain-types/test/fixtures/audit_projection_parity.json` | Single shared contract fixture | ✓ VERIFIED | Canonical rows + `expected` block consumed by both runtimes |

### Behavioral Spot-Checks (tests run)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full TS API suite (incl. parity + criterion-2 regression) | `pnpm api:test` | 10 files, 201 tests passed | ✓ PASS |
| Python cross-runtime parity test | `pytest -q workers/automation/tests/test_audit_projection_parity.py` | 1 passed | ✓ PASS |
| Python projection/materials/provenance/analysis suite | `pytest -q -k "projection or materials or provenance or analysis"` | 266 passed, 1 failed (pre-existing, see below) | ✓ PASS |

### Requirements Coverage

| Requirement | Description | Status | Evidence |
|-------------|-------------|--------|----------|
| AUDIT-01 | Audit data served from a single canonical source; no synthesized/file-heuristic fallback | ✓ SATISFIED | Criterion 1 + 2 |
| AUDIT-02 | Cross-runtime projection parity for audit tables (no TS↔Python schema drift) | ✓ SATISFIED | Criterion 3 |

### Anti-Patterns Found

None blocking. No `TODO`/`FIXME`/`XXX`/`PLACEHOLDER` introduced in the audit-serving paths. The remaining `fs`/`readJson` usages in `read-model.ts` are scoped to settings and file-size reporting, not audit content.

### Pre-Existing Unrelated Failure (NOT counted)

`workers/automation/tests/test_materials_repository.py::test_suppress_backfilled_legacy_job_makes_selectors_treat_paths_inactive` — the known "materials suppression" pre-existing failure called out in the verification brief. Confirmed unrelated to Phase 4: the test file was last modified by PR #133 (`4ad381c`) and is NOT in PR #144's changeset (`git show 1a72b4a --stat` → 0 matches). Excluded from the verdict per instructions. The other two flagged pre-existing failures (enrichment staleness x2) fall outside the projection/materials suite run and are likewise excluded.

### Gaps Summary

No gaps. All three success criteria PASS with file:line evidence and green tests. The merged code retires the divergent read paths (sibling-file fallback + TS keyword recompute deleted), serves analysis/provenance/coverage exclusively from canonical projection rows, ships substantive regression fixtures reproducing the old synthesized state from canonical data, and enforces cross-runtime TS↔Python projection parity via a single shared fixture asserted by both builders.

---

_Verified: 2026-06-09T17:18:06Z_
_Verifier: Claude (gsd-verifier)_
