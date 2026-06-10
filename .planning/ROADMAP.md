# Roadmap: v1.1 shadcn standard-token migration + preset b3F5kqmYd8

## v1.1 shadcn standard-token migration + preset b3F5kqmYd8

## Overview

Milestone v1.1 migrates the JobHunter web app from a bespoke token layer to the current shadcn semantic CSS-variable token system using preset `b3F5kqmYd8`. This is not a product-feature milestone. The app must continue to behave like the same local-first operational tool: dashboard, jobs, artifacts, apply review, discovery, profile/preferences/settings, runs, pipelines, debug views, audit surfaces, route behavior, TanStack state, SSE invalidation, and safety boundaries stay intact.

The migration is dependency-forced. First establish the token contract and shadcn CLI/config prerequisites while removing the legacy token API under the Phase 6 clean-slate decision. Then migrate shared primitives, then app shell/layout, then domain/status surfaces. Only after Storybook/a11y/browser QA proves representative workflows in light/dark and density modes should the final cleanup remove dead global CSS, obsolete config remnants, and unused dependencies. This ordering still treats `apps/web/src/styles/globals.css` as the highest-risk blast radius: a hard token rename can pass typecheck while visually breaking dense operational surfaces, so Phase 6 requires browser proof.

## Phases

**Phase Numbering:**

- Previous milestone v1.0 completed Phases 1-5.
- This milestone continues numbering at Phase 6.
- Integer phases are planned milestone work.
- Decimal phases are reserved for urgent insertions.

- [x] **Phase 6: Token Foundation + shadcn Preset Contract** - Establish preset-backed standard semantic tokens, Tailwind 4 mappings, alias prerequisites, and clean-slate legacy token removal.
- [ ] **Phase 7: Shared Primitive Token Migration** - Move shared shadcn/Radix primitives to standard semantic classes with overlay, focus, form, table, and Storybook coverage.
- [ ] **Phase 8: Layout Chrome, Fonts, And Tabler Icons** - Apply the preset to app shell, topbar, nav, menus, theme/density controls, fonts, and visible iconography without route/workflow changes.
- [ ] **Phase 9: Domain And Status Surface Migration** - Preserve product-specific status semantics across pipeline, scoring, artifacts, apply, discovery, dashboard, audit, and warning states.
- [ ] **Phase 10: Route Visual QA + Storybook/A11y Hardening** - Prove representative routes, overlays, light/dark themes, and density modes with seeded/synthetic QA only.
- [ ] **Phase 11: Alias And Global CSS Cleanup** - Remove dead global selectors, obsolete config remnants, residual old token references, and unused icon/font dependencies after grep and QA proof.

## Phase Details

### Phase 6: Token Foundation + shadcn Preset Contract

**Goal:** The app has a standard shadcn semantic token foundation for light/dark themes and the decoded preset, with legacy token names removed from the Phase 6 public token contract.

**Depends on:** Milestone v1.0 complete.

**Requirements:** TOKEN-01, TOKEN-02, TOKEN-03, TOKEN-04, TOKEN-05, TOKEN-06

**Success Criteria** (what must be TRUE):

1. `apps/web/src/styles/tokens.css` and `apps/web/src/styles/globals.css` expose the shadcn standard semantic token set, chart/sidebar/menu tokens, font tokens, and derived radius scale for light and dark themes.
2. Tailwind 4 can generate semantic utilities such as `bg-background`, `text-foreground`, `bg-card`, `border-border`, `ring-ring`, `bg-primary`, `text-primary-foreground`, `bg-popover`, and `text-popover-foreground` through CSS-first token mappings.
3. `components.json`, TypeScript aliases, and Vite aliases satisfy current shadcn CLI validation and keep generated/copied components under `apps/web/src/shared/ui`.
4. The decoded preset values are represented in config/tokens: luma/radix-luma style target, neutral base, sky accents, amber chart palette, medium radius, Geist body font, JetBrains Mono heading/technical font, Tabler icon target, default-translucent menu, and subtle menu accent.
5. Existing `[data-theme="dark"]` and `data-density` behavior still works, and legacy aliases/utilities are absent from production styling by the Phase 6 exit state.

