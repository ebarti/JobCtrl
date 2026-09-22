# Reliability & QA

Choose the smallest proof for the accepted outcome. This page selects JobCtrl's
risk and product checks.
Explicit plans may raise the requirement. Never reduce security, privacy, data,
migration, release or submission proof to save time.

| Risk | Required proof and independent gates |
| --- | --- |
| 0: prose/comments/format only, no contract effect | `git diff --check`; docs build for published content/links |
| 1: contained internal/tooling/instruction change | Touched checks, diff check, one independent review; instruction changes include conflict/link review |
| 2: UI/CLI/API/integration/workflow behavior | Tier 1 plus actual product-path QA; review and QA PASS |
| 3: privacy/security/user data/migrations/releases/submission | Applicable full risk matrix, meaningful regression fixture, operational/product proof; review and QA PASS |

No unresolved Blocker/High may remain, and required scenarios need observed
results. Contract-only high-risk changes require independent review and safety
checks, with product verification before first use. Major UI regressions require
a regression test or an explicit reproducible scenario.

<a id="required-commands"></a>

| Surface | Starting command / selected recipe |
| --- | --- |
| API | `corepack pnpm api:check`, focused `api:test` / `api` |
| Web | `corepack pnpm web:lint`, `corepack pnpm web:check`, focused `web:test`, `web:build`; types/stories/browser when affected |
| Extension | `extension:check`, `extension:test`, `extension:build`, `extension:e2e` through Corepack |
| Worker | Locked focused Ruff/pytest; full worker suite for worker-wide changes |
| Scripts | `node --test scripts/<name>.test.mjs` |
| Docs | `corepack pnpm docs:build`, diff check |
| Cross-stack | `corepack pnpm check`, `corepack pnpm test`, affected separate web suites |

Focused commands live in `scripts/checks.toml`. Run the selected `argv` directly,
substituting an owned artifact path for `{report_path}`. Required tests must
execute; zero tests, skipped required cases or a build alone are not product QA.

<a id="pick-the-right-checklist"></a>
<a id="high-risk-regression-areas"></a>

Read only the relevant [regression catalog](developer/qa/regression-catalog.md),
[browser path](developer/qa/browser-smoke.md), [frontend layer](developer/qa/frontend.md)
or [detailed matrix](developer/qa/complete-checklist.md).

<a id="pull-request-ci"></a>

[CI behavior](local-development.md#pull-request-ci) follows executable workflows;
root aggregates do not cover separate web unit/type/E2E/Storybook suites.

<a id="temporal-fault-injection-matrix"></a>
<a id="durable-execution-recovery-demo"></a>
<a id="cumulative-rheabase-ui-final-gate"></a>

Temporal fault injection, recovery and cumulative Rhea/Base UI scenarios now live
in the [detailed matrix](developer/qa/complete-checklist.md).

## Discovery Transaction Recovery

Run the `discovery-transactions` recipe for preparation or enrichment transaction
changes. Seed failed and exhausted Tailor rows whose downstream stages are already
reconciled, with a scoring policy already present. Repeat the empty preparation
selection: zero changed rows must still release SQLite's writer before another
connection persists lifecycle/source events or the cached connection claims an
enrichment lease. A failed dependent update must roll back the whole reconciliation;
an inherited caller transaction must remain under that caller's control.

The recipe also separates the two waits that can surface at a lease claim. Hold a
writer on an independent connection and prove a configured SQLite busy wait fails
within the subprocess guard, then succeeds after release. In a diagnostic-only
probe, inject one connection into another thread: the default connection must
reject wrong-thread use, while an explicitly shareable connection must demonstrate
that its connection-object mutex is independent of `busy_timeout`. Run these probes
behind subprocess deadlines so a failed concurrency assertion cannot retain a test
runner thread. Confirm the real activity worker pool reuses a connection only on its
own thread, and record the production connection budgets (10 seconds for a new WAL
connection and 30 seconds for a freshly admitted exact-v10 connection). The short
fixture timeout proves mechanism and recovery; it is not a production latency bound.

Also repeat an already-claimed robots retry with a real enrichment lease, inject
retry update failures and lost comparisons, and reject superseded owners. Verify
unchanged metadata and accepted enrichment artifacts after failed persistence.
Race different owners for the same phase and attempt and require exactly one claim;
then prove a newer attempt and the terminal phase supersede it, including stale-fence
rejection.
The owned Temporal `DiscoverWorkflow` fixture runs production preparation,
lifecycle, enrichment, and terminal event persistence with connected and offline
acquisition, an already-retried blocked row, and a healthy peer whose description
must persist. Its source activity, browser/broker transport, and preparation
workflow dispatch are synthetic; it does not exercise personal Chrome, external
sources, scoring or material generation. Pair this with the applicable live
Discovery proof from the regression catalog before claiming runtime recovery.

## Safe QA Data

Use uniquely owned synthetic workspaces. Never point QA at real profiles,
application artifacts or databases. Confirm worker health for worker-backed
paths. Browser launch failure and inaccessible required runtime are nonpassing.
No application submission is implied by a QA request.
