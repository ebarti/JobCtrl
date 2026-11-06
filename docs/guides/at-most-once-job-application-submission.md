---
description: "Understand durable submit intent, exact approval, retry ambiguity, and JobCtrl's manual browser boundary."
---

# At-most-once Job Application Submission

At-most-once means JobCtrl must not create a second employer-facing send just
because the first result is uncertain. A provider can accept a message even
when the response is lost. The accepted Python target records an intent before
the owned email send, retains confirmation separately and leaves ambiguity for
human verification. Integrated worker, browser and installed-runtime proof is
still in progress.

## Why Ordinary Retries Are Dangerous

A failed read can often be retried safely. A send is different: after a timeout
or crash, local state may not show whether the employer received it. JobCtrl's
intent records that the one authorized attempt was admitted. If no valid
matching receipt is available, the original operation remains
`needs_verification` rather than being silently repeated.

## At-most-once Is Not Exactly-once

At-most-once does not promise that a message arrived. It prevents a second
owned attempt once intent exists. A failure before intent may permit a new
reviewed attempt if current controls allow it; after intent, ordinary retries,
reset, a different run or restart cannot create another send. Inspect the
provider or employer history and record what is known without rewriting the
original uncertain intent.

## Local Stops Do Not Resolve External Uncertainty

Skip and cancellation stop new claims, including batches and standing work.
They cannot retract a provider operation already admitted. A valid late
confirmation can settle the original run and record the actual outcome while
preserving the local stop. A missing or malformed confirmation stays uncertain.
Safe reset requires fresh preparation and approval, and never clears an existing
intent merely to enable another attempt. See [Skip and safe reset](../user/apply.md#skip-and-safe-reset).

## Approval Is Bound At The Mutation Boundary

An email approval binds the exact recipient, subject, body, resume bytes,
application and source versions, plus the qualifying rehearsal. Before intent,
the Python Applications owner rechecks current Profile, job, Fit, screening
answers, accepted resume, latest decision, rehearsal, local stop and repeat
risk under the writer transaction. It captures the approved attachment bytes,
writes one unique intent and rechecks the attachment before committing. The
sender uses the pinned bytes instead of reopening a mutable file.

A changed relevant source, payload or decision requires new preparation and
review. Unrelated additions can make a coverage report stale without revoking
an accepted PDF; a changed selected source or revoked approval cannot. An
approval, retry or direct API call cannot authorize a different payload.

## Repeat Protection Answers A Different Question

At-most-once protects a particular attempted send. Repeat protection asks whether
a confirmed application already exists for the same opening. The same opening
is blocked. A source-bound assessment of a different opening at the same
employer can require a reasoned one-use confirmation for an equivalent role.
Pending suggestions, notes, dry runs and unconfirmed intents do not establish
that an application occurred. Existing intent still independently blocks retry.

## Browser And Email Have Different Submission Boundaries

An employer website's final form submission is manual. The read-only browser
rehearsal uses an owned empty browser and one exact navigation; it has no typing,
credentials, upload or submission capability. Its coverage is partial, and the
user's explicit acknowledgement of that limitation is bound to the specific
rehearsal. A model or extension cannot turn page text into final-submit
authority.

The owned Gmail adapter can perform one approved send after durable intent.
A successful provider response must contain a valid message ID, and any
thread ID supplied must also be valid. Lost, invalid or unconfirmed results
remain uncertain; the sender does not retry an existing intent. A confirmed
receipt is evidence of that original provider operation, not a promise of
remote exactly-once delivery.

## Dry Runs Exercise The Boundary Without Submitting

Rehearsal observes the exact candidate and records what was actually inspected.
Scripts, redirects, additional navigation, uploads, credentials and mutations
are unavailable in the target browser rehearsal. Dynamic or multi-page content
may therefore remain unknown. A dry run neither submits an application nor
implicitly approves a later live send.

## What To Do When Verification Is Required

1. Do not start another live attempt.
2. Check sent-mail or employer-side history outside the model.
3. Record the actual outcome or uncertainty in JobCtrl.
4. Keep the original intent and review history; a generic reset does not grant
   permission to resend.

For the user workflow, see [Apply](../user/apply.md). For safety requirements,
see [developer security](../developer/security.md#apply-path-containment).
