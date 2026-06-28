## Context

JobHunter already has the raw ingredients for requirement-led tailoring:

- `RequirementFitReport` records job requirements, fit kind, evidence IDs,
  tailoring directives, prohibited claims, weights, and confidence.
- Profile experience entries can carry `achievement_evidence` with IDs, source
  text, scope, action, tools, metrics, outcomes, evidence strength, confidence,
  user confirmation, and tags.
- Profile tailoring rules carry required experience entries, required bullets,
  required skills, max bullets, current claim controls, writing style, and
  rewrite permissions.
- The current generator returns profile-row edits, not a full canonical resume.
  Code assembles fixed structure and validates the result.

The missing concept is a first-class many-to-many coverage graph. Today,
requirement directives are consumed as prompt guidance, but the generation
contract does not force the system to decide which requirements are covered by
which profile achievements before writing the resume.

## Goals / Non-Goals

**Goals:**

- Make requirement coverage the first-class tailoring plan.
- Preserve the code-owned assembly model: the writer returns mutable profile-row
  edits plus claim/coverage mappings, not arbitrary full-resume structure.
- Define the control model the new flow needs, then migrate existing Preferences
  controls into that model.
- Use an evidence-first pass before any enhancement pass.
- Link enhancement and auto-approval behavior to claim policy.
- Preserve user-pinned required experiences and bullets even when they do not
  cover a target requirement.
- Use post-generation scoring to decide whether revision/enhancement is needed.
- Persist safe audit data that explains coverage, gaps, unused achievements,
  enhancement status, and revision decisions.

**Non-Goals:**

- Do not train or fine-tune models.
- Do not let generated content modify the canonical profile automatically.
- Do not allow the writer to create new experience rows, education rows, contact
  fields, or unsupported skills.
- Do not treat keyword counts or stock phrase markers as hard fit authority.
- Do not preserve current Preferences controls just because they exist. Controls
  that do not map to a real behavior must be removed, remapped, or hidden behind
  an explicit compatibility migration.

## Decisions

### 1. Add A Requirement-Achievement Coverage Graph

Introduce a tailoring-time graph with:

- `requirements[]`: requirement id, text, tier, weight, source span, keywords,
  and blocker status.
- `achievements[]`: profile achievement evidence id, experience entry id,
  source text, metrics, tools, strength, confirmation state, and whether it is
  user-pinned.
- `coverage_edges[]`: requirement id, achievement evidence id, coverage kind,
  strength, claim policy needed, target terms, and rationale.
- `uncovered_requirements[]`: requirements with zero valid coverage edges.
- `unused_achievements[]`: profile achievements with zero target coverage edges
  that may still be included if pinned or valuable positioning evidence.

The graph is built through deterministic assembly plus a constrained planner:

- Deterministic assembly loads requirements from `RequirementFitReport` and
  profile achievements from `ProfileSnapshot`.
- Existing `RequirementFitAssessment.fit.evidence_ids` seed direct or
  transferable edges.
- A coverage planner may propose additional edges, but only by referencing
  existing requirement IDs and existing achievement evidence IDs.
- Validators reject unknown IDs, duplicate edges, invalid coverage kinds,
  unsupported metrics, prohibited claims, and claim-policy violations.

Alternative considered: ask the writer to infer mappings while writing. That is
the current failure mode in another form; it makes coverage hard to audit and
hard to repair.

### 2. Keep Profile-Row Edits, Add Claim Mapping

The final writer still emits mutable resume edits keyed by profile IDs:

- `executive_profile`
- `experience_updates[]`
- `skill_category_updates[]`

The schema should add a sidecar claim map rather than switch to a full-resume
schema. Each generated bullet and summary claim should map to one or more
coverage edges or to an explicit non-requirement reason such as `pinned`,
`positioning`, or `structure`.

Code remains responsible for contact info, education, section order, rendering,
and final artifact assembly.

Alternative considered: ask the model to emit the full resume JSON. That would
make assembly simpler superficially, but it expands the model's authority into
fixed profile structure and makes accidental profile drift more likely.

### 3. Define Controls By Behavioral Authority

The required controls are:

1. Claim policy:
   - `verified_only`: only verified or user-confirmed source claims.
   - `evidence_reframing`: rewrite existing evidence without adding new factual
     content.
   - `adjacent_translation`: translate adjacent evidence into target vocabulary
     while preserving source facts and requiring explicit audit labels.
   - `draft_requires_confirmation`: allow draft adjacent claims, but block
     auto-approval until user review confirms them.
2. Auto-approval policy:
   - derived from claim policy and claim label, not exposed as an independent
     general-purpose checklist unless advanced configuration needs it.
   - verified-only and evidence-reframed claims can be auto-approvable.
   - adjacent claims are not auto-approvable by default, but an advanced policy
     may explicitly make adjacent translation auto-approvable with stronger
     audit warnings.
   - draft claims always require confirmation.
3. Generation permissions:
   - rewrite summary,
   - rewrite achievement bullets,
   - select/order existing skills,
   - preserve fixed titles unless a future output schema supports title changes.
4. Required content pins:
   - required experience entries,
   - required bullets by experience entry,
   - required skill categories or skills.
5. Writing style:
   - tone,
   - bullet standards,
   - verbosity,
   - keyword emphasis as advisory style guidance, not a hard keyword-density
     validator.
