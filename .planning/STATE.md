---
gsd_state_version: 1.0
milestone: v1.2
milestone_name: Apply Review Audit UX - Drawer + Resume Pins
status: planning
last_updated: "2026-06-11T19:42:01.586Z"
last_activity: 2026-06-11
progress:
  total_phases: 0
  completed_phases: 0
  total_plans: 0
  completed_plans: 0
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-11)

**Core value:** A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.
**Current focus:** Defining milestone v1.2 — Apply Review Audit UX - Drawer + Resume Pins

## Current Position

Phase: Not started (defining requirements)
Plan: —
Status: Defining requirements
Last activity: 2026-06-11 — Milestone v1.2 started

## Active Milestone Summary

Milestone v1.2 implements Sketch 002 Option 1: Drawer + Resume Pins. The milestone makes the existing Jobs row-click drawer and the Apply review rendered-resume surface explain the audit trail clearly enough that a technical job seeker can understand ranking, readiness, blockers, material changes, grounding, and claim risk before any apply approval.

Chosen scope:

| Area | Status |
|------|--------|
| v1.1 cleanup folded into v1.2 | Early housekeeping slice |
| Jobs row-click drawer (`JobDetailDrawer`) | Owns ranking explanation, readiness, blockers, and eligibility concerns |
| Apply review rendered resume/material surface | Owns source-to-artifact changes, grounding, claim risk, and generated-material inspection |
| Shared readiness/eligibility contract | Must be one source of truth across both surfaces |
| Product-path QA | Must cover Jobs drawer, Apply review, resume pins, blocker/readiness states, and no auto-apply/submission |

Explicitly not in scope:

- Option 2 Evidence Ledger and Option 3 Gate Timeline.
- Blind-auto-apply safety positioning in UI; this stays deferred to README/docs positioning later.
- Auto-apply, browser submission, mailbox scanning, real generated-material regeneration, destructive profile/database actions, or worker-backed jobs unless explicitly requested later.

Prior v1.1 status: Phases 6-10 landed on `main` on 2026-06-10 as squash-merged PRs #151-#155 (one squash commit per phase, `4758935..ef6c680`). Phase 11 cleanup did not start; its narrow cleanup intent is folded into v1.2 rather than blocking the product audit milestone.

## Prior Milestone Verification (2026-06-09)

