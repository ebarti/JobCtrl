# Summary

The shadcn standard-token migration should be treated as a frontend shared-kernel migration, not as a feature-context migration. The semantic token contract belongs at the app styling boundary: `apps/web/src/styles/tokens.css`, `apps/web/src/styles/globals.css`, `apps/web/tailwind.config.ts`, and the shadcn registry contract in `apps/web/components.json`. The migration should make shadcn's standard CSS-variable names the canonical design-token API while preserving JobHunter's existing architecture: bounded contexts own domain behavior, views compose context components, and `shared/ui` owns reusable primitives.

Use preset `b3F5kqmYd8` as the source for the standard semantic token vocabulary, then map the current local palette into shadcn-compatible variables such as `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`, `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--destructive-foreground`, `--border`, `--input`, `--ring`, and `--radius`. Do not let app-specific aliases like `--paper`, `--ink`, `--rule`, `--ok`, or `--info` remain the long-term primitive API. If transitional aliases are needed, they should live only in `tokens.css` and point to the standard names, not spread through components.

The main architecture risk is that `globals.css` currently owns much more than global CSS. It imports Tailwind and tokens at the root, but it also contains app chrome, cards, dashboards, table grids, drawers, source registry, apply-review, scoring, and pipeline selectors. That file is the migration's highest-risk surface because changing tokens there changes every view at once. Roadmap phases should first establish the token contract, then migrate shared primitives, then migrate layout chrome, then migrate view/context CSS in small slices.

Repo anchors:

- `docs/architecture.md:433` states the frontend follows the target architecture: three-layer state, eight bounded contexts, view/context dichotomy, ports, SSE invalidation, and Operations read-side.
- `docs/architecture.md:446` records Tailwind CSS 4 with design tokens in `tokens.css`; `docs/architecture.md:447` records shadcn/ui as copied and owned in `shared/ui`.
- `docs/frontend-target.md:1025` to `docs/frontend-target.md:1054` chooses shadcn/Radix for the primitive layer.
- `docs/frontend-target.md:1059` to `docs/frontend-target.md:1072` makes Tailwind plus CSS variables the styling architecture.
- `apps/web/components.json:6` to `apps/web/components.json:20` already points shadcn at `src/styles/globals.css`, `tailwind.config.ts`, `@/shared/ui`, `@/shared/lib`, and `lucide`.
- `apps/web/src/styles/tokens.css:1` to `apps/web/src/styles/tokens.css:42` is the current non-standard token source.
- `apps/web/src/styles/globals.css:1` to `apps/web/src/styles/globals.css:34` is the global Tailwind/base style entry; `apps/web/src/styles/globals.css:42` onward is app/view/component styling that should be reduced over time.

# Current Architecture Fit

The token migration fits the current architecture if tokens are handled as styling infrastructure, not as domain data. They do not belong in `contexts/discovery`, `contexts/scoring`, `contexts/materials`, `contexts/apply`, `contexts/pipeline`, `contexts/profile`, or `contexts/operations` as config objects, enums, stores, or query data. Context components may consume semantic classes from `shared/ui` and Tailwind, but they should not define the app's semantic token vocabulary.

The existing shadcn setup is already aligned with the intended destination:

- `apps/web/components.json:6` to `apps/web/components.json:11` has `cssVariables: true`, no prefix, neutral base color, and `src/styles/globals.css` as the registry CSS target.
- `apps/web/components.json:13` to `apps/web/components.json:19` aliases generated components to `@/shared/ui`, utilities to `@/shared/lib/cn`, and hooks to `@/shared/hooks`.
- `apps/web/src/shared/ui/button.tsx:9` to `apps/web/src/shared/ui/button.tsx:25`, `apps/web/src/shared/ui/badge.tsx:8` to `apps/web/src/shared/ui/badge.tsx:19`, and `apps/web/src/shared/ui/card.tsx:7` to `apps/web/src/shared/ui/card.tsx:38` show the primitive layer already centralizes reusable visual variants. Those primitives currently use JobHunter-specific classes like `bg-ink`, `text-paper`, `border-rule`, and `text-muted`; they are the correct first TypeScript migration surface after the token file.

