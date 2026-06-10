# Phase 6: Token Foundation + shadcn Preset Contract - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md - this log preserves the alternatives considered.

**Date:** 2026-06-09
**Phase:** 6-Token Foundation + shadcn Preset Contract
**Areas discussed:** Token activation shape, Tooling and dependency path, Alias and config boundary, Validation proof

---

## Token Activation Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Parallel contract | Define real shadcn/preset tokens now, but keep legacy aliases preserving current UI until later phases migrate consumers. | |
| Preset active now | Map legacy aliases to the new shadcn semantic tokens immediately, accepting broad visual drift in Phase 6. | yes |
| Minimal scaffold | Only add the CLI/config prerequisites and token names now; defer actual preset values to later phases. | |

**User's choice:** Preset active now.
**Notes:** The preset should affect existing surfaces immediately in Phase 6.

| Option | Description | Selected |
|--------|-------------|----------|
| Alias to semantics | Legacy aliases like `--bg`/`--paper`/`--ink` point to the new shadcn semantic tokens so old CSS visibly adopts the preset. | yes |
| Hybrid bridge | Only base surface aliases point to preset tokens; status aliases keep current colors until Phase 9. | |
| Token names only | Keep legacy aliases on old colors even though the preset semantic tokens exist. | |

**User's choice:** Alias to semantics.
**Notes:** This was later superseded by the clean-slate alias decision: remove legacy aliases as a final Phase 6 outcome rather than hand off a bridge.

| Option | Description | Selected |
|--------|-------------|----------|
| Dual bridge | Add `@theme inline` semantic mappings while keeping `tailwind.config.ts` legacy utilities until cleanup proves they are unused. | |
| CSS-first now | Blank `components.json` `tailwind.config` and move all theme mappings into CSS in Phase 6. | yes |
| Config-first | Keep most mappings in `tailwind.config.ts` for now and defer `@theme inline` until primitive migration. | |

**User's choice:** "The simplest solution. Breaking changes included - no active users besides me."
**Notes:** After clarification, user confirmed: "Yeah, clean slate."

---

## Tooling and Dependency Path

| Option | Description | Selected |
|--------|-------------|----------|
| Inline/eject | Cleaner app dependency surface; use the CLI for generation/probing but keep final CSS owned in repo. | |
| Keep dependency | Import `shadcn/tailwind.css` and keep `shadcn` installed so future registry updates can reuse it directly. | yes |
| Decide by spike | Plan a quick probe comparing import vs eject before locking the final dependency choice. | |

**User's choice:** Asked "Why wouldn't we keep it as dependency?" then chose Keep dependency.
**Notes:** Keep `shadcn` as a dependency and import `shadcn/tailwind.css`. Ejection is not in Phase 6.

| Option | Description | Selected |
|--------|-------------|----------|
| Token deps only | Install `shadcn`, `tw-animate-css`, and font packages; leave Tabler package/import migration to Phase 8. | |
| All preset deps | Install `shadcn`, animations, font packages, and `@tabler/icons-react` now even if icons migrate in Phase 8. | yes |
| CLI only | Install only `shadcn` now; defer animations, fonts, and icons to later phases. | |

**User's choice:** All preset deps.
**Notes:** Phase 6 installs all preset-level packages.

| Option | Description | Selected |
|--------|-------------|----------|
| Apply theme only | Run the CLI only for the theme/preset surface, then manually finish config and token cleanup. | yes |
| Full apply allowed | Allow the CLI to rewrite primitives/components if that is the cleanest result. | |
| Decode only | Use the CLI only to decode/inspect; implement all changes manually. | |

**User's choice:** Apply theme only.
**Notes:** Full primitive/component rewrite remains out of scope.

| Option | Description | Selected |
|--------|-------------|----------|
| Final target now | Set style/icon/preset fields, blank `tailwind.config`, and add TS/Vite aliases so the CLI validates cleanly. | yes |
| Interim config | Update style/icon fields but keep `tailwind.config.ts` wired until later cleanup. | |
| Minimal config | Only add aliases now; defer `components.json` style/config changes. | |

**User's choice:** Final target now.
**Notes:** Make `components.json` match Tailwind v4 final target in Phase 6.

