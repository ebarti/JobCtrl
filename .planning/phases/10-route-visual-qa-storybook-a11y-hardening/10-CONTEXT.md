---
phase: 10-route-visual-qa-storybook-a11y-hardening
gathered: 2026-06-10T13:48:55Z
status: ready-for-planning
mode: auto-discussed
---

# Phase 10: Route Visual QA + Storybook/A11y Hardening - Context

## Phase Boundary

Phase 10 proves that the completed token, primitive, layout, icon, and domain-status migrations hold across representative app routes, overlays, density modes, themes, and accessibility gates.

This phase may add or tighten QA tests, Storybook/a11y evidence, and planning documentation. It should not intentionally change product behavior, API contracts, TanStack route/search behavior, query keys, mutation behavior, SSE invalidation, generated materials policy, apply submission behavior, profile data, worker execution, or route information architecture.

Dead CSS cleanup, dependency removal, and obsolete alias cleanup remain Phase 11.

## Decisions

- Reuse the existing Playwright E2E harness with synthetic `qa-seed.ts` data.
- Keep route visual QA focused on computed visibility, overflow, theme/density compatibility, focus indicators, and safe overlay/control interactions.
- Prefer deterministic checks over screenshots for CI stability; screenshots remain optional browser proof if a visual issue is found.
- Run Storybook build/test to enforce the configured critical/serious axe bar and documented deferrals.
- Keep destructive-control coverage read-only unless the existing E2E harness already owns a disposable destructive workflow.

## Canonical References

- `.planning/REQUIREMENTS.md` - `QA-01` through `QA-06`.
- `.planning/ROADMAP.md` - Phase 10 goal, success criteria, and verification.
- `AGENTS.md` - frontend QA gates, sensitive-data restrictions, and no real apply/material generation.
- `docs/local-reliability-qa.md` - frontend QA pyramid, Storybook/a11y bar, seeded browser safety.
- `docs/frontend-target.md` - route/view composition and testing expectations.
- `apps/web/e2e/playwright.config.ts` - seeded E2E workspace and stubbed dispatch configuration.
- `apps/api/test/qa-seed.ts` - synthetic data source for route QA.

## Modern Web Guidance Applied

The `modern-web-guidance` accessibility and HTML guides were consulted before Phase 10 changes. Relevant guidance for this phase:

- Interactive controls need accessible names and visible focus indicators.
- Dialog and overlay checks should include keyboard dismissal and focus behavior.
- Color cannot be the only status indicator; route QA should assert visible labels/status text still render.
- Automated axe checks are useful but not sufficient; keyboard and visual state checks remain necessary.
- Hidden or decorative elements must not leave focusable controls hidden from assistive technology.

## Safety Notes

- Browser proof must use seeded/synthetic app data only.
- Do not run real auto-apply, mailbox scanning, browser submission, material generation, destructive profile/database actions, or worker-backed jobs.
- The Playwright harness sets `JOBHUNTER_E2E_STUB_DISPATCH=1`, which keeps route actions deterministic and local to the disposable workspace.
