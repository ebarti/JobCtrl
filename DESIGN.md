---
version: alpha
name: JobCtrl
description: Local-first job operations with an editorial, evidence-led interface.

implementation:
  shadcnStyle: "base-rhea"
  behaviorPrimitives: "Base UI"
  css: "Tailwind CSS v4 plus semantic route styles"
  icons: "Tabler"

colors:
  background: "oklch(0.972 0.008 293)"
  foreground: "oklch(0.145 0 0)"
  card: "oklch(1 0 0)"
  card-foreground: "oklch(0.145 0 0)"
  popover: "oklch(1 0 0)"
  popover-foreground: "oklch(0.145 0 0)"
  primary: "oklch(0.541 0.281 293.009)"
  primary-foreground: "oklch(0.985 0.006 293)"
  secondary: "oklch(0.94 0 0)"
  secondary-foreground: "oklch(0.205 0 0)"
  muted: "oklch(0.948 0.01 293)"
  muted-foreground: "oklch(0.49 0.015 293)"
  accent: "oklch(0.943 0.029 294.588)"
  accent-foreground: "oklch(0.541 0.281 293.009)"
  destructive: "oklch(0.577 0.245 27.325)"
  border: "oklch(0.89 0.012 293)"
  input: "oklch(0.82 0.014 293)"
  ring: "oklch(0.541 0.281 293.009)"
  success: "oklch(0.54 0.13 145)"
  success-text: "oklch(0.42 0.1 145)"
  warning: "oklch(0.72 0.15 72)"
  warning-text: "oklch(0.44 0.1 72)"
  destructive-text: "oklch(0.46 0.18 27.325)"
  status-info: "oklch(0.56 0.12 242)"
  sidebar: "oklch(0.982 0.014 294.588)"
  sidebar-foreground: "oklch(0.145 0 0)"
  sidebar-primary: "oklch(0.541 0.281 293.009)"
  sidebar-primary-foreground: "oklch(0.985 0.006 293)"
  sidebar-accent: "oklch(0.943 0.029 294.588)"
  sidebar-accent-foreground: "oklch(0.541 0.281 293.009)"
  sidebar-border: "oklch(0.88 0.018 293)"

darkColors:
  background: "oklch(0.145 0.012 293)"
  foreground: "oklch(0.985 0 0)"
  card: "oklch(0.185 0 0)"
  muted: "oklch(0.269 0.016 293)"
  muted-foreground: "oklch(0.708 0.012 293)"
  primary: "oklch(0.702 0.183 293.541)"
  primary-foreground: "oklch(0.21 0.03 293.5)"
  border: "oklch(1 0 0 / 10%)"
  input: "oklch(1 0 0 / 18%)"
  success: "oklch(0.66 0.14 145)"
  success-text: "oklch(0.76 0.12 145)"
  warning: "oklch(0.8 0.15 76)"
  warning-text: "oklch(0.72 0.13 76)"
  destructive-text: "oklch(0.76 0.15 27.325)"
  status-info: "oklch(0.72 0.13 242)"
  sidebar: "oklch(0.19 0.024 293.5)"

typography:
  page-title:
    fontFamily: "Geist Variable"
    fontSize: 24px
    fontWeight: 700
    lineHeight: 30px
  section-title:
    fontFamily: "Geist Variable"
    fontSize: 18px
    fontWeight: 600
    lineHeight: 24px
  component-title:
    fontFamily: "Geist Variable"
    fontSize: 16px
    fontWeight: 600
    lineHeight: 22px
  body:
    fontFamily: "Geist Variable"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
  strong-body:
    fontFamily: "Geist Variable"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
  control:
    fontFamily: "Geist Variable"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
  label:
    fontFamily: "Geist Variable"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 16px
  metadata:
    fontFamily: "Geist Variable"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
  metric:
    fontFamily: "Geist Variable"
    fontSize: 20px
    fontWeight: 700
    lineHeight: 24px
  mono:
    fontFamily: "JetBrains Mono Variable"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px

