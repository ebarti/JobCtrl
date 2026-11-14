# Local Python API Contract

The accepted [Python transformation](../plans/2026-11-06-python-transformation.md)
is **in progress**. This is the target contract and a route-family index, not an
exhaustive declaration that every former endpoint, field or journey has been
ported. Feature adapters in `workers/automation/src/jobctrl/features/` own
their actual routes and DTOs; the composed candidate and integrated E2E proof
establish what works. The legacy TypeScript API and JSON-RPC bridge are removed
at cutover, without a forwarding bridge or a second business writer.

## Cross-cutting HTTP contract

The foundation reserves `/v1/health`, `/v1/settings`, `/v1/credentials`,
`/v1/events/stream`, `/v1/actions/{action}` and `/v1/action-runs/{run_id}`.
Feature-owned `/v1/...` routes register explicitly. The intended error envelope
is `{ "error": { "code": "...", "message": "...", "details": {} } }`;
`details` is optional. Unexpected errors use a generic message and request ID,
not exception text or secrets. Ordinary reads/writes use 200/201; a durable
submission returns 202 only after Temporal accepts it. Completion is a separate
state. A revision conflict is a conflict, not permission to overwrite newer data.
See [foundation contract](../plans/2026-11-06-python-contracts.md) and
[operations](operations-and-events.md).

## Profile and preferences

<a id="candidate-profile"></a>
Profile owns facts, sources, evidence, confirmations, preferences, authored
baseline and wording approval. Reads and writes must preserve source/version
identity and reject stale edits. See [Profile and Settings](profile-and-settings.md).

The Original candidate adds pending wording edits/history, explicit proposed
revision lineage and targeted removed-role/achievement recovery. Search place
bindings retain row identity, selected provider/place metadata and exact text;
typing invalidates an earlier selection. These writes do not assess meaning or
start model work. Exact fields remain owned by the focused API reference.

## Jobs read model and lifecycle

