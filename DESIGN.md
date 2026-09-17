---
version: alpha
name: JobCtrl
description: Local-first job operations with a Swiss timetable visual language.

implementation:
  shadcnStyle: "base-rhea"
  behaviorPrimitives: "Base UI"
  css: "Tailwind CSS v4 plus semantic route styles"
  icons: "Tabler"

colors:
  background: "oklch(1 0 0)"
  foreground: "oklch(0.145 0 0)"
  card: "oklch(1 0 0)"
  card-foreground: "oklch(0.145 0 0)"
  popover: "oklch(1 0 0)"
  popover-foreground: "oklch(0.145 0 0)"
  primary: "oklch(0.145 0 0)"
  primary-foreground: "oklch(0.985 0 0)"
  secondary: "oklch(0.94 0 0)"
  secondary-foreground: "oklch(0.205 0 0)"
  muted: "oklch(0.96 0 0)"
  muted-foreground: "oklch(0.46 0 0)"
  accent: "oklch(0.94 0 0)"
  accent-foreground: "oklch(0.145 0 0)"
  destructive: "oklch(0.577 0.245 27.325)"
  border: "oklch(0.84 0 0)"
  input: "oklch(0.64 0 0)"
  ring: "oklch(0.32 0 0)"
  success: "oklch(0.25 0 0)"
  success-text: "oklch(0.25 0 0)"
  warning: "oklch(0.84 0.16 88)"
  warning-text: "oklch(0.42 0.08 75)"
  destructive-text: "oklch(0.46 0.18 27.325)"
  status-info: "oklch(0.4 0 0)"
  sidebar: "oklch(0.96 0 0)"
  sidebar-foreground: "oklch(0.145 0 0)"
  sidebar-primary: "oklch(0.145 0 0)"
  sidebar-primary-foreground: "oklch(0.985 0 0)"
  sidebar-accent: "oklch(0.91 0 0)"
  sidebar-accent-foreground: "oklch(0.145 0 0)"
  sidebar-border: "oklch(0.84 0 0)"

darkColors:
  background: "oklch(0.16 0 0)"
  foreground: "oklch(0.985 0 0)"
  card: "oklch(0.185 0 0)"
  muted: "oklch(0.25 0 0)"
  muted-foreground: "oklch(0.76 0 0)"
  primary: "oklch(0.95 0 0)"
  primary-foreground: "oklch(0.16 0 0)"
  border: "oklch(0.36 0 0)"
  input: "oklch(0.58 0 0)"
  success: "oklch(0.9 0 0)"
  success-text: "oklch(0.9 0 0)"
  warning: "oklch(0.84 0.16 88)"
  warning-text: "oklch(0.85 0.13 88)"
  destructive-text: "oklch(0.76 0.15 27.325)"
  status-info: "oklch(0.78 0 0)"
  sidebar: "oklch(0.2 0 0)"

typography:
  page-title:
    fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: 28px
    fontWeight: 700
    lineHeight: 34px
  section-title:
    fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: 18px
    fontWeight: 700
    lineHeight: 24px
  component-title:
    fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: 16px
    fontWeight: 700
    lineHeight: 22px
  body:
    fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
  strong-body:
    fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
  control:
    fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: 14px
    fontWeight: 600
    lineHeight: 20px
  label:
    fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 600
    lineHeight: 16px
  metadata:
    fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
  metric:
    fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif"
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
  sm: 0px
  md: 0px
  lg: 0px
  xl: 0px
  2xl: 0px
  3xl: 0px
  card: 0px
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
    borderColor: "{colors.border}"
    topRuleColor: "{colors.foreground}"
    shadow: none
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

JobCtrl is a local-first control plane for consequential work. Its interface is calm, operational, dense without being cramped, and explicit about evidence and lifecycle. The Swiss timetable visual language uses the existing shadcn Rhea-derived wrappers, Base UI behavior primitives, Tailwind CSS v4 semantic tokens, and Tabler icons. It changes appearance and the presentation of job metrics, evidence, and authorization gates while preserving navigation, controls, and workflow contracts.

Non-negotiables:

- Shared primitives own behavior and visual treatment; route code does not import Base UI directly or recreate a native lookalike.
- Cards group coherent panels, decisions, or bounded workspaces. Do not create one card per datum or nest decorative cards.
- Large surfaces stay neutral. Near-black anchors primary actions and selection in light mode, with paired light ink in dark mode. Red is reserved for failure/destructive states and amber for pending/review states; informational and completed states remain neutral with explicit icons and labels.
- Semantic status color appears on a small icon/dot and text. Domain status never relies on color alone or becomes a tinted capsule.
- Controls, panels, and overlays use the shared zero-radius scale. Full rounding is reserved for intrinsically circular controls.
- Panels use thin neutral internal dividers and a 2px foreground-ink section rule, with no resting shadow. Profile panels use a 1px ink outline. Elevation belongs to menus, dialogs, popovers, and mobile sheets.
- Route-backed detail is a full workspace, not a modal-shaped card floating over the index.
- Route identity uses one compact `PageHead`: a visible level-1 page title establishes the focal point, while the sidebar section and current page remain secondary breadcrumb context. A short subtitle or count stays inline when space allows. Actions align beside it on desktop and stack below it on narrow screens.
- Missing, unknown, blocked, residual-warning, and failed-refresh states remain visible.
- Retrying or re-tailoring never hides the last accepted artifact.

