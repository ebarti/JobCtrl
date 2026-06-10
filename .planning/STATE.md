---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: shadcn standard-token migration + preset b3F5kqmYd8
status: executing
stopped_at: Completed Phase 10
last_updated: "2026-06-10T14:22:43.000Z"
last_activity: 2026-06-10 -- Phase 10 route visual QA completed; Phase 11 cleanup is next
progress:
  total_phases: 6
  completed_phases: 5
  total_plans: 23
  completed_plans: 23
  percent: 83
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-06-09)

**Core value:** A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.
**Current focus:** Phase 11 — alias-and-global-css-cleanup

## Current Position

Phase: 11 (alias-and-global-css-cleanup) — READY TO PLAN
Plan: create Phase 11 plan
Status: Phase 10 complete; Phase 11 cleanup is next
Last activity: 2026-06-10 -- Phase 10 route visual QA completed; Phase 11 cleanup is next

Progress: [████████░░] 83%

## Active Milestone Summary

Milestone v1.1 migrates JobHunter's web UI from legacy custom tokens to the shadcn standard semantic CSS-variable token system using preset `b3F5kqmYd8`.

Decoded preset values:

| Setting | Value |
|---------|-------|
| menuColor | default-translucent |
| menuAccent | subtle |
| radius | medium |
| font | geist |
| iconLibrary | tabler |
| theme | sky |
| baseColor | neutral |
| style | luma / radix-luma target |
| chartColor | amber |
| fontHeading | jetbrains-mono |

Phase order:

| Phase | Name | Status |
|-------|------|--------|
| 6 | Token Foundation + shadcn Preset Contract | Completed |
| 7 | Shared Primitive Token Migration | Completed |
| 8 | Layout Chrome, Fonts, And Tabler Icons | Completed |
| 9 | Domain And Status Surface Migration | Completed |
| 10 | Route Visual QA + Storybook/A11y Hardening | Completed |
| 11 | Alias And Global CSS Cleanup | Pending |

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

- Treat shadcn tokens as frontend shared infrastructure, not bounded-context domain data.
- Preserve JobHunter's existing `[data-theme="dark"]` model during the migration unless a phase explicitly changes `ThemeProvider`.
- Phase 6 uses the clean-slate token decision from `06-CONTEXT.md`: remove legacy aliases/utilities by Phase 6 completion, with no compatibility-bridge handoff to later phases.
- Avoid uncontrolled full `shadcn apply`; research showed it rewrites a larger primitive/package surface than this milestone needs.
- Keep domain status semantics explicit in context-owned tone helpers or explicit variant maps.
- Make browser QA in light/dark themes and density modes a gate for user-facing visual phases.
- [Phase 10]: Added seeded route visual QA coverage for representative routes, overlays, light/dark themes, density modes, focus indicators, and destructive-control visibility.
- [Phase 10]: Restored global app focus outlines for `Input` and `Textarea` by removing primitive-level `focus-visible:outline-none` suppression.
- [Phase 10]: Split Jobs bulk-action disabled state from background query/preparation pickup state so valid selected-row actions remain usable while automatic preparation runs.

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
- Research risk: `apps/web/src/styles/globals.css` has broad blast radius; phase plans must avoid broad visual rewrites without route/browser QA.
- Research risk: full shadcn CLI apply rewrites too many UI files; use targeted application and manual edits unless a phase explicitly expands scope.
- Carry-forward test hygiene: 3 pre-existing unrelated failing tests were noted at v1.0 close (enrichment staleness x2, materials suppression).
- Phase 11 owns final legacy alias/global CSS cleanup, icon/font dependency audit, and residual token scans after the Phase 10 QA gate passed.

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
