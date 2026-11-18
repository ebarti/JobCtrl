---
description: "Understand JobCtrl's supervised application controls, rehearsal, exact approval, Gmail, and submission safety."
---

# Apply

Apply is the employer-facing boundary. JobCtrl prepares a specific application,
lets you inspect it and records a separate decision before any authorized
external action. Final submission on an employer website remains manual.

In the Original redesign source candidate, open the selected job's **Resume**
and **Application** tasks, or **Jobs → Applications** for the cross-job review
queue. The selected review identifies the actual job title and employer; check
that identity before approving its outgoing packet. The actual Plate editor
remains embedded in the job workspace. Preparing,
editing, accepting a document and approving an outgoing application are separate
decisions. The [redesign ledger](../plans/2026-11-11-original-app-redesign.md)
records integration/verification; source controls do not establish an installed
release or hosted deployment.

When Preparation is mounted, the selected application uses the same resume-mode
choice and **Prepare resume** action as the job workspace. Its exact result opens
document review, and an unfinished Plate edit must be saved or discarded before
new preparation. This does not approve or execute the application. Without the
optional Preparation feature, **Resume type → Create resume** retains direct
draft creation with explicit checks/rendering and separate acceptance/export.

::: info Python transformation in progress
The behavior below is the accepted target and current feature contract. Its
integrated web, worker and installed-runtime journeys are still being verified;
a source route or feature package alone does not establish release availability.
See [Getting Started](getting-started.md) for the published version.
:::

## Candidate Profile Application Fields

Profile owns the facts an application can use. Application attestations such as
age, background-check consent, prior employment and conviction must reflect your
explicit answer; leave an unknown value unknown rather than guessing. Profile
preferences, such as how you heard about a role, are separate from legal
attestations. The [Candidate Profile](candidate-profile.md) guide owns editing,
sources and confirmations.

## Materials And Resume Rendering

Resumes owns the editable resume, its accepted revision and PDF. Review and
accept a document before using it in an application. Editing, rendering,
reviewing and accepting are distinct actions; a failed replacement preserves
the last accepted artifact. An unrelated new wording or requirement record can
make coverage stale without invalidating an accepted PDF whose selected sources
are unchanged. Revoked wording or a changed selected source requires a new
valid document and application review. See [Materials & Tailoring](materials-and-tailoring.md).

## Approval And Automation Modes

The target workflow is:

1. Prepare a browser or email candidate from the current saved job, Profile,
   reviewed screening answers and accepted resume. Email preview includes the
   exact recipient, subject, body and resume attachment.
2. Rehearse the exact candidate, inspect the result and resolve reported
   uncertainty. Browser inspection has **partial coverage**; acknowledging
   that limitation is a separate decision tied to that exact rehearsal.
3. Approve the exact candidate and rehearsal, or defer or decline it. A changed
   bound source or payload needs fresh preparation and review.
4. For an employer website, complete the final action yourself. An explicitly
   approved email may be sent through JobCtrl's owned Gmail path, subject to
   current safety, eligibility and repeat-application checks.

Targeted work, bounded approved batches and an explicitly enabled standing
schedule use the same application authority. A score alone does not authorize a
submission. A user-started dry run does not itself approve a live submission.
See [At-most-once submission](../guides/at-most-once-job-application-submission.md)
for failure and retry semantics.

### Maximum AI budget per application {#runtime-setting-maximum-ai-budget-per-application}

Application model work is subject to configured spending controls. Consult
[Configuration](configuration.md) for current settings and provider readiness;
enforcement in the transformed integrated runtime still requires verification.

### Apply agent timeout {#runtime-setting-apply-agent-timeout}

Application work has a configured timeout. A timeout is not proof that an
external effect failed; check its recorded status before taking another action.

### Final Browser Submission Is Manual

The target browser rehearsal opens an owned empty browser, permits one exact
read-only navigation and disables scripts, credentials, typing, uploads,
redirects and submission. Dynamic and later pages may not be inspected, so
coverage is partial. Findings can report a login, CAPTCHA, expired page,
email-only route, manual work or uncertainty; they do not grant permission to
submit or bypass the site's controls. The browser extension can offer
user-reviewed autofill, but it has no submit capability.

When inspection identifies an email-only route, treat the suggestion as a new
email candidate. Review its destination and content, prepare and rehearse that
candidate, and explicitly approve it before any send.

## Skip And Safe Reset

Skip or cancellation records a local stop and prevents new claims. It cannot
retract a provider operation already admitted; a late valid confirmation remains
associated with the original run, and a missing confirmation remains **Needs
verification**. Check the provider or employer history before recording what
happened. A safe reset requires a fresh preparation and review; it does not
release an existing submit intent or permit a duplicate send. Accepted materials
and prior history remain available.

## Repeat-Application Protection

A confirmed application to the same opening blocks another automatic attempt.
For a different opening at the same employer with an equivalent role, a
source-bound assessment can require your reasoned, one-use confirmation. A
similar title or employer name alone does not prove equivalence. Pending email
suggestions, notes, dry runs, unconfirmed attempts and assumptions do not become
confirmed applications. An existing submit intent cannot be overridden as if it
were known to have failed.

## Browser Apply Automation

The browser inspection described above is read-only. It does not type into a
form, upload a resume, use stored credentials or click a submit control. Use
the employer's normal flow yourself and record the outcome honestly. The optional
extension can present saved, source-bound suggestions for your review; accepting
an autofill suggestion does not submit an application.

## Gmail Connector And Sending Boundary

Gmail access is optional and requires your account authorization. For a reviewed
email application, JobCtrl binds the exact recipient, subject, body and accepted
resume bytes to your approval. Immediately before a send, Applications rechecks
current sources, rehearsal, approval, eligibility, stop and repeat protections,
then commits a unique intent and sends the pinned attachment once. A valid
matching provider receipt can confirm that attempt. A missing, malformed or
lost acknowledgement remains **Needs verification** and blocks automatic
resending; a manual outcome does not erase the original intent.

The separate, user-started Gmail feedback scan creates suggestions for your
review, not confirmed outcomes. See [Outcomes & Feedback](outcomes-and-feedback.md)
and [Configuration](configuration.md) for account setup and privacy.

## Outreach Follow-Ups

Contacts and Outreach own a separate communication workflow. Preparing or
approving an application does not authorize an outreach message; review each
communication and follow-up under [Contacts & Outreach](contacts-and-outreach.md).

## Reviewed Screening Answers

[Screening Answers](screening-answers.md) retains questions, selected evidence,
reviewed answers and manual-use history. Drafting, copying and recording manual
use are separate actions; none submits a form or records an application outcome.
