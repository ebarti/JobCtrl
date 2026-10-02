# Jobs & Materials API

This route family covers the projection-backed job read model, score and career
evidence, generated materials, review decisions, outcomes, contacts, and
outreach. It is the main implementation reference for Jobs, Artifacts, Apply
Review, Interviews, and Outreach views.

For field-level schemas and every route variant, use the
[complete contract](complete-contract.md#jobs-read-model-and-lifecycle).

## Jobs And Evidence

| Route family | What it exposes |
| --- | --- |
| `GET /v1/jobs` and `GET /v1/jobs/:jobKey` | List/detail projections, stage state, score summary, and audit links. |
| `POST /v1/jobs/import-url` | Fetch and import one public posting immediately, or return a typed Manual Capture fallback without creating a placeholder job. |
| `GET /v1/scoring/keywords` | Current projected score-version keyword aggregation with canonical normalized keys. |
| `GET /v1/evidence-map` | Canonical career evidence used by scoring and materials. |
| `POST /v1/jobs/:key/score-correction` | A new score version plus explicit correction rationale. |
| Job hide/restore/delete routes | Reversible lifecycle commands, plus a separate permanent-delete boundary. |

List and detail endpoints read projection rows. They do not recompute scores,
parse salary text, or replay events during a request.

`POST /v1/jobs/import-url` accepts `{ url }`, validates that the destination is
public HTTP(S), and awaits `JobUrlImportWorkflow` on the local worker. A readable
posting returns `{ ok, status: "imported", jobKey, importedAt,
alreadyExisted }`. A blocked, login-walled, rate-limited, or ambiguous page
returns `{ ok, status: "manual_capture_required", itemId, reason }`; that
outcome creates no Job row. Repeating an already-imported URL resolves the same
canonical `JobId` without another fetch.

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

## Feedback Learning And Materials Policy

| Route | Purpose |
| --- | --- |
| `GET /v1/learning/recommendations` | Paginated pending/inactive recommendation summaries with sample gates and safe counts. |
| `GET /v1/learning/recommendations/:recommendationId/evidence` | Bounded structured supporting and contradicting references without source free text. |
| `POST /v1/learning/recommendations/:recommendationId/reviews` | Explicitly accept or reject one current recommendation. |
| `GET /v1/learning/policies/materials` | Paginated current and superseded tailoring-policy revisions with allowlisted provenance. |
| `POST /v1/learning/policies/materials/rollbacks` | Append a `user_requested` revision restoring one earlier version. |

Acceptance creates one versioned Materials policy revision; rejection writes a
review but does not change policy. Rollback is append-only and idempotent for
the same structured request. None of these routes starts scoring, tailoring,
Apply, or artifact work. Errors and historical metadata are sanitized before
they cross the browser boundary.

## Artifacts And Resume Templates

| Route family | Purpose |
| --- | --- |
| Artifact list/detail | Read registered resume, cover-letter, PDF, and audit metadata. |
| Artifact preview routes | Serve HTML, PDF, or a rendered PDF page. |
| `POST /v1/artifacts/:artifactId/open` | Open a registered local artifact through the OS adapter. |
| `/v1/resume-templates` | Create, inspect, and select versioned resume templates. |

The API serves registered artifacts, never an arbitrary filesystem path. The
job detail projection links each accepted generation to provenance, validation,
and layout evidence. Artifact summaries include a nullable canonical
`generation` when one was recorded; lifecycle `status` remains unchanged.
An older generation can still be approved, so clients must not treat age alone
as a superseded status.

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

`POST /v1/outcomes/gmail/scan` returns bounded evidence and suggestion summaries
with canonical `jobId` values. It never returns raw message bodies. Scan events
use that same identity to invalidate the matching outcome detail.

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

<a id="contact-research"></a>
<a id="outreach-drafts"></a>
