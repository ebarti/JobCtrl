# Feature Landscape: shadcn Standard Token Migration

## Summary

This milestone should behave as a visual-system migration, not as a new JobHunter product feature. From the user's perspective, the app should still be the same local-first job-search pipeline: dashboard, jobs, job detail, artifacts, apply review, discovery, profile/preferences/settings, runs, pipelines, and debug views should preserve their navigation, data loading, forms, destructive-action safeguards, and audit surfaces. The visible change is a coherent shadcn standard-token skin based on preset `b3F5kqmYd8`: neutral base, sky theme accents, amber chart palette, medium radius, Geist body text, JetBrains Mono headings/technical labels, subtle translucent menu treatment, and Tabler iconography.

The migration is table-stakes successful only if existing workflows feel more consistent without requiring the user to relearn the app. The old custom vocabulary (`--bg`, `--paper`, `--ink`, `--rule`, `--info`, `--danger`, etc.) currently drives global CSS, Tailwind aliases, and shared primitives. The new behavior should route these surfaces through shadcn's semantic pairs (`background/foreground`, `card/card-foreground`, `popover/popover-foreground`, `primary/primary-foreground`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, `chart-*`, `sidebar-*`, `radius`) so future components inherit the same language by default.

The user-visible invariant is preservation plus polish: theme and density preferences continue to work, focus states remain obvious, status colors remain meaningful, audit/provenance displays remain honest, tables stay scannable, dialogs/drawers/menus remain keyboard-accessible, and local-first safety is unchanged. No new job pipeline, tailoring, apply, account, hosted, or analytics capabilities belong in this milestone.

## Table Stakes

| Capability | Expected user-visible behavior | Acceptance shape |
| --- | --- | --- |
| Standard semantic token coverage | Every visible surface uses the same light/dark token system. Backgrounds, cards, popovers, form controls, focus rings, selected rows, hover states, destructive actions, and chart colors look intentional instead of stitched together from old custom aliases. | CSS and primitives expose shadcn standard tokens in `globals.css` / `tokens.css`; shared UI components use semantic utilities such as `bg-background`, `text-foreground`, `bg-card`, `border-border`, `ring-ring`, `bg-primary`, `bg-accent`, and `text-muted-foreground` rather than app-specific color aliases. |
| Preset fidelity | The app visually reflects the preset: neutral base, sky action/accent language, amber chart emphasis, medium radius, Geist body font, JetBrains Mono for headings/technical display, subtle translucent menu treatment, and Tabler icons. | Token values, font imports/fallbacks, radius scale, chart palette, menu/nav styling, and icon library mapping are represented in the actual web app, not only in documentation. |
| Workflow preservation | Dashboard KPIs, jobs search/filter/sort/detail, artifacts preview/detail, apply review, discovery controls, profile/preferences/settings forms, runs/pipelines, and debug tables behave as before. | No route, loader, mutation, URL search-param behavior, form state, or SSE invalidation behavior changes as part of this migration. Existing tests for touched surfaces continue to pass. |
| Light/dark theme continuity | Theme toggle remains a persisted user preference and both themes are complete. Dark mode must not be a partial inversion with unreadable muted text, missing borders, invisible focus rings, or mismatched popovers. | `data-theme` / dark selector behavior remains compatible with the existing preference store and Tailwind configuration. Browser smoke covers light and dark on representative routes. |
| Density continuity | Compact, regular, and comfy density still alter row height and scanning density without changing route behavior or hiding controls. | The existing topbar density control remains visible and functional. Token changes do not accidentally hard-code table/list heights that defeat `--row` or its successor. |
| Navigation/menu polish | Topbar, nav links, global search, density select, theme toggle, and connection status keep their position and meaning while adopting the preset's translucent, subtle menu style. Active and hover states are visible but restrained. | The header is readable over app backgrounds in both themes; active route state is obvious; connection error banners remain high contrast. |
| Action hierarchy | Primary, secondary, ghost, outline, link, and destructive actions remain distinguishable. Dangerous actions are still visually and semantically destructive. | Button variants map to standard shadcn tokens. Destructive actions use `destructive` semantics rather than generic red aliases. |
| Status semantics | Pipeline/status indicators preserve meaning for success, warning, running/info, failed/destructive, pending/muted, and neutral states. | Status components may introduce local semantic tokens only where shadcn's core set is insufficient, but their names must reflect domain meaning and be mapped through `@theme inline` / CSS variables rather than ad hoc hex colors. |
| Form readability | Inputs, selects, textareas, checkboxes, tabs, dialogs, drawers, sheets, dropdowns, popovers, command palette, toasts, tables, badges, cards, skeletons, and empty states look like one component family. | Shared primitives in `apps/web/src/shared/ui/` are updated first, then route/view CSS follows. Focus-visible and disabled states remain clear. |
| Audit surface integrity | Tailoring rationale, employer analysis, bullet provenance, missing-audit states, apply review evidence, and artifact detail surfaces remain inspectable and honest. The migration must not hide awkward data by making it low contrast or moving it out of view. | Browser QA includes the materials/apply-review inspector states named in local QA. Missing data states remain explicit (`not recorded`, `none recorded`, etc.) where already required. |
| Responsive stability | Existing dense operational layouts continue to fit on desktop and narrow viewports. Token changes cannot introduce oversized padding, huge heading scale, or rounded-card marketing treatment that breaks repeated-use workflows. | Visual/browser smoke checks representative desktop and mobile/narrow widths for topbar wrapping, tables, drawers, apply-review split panes, forms, and artifact previews. |
| Accessibility baseline | Keyboard focus, aria labels, contrast, dialogs/drawers focus handling, menu selection, and visible disabled states stay at least as good as current shadcn/Radix-backed primitives. | Existing a11y tests and Storybook a11y gate remain green. Any pre-existing deferral remains documented; no new critical/serious axe issue is introduced. |
| Icon consistency | Existing lucide glyphs are replaced or intentionally mapped to Tabler equivalents without changing action meaning. A user should see one icon language, not a mixed library. | Every visible icon import is audited. Controls keep labels/aria labels where needed. Missing Tabler equivalents are documented before deferring. |

