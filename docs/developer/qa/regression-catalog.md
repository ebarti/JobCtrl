# Regression Catalog

Use this page when a change touches a product invariant with costly failure.
Choose the risk family first; the
[complete checklist](complete-checklist.md#high-risk-regression-areas) maps each
individual regression to exact test files.

## Risk Families

| Boundary | What must remain true | Proof shape |
| --- | --- | --- |
| Apply safety | No live submission without binding approval; dry-run cannot write; submit intent is at most once. | Apply saga/unit tests plus a disposable browser harness. |
| Durable workflows | Accepted work resumes or terminalizes correctly across restart, cancellation, and history loss. | Workflow tests plus targeted fault injection. |
| Storage and projections | Schema versions are guarded; canonical writes and read projections agree; accepted artifacts survive retries. | Repository/projection tests and API readback. |
| Credentials and privacy | Secrets, profile content, raw mail, contact values, paths, and artifacts do not leak into settings, events, logs, or projections. | Boundary tests plus response/event inspection. |
| Scoring and materials | Evidence, policy version, provenance, judge output, and fabrication gates remain inspectable and honest. | Deterministic fixtures, quality evals, and inspector smoke. |
| Frontend state | URL/server/client state stay in their owning layers; every event and stage state has a handler/rendering path. | Hook/component/type tests plus parity tests. |
| Integrated redesign | Visual recomposition preserves every pre-redesign value, control, state, and action while adapting without overflow. | Same-fixture semantic parity records, primitive/component tests, full E2E, and an in-app browser sweep. |
| Pipeline operations | Execution topology, privacy, refresh behavior, ETA, freshness, and capacity remain truthful and separately inspectable. | API/read-model tests, pipeline view fixtures, invalidation tests, and browser observation. |

## Temporal Fault Injection

For the affected workflow, prove four outcomes:

1. Kill the worker mid-activity: the same workflow resumes from durable history
   or reaches its designed verification state.
2. Cancel the run: cancellation propagates and the read model eventually shows a
   terminal state without deleting completed facts.
3. Make Temporal unavailable at start: the caller receives a clear error and no
   in-process fallback runs.
4. Lose local dev-server history: the reconciler terminalizes orphaned open rows.

The [complete matrix](complete-checklist.md#temporal-fault-injection-matrix)
lists the exact tests for Discover, Pipeline, Preparation, Apply, Profile Import,
Compensation Refresh, and Interview Prep workflows.

## Durable-Execution Recovery Demo

`scripts/reliability-demo.sh` runs an isolated, no-crawl, no-LLM, no-browser
worker-kill demonstration. It verifies that the same diagnostic run IDs remain
running while the worker is down and complete exactly once after restart.

```bash
scripts/reliability-demo.sh
scripts/reliability-demo.sh 5
scripts/reliability-demo.sh 3 40
```

The script uses a throwaway `JOBCTRL_DIR` and isolated ports. Do not adapt it to
run against `~/.jobctrl`.

## Auditability Checks

For score, rationale, materials, Apply Review, outcomes, or outreach changes,
trace each displayed claim to its source of truth. A passing UI snapshot is not
enough when the value could come from the wrong layer.

Check input evidence, deterministic/LLM transforms, validator or judge output,
persistence, projection/API shape, and rendering. Missing evidence must render
as missing—not be inferred, hidden, or replaced with reassuring copy.

## Integrated Redesign Contract

For a route or product-wide visual redesign, compare the before and after
surface against the same production-shaped fixture. The parity record is keyed
by route/surface and includes accessible labels and roles, visible fixture
and data values, controls and actions, status discriminants, warnings, audit
facts, unavailable/loading/empty/error states, and keyboard-reachable
disclosures, tabs, or detail routes. Layout may change; deleting or weakening a
legacy entry in the record to make the redesign pass is not acceptable.

Treat information density as part of that parity contract. Statuses and
pipeline diagnostics must not regress into rounded colored capsules or one
rounded card per datum. In job **Preparation diagnostics**, verify diagnostics remain compact
ruled rows with every existing value and action intact. Ledgers, disclosures,
and inspectors stay neutral; statuses use a small dot/glyph plus text; and the
active tab uses an underline rather than a filled capsule. Job, artifact,
contact, and run details remain full route workspaces.

The final browser matrix is 1440px, 1280px, collapsed rail, and 390×844 in
light/dark themes and compact/regular/comfortable density. At each size, verify
adaptive grids and tool rows retain deliberate spacing, controls remain
reachable, and the document has no horizontal overflow. The shared-composition
contract also requires:

- a real checkbox with an announced disabled reason for `ChoiceControl`;
- an associated label plus Tab, Enter/Space, Arrow-key, Enter, and Escape
  behavior for `SelectField`;
- mounted form content and preserved values when `DisclosureSection` is
  collapsed;
- compact controls above the named, real, full-width
  `ResumeStandalonePlateEditor` and its production toolbar in
  `PreviewWorkbench`.

Automated starting points are
`apps/web/src/shared/ui/redesign-compositions.test.tsx`,
`apps/web/src/contexts/profile/components/ResumeTemplatePanel.test.tsx`, and
`apps/web/e2e/tests/route-visual-qa.spec.ts`. They do not replace the complete
semantic parity record or the in-app browser route sweep.

## Pipeline Operations Contract

Use a production-shaped execution fixture with exactly three source families
and two reconciliation steps. `/pipelines` must show the three families as one
source-family plan and must show enrichment plus preparation fanout as the two
separate reconciliation steps; it must not flatten those facts into an invented
stage count or whole-pipeline completion percentage.

Also verify that URL-shaped or otherwise sensitive job identifiers are withheld
from the operations inspector and that raw activity inputs never enter the read
model or DOM. Pipeline step/stage/workflow events must invalidate
`pipelineKeys.operations`, while active and idle polling remain a 15-second and
60-second fallback respectively when no event arrives, with background polling
disabled. ETA must preserve available/calibrating/paused/stale/unavailable
states; freshness must preserve fresh/stale/unsupported/unavailable; capacity
must preserve available/stale/unavailable; and nested task-queue evidence must
preserve available/stale/unsupported/unavailable. Show basis, sample/calibration
state, observation time, worker/slot counts, and explicit reasons without
synthesizing certainty.

The focused automated evidence is
`apps/api/test/pipeline-operations.test.ts`,
`apps/api/test/pipeline-eta.test.ts`,
`apps/api/test/worker-runtime-telemetry.test.ts`,
`apps/web/src/views/pipelines/PipelinesView.test.tsx`,
`apps/web/src/contexts/operations/hooks/usePipelineOperationsQuery.test.ts`, and
`apps/web/src/contexts/operations/invalidation-router.test.ts`. Complete the
proof by observing refresh, stale/calibrating/unavailable states, privacy
masking, and responsive layout in the in-app browser.