6. Revision gates:
   - minimum post-tailoring fit score,
   - must-have coverage threshold,
   - maximum revision/enhancement attempts.
   - these start as versioned policy defaults visible in audit, not editable
     Preferences controls.
7. Additional guidance:
   - user text injected as writing/positioning guidance only; it cannot override
     evidence, claim policy, pins, or validators.

Existing Preferences controls are migration inputs:

| Existing control | Decision |
| --- | --- |
| Tailoring mode | Use only as a migration input, then remove from the active Preferences surface in favor of explicit controls. |
| Claim mode | Keep concept, rename or group as claim policy. |
| Writing tone | Keep as writing style. |
| Bullet standards | Keep as writing style. |
| Verbosity | Keep as writing style. |
| Keyword density | Replace or relabel as keyword emphasis; advisory only. |
| Avoid first-person language | Keep as writing style. |
| AI may rewrite executive summary | Keep as generation permission. |
| AI may rewrite achievement bullets | Keep as generation permission. |
| AI may reorder or trim skill items | Keep as generation permission for existing skills only. |
| AI may reframe experience titles | Remove or disable until title changes are actually supported by schema and validators. |
| AI may make minor inferred phrasing | Remap into claim policy; do not keep as a separate factual-expansion checkbox. |
| Allow adjacent achievement drafts | Remap into claim policy and review gate. |
| Auto-approvable claim modes | Derive from claim policy; expose only if the implementation keeps an advanced policy editor. |
| Additional tailoring prompt | Keep as constrained guidance, not a safety override. |

Alternative considered: preserve the current UI controls and bolt new behavior
behind them. That would keep overlapping knobs whose authority is unclear,
which is the problem this change is meant to fix.

### 4. Run Evidence-First, Then Score-Gated Revision

The generation loop should be:

1. Build target profile from employer analysis and requirement fit.
2. Build and validate coverage graph.
3. Generate evidence-first profile-row edits from direct and reframed coverage.
4. Assemble and validate the resume.
5. Score the assembled resume with a fit scorer using the same target profile.
6. If fit score and must-have coverage pass thresholds, accept unless review
   blockers exist.
7. If thresholds fail and claim policy allows adjacent or draft claims, run a
   minimal revision pass using scorer prioritized fixes and uncovered
   requirements.
8. Re-score and select the best candidate that satisfies validators and review
   policy.

Enhancement is not the default write strategy. It is a second-stage response to
measured fit gaps.

### 5. Treat Scoring As A Gate, Not A Substitute For Validators

The scorer decides whether the resume is good enough relative to the job. It
does not authorize unsupported facts. Deterministic validators still own:

- schema shape,
- known profile and requirement IDs,
- max bullet counts,
- required pins,
- exact skill membership,
- verified metrics,
- prohibited claims,
- title immutability,
- review-blocking claim states.

The scorer output can trigger revision and explain gaps, but it cannot approve
fabrication.

### 6. Persist Audit Data Separately From Raw Sensitive Inputs

Material metadata and read models should expose bounded, safe summaries:

- requirement coverage status,
- covered and uncovered requirement IDs/text excerpts,
- evidence IDs used per generated line,
- unused but pinned achievements,
- claim labels and review blockers,
- scorer dimensions and prioritized fixes,
- revision attempts and why they ran.

They must not expose raw prompts, full profile payloads, full job descriptions,
local file paths, generated PDFs, logs, browser profiles, or SQLite contents.

## Risks / Trade-offs

- More intermediate data can make tailoring slower and more expensive.
  Mitigation: cache deterministic graph assembly and run revision only after a
  failed score gate.
- Coverage planner output can overstate a weak connection.
  Mitigation: require existing IDs, classify edge strength, and route adjacent
  or draft edges through review policy.
- UI control migration can confuse users if labels change abruptly.
  Mitigation: migrate values deterministically, document the mapping, and keep
  old fields readable for compatibility until the profile schema migration is
  complete.
- Must-include bullets can reduce fit when they do not match the target job.
  Mitigation: keep pins authoritative, label them as pinned/positioning rather
  than requirement coverage, and let the scorer report the trade-off.
- A fit scorer can become overly broad or subjective.
  Mitigation: require structured dimensions, must-have coverage, red flags, and
  prioritized fixes; deterministic validators remain the hard safety gate.

## Migration Plan

1. Add new data structures and validators while continuing to read existing
   tailoring controls.
2. Implement a compatibility adapter from current profile controls to the new
   control model.
3. Add coverage graph generation and audit metadata behind a new tailoring
   policy version.
4. Update prompts and structured schemas for planner, writer, and scorer calls.
5. Update API/read models and UI to show safe coverage and review blockers.
6. Replace or relabel Preferences controls after migration tests prove the new
   control model round-trips.
7. Keep existing accepted artifacts unchanged; new requirement-led behavior
   applies to new tailoring runs or explicit re-tailor actions.

Rollback strategy: keep the previous tailoring policy version available for
existing artifacts and allow re-tailoring only when the user explicitly chooses
the new policy version.

## Open Questions

- None for the initial proposal. Thresholds start as versioned policy defaults;
  Tailoring mode migrates away; adjacent translation auto-approval is allowed
  only through explicit advanced policy configuration.
