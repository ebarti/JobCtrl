# JobHunter - Grounded Resume Tailoring

## What This Is

JobHunter is a local-first job-search automation app with a TypeScript API, React/Vite web app, and Python Temporal worker. It runs a discovery -> enrichment -> scoring -> tailoring -> cover -> apply pipeline over local SQLite and generated artifacts, with resume tailoring treated as a trust-first workflow: generated materials must remain grounded, inspectable, and reviewable before any apply action.

## Core Value

A user can trust every line of a tailored resume because each bullet traces visibly to a real profile fact and a specific job requirement, with the reasoning and transform rule available for review.

## Current Milestone: v1.1 shadcn standard-token migration + preset b3F5kqmYd8

**Goal:** Move JobHunter's web UI from its legacy custom token layer to the current shadcn semantic CSS-variable token system using preset `b3F5kqmYd8`, without regressing local-first product workflows or audit-heavy surfaces.

**Target features:**
- Apply the decoded shadcn preset: `radix-luma` / luma style, neutral base, sky action/accent theme, amber chart palette, medium radius, Geist body font, JetBrains Mono heading/technical font, Tabler icons, default-translucent menu treatment, and subtle menu accent.
- Establish shadcn standard semantic tokens as the canonical styling API: `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent`, `destructive`, `border`, `input`, `ring`, chart tokens, sidebar/menu tokens, font tokens, and radius scale.
- Preserve compatibility while migrating: keep temporary aliases for legacy `--bg`, `--paper`, `--ink`, `--rule`, status colors, fonts, and density until shared primitives, layout chrome, views, and domain status components are migrated.
- Update shared UI primitives, app shell/navigation, forms, overlays, tables, status components, charts/status visual semantics, Storybook, and QA coverage so the migration is proven in light/dark themes and density modes.

## Requirements

### Validated

<!-- Shipped and relied upon. -->

- [x] Discovery pipeline scrapes jobs from external boards (python-jobspy) - existing.
- [x] Enrichment verifies and snapshots postings - existing.
- [x] Scoring evaluates job fit with LLM plus scoring policy - existing.
- [x] Resume tailoring stage (`tailor`) generates resume artifacts and audit evidence via the Materials context - existing.
- [x] Cover-letter generation stage (`cover`) - existing.
- [x] Apply stage runs browser/agent submission automation when explicitly invoked - existing.
- [x] JSON-RPC tailoring actions: `tailor_job`, `retailor_job`, `retailor_current_policy` - existing.
- [x] PDF rendering of generated materials via LaTeX and Playwright HTML paths - existing.
- [x] Projection-backed read model, SSE realtime, and audit/event backbone (`job_events`) - existing.
- [x] Profile import and canonical profile data store - existing.
- [x] Materials, apply-review, and artifacts web surfaces - existing.
- [x] v1.0 grounded resume tailoring milestone - employer analysis, per-bullet provenance, granular controls, voice pass, canonical read model, generate-materials wiring, and inspector UI verified on 2026-06-09. See `.planning/MILESTONE-ACCEPTANCE.md`.

### Active

<!-- Current milestone scope. Hypotheses until shipped and validated. -->

**Pillar A - Token foundation and preset fidelity**

- [ ] The web app exposes shadcn standard semantic CSS variables for light and dark themes, mapped through Tailwind 4 `@theme inline`.
- [ ] The decoded preset `b3F5kqmYd8` is represented in real app styling: neutral base, sky accents, amber chart/data tokens, medium radius, Geist body text, JetBrains Mono headings/technical labels, translucent menu treatment, subtle menu accent, and Tabler icons.
- [ ] Legacy JobHunter token names remain as temporary aliases only while migrating, then are removed when production references are grep-clean.

**Pillar B - Shared primitives and layout chrome**

- [ ] Shared UI primitives use standard shadcn semantic utilities for surfaces, text, borders, inputs, focus rings, overlays, actions, disabled states, and destructive states.
- [ ] App shell, topbar, nav, global search, connection status, theme toggle, density control, menus, tabs, and route chrome preserve current workflow behavior while adopting the preset visual language.
- [ ] Iconography migrates from lucide to Tabler where user-visible, without changing action meaning, accessible names, or stable dimensions.

**Pillar C - Domain/status visual semantics**

- [ ] Pipeline, scoring, materials, apply, discovery, dashboard, audit, warning, stale, missing, success, blocked, running, and failed states remain semantically distinct after the token migration.
- [ ] Chart/data tokens are used for data-series styling only; lifecycle/status colors keep explicit domain meaning.
- [ ] Audit and apply-review surfaces remain readable and honest in light/dark modes; missing or embarrassing data is never hidden by low contrast or layout changes.

**Pillar D - QA, a11y, and cleanup**

- [ ] Storybook, component tests, a11y checks, browser smoke, and route-level QA prove the migration across representative JobHunter workflows, light/dark themes, and compact/regular/comfy densities.
- [ ] Visual QA uses synthetic or seeded data only and does not run auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs unless explicitly requested.
- [ ] Documentation and config surfaces that own the behavior (`components.json`, `package.json`, `docs/local-reliability-qa.md`, `docs/frontend-target.md`, and PR notes) reflect the final token, icon, font, and QA expectations.

### Out of Scope

<!-- Explicit boundaries with reasoning to prevent re-adding. -->

