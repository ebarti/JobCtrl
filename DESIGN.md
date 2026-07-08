---
version: alpha
name: JobCtrl
description: Local-first, AI-assisted job application pipeline with a calm operational UI.

colors:
  background: "oklch(0.967 0.003 264.542)"
  foreground: "oklch(0.145 0 0)"
  card: "oklch(1 0 0)"
  card-foreground: "oklch(0.145 0 0)"
  popover: "oklch(1 0 0)"
  popover-foreground: "oklch(0.145 0 0)"
  primary: "oklch(0.541 0.281 293.009)"
  primary-foreground: "oklch(0.985 0.006 293)"
  secondary: "oklch(0.967 0.001 286.375)"
  secondary-foreground: "oklch(0.21 0.006 285.885)"
  muted: "oklch(0.97 0 0)"
  muted-foreground: "oklch(0.535 0 0)"
  accent: "oklch(0.943 0.029 294.588)"
  accent-foreground: "oklch(0.541 0.281 293.009)"
  destructive: "oklch(0.577 0.245 27.325)"
  border: "oklch(0.928 0.006 264.531)"
  input: "oklch(0.928 0.006 264.531)"
  ring: "oklch(0.541 0.281 293.009 / 0.36)"
  success: "oklch(0.54 0.13 145)"
  success-foreground: "oklch(0.985 0 0)"
  warning: "oklch(0.72 0.15 72)"
  warning-foreground: "oklch(0.145 0 0)"
  status-info: "oklch(0.56 0.11 242)"
  status-info-foreground: "oklch(0.985 0 0)"
  chart-1: "oklch(0.541 0.281 293.009)"
  chart-2: "oklch(0.606 0.25 292.717)"
  chart-3: "oklch(0.702 0.183 293.541)"
  chart-4: "oklch(0.811 0.111 293.571)"
  chart-5: "oklch(0.894 0.057 293.283)"
  sidebar: "oklch(1 0 0 / 0.84)"
  sidebar-foreground: "oklch(0.145 0 0)"
  sidebar-primary: "oklch(0.541 0.281 293.009)"
  sidebar-primary-foreground: "oklch(0.985 0.006 293)"
  sidebar-accent: "oklch(0.943 0.029 294.588)"
  sidebar-accent-foreground: "oklch(0.541 0.281 293.009)"
  sidebar-border: "oklch(0.928 0.006 264.531)"
  brand-navy: "#1F2937"
  brand-violet: "#7C3AED"
  brand-violet-start: "#8B5CF6"
  brand-violet-end: "#6D28D9"
  brand-violet-layer: "#DDD6FE"
  brand-violet-layer-deep: "#C4B5FD"
  brand-amber: "#F59E0B"
  brand-green: "#10B981"
  brand-surface: "#F3F4F6"

typography:
  display:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 48px
    fontWeight: 800
    lineHeight: "1.05"
    letterSpacing: "0em"
  h1:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 32px
    fontWeight: 800
    lineHeight: "1.15"
    letterSpacing: "0em"
  h2:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 22px
    fontWeight: 700
    lineHeight: "1.2"
    letterSpacing: "0em"
  card-title:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 15px
    fontWeight: 700
    lineHeight: "1.25"
    letterSpacing: "0em"
  body:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 13px
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
    fontWeight: 800
    lineHeight: "1"
    letterSpacing: "0.01em"
  button:
    fontFamily: "Plus Jakarta Sans Variable"
    fontSize: 13px
    fontWeight: 750
    lineHeight: "1"
    letterSpacing: "0em"
  mono:
    fontFamily: "JetBrains Mono Variable"
    fontSize: 12px
    fontWeight: 500
    lineHeight: "1.45"
    letterSpacing: "0em"

