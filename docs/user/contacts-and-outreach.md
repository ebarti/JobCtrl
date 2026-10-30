# Contacts & Outreach

A contact is a local, provenance-bearing record for a person connected to an
employer or application. Outreach is JobCtrl's review workflow for drafting a
truthful message to that person, copying an approved version, recording a send
you performed yourself, and surfacing follow-up reminders. JobCtrl never sends
outreach.

## How Research And Draft Approval Work

Contacts have two separate trust transitions: a discovered person must become a
confirmed contact, and a generated message must become an approved draft.

1. **Check source policy before research.** JobCtrl rejects a disallowed source
   before fetching it. Autonomous broad-web discovery is off by default;
   login-walled and protected sources remain manual.
2. **Keep findings as proposals.** Research records source attempts and
   provenance-bearing candidates in `needs_review`. Explicit confirmation
   promotes a proposal into the canonical contact record and preserves where
   each fact came from.
3. **Verify the actual draft.** A separate model determination checks its claims
   against confirmed profile and contact facts, with verbatim quotations and
   recorded line IDs. The linked application provides context.
4. **Run independent quality review.** A second call judges relevance, clarity,
   relationship accuracy and professionalism. Both model verdicts must pass;
   code validates IDs, citations, exact values and schemas.

5. **Persist the gate result as authority.** Generated and user-edited drafts
   run the same checks. An edit creates a new generation; it cannot inherit the
   previous pass. Rejection or a failed replacement leaves the prior approved
   draft available.
6. **Stop at the clipboard.** Only a persisted approved draft can be copied.
   Sending happens in the external channel you operate, and **log a send** is a
   later user attestation rather than proof produced by JobCtrl.

Claim-to-fact bindings recorded from the accepted message make the approval
inspectable without turning an employer, recipient, or job description into
evidence about you.

## What You Can See And Control

Open **Contacts** at `/outreach`. The route name reflects the bounded context;
the page title is Contacts. From there you can:

- filter contacts by employer or linked job;
- create, edit, or remove a contact;
- preview and import CSV or vCard contacts, retaining filename provenance; and
- inspect due follow-ups before opening a contact.

The Contact Detail route workspace at `/outreach/:contactId` shows each fact
and its source, capture method, timestamp, confidence, and confirmation state.
A Job Detail workspace also composes the contacts linked to that application.

Supervised research proposes contacts for review. You start the run for an
employer or job and may opt into a permitted public source. No public page is
fetched by default, and login-walled or protected sources stay manual. Source
outcomes and candidate provenance remain visible even when nothing can be
fetched. A proposal becomes a contact only after you explicitly confirm it.
If a page is too large, takes too long, cannot be reached, or has a broken
redirect, the source attempt explains the failure and suggests a next step.
Those failures do not mean that the page contains no contacts. Previously
recorded proposals remain available.

