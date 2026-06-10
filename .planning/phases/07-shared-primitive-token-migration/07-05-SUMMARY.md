---
phase: 07-shared-primitive-token-migration
plan: 05
subsystem: ui
tags: [shared-ui, boundary-scan, shadcn, storybook, primitive-audit]

requires:
  - phase: 06-token-foundation-shadcn-preset-contract
    provides: shadcn semantic token foundation and shared primitive token baseline
  - phase: 07-shared-primitive-token-migration
    provides: Plans 07-01 through 07-04 shared primitive tests, stories, and a11y deferral cleanup
provides:
  - Shared description block helper under shared/lib with regression tests
  - Closed shared/ui dependency boundary with zero context/view/API/query/platform scan matches
  - Narrow shared primitive QA documentation for future local verification
  - Phase 7 primitive audit artifact with final token, boundary, Storybook, shadcn, and diff hygiene evidence
affects: [phase-07, shared-ui, local-qa, phase-10-storybook-a11y-qa]

tech-stack:
  added: []
  patterns:
    - "Pure generic helpers used by shared/ui live under apps/web/src/shared/lib, not bounded contexts."
    - "Final primitive audits record aggregate command results and safety boundaries without copying sensitive logs or local data."

key-files:
  created:
    - apps/web/src/shared/lib/job-description-blocks.ts
    - apps/web/src/shared/lib/job-description-blocks.test.ts
    - .planning/phases/07-shared-primitive-token-migration/07-PRIMITIVE-AUDIT.md
    - .planning/phases/07-shared-primitive-token-migration/07-05-SUMMARY.md
  modified:
    - apps/web/src/shared/ui/MarkdownDocument.tsx
    - docs/local-reliability-qa.md
  deleted:
    - apps/web/src/contexts/operations/selectors/jobDescriptionSelectors.ts

key-decisions:
  - "Removed the shared/ui -> contexts import exception instead of documenting it as a tolerated boundary violation."
  - "Kept broad web Vitest skipped for this phase because scoped shared/ui tests, typecheck, Storybook gates, static scans, shadcn info, and diff hygiene passed while the broad command has a known unrelated snapshot-runner caveat."
  - "Recorded final audit evidence as aggregate command results only, with no sensitive local artifacts or user-affecting automation."

patterns-established:
  - "Shared primitives may import pure shared/lib helpers but not bounded context selectors."
  - "Shared primitive QA requires scoped tests, web:check, Storybook build/test, shadcn info, corrected legacy-token scan, boundary scan, deferral scan, and git diff hygiene."

requirements-completed:
  - PRIM-01
  - PRIM-02
  - PRIM-03
  - PRIM-04
  - PRIM-05

duration: 11min
completed: 2026-06-10
---

# Phase 07 Plan 05: Primitive Boundary And Audit Summary

**Shared/ui is now boundary-clean, the pure description block helper lives in shared/lib, and Phase 7 has recorded final primitive token, Storybook, shadcn, and a11y-deferral audit evidence.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-06-10T10:31:40Z
- **Completed:** 2026-06-10T10:42:30Z
- **Tasks:** 3 completed
- **Files modified:** 6

## Accomplishments

- Moved `descriptionBlocks` from the operations context into `apps/web/src/shared/lib/job-description-blocks.ts`.
- Updated `MarkdownDocument.tsx` to import the pure helper through `../lib/job-description-blocks.js`, removing the known shared/ui -> contexts exception.
- Added shared/lib regression tests for explicit paragraph blocks, long paragraph sentence-boundary splitting, and empty input.
- Added a narrow shared primitive QA gate to `docs/local-reliability-qa.md`.
- Created `07-PRIMITIVE-AUDIT.md` with final Phase 7 verification evidence and safety boundaries.

## Task Commits

1. **Task 1 RED: Description block helper tests** - `5eca4a1` (`test`)
2. **Task 1 GREEN: Move helper to shared/lib** - `fc3b50c` (`feat`)
3. **Task 2: Document shared primitive QA gate** - `a38ef97` (`docs`)
4. **Task 3: Record primitive audit evidence** - `7744d43` (`docs`)

## Files Created/Modified

- `apps/web/src/shared/lib/job-description-blocks.ts` - Pure shared paragraph block helper moved out of the operations context.
- `apps/web/src/shared/lib/job-description-blocks.test.ts` - Shared/lib regression tests for existing block splitting behavior.
- `apps/web/src/shared/ui/MarkdownDocument.tsx` - Updated helper import to the shared/lib boundary.
- `apps/web/src/contexts/operations/selectors/jobDescriptionSelectors.ts` - Removed as unused after the helper move.
- `docs/local-reliability-qa.md` - Added shared primitive QA gate commands, scans, broad-suite caveat, and no user-affecting automation boundary.
- `.planning/phases/07-shared-primitive-token-migration/07-PRIMITIVE-AUDIT.md` - Final Phase 7 primitive audit evidence.

## Decisions Made