---

## Alias and Config Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Remove now | Clean-slate path: update enough base/global CSS in Phase 6 so legacy aliases are not part of the token contract. | yes |
| Short bridge | Keep aliases only where needed to keep unmigrated global CSS compiling, with a hard removal target. | |
| Keep bridge | Preserve aliases until Phase 11 as originally roadmapped. | |

**User's choice:** Remove now.
**Notes:** Do not leave the old token API as a Phase 6 output.

| Option | Description | Selected |
|--------|-------------|----------|
| Global CSS only | Update token files, base styles, and global selectors enough to compile; leave TSX primitive class migration to Phase 7. | |
| Include primitives | Also update shared UI primitive class names in Phase 6 if needed to remove legacy utilities fully. | |
| Anything needed | Allow broad web styling edits in Phase 6 to achieve a clean token slate immediately. | yes |

**User's choice:** Anything needed.
**Notes:** Scope remains token/styling foundation only, not product redesign.

| Option | Description | Selected |
|--------|-------------|----------|
| Rename now | Create clean app status tokens like `--success`, `--warning`, `--info`, with foreground/soft pairs; remove old `--ok`/`--warn` names. | yes |
| Use shadcn only | Force statuses onto core shadcn tokens like destructive/muted/primary/accent for now. | |
| Defer status | Leave old status aliases until Phase 9 handles domain/status surfaces. | |

**User's choice:** Rename now.
**Notes:** Preserve product status semantics with clean token names.

| Option | Description | Selected |
|--------|-------------|----------|
| Delete if unused | Remove `@config`, delete the config file, and update tsconfig includes if the build passes. | yes |
| Keep empty file | Leave a minimal config file even though `components.json` points to Tailwind v4 CSS-first mode. | |
| Planner decides | Let the planner choose deletion or retention based on build/tooling behavior. | |

**User's choice:** Delete if unused.
**Notes:** Remove `apps/web/tailwind.config.ts` if CSS-first mode fully replaces it.

---

## Validation Proof

| Option | Description | Selected |
|--------|-------------|----------|
| Build + browser | Run typecheck/build/tests plus browser smoke for app shell tokens in light/dark and density modes. | yes |
| Full frontend QA | Also run Storybook/a11y and targeted E2E even though this is foundation work. | |
| Build only | Require compile/build and token grep only; defer browser QA to later visual phases. | |

**User's choice:** Build + browser.
**Notes:** Compile-only validation is not enough.

| Option | Description | Selected |
|--------|-------------|----------|
| Web core | Require `pnpm web:check`, `pnpm web:build`, web tests for touched code, shadcn info, token grep, and diff check. | |
| Full test stack | Require root `pnpm test` plus web checks, even though backend/worker behavior should not change. | |
| Planner decides | Let the planner choose exact commands based on touched files. | yes |

**User's choice:** Planner decides.
**Notes:** Planner chooses exact commands, but build plus browser proof remains mandatory.

| Option | Description | Selected |
|--------|-------------|----------|
| App shell only | Open the running app, verify body/topbar/nav/theme/density computed tokens in light/dark; deeper routes wait for later phases. | yes |
| Core routes | Also open Dashboard, Jobs, Artifacts, Apply Review, and Settings to catch broad CSS fallout. | |
| Visual tour | Inspect every representative route listed in the roadmap during Phase 6. | |

**User's choice:** App shell only.
**Notes:** Route-level tour is later.

| Option | Description | Selected |
|--------|-------------|----------|
| Web only | Use Vite/web preview or dev server for shell/token proof; no worker/API/full stack unless needed. | |
| API + web | Run API and web if the shell needs live data for realistic smoke. | |
| Full stack | Use `pnpm dev` and all local services for the browser proof. | yes |

**User's choice:** Full stack.
**Notes:** Full stack is acceptable, but no auto-apply, browser submission, mailbox scanning, real generation, destructive actions, or worker-backed jobs should be triggered.

---

## the agent's Discretion

- Choose exact token values from the decoded preset and official shadcn output.
- Decide exact automated command set based on touched files.
- Decide whether limited primitive class edits are necessary in Phase 6 to remove legacy utilities.

## Deferred Ideas

None.
