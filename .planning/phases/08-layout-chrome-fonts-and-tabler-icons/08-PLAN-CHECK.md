# Phase 8 Plan Check - Layout Chrome, Fonts, And Tabler Icons

**Checked:** 2026-06-10
**Result:** ISSUES FOUND
**Plans checked:** 4
**Blockers:** 7
**Warnings:** 1

## Summary

The plan set is directionally aligned with LAYOUT-01 through LAYOUT-05, but it does not pass the pre-execution revision gate. The main problem is structural: the four `08-*-PLAN.md` files are prose task lists rather than GSD executable plans with frontmatter, `must_haves`, dependency metadata, and task-level `files/action/verify/done` fields. Because of that, coverage and verification cannot be deterministically enforced by the execution workflow.

There are also substantive coverage gaps: Phase 8 research has a `Validation Architecture` section but no `08-VALIDATION.md`, research open questions remain unresolved, and Plan 04 narrows LAYOUT-05 browser proof to `/dashboard` and `/jobs` instead of Jobs, Apply Review, artifact/PDF-adjacent surfaces, and dark-mode surfaces required by the phase contract.

## Coverage Summary

| Requirement | Claimed Plans | Checker Status |
|-------------|---------------|----------------|
| LAYOUT-01 | 08-01, 08-02, 08-03, 08-04 | Blocked by missing executable plan schema and dependency ordering |
| LAYOUT-02 | 08-01, 08-03, 08-04 | Blocked by missing `must_haves`; Storybook font parity proof is not explicit |
| LAYOUT-03 | 08-02, 08-04 | Mostly covered, but no frontmatter requirement trace and deferral audit depends on Plan 04 ordering |
| LAYOUT-04 | 08-01, 08-03, 08-04 | Covered in prose, but blocked by missing automated task structure |
| LAYOUT-05 | 08-01, 08-03, 08-04 | Blocker: browser route proof scope is reduced below the requirement |

## Blockers

**1. [task_completeness] Plans are not in executable GSD PLAN format**
- Plan: `08-01`, `08-02`, `08-03`, `08-04`
- Evidence: Plans use Markdown sections (`## Requirements Covered`, `## Files`, numbered `## Tasks`) instead of structured task elements with per-task `files`, `action`, `verify`, and `done`.
- Impact: Execution cannot deterministically assign files, run per-task checks, or know acceptance criteria.
- Fix: Rewrite each plan with required frontmatter and task blocks. Each implementation task needs explicit files, action, automated verify commands, and measurable done criteria.

**2. [requirement_coverage] Roadmap requirements are absent from required plan frontmatter**
- Plan: `08-01`, `08-02`, `08-03`, `08-04`
- Evidence: None of the plans has a `requirements:` frontmatter field.
- Impact: The gate requires every roadmap requirement ID (`LAYOUT-01` through `LAYOUT-05`) to appear in at least one plan frontmatter field; prose headings do not satisfy the traceability contract.
- Fix: Add frontmatter `requirements:` arrays to each plan and ensure all five LAYOUT requirements are covered.

**3. [verification_derivation] `must_haves` are missing from all plans**
- Plan: `08-01`, `08-02`, `08-03`, `08-04`
- Evidence: No plan defines `must_haves.truths`, `must_haves.artifacts`, or `must_haves.key_links`.
- Impact: The checker cannot verify that user-observable truths, artifacts, and wiring derive from the phase goal.
- Fix: Add `must_haves` to every plan. Include truths such as unchanged global search navigation, persisted theme/density behavior, migrated/deferred icons, and readable shell chrome; list artifacts and key links tying components, CSS, tests, and browser proof together.

**4. [dependency_correctness] Plan ordering is implied, not enforceable**
- Plan: `08-01`, `08-02`, `08-03`, `08-04`
- Evidence: No plan has `depends_on:` metadata. Plan 03 depends on implementation from Plans 01-02; Plan 04 depends on Plans 01-03 and closes the phase.
- Impact: The executor could run browser closeout or tests before implementation/icon migration is complete.
- Fix: Add explicit dependencies, for example `08-03` depends on `08-01` and `08-02`; `08-04` depends on `08-01`, `08-02`, and `08-03`.

**5. [nyquist_compliance] Validation architecture exists but `08-VALIDATION.md` is missing**
- Plan: phase-level
- Evidence: `08-RESEARCH.md` contains `## Validation Architecture`; no `*-VALIDATION.md` exists in the phase directory.
- Impact: Dimension 8 requires a blocking fail when validation architecture is present but the validation artifact is missing.
- Fix: Re-run planning with research validation output or create `08-VALIDATION.md` mapping each task to automated checks, wave 0 test gaps, and sampling continuity.

