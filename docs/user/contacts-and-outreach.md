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
3. **Ground the actual draft.** A draft may use Candidate Profile evidence,
   confirmed contact facts, and the linked application context. The
   never-fabricate check runs on the rendered message itself, not merely on the
   prompt or recipient record.
4. **Run the approval stack.** Structural checks require a usable greeting and
   sign-off and flag prohibited wording, model self-talk, and length problems.
   The structured judge then evaluates relevance, evidence support,
   relationship accuracy, safety, and professionalism. Approval requires
   `PASS`, a score of at least `0.82`, no unsupported claims, and no fabricated
   relationship.
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

For a confirmed contact, you can generate or revise an outreach draft, inspect
its deterministic checks, judge result, and claim-to-fact bindings, then approve
or reject it. Only an approved draft can be copied. After you send that copy
through your own channel, **log a send** records your attestation; it is not a
send action. Follow-ups are editable reminders that you complete or dismiss
yourself. The current cadence policy belongs to
[Apply → Outreach Follow-Ups](apply.md#outreach-follow-ups) and is not duplicated
here.

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
unsupported encodings, qualified telephone URIs, or missing required links are
invalid records.
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
