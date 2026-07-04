# Apply Feedback & Projections

How submitted applications feed outcomes back into the product, and how domain
events project into the read model the API and web app serve.

**Read this if** you need to know how apply outcomes are captured and reviewed,
or how domain events become the read model behind every list and detail view.

```mermaid
flowchart LR
    W["Workflows + activities"] -->|append| EV[("job_events")]
    W -->|"in-process projection builders (Python + TypeScript, same JSON shapes)"| PT[("projection tables: job_list / job_detail / dashboard / apply_run / artifact_list")]
    PT --> API["TypeScript API reads"]
    EV --> SSE["GET /v1/events/stream (SSE)"]
    SSE --> IR["Invalidation router"]
    IR -->|"invalidate / patch query keys"| TQ["TanStack Query cache"]
    API --> TQ
    TQ --> UI["Views"]
```

Every write appends to `job_events` and refreshes projections; the Server-Sent
Events (SSE) stream then tells the web app's cache which queries to refetch.

```mermaid
flowchart LR
    RD["application_review_decisions (approve_submit)"] --> CLAIM["Atomic apply claim (Python launcher)"]
    CLAIM --> INTENT["ApplySubmitIntended checkpoint"]
    INTENT --> SUBMIT["Live submission"]
    SUBMIT --> OUT["application_outcomes"]
    GM["Bounded Gmail scan (feedback.py)"] --> EVID["application_email_evidence"]
    EVID --> SUG["application_outcome_suggestions"]
    SUG -->|"user accepts / declines"| OUT
```

The apply path is gated and checkpointed: an approved review decision precedes
the atomic claim, a durable submit-intent checkpoint precedes live submission,
and Gmail evidence later suggests outcomes for the user to accept or decline.

## Apply Review And Outcome Feedback

The Apply Automation context has a local feedback foundation in the TypeScript
API. `apps/api/src/application-feedback.ts` owns idempotent SQLite table
creation and read/write helpers for:

- `application_review_decisions`: append-only user decisions for apply review.
- `application_outcomes`: reviewed manual or suggestion-derived outcomes.
- `application_email_evidence`: linked Gmail evidence, including body storage
  and body hash columns for confidently linked messages.
- `application_outcome_suggestions`: pending and decided classifier
  suggestions.

Apply-review approval is modeled as a recorded decision, not as an automatic
worker dispatch. Live apply claims require the latest decision for the job to
be `approve_submit` by default (`applyApprovalRequired: true`); the check runs
inside the Python launcher's atomic claim transaction, so while the gate is
on, no API or RPC dispatch path can submit without a committed
`approve_submit` decision. The gate itself is a runtime setting
(`applyApprovalRequired`, default on); a caller-supplied override can disable
it for a run, which is why the Preferences form shows a persistent warning
when it is off. Dry-run claims bypass this approval gate. Manual
outcome notes are stored only in the local outcome table.

::: warning Live submission requires an explicit approval
Live apply is blocked until an `approve_submit` decision exists for the job
(`applyApprovalRequired`, default on). Disabling the gate lets a run submit real
applications without human approval; dry-run claims always bypass it.
:::

Apply has an at-most-once checkpoint before autonomous submission:
`ApplySubmitIntended` is durably recorded immediately before the agent may
submit in a live run. If a live run dies after that checkpoint and no terminal
submit result exists, recovery parks the apply stage in `needs_verification`
instead of blindly re-queueing it. Runs without submit intent can be safely
rewound to `pending`.

Apply Review resume edits are modeled as a local feedback/draft layer in the
TypeScript API, not as direct writes to the Materials aggregate. The generated
HTML/CSS resume is loaded into a Plate editor; saved revisions, line edit
deltas, JobHunter comment threads, user replies, and feedback signals are
persisted in `resume_review_*` / `tailoring_feedback_signals` tables. A render
promotion validates the saved draft, creates a new `job_materials` generation
with replacement `tailored_resume` and `resume_pdf` artifacts plus layout boxes,
then marks unresolved comments as residual after acceptance. Existing approved
artifacts remain visible until that replacement generation is written, so failed
validation or render attempts do not destroy reviewable materials.

