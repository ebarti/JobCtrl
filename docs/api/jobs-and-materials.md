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
| `GET /v1/evidence-map` | Canonical career evidence used by scoring and materials. |
| `POST /v1/jobs/:key/score-correction` | A new score version plus explicit correction rationale. |
| Job hide/restore/delete routes | Reversible lifecycle commands, plus a separate permanent-delete boundary. |

List and detail endpoints read projection rows. They do not recompute scores,
parse salary text, or replay events during a request.

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