## User-Visible Acceptance

| Category | Acceptance criteria |
| --- | --- |
| App still feels like JobHunter | Brand, topbar, navigation, dense tables, operational cards, pipeline/status language, and audit-heavy views remain recognizable. The migration should not introduce a landing-page, marketing dashboard, decorative hero, or new IA. |
| Theme parity | Light and dark modes both render complete token sets for app shell, cards, forms, popovers, dialogs, drawers, tabs, badges, toasts, tables, charts/funnels, and focus rings. No component falls back to browser default blue/black/white. |
| Preset surface proof | A reviewer can point to the preset in the app: sky primary/accent, amber chart/funnel emphasis, neutral base surfaces, medium radii, Geist/JetBrains typography, subtle translucent menu/nav treatment, and Tabler icons. |
| Route coverage | At minimum, visual/browser QA should open `/dashboard`, `/jobs`, a job detail route/drawer, `/artifacts`, an artifact detail route/panel, `/apply-review`, `/discovery`, `/profile` or `/preferences`, `/settings`, `/runs`, `/pipelines`, and `/debug`. |
| Critical workflow no-regression | Search, filters, sorting, pagination, drawers, route params/search params, form edit/save/undo/autosave, theme toggle, density toggle, apply-review decisions, artifact preview, and pipeline/run status displays continue to work. |
| Safety no-regression | The migration must not start apply automation, auto-submit, browser submission, mailbox scanning, real generation, destructive profile/database actions, or worker-backed jobs during QA unless explicitly requested. |
| Readability | Body text, dense table cells, small metadata, muted helper text, status chips, warning/destructive text, and code/technical labels meet practical contrast in both themes. Muted text should be subdued, not illegible. |
| Focus and keyboard behavior | Keyboard users can tab through topbar controls, menus, filters, table controls, dialogs, drawers, forms, and destructive confirmations with visible focus. |
| Empty/loading/error states | Skeletons, empty states, errors, connection warnings, disabled states, and queued/in-flight states adopt the same token language and remain understandable. |
| Data honesty | UI polish must not reduce visibility of audit warnings, missing provenance, failed workflow state, stale scoring, hidden/deleted job state, or destructive warnings. |

## Developer Experience Acceptance

