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
| Integrated web redesign | [Integrated Redesign Final Gate](#integrated-redesign-final-gate) |
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
| A page, detail workspace, review flow, artifact, or browser extension | [Browser Smoke](developer/qa/browser-smoke.md) |
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
revocation, the three-section Settings route at desktop/mobile width, the demo
read-only boundary, and a sole-provider draft plus synthesis path without making
a live model call. For model selection, use deterministic SDK fakes to prove
catalog order, ready-only listing, Codex hidden/invalid filtering, Google
generate-content filtering, Claude runtime-catalog normalization, stable deduplication, and
sanitized failures. Prove settings reject an unready provider or unoffered ID,
allow a clear while unready, persist no credential data, and exercise precedence
for explicit workflow, selected-provider preference, and provider default
without executing a live provider request.

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

## Integrated Redesign Final Gate

A cross-route redesign is not covered by sampling one component or one route.
Run every static, component, Storybook, and browser layer on the assembled
integration tip:

```bash
corepack pnpm check
corepack pnpm test
corepack pnpm qa:test
corepack pnpm --filter @jobctrl/web test
corepack pnpm --filter @jobctrl/web test-d
corepack pnpm web:build
corepack pnpm web:storybook:build
corepack pnpm web:storybook:test
corepack pnpm --filter @jobctrl/web e2e
git diff --check
```

After the automated gate, use the in-app browser against the disposable seeded
stack from [Safe QA Data](#safe-qa-data) and walk every production route and
detail route. Playwright screenshots do not replace this sweep. Record evidence
for all of the following:

- light and dark themes plus compact, regular, and comfortable density at
  1440px, 1280px, collapsed-rail width, and 390×844; adaptive grids and tool
  rows must reflow with deliberate spacing and no document-level horizontal
  overflow;
- every pre-redesign label/role, data value, field, control, action, status
  discriminant, warning, audit fact, and unavailable/loading/empty/error state
  remains visible or keyboard-reachable from the same production-shaped
  fixture; the baseline may not be weakened after migration;
- dense operational surfaces do not turn statuses or pipeline diagnostics into
  rounded colored capsules or one rounded card per datum: job **Preparation diagnostics**
  diagnostics remain compact ruled rows; ledgers, disclosures, and inspectors
  stay neutral; statuses use a small dot/glyph plus text; and the active tab is
  identified by an underline rather than a filled capsule;
- `ChoiceControl` uses a real checkbox and announces any disabled reason,
  `SelectField` has an associated label and supports full keyboard selection,
  and collapsed `DisclosureSection` content remains mounted while hidden;
- `PreviewWorkbench` keeps compact controls above the named, real, full-width
  `ResumeStandalonePlateEditor` and its production toolbar rather than a
  placeholder, split thumbnail, or name-only template swap;
- `/pipelines` keeps three source families under one source-family plan and
  separately renders exactly two reconciliation steps (Enrichment pass and
  Preparation fanout), without blending them into a stage count or completion
  percentage; it omits raw/private workflow inputs and masks URL-shaped job
  identifiers; lifecycle SSE events invalidate the operations query while
  active/idle 15s/60s polling remains a no-background fallback; and ETA,
  freshness, capacity, and task-queue facts preserve their explicit states and
  reasons (ETA available/calibrating/paused/stale/unavailable; freshness
  fresh/stale/unsupported/unavailable; capacity available/stale/unavailable;
  task queue available/stale/unsupported/unavailable) without inventing an ETA,
  inventory total, or worker capacity.

The redesign gate is incomplete until the semantic pre/post parity record and
the in-app route-sweep evidence are attached to the review handoff. See the
[Frontend QA guide](developer/qa/frontend.md#integrated-redesign-contracts) and
[Browser Smoke guide](developer/qa/browser-smoke.md#integrated-redesign-route-sweep)
for the detailed assertions, and the
[Complete Checklist](developer/qa/complete-checklist.md#integrated-redesign-final-gate)
for the exhaustive evidence record.

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
