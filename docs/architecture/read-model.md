# Feature Reads and Application Feedback

Read models show data owned by Python features; they are not alternate business
writers. The application transformation is in progress, so these contracts and
source pointers must be verified through the composed product.

## Apply Review And Outcome Feedback

Applications owns the current payload, review decisions, runs, send intents,
receipts, outcomes and reviewed suggestions. It obtains immutable Profile,
Jobs, Fit and accepted Resumes snapshots through public services. Its local
review reads can expose private data to the user; general activity/events carry
only bounded IDs, versions, state and presence markers.

Approval binds the exact payload and rehearsal. A changed selected source or
approved artifact requires renewed preparation/review. An unrelated later
wording or catalog addition can make a coverage report stale without
invalidating an accepted PDF whose selected sources and approvals are unchanged;
revocation or a relevant source change does invalidate that authority.

The Applications source declares `GET /v1/jobs/{id}/application`,
`GET /v1/jobs/{id}/apply-audit`, `GET /v1/apply/review`, outcome and suggestion
routes in `features/applications/http.py`. `applications.execute`,
`applications.rehearse` and `applications.gmail_scan` are among its durable
actions. Actual integrated routing, worker behavior and UI remain subject to
journey proof.

## Approval and at-most-once submission

The email admission transaction rechecks current Profile, job, Fit, accepted
resume, screening answers, rehearsal, exact approval, stop frontier and repeat
risk; it pins approved resume bytes and writes one intent before the provider
call. A matching valid receipt can settle that original intent. A lost or
malformed acknowledgement remains `needs_verification` and blocks another send,
even after retry, reset, restart or a manual outcome. A local stop cannot retract
an already admitted external operation; a late valid receipt records what
actually happened while preserving that stop. Browser execution requires manual
final submission. See [Apply](../user/apply.md) and
[at-most-once](../guides/at-most-once-job-application-submission.md).

## Outcomes and Gmail suggestions

Manual outcomes and reviewed suggestions are canonical Applications records;
a model suggestion is not automatically a confirmed outcome. A bounded,
user-started Gmail scan links metadata to one known application before reading
the body, then proposes an outcome with source-bound authority. Accepted,
corrected or ignored decisions remain distinct. Message evidence and private
model input stay in scoped local reads; broad events and progress omit bodies,
quotes and private rationale. Failed scans retain committed prior progress and
previous accepted records. A controlled-provider proof does not establish live
Gmail authentication or delivery.

## Interview Preparation And Notes

Interviews owns its catalog, source-bound preparation and independently
revisioned notes. Evidence selection and explicit empty selection are bound to
the exact question. Failure does not erase accepted preparation or notes;
notes do not become Profile facts or Fit assessments.

## Projection Catalog

Public views compose owner services rather than relying on a fixed legacy list
of TypeScript projection tables. Job and application views use Jobs and
Applications; Dashboard and Activity combine bounded owner results; Evidence
Map uses recorded source and assessment references; other views consume the
relevant public feature. The precise composed DTOs are owned by their adapters
and need integrated verification. See [data and events](data-events-and-projections.md).

## Contacts, Research, And Outreach

Contacts owns contact facts and research; Outreach owns reviewed drafts,
communication decisions and send/follow-up records. Broad activity excludes
private message text. A review or draft does not authorize a send.

## Evidence, Analytics, And Compensation

Fit's evidence map links recorded Profile sources, requirement assessments and
score/determination IDs. Outcome analytics are descriptive and sample-gated;
they cannot establish causality or change a score. Compensation evidence retains
source and uncertainty. Learning activity is not evidence of capability.

## Offer Read Model

Offers owns actual terms, scenarios, decisions and corrections, separate from
Compensation's market evidence. Unknown values stay unknown, prior revisions
remain inspectable, and an offer change neither submits an application nor
approves a message.
