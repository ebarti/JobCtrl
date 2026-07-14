---
version: alpha
name: JobCtrl
description: Local-first job operations with an editorial, evidence-led interface.

colors:
  background: "#f5f5f3"
  foreground: "#181817"
  card: "#ffffff"
  card-foreground: "#181817"
  popover: "#ffffff"
  popover-foreground: "#181817"
  primary: "#6d28d9"
  primary-foreground: "#ffffff"
  secondary: "#fafaf8"
  secondary-foreground: "#181817"
  muted: "#fafaf8"
  muted-foreground: "#686865"
  accent: "#eee7ff"
  accent-foreground: "#181817"
  destructive: "#c9362b"
  border: "#deded9"
  input: "#c8c8c1"
  ring: "#6d28d9"
  success: "#2f7d44"
  warning: "#8a4c00"
  status-info: "#3269c8"
  sidebar: "#ffffff"
  sidebar-foreground: "#181817"
  sidebar-primary: "#6d28d9"
  sidebar-primary-foreground: "#ffffff"
  sidebar-accent: "#fafaf8"
  sidebar-accent-foreground: "#181817"
  sidebar-border: "#deded9"
  brand-navy: "#181817"
  brand-violet: "#6d28d9"

typography:
  display:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 30px
    fontWeight: 820
    lineHeight: "1.08"
    letterSpacing: "-0.045em"
  h1:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 28px
    fontWeight: 820
    lineHeight: "1.08"
    letterSpacing: "-0.045em"
  h2:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 14px
    fontWeight: 760
    lineHeight: "1.25"
    letterSpacing: "-0.015em"
  body:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 14px
    fontWeight: 500
    lineHeight: "1.5"
    letterSpacing: "0em"
  body-sm:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 12px
    fontWeight: 500
    lineHeight: "1.45"
    letterSpacing: "0em"
  label:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 11px
    fontWeight: 700
    lineHeight: "1.2"
    letterSpacing: "0em"
  button:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 12px
    fontWeight: 680
    lineHeight: "1"
    letterSpacing: "0em"
  mono:
    fontFamily: "JetBrains Mono Variable"
    fontSize: 12px
    fontWeight: 500
    lineHeight: "1.45"
    letterSpacing: "0em"

rounded:
  none: 0px
  xs: 2px
  sm: 3px
  full: 999px

spacing:
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  3xl: 48px

components:
  app-shell:
    backgroundColor: "{colors.background}"
    textColor: "{colors.foreground}"
  side-rail:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.sidebar-foreground}"
    rounded: "{rounded.none}"
    padding: 12px
  side-rail-active-item:
    backgroundColor: transparent
    textColor: "{colors.foreground}"
    indicatorColor: "{colors.primary}"
    rounded: "{rounded.none}"
  rule-section:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.none}"
    dividerColor: "{colors.border}"
  button-primary:
    backgroundColor: "{colors.foreground}"
    textColor: "{colors.card}"
    typography: "{typography.button}"
    rounded: "{rounded.xs}"
    height: 36px
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    borderColor: "{colors.border}"
    typography: "{typography.button}"
    rounded: "{rounded.xs}"
    height: 36px
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    borderColor: "{colors.input}"
    rounded: "{rounded.xs}"
    height: 38px
  tab:
    backgroundColor: transparent
    textColor: "{colors.muted-foreground}"
    activeTextColor: "{colors.foreground}"
    activeRuleColor: "{colors.primary}"
    rounded: "{rounded.none}"
  status:
    backgroundColor: transparent
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.none}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  overlay:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.popover-foreground}"
    rounded: "{rounded.xs}"
---

# JobCtrl Interface Standard

The design system is the contract that makes every JobCtrl screen feel like one product. It is not a bag of components. Tokens own values, shared primitives own appearance and interaction, domain components own meaning, and route composers use a small set of recurring structures.

## Product character

JobCtrl is a local-first control plane for consequential work. Its interface is editorial, calm, dense without being cramped, and explicit about evidence and lifecycle.

Non-negotiables:

- Type before containers.
- One-pixel rules before cards.
- Large surfaces stay neutral.
- Purple marks focus, selection, links, and the active rule; it is not a generic fill color.
- Semantic color appears on small glyphs and text, never large status backgrounds.
- Status is dot or icon + label + optional detail, never a colored capsule.
- Structural radius is 0–3px. `rounded-full` is reserved for intrinsically round controls.
- Shadows belong only to true overlays. Route-backed detail is a full workspace, not a floating card.
- Missing, unknown, blocked, residual-warning, and failed-refresh states remain visible.
- Retrying or re-tailoring never hides the last accepted artifact.

## Foundations

| Foundation | Contract |
| --- | --- |
| Base rhythm | 4px; primary steps 8, 12, 16, 24, 32 |
| Product type | Plus Jakarta Sans Variable |
| Technical type | JetBrains Mono Variable |
| Page title | 25–30px, 800–820 weight, tight optical spacing |
| Body | 14px / 21px |
| Label/meta | 10–12px, stronger weight or mono where appropriate |
| Table density | 32px compact, 40px regular, 48px comfy |
| Canvas | warm neutral `#f5f5f3` |
| Surface | white `#ffffff` |
| Ink | near-black `#181817` |
| Focus | purple `#6d28d9` |
| Semantic signals | green `#2f7d44`, amber `#8a4c00`, red `#c9362b`, blue `#3269c8` on glyph/text only |
| Icon family | Tabler, consistent 1.5–2px stroke |
| Shape | square/2px structural corners; no capsule taxonomy |

