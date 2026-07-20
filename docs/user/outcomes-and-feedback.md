# Outcomes & Feedback

An application outcome is a reviewed local record of what happened after you
applied, such as a reply, interview, rejection, offer, withdrawal, or no
response. Feedback includes your manual corrections and bounded suggestions
from linked evidence; it improves the audit trail and analytics without
changing scoring, ranking, thresholds, or Apply eligibility.

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
