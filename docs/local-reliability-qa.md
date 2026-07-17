# Reliability & QA

Use this page to choose the smallest QA surface that proves a change. The
complete risk matrix still exists, but the common commands and browser paths
come first.

**No single aggregate covers every layer.** Match commands to the changed
contract; do not add cross-stack checks "just in case." For an approved
unreleased stack, run focused checks per phase, finish canonical docs in the
final PR, then run product QA on the cumulative stack.

## Required Commands

| Change | Minimum starting point |
| --- | --- |
| Cross-stack behavior | `corepack pnpm check` and `corepack pnpm test` |
| TypeScript API | `corepack pnpm api:check` and `corepack pnpm api:test` |
| Web UI | `corepack pnpm web:check`, `corepack pnpm --filter @jobctrl/web test`, and `corepack pnpm web:build` |
| Frontend types | `corepack pnpm --filter @jobctrl/web test-d` |
| Browser flow | `corepack pnpm --filter @jobctrl/web e2e -- tests/<flow>.spec.ts` |
| Public demo browser workspace | `corepack pnpm --filter @jobctrl/web e2e:demo-workspace` |
| Public demo edge | `corepack pnpm demo-edge:check`, `corepack pnpm demo-edge:test`, and `corepack pnpm demo-edge:dry-run` |
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

### Broad-board commit/ack recovery

Broad-board discovery adds a stricter fault boundary inside the source-family
activity. The hermetic fixture commits the first JobStreaming posting and its
acceptance receipt, blocks the provider acknowledgement, kills that worker,
starts a fresh worker on the same Temporal task queue, and verifies the same
Discover execution completes from the stored checkpoint. It also covers
unacknowledged replay, durable result limits, activity-attempt fencing, cursor
reset ordering, partial board failure, incompatible cursor schemas, and
cooperative cancellation. It uses fake local adapters and performs no external
crawl:

```bash
uv --project workers/automation run pytest -q \
  workers/automation/tests/test_jobstreaming_resumable_discovery.py \
  workers/automation/tests/test_discovery_search_units.py \
  workers/automation/tests/test_jobstreaming_gateway.py
```

<a id="durable-execution-recovery-demo"></a>

## High-Risk Regression Areas

The highest-risk boundaries are apply submission safety, credential/privacy
containment, workflow durability, projection correctness, schema compatibility,
and accepted-artifact preservation. The
[Regression Catalog](developer/qa/regression-catalog.md) explains which layer
proves each class of invariant; the complete page maps every risk to exact tests.

### Pipeline history recovery and restart regression

Reproduce the human-reported partial-projection state with an active Discover
execution, 72 expected execution members, 15 persisted members, 16 expected
pipeline-step keys, four persisted keys, one live source-family activity, three
live tailoring activities, and an approximate activity backlog of 41. Verify:

- the durable checkpoint and operations response remain `recovering`; partial
  row counts, active slots, and fresh telemetry never promote it to `ready`;
- the UI renders **Restoring pipeline history**, the 15/72 and 4/16 restoration
  progress, and the live worker/queue/activity facts;
- selected-run counts, stage percentages, source/reconciliation ledgers, ETAs,
  **0%**, and **No work remaining** stay hidden until the checkpoint is `ready`;
  and
- a stale `ready` row whose exact key digest no longer matches is downgraded to
  `recovering` by the API and selected for worker repair;
- an idle snapshot with no selected execution has `projectionCoverage: null`
  only when fresh available telemetry proves zero active slots; occupied, stale,
  or unavailable runtime inventory reports `recovering` instead of fabricated
  idle or `ready`; and
- a non-ASCII membership and stage-key golden vector hashes identically in the
  Python recovery writer and TypeScript API validator.

Then exercise the write-side recovery controller with legacy queued, running,
completed, and failed activities, a mixed legacy/native history, and a true
empty native execution. Kill the worker after a partial replay while leaving
Temporal running, restart the worker, and verify that startup reconciliation:

1. resumes from the exact workflow/run history without starting, canceling, or
   signaling a discovery workflow;
2. restores source and backlog memberships, work plans, and step lifecycle
   events without duplicates;
3. records the current Temporal history-event watermark and exact membership
   and step-key digest; and
4. publishes `ready` only after projection refresh and exact set equality.

The legacy fixture must also reproduce the lossy projection shape: repeated
fanout passes declare `0`, `71`, `67`, and `34` targets with legitimate overlap,
the folded workflow projection retains only `jobUrl`, and the append-only event
log retains both causal job-only starts and exact full summaries. Verify decoder
v2 derives the 72-member union from each fanout's exact interval, rejects a
per-pass target-count or workflow-run mismatch, restores all 16 declared stage
keys, persists `legacy_history_recovery` as a valid bounded reason code, and
reaches a verified 72/72-membership and 16/16-step `ready` checkpoint.

For ambiguous mapping or a transient history read, verify `retrying` with a
bounded error code, automatic heartbeat retry, and no mutation of the running
workflow. Run the focused worker reconciliation tests, API checkpoint tests,
Pipelines component tests, and the live browser path together. The live pass
must compare the operations response with the rendered workspace so shared-pool
telemetry cannot be mistaken for selected-run proof.

