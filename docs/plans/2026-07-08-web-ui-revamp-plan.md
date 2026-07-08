# Web UI/UX Revamp — Left-Rail Shell + JobCtrl Design System

- **Status:** In progress (this PR implements the plan end to end)
- **Branch:** `feat/ui-revamp`
- **Date:** 2026-07-08
- **Owner ask:** adopt a friendlier, more polished UX modeled on the JobCtrl
  P3-B static mock-up; break up the overloaded top-bar menu into a left
  navigation rail; end state is a visibly polished UI across every view.

## 1. Sources of truth

1. **P3-B static mock-up** (`jobctrl-p3b-webapp.html`, provided by the owner;
   not committed — its design tokens are transcribed into §3 below). The
   mock-up duplicates its nav in both the rail and the top bar; per the owner,
   we do **not** copy that duplication. Rail = navigation, top bar = search +
   runtime status only.
2. **Brand assets** (owner-provided 2026-07-08, saved at the repo root of
   the main checkout): `logo.png` (app icon — bold purple check resting on
   two stacked, rounded diamond layers in light violet), `primarylogo.png`
   and `horizontallockuo.png` (color lockups: "Job" in near-black, "Ctrl"
   in purple, tagline "Plan. Apply. Track. Succeed."), `monochromelogo.png`
   (black mono lockup). These supersede the mock-up's three-stroke
   `.brand-mark-svg`: the canonical mark is **check-over-layered-diamonds**.
   Optimized copies are committed under `docs/assets/brand/`; the in-app
   `BrandMark` is a hand-drawn SVG reproduction of the mark (crisp at rail
   size, theme-aware), and the app icon feeds the favicon set (§5 Phase 1).
3. **Current implementation** as mapped on 2026-07-08: shell =
   `apps/web/src/shared/layout/{AppShell,Topbar,NavBar,ThemeToggle,ConnectionStatusPill}.tsx`;
   tokens = `apps/web/src/styles/tokens.css` (contract-tested by
   `apps/web/src/styles/token-contract.test.ts` and `token-contrast.test.ts`);
   ~7,200-line `apps/web/src/styles/globals.css` of bespoke class CSS;
   Tailwind v4 CSS-first (`@theme inline` block in `globals.css`); shadcn
   (radix-luma) primitives under `apps/web/src/shared/ui/`.

## 2. What changes, at a glance

| Surface | Today | Target |
| --- | --- | --- |
| Navigation | 14 links crammed into the sticky top bar (`NavBar.tsx`) | Grouped left rail (236px, sticky, collapsible), zero nav in the top bar |
| Top bar | brand + 14 links + search + density + theme + connection pill, wraps at narrow widths | Slim 60px bar: global search, density, theme toggle, connection pill |
| Brand | "jh" text chip | Stacked-check SVG mark + Job**Ctrl** wordmark (Ctrl in purple) |
| Primary color | blue `oklch(0.5 0.134 242.749)` | purple `#7c3aed` (`oklch(0.541 0.281 293.009)`, Tailwind violet-600) |
| Sans font | Geist Variable | Plus Jakarta Sans Variable |
| Heading font | JetBrains Mono Variable | Plus Jakarta Sans Variable (tight tracking, heavy weights) |
| Page headers | Ad-hoc per view | Uniform page-head: purple uppercase eyebrow, 26px title, subtitle, right-aligned actions |
| Cards/tables | Flat, mixed styles | Soft-shadow panels, pill tags, sticky uppercase table headers, hover tint |
| `document.title` | Static "JobCtrl" | `JobCtrl · <page>` per route |
| Dark mode | Kept | Kept — purple accent retuned for dark; mock-up is light-only so dark values are derived, not copied |

Explicit non-goals: no behavior changes, no new/removed routes, no data-layer
changes, no changes to contexts' hooks/mutations, no removal of density modes,
no mobile-first rework beyond the responsive rail described in §4.

**Owner constraint (2026-07-08, binding on every phase):** the mock-up is
*directional, not a spec*. The shipped app is denser than the mock-up and
that density is the product. **No functionality or currently-presented data
may be reduced** in the name of visual alignment — every column, control,
metric, panel, badge, and audit surface that exists today must still exist
and remain reachable after the revamp. Alignment work is additive styling
and composition only. Any conflict between "look like the mock-up" and
"keep the data" resolves in favor of the data.

