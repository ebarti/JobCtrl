# Phase 07 Primitive Audit

**Date:** 2026-06-10
**Scope:** Shared primitive token migration final gate for Plans 07-01 through 07-05.
**Data safety:** Evidence below uses command names, aggregate pass/fail counts, and static scan results only. No local profile data, resumes, generated PDFs, browser profiles, SQLite rows, application logs, API keys, OAuth tokens, screenshots, or worker-backed job output are recorded.

## Summary

- Shared primitive scoped tests passed for the changed/high-risk files from Plans 07-01, 07-02, and 07-05.
- Storybook build passed.
- Storybook test-runner passed after browser-launch escalation; the first sandboxed run failed before executing suites because Chromium could not register its macOS Mach port.
- Corrected shared/ui legacy-token scan returned `legacy token matches: 0`.
- Shared/ui boundary scan returned zero disallowed imports, including removal of the former `MarkdownDocument.tsx -> contexts/operations` exception.
- Remaining Storybook a11y deferrals are the 10 tracked rows in `docs/backlog.md`.
- Review-fix verification rechecked row activation after moving activation from focusable structural rows to named native buttons inside the table cells.
- No user-affecting automation, mailbox scanning, browser submission, real material generation, destructive profile/database action, or worker-backed job was run.

## Command Results

| Command | Result | Notes |
| --- | --- | --- |
| `corepack pnpm web:check` | PASS | TypeScript check completed with `tsc --noEmit --project tsconfig.json`. |
| `corepack pnpm --filter @jobhunter/web test src/shared/ui/data-table.test.tsx src/shared/ui/toast.a11y.test.tsx src/shared/ui/filterable-data-grid.test.tsx src/shared/ui/table-pager.test.tsx src/shared/lib/job-description-blocks.test.ts` | PASS | `5 passed (5)` test files; `19 passed (19)` tests. Vitest emitted the existing `--localstorage-file` warning. |
| `corepack pnpm web:storybook:build` | PASS | Storybook `v10.3.6` build completed successfully to `dist/web-storybook`; existing docgen/chunk-size warnings only. |
| `corepack pnpm web:storybook:test` | FAIL before suites in sandbox | `0 of 89` suites ran; Chromium launch failed with `bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer... Permission denied (1100)`. |
| `corepack pnpm web:storybook:test` with browser-launch escalation | PASS | `89 passed, 89 total`; `320 passed, 320 total`; `0` snapshots. |
| `corepack pnpm dlx shadcn@latest info -c apps/web` | PASS | Reports Vite, TypeScript, Tailwind v4, `style radix-luma`, `iconLibrary tabler`, blank Tailwind config, aliases to `@/shared/ui` and `@/shared/lib`. |
| Corrected legacy-token scanner from `07-RESEARCH.md` over `apps/web/src/shared/ui/*.tsx`, `apps/web/src/shared/ui/*.stories.tsx`, `apps/web/.storybook/*.ts`, and `apps/web/components.json` | PASS | `legacy token matches: 0`. |
| Shared/ui boundary scan from `07-RESEARCH.md` | PASS | Zero matches for contexts, views, API/routes, `@tanstack/react-query`, `apiClient`, query mutations, `EventSource`, `localStorage`, or `navigator.clipboard` under `apps/web/src/shared/ui`. |
| `rg -n "a11y:\\s*\\{\\s*test:\\s*\\\"off\\\"|test:\\s*\\\"off\\\"" apps/web/src/shared/ui apps/web/src/views apps/web/src/contexts docs/backlog.md` | PASS | Found the backlog count line plus 10 story deferrals: `scroll-area`, `popover`, `command`, `ArtifactFilterBar`, `ArtifactsView`, `dropdown-menu`, `ProfileEditor`, `ApplyHistory`, `select`, and `StructuredProfileEditor`. |
| `git diff --check` | PASS | No whitespace errors. |

## Review Fix Addendum

The post-review fix for CR-01 removes row-level `tabIndex`, click handlers, and Enter/Space handlers from `DataTable` and `FilterableDataGrid`. Activatable rows remain structural table rows; activation is now exposed through per-row native `<button>` controls with explicit accessible labels and `--ring` focus styling. App consumers pass domain-specific labels for jobs, artifacts, workflow runs, and debug activity.

The post-review fix for WR-01 updates `docs/local-reliability-qa.md` from 13 deferred stories to the current 10-story count. The deferral scanner returned `a11y deferral stories: 10`.

The post-review fix for MD-01 changes the global fallback `:focus-visible` outline from `--status-info` to the standard `--ring` token and extends the grid CSS contract test to assert the fallback rule.

## Skipped Broad Suite

`corepack pnpm --filter @jobhunter/web test` was intentionally not run for this plan. `07-CONTEXT.md`, `07-RESEARCH.md`, `07-VALIDATION.md`, and `docs/local-reliability-qa.md` document the known unrelated broad web Vitest inline snapshot runner failures and allow scoped shared/ui verification when the scoped tests, `web:check`, Storybook gates, static scans, and diff hygiene pass. This plan did not touch the known failing snapshot surfaces.

## Boundary Proof

The former shared/ui boundary exception was removed:

- `apps/web/src/shared/ui/MarkdownDocument.tsx` now imports `descriptionBlocks` from `../lib/job-description-blocks.js`.
- `apps/web/src/shared/lib/job-description-blocks.ts` owns the pure paragraph splitting helper.
- `apps/web/src/contexts/operations/selectors/jobDescriptionSelectors.ts` was removed as an unused context-owned selector.

The final shared/ui boundary scan returned zero matches.

## Token Proof

The corrected scanner rejects legacy utilities and variables while allowing standard shadcn muted utilities:

- Rejected patterns include `bg-paper`, `text-ink`, `border-rule`, `ring-info`, `ring-offset-paper`, `bg-bg`, bare `text-muted`, and legacy CSS variables such as `--paper`, `--ink`, `--rule`, `--info`, `--danger`, `--warn`, and `--ok`.
- Result: `legacy token matches: 0`.

## A11y Deferral Proof

The remaining deferrals are tracked in `docs/backlog.md` "Frontend Accessibility Backlog (Phase 7 Deferrals)" with a count of 10. No new `a11y: { test: "off" }` entries were introduced by Plan 07-05.

## Safety Statement

All verification used TypeScript checks, scoped Vitest, Storybook build/test-runner, shadcn config info, static scans, and git diff hygiene. No auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database action, or worker-backed job was executed.
