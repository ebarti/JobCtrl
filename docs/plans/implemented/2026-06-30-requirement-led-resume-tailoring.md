# Requirement-Led Resume Tailoring

- **Status:** Implemented / archived 2026-06-30. Proposed by #201, delivered by
  #202, and synchronized/archived by #203. Grounded coverage and audit behavior
  received follow-up hardening in #216, #224, #228, and #229.
- **Date:** 2026-06-30
- **Owning bounded contexts:** Scoring, Profile, Materials, Apply, and Operations
- **Source:** Consolidated on 2026-07-12 from the delivered OpenSpec proposal,
  design, capability requirements, and completed task record.

## 1. Outcome

Resume tailoring plans against explicit job requirements rather than relying on
the raw job description or implicit keyword emphasis. A many-to-many
requirement-achievement coverage graph links canonical requirement ids to
profile evidence ids before writing. The writer remains constrained to
profile-row edits and a claim map; code continues to own fixed resume structure,
assembly, validation, rendering, and artifact persistence.

The generation path is evidence-first. A structured fit scorer gates a bounded
revision/enhancement pass only when fit or must-have coverage misses configured
thresholds. Deterministic validators remain authoritative over schema, source
ids, pins, metrics, claim policy, prohibited claims, titles, skills, and review
blockers. Apply Review exposes bounded coverage and revision audit data without
leaking raw prompts or sensitive source payloads.

## 2. Product Invariants

- Every coverage edge references an existing requirement and profile evidence
  id; unknown or duplicate edges fail validation.
- User-pinned experiences and bullets remain authoritative even when they do
  not improve target fit.
- Every selected achievement that covers a target requirement must appear in
  the candidate, including enhancement-produced coverage.
- Mandatory pins and covered achievements may exceed the configured bullet
  budget; the overflow is retained and audited rather than silently dropped.
- Optional positioning content remains subject to the normal bullet budget.
- Scoring may request revision, but it cannot authorize unsupported facts.
- Draft/adjacent claims obey claim policy and explicit review requirements.
- Keyword/requirement coverage is computed from the actual rendered resume
  text or recorded generation-time evidence, never inferred from target terms
  alone.
- Audit projections contain safe ids, bounded excerpts, scores, blockers, and
  decisions—not full profiles, job descriptions, prompts, paths, PDFs, logs,
  browser data, or database contents.

## 3. Architecture Decisions

### 3.1 Build a requirement-achievement coverage graph first

The tailoring plan contains:

- requirement nodes with id, text, tier, weight, source span, keywords, and
  blocker state;
- achievement nodes with evidence id, experience id, source facts, metrics,
  tools, evidence strength, confirmation state, and pin state;
- coverage edges with requirement id, achievement id, coverage kind, strength,
  required claim policy, target terms, and rationale;
- uncovered requirements; and
- unused achievements that may still be included for pins or positioning.

Deterministic assembly loads requirements from `RequirementFitReport` and
achievements from the Profile snapshot. Existing fit evidence seeds direct and
transferable edges. A constrained planner may add edges only between known ids.
Validators reject unknown ids, duplicates, unsupported metrics, prohibited
claims, invalid edge kinds, and policy-incompatible edges.

### 3.2 Preserve code-owned assembly

The writer returns mutable profile-row edits for the executive profile,
experience entries, and skill categories plus a sidecar generated-claim map.
Each claim maps to coverage edges or to an explicit non-requirement reason such
as pinned, positioning, or structure. The model cannot invent new experience,
education, contact, or unsupported skill rows.

### 3.3 Mandatory content overrides layout budgets

Assembly priority is:

1. required experiences and user-pinned bullets;
2. achievements with valid requirement coverage;
3. allowed enhancement-produced achievements that cover remaining gaps;
4. optional positioning achievements while space remains.

When mandatory content exceeds `max_bullets`, the candidate records an overflow
reason such as `pinned_required_bullet`, `requirement_coverage`, or
`enhancement_coverage`. Enhancement may append newly covered evidence but may
not evict previously selected pins or covered achievements.

### 3.4 Controls are defined by real behavioral authority

| Control | Delivered authority |
| --- | --- |
| Claim policy | `verified_only`, `evidence_reframing`, `adjacent_translation`, or `draft_requires_confirmation` governs factual expansion and review state |
| Auto approval | Derived from claim label/policy; draft claims always require confirmation and adjacent behavior is explicit advanced policy |
| Generation permissions | Summary rewrite, achievement-bullet rewrite, and existing-skill selection/order; experience titles stay fixed |
| Required content | Profile-owned required experiences, bullets, and skills; duplicate Preferences pin controls were removed |
| Writing style | Tone, bullet standards, verbosity, first-person preference, and advisory keyword emphasis |
| Revision gates | Minimum fit score, must-have coverage, and maximum attempts; #202 delivered editable persisted thresholds consumed by the worker |
| Additional guidance | Writing/positioning guidance only; it cannot override evidence, pins, policy, or validators |

