# Research Summary: shadcn Standard-Token Migration

**Milestone:** shadcn standard-token migration + preset `b3F5kqmYd8`
**Decoded preset:** `menuColor=default-translucent`, `menuAccent=subtle`, `radius=medium`, `font=geist`, `iconLibrary=tabler`, `theme=sky`, `baseColor=neutral`, `style=luma`, `chartColor=amber`, `fontHeading=jetbrains-mono`
**Synthesized:** 2026-06-09
**Overall confidence:** HIGH for stack/config direction and architecture placement; MEDIUM-HIGH for exact visual QA scope because the current global CSS blast radius is large.

## Executive Summary

This milestone is a visual-system and shared-UI infrastructure migration, not a new JobHunter product feature. JobHunter should keep its existing local-first workflows, DDD/frontend bounded-context architecture, TanStack state model, routes, query keys, SSE invalidation behavior, audit surfaces, and safety constraints. The visible outcome should be a coherent shadcn standard-token skin matching preset `b3F5kqmYd8`: neutral base surfaces, sky action/accent language, amber chart/data emphasis, medium radii, Geist body text, JetBrains Mono headings/technical labels, subtle translucent menu treatment, and Tabler iconography.

The recommended approach is compatibility first. Introduce shadcn semantic CSS variables and Tailwind v4 `@theme inline` mappings before removing the old JobHunter token vocabulary. Keep temporary aliases for `--bg`, `--paper`, `--ink`, `--rule`, `--info`, `--danger`, `--warn`, `--ok`, `--font`, `--mono`, and `--row` until shared primitives, layout chrome, views, and status components are migrated and grep-clean. A hard switch to `bg-background`, `text-foreground`, `border-border`, and `ring-ring` without aliases will compile selectively but visually break global CSS, dynamic status classes, and dense operational surfaces.

The main risk is broad visual regression hidden inside a mechanically simple token rename. `apps/web/src/styles/globals.css` currently owns much more than base CSS: topbar, cards, dashboards, tables, drawers, apply review, scoring, pipeline, artifacts, source registry, and forms. Roadmap phases should therefore establish the token contract first, migrate shared primitives second, preserve domain/status semantics third, harden Storybook/a11y/visual QA fourth, and only then remove compatibility aliases and dead global CSS.

## Stack Additions

Recommended package/config additions are narrow and frontend-only:

| Addition | Why |
| --- | --- |
| `shadcn` | Needed if importing `shadcn/tailwind.css`; use CLI as generator/probe, not as uncontrolled rewrite. |
| `tw-animate-css` | Current shadcn Tailwind 4 animation path; `tailwindcss-animate` is deprecated for this path. |
| `@fontsource-variable/geist` | Preset body font. |
| `@fontsource-variable/jetbrains-mono` | Preset heading/technical font. |
| `@tabler/icons-react` | Preset icon library. Keep `lucide-react` until all imports are migrated. |
| `@types/node` dev dependency | Needed for Vite alias setup using Node path imports. |

Required config shape:

- `apps/web/components.json` should target `style: "radix-luma"`, `iconLibrary: "tabler"`, `baseColor: "neutral"`, CSS variables enabled, aliases still pointing at `@/shared/ui`, `@/shared/lib`, and `@/shared/hooks`.
- Add `@/* -> ./src/*` to `apps/web/tsconfig.json` and Vite `resolve.alias["@"]`; the shadcn CLI currently fails alias validation without this.
- Use `corepack pnpm dlx shadcn@latest apply b3F5kqmYd8 --only theme -y -c apps/web` only after alias setup. Avoid full `apply`; the probe rewrote 22 UI files, created new files, and added broader package changes including `radix-ui`.
- Final Tailwind v4 target should be CSS-first with standard shadcn variables exposed through `@theme inline`. Keep existing Tailwind config legacy mappings only as an interim bridge.

Do not add `radix-ui` or run `shadcn migrate radix` unless the milestone expands to regenerating local primitives. The current architecture already owns shadcn/Radix primitives under `apps/web/src/shared/ui/`.

## Feature Table Stakes

This milestone succeeds if existing JobHunter workflows are preserved while the visual language becomes consistent.

Must-have behavior:

