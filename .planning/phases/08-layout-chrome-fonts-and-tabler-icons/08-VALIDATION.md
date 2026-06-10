---
phase: 08
slug: layout-chrome-fonts-and-tabler-icons
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-10
---

# Phase 08 - Validation Strategy

> Per-phase validation contract for shell chrome, fonts, icons, density, and route readability proof.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.5, Testing Library, Playwright 1.59.1, Storybook 10.3.6 when story/provider surfaces change |
| **Config file** | `apps/web/vitest.config.ts`, `apps/web/e2e/playwright.config.ts`, `apps/web/.storybook/main.ts`, `apps/web/.storybook/preview.tsx` |
| **Quick run command** | `corepack pnpm --filter @jobhunter/web test src/shared/layout/Topbar.test.tsx src/shared/layout/ThemeToggle.test.tsx src/shared/layout/ConnectionStatusPill.test.tsx` |
| **Full suite command** | `corepack pnpm web:check`; `corepack pnpm web:build`; targeted Vitest; targeted Playwright; icon import audit; `git diff --check` |
| **Estimated runtime** | ~30-240 seconds for scoped tests/typecheck/build; Playwright and conditional Storybook may run longer |

---

## Sampling Rate

- **After every task commit:** Run the touched scoped Vitest file and `corepack pnpm web:check` when TypeScript or icon imports changed.
- **After every wave:** Run token contract tests, icon import audit, and `git diff --check`.
- **Before Phase 8 closeout:** Run targeted layout/shared-ui Vitest, `web:check`, `web:build`, targeted Playwright shell proof, full icon audit, and review/QA loops.
- **Conditional Storybook gate:** Run `corepack pnpm web:storybook:build` and `corepack pnpm web:storybook:test` only if stories, Storybook providers, or story-visible primitive behavior changed.
- **Max feedback latency:** No three consecutive implementation tasks may skip automated verification.

---

## Per-Requirement Verification Map

| Requirement | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|-------------|-----------------|-----------|-------------------|-------------|--------|
| LAYOUT-01 | App shell, topbar, nav, global search, theme toggle, density control, connection status, tabs, and menu surfaces adopt preset tokens while preserving route/user workflows. | unit + e2e + static | `corepack pnpm --filter @jobhunter/web test src/shared/layout/Topbar.test.tsx src/shared/layout/ThemeToggle.test.tsx src/shared/layout/ConnectionStatusPill.test.tsx`; `corepack pnpm --filter @jobhunter/web e2e -- tests/token-foundation.spec.ts` | new layout tests needed; E2E exists | pending |
| LAYOUT-02 | Geist body and JetBrains Mono heading/technical fonts remain wired through Vite/Storybook global CSS and dense layouts still fit. | static + build + e2e | `corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts`; `corepack pnpm web:build`; targeted Playwright computed shell/font/density proof | token test exists | pending |
| LAYOUT-03 | User-visible lucide icons are migrated to Tabler or explicitly recorded as deferrals without changing action meaning or accessible labels. | static + unit | `rg "lucide-react|@tabler/icons-react" apps/web/src apps/web/package.json`; targeted shared-ui/layout tests | command-based; `08-ICON-AUDIT.md` needed | pending |
| LAYOUT-04 | Compact, regular, and comfy density modes continue to set `.app-shell[data-density]` and `--jh-row-height` for dense Jobs scanning. | e2e + static | `corepack pnpm --filter @jobhunter/web e2e -- tests/token-foundation.spec.ts`; token contract test | E2E exists, needs extension | pending |
| LAYOUT-05 | Topbar/menu translucency remains readable over Jobs, Apply Review, artifact/PDF-adjacent, and dark-mode surfaces. | e2e/browser proof | Extend `apps/web/e2e/tests/token-foundation.spec.ts` to inspect `/jobs`, `/apply-review`, and `/artifacts` or an artifact detail route supported by synthetic fixtures | partial existing proof | pending |

---

## Wave 0 Requirements

- [ ] `apps/web/src/shared/layout/Topbar.test.tsx` - prove global search Enter behavior, blank-query guard, nav labels, and density select options/store update.
- [ ] `apps/web/src/shared/layout/ThemeToggle.test.tsx` - prove accessible name and theme store update after Tabler swap.
- [ ] `apps/web/src/shared/layout/ConnectionStatusPill.test.tsx` - prove live label, `aria-live`, worker alert banner, and long-disconnect status banner where deterministic.
- [ ] `apps/web/e2e/tests/token-foundation.spec.ts` - extend shell proof for global search URL, nav active state, theme/density persistence, icon/control dimensions, and LAYOUT-05 route readability.
- [ ] `.planning/phases/08-layout-chrome-fonts-and-tabler-icons/08-ICON-AUDIT.md` - record Tabler mappings and every remaining lucide deferral.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Final visual polish judgment | LAYOUT-01, LAYOUT-05 | Automated computed-style checks prove surfaces are painted/readable but not all perceptual hierarchy. | Inspect browser proof for topbar/nav/search/density/theme/status on `/jobs`, `/apply-review`, and artifact/PDF-adjacent route in light and dark. Record only non-sensitive observations. |

All other Phase 8 behaviors require automated checks or a documented blocker in `08-VERIFICATION.md`.

---

## Safety Gates

- Use synthetic/seeded data only.
- Do not expose profile data, resumes, cover letters, generated PDFs, browser profiles, SQLite databases, logs, API keys, OAuth tokens, or real application data.
- Do not run auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs.
- Do not mark LAYOUT requirements complete until `08-VERIFICATION.md` and `08-REVIEW.md` exist and no Blocker/High findings remain.

---

## Validation Sign-Off

- [x] All Phase 8 requirements have automated verification or Wave 0 dependencies.
- [x] Sampling continuity is documented.
- [x] Wave 0 covers missing layout tests, browser proof extensions, and icon audit.
- [x] No watch-mode flags are used in verification commands.
- [x] LAYOUT-05 route proof includes Jobs, Apply Review, and artifact/PDF-adjacent surfaces without pulling in the full Phase 10 route matrix.
- [x] `nyquist_compliant: true` is set in frontmatter.

**Approval:** approved 2026-06-10