rounded:
  xs: 3px
  sm: 5px
  md: 6px
  lg: 8px
  xl: 11px
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
    rounded: "{rounded.lg}"
    padding: 12px
  side-rail-active-item:
    backgroundColor: "{colors.sidebar-accent}"
    textColor: "{colors.sidebar-accent-foreground}"
    rounded: "{rounded.md}"
    padding: 8px
  brand-lockup:
    backgroundColor: "{colors.card}"
    textColor: "{colors.brand-navy}"
    typography: "{typography.h1}"
  brand-glyph:
    backgroundColor: "{colors.brand-violet-layer}"
    textColor: "{colors.brand-violet-end}"
    rounded: "{rounded.lg}"
    size: 32px
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.lg}"
    padding: 16px
  card-header:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    typography: "{typography.card-title}"
    padding: 16px
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 36px
  button-secondary:
    backgroundColor: "{colors.secondary}"
    textColor: "{colors.secondary-foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 36px
  button-quiet:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.md}"
    padding: 8px
    height: 32px
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: 10px
    height: 36px
  focus-ring:
    backgroundColor: "{colors.ring}"
  badge-success:
    backgroundColor: "{colors.success}"
    textColor: "{colors.success-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: 8px
  badge-warning:
    backgroundColor: "{colors.warning}"
    textColor: "{colors.warning-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: 8px
  badge-info:
    backgroundColor: "{colors.card}"
    textColor: "{colors.status-info}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: 8px
  badge-danger:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label}"
    rounded: "{rounded.full}"
    padding: 8px
  chart-series-1:
    backgroundColor: "{colors.chart-1}"
  chart-series-2:
    backgroundColor: "{colors.chart-2}"
  chart-series-3:
    backgroundColor: "{colors.chart-3}"
  chart-series-4:
    backgroundColor: "{colors.chart-4}"
  chart-series-5:
    backgroundColor: "{colors.chart-5}"
  popover:
    backgroundColor: "{colors.popover}"
    textColor: "{colors.popover-foreground}"
    rounded: "{rounded.lg}"
    padding: 8px
  muted-copy:
    textColor: "{colors.muted-foreground}"
    typography: "{typography.body-sm}"
  divider:
    backgroundColor: "{colors.border}"
    height: 1px
  input-border:
    backgroundColor: "{colors.input}"
    height: 1px
  side-rail-primary-action:
    backgroundColor: "{colors.sidebar-primary}"
    textColor: "{colors.sidebar-primary-foreground}"
    rounded: "{rounded.md}"
    padding: 8px
  side-rail-divider:
    backgroundColor: "{colors.sidebar-border}"
    height: 1px
  brand-violet-swatch:
    backgroundColor: "{colors.brand-violet}"
  brand-violet-gradient-start:
    backgroundColor: "{colors.brand-violet-start}"
  brand-violet-layer-deep:
    backgroundColor: "{colors.brand-violet-layer-deep}"
  brand-stage-amber:
    backgroundColor: "{colors.brand-amber}"
  brand-stage-green:
    backgroundColor: "{colors.brand-green}"
  brand-surface-panel:
    backgroundColor: "{colors.brand-surface}"
    textColor: "{colors.brand-navy}"
    rounded: "{rounded.lg}"
    padding: 16px
  status-info-solid-swatch:
    backgroundColor: "{colors.status-info-foreground}"
  chart-label:
    textColor: "{colors.foreground}"
    typography: "{typography.label}"
---

## Overview

JobCtrl is a local-first operations console for finding jobs, judging fit,
generating audited application materials, and applying only behind explicit
approval gates. The design system should feel focused, private, reliable, and
slightly optimistic. It is a productivity surface, not a marketing splash:
prioritize scanability, evidence, workflow status, and controls that stay calm
under dense data.

The brand expression is a layered violet checkmark over stacked planes. The
checkmark means progress and completion; the layers mean organized stages and
traceable workflow. Use the tagline exactly as:

Plan. Apply. Track. Succeed.

Brand assets in this repository:

- `docs/assets/brand/lockup-primary.png` - full-color lockup with icon,
  wordmark, and tagline for large brand moments.
- `docs/assets/brand/lockup-horizontal.png` - wide horizontal lockup with
  divider and tagline for broad headers, docs, and presentation contexts.
- `docs/assets/brand/app-icon.png` - square app icon artwork for docs, launch
  surfaces, social previews, and compact empty states.
- `docs/assets/brand/lockup-mono.png` - single-color lockup for print,
  embossing, reduced-color contexts, and high-contrast fallback.
- `apps/web/public/favicon.svg` and `apps/web/public/apple-touch-icon.png` -
  runtime browser icons derived from the brand mark. Keep runtime icons in the
  web public directory rather than using documentation lockups directly.

## Colors

The implemented app uses semantic CSS tokens in `apps/web/src/styles/tokens.css`.
The front matter above mirrors those values so generation tools can use the
same decisions. Use semantic tokens first; use brand hex tokens only when
creating brand artwork, illustrations, docs visuals, or marketing lockups.

- `primary` / `brand-violet` drives key actions, active navigation, focus
  affordances, and the accented `Ctrl` in the wordmark.
- `brand-navy` is the wordmark and headline anchor. It should feel precise and
  operational.
- `background`, `card`, `muted`, `border`, and `input` create the light,
  off-white product shell. Avoid pure gray slabs unless they are semantic
  disabled states.
- `success`, `warning`, `status-info`, and `destructive` communicate workflow
  state. Do not reuse them as decorative accents.
- `brand-amber` and `brand-green` come from the proposal board and may support
  job-stage counters or diagrams, but production UI should prefer the semantic
  status tokens.

Dark mode follows the same semantic names with darker values in
`tokens.css`. Do not invent separate component behavior for dark mode; switch
the token values and keep spacing, typography, and hierarchy stable.