| Category | Acceptance criteria |
| --- | --- |
| Token vocabulary | The canonical styling vocabulary is shadcn standard semantic tokens. New feature code should not introduce new `--paper`, `--ink`, `--rule`, `--info`, `--danger`, `bg-paper`, `text-ink`, `border-rule`, or `ring-info` usage. |
| Migration strategy | Update shared primitives and token definitions before one-off view CSS. Keep any temporary compatibility aliases narrow and remove them by the milestone exit unless explicitly documented. |
| Tailwind integration | Tailwind 4 exposes standard shadcn token utilities through the project CSS/Tailwind setup. Radius scale derives from `--radius`; chart and sidebar/menu tokens are available even if current views use only a subset. |
| Component ownership | shadcn components remain copied and owned under `apps/web/src/shared/ui/`, consistent with the target architecture. The migration should not add a runtime component framework or CSS-in-JS layer. |
| Icon migration | Replace `lucide-react` imports with the selected Tabler package only after mapping all current icons and updating tests/stories. Do not leave user-facing mixed icon sets as the final state. |
| Fonts | Geist and JetBrains Mono are loaded or locally configured in a way that works in the Vite app and Storybook/build output. Fallback stacks remain sensible if font loading fails. |
| Tests | Run at least `pnpm web:check`, `pnpm web:build`, `pnpm --filter @jobhunter/web test`, and targeted Storybook/a11y or E2E checks for changed visual primitives and routes. Broader `pnpm test` is the default if the implementation touches shared behavior beyond CSS/primitives. |
| Visual QA | Capture browser screenshots or equivalent reviewer-visible evidence in light and dark mode across representative routes. Include compact and comfy density checks for table/list-heavy routes. |
| Storybook | Update primitive and affected component stories so future visual review uses the new token system. Storybook a11y remains the gate for critical/serious violations. |
| Documentation | If `components.json`, package dependencies, scripts, icon library, token names, or QA expectations change, update the owning docs/files narrowly. If the implementation is purely internal and no docs change is warranted, state that in the PR description. |
| Reviewability | The diff should make the token migration obvious: centralized token changes, primitive class changes, icon import changes, and limited view CSS cleanup. Avoid mixing product-feature changes into the same PR. |

## Deferred/Out of Scope

| Deferred item | Why out of scope | Later acceptance trigger |
| --- | --- | --- |
| New product workflows | This is a design-system migration. It should not add new discovery, scoring, tailoring, cover-letter, apply, profile, or pipeline functionality. | A separate product milestone with domain requirements and tests. |
| Full redesign or information architecture change | The current app is an operational tool with dense repeated-use views. A full IA redesign would create validation risk unrelated to token migration. | A dedicated UX milestone with route-level prototypes and usability acceptance. |
| Hosted/multi-tenant/auth UI | Project context remains local-first single-user. Token work should keep hosted seams unblocked but not build hosted surfaces. | Hosted milestone that activates auth/tenant requirements. |
| Visual regression infrastructure | Useful, but not required to perform the migration. Storybook and Playwright/browser screenshots are enough for this milestone. | Add Chromatic/Loki/Percy only when visual drift becomes recurring review cost. |
| Advanced user theme customization | The preset is the design contract. Letting users edit theme colors/fonts/radius would undermine migration acceptance. | A future personalization/settings milestone. |
| Component inventory expansion | Do not add large new shadcn blocks or components merely because they exist. | Add when a product feature needs that primitive. |
| Charting overhaul | Amber chart tokens should be available and used where existing chart/funnel-like surfaces need them, but new chart libraries or analytics dashboards are out of scope. | A reporting/analytics milestone. |
| Motion/animation system | Token migration does not require new transitions, page animations, or microinteraction design. | A later polish milestone with accessibility and reduced-motion criteria. |
| Tailoring inspector product changes | Inspector readability must be preserved, but employer analysis/provenance behavior is governed by the active product milestone, not by token migration. | The resume-tailoring milestone's auditability phases. |
| Compatibility shims as permanent API | Temporary old-token aliases may help cut over safely, but they should not become the new public styling API. | Only keep aliases if a follow-up phase explicitly owns their removal schedule. |

## Evidence

### Repo Evidence