Legacy Tailoring mode is migration input, not independent runtime authority.
Minor inference and adjacent-draft toggles map into claim policy. Experience-title
reframing is absent because the output schema and validators do not support it.
Keyword density became advisory emphasis rather than a loose hard blocker.

### 3.5 Evidence-first generation precedes score-gated revision

The delivered loop is:

1. Build a target profile from employer analysis, requirement fit, job data,
   and profile evidence.
2. Build and validate the coverage graph.
3. Generate evidence-first profile-row edits from direct/reframed coverage.
4. Assemble and deterministically validate the candidate.
5. Score the assembled resume against the same target profile.
6. Accept when fit and must-have coverage pass and no review blocker exists.
7. If thresholds fail and policy permits, run a minimal bounded revision using
   prioritized scorer fixes and uncovered requirements.
8. Re-score and select the best validator- and review-policy-compliant candidate.

Enhancement is a measured response to a fit gap, not the default writing mode.

## 4. Delivered Product Contract

### 4.1 Coverage planning

- Requirements may have multiple supporting achievements; achievements may
  support multiple requirements.
- Requirements with no valid edge are explicitly uncovered.
- Achievements with no target edge remain visible as unused, with pins and
  positioning treated separately from coverage.
- Planner output that references unknown ids or invalid edge kinds fails closed.
- Existing requirement-fit evidence seeds the graph before any planner call.
- The target-profile adapter carries the target role, seniority, must-have and
  nice-to-have requirements, hard skills, ATS keywords, requirement weights,
  and source spans where available.
- When required employer-analysis or requirement-fit inputs are stale or
  unavailable, the system regenerates them or reports the missing prerequisite;
  it does not run tailoring against an incomplete target or fabricate evidence.

### 4.2 Evidence-first writing and claims

- The writer may edit only supported profile rows and must return claim mapping
  for generated summary, bullet, and skill content.
- New structural rows or unsupported skills are rejected.
- Required pins remain even when the scorer would prefer different content.
- Covered achievements cannot be removed to satisfy normal bullet limits.
- Optional achievements are trimmed before mandatory content.
- Verified-only and evidence-reframing modes cannot introduce new facts.
- Adjacent translation retains source facts and explicit audit labels.
- Draft claims block approval until confirmed.

### 4.3 Revision and deterministic gates

- Fit score and must-have coverage thresholds decide whether revision is
  needed; loose keyword counts do not.
- Revision attempts are bounded by persisted policy.
- Audit metadata records the versioned minimum fit score, must-have coverage
  threshold, and maximum revision attempts used for the decision.
- Enhancement is skipped when policy disallows it or no attempts remain.
- Unsupported metrics, missing mandatory achievements, invalid claim maps,
  prohibited claims, and review-blocking claim states fail deterministic gates.
- Low-quality phrase signals inform scoring/revision but do not replace
  evidence and fabrication validators.

### 4.4 Safe auditability

- Apply Review shows covered/uncovered requirements, evidence links, unused
  achievements, claim labels, review blockers, scorer dimensions, prioritized
  fixes, revision attempts, and mandatory bullet-overflow reasons when data
  exists.
- Revision history records the score before revision, the threshold that
  triggered, the prioritized fixes used, the revision attempt count, the final
  score, why the revision ran, and which candidate was chosen.
- The audit surface uses bounded safe data and never exposes raw prompts, full
  profiles, full job descriptions, local paths, PDFs, logs, browser data, or
  SQLite contents.

## 5. Implementation Record

| Phase | Delivered behavior |
| --- | --- |
| Domain and policy | Policy version/defaults, graph value objects, deterministic validators, control migration adapter |
| Coverage planning | Target-profile adapter, deterministic seeded edges, constrained planner/schema, parser tests, safe persistence |
| Writer/scorer loop | Claim mapping, evidence-first prompt/schema, post-generation fit score, bounded revision/enhancement, candidate selection |
| Assembly and audit | Pins, mandatory coverage, overflow reasons, provenance ids, safe read models, review blockers |
| Preferences | Migrated controls, removed unsupported title authority, advisory keyword emphasis, persisted editable revision gates |
| Documentation and QA | Tailoring architecture, QA matrix, Python evaluation fixtures, API projections, Apply Review and Preferences product-path QA |

## 6. Delivery Evidence And Deviations

The #202 delivery recorded the cross-stack `pnpm check` and `pnpm test` gates,
focused API/projection/draft tests, focused Python requirement-led and profile
repository tests, Ruff, and browser QA across Apply Review, Preferences, and job
detail. Review and QA ended at PASS for the delivered Preferences policy flow.

Two delivery choices intentionally refined the proposal:

- required-content pins remained Profile-owned, so duplicate pin controls were
  removed from Preferences rather than recreated there; and
- revision thresholds became editable, persisted Preferences controls instead
  of read-only policy defaults, with the worker consuming the same stored
  values.

Follow-up work #216, #224, #228, and #229 tightened the source-of-truth rule for
coverage: missing/covered keyword claims and Apply Review audit labels are based
on the shipped resume text and canonical generation evidence, not target
keywords alone.