## 3. Design tokens (target)

Token **names are frozen** — `token-contract.test.ts` enforces the set; we
retune **values only** and add the few net-new tokens listed below. All colors
stated in oklch (house format), derived from the mock-up's hex palette.

Light theme retunes in `apps/web/src/styles/tokens.css`:

| Token | Target | Mock-up source |
| --- | --- | --- |
| `--primary` | `oklch(0.541 0.281 293.009)` | `--purple: #7c3aed` |
| `--primary-foreground` | near-white with violet cast | button text on purple |
| `--accent` | `oklch(0.943 0.029 294.588)` (violet-100) | `--purple-2: #ede9fe` |
| `--accent-foreground` | `--primary` | active-nav text |
| `--ring` | violet at ~36% alpha | `outline: 3px solid rgba(124,58,237,.36)` |
| `--background` | `#f3f4f6`-equivalent warm gray | `--bg` |
| `--card` / `--popover` | white | `--surface` |
| `--border` | `#e5e7eb`-equivalent | `--border` |
| `--sidebar-*` (already declared, currently unused) | rail surface `rgba(255,255,255,.84)` over `--background`, `--sidebar-primary` = purple | `.rail` |
| `--chart-1..5` | violet ramp (`#7c3aed` → `#ddd6fe`) | bars/donut gradient |
| `--radius` | `0.5rem` | `--radius: 8px` |

Net-new tokens (additive, so the contract test gains rows, loses none):
`--shadow-panel` (`0 12px 34px rgb(31 41 55 / 0.08)`), `--rail-width`
(`236px`), `--rail-width-collapsed` (`72px`), `--topbar-height` (`60px`).

Dark theme: same hue moves applied to the existing dark block —
`--primary` ≈ violet-400 `oklch(0.702 0.183 293.541)` for contrast on dark,
`--accent` a deep violet mix, rail surface translucent dark. Both themes must
pass `token-contrast.test.ts` and the Storybook a11y bar.

Fonts: add `@fontsource-variable/plus-jakarta-sans`; `--jh-font-sans` and
`--jh-font-heading` both move to it (headings get `letter-spacing: -0.03em`,
weights 700–800). `--jh-font-mono` stays JetBrains Mono (document blocks,
payloads, IDs). Remove the Geist import once nothing references it.

Semantic status colors (`--success`, `--warning`, `--status-info`,
`--destructive`) keep their hues — they carry meaning in badges across the
product — but their `*-muted` soft backgrounds shift to the mock-up's soft
fills (`#ecfdf5` / `#fffbeb` / `#fef2f2` equivalents).

## 4. Information architecture — rail + top bar

### 4.1 Left rail (new `apps/web/src/shared/layout/SideRail.tsx`)

Sticky, `--rail-width`, translucent white + blur, right border. Top to
bottom:

1. **Brand**: `BrandMark.tsx` — SVG reproduction of the canonical mark
   (purple check over two rounded diamond layers, `#ddd6fe`/`#c4b5fd`
   layers + `#7c3aed` check) + wordmark "Job" (foreground) / "Ctrl"
   (purple), links to `/dashboard`. The tagline "Plan. Apply. Track.
   Succeed." is available for empty states / the sheet-nav header; it does
   not clutter the rail.
2. **Grouped nav** — all 14 existing routes, unchanged paths and link labels
   (e2e locates them by role/name), grouped with uppercase section labels:
   - **Overview**: Dashboard, Analytics
   - **Pipeline**: Jobs, Apply review, Pipelines, Discovery
   - **Library**: Artifacts, Evidence, Contacts
   - **Activity**: Runs, Debug
   - **Setup**: Profile, Preferences, Settings
   Each item: Tabler icon + label; active state = violet text on
   `--accent` fill with a 3px inset left bar (mock-up `.nav-button
   [aria-current="page"]`). TanStack Router `Link` keeps `aria-current`.
   Count badges (e.g. Apply review queue size) are a stretch item (§7).
