---
phase: 12-folded-cleanup-verification-baseline
status: complete
researched_at: 2026-06-11
---

# Phase 12 Research

## Scope

Phase 12 is a narrow cleanup phase. It should close stale v1.1 visual-system residue without changing product behavior.

## Findings

- `rg "lucide-react" apps/web/src apps/web/package.json pnpm-lock.yaml` shows no `apps/web/src` imports. The dependency remains only in `apps/web/package.json` and `pnpm-lock.yaml`, so it is removable if `pnpm` updates the lockfile cleanly.
- `apps/web/components.json` already targets Tabler and has an empty Tailwind config path for CSS-first Tailwind 4.
- `apps/web/src/styles/token-contract.test.ts` already asserts `componentsJson.tailwind.config` is `""`.
- Current generated codebase maps still describe `apps/web/tailwind.config.ts` as active. Those maps are current-state documentation and should be updated.
- Historical docs under `docs/plans/implemented/` intentionally describe May 2026 implementation history and should not be rewritten as current-state docs.
- `docs/frontend-target.md` still says existing visible `lucide-react` imports remain compatible until deliberate migration. That statement is stale after the source import audit.
- `docs/local-reliability-qa.md` already documents the legacy token scan; it can remain as the QA gate that rejects old token utility names.

## Implementation Constraints

- Do not change product layout, routes, status semantics, scoring, tailoring, or worker behavior.
- Remove dependencies only after import proof.
- Keep docs narrow and current-state focused.
- Run web typecheck/build after dependency cleanup.

## Verification Targets

- Source import audit proves `lucide-react` is absent.
- Package/lockfile audit proves `lucide-react` is removed.
- Stale Tailwind config scan has no current-state references outside historical implemented-plan docs and v1.2 planning statements describing cleanup.
- Legacy token scan has no production styling/config references.
- `pnpm web:check`, `pnpm web:build`, and `git diff --check` pass.