Also cover the retry and terminal edge cases. A successful fanout retry with
`attempt > 1` must restore exact membership and steps without inventing a queue
timestamp. A failed attempt that is waiting to retry, or a later attempt that is
still running, must remain non-terminal and cannot publish `ready` or a false
failed step. A canceled or terminally failed fanout with no retry remaining must
preserve its exact partial membership, work plan, failed-step evidence, digest,
and watermark as `projectionCoverage.status = incomplete`. Its expected counts
remain unknown in the API and UI. Restart the worker and verify that the closed
incomplete run is not selected for automatic repair again. Pipelines must label
the history as incomplete, avoid claims about the missing remainder, and expose
**Set up a new Discover run** only when active work is exactly zero.

Finally, begin from a valid `ready` manifest and force a transient history-read
failure. Verify the worker first demotes it to `retrying`, preserves the prior
proof for audit, and returns to `ready` after the authoritative history becomes
readable; it must not leave stale ready data published during the failure.

### Public demo privacy and edge gate

When consent, cookies, telemetry, D1, retention, or Cloudflare configuration
changes, the edge suite must prove that decline creates no analytics identity,
grant is required before telemetry, cookie attributes and versioning remain
exact, event fields stay allowlisted, retries do not double-count, rate limits
fail closed, and expired identities/events/counters are deleted. Before public
cutover, also repeat the consent and retention paths through local Wrangler and
the production-mode browser lane. Verify direct SPA deep links, Pages security
headers, the same-origin `/api/*` route, D1 migration state, and one Pages
rollback before calling the public deployment healthy.

### Provider setup gate

When provider auth, Settings credentials, model routing, or employer analysis
changes, prove each sanctioned provider independently: Codex persisted CLI auth,
Claude API/cloud auth, Google Gemini key, Google standard ADC, and an existing
regular `GOOGLE_APPLICATION_CREDENTIALS` service-account file. Project metadata,
missing credential files, consumer Claude OAuth, raw OpenAI keys, and deferred
local/custom endpoints must not unlock readiness. Inject a failure at every
Keychain batch boundary and prove exact rollback, then exercise provider-level
revocation, the three-card Settings route at desktop/mobile width, the demo
read-only boundary, and a sole-provider draft plus synthesis path without making
a live model call. For model selection, use deterministic SDK fakes to prove
catalog order, ready-only listing, Codex hidden/invalid filtering, Google
generate-content filtering, Claude runtime-catalog normalization, stable deduplication, and
sanitized failures. Prove settings reject an unready provider or unoffered ID,
allow a clear while unready, persist no credential data, and exercise precedence
for explicit workflow, selected-provider preference, and provider default
without executing a live provider request. When an active provider route is
environment-owned, prove its secret and removal controls stay read-only while
another supported route remains editable. Saving that alternative must not
displace the active environment route before the environment value is removed
and the relevant process restarts.

### Browser capability adoption gate

When browser detection, adoption, profile copying, or Settings browser UI
changes, prove that listing capabilities only performs passive detection and
returns opaque browser kinds plus labels—never executable paths. Listing must
not launch, adopt, or persist a browser. Enabling requires an explicit detected
selection or one advanced manual path, re-resolves a detected selection at
mutation time, and fails closed when the installation disappeared. Profile-copy
consent remains a separate affirmative action; capability enablement must not
imply it.

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
one-time seed-version refresh with generated-blob cleanup,
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
external effect. It also proves the admitted Demo guide reaches the seeded
scoring, materials, Apply Review, and run-history shortcuts before a confirmed
workspace reset. Every scenario test installs a strict
request guard that rejects product API, SSE, and external-origin traffic. Unit
and component tests cover seed-refresh quota/memory fallback, other injected
quota/security fallbacks, schema revalidation, reset-epoch races, event-log
loss, read-adapter query/404/capability parity, valid arguments for every
browser-local command plus focused projection, replay, cascade, and
quota-rollback invariants, the reactive data-boundary warning, and the unchanged
canonical event provider/invalidation router.
Playwright artifacts are written outside the repository under the system
temporary directory.

The same lane begins with three consent regressions: no IndexedDB, health, or
product telemetry before a confirmed grant; anonymous decline redirects even
when measurement fails; and a denied revisit renders the acceptance-required
gate again. Existing product journeys use a granted same-origin API stub, so
the full suite also proves the gate does not regress admitted sessions.

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

## Cumulative Rhea/Base UI Final Gate

Run this gate after the cumulative redesign branch has its canonical docs and
synthetic fixtures. It complements focused phase checks; it is not a substitute
for the security, apply, or workflow matrices above.

