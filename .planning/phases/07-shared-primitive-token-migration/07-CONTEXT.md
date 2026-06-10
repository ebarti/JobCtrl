# Phase 7: Shared Primitive Token Migration - Context

**Gathered:** 2026-06-10
**Status:** Ready for planning
**Mode:** Auto-discussed via `$gsd-autonomous`

<domain>
## Phase Boundary

Phase 7 hardens the shared primitive layer on top of the completed Phase 6 shadcn token foundation. It owns shared UI primitive behavior, semantic utility coverage, Storybook/test/a11y proof, open overlay states, stable dimensions, disabled/focus states, and the domain-agnostic boundary of `apps/web/src/shared/ui`.

This phase does not create new product workflows, change routes, change API/SSE/query behavior, change domain status semantics, replace the token foundation, run uncontrolled `shadcn apply`, or migrate visible app-shell iconography. Those remain Phase 8+ work.

</domain>

<decisions>
## Implementation Decisions

### Primitive Scope Shape
- **D-01:** Treat Phase 7 as primitive hardening and coverage, not a second token-foundation phase. Phase 6 already made `apps/web/src/shared/ui` grep-clean for legacy token names and direct semantic CSS variable references.
- **D-02:** Keep all primitive edits behavior-preserving. Exports, props, Radix wiring, keyboard behavior, ARIA semantics, focus management, portals, animations, and stable dimensions must not change unless a test proves the current behavior is wrong.
- **D-03:** Do not run uncontrolled full `shadcn apply` or regenerate primitives wholesale. Use local mechanical edits, targeted tests, and Storybook states.
- **D-04:** Keep `shared/ui` domain-agnostic. It must not import contexts, views, API clients, query hooks, domain status helpers, local storage, EventSource, or route modules.
- **D-05:** Do not migrate visible lucide app iconography in this phase. `components.json` targets Tabler for future generated output, but visible icon migration belongs to Phase 8 unless a primitive test/story needs a local decorative icon fixture.

### Coverage Priority
- **D-06:** Focus first on high-risk primitive surfaces: `filterable-data-grid`, `data-table`, `table-pager`, dialog/sheet/drawer/dropdown/select/popover/command/tooltip/toast open states, and form controls. These combine keyboard behavior, focus, data density, or overlay readability.
- **D-07:** Storybook coverage should be per-state/per-variant, not decorative. Required states include default, disabled, focus/keyboard-reachable, destructive where applicable, loading/empty where applicable, and open overlay/menu/select/popover/dialog states.
- **D-08:** Add colocated `*.test.ts(x)` or `*.a11y.test.tsx` only where they prove behavior or accessibility that Storybook cannot prove cheaply. Do not snapshot shadcn/Radix internals just to increase file count.
- **D-09:** Use synthetic story/test data only. Do not include real profile data, resumes, generated PDFs, browser profiles, local DB content, application logs, job URLs, API keys, OAuth tokens, or other sensitive data.

### Accessibility And Density
- **D-10:** Follow current web accessibility guidance: prefer native elements over ARIA, keep accessible names/descriptions explicit, keep visible focus indicators, avoid `aria-hidden` on focusable elements, avoid positive `tabindex`, and verify keyboard paths for custom row/menu/filter interactions.
- **D-11:** Keep density behavior on the existing `.app-shell[data-density]` and `--jh-row-height` seam. Do not rely on container style queries as the only implementation path for core density behavior because Firefox support is not baseline.
- **D-12:** Overlay and menu primitives must stay readable in light and dark modes over dense content with visible boundaries/focus rings. Use standard shadcn semantic utility classes (`bg-popover`, `text-popover-foreground`, `border-border`, `ring-ring`, `bg-accent`, `text-accent-foreground`, `text-muted-foreground`, `bg-muted`) rather than introducing new token names.
- **D-13:** If an existing story disables a11y checks for a production defect, keep the deferral only when it is already tracked in `docs/backlog.md`. Any new serious/critical axe deferral requires a backlog entry per repo policy.

