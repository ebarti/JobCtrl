# Jobs & Materials API

This route family covers the projection-backed job read model, score and career
evidence, generated materials, review decisions, outcomes, contacts, and
outreach. It is the main implementation reference for Jobs, Artifacts, Apply
Review, Interviews, and Outreach views.

For field-level schemas and every route variant, use the
[complete contract](complete-contract.md#jobs-read-model-and-lifecycle).

## Generation Selection

`POST /v1/jobs/:jobKey/actions/generate-materials` accepts optional `stages`.
Omitting them prepares the résumé and PDF; it also includes a letter when
`coverLetterGeneration` is enabled in Settings. With the setting off, mixed
requests omit Cover and a cover-only request returns
`409 cover_letter_generation_disabled` with guidance to enable the setting.
Existing accepted materials remain available.

## Jobs And Evidence

| Route family | What it exposes |
| --- | --- |
| `GET /v1/jobs` and `GET /v1/jobs/:jobKey` | List/detail projections, stage state, score summary, and audit links. |
| `POST /v1/jobs/import-url` | Start one public posting import and follow completion or its typed Manual Capture fallback. |
| `GET /v1/jobs/import-url/:workflowId/:executionId` | Read the acknowledged import execution without starting or waiting for more work. |
| `GET /v1/scoring/keywords` | Current projected score-version keyword aggregation with canonical normalized keys. |
| `POST /v1/scoring/stale-scores/actions/reset-for-rescore` | Reset distinct inactive stale scores while retaining their markers until a matching replacement; report active and already-pending jobs separately. |
| `GET /v1/evidence-map` | Canonical career evidence used by scoring and materials. |
| `GET/POST /v1/evidence-map/learning` | Read retained selected-job comparisons; preview sources, compare an explicit dated cohort, choose proposals and record milestone activity. |
| `POST /v1/jobs/:key/score-correction` | A new score version plus explicit correction rationale. |
| Job hide/restore/delete routes | Reversible lifecycle commands, plus a separate permanent-delete boundary. |

The Jobs removed-selection flow reads a reviewable list and prepares an exact,
short-lived cohort before confirmation. It submits that receipt with the same
canonical IDs; a stale receipt refuses the entire deletion. See the
[complete lifecycle contract](complete-contract.md#jobs-read-model-and-lifecycle)
for the request and conflict details. Direct permanent deletion and the guarded
job-data purge keep their separate existing contracts.

List and detail endpoints read projection rows. Job detail also reads the latest
accepted interview prep directly from its canonical owner, independently of
projection lag. These reads do not recompute scores, parse salary text, or replay
events during a request.

The current requirement-fit report retains each contribution's optional
`scope` and `scopeSourceId`, bound to the recorded job-interpretation
determination and exact requirement ID. `requirement-fit-v2-scoped` includes
only `resume`-scope rows in capability coverage; eligibility, logistics and
employer conditions remain visible with zero `maxPoints` and `awardedPoints`.
These readers expose stored arithmetic without recalculating it. Legacy
reports without a recorded scope source retain their earlier shape and formula.

`POST /v1/jobs/import-url` validates a public HTTP(S) destination. The Jobs UI
sends `{ url, awaitResult: false }` and receives `202` with
`{ ok: true, status: "started", workflowId, executionId }` as soon as Temporal
accepts the import. It follows that exact execution through
`GET /v1/jobs/import-url/:workflowId/:executionId`; a running import returns
`status: "pending"` without awaiting its result. The dialog retains this handle
when a status read fails, retries the read, and links to Runs. It never resubmits
the import to check progress. Terminal failed, canceled, timed-out and terminated
histories remain explicit stopped outcomes. The worker checks the tenant,
app/database, import workflow type and exact execution identity before reading a
result; it does not follow a newer execution with the same workflow ID.

Existing callers may omit `awaitResult` or set it to `true` to retain the awaited
`200` response. Both the awaited response and a completed status read map a
readable posting to `{ ok, status: "imported", jobKey, importedAt,
alreadyExisted }`. A blocked, login-walled, rate-limited, or ambiguous page
returns `{ ok, status: "manual_capture_required", itemId, reason }`; that
outcome creates no Job row. Repeating an already-imported URL resolves the same
canonical `JobId` without another fetch.
An identified posting with public structured content may proceed through strict
extraction and content-quality review when visual access is unknown. Unknown
access and availability remain recorded; they are not promoted to clear or
active. An unknown posting identity or explicit login/challenge still requires
Manual Capture.
This includes an exact originating URL whose accepted Manual Capture receipt
already points to an existing job, even when the captured canonical URL differs.

Provider execution errors retain their retryable domain classification, allowing
the workflow's bounded retry to acquire another ready route. Citation, schema
and other source-binding failures remain distinct failures after bounded model
correction; none can create a guessed job or replace accepted data.
An oversized public page resource retains its acquisition-limit classification
and opens Manual Capture. Destination denial still rejects the URL; byte caps
and public-address checks remain enforced.

Each job-detail stage may include an optional `applyUrlOutcome` object with the
allow-listed `code`, user-facing `message`, `retryable`, and resolver `method`
fields. It is populated on Enrich when application-target discovery has an
auditable result. The object is independent of the Enrich stage state: a
LinkedIn on-site application flow is a successful terminal outcome even though
there is no external URL. Raw resolver errors and browser-local paths are not
projected.

Enrich stages can also include `fetchFailure`: an allow-listed `kind`,
`requestHost`, `observedAt`, `recoveryStatus`, `checkCount`, `checkedAt`,
`nextCheckAt`, and `retryEligibleAt`. Recovery status is `waiting`,
`retry_ready`, `checks_exhausted`, or `stopped`; absent recovery has a zero
count and null times/status. The diagnostic excludes raw request URLs, query
strings, and unknown metadata. Both projection writers produce the same shape.
The job audit preserves typed failure evidence and `EnrichmentFetchRechecked`
results. Historical success does not turn an old failure into a current block.

`jobKey` resolves at the browser API boundary to the tenant-scoped stable
`JobId`. Canonical clients send that ID; the explicit API/import boundary may
also accept a posting or application URL as an external locator and resolve it
to the same ID. Posting identity (the `JobId`, posting URL, or a retained
posting locator) resolves first. An application URL resolves only when exactly
one job in the tenant owns it as its canonical enrichment target or retained
alias; a shared application endpoint matching several jobs resolves to no job,
and the route answers `job_not_found`. The
[application URL authority inventory](../architecture/application-url-authority.md)
lists every reader of these values. Internal command payloads and foreign
references remain ID-shaped. `GET /v1/jobs` accepts
`normalizedScoreKeyword` using the exact key returned by
`GET /v1/scoring/keywords`; current filtering never mixes historical score
versions into the result. It also accepts optional `jobStates` values
(`active`, `deleted`, `hidden`; repeated values or normal comma serialization
are accepted). These values are ORed before count and pagination. Hidden wins
when both hide and delete tombstones exist. When `jobStates` is present it takes
precedence over the legacy `deleted` filter; when absent, legacy links keep the
existing `active`, `closed`, `deleted`, `hidden`, and `all` behavior. The same
optional filter is accepted by all-matching bulk job mutations.

`GET /v1/jobs` and all-matching bulk filters also accept `stages`, an OR filter
on the projected `currentStage`. JSON arrays, comma serialization
(`stages=discover,apply`), repeated values, and repeated comma groups are
accepted. Up to six values are validated before duplicates are removed;
surrounding whitespace is trimmed. A valid `stages` value overrides scalar
`stage`. An empty array (serialized as `stages=`) clears the stage restriction,
including a supplied scalar. Invalid or oversized arrays are ignored as a whole,
so the legacy scalar remains effective. Omission or an explicit TypeScript
`stages: undefined` preserves scalar behavior.
The current projection groups preparation substages under Discover or Apply;
membership uses that public stage rather than `currentSubstage`.

Stage membership and all other filters apply before the global total, sort,
and page slice. Pages clamp to the last page; an empty result has page one and
one page. All requests read the total and page from one SQLite snapshot.
`discoveredSince` and `scoredSince` compare instants inclusively at JavaScript
millisecond precision, so equivalent offsets and fractional notation match.
Missing or invalid stored timestamps do not match their cutoff. When both
cutoffs are supplied, either may match. Timestamp filters use precomputed
milliseconds in the query index before totals, pagination, and all-matching bulk
selection.
Response `filter.stages` records the effective deduplicated membership (an empty
array means unrestricted); `filter.stage` retains the requested legacy scalar
for compatibility. Clients can request combined pages through the existing
API client without assembling stage-local pages.

Stage-state selection uses the same membership for SQL pages, searched lists,
and all-matching bulk actions. `state=failed` includes stored `failed` and
`exhausted` rows; the legacy `state=exhausted` selector includes only stored
exhaustion. Both are presented as `currentState: "failed"`, with
`failureReason: "attempt_budget_exhausted"` identifying exhaustion.
State sorting uses that presented state, so exhausted and other failed jobs
share the failed sort key. Text sorts lowercase their values and use locale
comparison, matching the existing browser merger; equal keys keep ascending job
IDs in both directions. Discovery sorting compares the original timestamp
strings with locale comparison, preserving browser behavior across fractional
and offset notation; it does not normalize them to instants. Missing values
sort first ascending and last descending. All searches and sorts select IDs in
SQLite before hydrating only the returned page. The app-owned, rebuildable
[query index](../architecture/read-model.md#job-list-sqlite-selection) stores
compatible search values and locale sort ordinals without changing exact v14.
Source and company filters are literal substrings after
Unicode lowercasing: `%`, `_`, and backslash have no wildcard or escape meaning.
Source checks the displayed source, discovery source, posting source, and posting
URL. These rules also apply to searched lists and all-matching bulk selection.

### Profile freshness and explicit score updates

Jobs list/detail include `scoreProfileFreshness`: status, scored/current profile
versions, and an optional bound review with determination ID, verdict, rationale,
provider/model/effort and review time. Profile saves and API startup launch no
score or material work. A score with unknown source versions is `unknown`.

The existing per-job `actions/rescore-current-policy` and batch scoring actions
remain explicit. For a changed profile on the same policy, they ask the configured
model whether the edits affect the job. An insignificant verdict keeps the score's
original version/date and records `reviewed_unchanged`; a significant verdict
recomputes. Policy or posting/guidance changes can independently require a new
score. Missing historical comparison inputs and failed checks preserve accepted
scores and return their typed failure, without a lexical substitute.

## Saved Posting Availability

`POST /v1/jobs/:jobId/actions/check-availability` accepts `{}` with no additional
fields and a canonical JobId. It dispatches `check_posting_availability` with
trusted tenant, application-directory and database identity; a successful start
returns `202 { ok: true, status: "queued", runId, workflowId }`. Missing jobs,
invalid input, unavailable dispatch and malformed worker acknowledgements stay
explicit errors; the command never launches Apply.

Jobs list/detail read the latest `availability` observation directly from the
Enrichment event ledger, independently of projection lag. The response exposes
separate attempt/success clocks, latest uncertainty, bounded hashed acquisition
lineage, next due, calculated overdue/in-progress state, and optional deferred
explicit command reason/request time/retry time. Unchanged refusals coalesce;
automatic/preflight checks do not create user request feedback. Local refusal does
not invent an attempt or raise evidence backoff. It performs no
employer network calls and appends no events. The
[complete contract](complete-contract.md#saved-posting-availability) owns fields;
the [enrichment guide](../user/enrichment-and-extraction.md#saved-posting-availability)
owns cadence, bounds, anonymous access and costly-work freshness gates.

## Feedback Learning And Materials Policy

| Route | Purpose |
| --- | --- |
| `GET /v1/learning/recommendations` | Paginated pending/inactive recommendation summaries with sample gates and safe counts. |
| `GET /v1/learning/recommendations/:recommendationId/evidence` | Bounded structured supporting and contradicting references without source free text. |
| `POST /v1/learning/recommendations/:recommendationId/reviews` | Explicitly accept or reject one current recommendation. |
| `GET /v1/learning/policies/materials` | Paginated current and superseded tailoring-policy revisions with allowlisted provenance. |
| `POST /v1/learning/policies/materials/rollbacks` | Restore a reviewed earlier version against an expected current version, or replay its command receipt. |

Acceptance creates one versioned Materials policy revision; rejection writes a
review but does not change policy. A restore compares the reviewed current
version inside the append transaction; a stale review requires a fresh review
and new command. An identical command returns its original receipt even if a
later revision is current. See the [complete contract](complete-contract.md#feedback-learning-and-policy-history)
for fields and conflicts. None of these routes starts scoring, tailoring,
Apply, or artifact work. Errors and historical metadata are sanitized before
they cross the browser boundary.

## Artifacts And Resume Templates

| Route family | Purpose |
| --- | --- |
| Artifact list/detail | Read registered resume, cover-letter, PDF, and audit metadata. |
| Artifact preview routes | Serve HTML, PDF, or a rendered PDF page. |
| `POST /v1/artifacts/:artifactId/open` | Open a registered local artifact through the OS adapter. |
| `POST /v1/jobs/:jobId/material-exports` | List original accepted text sources/retained exports or synchronously create a source-bound DOCX. |
| `GET /v1/artifacts/:artifactId/download.docx` | Download an owned, hash-verified retained DOCX export as an attachment. |
| `/v1/resume-templates` | Create, inspect, and select versioned resume templates. |

The API serves registered artifacts, never an arbitrary filesystem path. The
job detail projection links each accepted generation to provenance, validation,
and layout evidence. Artifact summaries include a nullable canonical
`generation` when one was recorded; lifecycle `status` remains unchanged.
An older generation can still be approved, so clients must not treat age alone
as a superseded status.

Original accepted-material exports reuse the CLI's deterministic DOCX service
through runtime-bound Python RPC. The request binds the displayed source ID,
generation, source hash and metadata hash; an intervening edit or acceptance
change refuses export. History and export failures preserve accepted materials,
review decisions and earlier exports. Download failures preserve the receipt and
can be retried independently. See the [field-level DOCX contract](complete-contract.md#accepted-material-docx-exports).

## Interviews: Catalog, Preparation, And Notes

| Route | Purpose |
| --- | --- |
| `GET /v1/interviews/catalog` | Bounded, filtered installed public catalog with source/reading metadata. |
| `GET /v1/interviews/questions/:questionId` | One active card plus its immutable catalog binding. |
| `POST /v1/jobs/:jobKey/actions/generate-interview-prep` | Explicit bounded selection/context dispatched to `InterviewPrepWorkflow`; returns `202` when queued, `200` for a completed dispatch response. |
| `GET /v1/jobs/:jobKey/interview-prep/history` | Paginated generations, including superseded and failed attempts. |
| `GET /v1/jobs/:jobKey/interview-notes` | Latest independent per-question notes, or one question's revision history. |
| `POST /v1/jobs/:jobKey/interview-notes` | Expected-revision note save; a stale edit returns `409`. |

Catalog reads are direct TypeScript asset handlers. They need no SQLite, job,
live worker, or provider and retain normal loopback/browser security hooks.
An unknown card returns `404 unknown_question`, a retired card such as C08
returns `410 retired_question`, and a missing/invalid packaged asset fails
closed with `503 interview_catalog_unavailable`.

Generation accepts up to 16 unique active question IDs, catalog binding,
per-question accepted-evidence choices with a current profile-version fence,
stage/format, role lens/responsibilities, known criteria, and rationale. An
explicit empty evidence choice remains a gap; omitted entries allow automatic
selection. It validates selection before worker dispatch and provider spend. Legacy requests
without a selection use deterministic bounded selection; older unbound stored
prep remains explicitly legacy. The returned current job-detail prep remains
the last accepted generation through pending or failed replacement. Its
retained card/input context and question metadata support inspectable history
and read-side stale diagnostics without rewriting old results.

Note saves are independent of generation/item replacement and default to
unverified user statements. They append revision history, verify any source
generation retains the same question for the tenant/job, derive matching origin
bindings at the server, and never inherit a passed generation
audit or update Profile, fit, or Apply. The conflict response includes
`currentNote`; clients preserve the dirty draft and reconcile with that saved
revision before retrying. Events carry safe IDs/versions/counts only.

The [complete interview contract](complete-contract.md#interview-catalog-preparation-and-notes)
owns every field, pagination default, status, and error. The
[Materials audit owner](../architecture/materials.md#stored-interview-preparation)
explains source authority and the research-draft/assessment boundary.

## Compensation

`GET /v1/jobs/:jobKey/compensation/posted` exposes parsed employer-posted facts;
`GET /v1/jobs/:jobKey/compensation/market` exposes the local estimate and its
selected evidence plus immutable benchmark lineage when the estimate references
a canonical direct or geographically extrapolated fact. Job list/detail
summaries identify that authority as `direct`, `extrapolated`, or unknown;
detail reads expose the role, level, geography, freshness, exact salary and
price-level inputs, factor bounds, and formula needed to audit the result.
After an automatic refresh attempt, active jobs without a supported role or
country have a recorded `insufficient_evidence` market result with a role or
location reason and no range. `not_requested` means no market result has been
persisted. A failed source lookup with no benchmark records
`source_unavailable`; a retained all-level benchmark still records
`insufficient_evidence` with `weak_level_match` when it cannot support the
job's level. A compatible accepted range survives either failure.
`/v1/compensation/sources` controls permitted source inputs. Refresh is an
explicit workflow/action, not a read-time side effect.

## Apply Review And Outcomes

| Boundary | Representative routes |
| --- | --- |
| Review queue and drafts | `GET /v1/apply/review-queue`, resume-review draft/revision/render/comment routes |
| Binding decision | `POST /v1/jobs/:jobKey/apply-review/decision` |
| Repeat-application evidence and confirmation | `repeatApplication` on review/detail reads; `POST /v1/jobs/:jobKey/repeat-application/override` |
| Outcomes | job outcome routes plus `/v1/outcomes` and `/v1/analytics/outcomes` |
| Gmail suggestions | bounded scan plus accept/reject decision routes |

Manual `POST /v1/jobs/:jobKey/outcomes` and user-attested
`POST /v1/outreach/threads/:threadId/send-logs` require a UUID `requestId`.
Keep the same identity and validated payload for a retry. Equal retries return
the original immutable result; a changed payload in that tenant/operation/target
scope returns `409 action_identity_conflict` without mutation. A new deliberate
action uses a new identity. Missing or malformed identities return `400`.
Send logging returns `{ ok: true, sendLog }`, not a thread snapshot; use the
existing contact Outreach read for current thread state. See the
[complete retry contract](complete-contract.md#manual-action-retry-contract).

Email approval requests echo the complete reviewed `emailApplication` preview
as `reviewedEmailCandidate`, alongside recipient and attachment ID. The API
compares it atomically with the current preview before recording approval.
A replacement preview requires fresh review even when those two IDs match.

`POST /v1/outcomes/gmail/scan` returns bounded evidence and suggestion summaries
with canonical `jobId` values. It never returns raw message bodies. Scan events
use that same identity to invalidate the matching outcome detail. Worker-side
failures include a safe `failureCode`; invalid input returns 400, and Gmail or
model unavailability returns 503. Previously stored evidence is preserved.

The latest accepted artifact remains reviewable while a replacement is being
generated. Failed or rejected attempts stay in the audit history.

Live Apply dispatch returns `409` when confirmed prior-application evidence
blocks the target or requires confirmation. The confirmation endpoint records a
reasoned, evidence-fingerprint-bound authorization for one later live claim; it
never submits by itself. The Python worker recomputes and consumes that
authorization at its authoritative claim boundary.

## Contacts And Outreach

| Capability | Route family |
| --- | --- |
| Contact facts | `/v1/contacts` list, detail, create, update, delete, and reviewed CSV/vCard import |
| Supervised research | `/v1/contacts/research` run/list/detail and candidate confirmation |
| Draft review | contact/thread draft generate, revise, approve, and reject routes |
| Follow-up operations | send logs, schedule/complete/dismiss, and due-follow-up reads |

Research candidates remain proposals until a user confirms them. Outreach drafts
remain drafts until their review gate is satisfied.
Research detail includes distinct source outcomes for a response that is too
large, a timeout, a failed redirect, a transport failure, or an HTTP error.
These do not claim that a successfully read page contains no candidates.

Contact updates use the fingerprint from the detail read to reject stale edits
without replacing newer facts. See the [contact contract](complete-contract.md#contacts)
for the request and conflict response.

<a id="contact-research"></a>
<a id="outreach-drafts"></a>

Generation and revision compare their complete starting thread state at
publication. A concurrent draft/review/send-log/reminder change returns
`409 outreach_publication_conflict` with private unpublished text, completed
gates and provenance, leaving current content and history unchanged. The caller
refetches and deliberately reconciles before retrying; see the
[conflict response](complete-contract.md#outreach-drafts). The open editor
retains those results across refresh, including disappearance of the review
card. This does not make generation or revision commands idempotent or send
anything automatically.
The revision response identifies the draft published by that operation; clients
check its thread, draft ID, generation and submitted text against the returned
readback before treating it as confirmed. A matching older draft is insufficient.

## Reviewed Locale Variants

`POST /v1/jobs/:jobId/material-locales` provides history, source-linked generation,
independent terminology/formatting review, explicit acceptance/rejection and four
accepted exports. Requests bind source/profile/revision versions; history reads
stored authority and never retranslates. See the
[wire contract](complete-contract.md#material-locale-variants) and
[user flow](../user/locale-variants.md).

## Screening Answers

`GET /v1/jobs/:jobId/screening-answers` reads private current questions, application-bound history, reviewed library revisions, available facts, source bindings/failures and persisted determination receipts. `POST` executes `capture`, `draft`, `edit`, `review`, `reuse` or `use` with `expectedRevision` and `idempotencyKey`. The [user command reference](../user/screening-answers.md#cli-and-local-api) describes action fields. API-derived tenant and mandatory workspace/database identity bind the registered `screening_answers` RPC; callers cannot supply runtime identity inside commands. Conflicts/source/model failures preserve accepted content. The public demo classifies both endpoints unavailable. These routes never enter/submit forms or create submitted outcomes.

## Optional company context

`GET /v1/jobs/:jobId` includes `companyBriefing` when a company link has been explicitly confirmed. This read joins canonical company records and the stored determination; it never refreshes public sources. Job Detail and Interviews render this same snapshot. See [the wire contract](complete-contract.md#company-briefings) and [user controls](../user/company-briefings.md).

## Cover-Letter PDF Review

`materialsPreview.coverLetter` identifies the canonical accepted cover source,
current accepted PDF, normalized print settings, renderer and accepted version.
`POST /v1/jobs/:jobKey/cover-letter/preview` renders a fenced full-text snapshot;
`POST /v1/jobs/:jobKey/cover-letter/accept` explicitly accepts its exact bytes.
The preview PDF route and accepted artifact route serve the same file after
acceptance. Preview requests do not advance Materials or approval bindings.
Submit-approval requests with a cover source must supply `coverLetterAcceptedVersion`;
the API and Apply worker check the recorded source/PDF binding. See the
[complete contract](complete-contract.md#cover-letter-pdf-review) for limits and
failure behavior.

## Selected-job learning commands

`GET /v1/evidence-map/learning` reads saved cohort comparisons and chosen
milestones through the registered local `career_learning` RPC. It does not
refresh sources or call a model. POST uses a strict `action` union: `preview`
selects explicit job IDs without writing; `compare` creates or revision-fences a
dated cohort; `choose` accepts one proposal from the exact current comparison;
`update` saves revision-fenced milestone activity with a required completion
statement for completed work. Provider or binding failure preserves accepted
records. See the [complete contract](complete-contract.md#selected-cohort-demand-and-milestones)
and [user workflow](../user/scoring-and-employer-analysis.md#selected-job-demand-and-learning-milestones).

## Actual Offers

`GET /v1/jobs/:jobId/offer` reads the private current terms, current decision
and immutable histories. `POST .../offer/terms` saves a user-confirmed source
and typed cash/equity/benefit/deadline terms with `expectedRevisionId`.
`POST .../offer/decisions` records accepted/declined attestations against the
current `termsRevisionId` with `expectedDecisionId`. Revisions/corrections
require reasons; stale or conflicting writes return `409 offer_conflict`.
Neither command needs interview prep or changes submission/pipeline authority.
See the [field-level offer contract](complete-contract.md#actual-offer-terms-and-decisions).

Outreach generation/revision also accepts the closed offer-specific `kind`
values and `offerRevisionId`. The worker loads canonical sources, applies the
existing claim/quality gates and fences source changes at persistence. Stale
offer bindings return `409 draft_gates_not_passed` on approval/send logging.
Provider, spend and structural failures retain the last approved message.

Job Detail and Apply Review read the same canonical Apply disposition and
submission evidence. Manual `mark-skipped` records a durable local Apply stop. Its response message
explains that an in-flight submission may still complete. Job Detail's existing
`applyAudit.hardBlockers` distinguishes `manual_apply_skip` from
`submission_intent_recorded`; the latter retains original intent run IDs from
canonical events, independently of the latest run. A recorded successful
submission or manual Applied attestation retains the intent source without
labeling the accepted outcome as uncertain; neither authorizes blind retry. `submission_outcome_uncertain`
retains a prior Needs verification stop even if its intent receipt is missing. See [Skip and safe
reset](../user/apply.md#skip-and-safe-reset) for recovery limits.
