# Phase 08: Layout Chrome, Fonts, And Tabler Icons - Research

**Researched:** 2026-06-10
**Domain:** JobHunter web app shell, theme/density persistence, typography, and icon migration [VERIFIED: .planning/ROADMAP.md; apps/web/src/shared/layout/Topbar.tsx]
**Confidence:** HIGH for repo behavior and local package metadata; LOW for any unverified external ecosystem generalization [VERIFIED: codebase grep; VERIFIED: local node module metadata]

<user_constraints>
## User Constraints (from CONTEXT.md)

All constraints in this section are copied from `.planning/phases/08-layout-chrome-fonts-and-tabler-icons/08-CONTEXT.md`. [CITED: .planning/phases/08-layout-chrome-fonts-and-tabler-icons/08-CONTEXT.md]

### Locked Decisions

#### Shell And Navigation Shape
- **D-01:** Preserve the existing `AppShell` structure: one topbar, existing main navigation labels/routes, global search, density selector, theme toggle, and connection status group. Do not redesign the information architecture or create new route groupings.
- **D-02:** Apply the preset chrome through standard shadcn semantic tokens and the decoded default-translucent/subtle menu treatment. Improve readability and polish without lowering the dense operational character of the app.
- **D-03:** Keep the brand small and functional. The brand mark may adopt preset radius/font/token styling, but it should remain a first-line app-shell affordance, not a marketing hero or large decorative element.
- **D-04:** Route tabs such as settings/profile wizard steps should be treated as chrome for token and focus consistency, but their navigation meaning and URL behavior must not change.

#### Typography And Density
- **D-05:** Keep Geist as the body font and JetBrains Mono as the technical/heading/mono font, using the existing Fontsource imports from Phase 6. Verify Vite and Storybook both load the same stacks.
- **D-06:** Preserve the existing persisted theme and density store (`jh:ui-preferences`) and the pre-paint theme script in `apps/web/index.html`. Do not change storage keys or persistence shape unless a test proves a migration is necessary.
- **D-07:** Keep density scoped to `.app-shell[data-density]` and `--jh-row-height`. Compact, regular, and comfy modes must still fit dense table/list routes after font, radius, and icon updates.
- **D-08:** Do not rely on experimental style-query-only density behavior. Plain data attributes and CSS variables remain the baseline seam.

#### Icon Migration
- **D-09:** Migrate user-visible lucide icons to Tabler equivalents wherever practical in Phase 8. `components.json` already targets Tabler for future generated output; this phase should make visible app chrome and controls match that target.
- **D-10:** Preserve icon-only control accessible names, hit targets, stable dimensions, and action meaning. Decorative icons stay `aria-hidden`.
- **D-11:** If a lucide icon cannot be replaced safely in this phase, record an explicit mapping/deferral in the Phase 8 summary or audit. Do not leave silent mixed icon libraries in user-visible chrome.
- **D-12:** Shared primitive internal icons may be migrated when they are user-visible control affordances, but do not rewrite primitive behavior while changing icons.

#### Behavior And Safety
- **D-13:** Global search must continue navigating to `/jobs` with `q` and `page: 1` on Enter. Topbar/nav Link active state, route search params, loaders, mutations, theme persistence, density persistence, SSE status, and local-first safety behavior must remain unchanged.
- **D-14:** Connection status and worker/unavailable banners remain honest operational signals. This phase can improve chrome readability but must not hide, rename, or suppress warning/offline states.
- **D-15:** Use synthetic or seeded QA only. Do not run auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs.

#### Verification Contract
- **D-16:** Phase 8 verification must include `corepack pnpm web:check`, `corepack pnpm web:build`, targeted tests for changed shell/provider/icon behavior, icon import audit (`lucide-react` / `@tabler/icons-react`), and `git diff --check`.
- **D-17:** Browser proof is required for the app shell: verify topbar/nav/global search/theme/density/connection chrome in light and dark themes and compact/regular/comfy density modes using seeded/synthetic local state.
- **D-18:** Storybook build/test should run if shared stories or route/view stories are changed. The existing Storybook Chromium MachPort sandbox failure may require the same browser-launch escalation used in Phase 7.

### the agent's Discretion
- The planner may choose the exact Tabler icon equivalents, class names, and CSS organization as long as meaning, accessible names, and stable dimensions are preserved.
- The planner may split shell styling, icon migration, and browser proof into separate plans based on dependency and verification cost.
- The planner may add narrow tests around `Topbar`, `ThemeToggle`, `ConnectionStatusPill`, or pre-paint/persistence behavior if they are the best way to prove no behavior changed.