## Foundations

| Foundation | Contract |
| --- | --- |
| Base rhythm | 4px; primary steps 8, 12, 16, 24, 32 |
| Product type | Helvetica Neue, Helvetica, Arial, sans-serif (system stack matching the timetable mock) |
| Technical type | JetBrains Mono Variable |
| Typography roles | Page 28/34/700; section 18/24/700; component 16/22/700; body 14/20/400; strong/control 14/20/600; label/status/table header 12/16/600; metadata 12/16/400; metric 20/24/700 |
| Typography ownership | Every rendered shared primitive carries a named `data-typography` role; route code composes roles instead of inventing local values. |
| Density | Geometry only: controls 32/36/40px; rows 44/52/60px; panels 16/20/24px; internal gaps 8/12/16px; section gaps 16/24/32px. |
| Semantic color | Amber and red identify warning/pending and failure/destructive states. Completed and informational states use neutral ink plus their distinct labels/icons. Categories use neutral treatment; long alert copy uses normal foreground color. |
| Canvas | white `oklch(1 0 0)` |
| Surface | white `oklch(1 0 0)` |
| Ink | near-black `oklch(0.145 0 0)` |
| Primary/focus | near-black primary `oklch(0.145 0 0)`; visible neutral focus `oklch(0.32 0 0)` |
| Charts | neutral five-step ramp; reserve chroma for selected or semantic data |
| Semantic signals | success, warning, destructive, and informational tokens on glyph/text plus accessible labels |
| Icon family | Tabler, consistent 1.5–2px stroke |
| Brand mark | Original stacked planes and check geometry, with filled neutral layers and a grayscale check gradient; colors invert with the theme. |
| Shape | square controls, panels, overlays, and score markers; no capsule status taxonomy |

Dark mode remaps the same semantic tokens. It does not invent a second component language.

## Ownership layers

1. **Tokens** — color, spacing, typography, radius, elevation, density, and motion values in `apps/web/src/styles/tokens.css`.
2. **Primitives** — owned shadcn Rhea-derived wrappers in `apps/web/src/shared/ui/`; Base UI supplies behavior where a primitive needs it.
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

- One dominant action per region uses the monochrome primary token and its paired foreground token.
- Secondary actions use neutral borders and surfaces.
- Destructive actions use the destructive token and require explicit confirmation when the effect is consequential.
- Success and warning button variants are reserved for actions whose meaning is genuinely semantic.

Tabs and selection:

- Shared tabs are labels on a one-pixel rule; the active tab uses a primary-color underline.
- Row and navigation selection use a thin primary-color rule or an explicit checked state.
- Do not copy transitional route-specific `.tab` CSS into new components; consume the shared Tabs wrapper.

Status:

- Render a small semantic dot or icon, a readable label, and optional muted detail.
- Neutral check/info symbols identify completed and informational states; amber means pending/review/risk/residual warning; red means failure/destructive/unsafe. Keep the readable state label beside the symbol.
- Never use background color alone, and never wrap status in a tinted rounded rectangle.
- Scores above the neutral midpoint use filled square markers; lower scores use outlined markers, and unknown scores retain a dash. Scores do not borrow failure red. Every filled marker pairs its background with an explicit foreground token.
- Unknown, unchecked, checked, indeterminate, and disabled form states stay distinct; an unanswered value must never be painted as a checked assertion.

Forms:

- Inputs, selects, and textareas share square geometry, a foreground-ink one-pixel border, and no resting shadow.
- Labels explain meaning; optional documentation links sit beside the label rather than inside helper-card chrome.
- Adaptive grids use available width and collapse by their own container, not only the viewport.

Data grids:

- Preserve useful title and compensation column widths at laptop sizes. A wide table may scroll inside its own container instead of compressing titles or shrinking text.
- Keep columns scannable, ruled, and compact on desktop. At 900px and below,
  record-oriented tables use labelled cards with their sort/filter controls still
  available; do not hide primary fields behind multi-viewport horizontal scroll.
- Filters and saved views live in the tool row or an overlay, never as a wall of mini-cards.
- Semantic row/cell rules are thin markers. Do not flood a cell or row with status color.

Elevation:

- Cards use neutral one-pixel borders and stronger section rules with no resting shadow; do not stack decorative shadows.
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

### Timetable information density

Jobs starts with fit, title, company, location, stage, state, and apply status; Sources, compensation scan columns, Warnings, Template, and Discovered date remain available from Columns. Existing named and customized views retain their choices. Jobs row density adjusts padding while body text stays 14px. Secondary recording actions such as Mark as applied use an outline so the next workflow action remains visually dominant.

Job detail uses a responsive six-cell summary strip and labeled header metadata. Requirement evidence starts expanded and remains collapsible. Apply Review shows canonical authorization gates in a neutral table with state glyphs and text; dry run remains primary until live-submit eligibility is satisfied. Missing evidence, stale bindings, partial evidence, and failures retain their full reasons and existing authorization rules.