The app's theme and density mechanics also fit the shadcn CSS-variable model:

- `apps/web/src/shared/stores/ui-preferences.ts:14` to `apps/web/src/shared/stores/ui-preferences.ts:26` persists `theme` and `density`.
- `apps/web/src/shared/providers/ThemeProvider.tsx:5` to `apps/web/src/shared/providers/ThemeProvider.tsx:10` writes `data-theme` to `<html>`.
- `apps/web/src/shared/layout/AppShell.tsx:6` to `apps/web/src/shared/layout/AppShell.tsx:14` writes `data-density` on the app shell.
- `apps/web/src/shared/providers/DensityProvider.tsx:3` to `apps/web/src/shared/providers/DensityProvider.tsx:8` intentionally keeps density off `<html>` so portaled overlays are not accidentally density-scoped.

Keep that split. Shadcn semantic color tokens should be theme-scoped on `:root` and `[data-theme="dark"]`. Density should remain an app-shell/layout concern and should continue to drive dimensional variables like row height. Do not move density to shadcn color tokens, and do not make portaled Radix overlays depend on `.app-shell[data-density]` unless the overlay intentionally receives density classes.

The current mismatch is naming and ownership:

- `apps/web/src/styles/tokens.css:1` to `apps/web/src/styles/tokens.css:16` defines bespoke light tokens.
- `apps/web/src/styles/tokens.css:19` to `apps/web/src/styles/tokens.css:27` defines density variables on `[data-density]`.
- `apps/web/src/styles/tokens.css:29` to `apps/web/src/styles/tokens.css:42` defines bespoke dark tokens.
- `apps/web/tailwind.config.ts:8` to `apps/web/tailwind.config.ts:24` exposes bespoke names as Tailwind colors and fonts.
- `apps/web/src/styles/globals.css:42` onward uses those bespoke variables directly for app structure.

The migration should change the public styling API from JobHunter aliases to shadcn semantic names while keeping the product architecture unchanged.

# Owning Layers

| Layer | Owns | Migration Responsibility | Do Not Put Here |
| --- | --- | --- | --- |
| `apps/web/src/styles/tokens.css` | Canonical CSS variables for theme and density | Add preset `b3F5kqmYd8` standard semantic variables; keep light/dark scopes; optionally provide temporary alias variables that point to standard variables | Component selectors, view layout rules, domain status mappings, JavaScript data |
| `apps/web/src/styles/globals.css` | Tailwind import/config, base element styles, temporary legacy global selectors | Switch base styles to standard tokens; shrink legacy selectors over phases; keep only real global reset/base and temporary compatibility | Long-term ownership of cards, tables, drawers, dashboard grids, status badges, apply-review layout |
| `apps/web/tailwind.config.ts` | Tailwind bridge to CSS variables | Expose shadcn standard semantic color names and radius/font tokens; keep dark mode selector as `[data-theme='dark']` | Bespoke product palette aliases as the permanent API; domain tone definitions |
| `apps/web/components.json` | shadcn registry contract | Keep aliases to `@/shared/ui`, `@/shared/lib/cn`, CSS variables, `lucide`; update only if shadcn CLI output requires a schema-compatible change | Alternate component roots, generated code outside `shared/ui`, prefix changes that invalidate existing classes |
| `apps/web/src/shared/ui/*` | shadcn/Radix primitives and reusable non-domain UI | Convert primitive classes from `bg-ink`/`text-paper`/`border-rule` to standard semantic classes (`bg-primary`, `text-primary-foreground`, `bg-card`, `text-card-foreground`, `border-border`, `ring-ring`, etc.) | Domain-specific tones like "job failed", "score stale", "resume approved"; direct API/query/state logic |
| `apps/web/src/shared/layout/*` | App shell, topbar, nav, global search, theme/density controls, connection chrome | Move `.topbar`, `.brand`, `.nav`, `.global-search`, `.tab`, `.main`, and connection-banner styling out of legacy global CSS into layout components or layout-specific primitives | Context imports, domain-specific view logic, persistent server state |
| `apps/web/src/views/*` | View composition and view-local ephemeral UI | Consume primitives/layout utilities; migrate view-owned layout wrappers like dashboard grids and page section composition in small slices | New token definitions, shared primitive variants, context-owned badge/status semantics, query keys, mutations |
| `apps/web/src/contexts/*` | Domain hooks, context components, domain selectors, event handlers | Update context-owned components only where they render their own status/tone UI; keep tone decisions in context libs such as scoring/pipeline/materials tone helpers | CSS variable declarations, shadcn registry config, global app chrome, view composition |
| `apps/web/src/shared/providers/*` and stores | Theme/density/ports/query/toast provider wiring | Preserve `ThemeProvider` and `DensityProvider` behavior; no token migration should change server/URL/client state boundaries | CSS token maps as runtime state, user preference migrations unrelated to theme/density |