**Verification:**

- `pnpm web:check`
- `pnpm web:build`
- `pnpm dlx shadcn@latest info -c apps/web` or documented equivalent
- Token grep showing legacy names are removed from production styling and any short-lived compile bridge is gone
- Browser smoke of light/dark token computed values on the app shell

**Plans:** 6/6 plans executed
Plans:
**Wave 1**

- [x] 06-01-PLAN.md — Approve SUS package identities before dependency installation.

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 06-02-PLAN.md — Install preset dependencies and validate shadcn aliases/config.

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 06-03-PLAN.md — Implement CSS-first semantic tokens, density seams, bridge removal, and token tests.

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 06-04-PLAN.md — Mechanically migrate core shared primitives and Storybook wrapper utilities.
- [x] 06-05-PLAN.md — Mechanically migrate overlay/menu primitives and overlay story utilities.

**Wave 5** *(blocked on Wave 4 completion)*

- [x] 06-06-PLAN.md — Add browser computed-token smoke, update docs, and run final proof gate.

### Phase 7: Shared Primitive Token Migration

**Goal:** Shared UI primitives speak the shadcn standard token language, so views and context components can inherit consistent surfaces, borders, focus rings, actions, forms, tables, overlays, and disabled states.

**Depends on:** Phase 6

**Requirements:** PRIM-01, PRIM-02, PRIM-03, PRIM-04, PRIM-05

**Success Criteria** (what must be TRUE):

1. Button, badge, card, input, textarea, select, checkbox, switch, tabs, table/data-grid, skeleton, separator, scroll-area, toast, dialog, sheet/drawer, dropdown, popover, command, and tooltip primitives use standard semantic utilities instead of legacy `bg-paper`, `text-ink`, `border-rule`, `ring-info`, or direct legacy variables.
2. Overlay primitives are readable in light and dark modes over dense content, with `popover`/surface token pairs and visible focus rings.
3. Changed primitives preserve behavior, ARIA semantics, keyboard behavior, disabled states, loading/empty states, and stable dimensions.
4. Colocated tests and/or Storybook stories cover changed variants and open overlay states.
5. `shared/ui` remains domain-agnostic and does not import context, view, API, query, or domain modules.

**Verification:**

- `pnpm --filter @jobhunter/web test`
- `pnpm --filter @jobhunter/web test-d` if primitive prop/export types change
- `pnpm web:storybook:build`
- `pnpm web:storybook:test` where changed stories are covered
- Targeted browser smoke for open overlays and keyboard focus in light/dark

**Plans:** 4/5 plans executed
Plans:
**Wave 1**

- [x] 07-01-PLAN.md - Repair DataTable and toast production primitive accessibility defects with tests and backlog cleanup.
- [x] 07-02-PLAN.md - Add data-grid and table-pager behavior/state coverage for dense table focus, filters, sorting, and pagination.
- [x] 07-03-PLAN.md - Harden overlay/menu Storybook open states for dialog, sheet, drawer, dropdown, select, popover, command, and tooltip.
- [x] 07-04-PLAN.md - Harden core action, form, state, layout, and feedback primitive Storybook states.

**Wave 2** *(blocked on Wave 1 completion)*

- [ ] 07-05-PLAN.md - Close the shared/ui boundary, run static/story verification, update QA docs, and write primitive audit evidence.

### Phase 8: Layout Chrome, Fonts, And Tabler Icons

**Goal:** The app shell and user-visible chrome adopt the preset visual language while preserving route behavior, theme/density controls, navigation meaning, and operational density.

**Depends on:** Phase 7

**Requirements:** LAYOUT-01, LAYOUT-02, LAYOUT-03, LAYOUT-04, LAYOUT-05