Dark mode remaps the same semantic tokens. It does not invent a second component language.

## Ownership layers

1. **Tokens** — color, spacing, typography, rule, radius, elevation, density, and motion values.
2. **Primitives** — button, icon button, field, checkbox, tabs, status, ledger, rule section, table, empty state, and detail workspace.
3. **Domain components** — score, stage, run, source, evidence, artifact, apply decision, and lifecycle displays.
4. **Page archetypes** — the six recurring compositions below.
5. **Route composers** — real application pages combine domain components without redefining their appearance.

## Page archetypes

| Archetype | Routes |
| --- | --- |
| Overview / insight | `/dashboard`, `/analytics` |
| Data index | `/jobs`, `/artifacts`, `/outreach`, `/runs`, `/debug` |
| Inspector / decision | `/apply-review`, `/evidence-map` |
| Operations | `/pipelines`, `/discovery` |
| Configuration / form | `/profile`, `/profile/import/*`, `/preferences`, `/settings/*` |
| Route-backed detail workspace | `/jobs/$jobId`, `/jobs/$jobId/run/$runId`, `/artifacts/$artifactId`, `/outreach/$contactId`, `/runs/$runId`, `/activity/$eventId` |

## Composition rules

- Overview pages use a ruled metric ledger followed by a small number of continuous insight bands.
- Data indexes use one tool row and one dense table sheet. Saved views and filters are controls, not content cards.
- Inspector pages use stable master-detail geometry with evidence and the decision action visible together.
- Operations pages use ledgers, stage rows, timelines, and disclosures; each datum does not get its own tile.
- Configuration pages use collapsible rule sections and adaptive field grids. The resume preview is a full-width workbench.
- Detail routes use a full workspace with a clear return action, identity header, tab rule, and persistent audit inspector.

Never nest decorative cards inside another card. A container exists only when it expresses structure, grouping, scroll ownership, selection, or an overlay relationship.

## Components

Buttons:

- One dominant action per page uses near-black on the neutral surface.
- Secondary actions use neutral borders and surfaces.
- Destructive actions use red text/glyph and a neutral surface until confirmation.
- Purple belongs to focus and selection, not every primary button fill.

Tabs and selection:

- Tabs are labels on a one-pixel rule; the active tab uses a 2px purple underline.
- Row and navigation selection use a thin purple rule or an explicit checked state.
- Segmented choices remain square and use a rule/underline; they do not become capsule groups.

Status:

- Render a small semantic dot or icon, a readable label, and optional muted detail.
- Green means complete/accepted/validated; amber means review/risk/residual warning; blue means queued/running/inspected; red means failed/blocked/unsafe.
- Never use background color alone, and never wrap status in a tinted rounded rectangle.

Forms:

- Inputs, selects, textareas, and checkboxes share 2px corners, a neutral one-pixel border, and no resting shadow.
- Labels explain meaning; optional documentation links sit beside the label rather than inside helper-card chrome.
- Adaptive grids use available width and collapse by their own container, not only the viewport.

Data grids:

- Keep columns scannable, ruled, and compact; allow horizontal scrolling only inside the table.
- Filters and saved views live in the tool row or an overlay, never as a wall of mini-cards.
- Semantic row/cell rules are thin markers. Do not flood a cell or row with status color.

Elevation:

- Normal route content has no shadow.
- Menus, dialogs, popovers, and mobile sheets may use one quiet shadow because they truly overlay content.
- Large previews may use a dark neutral stage only when it clarifies the physical page boundary.

## State contract

Every asynchronous composite defines loading, empty, error, populated, refreshing, and disabled states. Loading preserves final geometry. Refreshing keeps reviewable truth in place. Disabled controls explain the missing prerequisite. Consequential states show their source, lifecycle, and timestamp when the data exists.

## Interaction and accessibility

- URL state owns navigation and filters that users may revisit, share, or traverse with browser history.
- Focus remains visible with the focus token.
- Interactive targets are at least 24px, with 32–40px preferred for primary controls.
- State never relies on color alone and remains legible in forced-colors mode.
- Mobile reflow favors readable stacking over compressed desktop columns.
- The page itself never overflows horizontally; only intrinsically wide tabs, tables, and editors may scroll.

## Acceptance bar

- No unexplained one-off spacing, radius, color, or control treatment.
- No rounded-rectangle proliferation and no capsule status taxonomy.
- No P0/P1/P2 visual mismatch against the approved draft direction.
- Zero page-level horizontal overflow at supported widths.
- All original data, controls, audit fields, filters, and route transitions remain available.
- All core actions work and all consequential claims expose source and lifecycle when data exists.
- Zero critical or serious accessibility violations in supported stories.