- Removed the boundary exception rather than preserving a context-owned re-export. `descriptionBlocks` is generic rendering support, so `shared/lib` is the owning layer.
- Kept the broad web Vitest command skipped and documented because it is explicitly covered by D-15 and the new QA note; this plan proved the touched shared/ui and shared/lib surface with scoped tests and Storybook gates.
- Used Storybook test-runner as the browser proof for open primitive states; no product route, worker, mailbox, apply, or material-generation automation was run.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected long-paragraph test expectation**
- **Found during:** Task 1 GREEN
- **Issue:** The initial RED test expected the first two sentences to stay together, but the existing splitter emits the current block before adding the sentence that would cross the 520-character threshold.
- **Fix:** Updated the test expectation to preserve the existing behavior: first sentence in block one, second and third sentences in block two.
- **Files modified:** `apps/web/src/shared/lib/job-description-blocks.test.ts`
- **Verification:** `corepack pnpm --filter @jobhunter/web test src/shared/lib/job-description-blocks.test.ts` passed with 3 tests.
- **Committed in:** `fc3b50c`

---

**Total deviations:** 1 auto-fixed (Rule 1)
**Impact on plan:** The fix kept Task 1 behavior-preserving and avoided changing product rendering semantics.

## Issues Encountered

- The required `modern-web-guidance` lookup failed in sandbox due unwritable `~/.npm` cache files; the elevated retry was rejected as unsandboxed third-party npm execution. Execution proceeded from repo UI contracts, phase research, and existing frontend docs.
- The first RED test patch was applied to the original checkout because the patch tool used the session cwd, not the requested `/private/tmp` worktree. The accidental file was removed immediately from the original checkout before any commit; all committed changes were applied to verified paths under `/private/tmp/JobHunter-shadcn-standard-token-milestone`.
- `corepack pnpm web:storybook:test` failed before running suites in the sandbox because Chromium could not register its macOS Mach port. The same command passed with browser-launch escalation.
- A read-only self-check command initially used `path` as a zsh loop variable, which shadowed the shell command path and produced false missing-commit output. The self-check was rerun with a safe variable name and passed.

## Verification

- `corepack pnpm --filter @jobhunter/web test src/shared/lib/job-description-blocks.test.ts` - PASS, 3 tests.
- `corepack pnpm web:check` - PASS.
- `rg -n 'contexts|views|api|routes|@tanstack/react-query|localStorage|EventSource|navigator\.clipboard' apps/web/src/shared/ui/MarkdownDocument.tsx || true` - PASS, zero matches.
- `rg -n "shared primitive|storybook:test|boundary scan|legacy token" docs/local-reliability-qa.md` - PASS, matched the new QA gate.
- `corepack pnpm --filter @jobhunter/web test src/shared/ui/data-table.test.tsx src/shared/ui/toast.a11y.test.tsx src/shared/ui/filterable-data-grid.test.tsx src/shared/ui/table-pager.test.tsx src/shared/lib/job-description-blocks.test.ts` - PASS, 5 files and 19 tests.
- `corepack pnpm web:storybook:build` - PASS, Storybook 10.3.6 build completed with existing docgen/chunk-size warnings only.
- `corepack pnpm web:storybook:test` - FAIL before suites in sandbox due Chromium Mach port permission denial.
- `corepack pnpm web:storybook:test` with browser-launch escalation - PASS, 89 suites and 320 tests.
- `corepack pnpm dlx shadcn@latest info -c apps/web` - PASS, reports Vite, TypeScript, Tailwind v4, radix-luma style, Tabler icon library, blank Tailwind config, and aliases to `@/shared/ui` and `@/shared/lib`.
- Corrected legacy-token scanner from `07-RESEARCH.md` - PASS, `legacy token matches: 0`.
- Shared/ui boundary scan from `07-RESEARCH.md` - PASS, zero matches.
- Deferral/backlog scan - PASS, 10 story deferrals plus matching backlog count line.
- `git diff --check` - PASS.

## User Setup Required

None - no external service configuration required.

## Known Stubs

None. The stub-pattern scan found only local accumulator initializers in parser/render code and an existing QA row about placeholder-copy regression, not unfinished UI stubs or mock data wired to production rendering.

## Threat Flags

None. This plan introduced no network endpoints, auth paths, file-access trust boundaries, schema changes, package installs, product automation, mailbox scans, browser submission, real material generation, destructive profile/database actions, or worker-backed jobs.

## TDD Gate Compliance

- RED commit present: `5eca4a1` (`test(07-05): add failing description block helper tests`).
- GREEN commit present after RED: `fc3b50c` (`feat(07-05): move description block helper to shared lib`).
- Refactor commit not needed.

## Next Phase Readiness

Phase 7 requirements PRIM-01 through PRIM-05 are covered. Shared primitives remain semantic-token clean, Storybook/a11y evidence is recorded, and the shared/ui dependency boundary now returns zero disallowed imports. Ready for Phase 8 layout chrome, fonts, and Tabler icon migration.

## Self-Check: PASSED

- Found created files: `apps/web/src/shared/lib/job-description-blocks.ts`, `apps/web/src/shared/lib/job-description-blocks.test.ts`, `.planning/phases/07-shared-primitive-token-migration/07-PRIMITIVE-AUDIT.md`.
- Found modified files: `apps/web/src/shared/ui/MarkdownDocument.tsx`, `docs/local-reliability-qa.md`.
- Found task commits: `5eca4a1`, `fc3b50c`, `a38ef97`, `7744d43`.
- No tracked files were unexpectedly deleted; the selector helper moved from `contexts/operations/selectors` to `shared/lib`.
- Worktree has only the known unrelated untracked `.planning/research/.cache/` path before summary close-out.

---
*Phase: 07-shared-primitive-token-migration*
*Completed: 2026-06-10*
