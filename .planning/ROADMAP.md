# Roadmap: JobHunter — Grounded Resume Tailoring

## Overview

This milestone turns resume tailoring into a flagship, trustworthy feature on the existing JobHunter codebase. The work is largely **relocation + canonicalization**, not greenfield: the domain already has the right shapes (`TailoringPlan`, `TailoringChangeAnnotation`, `ArtifactTailoringExplanation`), but they live in opaque `metadata_json`, are recomputed divergently in TypeScript vs Python, and back-fill from sibling files. The journey is dependency-forced: first land a canonical, reasoned **employer analysis** (the root-cause fix for flakey keywords), then attach **per-bullet provenance + granular controls** anchored to that analysis, then run an explicit **voice pass before the final audit** so audited/coverage text equals rendered text, then **rip out the divergent read paths** so the read model serves only canonical rows, and finally — only once all backend audit data is canonical and the broken `generate-materials` path is wired — build the **inspector UI** so it can never mask missing data. Every backend canonicalization lands before any UI, honoring the CLAUDE.md auditability discipline.

## Phases

**Phase Numbering:**
- Integer phases (1, 2, 3): Planned milestone work
- Decimal phases (2.1, 2.2): Urgent insertions (marked with INSERTED)

Decimal phases appear between their surrounding integers in numeric order.

- [x] **Phase 1: Canonical Employer Analysis** - Reasoned, reproducible, persisted "ideal candidate" analysis that replaces flakey keyword extraction and drives all tailoring
- [x] **Phase 2: Per-Bullet Provenance + Granular Controls** - Every bullet records FK-bound evidence × requirement × transform × control × rationale, with never-fabricate enforced deterministically
- [x] **Phase 3: Voice Pass + Final Audit Against Rendered Text** - De-buzzword/voice transform runs before a final audit so coverage and provenance are computed against the exact rendered text
- [x] **Phase 4: Read-Model Cleanup (rip-and-replace)** - Retire the sibling-file fallback and TS coverage recompute; read model serves canonical projection rows with cross-runtime parity
- [x] **Phase 5: Generate-Materials Wiring + Inspector UI** - Fix the broken per-job generation path and expose analysis + provenance + diff + honest missing-state inspection in-app

## Phase Details

### Phase 1: Canonical Employer Analysis
**Goal**: A reasoned, reproducible, persisted employer "ideal candidate" analysis becomes the single source of truth that replaces the flakey hardcoded keyword extraction and drives all downstream tailoring.
**Depends on**: Nothing (first phase)
**Requirements**: ANALYSIS-01, ANALYSIS-02, ANALYSIS-03, ANALYSIS-04, ANALYSIS-05, ANALYSIS-06
**Success Criteria** (what must be TRUE):
  1. Running tailoring on a job produces a persisted `job_employer_analysis` record with structured requirements classified must-have vs nice-to-have and assigned priority/weighting.
  2. Every keyword in the analysis is tied to a quoted job-description evidence span that is a literal substring of the persisted posting snapshot — the old `_extract_job_keywords` heuristic no longer runs.
  3. Running analysis twice on the same job snapshot yields a stable requirement and keyword set (reproducibility fixture passes), and the analysis is reused/cached on re-tailor (keyed by snapshot hash) rather than re-reasoned.
  4. The persisted analysis is served through the canonical read path (projection + DTO, parity across Python and TypeScript builders) and can be read back as an inspectable artifact.