## Typography

Use Plus Jakarta Sans Variable for the entire product interface and brand
wordmark. It gives JobCtrl a modern, technical, and approachable tone without
looking like a consumer social app. Use JetBrains Mono Variable only for code,
IDs, file paths, JSON, logs, and other developer-facing literals.

Headings should be confident but compact. Inside dashboards, cards, drawers,
and tables, avoid oversized display type; reserve display scale for onboarding,
docs hero graphics, or one-off brand surfaces. Letter spacing is `0em` for new
UI unless matching the existing CSS wordmark or a tested component contract.

## Layout

JobCtrl is a repeated-use work tool. Build layouts as dense, organized
operational surfaces:

- Keep the left rail persistent for primary navigation.
- Use full-width work areas with constrained content only where readability
  needs it.
- Put evidence, audit trails, status, and next actions near the data they
  explain.
- Prefer tables, drawers, split panes, timelines, and compact panels over
  oversized cards.
- Use 8px as the default spacing rhythm, with 12px and 16px for card internals
  and toolbars.
- Keep row heights stable: regular 40px, compact 32px, comfy 48px.

Never nest decorative cards inside other cards. A repeated item may be a card;
a page section should be an unframed layout or a full-width band.

## Elevation & Depth

Depth is quiet and functional. Use one soft panel shadow for cards and floating
surfaces:

`0 12px 34px rgb(31 41 55 / 0.08)`

Use borders more often than shadows. Shadows should indicate a real surface
relationship: panels, drawers, menus, popovers, previews, and modal surfaces.
Do not use glow effects or decorative gradient blobs.

The brand glyph can retain its layered translucent violet planes in brand
artwork. In the product UI, keep those layers small and symbolic rather than
turning them into page backgrounds.

## Shapes

The base radius is 8px (`0.5rem`). Most product UI should use 5px, 6px, or 8px.
Use full pills only for compact badges, status tags, and count chips. Large
rounded rectangles should be rare; the app should feel precise, not bubbly.

Icon buttons and compact controls should have stable square dimensions so hover
states and label changes never shift layout. Inputs and buttons should align to
the same height within a toolbar.

## Components

Buttons:

- Primary buttons use `primary` on `primary-foreground` and are reserved for
  committing the main action in the current workflow.
- Secondary buttons use `secondary` on `secondary-foreground`.
- Quiet buttons use `accent` on `accent-foreground` for local controls,
  filters, low-risk actions, and active affordances.
- Dangerous actions use `destructive`; never make destructive actions visually
  equivalent to primary actions.

Cards and panels:

- Cards use `card`, `card-foreground`, `border`, `radius.lg`, and the panel
  shadow.
- Card headers may use `muted` to separate controls from content.
- Drawers and detail panels should keep audit evidence visible with the action
  that depends on it.

Navigation:

- The side rail uses `sidebar` tokens, compact Tabler icons, and a small
  lockup.
- Active navigation uses the violet `accent` family, not green or amber.
- Keep labels short. Tooltips may clarify icon-only collapsed states.

Status:

- Success means completed, accepted, validated, or safe.
- Warning means needs review, policy concern, budget risk, or residual issue.
- Info means queued, running, neutral progress, or inspected evidence.
- Destructive means failed, blocked, exhausted, deleted, or unsafe.

Data grids:

- Keep columns scannable and avoid inline prose.
- Use badges for stage/state/status, not color-only text.
- Filters and saved views should look like controls, not content cards.

Brand:

- Use `docs/assets/brand/app-icon.png` for compact icon contexts outside the
  running web app.
- Use `apps/web/public/favicon.svg` and `apps/web/public/apple-touch-icon.png`
  only for browser/runtime icon delivery.
- Use the wordmark with `Job` in navy and `Ctrl` in violet.
- Do not recolor the full-color brand mark outside the approved violet range.
- Use the monochrome mark only when the medium cannot support color or contrast
  requires it.

## Do's and Don'ts

Do:

- Use semantic tokens from `tokens.css` for implementation.
- Keep pages quiet, dense, and built for repeated operational use.
- Keep audit evidence, source context, and approval controls visible together.
- Use Tabler icons for product UI controls.
- Use violet for brand and primary workflow emphasis.
- Use green, amber, blue, and red only for status semantics.
- Preserve the local-first and safety-first tone in empty states and warnings.

Don't:

- Do not create marketing-style hero pages inside the app shell.
- Do not use decorative violet gradients as page backgrounds.
- Do not make broad beige, dark-slate, or one-note purple screens.
- Do not hide failed, blocked, or residual-warning states behind neutral labels.
- Do not use color alone to communicate status.
- Do not stretch the icon, alter the checkmark angle, or rebuild the logo from
  unrelated iconography.
- Do not replace product evidence with generic motivational copy.
