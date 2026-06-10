# Phase 8: Layout Chrome, Fonts, And Tabler Icons - Context

**Gathered:** 2026-06-10
**Status:** Ready for planning
**Mode:** Auto-discussed via `$gsd-autonomous`

<domain>
## Phase Boundary

Phase 8 migrates the app shell and user-visible chrome onto the preset visual language on top of the completed Phase 6 token foundation and Phase 7 shared primitive baseline. It owns topbar/nav/menu styling, brand mark treatment, global search, row density control, theme toggle, connection status/banner chrome, route tabs, persisted theme/density continuity, font usage, and visible icon migration to Tabler.

This phase must not change route structure, route search contracts, loaders, mutations, SSE/query behavior, domain workflow behavior, product status semantics, or audit data rendering. Domain/status tone semantics remain Phase 9, route-wide visual QA remains Phase 10, and final dead-CSS/dependency cleanup remains Phase 11.

</domain>

<decisions>
## Implementation Decisions

### Shell And Navigation Shape
- **D-01:** Preserve the existing `AppShell` structure: one topbar, existing main navigation labels/routes, global search, density selector, theme toggle, and connection status group. Do not redesign the information architecture or create new route groupings.
- **D-02:** Apply the preset chrome through standard shadcn semantic tokens and the decoded default-translucent/subtle menu treatment. Improve readability and polish without lowering the dense operational character of the app.
- **D-03:** Keep the brand small and functional. The brand mark may adopt preset radius/font/token styling, but it should remain a first-line app-shell affordance, not a marketing hero or large decorative element.
- **D-04:** Route tabs such as settings/profile wizard steps should be treated as chrome for token and focus consistency, but their navigation meaning and URL behavior must not change.

### Typography And Density
- **D-05:** Keep Geist as the body font and JetBrains Mono as the technical/heading/mono font, using the existing Fontsource imports from Phase 6. Verify Vite and Storybook both load the same stacks.
- **D-06:** Preserve the existing persisted theme and density store (`jh:ui-preferences`) and the pre-paint theme script in `apps/web/index.html`. Do not change storage keys or persistence shape unless a test proves a migration is necessary.
- **D-07:** Keep density scoped to `.app-shell[data-density]` and `--jh-row-height`. Compact, regular, and comfy modes must still fit dense table/list routes after font, radius, and icon updates.
- **D-08:** Do not rely on experimental style-query-only density behavior. Plain data attributes and CSS variables remain the baseline seam.

### Icon Migration
- **D-09:** Migrate user-visible lucide icons to Tabler equivalents wherever practical in Phase 8. `components.json` already targets Tabler for future generated output; this phase should make visible app chrome and controls match that target.
- **D-10:** Preserve icon-only control accessible names, hit targets, stable dimensions, and action meaning. Decorative icons stay `aria-hidden`.
- **D-11:** If a lucide icon cannot be replaced safely in this phase, record an explicit mapping/deferral in the Phase 8 summary or audit. Do not leave silent mixed icon libraries in user-visible chrome.
- **D-12:** Shared primitive internal icons may be migrated when they are user-visible control affordances, but do not rewrite primitive behavior while changing icons.

### Behavior And Safety
- **D-13:** Global search must continue navigating to `/jobs` with `q` and `page: 1` on Enter. Topbar/nav Link active state, route search params, loaders, mutations, theme persistence, density persistence, SSE status, and local-first safety behavior must remain unchanged.
- **D-14:** Connection status and worker/unavailable banners remain honest operational signals. This phase can improve chrome readability but must not hide, rename, or suppress warning/offline states.
- **D-15:** Use synthetic or seeded QA only. Do not run auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs.

### Verification Contract
- **D-16:** Phase 8 verification must include `corepack pnpm web:check`, `corepack pnpm web:build`, targeted tests for changed shell/provider/icon behavior, icon import audit (`lucide-react` / `@tabler/icons-react`), and `git diff --check`.
- **D-17:** Browser proof is required for the app shell: verify topbar/nav/global search/theme/density/connection chrome in light and dark themes and compact/regular/comfy density modes using seeded/synthetic local state.
- **D-18:** Storybook build/test should run if shared stories or route/view stories are changed. The existing Storybook Chromium MachPort sandbox failure may require the same browser-launch escalation used in Phase 7.

### the agent's Discretion
- The planner may choose the exact Tabler icon equivalents, class names, and CSS organization as long as meaning, accessible names, and stable dimensions are preserved.
- The planner may split shell styling, icon migration, and browser proof into separate plans based on dependency and verification cost.
- The planner may add narrow tests around `Topbar`, `ThemeToggle`, `ConnectionStatusPill`, or pre-paint/persistence behavior if they are the best way to prove no behavior changed.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone And Prior Phases
- `.planning/PROJECT.md` - Current milestone goal, clean-slate token migration constraints, and v1.1 project boundary.
- `.planning/REQUIREMENTS.md` - Phase 8 requirements `LAYOUT-01` through `LAYOUT-05` and milestone safety boundaries.
- `.planning/ROADMAP.md` - Phase 8 goal, success criteria, dependencies, and verification expectations.
- `.planning/STATE.md` - Current v1.1 state with Phases 6 and 7 complete.
- `.planning/phases/06-token-foundation-shadcn-preset-contract/06-CONTEXT.md` - Clean-slate token, preset, font, and Tabler dependency decisions.
- `.planning/phases/06-token-foundation-shadcn-preset-contract/06-VERIFICATION.md` - Token foundation, font dependency, shadcn config, and browser smoke evidence.
- `.planning/phases/07-shared-primitive-token-migration/07-CONTEXT.md` - Shared primitive, density, accessibility, and safety decisions.
- `.planning/phases/07-shared-primitive-token-migration/07-VERIFICATION.md` - Shared primitive baseline, row activation, focus ring, Storybook, and boundary evidence.

