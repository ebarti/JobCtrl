# Phase 8: Layout Chrome, Fonts, And Tabler Icons - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-06-10
**Phase:** 8-layout-chrome-fonts-and-tabler-icons
**Areas discussed:** shell shape, typography and density, icon migration, behavior and safety

---

## Shell Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve current chrome | Keep the existing topbar, nav labels, brand, search, density, theme, and connection controls while improving token/readability treatment. | yes |
| Redesign navigation | Reorganize routes, add grouping, or change the IA. | |
| Marketing-style shell | Make the app shell more expressive/hero-like. | |

**User's choice:** Auto-selected from roadmap and prior clean-slate decisions.
**Notes:** Phase 8 is a visual-system migration, not a route or workflow redesign.

---

## Typography And Density

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve existing seams | Use the existing Fontsource imports, `jh:ui-preferences` persistence, and `.app-shell[data-density]` density seam. | yes |
| Change persistence shape | Rewrite the theme/density store or pre-paint script. | |
| New density mechanism | Replace the current data attribute seam with a new responsive-only mechanism. | |

**User's choice:** Auto-selected from Phase 6 and Phase 7 context.
**Notes:** Density and theme persistence are behavior surfaces and must remain stable.

---

## Icon Migration

| Option | Description | Selected |
|--------|-------------|----------|
| Migrate visible icons | Replace user-visible lucide imports with Tabler equivalents and preserve labels/dimensions. | yes |
| Leave mixed icon libraries silently | Keep lucide usage without documenting mappings. | |
| Regenerate all primitives | Use broad shadcn regeneration to change icons. | |

**User's choice:** Auto-selected from Phase 8 success criteria and Phase 6 `components.json` Tabler target.
**Notes:** Any lucide retention must be explicit and justified in the Phase 8 evidence.

---

## Behavior And Safety

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve behavior | Keep route search, theme/density persistence, SSE status, query/mutation behavior, and local-first safety unchanged. | yes |
| Couple visual work to workflow changes | Use the phase to alter navigation, workflows, or domain behavior. | |
| Run live workflow QA | Use worker-backed jobs or user-affecting automation to prove chrome changes. | |

**User's choice:** Auto-selected from roadmap, AGENTS.md safety rules, and prior phase context.
**Notes:** Browser proof should use synthetic or seeded data only.

---

## the agent's Discretion

- Exact Tabler icon equivalents.
- Exact plan split across shell tokens, icon migration, tests, and browser proof.
- Exact focused tests, as long as behavior and accessibility are proven.

## Deferred Ideas

- Domain/status tone remapping: Phase 9.
- Route-wide visual QA and Storybook/a11y hardening: Phase 10.
- Dead CSS and unused dependency cleanup: Phase 11.