**Plans**: Implemented outside the GSD loop (PRs #141–#145); verified — see the phase VERIFICATION.md

### Phase 2: Per-Bullet Provenance + Granular Controls
**Goal**: Every generated resume bullet carries a canonical, FK-bound provenance record (evidence × requirement × transform × control × rationale) consuming Phase 1's analysis, with never-fabricate enforced by a deterministic detector independent of the prompt.
**Depends on**: Phase 1
**Requirements**: GROUND-01, GROUND-02, GROUND-03, GROUND-04, GROUND-05, CONTROL-01, CONTROL-02, CONTROL-03
**Success Criteria** (what must be TRUE):
  1. Each generated bullet has a `job_bullet_provenance` row linking to the canonical profile-evidence item it derives from and the job requirement it serves, recording a transform type from the explicit taxonomy (verbatim / rephrase / reframe / synthesize-from-related / quantify-from-evidence) and a human-readable rationale.
  2. Provenance is stored as foreign-key bindings, not model-authored free text — a fabricated evidence or requirement ID is hard-rejected at generation time (fabricated-ID fixture proves the reject).
  3. The governing control rule (rephrase always allowed; invent only for closely-related experience; never fabricate metrics/titles/dates/employers) is recorded per bullet so the user can see what policy produced each line.
  4. A deterministic numeric/date/title detector runs independently of the prompt: a metrics-hungry job + a numberless profile yields zero unsourced numerics in the output, and every numeric/date/title token traces to recorded profile evidence.
  5. Provenance is generation-versioned and superseded with its artifact — a failed re-tailor never destroys the last accepted generation's provenance.
**Plans**: Implemented outside the GSD loop (PRs #141–#145); verified — see the phase VERIFICATION.md

### Phase 3: Voice Pass + Final Audit Against Rendered Text
**Goal**: An explicit voice/de-buzzword transform runs before the final audit so the audited and coverage text equals the rendered/PDF text, with provenance and fabrication re-validated after voice and coverage computed honestly against the final canonical text.
**Depends on**: Phase 2
**Requirements**: GROUND-06, VOICE-01, VOICE-02, VOICE-03
**Success Criteria** (what must be TRUE):
  1. An explicit voice pass de-buzzwords and varies bullet structure, measured by deterministic proxies (buzzword density, structure/length variance), and runs before the final audit.
  2. Voice edits are recorded as a transform class within provenance — inspectable, not a hidden prompt tweak — and provenance + fabrication checks are re-validated after the voice pass.
  3. Keyword coverage (covered + missing) is computed against the actual final rendered resume text both renderers consume — a round-trip fixture asserts the audited bullet text equals the rendered text — and the missing list is never suppressed nor inferred from the job description.
  4. A keyword counts as covered only when it appears in a provenance-backed grounded bullet; unsourced keyword-stuffing and substring false positives do not count as covered.
**Plans**: Implemented outside the GSD loop (PRs #141–#145); verified — see the phase VERIFICATION.md

### Phase 4: Read-Model Cleanup (rip-and-replace)
**Goal**: With canonical analysis and provenance rows landed, retire the divergent read paths so the read model serves only canonical projection rows, with cross-runtime projection parity guaranteed.
**Depends on**: Phase 3
**Requirements**: AUDIT-01, AUDIT-02
**Success Criteria** (what must be TRUE):
  1. The `tailoringExplanationForArtifact` sibling-file fallback and the TypeScript-side coverage recompute are deleted; `read-model.ts` serves analysis, provenance, and coverage exclusively from canonical projection rows.
  2. A regression fixture reproduces the old embarrassing/synthesized state from canonical data and proves the new path serves correct audit data without any file-heuristic or legacy-column source.
  3. A cross-runtime projection parity/contract test covers the new audit tables, proving the Python and TypeScript projection builders agree (no schema drift).
**Plans**: Implemented outside the GSD loop (PRs #141–#145); verified — see the phase VERIFICATION.md

### Phase 5: Generate-Materials Wiring + Inspector UI
**Goal**: Fix the currently-broken per-job generate-materials path and expose the employer analysis, per-bullet provenance, controls, and a diff view in an in-app inspector that renders every missing/covered/unmet state explicitly and never destroys the last accepted artifact.
**Depends on**: Phase 4
**Requirements**: INSPECT-01, INSPECT-02, INSPECT-03, INSPECT-04, INSPECT-05, INSPECT-06
**Success Criteria** (what must be TRUE):
  1. The user can invoke per-job materials generation from the product surface — the `generate-materials` route no longer returns 400, the button is enabled, and the previously `fixme`'d E2E spec is unskipped and passing.
  2. The inspector exposes the employer "ideal candidate" analysis (requirements, priorities, reasoned keywords with evidence spans) and per-bullet provenance (evidence × requirement × transform × control × rationale) in-app.
  3. The inspector shows a diff view (original profile bullet → tailored bullet) and renders missing/empty/covered/unmet states explicitly, with per-state Storybook stories proving missing/embarrassing data is never masked.
  4. Re-tailor/retry preserves the last accepted artifact: a failed refresh becomes inspectable audit history and never destroys the current reviewable resume.
**Plans**: Implemented outside the GSD loop (PRs #141–#145); verified — see the phase VERIFICATION.md
**UI hint**: yes

## Progress

**Execution Order:**
Phases execute in numeric order: 1 → 2 → 3 → 4 → 5

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Canonical Employer Analysis | via PR | Complete (verified) | 2026-06-09 |
| 2. Per-Bullet Provenance + Granular Controls | via PR | Complete (verified) | 2026-06-09 |
| 3. Voice Pass + Final Audit Against Rendered Text | via PR | Complete (verified) | 2026-06-09 |
| 4. Read-Model Cleanup (rip-and-replace) | via PR | Complete (verified) | 2026-06-09 |
| 5. Generate-Materials Wiring + Inspector UI | via PR | Complete (verified) | 2026-06-09 |