### Frontend Architecture And QA
- `AGENTS.md` - Dedicated worktree, frontend conventions, QA expectations, sensitive-data restrictions, and no user-affecting automation rule.
- `docs/frontend-target.md` - App shell, state layers, view/context split, shared UI ownership, Storybook/testing pyramid, and route behavior constraints.
- `docs/local-reliability-qa.md` - Local QA command set, Storybook/a11y bar, browser proof expectations, and safety boundaries.
- `docs/local-ts-api.md` - Web/API development and verification commands; Phase 8 must not change API/SSE behavior.
- `docs/architecture.md` - Current TypeScript web/API architecture, local-first boundaries, and frontend stack.
- `docs/decisions.md` - ADR context for TanStack Router/Query, frontend ports, SSE invalidation, and architecture boundaries.

### Codebase Maps
- `.planning/codebase/STRUCTURE.md` - Web app route/view/context layout and shell entry points.
- `.planning/codebase/CONVENTIONS.md` - Frontend styling, import, testing, and documentation conventions.
- `.planning/codebase/TESTING.md` - Web test, Storybook, Playwright, and fixture patterns.

### Current Code Surfaces
- `apps/web/src/shared/layout/AppShell.tsx` - App shell root and density attribute seam.
- `apps/web/src/shared/layout/Topbar.tsx` - Topbar, brand, nav, global search, density control, theme toggle, and connection status composition.
- `apps/web/src/shared/layout/NavBar.tsx` - Main navigation labels/routes and active link styling.
- `apps/web/src/shared/layout/ThemeToggle.tsx` - Theme toggle behavior and current lucide sun/moon icons.
- `apps/web/src/shared/layout/ConnectionStatusPill.tsx` - SSE/worker status chrome and banners.
- `apps/web/src/shared/stores/ui-preferences.ts` - Persisted theme/density state and storage key.
- `apps/web/index.html` - Pre-paint theme script tied to the Zustand persist shape.
- `apps/web/src/styles/globals.css` - Shell/nav/tab/menu/density global styling and token consumers.
- `apps/web/src/styles/tokens.css` - Standard token source and font/radius/density variables.
- `apps/web/.storybook/preview.tsx` - Storybook theme/density provider parity.
- `apps/web/src/styles/token-contract.test.ts` - Existing token/preset/font/dependency assertions.
- `apps/web/e2e/tests/token-foundation.spec.ts` - Existing browser proof pattern for computed tokens, theme, and density.
- `apps/web/package.json` - Current `@tabler/icons-react` and remaining `lucide-react` dependencies.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `AppShell` already renders `.app-shell` with `data-density={density}`. This is the correct density seam for Phase 8.
- `Topbar` already composes every Phase 8 app-shell control in one place: brand, `NavBar`, global search, density `select`, `ThemeToggle`, and `ConnectionStatusPill`.
- `ThemeProvider`, `useTheme`, `useDensity`, and `useUiPreferencesStore` already preserve theme/density without a provider API change.
- `apps/web/index.html` already avoids theme flash by reading `jh:ui-preferences` before React renders.
- `token-contract.test.ts` already asserts preset values, font dependencies, `iconLibrary: tabler`, and density/theme selectors. Extend rather than duplicate if a token contract needs proof.
- `token-foundation.spec.ts` already demonstrates a seeded browser-proof style for computed values, theme switching, and density checks.

### Established Patterns
- Frontend view and shell code uses TanStack Router `Link` / `useNavigate`; route behavior must stay URL-driven.
- Global shell styling currently lives in `apps/web/src/styles/globals.css`, while primitives use shared UI utility composition. Phase 8 should avoid moving app shell behavior into bounded contexts.
- Persisted UI preferences use Zustand `persist` with key `jh:ui-preferences` and version `1`; `index.html` reads that exact serialized shape.
- Shared primitives and chrome use native controls where possible. Keep labels explicit and avoid icon-only unlabeled buttons.
- Current visible icons are mixed: `@tabler/icons-react` is installed, but app/shared/context code still imports several icons from `lucide-react`.

### Integration Points
- `Topbar` global search is the behavior seam: Enter on a non-empty query navigates to `/jobs` with `{ q, page: 1 }`.
- `NavBar` active state uses TanStack Router `activeProps={{ className: "on" }}` and should keep that route-aware behavior.
- `ConnectionStatusPill` reads both EventStream status and health query. Styling can change, but alert/status live-region behavior must remain.
- `ThemeToggle` is the smallest high-value icon migration target because it is app chrome and has an explicit accessible name.
- Storybook provider parity is in `.storybook/preview.tsx`; any shell stories or provider-facing stories should respect the same theme/density globals.

</code_context>

<specifics>
## Specific Ideas

- Auto-selected gray area: **Shell shape** -> preserve the current dense operational topbar and navigation structure; improve token/readability treatment rather than redesigning.
- Auto-selected gray area: **Typography and density** -> use existing Fontsource/persisted density seams; verify that compact/regular/comfy still fit table-heavy routes.
- Auto-selected gray area: **Icon migration** -> migrate visible lucide imports to Tabler equivalents or explicitly document any intentional retained mappings.
- Auto-selected gray area: **Safety and behavior** -> no route/API/query/SSE/workflow changes; no user-affecting automation during QA.

</specifics>

<deferred>
## Deferred Ideas

- Domain/status tone remapping remains Phase 9.
- Route-wide light/dark/density visual QA across all representative routes remains Phase 10.
- Final global CSS cleanup and unused dependency removal remains Phase 11.

</deferred>

---

*Phase: 8-Layout Chrome, Fonts, And Tabler Icons*
*Context gathered: 2026-06-10*