Gmail outcome feedback is implemented in
`workers/automation/src/jobhunter/infrastructure/gmail/feedback.py`, separate
from the verification-only Gmail MCP server. The scanner reuses the readonly
Gmail OAuth/client support but searches only bounded post-application windows
for known SQLite application anchors. Candidate queries combine the recipient
email with employer/ATS hints, job title/company terms, application URL/domain
tokens, and application timing. The worker reads a full Gmail body only after
metadata reaches the link-confidence threshold, then stores body text,
`body_sha256`, `linked_at`, confidence, safe link signals, and a unique provider
message ID in `application_email_evidence`. Deterministic v1 classification
writes pending `application_outcome_suggestions` for confirmations, recruiter
replies, interviews, assessments, rejections, offers, bounces, and unknowns.

`job_events.payload_json` receives safe summaries with identifiers, kinds,
sources, timestamps, confidence values, link signals, and presence flags; raw
notes and raw email bodies are not copied into domain events, projections,
logs, telemetry, or Gmail scan API responses.

## Read-Model Projections

The Operations / Read-Side context maintains denormalised projection
tables that back every read-model endpoint:

| Table                        | What it stores                                                    |
|------------------------------|-------------------------------------------------------------------|
| `job_list_projections`       | One row per job — title, employer, current stage/state, fit score, materials presence, apply status. |
| `dashboard_projections`      | Singleton aggregates: counts, funnel per stage, source breakdown, score distribution, and the outcome-conversion funnel (`outcome_conversion_json`: applied/reply/interview/offer/rejection counts by source and score band, from `application_outcomes`). |
| `job_detail_projections`     | Per-job description preview, score reasoning, full stages array, and curated audit history assembled from job events plus append-only apply feedback records. |
| `artifact_list_projections`  | All generated artifacts (resume txt/pdf, cover txt/pdf) with provenance. |
| `apply_run_projections`      | Apply-run telemetry with denormalised job context and event timeline. |
| `workflow_run_projections`   | One row per Temporal workflow run across all workflow types — status (12-state), input summary, failure cause, and a timeline folded from the `Workflow*` lifecycle events. The Python builder is the sole writer; the TypeScript API creates/reads it. |
| `source_quality_stats`       | Rolling per-source health rates used by the dashboard and discovery scheduler. |
| `operational_attempt_metrics` | Append-only stage/source/apply attempt facts with outcome, source role, failure class, retryability, scrape/operational flags, counts, and durations. |

The Python `ProjectionBuilder` (driven by `InProcessEventBus`) and the TS
`refreshProjections` helper both read new rows from `job_events` since the
shared `event_watermarks.operations_projections` watermark, recompute
projections from canonical aggregate state, and advance the watermark in the
same transaction. Both processes write to the same tables; SQLite handles the
concurrent advances. Request paths read precomputed projections instead of
assembling stage state with per-request joins.

The outcome-conversion projection materialises integer funnel counts only (both
builders must agree — the cross-runtime parity fixture asserts the
`outcome_conversion_json` column). The dashboard read model derives the
conversion rates (reply/interview/offer/rejection over applied) from those
counts so there is no cross-runtime float drift; `costPerInterview` stays `null`
until per-run apply cost is projected. This surface is read-only — it never
feeds scoring, ranking, thresholds, or apply eligibility.

Job detail audit history is assembled at read time from allow-listed lifecycle
events and append-only apply review/outcome records. It is a user-facing audit
timeline, not a debug log: raw event payloads, debug messages, local paths, raw
outcome notes, and email body text stay out of the response.
Posted-compensation facts are persisted in `job_posted_compensation_facts`
before inspection. They are exposed through both the narrow read-only
inspection API and projection-backed job list/detail compensation summaries.
Company-role market compensation estimates are persisted in
`job_market_compensation_estimates` before inspection. Estimates are
deterministic local facts derived from configured reported compensation feeds for
Euro Top Tech, Levels.fyi, Glassdoor, or manual imports, or from employer-posted
salary facts already captured by JobHunter.
Euro Top Tech rows are treated as public community-reported EUR/year total
compensation observations; Levels.fyi and Glassdoor rows are loaded only when a
permitted source-policy mode and feed path or URL are configured.
Employer-posted market rows are labeled as job posting salary text and remain
low confidence when they are based on a single posting or extrapolated fallback
tier. These rows store explicit estimate
states, normalized company and role, match scope, trimodal company tier,
confidence factors, confidence interval bounds, safe source snapshots, warnings,
and reasons. They do not store raw benchmark pages, provider payloads,
credentials, local paths, private account state, user compensation preferences,
or U.S. salary baselines.
Compensation writes emit `CompensationFactsUpdated` rows into `job_events`.
Those payloads carry only job id, changed section, state markers, and timestamp;
the Operations/SSE invalidation path refreshes job list/detail queries from the
projection tables.
