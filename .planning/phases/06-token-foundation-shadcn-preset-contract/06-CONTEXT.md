# Phase 6: Token Foundation + shadcn Preset Contract - Context

**Gathered:** 2026-06-09
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 6 establishes the clean shadcn/Tailwind v4 token foundation for the web app. It owns token files, global CSS token wiring, shadcn CLI/config prerequisites, package dependencies for the decoded preset, and enough mechanical styling updates to remove the legacy token API. It does not redesign the app, change routes, alter domain behavior, change query/SSE/API contracts, or run user-affecting automation.

</domain>

<decisions>
## Implementation Decisions

### Token Activation Shape
- **D-01:** The preset should be active immediately in Phase 6. This is not a parallel contract that preserves the current visual palette.
- **D-02:** Use a clean-slate token migration. Breaking visual/styling changes are acceptable because there are no active users besides the owner.
- **D-03:** Legacy aliases such as `--bg`, `--paper`, `--ink`, `--rule`, `--info`, `--danger`, `--warn`, `--ok`, `--font`, `--mono`, `bg-paper`, `text-ink`, `border-rule`, and `ring-info` should not remain part of the Phase 6 token contract.
- **D-04:** If implementation needs a short-lived compile bridge inside a single patch, it must be removed before Phase 6 is called complete. Do not hand off a compatibility-bridge state to later phases.
- **D-05:** Phase 6 should move to the simplest final-state Tailwind setup now: CSS-first `@theme inline`, no dependency on legacy Tailwind utility names, and no old config bridge unless the planner proves it is unavoidable.

### Tooling And Dependency Path
- **D-06:** Keep `shadcn` as a web dependency and import `shadcn/tailwind.css`. Do not eject/inline it in Phase 6.
- **D-07:** Install all preset-level dependencies in Phase 6: `shadcn`, `tw-animate-css`, `@fontsource-variable/geist`, `@fontsource-variable/jetbrains-mono`, `@tabler/icons-react`, and any dev dependency needed for the Vite alias setup such as `@types/node`.
- **D-08:** Use the shadcn CLI for the theme/preset surface only. The intended command shape is `pnpm dlx shadcn@latest apply b3F5kqmYd8 --only theme -y -c apps/web` after aliases validate.
- **D-09:** Do not run an uncontrolled full `shadcn apply` that rewrites primitives/components. Primitive migration remains a later phase unless mechanical token cleanup requires limited class edits.
- **D-10:** Make `components.json` match the Tailwind v4 final target in Phase 6: `style` aligned to the luma/radix-luma target, `iconLibrary` set to Tabler, CSS variables enabled, aliases preserved under `@/shared/*`, and `tailwind.config` blank if CSS-first mode works.

### Alias And Config Boundary
- **D-11:** Remove legacy token aliases now. Phase 6 is allowed to update any web styling files needed to eliminate legacy token names.
- **D-12:** The scope can be broad across web styling files if needed, but the edits must remain mechanical token/style-foundation work. Do not introduce product redesign, new route structure, or domain behavior changes.
- **D-13:** Rename app-specific status extensions now. Prefer clean names such as `--success`, `--success-foreground`, `--success-muted`, `--warning`, `--warning-foreground`, `--info`, and related semantic pairs. Remove old public names like `--ok` and `--warn`.
- **D-14:** Do not flatten lifecycle/status colors onto positional `chart-*` tokens. Chart/data tokens can exist, but status tokens should remain semantic.
- **D-15:** Delete `apps/web/tailwind.config.ts` if CSS-first `@theme inline` fully replaces it and the build passes. Also remove `@config "../../tailwind.config.ts"` and update TypeScript includes if the file is deleted.

### Validation Proof
- **D-16:** Phase 6 requires build plus browser proof. Compile-only validation is insufficient because the phase can produce broad visual fallout.
- **D-17:** The planner may choose exact automated commands based on touched files, but the validation plan must include type/build proof, shadcn CLI/config proof, token grep proof, and `git diff --check`.
- **D-18:** Browser proof is app-shell focused for Phase 6: run the app and verify body/app shell/topbar/nav/theme/density computed tokens in light and dark. Deeper route visual tours belong to later phases.
- **D-19:** Full `pnpm dev` local stack is acceptable for browser proof.
- **D-20:** Even when using the full stack, do not trigger auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs.

### the agent's Discretion
- The planner may choose the exact token values from the decoded preset and official shadcn output, as long as the visible result reflects the supplied preset.
- The planner may decide whether limited shared primitive class edits are necessary in Phase 6 to remove legacy utilities, but must not turn this into the Phase 7 primitive migration unless needed for the clean token slate.
- The planner may choose the exact automated command set, subject to the proof requirements above.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone And Phase Scope
- `.planning/PROJECT.md` - Current milestone goal, clean token migration constraints, and validated v1.0 context.
- `.planning/REQUIREMENTS.md` - Phase 6 requirements `TOKEN-01` through `TOKEN-06` and milestone-wide boundaries.
- `.planning/ROADMAP.md` - Phase 6 goal, success criteria, dependencies, and verification expectations.
- `.planning/STATE.md` - Active v1.1 state, phase order, prior milestone verification, and safety constraints.
- `.planning/research/SUMMARY.md` - Synthesized shadcn migration research, risks, and recommended phase shape. Note: Phase 6 discussion intentionally overrides the research's compatibility-first recommendation with a clean-slate decision.