```bash
corepack pnpm --filter @jobctrl/web exec vitest run \
  src/styles/token-contract.test.ts \
  src/styles/token-contrast.test.ts \
  src/styles/shared-layout-contract.test.ts \
  src/styles/profile-evidence-responsive-layout.test.ts \
  src/styles/apply-review-contacts-responsive.test.ts \
  src/shared/ui/base-ui-migration-boundary.test.ts \
  src/shared/layout/Topbar.test.tsx \
  src/shared/ui/button.test.tsx \
  src/shared/ui/data-table.test.tsx \
  src/shared/ui/label.test.tsx \
  src/shared/ui/page-head.test.tsx \
  src/shared/ui/filterable-data-grid.test.tsx \
  src/shared/stores/saved-table-views.test.ts \
  src/contexts/operations/components/BrowserCapabilitiesPanel.test.tsx \
  src/contexts/profile/components/CredentialsPanel.test.tsx \
  src/contexts/outreach/components/DueFollowUpsPanel.test.tsx \
  src/contexts/scoring/components/CompensationSourcePolicyPanel.test.tsx \
  src/contexts/materials/components/EmployerAnalysisPanel.test.tsx \
  src/contexts/materials/components/EmployerAnalysisPanel.a11y.test.tsx \
  src/contexts/materials/components/TailoringExplanationSection.test.tsx \
  src/contexts/pipeline/hooks/useCancelWorkflowRunMutation.test.ts \
  src/views/pipelines/PipelinesView.test.tsx \
  src/routes/-jobs.search.test.ts \
  src/views/jobs/JobBulkActions.test.tsx \
  src/views/jobs/JobBulkActions.a11y.test.tsx \
  src/views/jobs/JobsTable.test.tsx \
  src/views/jobs/JobsTable.a11y.test.tsx \
  src/views/jobs/JobsView.test.tsx \
  src/views/jobs/JobDetailDrawer.test.tsx \
  src/views/artifacts/ArtifactDetailPanel.test.tsx \
  src/views/evidence-map/EvidenceMapView.test.tsx \
  src/views/apply-review/ApplyReviewView.test.tsx \
  src/contexts/operations/hooks/usePipelineOperationsQuery.test.ts \
  src/contexts/operations/invalidation-router.test.ts
corepack pnpm --filter @jobctrl/api exec vitest run \
  test/pipeline-operations.test.ts \
  test/pipeline-eta.test.ts \
  test/worker-runtime-telemetry.test.ts \
  test/server.test.ts
uv --project workers/automation run --extra dev pytest -q \
  workers/automation/tests/test_browser_capabilities.py \
  workers/automation/tests/test_browser_capabilities_rpc.py
JOBCTRL_E2E_APP_DIR=/tmp/jobctrl-route-qa \
JOBCTRL_E2E_API_PORT=8878 \
JOBCTRL_E2E_WEB_PORT=5275 \
corepack pnpm --filter @jobctrl/web e2e -- tests/route-visual-qa.spec.ts
JOBCTRL_E2E_APP_DIR=/tmp/jobctrl-responsive-qa \
JOBCTRL_E2E_API_PORT=8879 \
JOBCTRL_E2E_WEB_PORT=5276 \
corepack pnpm --filter @jobctrl/web e2e -- tests/responsive-data-surfaces.spec.ts
git diff --check
```

The gate passes only when:

- `base-rhea`, Geist, the semantic token mappings, light/dark contrast, all
  three densities, a density-independent 16px body, the compact PageHead
  hierarchy, and the shared card/status rules remain intact;
- direct Radix imports and raw native selects are absent, Base UI overlays keep
  their focus/dismissal/portal contract, and route visuals show no clipping or
  document-level overflow at desktop and 390×844;
- Jobs exposes Active/Deleted/Hidden as real Tabs, keeps legacy `closed` only as
  a compatible deep-link state, hides Sources/Warnings in the default view,
  omits redundant active lifecycle copy, uses destructive deletion, and keeps
  row activation focus-visible without a permanent duplicate action;
- Jobs, Artifacts, Contacts, Discovery, and Settings record data reflows into
  labelled cards at 900px and below; Profile and Evidence Map stack their work
  regions, while Apply Review keeps a desktop queue rail and wraps decisions in
  its narrow sequential layout;
- Pipelines keeps source families separate from the two reconciliation steps,
  preserves execution/sweep/global-backlog scope and exact outcome counts,
  masks sensitive identifiers, refreshes after stopping active discovery, and
  gates replacement-run setup on an exact zero-active-work inventory without
  dispatching implicitly; compact inspector labels, values, and timestamps also
  remain on the same body-small typography scale;
- Job Detail and Artifact Detail resolve evidence through the Evidence Map into
  human-readable titles/excerpts, keep unresolved keys behind technical details,
  Artifact Detail places the preview after its audit details, and Apply Review
  preserves persisted comments even when a rendered-line anchor cannot be
  resolved;
- passive browser detection exposes no paths or side effects, stale detected
  IDs fail closed, manual path entry remains an advanced explicit fallback, and
  profile copying still requires separate consent;
- an environment-owned active provider route stays authoritative and read-only
  while alternative supported routes remain editable but inactive; and
- a retry with `runAfter: true` preflights worker readiness before resetting
  the failed stage. If the worker is unavailable, the API returns the readiness
  failure and preserves the stage state, attempt count, diagnostics, and audit
  evidence unchanged.

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
