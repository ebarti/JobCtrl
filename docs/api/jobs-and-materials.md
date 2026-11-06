# Jobs and Materials API

Feature-owned Python HTTP adapters are being integrated. These are target
ownership and lifecycle semantics; consult the current adapters for exact paths,
methods, fields and status codes. A route declaration alone is not proof of a
working product journey.

## Jobs and Evidence

Jobs owns capture, identity and versioned posting snapshots. The current work in
`features/jobs/bootstrap.py` declares `/v1/jobs`, capture and job snapshot
routes; the integrated candidate must verify them. Manual Jobs works without
Discovery or Companies. Requirements owns qualified source meanings and Fit
owns person/evidence qualification; no reader should recompute semantic
relationships with word matching. The in-progress `features/requirements/http.py`
declares the catalog and job requirement routes; `features/fit/http.py`
declares job fit, assessment, corrections and coverage. These declarations
still need composed application and E2E verification.

## Saved Posting Availability

Checks preserve source and timing provenance. Failure or inability to fetch is
not a confirmed closed posting. See [jobs lifecycle](complete-contract.md#jobs-read-model-and-lifecycle).

## Artifacts and Resume Templates

Resumes owns approved wording selection, coverage manifest, editable documents,
rendering, templates, acceptance and exports. Bind approval and download to the
exact artifact and source revisions. Failed replacement, rendering or export
preserves prior accepted material. One advisory coherence review has a status
separate from user acceptance; a mechanically valid document can be accepted
with an explicit override of a finding or timeout. The in-progress
`features/resumes/http.py` declares `/v1/resumes` and routes for editing, review,
rendering, acceptance, export and locales; these still need integrated proof. See
[tailoring](../architecture/tailoring.md).

## Apply Review and Outcomes

Applications consumes the exact accepted resume and owns screening answers,
approval of the application payload, assisted execution and outcomes. Changed
inputs invalidate stale approval; ambiguous external outcomes cannot be silently
retried. See [apply](../user/apply.md) and
[security](../developer/security.md#apply-path-containment).

## Screening Answers

Applications owns reviewed answer revisions and their application context.
Profile evidence remains Profile-owned. A prior answer or resume approval does
not approve a new application payload.

## Contacts and Outreach

Contacts and Outreach are separate features. Contacts owns provenance, import
and research; Outreach owns reviewed drafts, decisions, send records and
follow-up state. Changes and sends require current revision/authorization
checks; creating a draft is not a send. See [contacts](complete-contract.md#contacts).

## Interviews Catalog, Preparation, and Notes

Interviews owns its catalog, source-bound preparation and independent notes.
Explicitly empty evidence selections remain empty; a failed generation leaves
accepted preparation and notes intact.

## Compensation

Compensation owns posted and market evidence, source policy and normalization.
Source availability and currency/time-base uncertainty must be represented
honestly. Its neutral core does not depend on JobCtrl storage or workflow IDs.

## Actual Offers

Offers owns terms, scenarios, decisions and correction history separately from
market compensation. Unknown terms stay unknown. Changes do not themselves
submit an application or send a communication.

## Feedback Learning and Materials Policy

Corrections and feedback remain inspectable and user-controlled. Learning
activity is not evidence of a capability and does not alter Fit. Policy and
artifact updates preserve previously accepted versions until explicitly changed.
