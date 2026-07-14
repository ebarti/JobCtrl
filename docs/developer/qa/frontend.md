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

## Integrated Redesign Contracts

The shared redesign compositions have behavioral contracts; they are not CSS
aliases. Keep the focused component tests and deterministic stories, then prove
their real product use in the browser:

| Composition | Required proof |
| --- | --- |
| `AdaptiveFieldGrid` | Source order is unchanged, explicit spans survive, columns collapse through container queries, gaps stay deliberate, and the route has no horizontal overflow at 1440px, 1280px, collapsed rail, or 390×844. |
| `ChoiceControl` | The control is a real checkbox with a visible label. When disabled or locked, the visible reason is wired as its accessible description; visual opacity alone is not evidence. |
| `SelectField` | The visible label names the trigger; description/error ids remain associated; Tab, Enter/Space, Arrow keys, Enter, and Escape follow the Select keyboard contract. A div-only faux listbox does not pass. |
| `DisclosureSection` | `aria-expanded`/`aria-controls` track state and collapsed content remains mounted-but-hidden so form values and local state survive reopen. |
| `PreviewWorkbench` | Compact primary/secondary controls stay above a named document region containing the real full-width `ResumeStandalonePlateEditor` and its production toolbar. A mock document, thumbnail, side preview, or name-only template swap does not pass. |

The focused starting points are
`apps/web/src/shared/ui/redesign-compositions.test.tsx`, the composition stories
in `apps/web/src/shared/ui/redesign-compositions.stories.tsx`, and
`apps/web/src/contexts/profile/components/ResumeTemplatePanel.test.tsx`. Add a
targeted test when a route introduces a new state. The composition test must
cover the `SelectField` accessible name and keyboard interaction as well as the
choice-description, mounted-disclosure, adaptive-order, and named-preview
contracts. A story or filename alone is not proof that the production route
uses the composition correctly.

### Semantic pre/post parity

Every redesigned route/surface needs a manifest captured from the
pre-redesign component and the same production-shaped fixture. Record accessible
labels and roles, every visible fixture/data value, controls and actions, status
discriminants, warnings, audit facts, and loading/empty/error/unavailable
states. The redesigned surface must contain every legacy entry directly or
behind a documented keyboard-reachable tab, disclosure, or detail route. New
explicit states may be added; old entries may not be removed or weakened to
make parity pass.

Each manifest row records the route/surface, canonical fixture and baseline
revision, legacy role/name or data/control/state assertion, redesigned
location, automated-test reference, and browser-evidence reference. Capture the
baseline from the pre-redesign production component before comparing the new
surface; the redesigned component cannot redefine its own baseline.

The visual contract is equally explicit: job, artifact, contact, and run detail
routes render full `RouteWorkspace` pages; status components render a small
dot/glyph plus text rather than colored pills; active tabs use an underline;
and dense facts remain in ruled rows, ledgers, disclosures, or inspectors rather
than one card per datum.

This manifest is semantic, not a DOM snapshot. Complete it with the full
Playwright suite and the
[in-app browser route sweep](browser-smoke.md#integrated-redesign-route-sweep)
across light/dark themes, all three densities, and the required viewport matrix.

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
[Browser Smoke guide](browser-smoke.md). An integrated redesign requires the
complete E2E suite and in-app route sweep, not a representative route sample.

## Parity And Accessibility

Two parity tests are non-negotiable runtime backstops:

- every domain event type has a real invalidation handler;
- every stage-state kind has a non-default badge rendering.

For the Pipelines operations workspace, lifecycle events must also invalidate
`pipelineKeys.operations`, and active/idle polling must remain as a bounded
fallback at 15 seconds and 60 seconds respectively, with background polling
disabled. Verify three source families under one source-family plan, exactly
two separate reconciliation steps (Enrichment pass and Preparation fanout),
raw/private input omission, URL-shaped identifier masking, and honest
ETA/freshness/capacity/task-queue states through the focused API, hook,
invalidation, and `PipelinesView` tests plus the browser sweep. Source-family
and reconciliation facts must not become a blended stage count or completion
percentage.

Critical and serious axe violations fail the component/Storybook bar. Contrast
is checked from resolved tokens because jsdom cannot evaluate rendered colors.
Any future Storybook a11y escape hatch needs a matching backlog entry.

## Test Data Boundary

Frontend QA uses synthetic stories, seeded databases, stub dispatchers, and
disposable browser fixtures. It does not need real profile data, real contacts,
mailbox access, model spend, or application submission.