For a confirmed contact, you can generate or revise an outreach draft, inspect
its claim verification, quality verdict and recorded source bindings, then approve
or reject it. Only an approved draft can be copied. After you send that copy
through your own channel, **log a send** records your attestation; it is not a
send action. Follow-ups are editable reminders that you complete or dismiss
yourself. The current cadence policy belongs to
[Apply → Outreach Follow-Ups](apply.md#outreach-follow-ups) and is not duplicated
here.

## When Outreach Changes During Verification

Generation and revision verify the thread state they started from. If another request commits
an approval, rejection, draft, send log or reminder change before it finishes,
the completed proposal reports a conflict and leaves the current thread intact.
The editor keeps your text and the unpublished verification results even when
refresh replaces or removes the original review card. Those results are private
proposals, not an approved message or a published generation.

You can continue editing while a revision is being verified. If the submitted
version is saved, newer typing remains in the editor and has not been verified.
You can submit that newer text deliberately or discard it.

Compare the current accepted message, review history, send logs and reminder
with your edit. Confirm that comparison in the editor before deliberately
retrying; retry runs the gates again against the current state. JobCtrl does not
automatically regenerate or overwrite the newer facts. Unpublished results are
retained in the open editor, not saved as canonical draft history; leaving or
reloading the page can discard them. If the thread was removed, preserve your
text before leaving and open the current contact to start again.

For a generation conflict, open **Unpublished message and completed verification**
to inspect the completed body, checks and provenance. Compare them with the
current thread, including a winner from another first-generation request, then
confirm the comparison before choosing **Generate draft** again. The previous
proposal stays available during a deliberate retry and after a provider failure;
it clears on success or when you explicitly discard it. Generation never retries
automatically.

Within an open panel, edits and unpublished proposals belong to their recipient
and optional job. Selecting another recipient or job suspends the previous work;
return to its original target to resume it. It cannot be confirmed or submitted
while another target is displayed. Generation proposals also retain their offer
purpose and offer revision context. Switching tenant or leaving the panel ends
these private sessions; there is no persistent recovery store.

If a revision's acknowledgement times out, is lost, does not confirm the
submitted draft, or reports a server error, the editor retains
each submitted version alongside your current text. The revision may already
have been saved or may still finish later. Check the current thread and its
generation history, then confirm that review before deliberately retrying.
These retained texts last only while the panel remains open. The conflict and
timeout handling do not make repeated revision commands idempotent. For other
Outreach commands, also inspect the current thread before issuing another
command after a lost acknowledgement.

## Retrying A Send Log

An open form stays bound to the approved draft it was opened for. If a newer
approval replaces that draft before its first submission, recording is refused;
close the form. Reopen it for the newer draft only if you sent that draft yourself.

If **Record send** loses its acknowledgement, retry in the same mounted form.
The form retains its original draft, channel, date and request identity, and the
API returns the original send-log record without a second event. The current
thread is read separately, so replaying a log does not restore an older approval
or reminder. A retry remains valid if that draft's review has since changed.

Input stays visible and locked until acknowledgement or **Start a new action**.
That choice creates a distinct identity and can record another attestation; the
previous action may already exist. Reloading or leaving the form discards its
in-memory retry state. Inspect sent history before adding a new attestation.
Fresh actions still require a currently approved draft and current offer sources
where applicable. None of these actions sends a message.

## Contact Import

Open **Import contacts**, choose CSV or vCard, enter the source filename, and
paste its contents. **Preview import** parses the input on the local API and shows
supported facts, duplicate matches, invalid records, and warnings. Preview does
not create contacts or events. Go back to correct the input, or continue and
choose **Confirm import** to save the ready records. Confirmation checks for
duplicates again against current contacts, so the final imported count can
change if another import committed meanwhile.

Every saved attribute retains the filename as `sourceRef`, with
`sourceKind = user_imported_list`, `captureMethod = manual`, a capture timestamp,
confidence `1`, and `userConfirmed = true`. Import does not fetch linked content,
enrich facts, draft messages, or send outreach. Skipped duplicates never merge
into or overwrite an existing contact; review and edit that contact separately
if you want to add facts.

Duplicate checks compare case-insensitive email addresses and phone digits
(with at least seven digits) against active contacts and earlier ready records
in the batch. A unique match skips the whole record. Identifiers matching
several contacts are ambiguous and invalidate the record. Without an email or
usable phone, only an identical normalized full record (employer, application,
role, and all facts) counts as a duplicate; a name alone is not enough.
Normalization ignores text case and repeated whitespace. Soft-deleted contacts
are not duplicate targets.

### Supported vCards

The importer supports a bounded text subset of
[vCard 3.0](https://www.rfc-editor.org/rfc/rfc2426) and
[vCard 4.0](https://www.rfc-editor.org/rfc/rfc6350), including multiple cards,
folded lines, grouped property names, and escaped text. This is not a general
address-book synchronizer. Requests allow up to 1,000,000 text characters
(within the API body-size limit), 1,000 cards, 50 facts per card, 2,000 characters
per fact, and a 200-character employer. Oversized records are reported as
invalid; an oversized card batch is rejected as an invalid preview item.

| vCard property | Imported fact |
| --- | --- |
| `FN`, or structured `N` when `FN` is absent | Name |
| `ORG` | Employer link from its first component |
| `TITLE` | Title; the contact role remains **Other** |
| `EMAIL` | Email address |
| `TEL` | Plain phone number or an unqualified `tel:` URI |
| `URL` | Profile URL, stored without fetching it |
| `NOTE` | Note |

Each card needs an employer (`ORG`) because a contact must link to an employer
or application. vCards do not assign application IDs. Other properties,
including photos, addresses, birthdays, and extensions, are reported as
unsupported; they are not fetched or imported. Unsupported parameters are
reported rather than treated as extra facts. Type/preference/language labels
are reported as ignored metadata; they do not alter fact values or choose a
preferred fact. Qualified telephone URIs (such as `phone-context` or extensions)
are unsupported because reducing them to digits can conflate distinct numbers.
Unsupported versions, malformed cards, incompatible property value types,
unsupported encodings on supported fields, invalid email/phone values,
qualified telephone URIs, or missing required links are invalid records.
Unsupported properties such as an embedded photo are skipped with a warning,
including their encoding parameters, without invalidating other usable facts.
Their supported fields may be shown for review, but confirmation skips the
whole invalid card. Valid neighboring cards can still be imported.

CSV retains its existing column mapping; application links must identify an
existing job. Both formats use the same reviewed workflow and provenance
authority. For request fields and response outcomes,
see the [contacts API contract](../api/complete-contract.md#contacts).

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


## Semantic Determination Authority

Outreach generation and user edits receive source-bound claim verification using only confirmed contact facts and canonical profile sources, plus separate model quality review. Findings and source anchors are persisted by line ID. Provider and validation failures block approval and preserve the accepted draft; stock-phrase and technology word lists do not decide support. Sending still requires the user's separate explicit action.

See [the decision](../decisions.md#_2026-10-07-semantic-judgments-are-llm-determinations) for caching, provenance and failure contracts.


## Offer Communications

Job Detail → Application outcomes → **Draft an offer communication** reuses
Outreach for negotiation, clarification, acceptance and decline messages.
Choose a contact already linked to the job. The worker reads the saved actual
offer revision, any user-attested decision, canonical candidate achievements
and existing recorded compensation evidence. Employer/posting evidence and
market estimates retain their separate authority and uncertainty.

The claim verifier and independent quality reviewer must both pass. Unknown
equity, benefits, currency, time base and deadlines remain unknown; a draft may
ask for clarification. Unsupported ROI, competing offers, employer leverage
or invented deadlines are prohibited. Acceptance and decline require the
matching user-attested decision against these terms. Inspect the recorded
source snapshot in the draft's gate results before approval.

A terms or decision correction makes an earlier message stale for approval,
copying and send logging, while its body and original review remain readable.
Generate and review a replacement. An edit reruns the same gates. Provider,
budget, invalid-output or concurrent-source failures preserve the previous
approved message. Copying rechecks the current offer binding; JobCtrl never
sends the message. After sending yourself, log the send in Outreach.
