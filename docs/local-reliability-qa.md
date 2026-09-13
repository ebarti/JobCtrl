# Reliability & QA

Choose the smallest proof for the accepted outcome. The installed devflow skill
owns execution and evidence; this page selects JobCtrl's risk and product checks.
Explicit plans may raise the requirement. Never reduce security, privacy, data,
migration, release or submission proof to save time.

| Risk | Required proof and independent gates |
| --- | --- |
| 0: prose/comments/format only, no contract effect | `git diff --check`; docs build for published content/links; no artificial tests or role tasks |
| 1: contained internal/tooling/instruction change | Touched checks, diff check, one independent review; instruction changes include conflict/link review |
| 2: UI/CLI/API/integration/workflow behavior | Tier 1 plus actual product-path QA; review and QA PASS |
| 3: privacy/security/user data/migrations/releases/submission | Applicable full risk matrix, meaningful regression fixture, operational/product proof; review and QA PASS |

No unresolved Blocker/High may remain. Missing required proof is BLOCKED. Fix and
rerun the failed gate with the same reviewer/QA identity. Repeat passing checks
only after relevant changes or unresolved risk. Report commands, results, limits
and the delivered ref. Contract-only high-risk groundwork needs independent
review and safety checks; record product QA as mandatory at first execution.
Approved unreleased stacks use focused checks and review per phase, then canonical
docs and cumulative product QA in the final PR. Active high-risk paths keep their
normal gates. Human-found major UI regressions need a fixture or explicit scenario.

<a id="required-commands"></a>

| Surface | Starting command / selected recipe |
| --- | --- |
| API | `corepack pnpm api:check`, focused `api:test` / `api` |
| Web | `corepack pnpm web:check`, focused `web:test`, `web:build`; types/stories/browser when affected |
| Extension | `extension:check`, `extension:test`, `extension:build`, `extension:e2e` through Corepack |
| Worker | Locked focused Ruff/pytest; full worker suite for worker-wide changes |
| Scripts | `node --test scripts/<name>.test.mjs` |
| Docs | `corepack pnpm docs:build`, diff check |
| Cross-stack | `corepack pnpm check`, `corepack pnpm test`, affected separate web suites |

Executable workflow recipes live in `.devflow/checks.toml`; select or add a focused
recipe before admission. JUnit recipes require executed test cases and reject
skipped required cases. Exit zero or a build alone is not product QA.

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

Also repeat an already-claimed robots retry with a real enrichment lease, inject
retry update failures and lost comparisons, and reject superseded owners. Verify
unchanged metadata and accepted enrichment artifacts after failed persistence.
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
