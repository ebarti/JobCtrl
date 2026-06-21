---
phase: 22
slug: product-path-qa-safety-release
status: approved
shadcn_initialized: true
preset: radix-luma
created: 2026-06-21
approved: 2026-06-21
---

# Phase 22 — UI Design Contract

> Visual and interaction contract for frontend QA work in Phase 22. This phase verifies existing Jobs compensation states; it does not authorize a new visual direction.

---

## Design System

| Property | Value |
|----------|-------|
| Tool | shadcn-compatible copied primitives |
| Preset | `radix-luma` from `apps/web/components.json` |
| Component library | Radix/shadcn-style primitives under `apps/web/src/shared/ui` |
| Icon library | Tabler (`iconLibrary: "tabler"`) |
| Font | Geist Variable for UI text; JetBrains Mono Variable for code/compact technical labels |

---

## Spacing Scale

Declared values:

| Token | Value | Usage |
|-------|-------|-------|
| xs | 3-4px | Compact table metadata and code/message stacks |
| sm | 6-8px | Inline tags, compensation table cell rows, detail grid gaps |
| md | 10-12px | Compensation strips, panels, drawer evidence groups |
| lg | 16px | Drawer section content where the surrounding shell already uses it |
| xl | 24px | Drawer shell padding inherited from existing layout |
| 2xl | 48px | Page-level spacing only if existing layout already uses it |
| 3xl | 64px | Not expected for Phase 22 QA work |

Exceptions: Phase 22 reuses the existing drawer, section, tag, table, and compensation evidence spacing system rather than adding a parallel spacing primitive set.

---

## Typography

| Role | Size | Weight | Line Height |
|------|------|--------|-------------|
| Body | 13px | 400 | existing app default |
| Label | 12px | 500-600 | compact, readable labels |
| Heading | 16px | 600 | drawer section headings |
| Display | Not applicable | Not applicable | Do not add hero/display text |

Long compensation state text must wrap within drawer panels and table cells without overlapping adjacent content. Do not scale font size with viewport width.

---

## Color

| Role | Value | Usage |
|------|-------|-------|
| Dominant (60%) | `--background`, `--card`, `--foreground` | Page, drawer, table, and default text |
| Secondary (30%) | `--muted`, `--muted-foreground`, `--border` | Empty/missing states, evidence metadata, separators |
| Accent (10%) | `--warning`, `--warning-muted`, `--status-info` | Warning-only compensation evidence, source/confidence emphasis |
| Destructive | `--destructive` | Destructive actions only; not used for salary warnings |

Accent reserved for: compensation warning counts, warning-only copy, source-quality emphasis, and existing status tags. Salary warnings must not visually look like hard blockers or destructive errors.

---

## Copywriting Contract

| Element | Copy |
|---------|------|
| Primary CTA | No new CTA. Keep existing Jobs row `Open job ...` affordance and existing Apply Review controls unchanged. |
| Empty state heading | `No compensation evidence recorded.` |
| Empty state body | Not shown in the compact merged drawer state. |
| Warning-only boundary | Source-conflict warning code/message stays inside Compensation evidence and out of ranking, filters, apply readiness, blockers, Apply Review concerns, and dispatch controls. |
| Missing posted state | `No posted salary recorded` |
| Unparseable posted state | `Posted salary unparseable` |
| Ambiguous posted state | `Posted salary ambiguous` |
| Market unsupported state | `Market estimate unsupported` |
| Market insufficient state | `Insufficient market evidence` |
| Market unavailable state | `Market source unavailable` |
| Market not requested state | `Market estimate not requested` |
| Destructive confirmation | Not applicable. Phase 22 must not introduce destructive UI actions. |

Copy must keep compensation evidence audit-focused and avoid implying automatic rejection, ranking, filtering, or apply gating.

---

## Interaction Contract

- Jobs list compensation remains a single display-only `Compensation` column that summarizes range, source, confidence, source/sample counts, and warning count.
- Compensation remains display-only. Do not add sort buttons, filters, route search fields, query parameters, ranking controls, or bulk actions for compensation.
- Narrow/mobile widths keep the existing horizontal table scroll instead of adding a mobile-only compensation control.
- Jobs drawer `Compensation` evidence stays immediately after `Why this job is here` and before `Description`.
- Source trail, confidence factors, and assumptions stay progressively disclosed so the drawer remains scannable.
- Missing, unsupported, unavailable, insufficient-evidence, source-conflict, and warning-only states must be visible or accessible by label/title where a compact dash is shown.
- Compensation warning labels stay inside the compensation audit surface and must not appear in Apply concerns, missing prerequisites, hard blockers, fit-score explanations, readiness controls, or dispatch/apply controls.

---

## Registry Safety

| Registry | Blocks Used | Safety Gate |
|----------|-------------|-------------|
| shadcn official | none expected | not required |
| third-party registry | none allowed | do not add third-party UI blocks for Phase 22 |

Phase 22 should not install UI packages, import registry blocks, or add icon libraries.

---

## Checker Sign-Off

- [x] Dimension 1 Copywriting: PASS
- [x] Dimension 2 Visuals: PASS
- [x] Dimension 3 Color: PASS
- [x] Dimension 4 Typography: PASS
- [x] Dimension 5 Spacing: PASS
- [x] Dimension 6 Registry Safety: PASS

**Approval:** approved 2026-06-21
