# Requirements: JobHunter — Grounded Resume Tailoring

**Defined:** 2026-06-08
**Core Value:** A user can trust every line of a tailored resume — because each bullet traces, visibly, to a real profile fact *and* a specific job requirement, with the reasoning and the transform rule that produced it on display.

## v1 Requirements

Requirements for this milestone. Each maps to roadmap phases. Resume-only scope.

### Job/Employer Analysis (Pillar A)

- [x] **ANALYSIS-01**: System extracts structured requirements from the job description (responsibilities, qualifications), classified as must-have vs nice-to-have
- [x] **ANALYSIS-02**: System assigns priority/weighting to requirements so tailoring can spend resume space on what matters most
- [x] **ANALYSIS-03**: System produces a reasoned keyword set with each keyword tied to a quoted job-description evidence span, replacing the flakey hardcoded extraction (`_extract_job_keywords`)
- [x] **ANALYSIS-04**: The employer "ideal candidate" analysis is persisted as a canonical, inspectable artifact that drives all downstream tailoring
- [x] **ANALYSIS-05**: Job analysis is reproducible — the same job snapshot yields a stable requirement/keyword set across runs
- [x] **ANALYSIS-06**: The persisted analysis is cached/reused on re-tailor (keyed by job-snapshot hash) to bound latency and cost

### Grounding & Per-Bullet Provenance (Pillar B)

- [x] **GROUND-01**: Every tailored resume bullet links to the canonical profile evidence item it derives from
- [x] **GROUND-02**: Every tailored resume bullet links to the job requirement it serves
- [x] **GROUND-03**: Each bullet records a per-bullet provenance entry capturing evidence, requirement served, transform type, and a human-readable rationale ("chose this because…, worded it like this because…")
- [x] **GROUND-04**: Each bullet records its transform type from an explicit taxonomy (verbatim / rephrase / reframe / synthesize-from-related / quantify-from-evidence)
- [x] **GROUND-05**: Provenance is stored as canonical foreign-key bindings (not model-authored free text); fabricated evidence/requirement IDs are rejected at generation time
- [x] **GROUND-06**: Keyword coverage (covered + missing) is computed against the actual generated/rendered resume text at generation time; the missing list is never suppressed nor inferred from the job description alone

### Granular Tailoring Controls (Pillar C)

- [x] **CONTROL-01**: Tailoring is governed by granular rules — rephrase always allowed; invent only for closely-related experience; never fabricate metrics, titles, dates, or employers
- [x] **CONTROL-02**: The governing control rule is recorded per bullet/decision so the user can see what policy produced each line
- [x] **CONTROL-03**: A deterministic detector enforces never-fabricate independently of the prompt — every numeric/date/title token must trace to recorded profile evidence

### Human-Authentic Voice (Pillar D)

- [x] **VOICE-01**: An explicit voice pass de-buzzwords and varies bullet structure to directly target the "reeks like AI" smell
- [x] **VOICE-02**: Voice edits are recorded as a transform class within provenance — inspectable, not a hidden prompt tweak
- [x] **VOICE-03**: The voice pass runs before the final audit so audited/coverage text equals rendered text; provenance and fabrication checks are re-validated after the voice pass

### Inspector UI & Per-Job Wiring (Pillar E + prerequisite)

- [x] **INSPECT-01**: Per-job materials generation is invokable from the product surface — wire the currently-broken `generate-materials` path (route returns 400, button disabled, E2E `fixme`), enable the button, and unskip the E2E
- [x] **INSPECT-02**: The app exposes the employer "ideal candidate" analysis (requirements, priorities, reasoned keywords) in an in-app inspector surface
- [x] **INSPECT-03**: The inspector shows per-bullet provenance (evidence × requirement × transform × control × rationale)
- [x] **INSPECT-04**: The inspector shows a diff view (original profile bullet → tailored bullet)
- [x] **INSPECT-05**: The inspector renders missing/empty/covered/unmet states explicitly and never masks missing audit data
- [x] **INSPECT-06**: Re-tailor/retry preserves the last accepted artifact; failed refreshes become audit history and never destroy the current reviewable resume