Data/style flow should remain:

1. `useUiPreferencesStore` persists theme and density (`apps/web/src/shared/stores/ui-preferences.ts:14`).
2. `ThemeProvider` writes `data-theme` to `<html>` (`apps/web/src/shared/providers/ThemeProvider.tsx:7`).
3. `AppShell` writes `data-density` around app content (`apps/web/src/shared/layout/AppShell.tsx:9`).
4. `tokens.css` resolves semantic CSS variables for the active theme and density.
5. `tailwind.config.ts` exposes those variables as Tailwind semantic utilities.
6. `shared/ui` primitives consume semantic utilities.
7. `shared/layout`, `views`, and `contexts` compose primitives and add only the layout/tone classes they own.

This means tokens flow downward; domain state never flows back into token definitions. A score, stage, or apply status can choose a component variant, but it must not rewrite global CSS variables.

# Migration Sequence

1. Establish the standard-token contract.

   Replace the canonical variable names in `apps/web/src/styles/tokens.css` with shadcn standard semantic variables from preset `b3F5kqmYd8`. Keep light and dark scopes. Preserve density variables (`--row` or a renamed app dimension token) under `[data-density]` because density is a local JobHunter UI preference, not a shadcn color semantic. For compatibility, temporary aliases like `--bg: var(--background)` and `--ink: var(--foreground)` are acceptable only inside `tokens.css`.

2. Update the Tailwind bridge.

   Convert `apps/web/tailwind.config.ts` from bespoke colors (`bg`, `paper`, `paper-2`, `rule`, `ink`, `danger`, `warn`, `ok`, `info`) to shadcn semantic colors backed by CSS variables. Preserve `darkMode: ["selector", "[data-theme='dark']"]` from `apps/web/tailwind.config.ts:4` because it matches `ThemeProvider` and the architecture docs. Add radius/font mappings if the preset includes them. Do not introduce Tailwind plugin or config state that bypasses CSS variables.

3. Migrate shared primitives.

   Update `apps/web/src/shared/ui/*` before touching views. Button, badge, card, input, select, dropdown, dialog, sheet, drawer, toast, tabs, table, popover, tooltip, switch, checkbox, scroll-area, skeleton, separator, and data-grid primitives should speak shadcn semantic classes. This creates a stable semantic surface for context and view work. Primitive tests and stories should remain colocated.

4. Migrate app shell and layout chrome.

   Move topbar/nav/main/global-search/tab/connection styling out of broad legacy selectors and into `apps/web/src/shared/layout/*` using semantic utilities or small layout-local class names. `Topbar` currently uses `.topbar`, `.brand`, `.brand-mark`, `.global-search`, `.select`, and `.tab` (`apps/web/src/shared/layout/Topbar.tsx:17` to `apps/web/src/shared/layout/Topbar.tsx:48`); `NavBar` uses `.nav` and active class `on` (`apps/web/src/shared/layout/NavBar.tsx:31` to `apps/web/src/shared/layout/NavBar.tsx:39`); `ThemeToggle` uses `.tab` (`apps/web/src/shared/layout/ThemeToggle.tsx:9` to `apps/web/src/shared/layout/ThemeToggle.tsx:17`). Those are layout-owned, not view-owned.