Milestone v1.0 was implemented via the repository PR workflow (PRs #141-#145, with Phase 1 hardening in #146-#148) outside the GSD plan/execute loop. On 2026-06-09 each phase was verified goal-backward against merged code (`main` @ e36ffb1): every ROADMAP success criterion checked against actual code plus passing tests. All five phases plus cross-phase integration returned PASS. The durable summary is `.planning/MILESTONE-ACCEPTANCE.md`.

| Phase | PR(s) | Verdict |
|-------|-------|---------|
| 1 - Canonical Employer Analysis | #141 (+#146/#147/#148) | PASS (4/4) |
| 2 - Per-Bullet Provenance + Controls | #142 | PASS (5/5) |
| 3 - Voice Pass + Final Audit | #143 | PASS (4/4) |
| 4 - Read-Model Cleanup (rip-and-replace) | #144 | PASS (3/3) |
| 5 - Generate-Materials + Inspector UI | #145 | PASS (4/4) |
| Cross-phase integration | - | PASS (5/5 seams; 26/26 requirements wired) |

No Blocker/High gaps remained. Residual LOW/cosmetic items from v1.0: stale `generate_materials` branch in `apps/web/.../local-actions.ts`; inspector diff "original text" sourced from `annotatedChanges` rather than a canonical provenance column; Phase 5 live Playwright needs a clean-env re-run (port-reuse artifact, not a code defect).

The previous `.planning/phases/01-*` through `.planning/phases/05-*` directories were cleared when v1.1 started, per the new-milestone workflow, so new phase work can start cleanly at Phase 6.

## Performance Metrics

- Total plans completed: 23 of 23 planned so far for v1.1
- Average duration: 9 min
- Total execution time: 96 min

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table. Current milestone decisions:

- Choose Sketch 002 Option 1: Drawer + Resume Pins for implementation.
- Define "job overlay" as the Jobs row-click drawer (`JobDetailDrawer`), not an Apply review queue panel.
- Keep Apply review centered on the rendered resume/material, with row/claim pins for evidence inspection.
- Share readiness and eligibility facts across Jobs drawer and Apply review from one contract/source of truth.
- Fold the leftover v1.1 Phase 11 cleanup into v1.2 as housekeeping, not as the core product outcome.
- Defer blind-auto-apply safety positioning to README/docs rather than the v1.2 UI scope.

Prior milestone decisions that still matter:

- Auditability-first: UI must not mask missing or embarrassing audit data.
- Rip-and-replace is acceptable for local-first internals when the replacement is verified.
- Existing JobHunter generated artifacts, profiles, resumes, browser profiles, logs, databases, and application data are sensitive and must not be exposed in QA evidence.
- [Phase 06]: Approved shadcn@4.11.0, @fontsource-variable/geist@5.2.9, and @types/node@25.9.2 package identities before Plan 06-02 install — Plan 06-01 was a blocking package-legitimacy checkpoint for recent npm releases flagged by T-06-01.
- [Phase 06 Plan 02]: Adapted shadcn generated .dark theme output to JobHunter's :root[data-theme=dark] selector.
- [Phase 06 Plan 02]: Used a temporary pnpm minimumReleaseAge=0 window only for human-approved recent shadcn package operations, then restored the workspace policy before committing.
- [Phase 06 Plan 02]: Kept lucide-react for compatibility while setting new shadcn output to Tabler; Phase 8 owns visible icon migration.
- [Phase 06]: [Phase 06 Plan 03]: Moved semantic token definitions into tokens.css and kept Tailwind @theme inline mappings in globals.css.
- [Phase 06]: [Phase 06 Plan 03]: Deleted the legacy Tailwind config bridge after shadcn info and web checks passed.
- [Phase 06]: [Phase 06 Plan 03]: Used corrected Vitest file-filter command for token-contract.test.ts because the planned -- separator runs the full web suite.
- [Phase 06]: [Phase 06 Plan 04]: Kept core primitive migration mechanical: only class-token utilities changed; exports, variants, Radix wiring, providers, routes, and story behavior stayed unchanged.
- [Phase 06]: [Phase 06 Plan 04]: Corrected legacy-token grep gates to allow standard shadcn muted utilities while still rejecting bare legacy text-muted and old token names.
- [Phase 06]: [Phase 06 Plan 05]: Kept overlay/menu primitive migration mechanical: only class-token utilities changed; Radix portals, refs, focus behavior, roles, animations, props, and exports stayed unchanged.
- [Phase 06]: [Phase 06 Plan 05]: Recovered close-out from committed task evidence after the plan executor stalled before writing its summary.
- [Phase 06]: [Phase 06 Plan 06]: Added seeded browser computed-token proof for root shadcn tokens, light/dark theme switching, color-scheme, density row heights, focus indicators, and dense-route rendering.
- [Phase 06]: [Phase 06 Plan 06]: Corrected final proof commands to use the working Vitest file filter, generated CSS ring variants, and a deterministic legacy-token scanner that allows standard shadcn muted utilities.
- [Phase 06]: [Phase 06 Plan 06]: Removed final legacy `bg-rule`/`bg-rule-2` primitive utilities so the Phase 6 app/story/config scan exits with zero matches.
- [Phase 07]: [Phase 07 Plan 04]: Kept changes story-only because no production primitive defect blocked truthful rendering.
- [Phase 07]: [Phase 07 Plan 04]: Kept the existing scroll-area a11y deferral because it maps to the tracked Radix ScrollArea backlog row.
- [Phase 07]: [Phase 07 Plan 04]: Did not change badge.stories.tsx because it already covered the supported default, secondary, destructive, and outline variants.
- [Phase 08]: Kept shell behavior unchanged while retokenizing app chrome; route labels, search navigation, theme store, density store, and connection status semantics remain the source of behavior.
- [Phase 08]: Migrated only shell/shared affordance icons to Tabler; remaining lucide imports are domain/view deferrals for Phase 9 or Phase 11, and `lucide-react` remains until imports reach zero.
- [Phase 08]: Used isolated E2E ports for final browser proof after a default-port retry observed stale dev-server CSS.
- [Phase 09]: Centralized shared status vocabularies in `shared/ui/status-tokens.ts` and kept domain meaning in context/view tone helpers or explicit maps.
- [Phase 09]: Retokenized lifecycle/status CSS with standard semantic tokens and local `color-mix()` derivations; status colors are not backed by positional `chart-*` tokens.
- [Phase 09]: Removed source-level `lucide-react` imports; the package dependency remains for Phase 11 cleanup after final import/dependency audit.
- [Phase 09]: Extended token-foundation E2E with route-level painted status proof across seeded Dashboard, Jobs, Apply Review, Artifacts, Runs, and Debug.

### Pending Todos

None.

### Blockers/Concerns

- No current Blocker/High milestone blockers.
- Auditability risk: the UI must not hide missing or embarrassing audit data; missing sources must be fixed at the owning layer.
- Scope risk: ranking explanation belongs in the Jobs row-click drawer, while generated-material proof belongs in Apply review.
- QA risk: browser proof must use synthetic/seeded data and must not run auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs.
- Cleanup risk: folded v1.1 cleanup should close stale dependency/config/docs items without re-opening broad visual-system migration.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Visual system | User-editable theme customization | Future milestone | 2026-06-09 |
| Visual system | Dedicated visual regression service such as Chromatic/Loki/Percy | Future milestone | 2026-06-09 |
| Product UX | Full redesign or route/information architecture change | Future milestone | 2026-06-09 |
| Reporting | Charting/analytics overhaul beyond token availability | Future milestone | 2026-06-09 |
| Motion | Motion and microinteraction system | Future milestone | 2026-06-09 |
| Phase 06 P01 | 1min | 1 tasks | 1 files |
| Phase 06 P02 | 12min | 2 tasks | 7 files |
| Phase 06 P03 | 11min | 3 tasks | 7 files |
| Phase 06 P04 | 7min | 3 tasks | 14 files |
| Phase 06 P05 | 5min | 3 tasks | 15 files |
| Phase 06 P06 | 14min | 3 tasks | 6 files |
| Phase 07 P04 | 10min | 2 tasks | 11 files |
| Phase 07 P05 | 16min | 3 tasks | 8 files |
| Phase 08 P01 | 9min | 3 tasks | 2 files |
| Phase 08 P02 | 7min | 3 tasks | 10 files |
| Phase 08 P03 | 12min | 3 tasks | 4 files |
| Phase 08 P04 | 18min | 3 tasks | 7 files |
| Phase 09 P01 | 18min | 4 tasks | 7 files |
| Phase 09 P02 | 24min | 4 tasks | 16 files |
| Phase 09 P03 | 9min | 3 tasks | 10 files |
| Phase 09 P04 | 21min | 4 tasks | 10 files |
| Phase 10 P01 | 10min | 4 tasks | 1 files |
| Phase 10 P02 | 15min | 5 tasks | 4 files |
| Phase 10 P03 | 11min | 3 tasks | 0 files |
| Phase 10 P04 | 8min | 4 tasks | 12 files |

## Session Continuity

Last session: 2026-06-10T12:23:42.000Z
Stopped at: Completed Phase 10
Resume file: None
