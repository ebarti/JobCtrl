# Contacts & Outreach

A contact is a local, provenance-bearing record for a person connected to an
employer or application. Outreach is JobCtrl's review workflow for drafting a
truthful message to that person, copying an approved version, recording a send
you performed yourself, and surfacing follow-up reminders. JobCtrl never sends
outreach.

## What You Can See And Control

Open **Contacts** at `/outreach`. The route name reflects the bounded context;
the page title is Contacts. From there you can:

- filter contacts by employer or linked job;
- create, edit, or remove a contact;
- import a CSV list, with the filename retained as source provenance; and
- inspect due follow-ups before opening a contact.

The Contact Detail route workspace at `/outreach/:contactId` shows each fact
and its source, capture method, timestamp, confidence, and confirmation state.
A Job Detail workspace also composes the contacts linked to that application.

Supervised research proposes contacts for review. You start the run for an
employer or job and may opt into a permitted public source. No public page is
fetched by default, and login-walled or protected sources stay manual. Source
outcomes and candidate provenance remain visible even when nothing can be
fetched. A proposal becomes a contact only after you explicitly confirm it.

For a confirmed contact, you can generate or revise an outreach draft, inspect
its deterministic checks, judge result, and claim-to-fact bindings, then approve
or reject it. Only an approved draft can be copied. After you send that copy
through your own channel, **log a send** records your attestation; it is not a
send action. Follow-ups are editable reminders that you complete or dismiss
yourself. The current cadence policy belongs to
[Apply → Outreach Follow-Ups](apply.md#outreach-follow-ups) and is not duplicated
here.

## Source Of Truth And Ownership

- **Contacts own confirmed facts.** Canonical `contacts` and
  `contact_attributes` rows hold the employer/job link and attribute values.
  Every value has provenance; broad events and list projections carry summary
  metadata rather than names, email addresses, or notes.
- **Research owns proposals and source attempts.** Candidates remain in
  research tables with `needs_review` state. They are not contact facts and
  cannot ground outreach until confirmed.
- **The Candidate Profile owns claims about you.** Outreach may also use the
  confirmed contact and linked application as recipient context. A target
  employer or relationship is not evidence of your history.
- **Outreach owns versioned draft text and gates.** The persisted gate result is
  the approval authority. Claim provenance is computed from the actual rendered
  draft, not inferred from who the recipient is.
- **Send logs own user attestations.** They record a channel and time for an
  approved draft you say you sent. There is no email, social-message, or other
  outreach-send transport behind the route.
- **Follow-up projections own reminders only.** Due state is computed from the
  stored date and the clock; reading a due item never acts on it.

Contact, research, outreach, send-log, and reminder data do not affect job
scoring or Apply decisions.

## Lifecycle

1. **Create or import a contact, or start supervised research.** A manual fact
   is immediately canonical with its user-entered/import provenance. Research
   instead records source attempts and candidate proposals.
2. **Confirm research candidates.** Confirmation promotes one proposal into a
   contact and preserves the research provenance as user-confirmed.
3. **Generate a draft.** The worker grounds the message in profile evidence,
   confirmed contact facts, and the linked application, then runs the shared
   Materials truthfulness stack and records a candidate generation.
4. **Review and decide.** A candidate whose persisted gates pass can be
   approved; a failing candidate is blocked. Rejection leaves any prior approved
   message intact.
5. **Revise safely.** Editing creates another generation and reruns every gate.
   The previous approved draft remains readable and copyable until a replacement
   is approved.
6. **Copy and send yourself.** Clipboard export is the terminal JobCtrl action.
   You choose and operate the external channel.
7. **Record and remember.** Log the send only after it happened, then optionally
   schedule, complete, or dismiss a surfaced follow-up reminder.

## Implementation And API Pointers

| Layer | Pointer |
| --- | --- |
| User workflow | [Daily Workflow → Keep Contacts](normal-flows.md) and [Discovery → Contact Research](discovery.md#contact-research). |
| HTTP contract | `/v1/contacts`, supervised-research routes, contact/thread draft routes, send logs, and follow-up operations; see [Jobs & Materials API](../api/jobs-and-materials.md#contacts-and-outreach) and the [complete contacts contract](../api/complete-contract.md#contacts). |
| API implementation | `apps/api/src/contacts.ts` and `apps/api/src/outreach.ts`; shared request/response types live in `packages/contracts`. |
| Worker implementation | `workers/automation/src/jobctrl/domain/contact/`, `workers/automation/src/jobctrl/contact/`, and `workers/automation/src/jobctrl/infrastructure/contact/`. |
| Web implementation | `apps/web/src/contexts/outreach/`, `apps/web/src/views/outreach/`, and the `/outreach` route files. |
| Deep architecture | [Stage Walkthrough → Contact Research](../architecture/pipeline/stages.md#contact-research-supervised-off-pipeline), [Outreach Draft Gates](../architecture/tailoring.md#outreach-draft-gates-reused-materials-stack), and [Sensitive Projection Families](../architecture/read-model.md#contacts-research-and-outreach). |
