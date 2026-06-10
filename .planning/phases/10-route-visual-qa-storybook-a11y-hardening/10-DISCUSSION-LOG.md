---
phase: 10-route-visual-qa-storybook-a11y-hardening
gathered: 2026-06-10T13:48:55Z
status: complete
mode: auto-discussed
---

# Phase 10 Discussion Log

## Inputs

- User approved a clean-slate shadcn standard-token migration and requested autonomous execution from Phase 6 onward.
- User requested draft PRs as phases complete.
- Phase 9 completed the status surface migration and left Phase 10 as the next QA gate.

## Decisions

- Treat Phase 10 as QA hardening, not a product behavior change.
- Use the existing Playwright seeded workspace because it routes dispatch through the deterministic E2E stub and avoids worker subprocesses, real LLM calls, browser submissions, mailbox scans, and real generated artifacts.
- Add route-level Playwright coverage for representative routes, overlays, light/dark themes, density modes, focus indicators, controls, forms, and destructive-control visibility.
- Keep Storybook/a11y as the authoritative automated axe gate and rerun the existing Storybook build/test commands rather than adding broad page-level axe assertions that would duplicate known Storybook deferrals.
- Record evidence and update requirements only after verification, review, and QA pass.

## Constraints

- Do not run auto-apply, browser submission, mailbox scanning, real material generation, destructive profile/database actions, or worker-backed jobs.
- Do not expose profile data, generated PDFs, browser profiles, logs, SQLite databases, API keys, or OAuth tokens.
- Use synthetic or seeded QA data only.
- Preserve existing route behavior and product workflows.