- New discovery, scoring, tailoring, cover-letter, apply, profile, hosted/auth, analytics, or worker-backed product workflows - this is a visual-system migration.
- Full product redesign, route/information-architecture changes, marketing dashboard treatment, or landing-page work - JobHunter remains a dense operational tool.
- Permanent compatibility shims for `--paper`, `--ink`, `--rule`, `bg-paper`, `text-ink`, `border-rule`, `ring-info`, or legacy status aliases - temporary bridge only.
- Regenerating all shadcn primitives through an uncontrolled full `shadcn apply` - research showed full apply rewrites a broader component surface than this milestone needs.
- Replacing domain state models, query keys, SSE invalidation, API contracts, local storage, ports, or bounded-context ownership - token work must not become behavior refactoring.
- Visual regression platform rollout such as Chromatic, Loki, or Percy - useful later, but targeted Storybook/a11y/browser proof is enough for this milestone.
- User-editable theme customization - the preset is the design contract for this milestone.

## Context

- **Current web stack:** React 19, Vite 7, Tailwind CSS 4, `@tailwindcss/vite`, shadcn/Radix copied primitives under `apps/web/src/shared/ui`, TanStack Router/Query/Table/Form, Zustand UI preferences, Vitest, Playwright, Storybook, and axe-based accessibility tests.
- **Current token state:** `apps/web/src/styles/tokens.css` defines bespoke variables such as `--bg`, `--paper`, `--ink`, `--rule`, `--danger`, `--warn`, `--ok`, and `--info`. `apps/web/tailwind.config.ts` exposes those names as utility colors. `apps/web/src/styles/globals.css` has a large blast radius because it owns app chrome, table, dashboard, drawer, apply-review, profile, and status styles.
- **shadcn baseline:** `apps/web/components.json` already enables CSS variables, neutral base color, TypeScript, and aliases to `@/shared/ui`, `@/shared/lib`, and `@/shared/hooks`, but it still uses `style: "default"`, `tailwind.config.ts`, and `iconLibrary: "lucide"`.
- **Preset source:** `pnpm dlx shadcn@latest preset decode b3F5kqmYd8 --json` decoded to default-translucent menu, subtle menu accent, medium radius, Geist body font, Tabler icons, sky theme, neutral base color, luma style, amber chart color, and JetBrains Mono heading font.
- **Official docs baseline:** Current shadcn theming recommends CSS variables, semantic background/foreground token pairs, Tailwind 4 CSS-first `@theme inline`, chart/sidebar/radius tokens, and `components.json` with Tailwind v4 config left blank as the final target.
- **Architecture boundary:** The token contract belongs to the shared styling boundary, not bounded-context data. Contexts may map domain states to visual variants, but they do not own global token definitions.

## Constraints

- **Architecture:** Follow the frontend target architecture: views compose context components; contexts do not import views; shared UI owns primitives; operations owns read-side hooks and invalidation. Token work must not touch query keys, mutations, API contracts, SSE event handling, or domain state unless explicitly scoped by a phase.
- **Local-first safety:** Do not expose profile data, resumes, generated PDFs, browser profiles, logs, SQLite databases, API keys, OAuth tokens, or application artifacts in screenshots, stories, fixtures, docs, or commits.
- **Dark mode:** Preserve JobHunter's existing persisted `[data-theme="dark"]` model unless a phase explicitly migrates `ThemeProvider`; do not split styling between `.dark` and `[data-theme]`.
- **Density:** Preserve compact/regular/comfy density behavior and app-shell-scoped `data-density`; do not let font, radius, icon, or spacing changes break dense table/list workflows.
- **QA:** User-facing visual migration requires product-path QA, not only typecheck. At minimum use web typecheck, build, relevant tests, Storybook/a11y where primitives change, and browser smoke in light/dark and density modes.
- **Scope discipline:** Keep changes as small as practical per phase. Do not combine product behavior changes, backend changes, or worker execution with token migration.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Treat shadcn tokens as frontend shared infrastructure, not domain data | Preserves bounded-context and view/composer architecture | - Pending |
| Preserve `[data-theme="dark"]` during the migration | Existing theme store/provider already uses this selector; switching to `.dark` is unnecessary risk | - Pending |
| Use compatibility aliases before cleanup | The global CSS and shared primitives still depend on legacy token names; hard cutover would create broad visual regressions | - Pending |
| Avoid uncontrolled full `shadcn apply` | Research showed full apply rewrites many UI files and broadens package scope beyond a standard-token migration | - Pending |
| Keep domain status semantics explicit | JobHunter status colors encode product meaning; generic shadcn tokens alone are not enough | - Pending |
| Make browser QA a release gate for user-visible visual phases | Token changes can pass tests while breaking readability, focus, overlays, or dense layouts | - Pending |
| v1.0 grounded resume tailoring architecture is validated | Milestone verification on 2026-06-09 showed all 26 requirements mapped and verified | Good |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? -> Move to Out of Scope with reason.
2. Requirements validated? -> Move to Validated with phase reference.
3. New requirements emerged? -> Add to Active.
4. Decisions to log? -> Add to Key Decisions.
5. "What This Is" still accurate? -> Update if drifted.

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections.
2. Core Value check - still the right priority?
3. Audit Out of Scope - reasons still valid?
4. Update Context with current state.

---
*Last updated: 2026-06-09 after starting milestone v1.1*
