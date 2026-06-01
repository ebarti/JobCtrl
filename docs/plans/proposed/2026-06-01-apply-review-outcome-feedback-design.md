# Apply Review Queue And Outcome Feedback Design

## Goal

Build an end-to-end application control loop for JobHunter:

```text
ready to apply -> user review -> apply/dry-run -> email feedback -> reviewed outcome
```

The first version is local-first, Gmail-only for email feedback, and keeps user
approval in the loop for risky actions and outcome changes.

## Scope

This feature adds two linked product surfaces:

- **Apply review queue:** a pre-submit queue for jobs that appear ready to apply
  but still require explicit user review before submission.
- **Outcome tracking:** a post-apply timeline that records manual outcomes and
  Gmail-derived outcome suggestions.

Gmail feedback is read-only. Full message bodies may be ingested only after a
message is confidently linked to a known application. Stored message bodies are
sensitive local evidence and must not be copied into domain events, telemetry,
logs, broad projections, or public PR content.

## Domain Model

### Terms

**ApplyReviewItem**  
Read-side queue item for a job whose apply prerequisites are ready or nearly
ready. It summarizes materials readiness, score, source/apply URL confidence,
latest dry-run result, blockers, and review state.

**ApplyReviewDecision**  
User decision on a review item: approve submit, approve dry-run, defer, decline,
or reset review. Decisions are recorded as local events and projected back into
the queue.

**ApplicationOutcome**  
Reviewed job-search outcome for a submitted or externally handled application:
applied confirmation, recruiter reply, interview, assessment, rejection, offer,
withdrawn, bounced, no response, or unknown.

**ApplicationEmailEvidence**  
Sensitive local evidence captured from Gmail after linking a message to a known
application. It stores message identifiers, headers/snippet, received time,
linking signals, confidence, body text, and body hash.

**OutcomeSuggestion**  
Unreviewed classifier result derived from email evidence. Suggestions never
silently overwrite a reviewed outcome in v1.

### Invariants

- Auto-submit remains opt-in. A review decision can approve a submit action, but
  the apply execution path still respects existing dry-run and explicit submit
  controls.
- Review decisions and outcome decisions are append-only facts. Current queue
  state and current outcome are projections over those facts.
- Full Gmail bodies are stored only for linked application messages.
- Raw email bodies are never written to `job_events.payload_json`, traces, logs,
  or dashboard summary JSON.
- Outcome suggestions require user acceptance or correction before they become
  application outcomes.
- Gmail feedback uses a dedicated feedback connector surface, not the existing
  verification-only Gmail MCP tool.

## Product Flow

### Apply Review Queue

1. A job enters the queue when it is active, not deleted/hidden, has apply stage
   pending/blocked/failed/stale, and has enough evidence to review.
2. The queue row shows job, company, source, fit score, materials readiness,
   application URL, latest apply/dry-run status, blockers, and review state.
3. The user can approve dry-run, approve submit, defer, or decline.
4. Approve dry-run triggers the existing apply action with `dryRun: true`.
5. Approve submit records review approval and triggers the existing apply action
   with `dryRun: false`.
6. Defer and decline keep the job inspectable and remove it from active review
   until reset.

### Outcome Tracking

1. Apply success, manual mark-applied, or accepted confirmation creates an
   application anchor for email feedback.
2. Gmail feedback scan searches bounded time windows after known application
   anchors using recipient, employer, ATS, domain, job title/company, and apply
   timing signals.
3. Candidate Gmail metadata is scored for linking confidence.
4. When confidence is high enough, JobHunter reads and stores the full body as
   `ApplicationEmailEvidence`.
5. A local classifier produces an `OutcomeSuggestion` with kind, confidence,
   rationale, and evidence reference.
6. The UI outcome review queue lets the user accept, correct, or ignore the
   suggestion.
7. Accepted or corrected outcomes update job detail, dashboard metrics, and the
   outcome history.

## Data Storage

The local SQLite schema gains focused tables:

- `application_review_decisions`: append-only review decisions by job.
- `application_outcomes`: reviewed outcomes by job.
- `application_email_evidence`: linked Gmail evidence with body text and hashes.
- `application_outcome_suggestions`: unreviewed/reviewed classifier suggestions.

Projection reads may be implemented directly from these tables in v1. The
existing `job_events` stream records only safe summaries and identifiers.

## API Surface

- `GET /v1/apply/review-queue`
- `POST /v1/jobs/:jobKey/apply-review/decision`
- `GET /v1/outcomes`
- `GET /v1/jobs/:jobKey/outcomes`
- `POST /v1/jobs/:jobKey/outcomes`
- `POST /v1/outcome-suggestions/:suggestionId/decision`
- `POST /v1/outcomes/gmail/scan`

All mutating routes use existing local mutation origin protections.

## Frontend Surface

- Add an Apply review tab/page that composes existing score, materials, pipeline,
  and apply controls.
- Add outcome timeline and outcome controls to job detail.
- Add outcome suggestion review UI for Gmail-derived suggestions.
- Add dashboard conversion metrics for reviewed outcomes and pending outcome
  suggestions.

Forms must use semantic form controls, visible labels, fieldsets for grouped
choices, and submit buttons with concrete action labels.

## Stacked PRs

1. **Foundation:** contracts, schema helpers, read/write model functions, docs,
   and API tests for review decisions and manual outcomes.
2. **Product UI:** apply review queue UI, job detail outcome timeline, frontend
   hooks, dashboard metrics, and component tests.
3. **Gmail feedback:** Gmail feedback connector, message linking, body evidence
   ingestion, outcome suggestions, worker/API integration, and focused Python +
   API tests.

## Validation

Automated validation must cover API behavior, persistence, projection/read-model
behavior, frontend hooks/components, typechecks, build, and Python Gmail feedback
logic. Manual QA is reserved for the final human product pass.