3. **Rail footer**: "Local mode — all data stays on device" status card
   (replaces the mock-up's user card; we have no accounts, and this states
   the product's actual privacy posture).

Responsive behavior (net-new; the current shell has none):

- `≤1180px`: rail collapses to icon-only `--rail-width-collapsed`, labels in
  tooltips, section labels hidden.
- `≤820px`: rail hidden; top bar gains a hamburger button opening the
  existing `sheet.tsx` side panel containing the same grouped nav.

### 4.2 Top bar (rework `Topbar.tsx`, keep the `.topbar` class + painted
background + bottom border — `token-foundation.spec.ts` asserts them)

Left to right: hamburger (≤820px only) · global search (`aria-label="Global
search"` preserved verbatim) · density select · `ThemeToggle` ·
`ConnectionStatusPill` (`.connection-pill` class preserved). `NavBar.tsx` is
deleted; nothing else renders navigation. The brand moves to the rail.

### 4.3 Page furniture

- Per-route `document.title` = `JobCtrl · <Page name>` via a small
  `usePageTitle` hook called from each view (or route `head`/`meta` if the
  router version's API is cleaner — implementer's choice, one mechanism
  everywhere).
- Uniform `PageHead` component (`apps/web/src/shared/ui/page-head.tsx`):
  eyebrow (uppercase, purple, 10px/900), `h1` 26px tight-tracked title,
  muted subtitle, right-side action slot. Every view adopts it in Phase 3.

## 5. Phases

Single PR, stacked commits per phase, each phase leaves the app green
(`pnpm web:check`, web unit/component tests, stories build).

### Phase 1 — tokens, fonts, shell

1. Retune `tokens.css` light + dark per §3; extend `@theme inline` mappings;
   add Plus Jakarta Sans; update `token-contract.test.ts` /
   `token-contrast.test.ts` expectations where they pin values (names stay).
2. `BrandMark.tsx`, `SideRail.tsx` (+ stories + a11y test), grouped nav with
   icons, rail footer, collapse/sheet behavior.
3. Rework `Topbar.tsx`; delete `NavBar.tsx`; move its test coverage to
   `SideRail.test.tsx`; new `.app-shell` grid (`rail | main`).
4. Update the shell CSS blocks in `globals.css` (~lines 47–300: `.topbar`,
   `.nav`, `.brand`, `.global-search`) — replace `.nav` with `.side-rail`
   classes.
5. Update the two coupled e2e specs in lockstep:
   `token-foundation.spec.ts` (drop `.nav` width assertion, assert rail
   instead; keep `.topbar`, "Global search", `.connection-pill` checks) and
   `route-visual-qa.spec.ts` (nav links now live in the rail; role/name
   queries unchanged). `dashboard.spec.ts` / `dry-run.spec.ts` selectors are
   unaffected but must be re-run.
6. Per-route `document.title`.
7. **Brand asset refresh**: commit optimized copies of the four owner
   PNGs under `docs/assets/brand/` (downscaled, web-weight); replace the
   web app favicon with a hand-drawn `favicon.svg` of the mark + a 180px
   `apple-touch-icon.png` derived from `logo.png`; update `index.html`
   `<link rel>` tags accordingly.

### Phase 2 — shared primitive restyle (`apps/web/src/shared/ui/`)

Keep component APIs; restyle to the mock-up language:

- `card.tsx`/`section.tsx`: white panel, `--shadow-panel`, 8px radius.
- `badge.tsx` + context badges' shared styles: full-pill (999px), soft
  fills, 850-weight 11px text (mock-up `.tag`).
- `button.tsx`: primary = purple with soft purple glow shadow; secondary =
  white w/ violet border+text; ghost = muted w/ gray border.
- `filterable-data-grid.tsx` / `table.tsx`: sticky uppercase 10px
  letter-spaced headers on `#fbfbfd`, row hover tint `#fbfaff`-equivalent,
  score-pill styling hook.
- `tabs.tsx`/segmented: mock-up `.segmented` look (inset container, white
  active thumb with shadow).
- `input`/`select`/`textarea`: 38px min-height, tokenized borders, violet
  focus ring.