rounded:
  none: 0px
  sm: 6px
  md: 8px
  lg: 10px
  xl: 14px
  2xl: 18px
  3xl: 22px
  card: 24px
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
    textColor: "{colors.sidebar-accent-foreground}"
    indicatorColor: "{colors.primary}"
    rounded: "{rounded.none}"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.card}"
    ringColor: "oklch(0.145 0 0 / 5%)"
    shadow: "0 1px 2px rgb(0 0 0 / 0.05)"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: 36px
  button-secondary:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    borderColor: "{colors.border}"
    typography: "{typography.control}"
    rounded: "{rounded.md}"
    height: 36px
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    borderColor: "{colors.input}"
    rounded: "{rounded.md}"
    height: 36px
  tab:
    backgroundColor: transparent
    textColor: "{colors.muted-foreground}"
    activeTextColor: "{colors.accent-foreground}"
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
    rounded: "{rounded.lg}"
---

# JobCtrl Interface Standard

The design system is the contract that makes every JobCtrl screen feel like one product. It is not a bag of components. Tokens own values, shared primitives own appearance and interaction, domain components own meaning, and route composers use a small set of recurring structures.

## Product character

JobCtrl is a local-first control plane for consequential work. Its interface is calm, operational, dense without being cramped, and explicit about evidence and lifecycle. The production component contract is the shadcn Rhea preset implemented on Base UI behavior primitives, Tailwind CSS v4 semantic tokens, and Tabler icons.

Non-negotiables:

- Shared primitives own behavior and visual treatment; route code does not import Base UI directly or recreate a native lookalike.
- Cards group coherent panels, decisions, or bounded workspaces. Do not create one card per datum or nest decorative cards.
- Large surfaces stay neutral. Purple is the primary action, selection, link, and focus color; chart series remain neutral unless the data is semantic.
- Semantic status color appears on a small icon/dot and text. Domain status never relies on color alone or becomes a tinted capsule.
- The 10px Rhea base radius maps to 6px–10px controls, 14px–18px callouts, and a capped 24px card radius. Full rounding is reserved for intrinsically circular controls.
- Cards use only the quiet panel shadow/ring. Stronger elevation belongs to menus, dialogs, popovers, and mobile sheets.
- Route-backed detail is a full workspace, not a modal-shaped card floating over the index.
- Route identity uses one compact `PageHead`: a visible level-1 page title establishes the focal point, while the sidebar section and current page remain secondary breadcrumb context. A short subtitle or count stays inline when space allows. Actions align beside it on desktop and stack below it on narrow screens.
- Missing, unknown, blocked, residual-warning, and failed-refresh states remain visible.
- Retrying or re-tailoring never hides the last accepted artifact.

## Foundations

| Foundation | Contract |
| --- | --- |
| Base rhythm | 4px; primary steps 8, 12, 16, 24, 32 |
| Product type | Geist Variable |
| Technical type | JetBrains Mono Variable |
| Typography roles | Page 24/30/700; section 18/24/600; component 16/22/600; body 14/20/400; strong/control 14/20/600; label/status/table header 12/16/600; metadata 12/16/400; metric 20/24/700 |
| Typography ownership | Every rendered shared primitive carries a named `data-typography` role; route code composes roles instead of inventing local values. |
| Density | Geometry only: controls 32/36/40px; rows 44/52/60px; panels 16/20/24px; internal gaps 8/12/16px; section gaps 16/24/32px. |
| Semantic color | Green, amber, red, and information are reserved for lifecycle state, warning, failure/destructive action, and information. Categories use neutral treatment; long alert copy uses normal foreground color. |
| Canvas | violet-neutral `oklch(0.972 0.008 293)` |
| Surface | white `oklch(1 0 0)` |
| Ink | near-black `oklch(0.145 0 0)` |
| Primary/focus | violet `oklch(0.541 0.281 293.009)` |
| Charts | neutral five-step ramp; reserve chroma for selected or semantic data |
| Semantic signals | success, warning, destructive, and informational tokens on glyph/text plus accessible labels |
| Icon family | Tabler, consistent 1.5–2px stroke |
| Shape | 10px Rhea base; 8px fields/buttons; capped 24px cards; no capsule status taxonomy |

Dark mode remaps the same semantic tokens. It does not invent a second component language.

## Ownership layers