### Research Inputs
- `.planning/research/STACK.md` - Package/config/CLI findings and warnings about full `shadcn apply`.
- `.planning/research/FEATURES.md` - User-visible acceptance for workflow preservation, theme parity, density continuity, and audit surface honesty.
- `.planning/research/ARCHITECTURE.md` - Styling ownership, frontend architecture boundaries, and migration sequence.
- `.planning/research/PITFALLS.md` - Risks around dark selector mismatch, alias cleanup, dynamic classes, focus rings, status semantics, and QA.

### Frontend Architecture And QA
- `docs/frontend-target.md` - Frontend bounded-context architecture, shadcn/Radix primitive ownership, Tailwind/CSS-variable styling target, and view-vs-context split.
- `docs/architecture.md` - Current TypeScript API/web/Python architecture and frontend stack.
- `docs/local-reliability-qa.md` - Required local QA, browser smoke expectations, Storybook/a11y bar, and sensitive-data safety.
- `docs/decisions.md` - ADR context for TanStack, frontend ports, SSE invalidation, and architectural boundaries.

### Current Code Surfaces
- `apps/web/src/styles/tokens.css` - Current legacy token source to replace.
- `apps/web/src/styles/globals.css` - Tailwind imports, base styles, and broad global styling surface likely requiring mechanical token edits.
- `apps/web/tailwind.config.ts` - Current legacy Tailwind bridge; delete if CSS-first mode replaces it.
- `apps/web/components.json` - shadcn registry/config contract to update to the final Tailwind v4 target.
- `apps/web/vite.config.ts` - Add `@` alias support for shadcn CLI validation.
- `apps/web/tsconfig.json` - Add `baseUrl`/`paths` and remove `tailwind.config.ts` include if the config file is deleted.
- `apps/web/package.json` - Web dependency changes for shadcn, animation CSS, fonts, Tabler, and dev alias support.
- `apps/web/src/shared/providers/ThemeProvider.tsx` - Preserves `[data-theme]` dark-mode behavior.
- `apps/web/src/shared/providers/DensityProvider.tsx` - Documents density scoping away from `<html>`.

### Official External Sources
- `https://ui.shadcn.com/docs/installation/vite` - Vite install and alias expectations.
- `https://ui.shadcn.com/docs/components-json` - `components.json` schema and Tailwind v4 config target.
- `https://ui.shadcn.com/docs/theming` - shadcn semantic token contract.
- `https://ui.shadcn.com/docs/tailwind-v4` - Tailwind 4 CSS-first guidance.
- `https://ui.shadcn.com/docs/cli` - `preset`, `apply`, `--only theme`, and ejection behavior.
- `https://ui.shadcn.com/schema.json` - Schema values including luma/radix-luma and icon fields.
- `https://ui.shadcn.com/create?preset=b3F5kqmYd8` - Preset URL decoded during milestone research.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `apps/web/src/styles/tokens.css`: Small current token file; it is the natural replacement point for semantic CSS variables.
- `apps/web/src/styles/globals.css`: Central Tailwind import and base styling entry. It currently references legacy variables directly and has broad selector coverage, so Phase 6 may need mechanical edits here.
- `apps/web/src/shared/lib/cn.ts`: Existing class merge helper for any TSX class migration needed during clean slate.
- `apps/web/src/shared/ui/*`: Copied shadcn/Radix primitives. Phase 6 may make minimal mechanical class updates if required to eliminate old token utilities, but the main primitive migration belongs to Phase 7.
- `apps/web/src/shared/providers/ThemeProvider.tsx`: Existing theme seam writes `data-theme` to `<html>`.
- `apps/web/src/shared/layout/AppShell.tsx` and `DensityProvider.tsx`: Density is app-shell scoped; keep this boundary.

### Established Patterns
- Web styling currently combines Tailwind utilities, CSS variables, and copied shadcn primitives. New token work should stay in the web shared styling boundary.
- Views compose contexts; contexts do not own global styling contracts. Do not move token definitions into bounded contexts.
- The app already uses local-first safety conventions. Browser proof must not expose sensitive local artifacts or trigger workflow actions.
- Current dark mode uses `[data-theme="dark"]`, not `.dark`. Preserve this selector unless a later explicit phase changes `ThemeProvider`.

### Integration Points
- `apps/web/components.json` must continue pointing shadcn output at `@/shared/ui`, `@/shared/lib/cn`, and `@/shared/hooks`.
- `apps/web/vite.config.ts` and `apps/web/tsconfig.json` need `@/*` alias support before relying on shadcn CLI validation.
- `apps/web/src/styles/globals.css` should import Tailwind, shadcn CSS, animation CSS, fontsource CSS, and local tokens in the final chosen order.
- `apps/web/package.json` and `pnpm-lock.yaml` will change if dependencies are installed.

</code_context>

<specifics>
## Specific Ideas

- The user explicitly prefers the simplest clean-slate final-state setup: "Breaking changes included - no active users besides me" and "Yeah, clean slate."
- The user challenged the suggestion to eject shadcn CSS and chose to keep `shadcn` as a dependency.
- Phase 6 should prefer clear final-state configuration now over temporary compatibility that drifts into later phases.

</specifics>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 6-Token Foundation + shadcn Preset Contract*
*Context gathered: 2026-06-09*
