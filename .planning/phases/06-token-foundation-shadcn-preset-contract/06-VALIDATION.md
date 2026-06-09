---
phase: 06
slug: token-foundation-shadcn-preset-contract
status: approved
nyquist_compliant: true
wave_0_complete: false
created: 2026-06-09
---

# Phase 06 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.5, Vite 7.3.0, Storybook 10.3.6, Playwright `@playwright/test` `^1.50.0` |
| **Config file** | `apps/web/vitest.config.ts`, `apps/web/vitest.types.config.ts`, `apps/web/e2e/playwright.config.ts`, `apps/web/.storybook/*` |
| **Quick run command** | `corepack pnpm web:check` |
| **Full suite command** | `corepack pnpm web:check && corepack pnpm web:build && corepack pnpm dlx shadcn@latest info -c apps/web` |
| **Estimated runtime** | 120-300 seconds, excluding browser smoke |

---

## Sampling Rate

- **After every task commit:** Run `corepack pnpm web:check` plus targeted token grep for touched files.
- **After every plan wave:** Run `corepack pnpm web:build`, `corepack pnpm dlx shadcn@latest info -c apps/web`, and the legacy-token grep.
- **Before `$gsd-verify-work`:** Full suite, token grep, shadcn CLI proof, browser computed-token smoke, and `git diff --check` must be green.
- **Max feedback latency:** 300 seconds for automated checks; browser smoke is the explicit manual/interactive exception.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 06-W0-01 | Validation scaffold | 0 | TOKEN-01 | T-06-03 / T-06-04 | Token contract preserves readable surfaces and visible focus states | unit/static | `corepack pnpm --filter @jobhunter/web test src/styles/token-contract.test.ts -x` | no - Wave 0 creates | pending |
| 06-W0-02 | Validation scaffold | 0 | TOKEN-02 | T-06-03 / T-06-04 | Generated CSS exposes shadcn semantic utilities without legacy utility aliases | build/static | `corepack pnpm web:build` plus CSS output grep for `bg-background`, `text-foreground`, `border-border`, `ring-ring`, `bg-popover` | build script exists; grep task new | pending |
| 06-W0-03 | Validation scaffold | 0 | TOKEN-03 | T-06-01 | Preset values are asserted from config/tokens and package choices are deliberate | CLI/static | `corepack pnpm dlx shadcn@latest preset decode b3F5kqmYd8 --json` plus config assertions | CLI exists; assertions new | pending |
| 06-W0-04 | Validation scaffold | 0 | TOKEN-04 | T-06-01 | shadcn resolves aliases under `apps/web/src` and does not rewrite components broadly | CLI/build | `corepack pnpm dlx shadcn@latest info -c apps/web` | yes | pending |
| 06-W0-05 | Validation scaffold | 0 | TOKEN-05 | T-06-02 / T-06-04 | Theme and density proof uses synthetic/seeded data and avoids user-affecting automation | browser/manual or Playwright smoke | App shell smoke: light/dark computed values, focus ring, popover, density row heights 32/40/48 | smoke new | pending |
| 06-W0-06 | Validation scaffold | 0 | TOKEN-06 | T-06-03 | Legacy token aliases and utilities are absent from production styling at exit | static grep | `rg -- '--bg|--paper|--ink|--rule|--danger|--warn|--ok|--font|--mono|--row|bg-paper|text-ink|border-rule|ring-info' apps/web/src apps/web/.storybook apps/web/components.json` returns no production hits | command yes | pending |

---

## Wave 0 Requirements

- [ ] `apps/web/src/styles/token-contract.test.ts` or an equivalent colocated/static test asserts required light/dark semantic tokens, preset values, status extensions, and legacy-name absence.
- [ ] CSS output grep or an equivalent build artifact assertion proves Tailwind 4 generated required semantic utilities.
- [ ] Browser smoke script or checklist proves app shell light/dark, theme toggle, density control, visible focus ring, and one popover/dropdown surface with synthetic or seeded data only.
- [ ] Package-install tasks include `checkpoint:human-verify` for `shadcn`, `@fontsource-variable/geist`, and `@types/node` because research flagged their latest releases as recent.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| App shell computed-token smoke | TOKEN-05 | Computed browser styles, focus visibility, popover surface readability, and density row heights are visual/runtime concerns that typecheck cannot prove | Run the app, open `/dashboard` and one dense list route such as `/jobs`, toggle light/dark, set compact/regular/comfy density, inspect body/app shell/topbar/nav/theme/density computed colors and row heights, focus the controls, open one popover/dropdown |
| Sensitive-data safety during browser proof | TOKEN-05 | The repo is local-first and may contain sensitive generated artifacts | Use synthetic/seeded data only; do not trigger auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs |

---

## Threat References

| Ref | Threat | Required Plan Mitigation |
|-----|--------|--------------------------|
| T-06-01 | Supply-chain tampering from suspicious latest package releases | Add human verification checkpoints before installing `shadcn`, `@fontsource-variable/geist`, and `@types/node`; avoid unreviewed postinstall behavior |
| T-06-02 | Sensitive profile/application data exposed in screenshots or browser proof | Browser smoke uses synthetic/seeded data only and avoids user-affecting automation |
| T-06-03 | Legacy token bridge survives and misleads future phases | Token grep is a blocking exit gate; any compile bridge is removed before completion |
| T-06-04 | Visual polish breaks accessibility or hides domain status meaning | Verify visible focus, non-text contrast, and semantic status extensions; do not flatten lifecycle statuses into chart tokens |

---

## Validation Sign-Off

- [x] All tasks have automated verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all missing references
- [x] No watch-mode flags
- [x] Feedback latency under 300 seconds for automated checks
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-06-09