1. **Tokens** — color, spacing, typography, radius, elevation, density, and motion values in `apps/web/src/styles/tokens.css`.
2. **Primitives** — shadcn Rhea-styled wrappers in `apps/web/src/shared/ui/`; Base UI supplies behavior where a primitive needs it.
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

- Overview pages use a metric summary followed by a small number of coherent insight cards or bands.
- Data indexes use one tool row and one dense table surface. Saved views and filters are controls, not content cards. Record tables reflow into labelled cards at 900px and below instead of forcing page-level horizontal scrolling.
- Inspector pages use stable master-detail geometry with evidence and the decision action visible together.
- Operations pages use a small set of cards containing ledgers, stage rows, timelines, and disclosures; each datum does not get its own tile.
- Configuration pages use provider/section cards and adaptive field grids. The resume preview is a full-width workbench.
- Detail routes use a full workspace with a clear return action, identity header, tab rule, and persistent audit inspector.

Never nest decorative cards inside another card. A container exists only when it expresses structure, grouping, scroll ownership, selection, or an overlay relationship.

## Components

Buttons:

- One dominant action per region uses the violet primary token and its paired foreground token.
- Secondary actions use neutral borders and surfaces.
- Destructive actions use the destructive token and require explicit confirmation when the effect is consequential.
- Success and warning button variants are reserved for actions whose meaning is genuinely semantic.

Tabs and selection:

- Shared tabs are labels on a one-pixel rule; the active tab uses a violet underline.
- Row and navigation selection use a thin purple rule or an explicit checked state.
- Do not copy transitional route-specific `.tab` CSS into new components; consume the shared Tabs wrapper.

Status:

- Render a small semantic dot or icon, a readable label, and optional muted detail.
- Green means complete/accepted/validated; amber means review/risk/residual warning; blue means queued/running/inspected; red means failed/blocked/unsafe.
- Never use background color alone, and never wrap status in a tinted rounded rectangle.

Forms:

- Inputs, selects, and textareas share the Rhea medium radius, a neutral one-pixel border, and no resting shadow.
- Labels explain meaning; optional documentation links sit beside the label rather than inside helper-card chrome.
- Adaptive grids use available width and collapse by their own container, not only the viewport.

Data grids:

- Keep columns scannable, ruled, and compact on desktop. At 900px and below,
  record-oriented tables use labelled cards with their sort/filter controls still
  available; do not hide primary fields behind multi-viewport horizontal scroll.
- Filters and saved views live in the tool row or an overlay, never as a wall of mini-cards.
- Semantic row/cell rules are thin markers. Do not flood a cell or row with status color.

Elevation:

- Cards use the quiet panel shadow or Rhea `shadow-sm` plus a subtle ring; do not stack multiple decorative shadows.
- Menus, dialogs, popovers, and mobile sheets may use stronger elevation because they truly overlay content.
- Large previews may use a dark neutral stage only when it clarifies the physical page boundary.

## State contract

Every asynchronous composite defines loading, empty, error, populated, refreshing, and disabled states. Loading preserves final geometry. Refreshing keeps reviewable truth in place. Disabled controls explain the missing prerequisite. Consequential states show their source, lifecycle, and timestamp when the data exists.

## Interaction and accessibility

- URL state owns navigation and filters that users may revisit, share, or traverse with browser history.
- Focus remains visible with the focus token.
- Compact, regular, and comfy density change row, field, and control geometry;
  body and supporting text remain the same readable size in every mode.
- Interactive targets are at least 24px, with 32–40px preferred for primary controls.
- State never relies on color alone and remains legible in forced-colors mode.
- Mobile reflow favors readable stacking over compressed desktop columns.
- The page itself never overflows horizontally; only intrinsically wide tabs, tables, and editors may scroll.

## Acceptance bar

- No unexplained one-off spacing, radius, color, shadow, or control treatment.
- No card-per-datum proliferation and no capsule status taxonomy.
- New interactive primitives use the shared shadcn/Base UI layer; direct Radix imports, raw native selects, and route-local replicas fail the boundary gate.
- Zero page-level horizontal overflow at supported widths.
- All original data, controls, audit fields, filters, and route transitions remain available.
- All core actions work and all consequential claims expose source and lifecycle when data exists.
- Zero critical or serious accessibility violations in supported stories.
