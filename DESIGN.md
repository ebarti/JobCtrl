---
version: alpha
name: JobCtrl
description: A calm, compact workspace for local-first job operations.
implementation:
  behaviorPrimitives: "Base UI through shared wrappers"
  css: "Tailwind CSS v4 plus semantic route styles"
  icons: "Tabler"
colors:
  canvas: "#f7f8fa"
  surface: "#ffffff"
  foreground: "#202733"
  mutedForeground: "#616b79"
  primary: "#3b485a"
  primaryForeground: "#ffffff"
  border: "#dce1e8"
typography:
  fontFamily: "Geist Variable, system-ui, sans-serif"
  pageTitle: "28px / 34px / 700"
  sectionTitle: "18px / 24px / 700"
  componentTitle: "16px / 22px / 700"
  body: "14px / 20px / 400"
  strongAndControl: "14px / 20px / 600"
  label: "14px / 20px / 600"
  metadata: "12px / 16px / 400"
  metric: "20px / 24px / 700"
  code: "JetBrains Mono Variable"
shape:
  controlAndPanelRadius: "approximately 6–8px"
spacing:
  rhythm: "4px"
  primarySteps: "8px, 12px, 16px, 24px, 32px"
---

# JobCtrl Interface Standard

JobCtrl is a local-first workspace for consequential work. Its interface is calm,
readable, compact without being cramped, and clear about evidence and lifecycle.
The shared visual system applies across the application while preserving existing
routes, controls, drafts and workflow contracts. It uses the existing Base UI
behavior primitives, shared wrappers, semantic tokens and Tabler icons.

## Foundations

- **Color:** Graphite is the default light scheme: a pale canvas, white surfaces,
  readable dark ink, restrained borders and a modest graphite accent. Accent is
  used for primary actions, focus and selection; avoid large decorative fills.
  Ten selectable color schemes map to the same semantic roles. Dark mode remaps
  those roles to dark surfaces and readable text rather than changing meaning.
- **Type:** Geist is the default workspace font. Ten bundled font schemes can be
  selected in Settings → Appearance. Body and data values remain 14px; labels
  use a semibold 14px role, with 12px reserved for supporting metadata. Page
  headings are 28px and section headings 18px. Font and color choices never
  override the independently owned resume document template.
- **Shape:** Use restrained 6–8px radii for shared controls and panels, thin
  borders, and minimal resting shadow. Circular shapes are appropriate for
  intrinsically circular controls and swatches.
- **Density:** Compact, regular and comfy alter geometry, never reading size.
  Typical desktop controls are 32–36px; coarse-pointer mobile controls use a
  44px target. Rows and panels retain the user's selected density.
- **Layout:** The main workspace uses available width; constrain long prose for
  comfortable reading instead of constraining the entire application. Responsive
  layouts stack or reflow on narrow screens without page-level overflow.
- **Status:** Success, warning, failure and informational cues have semantic
  tokens and readable text or icons. Never depend on color alone; unknown,
  blocked, stale and failed states retain their reasons and recovery actions.
- **Elevation:** Panels use quiet borders. Overlays may use stronger elevation
  to communicate that they sit above the workspace.

Appearance choices apply immediately and are saved in browser-local UI
preferences. Existing light/dark, density and sidebar preferences remain
independent; restoring the default color and font does not reset them. The
bundled workspace fonts and their notices are in
`apps/web/src/assets/appearance-fonts/`; Geist and JetBrains Mono are installed
as fontsource dependencies.

## Ownership layers

1. **Tokens** — color, type, spacing, radius, density and motion in
   `apps/web/src/styles/tokens.css` and appearance scheme mappings.
2. **Primitives** — shared controls in `apps/web/src/shared/ui/`; Base UI owns
   behavior where needed.
3. **Domain components** — score, stage, source, evidence, artifact, apply
   decision and lifecycle displays.
4. **Page compositions** — overview, data index, decision, operations,
   configuration and route-backed detail workspaces.
5. **Routes** — compose domain interfaces without redefining shared treatments.

## Composition and controls

- Give each page a clear title, useful context and actions near the work they
  affect. Keep full workspaces available for route-backed details.
- Use panels for meaningful grouping and avoid decorative nesting or a card for
  every datum. Use thin dividers and clear text hierarchy to scan related work.
- Choose one primary action per region. Secondary actions use quiet surfaces and
  borders. Consequential actions retain their existing review and recovery rules.
- Tabs and navigation show the active location through a restrained accent and a
  visible state, with accessible names and keyboard focus.
- Forms use clear labels, compact controls and grids that adapt to available
  space. Keep valid input and the last accepted result when a refresh fails.
- Tables preserve useful column widths and readable values. Wide intrinsic
  content may scroll inside its own container; record tables can reflow on small
  screens while retaining sorting and filtering.
- Keep supporting explanations near the decision and constrain long text, not
  the whole workspace.

## State and accessibility

Every asynchronous composite defines loading, empty, populated, refreshing,
error and disabled states. Refreshing retains reviewable truth, disabled
controls explain missing prerequisites, and meaningful status includes its
source and lifecycle when available. Focus remains visible. Controls support
keyboard and touch, responsive reflow stays readable, and state is not conveyed
by color alone.

Before declaring a shared visual change complete, inspect representative dense,
editing and secondary surfaces at desktop and mobile widths, including light and
dark themes and actual bundled fonts. Check task behavior and document geometry
separately from visual craft.