**6. [research_resolution] Research open questions are unresolved**
- Plan: phase-level
- Evidence: `08-RESEARCH.md` has `## Open Questions` without `(RESOLVED)` and the two questions are recommendations, not resolved decisions.
- Impact: Planning proceeds with unresolved scope questions around Priority B icon breadth and shell Storybook stories.
- Fix: Resolve the section as `## Open Questions (RESOLVED)` and record the chosen scope before finalizing plans.

**7. [requirement_coverage] LAYOUT-05 browser proof scope is reduced**
- Plan: `08-04`
- Evidence: Plan 04 says route fit proof should cover "at least `/dashboard` and `/jobs`" and "Do not attempt the full Phase 10 route matrix." LAYOUT-05 and the UI/QA contract require topbar/menu readability over dense Jobs, Apply Review, artifact/PDF-adjacent surfaces, and dark-mode surfaces.
- Impact: Phase 8 can pass while missing required Apply Review and artifact/PDF readability proof.
- Fix: Keep Phase 10 route-wide QA out of scope, but add Phase 8 browser proof for `/jobs`, `/apply-review`, and an artifact/PDF-adjacent surface in light/dark where synthetic fixtures support it.

## Warnings

**1. [scope_sanity] Plans exceed recommended task count**
- Plan: `08-01`, `08-02`, `08-04`
- Evidence: Plan 01 has 5 tasks, Plan 02 has 5 tasks, and Plan 04 has 6 tasks.
- Impact: This increases execution risk and review burden, especially for broad CSS and icon migration.
- Fix: Split executable plans so each has 2-3 implementation tasks, or make the task blocks narrower with explicit file and verify scope.

## Structured Issues

```yaml
issues:
  - plan: "08-01,08-02,08-03,08-04"
    dimension: task_completeness
    severity: blocker
    description: "Plans are prose Markdown, not executable GSD plans with task-level files/action/verify/done."
    fix_hint: "Rewrite each plan with required frontmatter and structured task blocks."
  - plan: "08-01,08-02,08-03,08-04"
    dimension: requirement_coverage
    severity: blocker
    description: "LAYOUT-01 through LAYOUT-05 appear only in prose; no plan has required requirements frontmatter."
    fix_hint: "Add requirements arrays and map each roadmap requirement to concrete tasks."
  - plan: "08-01,08-02,08-03,08-04"
    dimension: verification_derivation
    severity: blocker
    description: "All plans are missing must_haves.truths, must_haves.artifacts, and must_haves.key_links."
    fix_hint: "Add user-observable truths, artifacts, and key links for each plan."
  - plan: "08-01,08-02,08-03,08-04"
    dimension: dependency_correctness
    severity: blocker
    description: "Plan ordering is implied but no depends_on metadata enforces implementation, test, and closeout order."
    fix_hint: "Add dependency metadata, with closeout depending on implementation and test plans."
  - plan: null
    dimension: nyquist_compliance
    severity: blocker
    description: "08-RESEARCH.md has Validation Architecture but no 08-VALIDATION.md exists."
    fix_hint: "Create 08-VALIDATION.md with automated verification and sampling continuity."
  - plan: null
    dimension: research_resolution
    severity: blocker
    description: "08-RESEARCH.md has unresolved Open Questions."
    fix_hint: "Resolve the open questions before final planning."
  - plan: "08-04"
    dimension: requirement_coverage
    severity: blocker
    description: "Plan 04 reduces LAYOUT-05 browser proof to dashboard/jobs and omits Apply Review plus artifact/PDF-adjacent readability proof."
    fix_hint: "Add focused Phase 8 browser proof for jobs, apply-review, and artifact/PDF-adjacent surfaces in light/dark."
  - plan: "08-01,08-02,08-04"
    dimension: scope_sanity
    severity: warning
    description: "Plans have 5, 5, and 6 tasks respectively, above the recommended 2-3 task range."
    fix_hint: "Split or narrow tasks to reduce execution risk."
```

## Recommendation

Do not execute Phase 8 yet. Return to the planner to regenerate the four plans in the executable GSD schema, add `08-VALIDATION.md`, resolve research open questions, add explicit dependencies, and expand LAYOUT-05 browser proof to the required Phase 8 surfaces without taking on the full Phase 10 matrix.