| Source | Evidence used | Confidence |
| --- | --- | --- |
| `.planning/PROJECT.md:5-9` | JobHunter's core user value is local-first resume tailoring with inspectable trust; token migration must not distract from that product behavior. | High |
| `.planning/PROJECT.md:17-28` | Existing discovery, enrichment, scoring, tailoring, cover, apply, PDF, projection/SSE, profile, materials/apply-review/artifacts surfaces are already shipped and must be preserved. | High |
| `.planning/PROJECT.md:56-60` | Inspector UI must expose employer analysis and per-bullet provenance without masking missing audit data; visual polish cannot hide audit facts. | High |
| `.planning/PROJECT.md:81-85` | Existing stack and local-first boundaries constrain the migration: React/Vite/Tailwind web, no new runtime without justification, no exposure of sensitive local data. | High |
| `docs/frontend-target.md:1025-1057` | shadcn/ui is the chosen primitive layer; components are copied/owned locally, Radix supplies accessibility behavior, and the existing target named lucide icons before this preset's Tabler change. | High |
| `docs/frontend-target.md:1059-1068` | Tailwind and CSS-variable-driven theme switching are the frontend styling target. | High |
| `docs/architecture.md:440-456` | Current frontend stack: Vite, React 19, Tailwind 4 tokens, shadcn/Radix primitives, TanStack Router/Query/Table/Form, Zustand, Vitest, Playwright, Storybook/a11y. | High |
| `docs/local-reliability-qa.md:3-32` | React UI changes require local QA commands and browser smoke against API/web or full `pnpm dev` stack. | High |
| `docs/local-reliability-qa.md:121-128` | Frontend coverage includes Vitest/RTL/MSW, type-level tests, Playwright E2E, and a11y suites. | High |
| `docs/local-reliability-qa.md:158-178` | Materials/apply-review inspector smoke requires honest missing-data rendering and preservation of last accepted artifact/provenance. | High |
| `apps/web/src/styles/tokens.css:1-42` | Current token file uses custom light/dark variables rather than shadcn standard semantic names. | High |
| `apps/web/src/styles/globals.css:1-33` | Global CSS imports Tailwind and current tokens, then applies old `--bg`, `--ink`, and `--info` values to body/focus. | High |
| `apps/web/src/styles/globals.css:42-120` | Topbar, brand, nav, search, banners, and tabs are styled through old custom variables; these are user-visible migration targets. | High |
| `apps/web/tailwind.config.ts:3-25` | Tailwind currently exposes old aliases (`bg`, `paper`, `ink`, `rule`, `danger`, `info`) and font aliases from `--font`/`--mono`. | High |
| `apps/web/components.json:1-20` | shadcn config already uses CSS variables and neutral base color, but currently has style `default` and icon library `lucide`; preset migration must reconcile these with the new standard/preset. | High |
| `apps/web/src/shared/ui/button.tsx:7-18` | Button variants currently use old aliases such as `bg-ink`, `text-paper`, `bg-danger`, `border-rule-2`, `text-info`. | High |
| `apps/web/src/shared/ui/card.tsx:5-37` | Card primitives currently use old aliases such as `border-rule`, `bg-paper`, `text-ink`, and `text-muted`. | High |
| `apps/web/src/shared/layout/Topbar.tsx:10-49` | Theme, density, global search, navigation, and connection status are persistent top-level user controls that must continue to work. | High |
| `apps/web/src/routes/*.tsx` | Routes use TanStack Router loaders and view composers; token migration should not change route loaders, query keys, URL state, or mutation behavior. | High |

### External Sources

| Source URL | Evidence used | Confidence |
| --- | --- | --- |
| https://ui.shadcn.com/docs/theming | shadcn recommends CSS variables for theming and defines standard semantic tokens used by components: background/foreground, card, popover, primary, secondary, muted, accent, destructive, border, input, ring, chart tokens, sidebar tokens, and radius scale. | High - official documentation, fetched 2026-06-09 |
| https://ui.shadcn.com/docs/components-json | `components.json` controls style, Tailwind CSS location, base color, CSS-variable generation, aliases, and icon library; the docs note some initialization choices are effectively not casual runtime switches. | High - official documentation, fetched 2026-06-09 |
| https://ui.shadcn.com/create | Official visual preset/create surface for previewing theme choices. The fetched text shell was sparse, so project-provided decoded preset values are treated as the source of truth for `b3F5kqmYd8`. | Medium - official page reachable, but decoded preset values came from milestone context |

### Tooling Note

`gsd-tools` was not available in this shell (`zsh: command not found: gsd-tools`), so the research-plan/cache/confidence seam could not be executed. Confidence above is based on local repo files plus current official shadcn documentation.