5. Migrate shared data/table surfaces.

   `FilterableDataGrid` is a shared UI primitive used by Jobs and Artifacts (`apps/web/src/shared/ui/filterable-data-grid.tsx:73` to `apps/web/src/shared/ui/filterable-data-grid.tsx:100`). It currently emits many global class names (`apps/web/src/shared/ui/filterable-data-grid.tsx:492` to `apps/web/src/shared/ui/filterable-data-grid.tsx:620`). Migrate this once in `shared/ui`, then let Jobs/Artifacts inherit the result. Avoid per-view table token overrides except for structural column width classes owned by the view.

6. Migrate view-owned layout slices.

   After primitives and layout are stable, migrate view wrappers in small slices:

   - Dashboard: `DashboardView` composes KPIs, funnel, source health, apply runs, and outcome suggestions (`apps/web/src/views/dashboard/DashboardView.tsx:19` to `apps/web/src/views/dashboard/DashboardView.tsx:44`). Its `.dashboard-grid`, `.card`, and `.banner` usage should become semantic primitives/layout utilities.
   - Jobs: `JobsView` owns URL-bound filters, bulk selection, and table composition (`apps/web/src/views/jobs/JobsView.tsx:153` to `apps/web/src/views/jobs/JobsView.tsx:239`) and renders the page card/table surface (`apps/web/src/views/jobs/JobsView.tsx:438` onward). Keep data logic unchanged while migrating classes.
   - Artifacts: `ArtifactsView` mirrors the same composer pattern (`apps/web/src/views/artifacts/ArtifactsView.tsx:34` to `apps/web/src/views/artifacts/ArtifactsView.tsx:96`).
   - Job drawer: `JobDetailDrawer` composes components from apply/materials/operations/pipeline/scoring (`apps/web/src/views/jobs/JobDetailDrawer.tsx:4` to `apps/web/src/views/jobs/JobDetailDrawer.tsx:23` and `apps/web/src/views/jobs/JobDetailDrawer.tsx:97` to `apps/web/src/views/jobs/JobDetailDrawer.tsx:177`). Treat drawer structure as view/layout; context-rendered sections keep their own domain components.

7. Migrate context-owned tone components.

   Context components such as `StageBadge`, `ScoreBadge`, `ArtifactStatusBadge`, `ApplyRunBadge`, and status/timeline components should map domain states to semantic variants or context-local tone helpers. They should not define CSS variables. Existing tone helpers like `contexts/pipeline/lib/*tone*`, `contexts/materials/lib/*tone*`, and scoring tier helpers remain the right place to translate domain state into UI tone.

8. Remove compatibility aliases and legacy globals.

   Only after `rg "bg-ink|text-paper|border-rule|var\\(--paper|var\\(--ink|var\\(--rule|var\\(--info|var\\(--ok|var\\(--warn|var\\(--danger"` is clean outside intentional compatibility checks, remove bespoke aliases from `tokens.css` and bespoke Tailwind color names from `tailwind.config.ts`. The final state should make accidental use of legacy token names fail quickly.

# Test/QA Integration Points

Use the frontend's existing architecture test pyramid rather than inventing token-specific backend tests.

Required static checks for migration phases:

- `pnpm web:check` or `pnpm api:check` only if touched; token/UI work should at least run the web typecheck.
- `pnpm --filter @jobhunter/web test` for touched primitive, layout, context, and view tests.
- `pnpm web:build` because Tailwind token/config mistakes often surface only during Vite/Tailwind compilation.
- A token usage audit with `rg` for legacy names after each phase. This is especially important before removing aliases.

Recommended targeted tests:

- Primitive Storybook stories: update stories colocated with `shared/ui` primitives so default, secondary, destructive, outline, disabled, focus, hover, and dark-mode states are visually reviewable.
- Component tests for behavior-bearing primitives only. Do not test shadcn/Radix internals; `docs/frontend-target.md:2189` to `docs/frontend-target.md:2193` explicitly excludes primitive internals and visual pixel-perfectness from unit tests.
- A small token-contract test can be useful if it checks project-owned invariants, not CSS rendering internals. Example: assert `tokens.css` contains the required standard variables in both `:root` and `[data-theme="dark"]`, and assert `tailwind.config.ts` exposes the semantic token names used by shadcn primitives.
- A11y checks should remain with forms/dialogs/components that already own them. The migration should not silence existing `*.a11y.test.tsx` files or Storybook a11y gates.