- Standard semantic token coverage for backgrounds, foreground text, cards, popovers, inputs, focus rings, borders, destructive actions, chart tokens, sidebar/menu tokens, and radius scale.
- Preset fidelity visible in the real app, not only config: sky primary/accent, amber chart/data emphasis, neutral base, medium radius, Geist/JetBrains typography, subtle translucent menu treatment, and Tabler icons.
- Workflow preservation across dashboard, jobs, job detail/drawer, artifacts, apply review, discovery, profile/preferences/settings, runs, pipelines, and debug views.
- Light/dark continuity using JobHunter's existing persisted theme preference and `[data-theme="dark"]` behavior unless the ThemeProvider is explicitly migrated.
- Density continuity for compact/regular/comfy table and list surfaces; density remains app-shell scoped, not a shadcn color token.
- Navigation/menu polish without IA changes: topbar, nav, global search, density select, theme toggle, and connection status keep their meaning and position.
- Action hierarchy remains clear: primary, secondary, ghost, outline, link, and destructive variants map to shadcn semantics without weakening dangerous-action cues.
- Status semantics remain meaningful: success, warning, running/info, failed/destructive, pending/muted, stale/skipped/canceled. Domain states must not be flattened into generic `primary`/`secondary`.
- Audit surfaces stay honest and readable. The migration must not hide missing provenance, failed workflow states, stale scoring, destructive warnings, or apply-review evidence through low contrast or layout changes.
- Accessibility baseline remains intact: keyboard focus, contrast, aria labels, Radix focus handling, disabled states, Storybook a11y, and route-level QA.

Explicitly out of scope:

- New discovery, scoring, tailoring, apply, profile, hosted/auth, analytics, or worker-backed workflows.
- Full product redesign, route/information-architecture changes, marketing-style dashboards, advanced user theme customization, new charting library, motion system, visual-regression platform rollout, or permanent compatibility shims.

## Architecture Integration

Treat tokens as styling infrastructure at the frontend shared boundary, not as domain data. They belong in:

- `apps/web/src/styles/tokens.css`: canonical semantic CSS variables for theme and density compatibility.
- `apps/web/src/styles/globals.css`: Tailwind imports/base styles and temporary legacy selectors; this file should shrink over time.
- `apps/web/tailwind.config.ts`: interim bridge from CSS variables to utilities; final direction is Tailwind v4 CSS-first `@theme inline`.
- `apps/web/components.json`: shadcn registry contract and aliases.
- `apps/web/src/shared/ui/*`: copied/owned shadcn/Radix primitives.
- `apps/web/src/shared/layout/*`: app shell, topbar, nav, theme/density controls, global search, and connection chrome.

Do not push token vocabulary into bounded contexts as runtime config, stores, query data, or domain enums. Context components may map domain state to visual variants, but the token contract remains shared styling infrastructure. Views stay composers; they should consume shared primitives and context components without creating a parallel design system.

Recommended data/style flow:

1. `useUiPreferencesStore` persists theme and density.
2. `ThemeProvider` writes `data-theme` to `<html>`.
3. `AppShell` writes `data-density` around app content.
4. `tokens.css` resolves semantic CSS variables for active theme and density.
5. Tailwind exposes semantic utilities.
6. `shared/ui` primitives consume semantic utilities.
7. `shared/layout`, `views`, and `contexts` compose primitives and add only owner-appropriate layout/tone classes.

Key repo anchors:

- `docs/architecture.md:440-456`: current frontend stack includes Vite, React 19, Tailwind 4 tokens, shadcn/Radix primitives, TanStack Router/Query/Table/Form, Zustand, Vitest, Playwright, Storybook/a11y.
- `docs/frontend-target.md:1025-1072`: shadcn/Radix primitive layer plus Tailwind/CSS-variable theme architecture.
- `docs/local-reliability-qa.md:3-32` and `docs/local-reliability-qa.md:121-178`: frontend QA, browser smoke, a11y, and materials/apply-review inspector expectations.
- `apps/web/components.json`: current shadcn config already uses CSS variables, neutral base, `src/styles/globals.css`, `@/shared/ui`, and lucide.
- `apps/web/src/styles/tokens.css`: current bespoke token source.
- `apps/web/src/styles/globals.css`: high-blast-radius global and view styling surface.
- `apps/web/tailwind.config.ts`: current bespoke Tailwind aliases.
- `apps/web/src/shared/ui/button.tsx`, `card.tsx`, `badge.tsx`, overlay primitives, and table primitives: first TypeScript migration surface.

## Watch Outs

Top pitfalls and prevention:

| Risk | Prevention |
| --- | --- |
| Deleting legacy variables too early | Add shadcn variables and legacy aliases in the same foundation phase; remove aliases only after grep proves no production references remain. |
| Tailwind utilities not generated | Use Tailwind v4 `@theme inline` mappings for shadcn semantic tokens; do not rely on plain `:root` variables alone. |
| Dark-mode selector split | Preserve `[data-theme="dark"]` for this milestone unless ThemeProvider is explicitly changed; align CSS, Tailwind dark variant, Storybook, and E2E to the same selector. |
| Token pairs mapped backward | Build and verify a matrix for surface/foreground pairs: background, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, chart, sidebar/menu. |
| Domain status meaning flattened | Keep success/warning/info/destructive/muted domain semantics in typed context helpers/components; use standard tokens as rendering primitives, not as domain vocabulary. |
| Dynamic classes missed | Audit `StageBadge`, `ScoreBadge`, `StatusDot`, `SegmentBar`, status pills, and global semantic classes; use explicit variant maps or keep intentional CSS until migrated. |
| Translucent menus reduce readability | Use `popover`/`popover-foreground` for overlays by default; test any translucent treatment over dense Jobs, Apply Review, PDF preview, and dark mode. |
| Focus rings become invisible | Map `--ring` deliberately and run keyboard focus sweeps for buttons, inputs, tabs, dropdown items, dialogs, sheets, data-grid headers, and destructive controls. |
| Font/radius changes destabilize dense layouts | Treat typography and radius as visual phases with table, profile, apply-review, and PDF preview smoke; do not blanket `rounded-xl` operational UI. |
| Storybook/a11y false confidence | Inventory `a11y.test = "off"` stories; changed primitives need open-state stories and a11y coverage or documented deferrals. |
| Visual snapshots rubber-stamp regressions | Run semantic checks for status colors, focus rings, menu readability, and dark mode before accepting snapshot changes. |
| Sensitive data leaks into QA artifacts | Use synthetic/seeded data only. Do not run auto-apply, real generation, mailbox scanning, browser submission, real resumes, logs, SQLite databases, or generated PDFs unless explicitly requested. |

## Recommended Phase Shape

1. **Token Foundation**

   Establish preset tokens in `tokens.css`/`globals.css`, add `@theme inline`, preserve `[data-theme="dark"]`, introduce font/radius/chart/sidebar/menu tokens, and keep legacy aliases. Add the `@/*` alias prerequisite and update `components.json` only as needed for schema-compatible preset alignment. Exit when the app builds with both legacy and shadcn utilities and light/dark computed tokens are verified.

2. **Shared Primitive Migration**

   Migrate `shared/ui` primitives to standard semantic classes: buttons, badges, cards, inputs, selects, dropdowns, dialogs, sheets/drawers, popovers, command, toast, tabs, checkbox, switch, skeleton, separator, scroll area, table/data-grid. This phase owns focus rings, overlay readability, accessible icon controls, and open-state Storybook coverage. Do not change domain status meanings here.

3. **Layout Chrome + Icon/Typography Preset**

   Apply the preset to app shell surfaces: topbar, nav, global search, theme/density controls, connection banners, menus, and route tabs. Migrate icons through shared/layout and primitives using Tabler equivalents while preserving labels/aria labels and stable dimensions. Verify compact/regular/comfy density and light/dark topbar/menu readability.

4. **Domain/Status Surfaces**

   Migrate context-owned status/tone components: pipeline stages, score badges, artifact/apply statuses, status dots, segment bars, dashboard funnel/KPI tones, warning/destructive states, stale/missing audit states. Keep typed tone helpers as the source of domain meaning. Exit with stage-state parity, status fixture coverage, and browser smoke proving failed/blocked/running/succeeded/pending/stale remain distinguishable.

5. **Route Visual QA + Storybook/A11y Hardening**

   Cover representative routes and overlays with seeded data: `/dashboard`, `/jobs`, job detail drawer, `/artifacts`, artifact detail/panel, `/apply-review`, `/discovery`, `/profile` or `/preferences`, `/settings`, `/runs`, `/pipelines`, and `/debug`. Build/update Storybook stories for changed primitives and discriminant-state components. Run a11y gates and targeted E2E/browser smoke in light/dark and multiple densities.

6. **Alias and Global CSS Cleanup**

   Remove legacy token aliases, obsolete Tailwind color names, and dead global selectors only after production references are grep-clean. Keep the cleanup mechanical and separately reviewable. Exit when removed aliases/classes have named replacements and visual/semantic checks remain green.

Research flags:

- Phase 1 needs phase-level research if the team intends to rely on `shadcn apply` beyond `--only theme`, because full CLI output is broader than this milestone.
- Phase 2 needs focused research for exact Tabler replacements only if icon migration is included in the same PR stack.
- Phase 4 should plan typed status fixtures carefully; this is the highest product-semantics risk.
- Phases 5 and 6 follow existing repo QA/cleanup patterns and should not require deeper external research.