- Stat-card pattern: new `stat-card.tsx` (tag + 28px/900 value + delta
  line) for dashboard/analytics KPIs.
- Update all affected stories; Storybook a11y bar (zero critical/serious)
  stays green; new deferrals, if any, must be logged in `docs/backlog.md`.

### Phase 3 — per-view polish (no behavior change)

Adopt `PageHead` + panel/stat/tag patterns in every view. Order (risk-first):

1. `views/dashboard/` — KPIs → stat cards; panels for conversion/digest/
   source health/apply runs (mock-up dashboard composition).
2. `views/jobs/` (730-line composer + 635-line columns) — toolbar styling,
   grid restyle flows from Phase 2; drawer paint.
3. `views/apply-review/` (1,346-line composer) — 3-column review layout
   polish; queue list gets `.list-item` selected-state (violet inset bar).
4. `views/analytics/`, `views/runs/`, `views/debug/`, `views/artifacts/`,
   `views/outreach/`, `views/evidence-map/`, `views/discovery/`,
   `views/pipelines/`, plus `settings`/`profile`/`preferences` panels
   (context-owned components restyled via shared primitives, not forked).
5. Sweep the remaining bespoke sections of `globals.css` view by view;
   delete dead rules as views adopt shared primitives.

### Phase 4 — verification gates

- `pnpm check`; `pnpm --filter @jobctrl/web test`; `pnpm --filter
  @jobctrl/web test-d`; `pnpm web:build`; `pnpm web:storybook:test` (a11y);
  `pnpm --filter @jobctrl/web e2e` (respecting the known-failing baseline in
  `docs/backlog.md` — no new failures).
- `pr-reviewer` loop → Gate: PASS; `qa` loop → Gate: PASS (QA drives the
  real stack against an isolated dir/ports, walks every route in light +
  dark + all three densities, checks rail collapse at 1180/820).

### Phase 5 — docs

Per the documentation matrix: regenerate the synthetic documentation
screenshots (workflow in `docs/local-development.md`) so `docs/user/
screenshots.md` and the README hero/tour images show the new UI; update
`docs/architecture/frontend/` only where it names shell files
(`NavBar.tsx` → `SideRail.tsx`); note the revamp in `docs/local-reliability-qa.md`
regression matrix (shell/nav entries). No README claim changes — visuals only.

## 6. Constraints & invariants

- Token **names** frozen (contract test); values retuned.
- Nav link **labels and roles** unchanged; `aria-label="Global search"`,
  `.topbar`, `.connection-pill` selectors preserved; e2e updated in lockstep
  with any DOM move, never loosened to `waitForTimeout`-style checks.
- View-composer rules hold: views keep composing context components; no
  view-owned queries/mutations introduced by the restyle.
- Dark mode and all three densities remain first-class; every restyled
  story is checked in both themes.
- A11y: keyboard reachability of all rail items, `aria-current` on active
  link, focus-visible violet ring, zero new critical/serious axe violations.
- No new runtime deps beyond `@fontsource-variable/plus-jakarta-sans` and
  (if needed for icons) the already-present Tabler icon set.

## 7. Stretch (in-PR if cheap, else logged to `docs/backlog.md`)

- Rail count badges (Apply review queue, Jobs total) via existing
  operations read hooks.
- Wire the existing dead-code command palette (`command.tsx` +
  `command-palette.ts` store) to Cmd/Ctrl+K with nav + jobs jump actions.

## 8. Risks

- **`globals.css` blast radius** (7.2k lines): mitigated by phase-by-phase
  sweeps + route-visual-qa e2e + full-route QA walk.
- **Token retune ripples** into 108 stories and 26 a11y tests: contrast
  failures surface in `token-contrast.test.ts` + Storybook a11y run, fixed
  at token level, not per-story.
- **e2e coupling**: the two token/route specs are updated in the same
  commits as the DOM changes they assert.
- **Design-system image**: the owner's design-system PNG arrived corrupted
  (placeholder only); tokens were transcribed from the mock-up CSS instead.
  If the real PNG diverges from the mock-up, tokens.css is the single file
  to retune.