**Success Criteria** (what must be TRUE):

1. Topbar, nav links, brand mark, global search, density selector, theme toggle, connection status/banner, route tabs, and menu states use standard tokens and the preset's subtle translucent menu treatment without lowering readability.
2. Geist body font and JetBrains Mono heading/technical font load in Vite and Storybook with fallback stacks, and dense routes still fit in compact/regular/comfy density modes.
3. User-visible lucide imports are migrated or explicitly mapped to Tabler equivalents; icon-only controls keep accessible names and stable dimensions.
4. Navigation, route search params, loaders, mutations, theme persistence, density persistence, and local-first safety behavior are unchanged.
5. Topbar/menu surfaces remain readable over Jobs, Apply Review, artifact/PDF, and dark-mode surfaces.

**Verification:**

- `pnpm web:check`
- `pnpm web:build`
- `pnpm --filter @jobhunter/web test`
- Icon import audit: `rg "lucide-react|@tabler/icons-react" apps/web/src apps/web/package.json`
- Browser smoke for topbar/nav/theme/density in light/dark and compact/regular/comfy modes

**Plans:** Create with `$gsd-plan-phase 8`.

### Phase 9: Domain And Status Surface Migration

**Goal:** JobHunter's domain states remain semantically distinct after the token migration, with typed tone helpers or explicit variant maps preserving product meaning.

**Depends on:** Phase 8

**Requirements:** STATUS-01, STATUS-02, STATUS-03, STATUS-04, STATUS-05

**Success Criteria** (what must be TRUE):

1. Pipeline stage states, score tiers, artifact statuses, apply statuses, connection statuses, discovery/source health, dashboard funnel/KPI tones, audit warnings, stale states, missing states, blocked states, running states, and failed states remain visually distinguishable in light and dark themes.
2. Context-owned tone helpers or explicit variant maps remain the source of domain-to-visual mapping; no context defines global token variables or relies on unscannable dynamic Tailwind utility strings.
3. Stage-state parity and status fixtures cover every discriminant/state arm that has user-visible styling.
4. Chart/data-series tokens are not used as lifecycle/status colors unless the component is actually a data-series chart.
5. Tailoring inspector, apply-review, audit history, missing provenance, failed workflow, stale scoring, and destructive warning states remain readable and honest.

**Verification:**

- `pnpm --filter @jobhunter/web test`
- `pnpm --filter @jobhunter/web test-d` if discriminant/status types change
- Existing parity tests, including `every-stage-state-has-badge.test.tsx`
- Browser smoke for Dashboard, Jobs, Apply Review, Artifacts, Pipelines, and Debug status surfaces
- Legacy/dynamic class audit for status components and global status selectors

**Plans:** Create with `$gsd-plan-phase 9`.

### Phase 10: Route Visual QA + Storybook/A11y Hardening

**Goal:** The migration is proven across representative JobHunter workflows, overlays, themes, density modes, Storybook states, and accessibility gates using synthetic or seeded data only.

**Depends on:** Phase 9

**Requirements:** QA-01, QA-02, QA-03, QA-04, QA-05, QA-06

**Success Criteria** (what must be TRUE):

1. Required web checks for touched surfaces pass: typecheck, build, unit/component tests, type-level tests when applicable, Storybook/a11y where primitives/stories changed, and targeted E2E/browser smoke for route-level behavior.
2. Browser QA opens representative routes and overlays in light and dark: `/dashboard`, `/jobs`, job detail, `/artifacts`, artifact detail, `/apply-review`, `/discovery`, `/profile` or `/preferences`, `/settings`, `/runs`, `/pipelines`, and `/debug`.
3. Compact, regular, and comfy density modes are checked on table/list-heavy surfaces, with focus rings, destructive controls, forms, menus, dialogs, sheets, popovers, and select/dropdown controls visible and usable.
4. Changed Storybook stories introduce no new critical or serious axe violations; any pre-existing a11y deferral remains documented in the owning backlog.
5. QA evidence uses only synthetic or seeded data and does not expose sensitive profile/application/material/log/database/browser data.
6. QA does not run auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs unless explicitly requested by the user.

