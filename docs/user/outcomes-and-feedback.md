# Outcomes & Feedback

An application outcome is a reviewed local record of what happened after you
applied, such as a reply, interview, rejection, offer, withdrawal, or no
response. Feedback includes your manual corrections and bounded suggestions
from linked evidence; it improves the audit trail and analytics without
changing scoring, ranking, thresholds, or Apply eligibility.

## How Email Becomes An Outcome Suggestion

The Gmail feedback path uses a bounded deterministic link-and-classify process;
it does not ask a model to read the inbox and decide what happened.

1. **Start from known applications.** A user-started scan builds anchors from
   applied job rows, reviewed outcomes, and successful live Apply runs, then
   keeps the earliest qualifying anchor for each job. A job row uses
   `applied_at` when present; a legacy row marked applied without that timestamp
   falls back to `discovered_at`. By default the scan checks at most 25 anchors
   and five search results per anchor inside a 45-day window that starts at the
   selected anchor.
2. **Score metadata before reading a body.** The current link signals are
   additive and capped at `1.0`:

   | Matching signal | Credit |
   | --- | ---: |
   | Expected recipient | `0.20` |
   | Inside the application time window | `0.20` |
   | Employer name | `0.20` |
   | Job title | `0.15` |
   | Application domain | `0.15` |
   | Known ATS hint | `0.10` |
   | Outcome wording | `0.10` |

   JobCtrl links a message only at `0.70` or above. It fetches and stores the
   bounded body only after that metadata gate passes.
3. **Classify with fixed phrase rules.** The linked subject, snippet, and body
   are checked in priority order for bounce, offer, rejection, interview,
   assessment, application confirmation, and recruiter-reply language. If no
   rule matches, the suggestion is `unknown`; the confidence shown is the
   rule's fixed confidence, not a learned probability.
4. **Wait for a human decision.** Accept and correct create a canonical reviewed
   outcome; ignore closes only the suggestion. Provider/message identity keeps
   the same email from creating duplicate evidence.
5. **Gate analytics by sample size.** Raw counts remain visible. Conversion
   rates require at least five applied records in the cohort, and median
   response time requires five response-time samples.

This keeps private mail access narrow and preserves the difference between a
machine suggestion, a reviewed lifecycle fact, and descriptive analytics.

## What You Can See And Control

- Open `/jobs/:jobId` and use **Application outcomes** to record an outcome,
  occurrence time, and optional local note. The same Job Detail workspace shows
  the ordered outcome timeline and any pending suggestion for that job.
- After using stored interview prep, record a reflection in the prep panel. The
  resulting interview outcome can link to the prep generation that preceded it.
- `/dashboard` surfaces pending outcome suggestions and the high-level
  applied-to-response funnel.
- `/analytics` groups recorded outcomes by source, score band, requirement-fit
  band, apply mode, template, or policy. Small groups show counts until they
  meet the API's current sample threshold; rates and medians are descriptive
  associations, not causal claims.

When the bounded Gmail feedback scanner has produced a suggestion, you choose
whether to accept it, correct its classification, or ignore it. JobCtrl does not
turn an email classification directly into a reviewed outcome without that
decision. The current web app reviews resulting suggestions but does not expose
the scan trigger; scan initiation is the `POST` API action listed below. Gmail
setup and the read/send boundary are documented in
[Apply](apply.md#gmail-connector-and-sending-boundary).

Apply-run state and application outcomes answer different questions. Apply
history records what the automation attempted and whether submission evidence
exists; outcome history records your reviewed understanding of what followed.
Both may appear in the same job audit timeline without sharing ownership.

## Source Of Truth And Ownership

- **Reviewed outcomes** live in canonical `application_outcomes` rows. Manual
  entries and accepted/corrected suggestions use the same outcome record shape.
- Only a reviewed `applied_confirmation` outcome is a confirmed application
  fact for repeat-application protection. Other outcome kinds, local notes, and
  unknown outcomes do not establish application history.
- **Suggestions** remain separate in `application_outcome_suggestions` until you
  decide them. A pending Gmail suggestion is never treated as a confirmed
  application; suggestion accuracy is derived from later decisions.
- **Linked Gmail evidence** stays local. A bounded scan starts from known
  application anchors and reads body content only after metadata reaches the
  link-confidence gate. Raw mail bodies never enter broad projections, events,
  logs, telemetry, or scan responses.
- **Local notes** stay in the canonical outcome table. Events carry safe IDs,
  kinds, timestamps, confidence/link markers, and presence flags rather than
  note text.
- **Analytics** is a read model over canonical outcomes and accepted material
  metadata. It cannot write back to a score, policy, profile, discovery query,
  or application decision.

The job detail audit history is allow-listed explanatory history, not a raw
event dump. It intentionally excludes private notes, mail bodies, local paths,
and debug payloads.

## Lifecycle

### Manual outcome

1. You choose an outcome and optionally add the time and a local note.
2. The API validates the request and creates a new canonical outcome record.
3. A privacy-bounded domain event invalidates outcome, job, dashboard, and
   analytics reads.
4. Projection-backed views show the reviewed timeline and recompute aggregate
   counts or sample-gated rates.

### Gmail suggestion

1. A user-started bounded scan searches post-application windows using local
   recipient, employer, title, URL/domain, and timing anchors.
2. Confidently linked evidence is stored locally and produces a pending
   suggestion; the response exposes only safe references and classification
   metadata.
3. Accept or correct writes a reviewed outcome. Ignore closes the suggestion
   without manufacturing one.
4. The suggestion decision remains available for accuracy reporting, while the
   reviewed outcome becomes the job's lifecycle fact.

Outcome feedback does not retrain a model or automatically adjust a scoring
policy in the current product. Score corrections have their own explicit
lifecycle under [Scoring](scoring-and-employer-analysis.md).

## Implementation And API Pointers

| Layer | Pointer |
| --- | --- |
| User surfaces | `/jobs/:jobId`, `/dashboard`, and `/analytics`; the practical monitoring loop is in [Daily Workflow → Inspect Progress](normal-flows.md). |
| HTTP contract | `GET /v1/outcomes`, per-job outcome reads/writes, suggestion decisions, `POST /v1/outcomes/gmail/scan`, and `GET /v1/analytics/outcomes`; see [Jobs & Materials API](../api/jobs-and-materials.md#apply-review-and-outcomes) and the [complete outcomes contract](../api/complete-contract.md#apply-review-and-outcomes). |
| API implementation | Outcome routes and projections are composed in `apps/api/src/server.ts`, `apps/api/src/read-model.ts`, and `apps/api/src/projections.ts`. |
| Web implementation | `apps/web/src/contexts/apply/components/ApplicationOutcomes.tsx`, Operations outcome hooks/keys, `views/dashboard/`, and `views/analytics/`. |
| Deep architecture | [Apply Feedback & Projections](../architecture/read-model.md#apply-review-and-outcome-feedback) and its [sensitive projection boundaries](../architecture/read-model.md#evidence-analytics-and-compensation). |
