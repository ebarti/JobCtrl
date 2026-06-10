---
phase: 07
slug: shared-primitive-token-migration
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-10
---

# Phase 07 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.5, Testing Library, jest-axe, Storybook 10.3.6, Storybook test-runner 0.24.3, Playwright 1.59.1 |
| **Config file** | `apps/web/vitest.config.ts`, `apps/web/vitest.types.config.ts`, `apps/web/.storybook/main.ts`, `apps/web/.storybook/preview.tsx`, `apps/web/e2e/playwright.config.ts` |
| **Quick run command** | `corepack pnpm --filter @jobhunter/web test src/shared/ui/filterable-data-grid.test.tsx` plus any newly added shared/ui test file |
| **Full suite command** | `corepack pnpm web:check`; `corepack pnpm web:storybook:build`; `corepack pnpm web:storybook:test`; targeted Playwright only when needed |
| **Estimated runtime** | ~30-180 seconds for scoped tests and typecheck; Storybook/browser gates may run longer |

---

## Sampling Rate

- **After every task commit:** Run the scoped shared/ui test command for touched files and `corepack pnpm web:check` when source types changed.
- **After every plan wave:** Run the corrected token scan, dependency-boundary scan, relevant shared/ui tests, and Storybook build/test when stories changed.
- **Before verification:** Run the Phase 7 full verification command set from `07-UI-SPEC.md`.
- **Max feedback latency:** Keep unit-test feedback under 180 seconds; defer Storybook/browser proof to wave and phase gates unless a task specifically changes overlay/focus/density behavior.

---

## Per-Requirement Verification Map

| Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|-----------------|-----------|-------------------|-------------|--------|
| PRIM-01 | Shared/ui, Storybook, and config surfaces do not reintroduce legacy token utilities or direct legacy token variables. | static scan | corrected Node token scanner over `apps/web/src/shared/ui`, `apps/web/.storybook`, and relevant story/config files | yes, command-based | pending |
| PRIM-02 | Overlay/menu/select/popover/dialog/toast open states remain readable in light and dark themes with visible focus states. | Storybook, a11y, optional browser proof | `corepack pnpm web:storybook:build`; `corepack pnpm web:storybook:test`; targeted Playwright when changed code cannot be proven by Storybook | partial stories exist | pending |
| PRIM-03 | Form, table/data-grid, card, badge, tab, checkbox, switch, skeleton, separator, and scroll-area primitives preserve behavior and accessibility. | unit, a11y, story | scoped `corepack pnpm --filter @jobhunter/web test src/shared/ui/<file>.test.tsx` for each changed high-risk primitive | partial | pending |
| PRIM-04 | Changed primitives expose default, disabled, focus, destructive, loading/empty, and open states where relevant. | Storybook and a11y gate | `corepack pnpm web:storybook:test` plus story review for changed primitives | partial | pending |
| PRIM-05 | Shared primitives do not gain domain, query, API, SSE, local-storage, route, or view dependencies. | static scan | dependency-boundary scanner over `apps/web/src/shared/ui` with existing `MarkdownDocument.tsx` exception held constant | yes, command-based | pending |

---

## Wave 0 Requirements

- [ ] `apps/web/src/shared/ui/data-table.test.tsx` - add behavior/a11y proof if `data-table.tsx` is changed, especially sortable header semantics and Enter/Space row activation.
- [ ] `apps/web/src/shared/ui/toast.a11y.test.tsx` - add close/action accessible-name proof if `toast.tsx` is changed.
- [ ] `apps/web/src/shared/ui/filterable-data-grid.test.tsx` - extend existing coverage for row activation, focus, page size, or pager disabled behavior if touched.
- [ ] Changed shared/ui stories - add per-state coverage for default, disabled, focus/open, destructive, loading, empty, and selected states as applicable.
- [ ] Static scans - codify or run deterministic token and dependency-boundary scans at wave and phase gates.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Primitive visual priority review | PRIM-02, PRIM-04 | Storybook can automate a11y checks, but final visual priority/readability still needs human review when overlays or dense table controls change. | Inspect the shared primitive Storybook surface, prioritizing open overlay readability, focus-visible rings, and dense table controls in light and dark modes. |

All other Phase 7 behaviors must have automated checks or an explicit documented reason in the plan summary.

---

## Validation Sign-Off

- [x] All phase requirements have automated verification or Wave 0 dependencies.
- [x] Sampling continuity: no three consecutive implementation tasks may skip automated verification.
- [x] Wave 0 covers missing shared/ui test and a11y proof references.
- [x] No watch-mode flags are used in verification commands.
- [x] Feedback latency target is documented.
- [x] `nyquist_compliant: true` is set in frontmatter.

**Approval:** approved 2026-06-10
