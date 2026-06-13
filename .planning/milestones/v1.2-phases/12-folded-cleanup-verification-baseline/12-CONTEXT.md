# Phase 12: Folded Cleanup + Verification Baseline - Context

**Gathered:** 2026-06-11
**Status:** Ready for planning

<domain>
## Phase Boundary

Phase 12 closes the narrow v1.1 cleanup residue before v1.2 feature work starts. It may update stale verification commands, generated codebase maps, dependency/config remnants, and narrow docs/config expectations related to the shadcn semantic-token migration. It must not change product layout, route behavior, scoring policy, tailoring policy, worker behavior, or generated-material behavior.

</domain>

<decisions>
## Implementation Decisions

### the agent's Discretion
All implementation choices are at the agent's discretion because this is an infrastructure cleanup phase. Use the roadmap success criteria, repository conventions, and import/config proof to decide whether to remove remnants or leave documented historical references alone.

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- `.planning/codebase/STACK.md`, `.planning/codebase/CONVENTIONS.md`, and `.planning/codebase/STRUCTURE.md` describe the repository stack and conventions but still contain stale v1.1-era references.
- `apps/web/src/styles/token-contract.test.ts` already asserts `components.json.tailwind.config` is an empty string for CSS-first Tailwind 4 config.
- `apps/web/components.json` is the current shadcn config owner for style, icon library, aliases, and Tailwind config path.
- `docs/local-reliability-qa.md` already documents the legacy token scan expectations.

### Established Patterns
- Documentation updates should be narrow and made in the owning existing document rather than adding new docs.
- Dependency removal must be backed by source import and lockfile/package proof.
- Planning artifacts are committed by phase so GSD can track context, plan, execution summary, and verification.

### Integration Points
- `apps/web/package.json` and `pnpm-lock.yaml` own web runtime dependencies such as `lucide-react`.
- `.planning/codebase/*.md` generated maps can be updated when their stack/convention claims drift from current repo state.
- `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, and `.planning/STATE.md` already define Phase 12 acceptance criteria.

</code_context>

<specifics>
## Specific Ideas

- Audit `lucide-react` before removal. Current search shows it remains in `apps/web/package.json` and `pnpm-lock.yaml`, while production source references should be checked with `rg "lucide-react" apps/web/src`.
- Normalize stale Tailwind 4 references. Current search shows codebase maps still mention `apps/web/tailwind.config.ts` even though current shadcn config is CSS-first.
- Keep historical implemented-plan references intact when they describe what existed in May 2026; do not rewrite historical ADR/plan records as if they were current docs.
- Preserve legacy token grep expectations in QA docs while ensuring production styling/config remains grep-clean.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>