**Verification:**

- `pnpm web:check`
- `pnpm web:build`
- `pnpm --filter @jobhunter/web test`
- `pnpm web:storybook:build`
- `pnpm web:storybook:test`
- Targeted `pnpm --filter @jobhunter/web e2e` specs or documented browser QA with screenshots
- `git diff --check`

**Plans:** Create with `$gsd-plan-phase 10`.

### Phase 11: Alias And Global CSS Cleanup

**Goal:** Remove dead global CSS, obsolete config remnants, residual legacy references, and unused styling dependencies once migrated surfaces have passed semantic, visual, and accessibility checks.

**Depends on:** Phase 10

**Requirements:** CLEAN-01, CLEAN-02, CLEAN-03, CLEAN-04

**Success Criteria** (what must be TRUE):

1. Grep proves no production references remain to legacy token variables or utility names outside intentional test fixtures or migration notes.
2. Obsolete Tailwind color names, dead config references, and any residual compatibility artifacts are removed from token/config files, and removed classes have named replacements.
3. Unused icon/font dependencies are removed only after import audits prove they are no longer used.
4. Global CSS cleanup is mechanical and does not remove view-specific styling unless that styling has an implemented replacement.
5. Owning docs/configs are updated narrowly for the final shadcn token, icon, font, and QA expectations.

**Verification:**

- Legacy audit: `rg "var\\(--bg|var\\(--paper|var\\(--ink|bg-paper|text-ink|border-rule|ring-info|--danger|--warn|--ok|--info" apps/web/src apps/web/tailwind.config.ts`
- Icon/font/dependency import audit
- `pnpm web:check`
- `pnpm web:build`
- `pnpm --filter @jobhunter/web test`
- Targeted browser smoke proving cleanup did not regress light/dark/density surfaces
- `git diff --check`

**Plans:** Create with `$gsd-plan-phase 11`.

## Progress

**Execution Order:**
Phases execute in numeric order: 6 -> 7 -> 8 -> 9 -> 10 -> 11

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 6. Token Foundation + shadcn Preset Contract | 6/6 | Complete | 2026-06-10 |
| 7. Shared Primitive Token Migration | 4/5 | In Progress|  |
| 8. Layout Chrome, Fonts, And Tabler Icons | 0/? | Pending | - |
| 9. Domain And Status Surface Migration | 0/? | Pending | - |
| 10. Route Visual QA + Storybook/A11y Hardening | 0/? | Pending | - |
| 11. Alias And Global CSS Cleanup | 0/? | Pending | - |

## Coverage

| Requirement Group | Requirements | Phase |
|-------------------|--------------|-------|
| Token Foundation | TOKEN-01 through TOKEN-06 | Phase 6 |
| Shared Primitives | PRIM-01 through PRIM-05 | Phase 7 |
| Layout, Fonts, Icons | LAYOUT-01 through LAYOUT-05 | Phase 8 |
| Domain/Status Semantics | STATUS-01 through STATUS-05 | Phase 9 |
| QA and Accessibility | QA-01 through QA-06 | Phase 10 |
| Cleanup and Documentation | CLEAN-01 through CLEAN-04 | Phase 11 |

**Coverage summary:** 31 of 31 v1.1 requirements mapped. Unmapped: 0.

## Next Up

**Phase 7: Shared Primitive Token Migration** - Discuss and plan the next migration slice on top of the completed Phase 6 token foundation.

`$gsd-discuss-phase 7`

Also available: `$gsd-plan-phase 7` after the Phase 7 discussion context is complete.

---
*Roadmap created: 2026-06-09*
*Last updated: 2026-06-09 after milestone v1.1 initialization*
