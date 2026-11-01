---
description: "Review reusable screening answers with exact saved sources and separate application-attempt history."
---

# Screening Answers

Use **Screening answers** in Job Detail or Apply Review to prepare open-ended
answers. Choose **Open screening answers** to load the private library. A saved Candidate Profile, captured posting and canonical application
destination are needed for drafting. This library is local and private; it does
not discover questions from a browser or fill application forms.

## Prepare and Review

1. Enter an application attempt identifier, the exact question and its context
   or constraints. Use a different attempt identifier for a later application
   to the same job. Capture creates a question identity separate from the Job ID.
2. Select saved supporting facts individually. Personal, authorization,
   compensation, availability, voluntary-demographic and application-attestation
   or preference fields also require the separate sensitive-value checkbox.
   Empty values provide no factual authority.
3. Generate a draft, or enter your own text and choose **Verify edited draft**.
   Question interpretation, factual verification and a separate quality judgment
   use the configured Apply model lane. Uncertainty and provider/budget failures
   remain explicit; no keyword or similarity fallback supplies an answer.
4. Inspect the source bindings and persisted model receipts. Selected sources
   describe what was allowed; the verifier's cited sources describe what it
   actually found supported. Choose **Approve reviewed answer** only after
   reading the entire draft. Approval creates an immutable reusable library
   revision and an application-bound review snapshot. Rejection preserves the
   previous accepted answer.

**Revise question or context** saves another question version. It keeps the old
accepted answer for inspection and requires a newly verified, reviewed answer
for the changed question. Unsaved answer-editor text survives navigation in the
current browser session and failed operations. Loading a generated draft into
that editor is an explicit replacement action.

## Reuse, Copy and Record Use

Open **Reviewed answer library**, choose a prior answer, select its supporting
facts in the current job and choose **Verify reuse**. Reuse requires the same
exact selected facts and sensitive-field consent. A model independently checks
question meaning and job-specific claims against the current destination;
claim verification and quality review run again. The result is a new draft,
which needs a new human review. Reuse is never inferred from similar wording.

Changes to the profile, authorization, compensation, facts, question/context,
posting, destination or material versions/content make old snapshots stale.
The previous text and history remain inspectable. Copy checks current saved
sources again before writing through the clipboard port; a stale answer cannot
be copied through this control.

Copying records no manual use. To record use, enter the **Actual manually used
text**, select the explicit attestation and choose **Record manual use**. If it
differs from the reviewed answer, history retains those exact bytes as a changed,
unverified user statement. It does not replace the reusable reviewed answer.
Review, copying and manual-use recording confer no form-entry or submission
authority and create no application-submitted outcome.

Open **Application-bound history** to inspect captured questions, draft/edit
versions, decisions, source snapshots and manual-use attestations. A failed
refresh, conflicting revision or persistence failure leaves accepted content and
previous history intact. Reload history before retrying a conflict.

## CLI and Local API

`jobctrl screening read JOB_ID` returns the private library, questions, history,
current source availability and persisted model authority. Capture a question
using `jobctrl screening write JOB_ID command.json`:

```json
{
  "action": "capture",
  "applicationId": "my-attempt-1",
  "question": "Exact question copied deliberately",
  "context": "Employer context and answer constraints",
  "expectedRevision": 0,
  "idempotencyKey": "capture-attempt-1-question-1"
}
```

Read also includes safe failed-attempt receipts with action, version and failure code; accepted answers remain intact.

Subsequent commands use the returned `questionId` and current `expectedRevision`,
a new idempotency key, and one action: `draft`, `edit`, `review`, `reuse` or `use`.
Draft/edit/reuse take `selectedFactIds` and `sensitiveFactIds` from the saved read;
edit adds `text`, review adds `decision: approved|rejected`, reuse adds
`libraryId`, and use adds actual `text` and `attested: true`. Repeating an
identical command with its original key returns its recorded result; changing
its payload with that key is refused.

The corresponding local routes are `GET` and `POST
/v1/jobs/:jobId/screening-answers`. See the [API reference](../api/jobs-and-materials.md#screening-answers)
and [owning architecture](../architecture/reviewed-screening-answers.md).
The public demo reports this private worker-backed capability unavailable.
