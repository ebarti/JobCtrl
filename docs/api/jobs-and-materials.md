# Jobs & Materials API

This route family covers the projection-backed job read model, score and career
evidence, generated materials, review decisions, outcomes, contacts, and
outreach. It is the main implementation reference for Jobs, Artifacts, Apply
Review, and Outreach views.

For field-level schemas and every route variant, use the
[complete contract](complete-contract.md#jobs-read-model-and-lifecycle).

## Jobs And Evidence

| Route family | What it exposes |
| --- | --- |
| `GET /v1/jobs` and `GET /v1/jobs/:jobKey` | List/detail projections, stage state, score summary, and audit links. |
| `GET /v1/scoring/keywords` | Current projected score-version keyword aggregation with canonical normalized keys. |
| `GET /v1/evidence-map` | Canonical career evidence used by scoring and materials. |
| `POST /v1/jobs/:key/score-correction` | A new score version plus explicit correction rationale. |
| Job hide/restore/delete routes | Reversible lifecycle commands, plus a separate permanent-delete boundary. |

List and detail endpoints read projection rows. They do not recompute scores,
parse salary text, or replay events during a request.

Each job-detail stage may include an optional `applyUrlOutcome` object with the
allow-listed `code`, user-facing `message`, `retryable`, and resolver `method`
fields. It is populated on Enrich when application-target discovery has an
auditable result. The object is independent of the Enrich stage state: a
LinkedIn on-site application flow is a successful terminal outcome even though
there is no external URL. Raw resolver errors and browser-local paths are not
projected.

`jobKey` resolves at the browser API boundary to the tenant-scoped stable
`JobId`. Canonical clients send that ID; the explicit API/import boundary may
also accept a posting or application URL as an external locator and resolve it
to the same ID. Internal command payloads and foreign references remain
ID-shaped. `GET /v1/jobs` accepts
`normalizedScoreKeyword` using the exact key returned by
`GET /v1/scoring/keywords`; current filtering never mixes historical score
versions into the result.

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
and layout evidence.

## Compensation

`GET /v1/jobs/:jobKey/compensation/posted` exposes parsed employer-posted facts;
`GET /v1/jobs/:jobKey/compensation/market` exposes the local estimate and its
selected evidence. `/v1/compensation/sources` controls permitted source inputs.
Refresh is an explicit workflow/action, not a read-time side effect.

## Apply Review And Outcomes

| Boundary | Representative routes |
| --- | --- |
| Review queue and drafts | `GET /v1/apply/review-queue`, resume-review draft/revision/render/comment routes |
| Binding decision | `POST /v1/jobs/:jobKey/apply-review/decision` |
| Repeat-application evidence and confirmation | `repeatApplication` on review/detail reads; `POST /v1/jobs/:jobKey/repeat-application/override` |
| Outcomes | job outcome routes plus `/v1/outcomes` and `/v1/analytics/outcomes` |
| Gmail suggestions | bounded scan plus accept/reject decision routes |

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
| Contact facts | `/v1/contacts` list, detail, create, update, delete, and CSV import |
| Supervised research | `/v1/contacts/research` run/list/detail and candidate confirmation |
| Draft review | contact/thread draft generate, revise, approve, and reject routes |
| Follow-up operations | send logs, schedule/complete/dismiss, and due-follow-up reads |

Research candidates remain proposals until a user confirms them. Outreach drafts
remain drafts until their review gate is satisfied.

<a id="contact-research"></a>
<a id="outreach-drafts"></a>