Required product QA for user-facing visual migration phases:

- Run at least one browser smoke through the visible app shell: dashboard load, topbar/nav, theme toggle, density selector, Jobs table, job detail drawer, and Artifacts table. The token migration can visually break these without changing behavior.
- Verify both light and dark themes because `ThemeProvider` writes `[data-theme]` and all semantic variables must resolve in both scopes.
- Verify all three densities because row height is still a product preference (`--row`) and the AppShell intentionally scopes it below `<html>`.
- Verify Radix portals: Dialog, Sheet/Drawer, DropdownMenu, Popover, Select, Tooltip, Toast. Portaled elements may not inherit AppShell density, and they depend on globally scoped theme tokens.

QA should be phase-specific:

- Token/Tailwind phase: build plus token audit plus light/dark smoke.
- Primitive phase: Storybook or component smoke for every changed primitive.
- Layout phase: browser smoke for topbar/nav/global search/theme/density/connection banner.
- View phase: Playwright or manual browser smoke for the changed view's real workflow.
- Context tone phase: existing colocated tests for status badges/timelines plus Storybook variants per discriminant state.

# Risks

1. Global CSS blast radius.

   `globals.css` is not just global base CSS. It owns topbar, cards, dashboards, forms, tables, drawers, apply-review, discovery, source registry, score, pipeline, and artifact styles. A single token rename can break unrelated product surfaces. Mitigation: introduce standard variables first, keep temporary aliases, migrate by owner layer, and remove aliases only after an `rg` audit.

2. Architecture drift into view-owned design systems.

   Views are composers, not component libraries. `docs/frontend-target.md:680` to `docs/frontend-target.md:709` and `docs/architecture.md:489` to `docs/architecture.md:494` are explicit: views own layout and ephemeral UI only. Mitigation: any reusable visual variant belongs in `shared/ui`; any app chrome belongs in `shared/layout`; any domain status rendering belongs in its context.

3. Domain tone flattening.

   Shadcn standard tokens have generic semantic colors, but JobHunter has domain states: stage failed/blocked/running/pending, score stale, artifact missing/approved, apply run states, source health. A naive migration to only `primary`, `secondary`, and `destructive` will lose product meaning. Mitigation: keep domain-to-tone mapping in context-owned helpers/components, but express the final styles through standard token utilities or context-local component variants.

4. Density and portal inheritance bugs.

   Density is scoped on `.app-shell` by design (`apps/web/src/shared/providers/DensityProvider.tsx:3` to `apps/web/src/shared/providers/DensityProvider.tsx:6`). Radix portals render outside that subtree. Mitigation: keep theme tokens global, keep density layout-scoped, and explicitly handle density for portaled components only when necessary.

5. Premature removal of aliases.

   Removing `--paper`, `--ink`, `--rule`, `--info`, `--ok`, `--warn`, and `--danger` before all CSS/classes are migrated will produce broad visual regressions. Mitigation: use compatibility aliases during early phases, then delete aliases in a final cleanup phase guarded by `rg`.

6. Token migration mixed with state or data refactors.

   The migration should not touch query keys, Operations read hooks, SSE invalidation, router search params, ports, or API contracts. Those are architecture seams documented in `docs/architecture.md:458` to `docs/architecture.md:575`. Mitigation: reject roadmap phases that combine token migration with server-state, routing, event, or domain behavior changes unless there is a separate product reason.

7. Shadcn CLI output outside the intended owner.

   `components.json` already directs shadcn output to `@/shared/ui`. Generated components must not land under `views`, `contexts`, or a new root `components` folder. Mitigation: keep `apps/web/components.json` aliases stable and review generated imports before accepting a phase.

8. Incomplete dark-mode coverage.

   Existing `tokens.css` has both light and dark values. The standard-token replacement must preserve both. Mitigation: token-contract check plus manual/browser smoke in both themes before any alias cleanup.
