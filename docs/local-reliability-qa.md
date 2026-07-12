# Reliability & QA

Use this page to choose the smallest QA surface that proves a change. The
complete risk matrix still exists, but the common commands and browser paths
come first.

**No single aggregate covers every layer.** Match the commands to the code you
changed, then add a browser/product-path check for user-visible behavior.

## Required Commands

| Change | Minimum starting point |
| --- | --- |
| Cross-stack behavior | `corepack pnpm check` and `corepack pnpm test` |
| TypeScript API | `corepack pnpm api:check` and `corepack pnpm api:test` |
| Web UI | `corepack pnpm web:check`, `corepack pnpm --filter @jobctrl/web test`, and `corepack pnpm web:build` |
| Frontend types | `corepack pnpm --filter @jobctrl/web test-d` |
| Browser flow | `corepack pnpm --filter @jobctrl/web e2e -- tests/<flow>.spec.ts` |
| Public demo browser workspace | `corepack pnpm --filter @jobctrl/web e2e:demo-workspace` |
| Python worker | `uv --project workers/automation run --extra dev ruff check .` and `uv --project workers/automation run --extra dev pytest -q` |
| Any patch | `git diff --check` |

Start the attached full stack with `corepack pnpm dev` when the path needs the
API, Temporal, worker, and web app together. Confirm `GET /v1/health` reports a
healthy worker before starting worker-backed stages.

## Pick The Right Checklist

| You changed… | Use |
| --- | --- |
| Workflow durability, apply safety, storage, or another known high-risk invariant | [Regression Catalog](developer/qa/regression-catalog.md) |
| A page, drawer, review flow, artifact, or browser extension | [Browser Smoke](developer/qa/browser-smoke.md) |
| Tokens, shared primitives, routes, state, realtime, Storybook, or accessibility | [Frontend QA](developer/qa/frontend.md) |
| A surface with a specific historical risk or exact test mapping | [Complete Checklist](developer/qa/complete-checklist.md) |

## Temporal Fault-Injection Matrix

The durable-execution rule is simple: accepted work survives a worker restart,
cancellation reaches a terminal observable state, an unavailable Temporal path
fails clearly at start, and a lost dev-server history is reconciled rather than
left open forever.

Use the workflow-by-workflow matrix in the
[Regression Catalog](developer/qa/regression-catalog.md#temporal-fault-injection)
or the [complete checklist](developer/qa/complete-checklist.md#temporal-fault-injection-matrix).

<a id="durable-execution-recovery-demo"></a>

## High-Risk Regression Areas

The highest-risk boundaries are apply submission safety, credential/privacy
containment, workflow durability, projection correctness, schema compatibility,
and accepted-artifact preservation. The
[Regression Catalog](developer/qa/regression-catalog.md) explains which layer
proves each class of invariant; the complete page maps every risk to exact tests.

<a id="scoring-policy-eval-gate"></a>
<a id="saved-views-smoke"></a>
<a id="daily-digest-smoke"></a>
<a id="resume-tailoring-quality-eval-gate"></a>

## Frontend QA

Frontend verification has four distinct jobs: logic/type correctness,
component accessibility, route-level browser behavior, and visual consistency.
The [Frontend QA guide](developer/qa/frontend.md) gives the commands and the
[Browser Smoke guide](developer/qa/browser-smoke.md) gives the user paths.

The dedicated demo-workspace Playwright lane starts Vite only; it must not
start or contact the product API or SSE endpoint. It proves same-profile tab
sharing and concurrent writes, separate-context isolation, reload persistence,
atomic reset/blob deletion, future IndexedDB-version refusal without downgrade,
post-commit domain-event delivery, and populated direct-refresh coverage for
the demo's dashboard, product routes, and seeded detail deep links. It also
exercises real source promotion, manual-capture import, and score correction
through the shared UI, proving that the results are reload durable and
product-network-free; score correction is also cross-tab visible. Native
browser coverage also proves that eventless Discovery and Settings writes
trigger a broad cross-tab resync and remain durable after reload. The same lane
drives deterministic queued, running, and terminal stage scenarios through
accessible product controls; covers the Contoso fail-first tailoring retry;
checks receipt history across reload and same-profile tabs; and rehearses
artifact preview, application dry-run, and mark-applied actions without an
external effect. Every scenario test installs a strict
request guard that rejects product API, SSE, and external-origin traffic. Unit
and component tests cover injected quota/security fallbacks, schema revalidation,
reset-epoch races, event-log loss, read-adapter query/404/capability parity,
valid arguments for every browser-local command plus focused projection,
replay, cascade, and quota-rollback invariants, the reactive data-boundary
warning, and the unchanged canonical event provider/invalidation router.
Playwright artifacts are written outside the repository under the system
temporary directory.

<a id="token-foundation-qa-gate"></a>
<a id="shared-primitive-qa-gate"></a>
<a id="route-visual-qa-gate"></a>
<a id="coverage-layout"></a>
<a id="scoring-policy-feedback-smoke"></a>
<a id="jobs-drawer-audit-smoke"></a>
<a id="evidence-map-smoke"></a>
<a id="apply-review-smoke"></a>
<a id="materials-generation-inspector-smoke"></a>
<a id="outreach-draft-review-smoke"></a>
<a id="outreach-planner-product-smoke"></a>
<a id="interview-prep-smoke"></a>
<a id="parity-tests"></a>
<a id="browser-extension-qa"></a>
<a id="accessibility-bar"></a>
<a id="storybook-gate"></a>

## Safe QA Data

Use synthetic or disposable workspaces for destructive, browser, extension,
mailbox, materials, and workflow QA. Do not run application submission, scan a
real mailbox, spend against a live model, or mutate a real profile/database just
to verify a change.

```bash
corepack pnpm qa:seed /tmp/jobctrl-qa
JOBCTRL_DIR=/tmp/jobctrl-qa corepack pnpm api:dev
VITE_JOBCTRL_API_BASE_URL=http://127.0.0.1:8766 corepack pnpm web:dev -- --port 5173
```
