# Browser Smoke For Action-Status Polling

Status: Proposed
Round: 1

## Goal

Add a browser-level smoke test for the action status feedback path that currently has
only unit/component coverage. The backlog item is the UI Quality entry in
`docs/backlog.md`: bulk job buttons already have Playwright coverage in
`apps/web/e2e/tests/jobs-bulk.spec.ts`, but the status loop shown after starting a
pipeline action is not exercised in a real browser.

This run is scoped to web/e2e coverage. It must not implement generate-materials
backend behavior, remove the existing `materials.spec.ts` `test.fixme`, or redesign
bulk actions.

## Current Evidence

- `StageTriggerPanel` owns the visible action status path on `/pipelines`: submitting a
  stage action shows `role="status"` while the mutation is pending, then renders the
  queued/failed/completed response or the latest dashboard activity for that stage.
- `useRunPipelineStagesMutation` invalidates jobs, dashboard summary, workflow runs,
  and apply runs after the mutation settles.
- `StageTriggerPanel.test.tsx` covers pending, backend activity, queued, and failed
  states with mocked ports, but no Playwright spec drives the same behavior through the
  routed application.
- The Playwright suite starts the real API and web app with a seeded disposable
  workspace. Existing browser specs use `expect.poll` for async UI updates and, where
  needed, route-level control or direct seeded-DB writes for deterministic smoke checks.
- `materials.spec.ts` remains blocked because the real generate-materials backend path
  returns an error; it should not be used as the vehicle for this backlog item.

## Design

Add a focused Playwright spec for the `/pipelines` action status UI.

Preferred file:

- `apps/web/e2e/tests/action-status-polling.spec.ts`

Primary flow:

1. Open `/pipelines` and wait for the `Pipeline actions` heading.
2. Click the `Score` tab explicitly before submitting. The stage trigger store
   persists the active tab, so the spec must not assume a fresh browser starts on
   `Discover`; after this click the submit button label is `Run Score`.
3. Intercept `POST /v1/pipeline/actions/run-stage` in the browser test and delay the
   fulfillment long enough to observe the pending UI. This keeps the test independent
   from a running Python/Temporal worker while still exercising the browser, route,
   TanStack mutation, and rendered status behavior.
   Use the same-origin Vite-proxied request URL; in Playwright the reliable match is
   `**/v1/pipeline/actions/run-stage`, not the API server's `:8767` URL.
4. Click `Run Score`.
5. Assert the `role="status"` element transitions to the pending text:
   `Starting Score... waiting for local worker response.`
6. Fulfill the intercepted request with a queued `PipelineStageRunResponse` containing:
   `ok: true`, `action: "run_stage"`, `status: "queued"`, `jobKey: "pipeline"`,
   `count: 1`, the echoed `command`, and one nested action with `ok: true`,
   `runId: "smoke-score-run"`, a stable `actionId`, `action: "run_stage"`,
   `status: "queued"`, `jobKey: "pipeline"`, and the echoed action command. The
   nested `runId` is required for the UI branch that renders the run reference.
7. Poll the status element until it shows:
   `Score queued successfully (run smoke-score-run).`

## Rejected Alternatives

- Re-enable or expand `materials.spec.ts`: rejected because that flow is explicitly
  blocked by backend generate-materials enablement, which is outside this run.
- Use real worker dispatch for `run-stage`: rejected for the smoke test because the
  Playwright web server starts API and web, not a Python worker or Temporal server.
  The browser status path can be covered deterministically with route control.
- Add another component test only: rejected because the backlog asks for browser smoke
  and component tests already cover this status logic.
- Fold this into `jobs-bulk.spec.ts`: rejected because job bulk delete/restore and
  pipeline action status are separate user flows; keeping the smoke separate makes
  failures easier to triage.

## Documentation And Cleanup

- Remove the completed `docs/backlog.md` UI Quality bullet once the Playwright smoke
  lands.
- Update `docs/local-reliability-qa.md` to list 10 Playwright specs, including both
  the already-present `runs` spec and the new `action-status-polling` spec.
- No README or architecture updates are expected because this is test coverage for
  existing behavior, not new product behavior.
- TODO(existing backlog): keep `apps/web/e2e/tests/materials.spec.ts` as `test.fixme`
  until the separate generate-materials backend enablement backlog item is delivered.

## Verification

Implementation should run the narrowest useful gates first:

```bash
pnpm --filter @jobhunter/web e2e -- tests/action-status-polling.spec.ts
pnpm --filter @jobhunter/web e2e
git diff --check
```

If the Playwright command syntax does not accept the explicit spec path through the
package script, run the package's documented e2e command and rely on the full suite.
Do not mark the backlog item complete unless the targeted browser smoke passes.

## Acceptance Criteria

- A Playwright browser test exercises the `/pipelines` action status UI from user click
  through pending status and queued completion status.
- The test is deterministic and does not require generate-materials backend behavior,
  a running Python worker, Temporal, browser submission, or destructive profile/database
  actions beyond the suite's disposable e2e workspace.
- Existing bulk action coverage remains unchanged.
- Backlog/QA documentation is updated narrowly to reflect the new coverage.
