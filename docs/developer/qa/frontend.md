# Frontend QA

Frontend QA is layered because type correctness, accessible components,
browser behavior, and visual consistency catch different failures.

## Command Map

| Layer | Command |
| --- | --- |
| TypeScript | `corepack pnpm web:check` |
| Unit, hook, component, a11y | `corepack pnpm --filter @jobctrl/web test` |
| Type-level contracts | `corepack pnpm --filter @jobctrl/web test-d` |
| Production bundle | `corepack pnpm web:build` |
| End-to-end | `corepack pnpm --filter @jobctrl/web e2e -- tests/<flow>.spec.ts` |
| Storybook bundle and runner | `corepack pnpm web:storybook:build` then `corepack pnpm web:storybook:test` |

## What Each Layer Proves

- Colocated Vitest/RTL/MSW tests prove selectors, query keys, hooks, mutations,
  forms, components, rollback, and critical/serious axe checks.
- Type-level tests prove the public inferred shapes of read hooks and contracts.
- Playwright uses a real API plus seeded SQLite fixtures to prove route and
  realtime behavior without a live worker or model.
- Storybook proves state/variant rendering and shared accessibility behavior.

## Token And Primitive Changes

Token changes need light/dark contrast and density proof. Shared primitive
changes need scoped primitive tests, Storybook, boundary scans, and a generated
CSS check. Use the exact commands in the
[token foundation](complete-checklist.md#token-foundation-qa-gate) and
[shared primitive](complete-checklist.md#shared-primitive-qa-gate) sections.

## Route-Level Changes

Run the relevant flow spec plus the seeded
[route visual QA](complete-checklist.md#route-visual-qa-gate) when a change
affects layout, overlays, theme, density, forms, filters, focus, or destructive
controls. Review the path manually using the
[Browser Smoke guide](browser-smoke.md).

## Parity And Accessibility

Two parity tests are non-negotiable runtime backstops:

- every domain event type has a real invalidation handler;
- every stage-state kind has a non-default badge rendering.

Critical and serious axe violations fail the component/Storybook bar. Contrast
is checked from resolved tokens because jsdom cannot evaluate rendered colors.
Any future Storybook a11y escape hatch needs a matching backlog entry.

## Test Data Boundary

Frontend QA uses synthetic stories, seeded databases, stub dispatchers, and
disposable browser fixtures. It does not need real profile data, real contacts,
mailbox access, model spend, or application submission.
