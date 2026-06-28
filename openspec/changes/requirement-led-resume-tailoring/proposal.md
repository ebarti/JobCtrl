## Why

Current resume tailoring is profile-row based: the generator rewrites existing
profile rows while requirement directives only influence emphasis. That makes it
hard to prove that a final resume covered the right job requirements, used the
minimum necessary enhancement, and preserved user-pinned experience and bullet
requirements.

The new flow should make requirement coverage the first-class planning unit:
each job requirement is covered by zero or more profile achievements, and each
profile achievement may cover zero or more job requirements.

## What Changes

- Add a requirement-achievement coverage graph before resume generation.
- Convert current `EmployerAnalysis` and `RequirementFitReport` data into a
  target-profile-style input for the writing and scoring loop.
- Generate an evidence-first tailored resume by using coverage decisions to
  populate the current profile-row edit schema rather than asking the model to
  infer coverage indirectly.
- Preserve user-pinned constraints: required experience entries and required
  bullets must remain in the final resume even when they do not cover any target
  requirement.
- Run a score-gated revision loop after the evidence-first draft. Revision is
  triggered by configured fit and must-have coverage thresholds, not by loose
  keyword counts.
- Define the required control model for requirement-led tailoring first, then
  migrate, remap, remove, or replace the current Preferences controls to match
  that model.
- Bind enhancement behavior to claim policy and review requirements rather than
  letting scattered checkboxes independently authorize factual expansion.
- Persist and expose audit metadata for requirement coverage, uncovered
  requirements, unused profile achievements, enhancement/draft claim status, and
  scorer-driven revision decisions.
- Align generator and verifier prompts with the local resume-content-writer and
  resume-fit-scorer skill contracts while keeping JobHunter's structured-output
  schemas and deterministic validators as the runtime contract.

## Capabilities

### New Capabilities

- `requirement-led-resume-tailoring`: Defines requirement-achievement coverage
  planning, evidence-first generation, claim-policy-gated enhancement,
  score-gated revision, the required tailoring controls, and audit metadata for
  tailored resumes.

### Modified Capabilities

- None.

## Impact

- Python Materials domain:
  `workers/automation/src/jobhunter/domain/materials/quality.py`,
  `use_cases.py`, provenance/audit helpers, and related tests.
- Python Scoring domain: requirement fit report consumption and post-tailoring
  fit scorer output used for revision gates.
- Profile model and Preferences UI: define the new control model, then migrate
  current tailoring mode, claim mode, writing tone, bullet standards, verbosity,
  keyword density, rewrite permissions, minor inference, adjacent drafts,
  auto-approvable modes, and additional prompt into clear supported controls.
- TypeScript API/read models and web UI: expose safe coverage and enhancement
  audit summaries without leaking raw prompts, full profile payloads, or raw job
  descriptions.
- Documentation: update `docs/tailoring.md`, active requirements, and QA matrix
  entries to describe the requirement-led flow after implementation.