### Verification Contract
- **D-14:** Phase 7 verification must include `corepack pnpm web:check`, relevant colocated web tests, Storybook build, Storybook test runner where changed stories are covered, a shared/ui token-boundary scan, and targeted browser/Playwright proof for open overlays or keyboard focus where unit/story tests are insufficient.
- **D-15:** The full `corepack pnpm --filter @jobhunter/web test` command currently has known unrelated inline snapshot runner failures when invoked broadly. The planner should either fix that test-hygiene issue if it becomes required for Phase 7 completion, or document scoped verification and preserve the existing failure as unrelated carry-forward evidence.
- **D-16:** If E2E/browser proof is required, use the seeded Playwright harness or a disposable synthetic workspace. Do not run auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs.

### the agent's Discretion
- The planner may decide the exact split between stories, unit tests, a11y tests, and browser proof, as long as every Phase 7 requirement has evidence and no primitive behavior regresses.
- The planner may choose whether table/data-grid hardening is one plan or multiple plans based on dependency ordering and verification cost.
- The planner may add narrow helper test fixtures if they reduce duplication and stay under `apps/web/src/shared/ui` or existing test utilities.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone And Prior Phase
- `.planning/PROJECT.md` - Current milestone goal, clean-slate token migration constraints, and validated v1.0 context.
- `.planning/REQUIREMENTS.md` - Phase 7 requirements `PRIM-01` through `PRIM-05` and milestone-wide safety boundaries.
- `.planning/ROADMAP.md` - Phase 7 goal, success criteria, dependencies, and verification expectations.
- `.planning/STATE.md` - Current v1.1 state and completed Phase 6 decisions.
- `.planning/phases/06-token-foundation-shadcn-preset-contract/06-CONTEXT.md` - Clean-slate token decisions and forbidden compatibility-bridge handoff.
- `.planning/phases/06-token-foundation-shadcn-preset-contract/06-VERIFICATION.md` - Evidence that Phase 6 token foundation and legacy-token exit state passed.
- `.planning/phases/06-token-foundation-shadcn-preset-contract/06-04-SUMMARY.md` - Core primitive semantic utility migration summary.
- `.planning/phases/06-token-foundation-shadcn-preset-contract/06-05-SUMMARY.md` - Overlay/menu primitive semantic utility migration summary.
- `.planning/phases/06-token-foundation-shadcn-preset-contract/06-06-SUMMARY.md` - Final token-foundation browser proof and docs gate.

### Frontend Architecture And QA
- `AGENTS.md` - Repo workflow rules, frontend conventions, QA expectations, and sensitive-data restrictions.
- `docs/frontend-target.md` - shadcn/Radix primitive ownership, Tailwind CSS 4 token target, Storybook/testing strategy, and shared UI boundaries.
- `docs/local-reliability-qa.md` - Frontend QA pyramid, Storybook/a11y bar, token QA gate, and no user-affecting automation rule.
- `docs/local-ts-api.md` - Web/API development commands and SSE contract context; Phase 7 should not change API behavior.
- `docs/architecture.md` - Current TypeScript API/web/Python architecture and local-first boundaries.
- `docs/decisions.md` - ADR context for TanStack, frontend ports, SSE invalidation, and architectural boundaries.
- `docs/backlog.md` - Required owner for any Storybook a11y deferrals.

### Codebase Maps
- `.planning/codebase/TESTING.md` - Current test pyramid, Storybook command guidance, and known test-command caveats.
- `.planning/codebase/CONVENTIONS.md` - Local coding conventions, colocated tests/stories, and shared UI placement.
- `.planning/codebase/CONCERNS.md` - Storybook/a11y and UI test coverage risks.
- `.planning/codebase/STACK.md` - Frontend stack and Radix/shadcn ownership.

