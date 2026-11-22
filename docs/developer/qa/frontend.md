# Frontend QA

Frontend QA combines static checks, real application journeys and rendered
accessibility/visual inspection. The target has no isolated unit, hook, type-test
or mocked internal API suite; see [Python application journeys](python-journeys.md).

## Command Map

| Check | Command |
| --- | --- |
| TypeScript | `corepack pnpm web:check` |
| Frontend boundaries | `corepack pnpm web:lint` |
| Production bundle | `corepack pnpm web:build` |
| Real application E2E | `corepack pnpm e2e` |
| Focused existing journey | `corepack pnpm e2e -- --grep 'approved baseline'` |
| Storybook inspection bundle | `corepack pnpm web:storybook:build` |

## What Each Check Proves

- TypeScript checks contract shapes and the boundary lint checks dependency
  direction. Neither proves runtime behavior. See
  [automated boundary checks](../../architecture/frontend/state-and-ports.md#automated-boundary-checks).
- The actual browser suite reaches Python HTTP, SQLite, Temporal, the worker and
  renderer. Only external services are controlled. It creates synthetic records
  through public entry points; it does not seed private tables, fake dispatch
  or replace internal API responses.
- For uncertain writes, retain submitted and later text, settle pending state,
  require deliberate review and never automatically resubmit. Exercise real
  delayed/lost acknowledgement, stale revisions and post-commit failure rather
  than returning a fabricated first-party response. Explicit 4xx conflicts keep
  their conflict handling.
- Resume review must retain tenant/job/document fences, independent comments and
  revisions, exact edit approval and accepted-artifact bytes. Drive real Plate
  edits, reload, conflicts, failed render and recovery. Inspect downloaded PDF
  text and page images for complete authored content, margins, heading/bullet
  continuity and annotation leakage. The old isolated export/session/API tests
  are retired; retain these outcomes in actual affected journeys.
- Current core journeys cover source-bound Fit/wording authority, full baseline,
  advisory review/override and accepted-PDF preservation. They do not grade live
  model quality. Storybook supplies rendering states for inspection, not a
  replacement internal test runner or persistence proof.

## Visual And Base UI Contracts

The frontend retains `base-rhea` component ancestry with the Swiss timetable
visual contract in `DESIGN.md`: Helvetica Neue/Helvetica/Arial product type, JetBrains Mono technical
text, square geometry, neutral chart ramps, monochrome primary/focus tokens,
and red/amber state accents. Domain status uses an icon/dot plus text rather
than a colored capsule, and filled score/count markers pair explicit foreground
and background tokens. Contrast calculations,
focused primitive behavior, and the rendered token-foundation browser gate own
those outcomes; route code should consume semantic tokens instead of
introducing local substitutes.

Interactive behavior belongs to wrappers under `apps/web/src/shared/ui/`.
Use the current boundary lint and inspect the affected real route for focus
containment/return, Escape/outside dismissal, portal stacking, accessible naming
and controlled state. A retired Vitest filename is not a current gate, and
class-name inspection alone does not establish these behaviors.

A focused starting point is:

```bash
corepack pnpm web:check
corepack pnpm web:lint
corepack pnpm e2e -- --grep 'approved baseline'
```

Select the existing journey that actually exercises the changed path; do not
claim the example baseline journey covers unrelated primitive behavior.

## Token And Primitive Changes

Token changes need light/dark contrast and density proof. Shared primitive
changes need rendered route/Storybook inspection, boundary scans, and a generated
CSS check. Use the exact commands in the
[token foundation](complete-checklist.md#token-foundation-qa-gate) and
[shared primitive](complete-checklist.md#shared-primitive-qa-gate) sections.

## Route-Level Changes

Run the relevant actual journey plus the synthetic
[route visual QA](complete-checklist.md#route-visual-qa-gate) when a change
affects layout, overlays, theme, density, forms, filters, focus, or destructive
controls. Review the path manually using the
[Browser Smoke guide](browser-smoke.md).

## Parity And Accessibility

Two runtime parity invariants remain required:

- every domain event type has a real invalidation handler;
- every stage-state kind has a non-default badge rendering.

The frontend boundary lint is the structural backstop. For Pipelines,
lifecycle events must invalidate the operations query while bounded polling
covers worker heartbeat/task-queue telemetry that has no domain event. Use synthetic records created through public entry points to distinguish
provider acquisition from Preparation fanout, and verify ETA, freshness, capacity, queue, active
inventory, privacy masking, and unavailable reasons without invented certainty.

Treat critical and serious accessibility violations as failures in the rendered
route/Storybook inspection. Check contrast from resolved tokens and actual
rendered colors; do not claim a deleted component runner supplied that evidence.

## Test Data Boundary

Frontend QA uses synthetic stories and owned disposable application/browser
workspaces. The current E2E harness controls external boundaries only. It does
not need real Profile data, contacts, mailbox access, model spend or employer
submissions. Retired stub-dispatch flags are not a safety control.