<a id="saved-posting-availability"></a>
Jobs owns manual capture, identity and posting snapshots, independently of
optional Discovery. Reads must distinguish unavailable checks from confirmed
closed postings and preserve the last accepted source evidence on failure.
The Python composer declares `GET /v1/jobs/query`, which applies literal filters
and sorting before pagination and composes feature-owned summaries in a shared
read snapshot. Its query revision fences continuation; exact DTOs and integrated
browser verification remain subject to the current candidate.
See [Jobs and Materials](jobs-and-materials.md#jobs-and-evidence).

## Discovery controls

<a id="discovery-target-search"></a>
Discovery owns search configuration, sources, schedules and execution; a
schedule is explicitly enabled and off by default. Source policy, budgets,
run ownership, retry and cancellation remain binding. Exact migrated controls
must be checked in the Discovery adapter and real product journey.

## Requirements and Fit

Requirements exposes reusable Skills/Professional Experience meanings, direct
job-local Education/Languages demands, source occurrences and corrections;
Fit exposes person qualification and approved-wording coverage as distinct
records. One model determination compares the full incoming reusable batch with
the complete current-generation catalog and retains source versions and
provenance. All four categories use one missing-qualification batch with
section-specific evidence. Education's explicit equivalent-experience route is
recorded without asserting a degree; Languages use structured Language /
Proficiency records only. A current section-backed match creates no
achievement-wording gap and wording does not lower person fit. Source or
revision changes invalidate stale authority. The Fit
adapter declares `/v1/jobs/{job_id}/fit`, assessment, correction, history and
coverage routes. Post-edit reassessment uses the durable `fit.refresh` action,
an expected saved-input stamp, explicit job scope and finite work limits.
Read-only pending and operation routes never start model work. Exact methods,
DTOs and failure boundaries live in the [Fit reference](../../workers/automation/src/jobctrl/features/fit/README.md).
Route declarations alone do not establish integrated E2E or released behavior.

New documents carry `contract_version: requirements-v2`; missing versions are
legacy. Old accepted rows and bytes remain history with contract-change refresh
status and cannot establish current ranking/composition readiness. A
source-bound English-language gate precedes extraction; non-English postings
are skipped without translation or a zero score. `requirement-fit-v3-equal`
gives one item to each distinct canonical requirement and direct demand, with
no source weights, must-have multiplier or blocker cap. See
[typed job requirements](jobs-and-materials.md#typed-job-requirements) and the
[score formula](../user/scoring-and-employer-analysis.md#how-the-score-is-calculated).

The independent library also reads canonical meaning/occurrence history and
Profile-scoped requirement relationships. Manual association creation/removal/
restore is revision-fenced, history-preserving and always unassessed. It cannot
change qualification, coverage, score, approval, current semantic authority or
an accepted document. See
[Requirements library and associations](jobs-and-materials.md#requirements-library-and-associations)
for routes and DTO boundaries.

## Artifacts and tailoring audit

<a id="accepted-material-docx-exports"></a>
<a id="material-locale-variants"></a>
Resumes owns composition, edits, advisory review, acceptance, rendering and
locale exports. The manifest identifies the approved wording and requirements
used in the document; accepted exports are bound to the accepted source
revision. A failed replacement preserves the prior artifact and bytes. Format
and route details require integrated verification; see
[tailoring](../architecture/tailoring.md) and [locale variants](../architecture/material-locale-variants.md).

## Apply review and outcomes

<a id="manual-action-retry-contract"></a>
Applications owns screening answers, payload approval, assisted execution and
outcomes. Approval binds the exact payload and current inputs; durable intent and
receipt checks prevent duplicate external effects. If acknowledgement is lost,
report an ambiguous outcome and require verification before retry. Resumes owns
its own artifact acceptance. See [apply containment](../developer/security.md#apply-path-containment).

## Contacts

<a id="outreach-drafts"></a>
Contacts owns contact facts, import and research. Outreach separately owns
reviewed drafts, communication state and receipts. Drafting is not send
authority; stale approval, conflicting edits or uncertain outcomes must be
handled explicitly. See [Jobs and Materials](jobs-and-materials.md#contacts-and-outreach).

## Compensation

<a id="actual-offer-terms-and-decisions"></a>
Compensation provides source-bound pay evidence and neutral calculations.
Offers owns actual terms, scenarios, decisions and correction history. Unknown
terms remain unknown and no offer decision creates an application submission.

## Interview catalog, preparation, and notes

Interviews owns catalog, preparation and independently revisioned notes. Bind
selected accepted evidence to the exact question and source; an explicit empty
selection stays empty. Failed replacement preserves accepted preparation and
notes. Learning and Digest are separate owners; completing an activity does not
establish Profile evidence or change Fit.

## Company briefings

Companies owns optional research and explicit identity. Consumers use public
snapshots; a missing briefing does not prevent manual job capture.

## Feedback learning and policy history

<a id="selected-cohort-demand-and-milestones"></a>
User corrections, feedback and learning activity retain their own authority and
history. Personalization requires explicit user action where it changes saved
policy; it cannot silently change facts, existing scores, approvals or accepted
artifacts. Selected demand and milestone activity are not evidence of skill.

## Dashboard, analytics, and operational metrics

<a id="pipeline-and-preparation-actions"></a>
The shell composes feature-owned reads and commands. Metrics distinguish
execution identity, current versus global work and known versus uncertain
status. See [operations and events](operations-and-events.md).

## Server-Sent Events

<a id="server-sent-events-—-get-v1eventsstream"></a>
<a id="dry-run-completion"></a>
<a id="database-failures"></a>
Events are bounded invalidations committed with the canonical mutation; SSE
reads only committed events. Consumers re-read feature-owned data. A stream or
storage failure must be reported honestly rather than fabricating completion.
Payloads exclude raw Profile evidence, credentials and generated documents.
See [operations and events](operations-and-events.md#server-sent-events).

<a id="cover-letter-pdf-review"></a>
The earlier letter review endpoint is retired; it is not a target API.
