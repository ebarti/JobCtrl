---
phase: 12-folded-cleanup-verification-baseline
plan: 12-02
status: completed
completed_at: 2026-06-11T20:35:00Z
---

# 12-02 Documentation And Baseline Verification - Summary

## Completed

- Updated `.planning/codebase/STACK.md` to describe Tailwind 4 CSS-first styling through `globals.css`, `tokens.css`, and `components.json`.
- Updated `.planning/codebase/CONVENTIONS.md` to remove stale `apps/web/tailwind.config.ts` guidance.
- Updated `docs/frontend-target.md` so icon guidance points to `@tabler/icons-react` and rejects new `lucide-react` imports.
- Left historical implemented-plan references under `docs/plans/implemented/` intact.
- Ran current-state stale Tailwind config and legacy token audits.

## Evidence

- Current-state Tailwind scan outside historical plans returned only the intentional `apps/web/src/styles/token-contract.test.ts` assertion that `componentsJson.tailwind.config` is empty.
- Current codebase-map scan returned only `.planning/research/STACK.md`, which explicitly warns not to reintroduce `apps/web/tailwind.config.ts` assumptions.
- Strict legacy token scan `rg -n --pcre2 "var\\(--(bg|paper|ink)(?![-a-zA-Z])|bg-paper|text-ink|border-rule|ring-info|--(danger|warn|ok|info)(?![-a-zA-Z])" apps/web/src apps/web/package.json apps/web/components.json` returned no matches.
- `git diff --check` passed.

## Notes

The broader roadmap grep still finds v1.2 planning text that names the removed Tailwind config path as the cleanup target, plus historical implementation records under `docs/plans/implemented/`. Those are intentional references, not current-state configuration guidance.