### Deferred Ideas (OUT OF SCOPE)
- Domain/status tone remapping remains Phase 9.
- Route-wide light/dark/density visual QA across all representative routes remains Phase 10.
- Final global CSS cleanup and unused dependency removal remains Phase 11.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| LAYOUT-01 | App shell, topbar, navigation, global search, theme toggle, density control, connection status, tabs, and menu surfaces adopt the preset visual language without changing route behavior or user workflows. | Shell seams are localized to `AppShell`, `Topbar`, `NavBar`, `ThemeToggle`, `ConnectionStatusPill`, and selected `.tab`/tabs/global CSS selectors. [VERIFIED: apps/web/src/shared/layout/*.tsx; apps/web/src/styles/globals.css] |
| LAYOUT-02 | Geist body font and JetBrains Mono heading/technical font load in the Vite app and Storybook with sensible fallbacks and without breaking dense table/list layouts. | Fontsource imports, token font variables, Tailwind `@theme inline` mappings, and Storybook preview global CSS already exist. [VERIFIED: apps/web/src/styles/globals.css; apps/web/src/styles/tokens.css; apps/web/.storybook/preview.tsx] |
| LAYOUT-03 | User-visible lucide icons are migrated or explicitly mapped to Tabler equivalents without changing action meaning, accessible labels, or stable control dimensions. | Current lucide imports and local Tabler exports were audited; shell/chrome and shared affordance priorities are listed below. [VERIFIED: rg lucide-react; VERIFIED: local @tabler/icons-react import] |
| LAYOUT-04 | Compact, regular, and comfy density modes still affect row height and dense operational scanning after radius/font/icon changes. | `.app-shell[data-density]` sets `--jh-row-height` to 32px, 40px, and 48px; existing E2E already proves the seam. [VERIFIED: apps/web/src/styles/tokens.css; apps/web/e2e/tests/token-foundation.spec.ts] |
| LAYOUT-05 | Topbar/menu translucency remains readable over dense Jobs, Apply Review, PDF preview, and dark-mode surfaces. | Existing topbar/menu CSS is global and route-agnostic; browser proof must cover `/jobs`, `/apply-review`, and artifact/PDF-adjacent surfaces with synthetic data where practical. [VERIFIED: apps/web/src/styles/globals.css; CITED: 08-UI-SPEC.md] |
</phase_requirements>

## Summary

Phase 8 should be a targeted shell/chrome migration, not a product redesign. [VERIFIED: .planning/ROADMAP.md; CITED: 08-CONTEXT.md] The app-shell behavior seams are already concentrated: `AppShell` applies `.app-shell` and `data-density`; `Topbar` owns brand, nav, global search, density, theme, and connection composition; `NavBar` owns route labels and active state; `ThemeProvider` and `index.html` own runtime and pre-paint theme application; `ConnectionStatusPill` owns SSE/worker operational status. [VERIFIED: apps/web/src/shared/layout/AppShell.tsx; apps/web/src/shared/layout/Topbar.tsx; apps/web/src/shared/layout/NavBar.tsx; apps/web/src/shared/providers/ThemeProvider.tsx; apps/web/index.html; apps/web/src/shared/layout/ConnectionStatusPill.tsx]

The highest-value implementation path is to keep route and state code stable, retokenize shell/menu/tab chrome in `globals.css`, migrate shell and obvious shared affordance lucide icons to local Tabler exports, and add focused tests/browser proof around the unchanged behavior. [VERIFIED: codebase grep; CITED: 08-UI-SPEC.md] Domain/status icon controls can be mapped where obvious, but status semantic remapping and final `lucide-react` dependency removal belong to Phase 9 and Phase 11 respectively unless imports reach zero safely. [CITED: .planning/ROADMAP.md; CITED: 08-CONTEXT.md]

**Primary recommendation:** Split Phase 8 into four plans: shell chrome tokens and fonts, Tabler icon migration/audit, behavior tests, and browser proof/QA evidence. [VERIFIED: phase scope files; ASSUMED: plan granularity is best kept to four reviewable chunks]

## Project Constraints (from AGENTS.md)

- Work in a dedicated worktree and never edit code on `main`; current target worktree branch is `plan/shadcn-standard-token-milestone-20260609`. [VERIFIED: git status; CITED: AGENTS.md]
- Use `pnpm dev` for full local stack only when product QA needs it; do not run auto-apply, browser submission, destructive profile/database actions, or application-submitting commands without explicit user instruction. [CITED: AGENTS.md]
- For frontend changes, respect bounded contexts, view composer rules, TanStack state ownership, SSE invalidation router ownership, and port usage. [CITED: AGENTS.md; CITED: docs/frontend-target.md]
- User-facing UI/API/product-flow changes need product-path QA, not only unit tests. [CITED: AGENTS.md; CITED: docs/local-reliability-qa.md]
- Sensitive data, generated artifacts, resumes, cover letters, PDFs, browser profiles, logs, SQLite databases, API keys, and OAuth tokens must not be exposed in evidence. [CITED: AGENTS.md]
- PR and commit titles must follow Conventional Commits. [CITED: AGENTS.md]
- Meaningful new capabilities require narrow owner-document updates; this phase is a visual-system migration, so docs updates are warranted only if QA expectations or public behavior documentation changes. [CITED: AGENTS.md]

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|--------------|----------------|-----------|
| App shell layout and chrome tokens | Browser / Client | Static CSS | React shell components render the structure, while `globals.css` and `tokens.css` own visual tokens and density variables. [VERIFIED: apps/web/src/shared/layout/AppShell.tsx; apps/web/src/styles/*.css] |
| Theme persistence and pre-paint | Browser / Client | Static HTML | Zustand persist stores `jh:ui-preferences`; `index.html` reads the same shape before React paints. [VERIFIED: apps/web/src/shared/stores/ui-preferences.ts; apps/web/index.html] |
| Density control | Browser / Client | Static CSS | The density selector writes Zustand state and `.app-shell[data-density]` drives `--jh-row-height`. [VERIFIED: apps/web/src/shared/layout/Topbar.tsx; apps/web/src/styles/tokens.css] |
| Navigation and global search | Browser / Client | TanStack Router | `NavBar` uses `Link`; global search uses `useNavigate` to `/jobs` with `q` and `page: 1`. [VERIFIED: apps/web/src/shared/layout/NavBar.tsx; apps/web/src/shared/layout/Topbar.tsx] |
| Connection status chrome | Browser / Client | API / Backend health query | UI reads EventStream provider status and health query, but Phase 8 must not alter SSE or health semantics. [VERIFIED: apps/web/src/shared/layout/ConnectionStatusPill.tsx; CITED: 08-CONTEXT.md] |
| Icon migration | Browser / Client | npm package metadata | User-visible React icon components should migrate from lucide to installed Tabler exports without changing controls. [VERIFIED: rg lucide-react; VERIFIED: apps/web/package.json; VERIFIED: local @tabler/icons-react import] |

## App-Shell And Chrome Surfaces To Preserve

| Surface | Current seam | Must preserve | Phase 8 styling target |
|---------|--------------|---------------|------------------------|
| Shell root | `<div className="app-shell" data-density={density}>` [VERIFIED: apps/web/src/shared/layout/AppShell.tsx] | Class name, `data-density`, and outlet structure. [CITED: 08-CONTEXT.md] | Keep density CSS variable seam and retokenize only visual shell chrome. [VERIFIED: apps/web/src/styles/tokens.css] |
| Topbar | `<header className="topbar">` composes brand, nav, search, density, theme, status. [VERIFIED: apps/web/src/shared/layout/Topbar.tsx] | Same controls and order unless CSS wrapping requires minor visual fit changes. [CITED: 08-CONTEXT.md] | Use `card`/`popover`/`border`/`muted`/`accent` tokens with readable translucent treatment. [CITED: 08-UI-SPEC.md] |
| Brand | Link to `/dashboard`, `.brand`, `.brand-mark`, visible `jh` and `jobhunter`. [VERIFIED: apps/web/src/shared/layout/Topbar.tsx] | Small functional app affordance, not hero branding. [CITED: 08-CONTEXT.md] | Use preset radius/font/token styling; keep click target stable. [CITED: 08-UI-SPEC.md] |
| Nav | Labels/routes are `Dashboard`, `Apply review`, `Jobs`, `Pipelines`, `Discovery`, `Runs`, `Debug`, `Artifacts`, `Profile`, `Preferences`, `Settings`. [VERIFIED: apps/web/src/shared/layout/NavBar.tsx] | Labels, routes, `Link`, and `activeProps={{ className: "on" }}`. [VERIFIED: apps/web/src/shared/layout/NavBar.tsx] | Improve active/hover contrast using subtle menu treatment. [CITED: 08-UI-SPEC.md] |
| Global search | Input label `Global search`; Enter on non-empty trimmed query navigates to `/jobs` with `{ q, page: 1 }`. [VERIFIED: apps/web/src/shared/layout/Topbar.tsx] | Enter behavior, placeholder, trimmed non-empty guard, URL search contract. [VERIFIED: apps/web/src/shared/layout/Topbar.tsx; CITED: 08-CONTEXT.md] | Tokenized input surface and focus ring; no search implementation rewrite. [VERIFIED: apps/web/src/styles/globals.css] |
| Density select | Native select label `Row density`; options `compact`, `regular`, `comfy`; writes `setDensity`. [VERIFIED: apps/web/src/shared/layout/Topbar.tsx] | Options, storage shape, and row-height semantics. [VERIFIED: apps/web/src/shared/stores/ui-preferences.ts; apps/web/src/styles/tokens.css] | Match shell input styling and browser-proof all three density modes. [CITED: 08-UI-SPEC.md] |
| Theme toggle | Button label `Switch to {next} theme`; currently lucide `Sun`/`Moon` plus text `theme`. [VERIFIED: apps/web/src/shared/layout/ThemeToggle.tsx] | Accessible name, toggle behavior, stable dimensions. [VERIFIED: apps/web/src/shared/layout/ThemeToggle.tsx; CITED: 08-CONTEXT.md] | Replace with `IconSun`/`IconMoon` and tokenized `.tab` treatment. [VERIFIED: local @tabler/icons-react import] |
| Connection status | Labels `connecting`, `live`, `reconnecting`, `offline`, `worker`; banners use `role="alert"` or `role="status"`. [VERIFIED: apps/web/src/shared/layout/ConnectionStatusPill.tsx] | Honesty of worker/offline signals, `aria-live`, roles, health/SSE inputs. [VERIFIED: apps/web/src/shared/layout/ConnectionStatusPill.tsx; CITED: 08-CONTEXT.md] | Improve badge/banner readability without hiding warning/offline states. [CITED: 08-UI-SPEC.md] |
| Route tabs/menu chrome | `.tab`, `.tabs`, `.discovery-tabs`, `.stage-trigger-tabs`, `.profile-mode-tabs`, `settings-tabs` are present in route/context surfaces. [VERIFIED: rg tab selectors; apps/web/src/styles/globals.css] | Navigation meaning and URL/state behavior. [CITED: 08-CONTEXT.md] | Apply consistent token/focus treatment to route chrome only; do not remap domain status tones. [CITED: 08-UI-SPEC.md] |

## Standard Stack

### Core

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| React | `^19.2.3` | Renders shell/chrome components. [VERIFIED: apps/web/package.json] | Existing app framework; no replacement in scope. [VERIFIED: apps/web/package.json; CITED: docs/frontend-target.md] |
| TanStack Router | `^1.93.0` | Owns shell nav links and global search navigation. [VERIFIED: apps/web/package.json; apps/web/src/shared/layout/*.tsx] | Existing URL-state/router standard. [CITED: docs/frontend-target.md] |
| Zustand | `^5.0.13` | Persists theme/density in `jh:ui-preferences`. [VERIFIED: apps/web/package.json; apps/web/src/shared/stores/ui-preferences.ts] | Existing client preference store; changing it risks persistence migration. [VERIFIED: apps/web/index.html] |
| Tailwind CSS | `^4.2.4` | Generates CSS-first shadcn utilities from `@theme inline`. [VERIFIED: apps/web/package.json; apps/web/src/styles/globals.css] | Existing token generation path established by Phase 6. [VERIFIED: apps/web/src/styles/token-contract.test.ts] |
| shadcn | `4.11.0` | Defines config expectations for radix-luma, semantic tokens, and Tabler target. [VERIFIED: apps/web/package.json; apps/web/components.json] | Existing milestone preset contract. [VERIFIED: apps/web/src/styles/token-contract.test.ts] |
| @tabler/icons-react | `3.44.0` | Target icon component library for user-visible chrome. [VERIFIED: apps/web/package.json; VERIFIED: local node module metadata] | `components.json` sets `iconLibrary: "tabler"`. [VERIFIED: apps/web/components.json] |
| @fontsource-variable/geist | `5.2.9` | Body font source imported by Vite/Storybook through global CSS. [VERIFIED: apps/web/package.json; apps/web/src/styles/globals.css] | Phase 6 preset font contract. [VERIFIED: apps/web/src/styles/token-contract.test.ts] |
| @fontsource-variable/jetbrains-mono | `5.2.8` | Heading/technical/mono font source imported by Vite/Storybook through global CSS. [VERIFIED: apps/web/package.json; apps/web/src/styles/globals.css] | Phase 6 preset font contract. [VERIFIED: apps/web/src/styles/token-contract.test.ts] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| Vitest | `4.1.5` | Unit/component and token contract tests. [VERIFIED: local `vitest --version`] | Add focused tests for shell behavior and icon/persistence contracts. [CITED: 08-UI-SPEC.md] |
| Playwright | `1.59.1` | Browser proof for shell, theme, density, search, nav, and route fit. [VERIFIED: local Playwright version] | Extend or supplement `token-foundation.spec.ts`. [VERIFIED: apps/web/e2e/tests/token-foundation.spec.ts] |
| Storybook | `^10.3.6` | Story/a11y proof when shared stories/providers/primitives change. [VERIFIED: apps/web/package.json; docs/local-reliability-qa.md] | Required only if stories/providers/shared primitives are changed in Phase 8. [CITED: 08-CONTEXT.md] |

**Installation:** No new package installation is recommended for Phase 8. [VERIFIED: apps/web/package.json; CITED: 08-CONTEXT.md]

## Package Legitimacy Audit

No new external package installation is recommended in this phase, so the package legitimacy gate is not required for Phase 8 planning. [VERIFIED: apps/web/package.json; CITED: 08-CONTEXT.md]

## Icon Migration Audit

### Priority A - Phase 8 Must Migrate Or Explicitly Defer

| File | lucide import | Recommended Tabler mapping | Reason |
|------|---------------|----------------------------|--------|
| `apps/web/src/shared/layout/ThemeToggle.tsx` | `Sun`, `Moon` | `IconSun`, `IconMoon` | Direct app-chrome control, local Tabler exports exist, accessible name already present. [VERIFIED: source file; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/shared/ui/command.tsx` | `Search` | `IconSearch` | User-visible command/search affordance; behavior should remain Radix/cmdk-owned. [VERIFIED: rg lucide-react; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/shared/ui/select.tsx` | `Check`, `ChevronDown`, `ChevronUp` | `IconCheck`, `IconChevronDown`, `IconChevronUp` | Shared select control affordances are user-visible chrome. [VERIFIED: rg lucide-react; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/shared/ui/dropdown-menu.tsx` | `Check`, `ChevronRight`, `Circle` | `IconCheck`, `IconChevronRight`, `IconCircle` | Menu affordances match Phase 8 menu/chrome scope. [VERIFIED: rg lucide-react; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/shared/ui/checkbox.tsx` | `Check` | `IconCheck` | Shared form/check affordance; preserve Radix behavior and dimensions. [VERIFIED: rg lucide-react; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/shared/ui/toast.tsx`, `sheet.tsx`, `dialog.tsx` | `X` | `IconX` | Close affordances are visible shared chrome; keep accessible names and Radix close behavior. [VERIFIED: rg lucide-react; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/shared/ui/filterable-data-grid.tsx` | `Filter`, `SortAsc`, `SortDesc`, `TableProperties`, `X` | `IconFilter`, `IconSortAscending`, `IconSortDescending`, `IconTable`, `IconX` | Dense grid controls are operational chrome across Jobs/Artifacts/Runs/Debug. [VERIFIED: rg lucide-react; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/shared/ui/copyable-command.tsx` | `Check`, `Copy` | `IconCheck`, `IconCopy` | Shared visible copy affordance; ensure clipboard port/pattern is not worsened. [VERIFIED: rg lucide-react; VERIFIED: local @tabler/icons-react import] |

### Priority B - Migrate Only If Meaning Is Obvious And Scope Stays Small

| File | lucide import | Recommended Tabler mapping | Phase note |
|------|---------------|----------------------------|------------|
| `apps/web/src/views/apply-review/ApplyReviewView.tsx` | `ExternalLink` | `IconExternalLink` | User-visible control icon in a route surface; safe if no apply-review behavior changes. [VERIFIED: source grep; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/contexts/pipeline/components/StageTriggerPanel.tsx` | `Play` | `IconPlayerPlay` | Domain workflow trigger; icon-only meaning is obvious, but do not alter stage behavior. [VERIFIED: source grep; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/contexts/scoring/components/RescoreCurrentPolicyButton.tsx` | `RefreshCw` | `IconRefresh` | Scoring domain action; mapping is obvious, status semantics are Phase 9. [VERIFIED: source grep; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/contexts/scoring/components/ResetStaleScoresButton.tsx` | `RotateCcw` | `IconRotateClockwise` | Scoring domain action; keep label and mutation behavior. [VERIFIED: source grep; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/contexts/scoring/components/ScoreCorrectionControl.tsx` | `Check` | `IconCheck` | Action confirmation icon; safe if tests already cover control behavior. [VERIFIED: source grep; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/contexts/materials/components/*Materials*Button.tsx` | `WandSparkles` | `IconWand` or `IconSparkles` | Domain action; choose one mapping and record it because exact metaphor differs. [VERIFIED: source grep; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/contexts/profile/components/StructuredProfileEditor.tsx` | `Plus`, `Trash2` | `IconPlus`, `IconTrash` | Profile editor controls; safe if dimensions and labels stay stable. [VERIFIED: source grep; VERIFIED: local @tabler/icons-react import] |
| `apps/web/src/contexts/discovery/components/DiscoveryProductControls.tsx` | `AlertTriangle`, `Ban`, `Check`, `ExternalLink`, `Eye`, `Plus`, `ThumbsUp`, `Upload`, `X` | likely `IconAlertTriangle`, `IconBan`, `IconCheck`, `IconExternalLink`, `IconEye`, `IconPlus`, `IconThumbUp`, `IconUpload`, `IconX` | Discovery is a domain route surface; migrate only with control-specific tests or record deferral to Phase 9/11 if too broad. [VERIFIED: source grep; ASSUMED: listed Tabler names should be locally confirmed before implementation] |

### Priority C - Explicit Deferral Is Acceptable

Domain/status icons that are tightly coupled to status semantics may be deferred to Phase 9 if the planner decides the migration would require status-tone decisions. [CITED: .planning/ROADMAP.md; CITED: 08-CONTEXT.md] Final removal of `lucide-react` from `apps/web/package.json` is Phase 11 unless import audit returns zero and cleanup is explicitly included. [CITED: .planning/ROADMAP.md]

## Architecture Patterns

### System Architecture Diagram

```mermaid
flowchart TD
  User[User keyboard/clicks] --> Topbar[Topbar chrome]
  Topbar --> Nav[NavBar Link active state]
  Topbar --> Search[Global search input]
  Topbar --> Density[Row density select]
  Topbar --> Theme[ThemeToggle]
  Topbar --> Status[ConnectionStatusPill]
  Nav --> Router[TanStack Router URL]
  Search --> JobsUrl[/jobs?q=...&page=1]
  Density --> UiStore[Zustand jh:ui-preferences]
  Theme --> UiStore
  UiStore --> AppShell[.app-shell data-density]
  UiStore --> HtmlPrepaint[index.html pre-paint data-theme]
  AppShell --> CssTokens[tokens.css/globals.css]
  HtmlPrepaint --> CssTokens
  Status --> EventStream[EventStreamProvider status]
  Status --> HealthQuery[Operations health query]
  CssTokens --> Browser[Rendered shell/chrome in light/dark/density modes]
```

The diagram is derived from current source composition and persistence seams. [VERIFIED: apps/web/src/shared/layout/*.tsx; apps/web/src/shared/stores/ui-preferences.ts; apps/web/index.html; apps/web/src/styles/*.css]

### Recommended Project Structure

```text
apps/web/src/shared/layout/       # AppShell, Topbar, NavBar, ThemeToggle, ConnectionStatusPill [VERIFIED: codebase]
apps/web/src/shared/ui/           # Shared chrome primitives and affordance icons [VERIFIED: codebase]
apps/web/src/styles/              # Token source, global shell/tab CSS, token contract tests [VERIFIED: codebase]
apps/web/e2e/tests/               # Browser proof, extend token-foundation or add shell-chrome spec [VERIFIED: codebase]
```

### Pattern 1: Preserve Behavior While Retokenizing

**What:** Keep component props, route targets, labels, storage keys, and providers stable while changing CSS classes/tokens and icon imports. [CITED: 08-CONTEXT.md]

**When to use:** All Phase 8 shell/chrome edits. [CITED: 08-CONTEXT.md]

**Example:**

```tsx
// Source: apps/web/src/shared/layout/Topbar.tsx [VERIFIED: codebase]
if (event.key === "Enter" && query.trim()) {
  void navigate({ to: "/jobs", search: { q: query.trim(), page: 1 } });
}
```

### Pattern 2: Icon Swap Without Semantic Swap

**What:** Replace lucide imports with equivalent `Icon*` Tabler imports while preserving `aria-hidden`, size, labels, and button text. [VERIFIED: rg lucide-react; VERIFIED: local @tabler/icons-react import]

**When to use:** `ThemeToggle`, shared UI affordances, and obvious route control icons. [VERIFIED: source grep]

**Example:**

```tsx
// Recommended pattern based on ThemeToggle.tsx and local Tabler exports. [VERIFIED: source file; VERIFIED: local package import]
import { IconMoon, IconSun } from "@tabler/icons-react";

{theme === "dark" ? <IconSun aria-hidden="true" size={14} /> : <IconMoon aria-hidden="true" size={14} />}
```

### Anti-Patterns To Avoid

- **Changing storage keys or persist shape:** `jh:ui-preferences` version `1` is read by both Zustand and the pre-paint script. [VERIFIED: apps/web/src/shared/stores/ui-preferences.ts; apps/web/index.html]
- **Moving route/search state into local shell state:** The frontend target assigns URL state to TanStack Router. [CITED: docs/frontend-target.md]
- **Adding direct platform calls in shell components:** Existing shell components do not use direct `localStorage`, `EventSource`, `apiClient`, `queryClient`, `useQuery`, or `useMutation`; keep providers/hooks as the seam. [VERIFIED: source grep; CITED: AGENTS.md]
- **Flattening status semantics into shell polish:** Phase 9 owns domain/status tone remapping. [CITED: .planning/ROADMAP.md]
- **Using full uncontrolled `shadcn apply`:** The milestone explicitly avoids broad shadcn rewrites. [VERIFIED: .planning/STATE.md; CITED: .planning/REQUIREMENTS.md]

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Theme persistence | Custom localStorage migration in component code | Existing Zustand `persist` store and `ThemeProvider` | Store and pre-paint script already share a key/shape. [VERIFIED: apps/web/src/shared/stores/ui-preferences.ts; apps/web/index.html] |
| URL navigation/search params | Manual `window.location` or string concatenation | TanStack Router `Link` and `useNavigate` | Existing nav/search behavior uses router APIs. [VERIFIED: apps/web/src/shared/layout/*.tsx] |
| Density engine | CSS style queries or JS layout measurements | `.app-shell[data-density]` plus `--jh-row-height` | Current seam is explicit and tested. [VERIFIED: apps/web/src/styles/tokens.css; apps/web/e2e/tests/token-foundation.spec.ts] |
| Icon set | Inline SVG copies or mixed one-off icons | `@tabler/icons-react` exports | Package is installed and config target is Tabler. [VERIFIED: apps/web/package.json; apps/web/components.json] |
| Connection status state | New polling/SSE reader in chrome | Existing EventStream provider and health query | `ConnectionStatusPill` already reads the owning providers. [VERIFIED: apps/web/src/shared/layout/ConnectionStatusPill.tsx] |

**Key insight:** Phase 8 is visual and affordance migration on existing seams; rebuilding state, routing, or connection machinery would create behavioral risk without satisfying any LAYOUT requirement. [CITED: 08-CONTEXT.md; VERIFIED: codebase]

## Runtime State Inventory

This phase is a visual migration, not a rename/refactor/migration of persisted domain identifiers. [CITED: .planning/ROADMAP.md]

| Category | Items Found | Action Required |
|----------|-------------|-----------------|
| Stored data | None - no domain datastore key rename is in scope. [VERIFIED: .planning/ROADMAP.md] | None. [VERIFIED: .planning/ROADMAP.md] |
| Live service config | None - no external service config rename is in scope. [VERIFIED: .planning/ROADMAP.md] | None. [VERIFIED: .planning/ROADMAP.md] |
| OS-registered state | None - no OS registration rename is in scope. [VERIFIED: .planning/ROADMAP.md] | None. [VERIFIED: .planning/ROADMAP.md] |
| Secrets/env vars | None - no secret/env var rename is in scope. [VERIFIED: .planning/ROADMAP.md] | None. [VERIFIED: .planning/ROADMAP.md] |
| Build artifacts | Vite/Storybook builds may contain old CSS/icon output until rebuilt. [ASSUMED] | Run `corepack pnpm web:build` and Storybook build if stories/providers changed. [CITED: 08-CONTEXT.md] |

## Common Pitfalls

| Risk | What goes wrong | How to avoid | Verification |
|------|-----------------|--------------|--------------|
| R-01 Search behavior regression | Styling or refactoring changes the Enter guard or drops `page: 1`. [VERIFIED: apps/web/src/shared/layout/Topbar.tsx] | Keep `useNavigate` behavior untouched and add a focused test/browser assertion. [CITED: 08-UI-SPEC.md] | RTL test or Playwright search-to-Jobs URL assertion. [CITED: 08-UI-SPEC.md] |
| R-02 Theme flash/persistence regression | Changing persist key/shape breaks `index.html` pre-paint. [VERIFIED: apps/web/index.html; apps/web/src/shared/stores/ui-preferences.ts] | Do not change `jh:ui-preferences` or version `1` unless a migration test is planned. [CITED: 08-CONTEXT.md] | Browser reload with seeded dark preference and `html[data-theme=dark]`. [CITED: 08-UI-SPEC.md] |
| R-03 Density visual drift | Font/radius/icon changes make compact tables too tall or clip text. [VERIFIED: apps/web/src/styles/tokens.css; CITED: 08-UI-SPEC.md] | Preserve `--jh-row-height` and check Jobs table in all densities. [VERIFIED: apps/web/e2e/tests/token-foundation.spec.ts] | Extend Playwright density proof on `/jobs`. [VERIFIED: apps/web/e2e/tests/token-foundation.spec.ts] |
| R-04 Connection warning masking | Visual polish hides or softens worker/offline states. [VERIFIED: apps/web/src/shared/layout/ConnectionStatusPill.tsx] | Preserve labels, data-status values, live regions, and banner roles. [CITED: 08-CONTEXT.md] | Component tests with mocked provider/health states. [ASSUMED: test harness can mock providers] |
| R-05 Icon migration breaks a11y | Icon-only or decorative icons lose names or `aria-hidden`. [VERIFIED: source grep] | Replace imports only; preserve labels and `aria-hidden`. [CITED: 08-CONTEXT.md] | Testing Library accessible-name checks and icon import audit. [CITED: 08-UI-SPEC.md] |
| R-06 Globals blast radius | Editing `globals.css` changes domain/status colors or route layouts. [VERIFIED: apps/web/src/styles/globals.css; .planning/STATE.md] | Scope CSS edits to shell/tab/menu selectors and leave domain status remapping to Phase 9. [CITED: .planning/ROADMAP.md] | Legacy/status grep plus route smoke. [CITED: 08-UI-SPEC.md] |
| R-07 Storybook browser sandbox | `web:storybook:test` can fail before suites due Chromium MachPort permissions. [VERIFIED: 07-VERIFICATION.md] | Use the same browser-launch escalation if Storybook gates are required. [VERIFIED: 07-VERIFICATION.md] | Record both sandbox failure and escalated pass if needed. [VERIFIED: 07-VERIFICATION.md] |

## Code Examples

### Theme/Density Persistence Contract

```ts
// Source: apps/web/src/shared/stores/ui-preferences.ts [VERIFIED: codebase]
persist(
  (set) => ({
    theme: "light",
    density: "regular",
    setTheme: (theme) => set({ theme }),
    setDensity: (density) => set({ density }),
  }),
  {
    name: "jh:ui-preferences",
    version: 1,
  },
);
```

### Pre-Paint Theme Contract

```html
<!-- Source: apps/web/index.html [VERIFIED: codebase] -->
<script>
  (function () {
    try {
      var raw = window.localStorage.getItem("jh:ui-preferences");
      var theme = "light";
      if (raw) {
        var parsed = JSON.parse(raw);
        if (parsed && parsed.state && parsed.state.theme === "dark") {
          theme = "dark";
        }
      }
      document.documentElement.dataset.theme = theme;
    } catch (e) {
      document.documentElement.dataset.theme = "light";
    }
  })();
</script>
```

### Browser Proof Pattern

```ts
// Source: apps/web/e2e/tests/token-foundation.spec.ts [VERIFIED: codebase]
await page.getByRole("combobox", { name: "Row density" }).selectOption("compact");
await expect(page.locator(".app-shell")).toHaveAttribute("data-density", "compact");
```

## State Of The Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Legacy custom token aliases | shadcn standard semantic variables and CSS-first Tailwind `@theme inline` | Phase 6, completed 2026-06-10 [VERIFIED: .planning/STATE.md] | Phase 8 should consume standard tokens, not recreate aliases. [VERIFIED: apps/web/src/styles/token-contract.test.ts] |
| Lucide as visible icon default | Tabler target in `components.json`, with lucide still installed for compatibility | Phase 6 kept lucide compatibility; Phase 8 owns visible migration. [VERIFIED: .planning/STATE.md; apps/web/components.json] | Migrate imports or record deferrals; remove dependency later. [CITED: .planning/ROADMAP.md] |
| Primitive a11y/story gaps | Phase 7 shared primitives verified with scoped tests and Storybook proof | Phase 7 completed 2026-06-10 [VERIFIED: 07-VERIFICATION.md] | Phase 8 can rely on primitive baseline and focus on shell/chrome. [VERIFIED: 07-VERIFICATION.md] |

**Deprecated/outdated:** Legacy token names such as `--paper`, `--ink`, `bg-paper`, `text-ink`, `border-rule`, and `ring-info` are out of scope for new styling and should remain absent. [VERIFIED: .planning/REQUIREMENTS.md; apps/web/src/styles/token-contract.test.ts]

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Four plans are the best split for Phase 8. | Summary / Recommended Plan Split | Planner may choose a different count if implementation dependencies warrant it. |
| A2 | Some Discovery Tabler names such as `IconThumbUp` should exist but must be locally confirmed before implementation. | Icon Migration Audit | A wrong export name would fail typecheck; planner should include an export-name check before editing. |
| A3 | Build artifacts may contain old CSS/icon output until rebuilt. | Runtime State Inventory | Low; build command will regenerate artifacts. |
| A4 | Provider/health mocking is available for focused `ConnectionStatusPill` tests. | Common Pitfalls | If no harness exists, planner should use Playwright or add a small provider test wrapper. |

## Open Questions

1. **How broad should Priority B icon migration be?**
   - What we know: Shell and shared UI affordances are clearly in Phase 8; domain/status semantics remain Phase 9. [CITED: 08-CONTEXT.md; VERIFIED: source grep]
   - What's unclear: Whether the planner should migrate every obvious domain control icon now or defer some to avoid broad route churn. [ASSUMED]
   - Recommendation: Migrate all Priority A icons, migrate small obvious Priority B files with existing tests, and record explicit deferrals for broad Discovery/Profile edits if they expand scope. [ASSUMED]

2. **Should Phase 8 add shell stories?**
   - What we know: No existing `shared/layout` tests or stories were found. [VERIFIED: find apps/web/src/shared/layout]
   - What's unclear: Whether Storybook shell stories are worth the provider/router setup cost. [ASSUMED]
   - Recommendation: Prefer focused Vitest plus Playwright browser proof unless shell stories become necessary for visual review. [ASSUMED]

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| Node.js | Vite, Vitest, package metadata checks | yes | `v25.9.0` [VERIFIED: local command] | none |
| pnpm via Corepack | Web checks/build/tests | yes | `10.24.0` [VERIFIED: local command] | none |
| Vitest | Unit/component/token tests | yes | `4.1.5` [VERIFIED: local command] | none |
| Playwright | Browser proof | yes | `1.59.1` [VERIFIED: local command] | Manual browser proof if runner fails, but automated proof is preferred. [CITED: docs/local-reliability-qa.md] |
| Storybook | Conditional story/a11y gate | yes | `^10.3.6` in package metadata [VERIFIED: apps/web/package.json] | Skip only if no stories/providers/primitives changed. [CITED: 08-CONTEXT.md] |

**Missing dependencies with no fallback:** None found during local CLI checks. [VERIFIED: local commands]

**Missing dependencies with fallback:** None found during local CLI checks. [VERIFIED: local commands]

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4.1.5, Testing Library, Playwright 1.59.1, Storybook 10.3.6 when needed. [VERIFIED: local command; VERIFIED: apps/web/package.json] |
| Config file | `apps/web/e2e/playwright.config.ts` for Playwright; Vitest config is project-local under `apps/web`. [VERIFIED: apps/web/package.json; VERIFIED: codebase] |
| Quick run command | `corepack pnpm --filter @jobhunter/web test <changed-test-files>` [CITED: AGENTS.md; CITED: 08-UI-SPEC.md] |
| Full phase command set | `corepack pnpm web:check`; `corepack pnpm web:build`; targeted Vitest; targeted Playwright; icon import audit; `git diff --check`. [CITED: 08-CONTEXT.md; CITED: 08-UI-SPEC.md] |

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| LAYOUT-01 | Shell/topbar/nav/search/theme/density/status keep behavior while visual chrome changes. | unit + e2e | `corepack pnpm --filter @jobhunter/web test src/shared/layout/<new-tests>.test.tsx`; `corepack pnpm --filter @jobhunter/web e2e -- tests/token-foundation.spec.ts` | New unit files needed; E2E exists. [VERIFIED: source tree] |
| LAYOUT-02 | Fonts load through Vite and Storybook global CSS and density fit remains stable. | token/unit + e2e | `corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts`; targeted Playwright computed font/density proof | Token test exists; font computed proof may need extension. [VERIFIED: source tree] |
| LAYOUT-03 | Visible lucide imports migrate or are explicitly deferred; accessible names/stable dimensions remain. | static + unit | `rg "lucide-react|@tabler/icons-react" apps/web/src apps/web/package.json`; targeted component tests | Static audit exists as command; new assertions needed where controls change. [VERIFIED: rg] |
| LAYOUT-04 | Compact/regular/comfy density still set row heights and dense `/jobs` route fits. | e2e | `corepack pnpm --filter @jobhunter/web e2e -- tests/token-foundation.spec.ts` | Exists and already checks density; extend for shell/chrome if needed. [VERIFIED: apps/web/e2e/tests/token-foundation.spec.ts] |
| LAYOUT-05 | Topbar/menu surfaces readable in light/dark over dense/product surfaces. | e2e/browser QA | Add/extend Playwright shell-chrome proof across `/jobs`, `/apply-review`, `/artifacts` where synthetic fixtures support it | Partial existing proof; route-specific shell proof likely needed. [VERIFIED: apps/web/e2e/tests/token-foundation.spec.ts] |

### Sampling Rate

- **Per task commit:** Run relevant scoped Vitest plus `corepack pnpm web:check` for TypeScript/icon import safety. [CITED: AGENTS.md; CITED: 08-UI-SPEC.md]
- **Per wave merge:** Run `corepack pnpm web:build`, icon import audit, and targeted Playwright for changed shell behavior. [CITED: 08-UI-SPEC.md]
- **Phase gate:** Run full Phase 8 command set and record browser proof without sensitive data. [CITED: 08-CONTEXT.md; CITED: AGENTS.md]

### Wave 0 Gaps

- [ ] `apps/web/src/shared/layout/Topbar.test.tsx` - prove global search Enter behavior, nav labels if useful, density select callback/persistence seam. [VERIFIED: no existing layout tests]
- [ ] `apps/web/src/shared/layout/ThemeToggle.test.tsx` - prove accessible name and theme toggle behavior after Tabler swap. [VERIFIED: no existing layout tests]
- [ ] `apps/web/src/shared/layout/ConnectionStatusPill.test.tsx` - prove labels, `aria-live`, and banner roles for live/offline/worker states if feasible. [VERIFIED: no existing layout tests; ASSUMED: provider mock feasible]
- [ ] `apps/web/e2e/tests/token-foundation.spec.ts` or a new `shell-chrome.spec.ts` - prove light/dark, density persistence, global search, nav active state, shell surface computed styles, and icon dimensions. [VERIFIED: existing E2E proof pattern]

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | No auth changes in Phase 8. [CITED: .planning/ROADMAP.md] |
| V3 Session Management | no | No session changes in Phase 8. [CITED: .planning/ROADMAP.md] |
| V4 Access Control | no | No route/API access changes in Phase 8. [CITED: 08-CONTEXT.md] |
| V5 Input Validation | yes | Preserve trimmed non-empty global search guard and typed router navigation; do not introduce ad hoc URL construction. [VERIFIED: apps/web/src/shared/layout/Topbar.tsx] |
| V6 Cryptography | no | No cryptographic behavior in Phase 8. [CITED: .planning/ROADMAP.md] |

### Known Threat Patterns for This Stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Sensitive data in visual QA screenshots or fixtures | Information Disclosure | Use seeded/synthetic data only and avoid profile/artifact/log/database/browser material. [CITED: AGENTS.md; CITED: docs/local-reliability-qa.md] |
| User-affecting automation during shell QA | Tampering | Do not run auto-apply, browser submission, mailbox scanning, real material generation, destructive actions, or worker-backed jobs. [CITED: AGENTS.md; CITED: 08-CONTEXT.md] |
| URL/search behavior altered by styling refactor | Tampering | Keep TanStack Router navigation and add regression proof for `/jobs?q=...&page=1`. [VERIFIED: apps/web/src/shared/layout/Topbar.tsx] |
| Operational status hidden by visual polish | Repudiation / Information Disclosure | Preserve worker/offline labels, roles, and banners; do not suppress awkward operational data. [VERIFIED: apps/web/src/shared/layout/ConnectionStatusPill.tsx; CITED: AGENTS.md] |

## Recommended Plan Split

1. **08-01 Shell Chrome Tokens And Fonts**
   - Scope: `AppShell`, `Topbar`, `NavBar`, shell/tab/menu CSS, font-family application for brand/headings/technical chrome. [VERIFIED: codebase]
   - Verification: `corepack pnpm web:check`, token contract if font mappings change, targeted browser computed style checks. [CITED: 08-UI-SPEC.md]

2. **08-02 Tabler Icon Migration**
   - Scope: Priority A icons first; small Priority B mappings only if tests are local and churn stays small. [VERIFIED: rg lucide-react]
   - Verification: `corepack pnpm web:check`, relevant scoped tests, `rg "lucide-react|@tabler/icons-react" apps/web/src apps/web/package.json`, local export-name check. [VERIFIED: local package import]

3. **08-03 Shell Behavior Regression Tests**
   - Scope: Add focused tests for global search, theme toggle, density persistence seam, connection status labels/banners, and icon accessible names/dimensions where changed. [VERIFIED: no existing layout tests]
   - Verification: targeted Vitest plus `corepack pnpm web:check`. [CITED: AGENTS.md]

4. **08-04 Browser Proof And Phase Audit**
   - Scope: Extend `token-foundation.spec.ts` or add shell-chrome Playwright proof for light/dark, compact/regular/comfy, theme reload, density reload/route persistence, nav active state, global search URL, connection status chrome, and topbar/menu readability over dense routes. [VERIFIED: existing E2E proof pattern]
   - Verification: `corepack pnpm web:build`, targeted Playwright, icon audit, `git diff --check`, Storybook gates only if stories/providers/primitives changed. [CITED: 08-CONTEXT.md; CITED: docs/local-reliability-qa.md]

## Implementation Commands

```bash
corepack pnpm web:check
corepack pnpm web:build
corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts
corepack pnpm --filter @jobhunter/web test src/shared/layout/Topbar.test.tsx src/shared/layout/ThemeToggle.test.tsx src/shared/layout/ConnectionStatusPill.test.tsx
corepack pnpm --filter @jobhunter/web e2e -- tests/token-foundation.spec.ts
rg "lucide-react|@tabler/icons-react" apps/web/src apps/web/package.json
git diff --check
```

Run `corepack pnpm web:storybook:build` and `corepack pnpm web:storybook:test` if Phase 8 changes Storybook stories, Storybook providers, or shared primitive story surfaces. [CITED: 08-CONTEXT.md; CITED: docs/local-reliability-qa.md]

## Sources

### Primary (HIGH confidence)
- `.planning/STATE.md` - milestone state, Phase 6/7 completion, Phase 8 readiness, carry-forward decisions. [VERIFIED: codebase]
- `.planning/ROADMAP.md` - Phase 8 goal, success criteria, verification, phase boundaries. [VERIFIED: codebase]
- `.planning/REQUIREMENTS.md` - LAYOUT-01 through LAYOUT-05 and safety constraints. [VERIFIED: codebase]
- `.planning/phases/08-layout-chrome-fonts-and-tabler-icons/08-CONTEXT.md` - locked decisions and deferred boundaries. [VERIFIED: codebase]
- `.planning/phases/08-layout-chrome-fonts-and-tabler-icons/08-UI-SPEC.md` - UI contract, icon priority, QA contract. [VERIFIED: codebase]
- `apps/web/src/shared/layout/*.tsx`, `apps/web/src/shared/stores/ui-preferences.ts`, `apps/web/index.html`, `apps/web/src/styles/*.css` - implementation seams. [VERIFIED: codebase]
- `apps/web/package.json`, `apps/web/components.json`, local `@tabler/icons-react` package metadata/import - dependency and export facts. [VERIFIED: local package metadata]

### Secondary (MEDIUM confidence)
- `docs/frontend-target.md` - frontend architecture constraints and state ownership. [CITED: docs/frontend-target.md]
- `docs/local-reliability-qa.md` - QA command and safety expectations. [CITED: docs/local-reliability-qa.md]
- `.planning/phases/07-shared-primitive-token-migration/07-VERIFICATION.md` - primitive baseline and Storybook MachPort caveat. [VERIFIED: codebase]

### Tertiary (LOW confidence)
- Assumptions in the Assumptions Log only; no external web browsing was used. [VERIFIED: research process]

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - package versions and configs were read from local package/config files and local CLI metadata. [VERIFIED: apps/web/package.json; apps/web/components.json; local commands]
- Architecture: HIGH - shell/state/router seams were read from source files. [VERIFIED: apps/web/src/shared/layout/*.tsx]
- Pitfalls: HIGH for repo-specific risks, LOW where test harness feasibility is assumed. [VERIFIED: source grep; ASSUMED]

**Research date:** 2026-06-10
**Valid until:** 2026-07-10 for repo-grounded phase planning, or earlier if Phase 8 implementation changes shell/icon surfaces. [ASSUMED]