### Current Code Surfaces
- `apps/web/src/shared/ui/` - Shared primitive source, stories, and tests owned by this phase.
- `apps/web/src/shared/ui/filterable-data-grid.tsx` - Highest-risk table/filter primitive with custom keyboard/dialog behavior.
- `apps/web/src/shared/ui/filterable-data-grid.test.tsx` - Existing behavioral coverage to extend instead of duplicating.
- `apps/web/src/shared/ui/data-table.tsx` - TanStack Table primitive with custom row activation and sorting behavior.
- `apps/web/src/shared/ui/table-pager.tsx` - Pagination control primitive used by dense tables.
- `apps/web/src/shared/ui/dialog.tsx`, `sheet.tsx`, `drawer.tsx`, `dropdown-menu.tsx`, `select.tsx`, `popover.tsx`, `command.tsx`, `tooltip.tsx`, `toast.tsx` - Overlay/menu primitives requiring open-state and focus/readability proof.
- `apps/web/src/styles/tokens.css` and `apps/web/src/styles/globals.css` - Phase 6 token foundation; Phase 7 should consume, not redefine.
- `apps/web/e2e/tests/token-foundation.spec.ts` - Existing browser token proof pattern for seeded light/dark/density checks.

### Modern Web Guidance Used
- `modern-web-guidance:accessibility` - Prefer native semantics, accessible names, visible focus, keyboard navigation, non-text contrast, and a11y testing.
- `modern-web-guidance:design-token-reactivity` - Use explicit `data-density` selector fallback for core density behavior; container style queries are not baseline across Firefox.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/web/src/shared/ui` currently has 35 source primitives/components. Most have colocated stories; `filterable-data-grid.test.tsx` is the only existing shared/ui unit test.
- `filterable-data-grid.test.tsx` already covers local pagination, filtering, sorting, active filter chips, and dialog-based filter interactions. It is the best starting point for keyboard/focus and a11y additions.
- The Phase 6 shared/ui token scanner returned `shared/ui token audit matches: 0` for legacy token utilities and direct semantic CSS variable use. This is a baseline invariant for Phase 7, not work to repeat manually.
- Storybook coverage exists for most primitives, including overlays and menus, but the inventory shows no colocated a11y tests under `shared/ui`.
- `docs/local-reliability-qa.md` states Storybook addon-a11y fails critical/serious violations, and 13 existing story deferrals must be tracked in `docs/backlog.md`.

### Established Patterns
- Shared primitives use Tailwind utility composition and `cn()` rather than component-specific CSS modules.
- Shadcn/Radix primitives are copied and owned locally, but their upstream internals should not be snapshot-tested or rewritten without evidence.
- Views compose context components; shared primitives stay generic and cannot import domain contexts or view modules.
- Existing Playwright E2E uses a seeded temp app directory and isolated ports. Use this pattern for browser proof when needed.

### Integration Points
- `FilterableDataGrid` composes `Dialog`, `Input`, and `TablePager`, so it is a useful integration target for primitive behavior and accessibility proof.
- `DataTable` uses `role="button"` rows when row activation exists and custom Enter/Space handling; this is accessibility-sensitive and should be tested.
- Overlay primitives depend on Radix portals and focus behavior. Phase 7 tests/stories should assert behavior through roles and accessible names rather than implementation internals.
- `apps/web/.storybook/preview.tsx` and colocated stories are the Storybook proof surface for primitive visual/a11y states.

</code_context>

<specifics>
## Specific Ideas

- Auto-selected gray area: **Primitive scope** -> recommended choice: harden the existing Phase 6 semantic primitive contract instead of regenerating or redesigning primitives.
- Auto-selected gray area: **Coverage strategy** -> recommended choice: add behavior/a11y tests only where they prove real risk, and use Storybook states for visual variant/open-state coverage.
- Auto-selected gray area: **Density/focus behavior** -> recommended choice: preserve the current `data-density`/CSS-variable seam and verify focus/keyboard behavior through native roles and Playwright/RTL interactions.
- Auto-selected gray area: **Safety boundary** -> recommended choice: synthetic/seeded stories and tests only; no user-affecting automation.

</specifics>

<deferred>
## Deferred Ideas

- Visible Tabler icon migration remains Phase 8.
- Domain/status tone mapping remains Phase 9.
- Route-wide visual QA/a11y hardening remains Phase 10.
- Final global cleanup and unused dependency removal remain Phase 11.

</deferred>

---

*Phase: 7-Shared Primitive Token Migration*
*Context gathered: 2026-06-10*