### Read-Model Integrity / Canonicalization (cross-cutting)

- [x] **AUDIT-01**: Analysis, provenance, and coverage are served from canonical projection rows; the sibling-file fallback and the TypeScript-side coverage recompute are removed (rip-and-replace)
- [x] **AUDIT-02**: Cross-runtime projection parity (TypeScript ↔ Python) for the new audit tables is covered by a parity/contract test

## v2 Requirements

Deferred to a future release. Tracked but not in the current roadmap.

### Deeper Inspection

- **EVID-01**: Evidence-strength signaling per bullet (strong direct match / stretch / absent)
- **MAP-01**: Requirement-coverage map — a two-way ledger (each requirement → bullets that serve it; each bullet → its requirement)
- **DELTA-01**: Re-tailor policy-delta view (what changed and why between attempts)
- **CONTROL-04**: Per-section policy overrides (e.g. stricter rules for a metrics-heavy section)

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| Cover-letter tailoring overhaul | Resume-only this milestone; the shared employer analysis lets cover letters adopt it later |
| Formal eval / golden-fixture quality harness | Explicitly deferred by choice; large surface; the planned next milestone (top cure for "inconsistent quality") |
| Auto-invented metrics / quantify achievements the user never stated | Fabrication — the category's cardinal failure; violates never-fabricate trust floor |
| Keyword stuffing to maximize a match score | Produces robotic, human-rejected resumes; gameable score becomes the goal |
| Single headline "ATS score" as the primary output | A scalar hides reasoning and invites gaming; contradicts inspectability-first |
| Fully automated mass tailoring / auto-apply with no review | Removes the human-in-the-loop grounding exists to serve; apply automation stays separate + opt-in |
| Inferring/suppressing coverage from the job description instead of generated text | Explicitly forbidden by CLAUDE.md auditability discipline |
| Voice calibration from the user's own writing samples | Deepen voice later once the baseline voice work proves out |
| Multi-resume / template-variant tailoring | Defer until the single grounded path is trusted |
| Hosted / multi-tenant / auth changes | Remains local-first single-user |

## Traceability

Which phases cover which requirements. Populated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| ANALYSIS-01 | Phase 1 | Done |
| ANALYSIS-02 | Phase 1 | Done |
| ANALYSIS-03 | Phase 1 | Done |
| ANALYSIS-04 | Phase 1 | Done |
| ANALYSIS-05 | Phase 1 | Done |
| ANALYSIS-06 | Phase 1 | Done |
| GROUND-01 | Phase 2 | Done |
| GROUND-02 | Phase 2 | Done |
| GROUND-03 | Phase 2 | Done |
| GROUND-04 | Phase 2 | Done |
| GROUND-05 | Phase 2 | Done |
| CONTROL-01 | Phase 2 | Done |
| CONTROL-02 | Phase 2 | Done |
| CONTROL-03 | Phase 2 | Done |
| GROUND-06 | Phase 3 | Done |
| VOICE-01 | Phase 3 | Done |
| VOICE-02 | Phase 3 | Done |
| VOICE-03 | Phase 3 | Done |
| AUDIT-01 | Phase 4 | Done |
| AUDIT-02 | Phase 4 | Done |
| INSPECT-01 | Phase 5 | Done |
| INSPECT-02 | Phase 5 | Done |
| INSPECT-03 | Phase 5 | Done |
| INSPECT-04 | Phase 5 | Done |
| INSPECT-05 | Phase 5 | Done |
| INSPECT-06 | Phase 5 | Done |

**Coverage:**
- v1 requirements: 26 total (enumerated list is authoritative; the earlier "24" header was a miscount — ANALYSIS 6 + GROUND 6 + CONTROL 3 + VOICE 3 + INSPECT 6 + AUDIT 2 = 26)
- Mapped to phases: 26 ✓
- Unmapped: 0 ✓

---
*Requirements defined: 2026-06-08*
*Last updated: 2026-06-09 — all 26 v1 requirements verified DONE (goal-backward against merged code); see .planning/MILESTONE-ACCEPTANCE.md. (2026-06-08: traceability populated, v1 count corrected to 26.)*