## Verification Gates

Minimum automated gates:

- `pnpm web:check`
- `pnpm web:build`
- `pnpm --filter @jobhunter/web test`
- `pnpm --filter @jobhunter/web test-d` if shared UI prop types, exports, or context component contracts change.
- `pnpm web:storybook:build` and `pnpm web:storybook:test` after primitive/story changes.
- `pnpm --filter @jobhunter/web e2e` or narrower affected specs for route-level visual workflow changes.
- `git diff --check`

Targeted migration gates:

- Legacy audit: `rg "var\\(--bg|var\\(--paper|var\\(--ink|bg-paper|text-ink|border-rule|ring-info|--danger|--warn|--ok|--info" apps/web/src apps/web/tailwind.config.ts`
- Computed-token smoke in light and `[data-theme="dark"]`: `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`, `--primary`, `--primary-foreground`, `--destructive`, `--border`, `--input`, `--ring`, `--chart-1`, `--chart-2`, and temporary compatibility aliases.
- Overlay smoke: dropdown, popover, command dialog, sheet, dialog, toast, select, and data-grid filter popover over dense Jobs/Apply Review content.
- Status smoke: all `STAGE_STATE_KINDS`, score tiers, artifact statuses, connection statuses, funnel segments, warning/destructive audit states, stale/missing states.
- Icon smoke: all icon-only controls have accessible names and stable dimensions; sort indicators, close/copy buttons, theme toggle, destructive controls, menu check/radio indicators.
- Font/density smoke: compact/regular/comfy across Jobs table, profile editor, apply-review queue, PDF preview toolbar, and debug/activity rows.
- Dark-mode smoke: assert the app uses `data-theme="dark"` consistently and overlays/forms/status badges resolve dark tokens correctly.
- Visual QA smoke with fixed viewport, seeded data, fixed theme/density, disabled animations, and one browser/project baseline. Do not update broad snapshots until semantic checks pass.

Roadmap blockers:

- Block primitive migration if Phase 1 does not preserve legacy aliases and `[data-theme]` behavior.
- Block domain/status migration if status colors are only visually inspected and not backed by typed fixtures/parity tests.
- Block cleanup until grep proves legacy references are gone outside intentional compatibility code.
- Block done status for user-facing phases without browser QA in both light and dark mode.

## Sources

Research files:

- `.planning/research/STACK.md`
- `.planning/research/FEATURES.md`
- `.planning/research/ARCHITECTURE.md`
- `.planning/research/PITFALLS.md`

Repo references:

- `README.md`
- `docs/architecture.md`
- `docs/frontend-target.md`
- `docs/local-reliability-qa.md`
- `docs/local-ts-api.md`
- `docs/decisions.md`
- `apps/web/components.json`
- `apps/web/package.json`
- `apps/web/src/styles/tokens.css`
- `apps/web/src/styles/globals.css`
- `apps/web/tailwind.config.ts`
- `apps/web/src/shared/ui/*`
- `apps/web/src/shared/layout/*`
- `apps/web/src/shared/providers/ThemeProvider.tsx`
- `apps/web/src/shared/providers/DensityProvider.tsx`
- `apps/web/src/shared/stores/ui-preferences.ts`
- `apps/web/src/contexts/operations/invalidation-router.ts`
- `apps/web/src/contexts/pipeline/components/StageBadge.tsx`
- `apps/web/src/contexts/scoring/components/ScoreBadge.tsx`

Official external sources:

- shadcn Vite installation: https://ui.shadcn.com/docs/installation/vite
- shadcn `components.json`: https://ui.shadcn.com/docs/components-json
- shadcn theming: https://ui.shadcn.com/docs/theming
- shadcn Tailwind v4 guidance: https://ui.shadcn.com/docs/tailwind-v4
- shadcn CLI: https://ui.shadcn.com/docs/cli
- shadcn schema: https://ui.shadcn.com/schema.json
- shadcn preset URL: https://ui.shadcn.com/create?preset=b3F5kqmYd8
- shadcn Vite dark mode: https://ui.shadcn.com/docs/dark-mode/vite
- shadcn chart theming: https://ui.shadcn.com/docs/components/chart
- Tailwind dark mode: https://tailwindcss.com/docs/dark-mode
- Tailwind theme variables: https://tailwindcss.com/docs/theme
- Storybook accessibility testing: https://storybook.js.org/docs/writing-tests/accessibility-testing
- Playwright visual comparisons: https://playwright.dev/docs/test-snapshots
