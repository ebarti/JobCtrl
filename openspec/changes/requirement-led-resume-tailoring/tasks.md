## 1. Domain Model And Policy

- [ ] 1.1 Add requirement-led tailoring policy version constants and policy-default revision gates for minimum fit score, must-have coverage, and max revision attempts.
- [ ] 1.2 Add value objects for requirement nodes, achievement nodes, coverage edges, uncovered requirements, unused achievements, and generated claim mappings.
- [ ] 1.3 Add deterministic validators for coverage graph IDs, edge kinds, claim labels, claim-policy compatibility, metric support, prohibited claims, and pinned content preservation.
- [ ] 1.4 Add compatibility adapter from existing profile tailoring controls to the new claim, generation, writing, and revision-gate control model.
- [ ] 1.5 Add migration tests proving Tailoring mode is used only as migration input and no longer acts as independent runtime authority.

## 2. Coverage Planning

- [ ] 2.1 Build target-profile adapter from `EmployerAnalysis`, `RequirementFitReport`, job data, and profile evidence.
- [ ] 2.2 Seed coverage graph edges from existing requirement-fit evidence IDs before invoking any planner prompt.
- [ ] 2.3 Add constrained coverage planner schema and prompt that can only reference existing requirement IDs and profile achievement evidence IDs.
- [ ] 2.4 Add planner parsing tests for direct, transferable, adjacent, missing, and invalid-edge cases.
- [ ] 2.5 Persist safe coverage graph metadata on tailoring attempts and final materials metadata.

## 3. Writer And Scorer Loop

- [ ] 3.1 Update writer schema to keep profile-row edits while adding generated claim mapping for summary claims, bullets, and skill choices.
- [ ] 3.2 Update writer prompt to consume target profile, coverage graph, required pins, claim policy, generation permissions, and writing style.
- [ ] 3.3 Add evidence-first candidate generation that excludes adjacent or draft claims unless policy allows them.
- [ ] 3.4 Integrate post-generation fit scoring against the assembled resume and target profile.
- [ ] 3.5 Add scorer-threshold revision routing using prioritized fixes and uncovered requirements.
- [ ] 3.6 Add minimal enhancement revision pass that labels every adjacent or draft claim and respects auto-approval policy.
- [ ] 3.7 Add candidate selection tests for pass-on-first-draft, revise-after-low-score, no-enhancement-allowed, and review-blocked draft claims.

## 4. Assembly, Provenance, And Audit

- [ ] 4.1 Extend provenance annotations to include requirement IDs, evidence IDs, coverage edge IDs, claim labels, and pinned/positioning reasons.
- [ ] 4.2 Preserve required experience entries, required bullets, and required skills even when they do not cover target requirements.
- [ ] 4.3 Expose safe audit summaries for covered requirements, uncovered requirements, unused achievements, revision decisions, and review blockers.
- [ ] 4.4 Ensure audit projections omit raw prompts, full profile payloads, full job descriptions, local paths, PDFs, logs, browser data, and SQLite contents.
- [ ] 4.5 Add API/read-model tests for requirement-led audit metadata and review-blocking adjacent or draft claims.

## 5. Preferences Controls

- [ ] 5.1 Replace or regroup the Preferences Tailoring controls around claim policy, generation permissions, required content pins, writing style, revision policy display, and additional guidance.
- [ ] 5.2 Remove or disable experience-title reframing unless the output schema and validators support title changes.
- [ ] 5.3 Remap minor inference and adjacent drafts into claim policy and review-gate behavior.
- [ ] 5.4 Replace keyword density with advisory keyword emphasis and ensure it cannot create loose keyword-count blockers.
- [ ] 5.5 Hide or move auto-approvable claim modes behind explicit advanced policy configuration; support configurable adjacent auto-approval only through that advanced policy.
- [ ] 5.6 Add frontend tests for migrated controls, removed Tailoring mode behavior, advanced adjacent auto-approval, and constrained additional guidance.

## 6. Documentation And QA

- [ ] 6.1 Update `docs/tailoring.md` to describe requirement-led coverage, claim policy, score-gated revision, and control migration.
- [ ] 6.2 Update active requirements and local reliability QA entries for requirement-led tailoring and safe audit display.
- [ ] 6.3 Add Python unit and evaluation fixtures covering coverage graph validation, claim-policy gates, pins, scorer thresholds, and low-quality advisory signals.
- [ ] 6.4 Add API tests for safe read-model exposure and Apply Review readiness with review-blocking enhanced claims.
- [ ] 6.5 Add product-path QA for Preferences control migration and Apply Review coverage audit display.
