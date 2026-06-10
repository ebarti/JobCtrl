# Phase 7: Shared Primitive Token Migration - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-06-10
**Phase:** 7-Shared Primitive Token Migration
**Mode:** Auto-discussed via `$gsd-autonomous`
**Areas discussed:** Primitive scope, Coverage strategy, Density and focus behavior, Safety boundary

---

## Primitive Scope

| Option | Description | Selected |
|--------|-------------|----------|
| Harden existing primitives | Start from Phase 6's grep-clean shared/ui token foundation and improve behavior/state proof. | yes |
| Regenerate primitives | Run broad shadcn generation or replacement over shared/ui. | |
| Redesign primitives | Change visual language and product interaction shape. | |

**Auto choice:** Harden existing primitives.
**Notes:** Phase 6 already established the clean token foundation. Phase 7 should preserve exports, props, Radix behavior, and domain boundaries.

---

## Coverage Strategy

| Option | Description | Selected |
|--------|-------------|----------|
| Risk-based tests plus stories | Add tests/a11y checks where they prove behavior; use Storybook for variants and open states. | yes |
| Snapshot every primitive | Add broad snapshots of copied shadcn internals. | |
| Browser-only validation | Rely on route smoke without colocated primitive proof. | |

**Auto choice:** Risk-based tests plus stories.
**Notes:** Modern accessibility guidance and repo QA docs favor semantic behavior, accessible names, focus, keyboard paths, and Storybook/a11y gates over pixel-perfect snapshots.

---

## Density And Focus Behavior

| Option | Description | Selected |
|--------|-------------|----------|
| Preserve data-density seam | Keep core density on `.app-shell[data-density]` and `--jh-row-height`; verify focus/keyboard behavior explicitly. | yes |
| Adopt container style queries as core | Use style queries for primitive density behavior. | |
| Ignore density until route QA | Defer primitive density proof to later route-level QA. | |

**Auto choice:** Preserve data-density seam.
**Notes:** Modern token-reactivity guidance says container style queries are not baseline across Firefox, so they should not be the only core density path.

---

## Safety Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Synthetic/seeded proof only | Use Storybook fixtures, RTL tests, and seeded Playwright paths without user-affecting automation. | yes |
| Real local data proof | Use the user's current application/profile/material data for visual proof. | |
| Worker-backed proof | Trigger real worker/material/apply flows as part of primitive QA. | |

**Auto choice:** Synthetic/seeded proof only.
**Notes:** This follows AGENTS.md and docs/local-reliability-qa.md. Phase 7 must not expose sensitive data or trigger auto-apply/material-generation/destructive workflows.

---

## the agent's Discretion

- The planner may decide the exact plan split and whether table/data-grid hardening should be separate from overlay/form primitive hardening.
- The planner may choose the minimum useful mix of Storybook states, RTL tests, a11y tests, and browser proof that satisfies `PRIM-01` through `PRIM-05`.

## Deferred Ideas

- Tabler icon migration: Phase 8.
- Domain/status tone mapping: Phase 9.
- Route-wide visual QA/a11y hardening: Phase 10.
- Final global cleanup and unused dependency removal: Phase 11.
