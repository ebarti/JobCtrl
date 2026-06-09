# Requirements: JobHunter - shadcn standard-token migration

**Defined:** 2026-06-09
**Milestone:** v1.1 shadcn standard-token migration + preset `b3F5kqmYd8`
**Core Value:** A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.

## v1.1 Requirements

Requirements for this milestone. Each maps to exactly one roadmap phase.

### Token Foundation

- [ ] **TOKEN-01**: The web app defines shadcn standard semantic CSS variables for light and dark themes, including `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, `chart-*`, `sidebar-*`, font, and radius tokens.
- [ ] **TOKEN-02**: Tailwind 4 can generate standard shadcn utilities from the token contract via CSS-first `@theme inline` mappings while existing JobHunter utility classes continue to work during the migration.
- [ ] **TOKEN-03**: The decoded preset `b3F5kqmYd8` is represented in project config and tokens: `radix-luma`/luma style, neutral base, sky theme, amber chart palette, medium radius, Geist body font, JetBrains Mono heading/technical font, Tabler icon target, default-translucent menu, and subtle menu accent.
- [ ] **TOKEN-04**: `components.json`, TypeScript aliases, and Vite aliases support current shadcn CLI validation without moving generated components outside `apps/web/src/shared/ui`.
- [ ] **TOKEN-05**: JobHunter's persisted `[data-theme="dark"]` behavior and app-shell-scoped density behavior remain compatible with the new token contract.
- [ ] **TOKEN-06**: Temporary compatibility aliases for legacy tokens (`--bg`, `--paper`, `--ink`, `--rule`, `--info`, `--danger`, `--warn`, `--ok`, `--font`, `--mono`, `--row`) exist only as a migration bridge and are documented as temporary.

### Shared Primitives

- [ ] **PRIM-01**: Shared UI primitives use standard shadcn semantic classes for surfaces, text, borders, inputs, rings, actions, destructive states, disabled states, and muted/helper text.
- [ ] **PRIM-02**: Overlay primitives (dialog, sheet/drawer, dropdown, popover, command, select, toast, tooltip) render readable `popover`/surface tokens in light and dark themes, including focus-visible states.
- [ ] **PRIM-03**: Form, table/data-grid, card, badge, tab, checkbox, switch, skeleton, separator, and scroll-area primitives preserve behavior and accessibility while moving away from legacy color/radius/font utility names.
- [ ] **PRIM-04**: Changed primitives have colocated tests and/or Storybook states for default, hover/active, disabled, destructive, focus, loading/empty where relevant, and open overlay states.
- [ ] **PRIM-05**: Shared primitives do not gain domain-specific dependencies on scoring, pipeline, materials, apply, discovery, or view modules.

### Layout, Fonts, And Icons

- [ ] **LAYOUT-01**: App shell, topbar, navigation, global search, theme toggle, density control, connection status, tabs, and menu surfaces adopt the preset visual language without changing route behavior or user workflows.
- [ ] **LAYOUT-02**: Geist body font and JetBrains Mono heading/technical font load in the Vite app and Storybook with sensible fallbacks and without breaking dense table/list layouts.
- [ ] **LAYOUT-03**: User-visible lucide icons are migrated or explicitly mapped to Tabler equivalents without changing action meaning, accessible labels, or stable control dimensions.
- [ ] **LAYOUT-04**: Compact, regular, and comfy density modes still affect row height and dense operational scanning after the radius/font/icon changes.
- [ ] **LAYOUT-05**: Topbar/menu translucency remains readable over dense Jobs, Apply Review, PDF preview, and dark-mode surfaces.

### Domain And Status Semantics

- [ ] **STATUS-01**: Pipeline stage states, scoring tiers, artifact states, apply states, connection states, discovery/source health, dashboard funnel segments, warnings, stale states, and missing audit states remain visually distinct after migration.
- [ ] **STATUS-02**: Domain components keep typed tone helpers or explicit variant maps as the source of product meaning; they do not define global CSS variables or rely on computed Tailwind class names that Tailwind cannot scan.
- [ ] **STATUS-03**: Success, warning, info/running, destructive/failed, blocked, muted/pending, stale, skipped, canceled, and missing states meet practical contrast in light and dark themes.
- [ ] **STATUS-04**: Chart/data-series tokens are available and used only for chart/data emphasis; lifecycle/status colors are not flattened into positional `chart-*` tokens.
- [ ] **STATUS-05**: Tailoring inspector, apply-review, audit history, missing provenance, failed workflow, stale scoring, and destructive warning states remain honest and inspectable; visual polish never hides awkward data.

### QA And Accessibility

- [ ] **QA-01**: Required web checks pass for the touched surface: `pnpm web:check`, `pnpm web:build`, `pnpm --filter @jobhunter/web test`, plus `test-d`, Storybook, a11y, or E2E commands where the phase touches those surfaces.
- [ ] **QA-02**: Browser QA covers representative routes and overlays in light and dark themes: `/dashboard`, `/jobs`, job detail, `/artifacts`, artifact detail, `/apply-review`, `/discovery`, `/profile` or `/preferences`, `/settings`, `/runs`, `/pipelines`, and `/debug`.
- [ ] **QA-03**: Browser QA covers compact, regular, and comfy density for table/list-heavy views and verifies focus rings, menus, overlays, forms, and destructive controls.
- [ ] **QA-04**: Storybook a11y introduces no new critical or serious axe violations for changed primitives and stateful components; any pre-existing deferral remains documented per repo policy.
- [ ] **QA-05**: QA fixtures, screenshots, stories, and docs use synthetic or seeded data only and do not expose profile data, resumes, generated PDFs, application data, browser profiles, logs, SQLite databases, API keys, or OAuth tokens.
- [ ] **QA-06**: No QA stage runs auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs unless the user explicitly asks for that behavior.

### Cleanup And Documentation

- [ ] **CLEAN-01**: Production references to legacy token variables and legacy Tailwind utilities are grep-clean before compatibility aliases are removed.
- [ ] **CLEAN-02**: Obsolete legacy aliases, old Tailwind color names, dead global selectors, and unused icon/font dependencies are removed only after replacements are verified.
- [ ] **CLEAN-03**: Documentation and config owners are updated narrowly for final token, icon, font, script, and QA expectations where behavior changed.
- [ ] **CLEAN-04**: The final diff leaves no permanent styling API based on `--paper`, `--ink`, `--rule`, `bg-paper`, `text-ink`, `border-rule`, or `ring-info`.

## Future Requirements

Deferred to a future release. Tracked but not in the current roadmap.

### Visual System Evolution

- **THEME-01**: User-editable theme settings for color, radius, and typography.
- **VISUAL-01**: Dedicated visual-regression service such as Chromatic, Loki, Percy, or equivalent.
- **CHART-01**: Reporting/analytics charting overhaul beyond token availability.
- **MOTION-01**: Motion and microinteraction system with reduced-motion criteria.
- **REDESIGN-01**: Full information-architecture or product redesign milestone with prototypes and usability acceptance.

## Out of Scope

Explicitly excluded. Documented to prevent scope creep.

| Feature | Reason |
|---------|--------|
| New discovery, scoring, tailoring, cover-letter, apply, profile, hosted/auth, analytics, or worker workflows | This milestone is a visual-system and shared-UI infrastructure migration |
| Full product redesign or route/IA changes | The app is a dense operational tool; route-level redesign needs separate acceptance |
| Permanent compatibility aliases | Legacy token names are a bridge only; final shadcn standard token API should be canonical |
| Full uncontrolled `shadcn apply` over every primitive | Research showed it rewrites a larger surface and adds broader package changes than needed |
| Query key, API, SSE, local storage, or domain state refactors | Token migration must not become behavior migration |
| Real auto-apply/browser submission/material generation during QA | Safety rule: no generated user data or application submission without explicit request |
| User theme customization | The decoded preset is the design contract for this milestone |

## Traceability

Which phases cover which requirements. Updated during roadmap creation.

| Requirement | Phase | Status |
|-------------|-------|--------|
| TOKEN-01 | Phase 6 | Pending |
| TOKEN-02 | Phase 6 | Pending |
| TOKEN-03 | Phase 6 | Pending |
| TOKEN-04 | Phase 6 | Pending |
| TOKEN-05 | Phase 6 | Pending |
| TOKEN-06 | Phase 6 | Pending |
| PRIM-01 | Phase 7 | Pending |
| PRIM-02 | Phase 7 | Pending |
| PRIM-03 | Phase 7 | Pending |
| PRIM-04 | Phase 7 | Pending |
| PRIM-05 | Phase 7 | Pending |
| LAYOUT-01 | Phase 8 | Pending |
| LAYOUT-02 | Phase 8 | Pending |
| LAYOUT-03 | Phase 8 | Pending |
| LAYOUT-04 | Phase 8 | Pending |
| LAYOUT-05 | Phase 8 | Pending |
| STATUS-01 | Phase 9 | Pending |
| STATUS-02 | Phase 9 | Pending |
| STATUS-03 | Phase 9 | Pending |
| STATUS-04 | Phase 9 | Pending |
| STATUS-05 | Phase 9 | Pending |
| QA-01 | Phase 10 | Pending |
| QA-02 | Phase 10 | Pending |
| QA-03 | Phase 10 | Pending |
| QA-04 | Phase 10 | Pending |
| QA-05 | Phase 10 | Pending |
| QA-06 | Phase 10 | Pending |
| CLEAN-01 | Phase 11 | Pending |
| CLEAN-02 | Phase 11 | Pending |
| CLEAN-03 | Phase 11 | Pending |
| CLEAN-04 | Phase 11 | Pending |

**Coverage:**
- v1.1 requirements: 31 total
- Mapped to phases: 31
- Unmapped: 0

---
*Requirements defined: 2026-06-09*
*Last updated: 2026-06-09 after roadmap creation*
