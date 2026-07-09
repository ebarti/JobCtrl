# Local TypeScript API

The local TypeScript API (the process the web app talks to) is the runnable
backend app under `apps/api`.

**Read this if** you are wiring a UI feature to the backend, adding or changing
a route, or tracing how a web action reaches the Python worker.

It owns product-facing JSON endpoints, reads the local SQLite database, and
invokes Python automation through the JSON-RPC 2.0 protocol over a long-lived
`jobctrl rpc` subprocess. It is intentionally local-first and binds to
`127.0.0.1` by default. As a DNS-rebinding defense, an `onRequest` hook rejects
any request whose `Host` header is not a loopback host (`127.0.0.1`,
`localhost`, or `[::1]`, with an optional port) with `403` `forbidden_host`;
local browser and CLI callers always send a loopback `Host`, so legitimate
access is unaffected. A second guard rejects cross-site mutations: `DELETE`,
`PATCH`, `POST`, and `PUT` requests whose `Origin` or `Referer` is present but
not loopback fail with `403` `cross_site_request` before any handler runs. When
browser fetch metadata is present, unsafe mutations also reject
`Sec-Fetch-Site: cross-site`; `same-site` is accepted only after the loopback
`Origin`/`Referer` check has passed, so the default Vite web app on another
loopback port still works while foreign browser origins do not.
Authenticated browser-extension routes are additive to that model:
`/v1/extension/*` routes still require a loopback `Host`, but trusted
`chrome-extension://` origins get route-scoped CORS and may satisfy the mutation
origin/fetch-metadata guards with `Authorization: Bearer <local capability
token>`. Existing loopback web and CLI behavior is unchanged.

## API at a glance

Each route family below has its own heading on this page. Jump to the area you
need:

| Area | What it covers |
| --- | --- |
| [Profile and preferences](#profile-and-preferences) | Reading and writing the candidate profile, autosave, and the Preferences / Discovery / Settings control split. |
| [Artifacts and tailoring audit](#artifacts-and-tailoring-audit) | Read-model projections, artifact preview/open routes, resume templates, and canonical tailoring evidence. |
| [Jobs read model and lifecycle](#jobs-read-model-and-lifecycle) | Score evidence, requirement-fit, career evidence map, audit history, list filters, and delete / hide / restore routes. |
| [Dashboard, analytics, and operational metrics](#dashboard-analytics-and-operational-metrics) | `GET /v1/dashboard/summary`, `GET /v1/analytics/outcomes`, source health, and operational attempt counters. |
| [Discovery controls](#discovery-controls) | Source registry, locator / quarantine / manual-capture queues, and feedback endpoints. |
| [Compensation](#compensation) | Posted-salary and reported-market inspection routes plus the refresh triggers. |
| [Workflow runs](#workflow-runs) | `/v1/workflow-runs` list, detail, and cancel across every workflow type. |
| [Profile resume preview](#profile-resume-preview) | The baseline profile resume HTML and PDF preview endpoints. |
| [Apply review and outcomes](#apply-review-and-outcomes) | Review queue, resume-review drafts, decisions, and bounded Gmail outcome ingestion. |
| [Contacts](#contacts) | The `/v1/contacts` routes: list (with `jobId`/`employer` filter), detail, create, update, delete, CSV import, the supervised-research run / list / detail / confirm-candidate routes, the outreach draft read / generate / revise / approve / reject routes, and the Phase 4 send-log / follow-up (schedule / complete / dismiss) / due-follow-ups routes. |
| [Pipeline and preparation actions](#pipeline-and-preparation-actions) | Global and per-job stage runs, rescore / re-tailor, retry, and per-job actions. |
| [Discovery target search](#discovery-target-search) | How Discover honors the profile Target search and location / work-model filters. |
| [Worker runtime and health](#worker-runtime-and-health) | `GET /v1/health`, the worker-readiness gate, and JSON-RPC transport hardening. |
| [Settings and credentials](#settings-and-credentials) | `/v1/settings`, extension pairing token routes, and Keychain-backed `/v1/credentials`. |
| [Server-Sent Events](#server-sent-events-—-get-v1-events-stream) | The `GET /v1/events/stream` realtime contract. |

## Profile and preferences

`GET /v1/profile` and `PATCH /v1/profile` use the normalized Candidate
Profile tables in `jobctrl.db` as the source of truth. When the profile
tables are empty, `GET /v1/profile` returns an empty profile with default
rendering settings. Explicit profile saves and resume-PDF imports create or
update the SQLite rows.
Profile-data writes also record `ProfileUpdated` in `job_events`. When existing
tailored resumes are present, the API handles that event by dispatching a
background `tailor -> cover` pipeline run with `retailor=true`, `dryRun=false`,
and no item limit. The Python materials generation path creates a new materials
generation for each re-tailored job, immediately follows it with cover-letter
generation for jobs that are ready, and preserves older generations as
superseded artifact data.
The web Profile, Preferences, Discovery target search, and Settings forms
autosave five seconds after the last edit using the same profile/settings
mutation paths as the explicit Save buttons; failed validation or mutation
errors stay on the local form surface.
The Preferences Application configurations section owns the user-editable
Location filter control and persists it through the local settings mutation;
the Preferences Tailoring controls section owns generated-material policy such
as the adjacent-experience invention toggle, revision-gate minimum fit score,
must-have coverage, and revision-attempt limits in the profile
`tailoring_rules`. Verified facts and evidence-backed reframing are baseline
non-inventing behavior, along with supported adjacent-experience translation;
the Preferences toggle only allows or forbids invented adjacent-experience
drafts. Draft adjacent claims require review and are not user-configured as an
auto-approval bypass. The Discovery page owns target search plus automation
controls such as discovery minimum fit score and auto apply. The Settings page
keeps execution-only controls such as apply concurrency.
When `VITE_GOOGLE_MAPS_API_KEY` is available to the web dev process, the Profile
Address field progressively enhances into a Google Maps Places address search.
Selecting a Google result updates the existing address, city, state/province,
country, and postal-code profile fields; without the key, the field remains a
normal editable street-address input.

## Artifacts and tailoring audit

Read-model endpoints (`/v1/dashboard/summary`, `/v1/jobs`, `/v1/jobs/:key`,
`/v1/artifacts`, `/v1/workflow-runs`) read from the local `*_projections` tables
maintained by `apps/api/src/projections.ts` (TS-side mirror) and the Python
`ProjectionBuilder` (`workers/automation/src/jobctrl/infrastructure/projections/`).
Both processes refresh projections idempotently via the shared
`event_watermarks.operations_projections` watermark.
Artifact detail routes include `GET /v1/artifacts/:artifactId` for metadata and
`GET /v1/artifacts/:artifactId/preview.pdf` for inline access to registered PDF
artifacts. HTML/CSS-rendered resume PDFs also expose
`GET /v1/artifacts/:artifactId/preview.html`, which streams the generated
sibling HTML file used by the Plate-backed Apply Review editor. That route is
limited to `render_format = 'html_pdf'` resume PDF artifacts and rejects
historical `latex_pdf` rows with `415`; operators can create HTML siblings for
approved legacy resume PDFs with
`uv --project workers/automation run jobctrl migrate-resume-html` after
checking `--dry-run`, or refresh already-HTML PDFs after renderer CSS changes
with `--force`. `GET /v1/artifacts/:artifactId/preview/page/:pageNumber.png`
renders a single registered PDF artifact page through local Poppler
`pdftoppm` for page-image previews. The preview routes serve only
known PDF artifact files from the local artifact projection; they return `404`
for missing metadata/files, `415` for unsupported artifact/renderer formats,
and `400` for invalid page numbers. The separate
`POST /v1/artifacts/:artifactId/open` route delegates to the local OS opener;
for resume text/PDF artifacts it first runs the resume-template ensure-current
path and opens the newest approved same-type artifact when a render-only
template refresh succeeds.
Every preview and open route only touches a path that is a registered artifact
in the projection AND whose `realpath` stays inside the JobCtrl app directory;
a path that resolves outside the app directory (for example a tampered
projection row or a symlink escape) is rejected with `403`
`artifact_path_forbidden` before any file is streamed or handed to the OS
opener.
PDF artifact detail responses also include `layoutBoxes` when the Materials
projection has generated resume layout metadata. Boxes use page-relative
percent coordinates plus optional resume line numbers. Apply Review passes them
into the HTML editor for line/page anchoring; PDFs or artifacts without a
layout map return an empty array.

Resume template editing is exposed through local JSON endpoints:
`GET /v1/resume-templates` lists the built-in and saved templates plus the
current default, `GET /v1/resume-templates/:templateId` returns one template,
`POST /v1/resume-templates` saves a style/layout-only template
version, `PATCH /v1/resume-templates/default` selects the default template, and
`PATCH /v1/jobs/:jobKey/resume-template` sets or clears a per-job override.
`POST /v1/jobs/:jobKey/resume-template/ensure-current` lazily creates a
render-only materials generation when the latest accepted resume text exists
but was rendered with an older effective template. The refreshed `resume_pdf`
is rendered from the resume HTML through the same Playwright `HtmlResumePdfAdapter`
(`render_format = 'html_pdf'`), so it is a full multi-page document rather than a
truncated fallback. The endpoint preserves the existing accepted artifacts and
records refresh status (including a `failed` attempt when the render fails)
instead of modifying profile data or replacing reviewable output in place.
Tailored resume artifact detail responses include safe tailoring evidence only:
keyword coverage counts and lists, evidence and quality summaries,
judge/adversarial-review results,
warning-repair status, annotated source-vs-tailored resume changes, high-fit
persona prompt/response audit, and model selection metadata. Persona warning
cards expose an expandable audit trail for the stored LLM request and structured
response behind that judgment. The `keywords` summary block (`planned` /
`covered` / `missing` + counts and `coverageRecorded`) is **derived from the
canonical coverage audit** (see below), not recomputed from the resume file or
the job description at read time; when the generation recorded no coverage the
block is honestly empty with `coverageRecorded: false`. Responses do not expose
raw generator prompts, raw profile payloads, or raw job text; annotation and
persona prompt snippets are bounded excerpts of the selected source, tailored
resume, and adversarial-review request.

The tailoring explanation is served exclusively from canonical projection rows.
The read model parses each artifact's own `metadata_json` projection column for
the non-coverage audit fields and attaches the per-bullet provenance, coverage,
and voice from their canonical projection columns. There is no sibling-file
fallback (an artifact whose own audit metadata is a shell is honestly flagged
incomplete rather than synthesised from a neighbouring artifact or a sibling
`.txt` file) and no TypeScript-side keyword recompute. The two canonical
generation-time audit fields are: `coverageAudit`, the honest keyword coverage
(covered + missing) computed against the actual rendered (voiced) resume text —
a keyword counts as covered only when it appears in a provenance-backed grounded
bullet, and `coveredBy` records which bullet demonstrates each covered keyword;
and `voicePass`, the voice-pass audit (whether the de-buzzword/vary-structure
pass ran and was accepted, the model, the prompt version, and the deterministic
buzzword-density / structural-variety proxy delta that justified it). Both are
`null` for a generation that recorded none, and a PDF artifact resolves them
(and the derived `keywords` block) from the sibling tailored-resume projection
row of the same generation.

## Jobs read model and lifecycle

`/v1/jobs` and `/v1/jobs/:key` expose the latest persisted scoring evidence
from `job_scores` as additive read-model fields: `scoreBreakdown`,
`scoreKeywords`, `scoreVersion`, `scoredAt`, `scoreTrace`, and
`scoreStaleness`. `scoreTrace` includes policy-facing metadata such as scoring
policy version, rubric version, calibration adjustment, and policy anchor
counts without exposing raw policy anchor payloads. `scoreStaleness` reports
unresolved stale markers, including the stale reason, current and target policy
versions, marked time, and whether the score is waiting for explicit rescore
reset. `scoreReasoning` remains on the wire as a compact compatibility summary.
`/v1/jobs/:key` also exposes `requirementFitReport` when the latest score has
canonical requirement-level assessments. The report is projected from
`job_requirement_fit_reports` and ordered `job_requirement_fit_items` rows and
shows the requirement weights, match status, score contribution, and tailoring
directive that explain the resolved fit score. It is `null` for jobs that have
not yet been scored with requirement-level evidence.
`GET /v1/evidence-map` returns the career evidence map projected from the same
canonical sources already used by scoring and materials audit: profile
achievement evidence and skills, latest bullet provenance, requirement-fit
items, and generation-time artifact coverage audits. The response contains
`entries[]` for achievement/skill evidence, attached resume-bullet,
requirement-fit, and coverage usages, plus `gaps[]` for missing skills and
missing/blocked/transferable requirements. It never recomputes claims from job
descriptions at read time and never introduces a separate preparation pipeline.
`/v1/jobs/:key` also returns `auditHistory[]`, a user-facing timeline assembled
from allow-listed `job_events` entries plus append-only apply review and
outcome feedback records. The timeline summarizes discovery, enrichment,
scoring, materials, pipeline, apply, outcome, and job visibility changes without
returning raw event payloads, debug messages, local paths, raw notes, or email
body text.
Job summaries also include source provenance. `discoverySource` is the observed
source registry id where the job was found and falls back to the discovery
strategy/source pair when canonical source identity is absent. `postingSource`
and `postingSourceUrl` come from canonical identity evidence when a broad-board
result points at a known ATS or employer-owned posting. The jobs list accepts
`minFitScore`, `maxFitScore`, `discoveredSince`, and `scoredSince` query
parameters, plus `applyStatus=applied` for jobs with an actual applied outcome
(`applied_at` present or apply status `applied`). The timestamp filters accept
ISO UTC timestamps and are used by digest deep links; when `discoveredSince`
and `scoredSince` are both present, the jobs list matches rows where either
timestamp is at or after its threshold. Active filters and sort remain URL state
in the web app. The same score and applied-outcome filters are accepted by
all-matching bulk job mutations.
`GET /v1/digest` returns the local daily digest read model for the dashboard and
CLI. It composes projection-backed counts for new matches, blocked sources,
apply-review materials, stale scores, pending approvals, derived follow-ups due,
and budget status. Passive reads never advance `digest_state.last_acknowledged_at`;
only the explicit acknowledge flow may move the watermark. The digest uses a
timestamp watermark and a UTC follow-up cutoff, resolving the plan's local-vs-UTC
day-boundary inconsistency in favor of UTC.
`POST /v1/digest/acknowledge` accepts an optional `acknowledgedAt` ISO
timestamp, advances the watermark monotonically, and returns the updated
`digest_state`. Acknowledge writes also record `DigestReviewed`, which lets the
SSE invalidation router refresh the dashboard digest query without any external
delivery channel.
`POST /v1/jobs/:key/score-correction` writes a new corrected `job_scores`
version, records `ScoreCorrected`, and updates the versioned `scoring_policies`
table with a correction-derived calibration anchor. It mirrors the Python
`CorrectScoreUseCase` policy update path because this TypeScript API mutation writes
directly to SQLite instead of crossing the Python JSON-RPC boundary. When the
policy version changes, the API also marks comparable latest uncorrected scores
stale in `job_score_staleness`; corrected score versions are not marked stale.
`POST /v1/scoring/stale-scores/actions/reset-for-rescore` clears active stale
markers and resets their score stage to `pending` for an explicit rescore. The
body accepts `jobKeys` for selected stale scores or an empty list for all active
stale scores, plus optional `limit` for bounded resets. The backend command
that consumes those reset jobs is `jobctrl score --rescore` or the batch
API action with `stage: "score"` and `rescore: true`.
The jobs list `deleted` filter accepts `active`, `closed`, `deleted`, `hidden`,
or `all`. Closed jobs are non-deleted postings whose active-state verification
marked them unavailable, expired, removed, or location-incompatible; they are
excluded from active lists, dashboard totals, and worker queues while remaining
inspectable from the Closed tab. Deleted jobs are temporary removals: discovery
clears the delete tombstone when the same posting is observed again. Hidden jobs
use a separate `jobctrl_hidden_jobs` tombstone and remain suppressed from
active/deleted/closed lists, dashboard totals, artifacts, workflow runs, and
activity until an unhide mutation clears that hidden tombstone. Soft delete
and restore are exposed at `DELETE /v1/jobs/:key` and
`POST /v1/jobs/:key/restore`, plus bulk `POST /v1/jobs/bulk-delete` and
`POST /v1/jobs/bulk-restore`. The API exposes
bulk hide/unhide routes at `POST /v1/jobs/bulk-hide` and
`POST /v1/jobs/bulk-unhide`, plus single-job `POST /v1/jobs/:key/hide` and
`POST /v1/jobs/:key/unhide`. Permanent delete is
available at `POST /v1/jobs/bulk-delete-permanent` and
`DELETE /v1/jobs/:key/permanent`; it removes the job row plus job-scoped state,
projection rows, and delete/hide tombstones. It does not write a new suppression
record, so rediscovery can add the same posting again later.
`POST /v1/jobs/bulk-retry-failed` accepts the same selected-job or
all-matching bulk mutation body and resets each active failed or exhausted job's
failed stage to `pending`; non-failed selected jobs are ignored.

## Dashboard, analytics, and operational metrics

`/v1/dashboard/summary` includes `sourceHealth[]`, sourced from
`source_quality_stats`. The projection is rebuilt from discovery run,
source-observation, duplicate, content snapshot, enrichment, apply-URL, and
active-state events and user discovery feedback. It is the read-side signal the
web dashboard uses for source health. The same response also includes
`operationalMetrics`, sourced from `operational_attempt_metrics`, plus
per-source operational/scrape/retryable failure counts. These counters use
structured stage/source/apply attempt rows, not label math over free-text event
messages.

Each `sourceHealth[]` entry also carries an additive `politeness` object with
per-source crawl-politeness outcome counts recorded by the R10 politeness
gateway — `robotsDisallowedCount`, `rateLimitedCount`, `budgetExhaustedCount`,
plus `lastBlockedReason` and `lastBlockedAt`. These are sourced from
`operational_attempt_metrics` rows written with `outcome = "blocked"` and
`is_scrape_failure = 0`, so a robots-disallowed / rate-limited / budget-exhausted
source shows *why* it produced nothing without being counted as a scrape
failure. All counts `0` with a `null` last reason means no politeness outcome was
recorded.

`GET /v1/analytics/outcomes` returns the outcome analytics read model sourced
from `dashboard_projections.outcome_conversion_json`. It exposes integer counts
and read-time rates for totals plus `bySource`, `byScoreBand`, `byFitBand`, and
`byApplyMode`, plus Phase 4 fields `byTemplate`, `byPolicy`, `timeToResponse`,
and `suggestionAccuracy`. Every row carries `n` (`applied`) beside the rate
fields, and all rates are `null` until `n >= MIN_CONVERSION_SAMPLE` (`5` by
default in `apps/api/src/read-model.ts`). `byScoreBand` uses the existing
score-band vocabulary, while `byFitBand` is a separate canonical requirement-fit
breakdown. Template/policy groups come from accepted material artifact metadata;
response-time minutes come from `applied_at` and response-kind
`application_outcomes.occurred_at`; suggestion counts come from decided
`application_outcome_suggestions` rows. The endpoint is read-only and stays
outside scoring, ranking, thresholds, and apply eligibility.

## Discovery controls

Discovery product-control endpoints are local-first and share DTOs from
`packages/contracts`. The web Discovery page composes these endpoints and the
profile-backed Target search settings into source-registry, source-locator,
quarantine-review, role-matching, and manual-capture surfaces; the
source registry renders as a paginated, filterable, sortable table so source
type and policy metadata are visible as columns instead of compact badges:

- `GET /v1/discovery/settings` returns the SQLite-backed runtime discovery
  settings used by board discovery.
- `PATCH /v1/discovery/settings` updates those runtime settings without
  dropping the worker search-contract fields stored in the same row.
- `GET /v1/discovery/sources` lists source registry entries merged with
  `source_quality_stats`. Each entry also carries the same additive `politeness`
  object as `sourceHealth[]` (robots-disallowed / rate-limited / budget-exhausted
  counts plus the last block reason/time), sourced from
  `operational_attempt_metrics`, so the registry table can show why a source was
  blocked instead of a silent zero.
- `POST /v1/discovery/sources` upserts a local source registry entry and emits
  `SourceRegistryEntryCreated` or `SourceRegistryEntryUpdated`.
- `PATCH /v1/discovery/sources/:sourceId/state` changes local source state and
  emits `SourceStateChanged`.
- `GET /v1/discovery/sources/:sourceId/preview` returns local preview leads
  from recent `JobSourceObserved` history for that source; it does not perform
  live scraping.
- `GET /v1/discovery/locator-candidates`, `GET /v1/discovery/quarantine`, and
  `GET /v1/discovery/manual-capture` expose the local review queues. Located
  parseable source candidates are auto-promoted into the active source registry;
  these queues are for blocked, ambiguous, unparseable, or compatibility pending
  work.
  JobSpy direct URLs feed this same loop: runnable ATS URLs are promoted into
  the source registry, while unknown owner URLs or ATS URLs that still need
  adapter configuration remain visible for review.
- `POST /v1/discovery/locator-candidates/:candidateId/promote` promotes a
  source locator candidate into an active source registry entry and emits
  `SourceLocationCandidatePromoted`.
- `POST /v1/discovery/locator-candidates/:candidateId/reject` removes a local
  source locator candidate from the review queue.
- `POST /v1/discovery/quarantine/:jobKey/decision` approves or rejects a
  quarantined lead and records feedback for source-quality aggregation.
- `POST /v1/discovery/manual-capture/:itemId/import` records user-mediated
  capture provenance for copied URLs, current-page URLs, pasted text, saved
  HTML, and email imports. Raw pasted or saved content is not copied into domain
  events; the API stores only local metadata such as content length and hash.
- `POST /v1/discovery/manual-capture/:itemId/dismiss` dismisses a pending
  manual-capture item.
- `POST /v1/discovery/feedback` records `DiscoveryFeedbackRecorded` with IDs,
  source, kind, and timestamp only; free-form notes stay out of the domain event
  payload.
- `GET /v1/discovery/role-match-feedback` derives a local review queue from
  newly scored jobs with very low fit scores and role-fit evidence. Suggestions
  are exact title-exclusion rules, not automatic prompt or query changes.
- `POST /v1/discovery/role-match-feedback/:suggestionId/decision` approves or
  declines a suggestion. Approved exact-title exclusions are visible in the
  Discovery page and are consumed by future discovery title matching; declined
  suggestions remain recorded but inactive.

## Compensation

`GET /v1/compensation/sources` returns the read-only compensation source policy
registry used by the Settings compensation-source panel. The response contains
safe policy metadata only: source id, display name, source type, access mode,
availability, license status, terms/source URLs, freshness policy, attribution
requirement, supported field names, disabled reason, configured flag, Europe
coverage notes, and safe operator notes. It does not return credentials, raw
provider payloads, private-account state, local paths, scraped salary data, or
salary observations.

The endpoint is deterministic and network-free. It does not fetch, scrape,
cache, or return raw provider payloads. It lists posted salary text, Euro Top
Tech, Levels.fyi, Glassdoor, and the temporary manual reported-compensation
import as safe policy entries. Levels.fyi automated access remains unavailable unless
`JOBCTRL_LEVELS_FYI_ACCESS_MODE` is `licensed_api`, `licensed_data_feed`, or
`enterprise_mcp` and `JOBCTRL_LEVELS_FYI_EUROPE_COVERAGE` is truthy.
Glassdoor automated access remains unavailable unless
`JOBCTRL_GLASSDOOR_ACCESS_MODE` is `partner_api` or `written_permission`.
When available, refresh paths automatically load licensed Levels.fyi rows from
`JOBCTRL_LEVELS_FYI_OBSERVATIONS_PATH` or
`JOBCTRL_LEVELS_FYI_OBSERVATIONS_URL` and Glassdoor rows from
`JOBCTRL_GLASSDOOR_OBSERVATIONS_PATH` or
`JOBCTRL_GLASSDOOR_OBSERVATIONS_URL`. JSON and CSV feeds are accepted. The
source registry does not expose secrets, row contents, local paths, or feed URLs.

`GET /v1/jobs/:jobKey/compensation/posted` returns the read-only
inspection contract for canonical posted-compensation facts. The endpoint reads
`job_posted_compensation_facts` only; it does not parse, backfill, update,
persist, refresh projections, call external providers, or run React-side
normalization during a GET. For an existing job with a canonical row, the
response is `{ ok: true, recordStatus: "recorded", fact }`, where `fact`
contains the parse state (`missing`, `unparseable`, `ambiguous`, or
`parsed_range`), bounded source text, raw salary fallback, parser
version, source hash, parse timestamp, confidence, warnings, and normalized
currency/period/component/min/max/annualized fields only for legal parsed
ranges. For an existing job without a canonical row, the response is
`recordStatus: "not_recorded"` plus the current raw `jobs.salary`
fallback. Unknown jobs return `404`.

The projection-backed `/v1/jobs` and `/v1/jobs/:key` responses include
`compensationSummary`, sourced from `job_list_projections` /
`job_detail_projections` JSON rather than API read-time salary parsing. The
detail response also includes top-level `compensationAudit`, which keeps
`posted` and `market` inspection payloads separate. The raw
`JobSummary.salary` string remains present for compatibility. Compensation
summary/audit data does not change fit score, apply readiness, apply-review
handoff, or apply mutation behavior. The Jobs list exposes dedicated sortable
and filterable scan columns for posted salary minimum and maximum normalized to
EUR/year, reported market estimate, market confidence, and compensation
warnings; these sort through `compensation_min_eur`,
`compensation_max_eur`, `compensation_market`, `compensation_confidence`, and
`compensation_warnings` alongside the existing sortable job columns. The Salary
min, Salary max, and Market headers carry the `EUR/year` unit so row values stay
compact. The `compensation_posted` sort remains accepted as a
compatibility alias for the posted minimum. Currency normalization is a
projection concern: supported parsed currencies are converted to EUR/year;
unsupported or missing currencies leave the normalized min/max empty instead of
guessing.

`GET /v1/jobs/:jobKey` also includes top-level `interviewPrep`, sourced from
`job_detail_projections.interview_prep_json`. The value is `null` until the user
explicitly generates prep for that job. When present, it is the latest accepted
stored prep generation with item text, item kind, evidence IDs, requirement IDs,
joined profile source snippets, gate/judge summary, and accepted-residual
warnings. It does not expose raw prompts, full profile JSON, or full job
descriptions.

`GET /v1/jobs/:jobKey/compensation/market` returns the read-only
inspection contract for canonical company-role reported compensation estimate
rows. The endpoint reads `job_market_compensation_estimates` only; it does not
estimate, backfill, update, persist, refresh projections, call providers, scrape
pages, or normalize anything in React during a GET. Existing jobs without a
market row return
`{ ok: true, recordStatus: "not_requested", jobKey }`; unknown jobs return
`404`.

Recorded market estimates expose one explicit state: `unsupported`,
`source_unavailable`, `insufficient_evidence`, or `estimated_range`. Range
fields are present only for `estimated_range`. Non-range states carry
inspectable reasons, confidence factors, safe source snapshots, and warnings
instead of nullable precision. Source scope is reported compensation
evidence keyed by company and role: Euro Top Tech public community-reported
rows, Levels.fyi, Glassdoor, and manual local reported-compensation imports. The
estimate includes company name, normalized company, role title, normalized role,
match scope, total compensation component, source count, sample count,
confidence factors, selected evidence rows, and trimodal company-tier context.
Selected evidence rows are the sanitized reported observations used to choose
the range, including source id/display name, company, role, location, level,
component, EUR/year range, sample count, release year, source URL when the
observation has a safe public URL, and match scores. Raw benchmark pages,
credentials, private account payloads, local paths, unsafe/private URLs, and
user compensation preferences are not returned.

Temporary write trigger: `jobctrl compensation-refresh` reparses posted salary
facts from existing `jobs.salary` values and description compensation text,
imports all configured reported compensation observations, estimates matching
existing jobs, and refreshes projections without running discovery, scoring,
tailoring, cover, or apply automation. Explicit `--observations-json <file>`
imports are additive with configured Levels.fyi feeds, configured Glassdoor
feeds, and public Euro Top Tech rows. When reported evidence does not match, the
estimator falls back to employer-posted salary facts already captured by
JobCtrl as low-confidence posted-salary evidence. It falls back through same company/role,
same-location role, same-company adjacent-role, trimodal company-tier, and broad
market-baseline tiers so sparse real evidence still produces a best estimate
with a wider confidence interval. Fallback matching is seniority-aware, so
executive CTO/VP roles do not reuse staff, principal, or director observations
unless the selected source row is also executive-level. It does not label those rows as Levels.fyi,
Glassdoor, Euro Top Tech, or manual reported-compensation data unless that
source actually contributed observations. `--url <job-url>` narrows the refresh
to one existing job.

Manual web/API triggers: `POST
/v1/jobs/:jobKey/actions/refresh-compensation` dispatches the same focused
compensation refresh through the local worker for one existing job, while `POST
/v1/jobs/actions/refresh-compensation` refreshes every existing job. Both paths
avoid rerunning discovery, scoring, tailoring, cover, or apply automation. The
request body may include `{ "observationsJsonPath": "/path/to/export.json" }`
to import additional reported-compensation observations before estimating market
evidence, or `{ "includeEuroTopTech": false }` to disable only the public Euro
Top Tech import. Configured Levels.fyi and Glassdoor feeds still load by
default. When no reported source matches, the estimator still falls back to the
selected job's captured employer-posted salary facts when they can be safely annualized or when
high-value base-salary text can be treated as annual evidence without using
bonus-only or one-sided rows. The refresh dispatches `refresh_compensation`,
which starts `CompensationRefreshWorkflow`; the response is the standard
action response with the queued workflow ID.

Market estimates also project into the same job list/detail compensation
summary and detail audit fields, separate from posted facts. The compact
summary carries range, market confidence band/score, source count, sample count,
and warning count for list surfaces; detail audit carries the source trail,
selected evidence rows with safe source URLs, confidence factors, warnings, and
reasons. The web Jobs
table, expanded job drawer, and Apply Review render these persisted fields
without parsing salary text in React. This projection and rendering do not change fit score, apply
readiness, apply-review handoff, or apply mutation behavior.

When Python compensation repositories save posted facts or market estimates,
they append `CompensationFactsUpdated` to `job_events`. The SSE payload contains
only safe state markers: job id, changed section (`posted` or `market`), posted
record/parse state, market record/estimate state, and timestamp. It does not
contain source text, market source snapshots, profile compensation preferences,
credentials, local paths, or provider payloads. The frontend Operations
invalidation router uses the event to refresh job list/detail queries.

## Workflow runs

`/v1/workflow-runs` reads the unified `workflow_run_projections` table (the
Python-sole-writer projection folded from the `Workflow*` lifecycle events) and
projects each row to a `WorkflowRunSummary` across **all** workflow types —
pipeline orchestrator, apply, and future workflows. Apply rows are enriched with
job context (title/company/dry-run/model) via a LEFT JOIN to
`apply_run_projections`; non-apply rows surface their `workflowType` instead of a
job title. The `runId` equals the Temporal workflow id, so the web Workflow Runs
view at `/runs` deep-links each row to the local Temporal Web UI
(`http://127.0.0.1:8233`).
`GET /v1/workflow-runs/:runId` returns a `WorkflowRunDetail` for one run — its
status, input summary, failure cause (`errorCode` / `errorMessage` /
`retryable`), Temporal run id, and the folded lifecycle timeline — or `404`
(`{ ok: false, error: "workflow_run_not_found" }`) for an unknown id. The `/runs`
detail drawer renders it for every workflow type.
`POST /v1/workflow-runs/:runId/actions/cancel` dispatches a worker-backed
`cancel_run` request for in-flight workflow IDs that are not tied to a concrete
job row, such as global Discover or Apply runs started from the Pipelines tab.
`GET /v1/dashboard/summary` also carries recent apply-run timeline summaries
from `apply_run_projections.events_json` (`type`, `level`, `message`, `at`) so
the Run details drawer renders persisted history without exposing raw event
payloads.

## Profile resume preview

`GET /v1/profile/preview.html` renders the baseline Candidate Profile resume
HTML used by the Profile page Plate editor. The renderer is the same HTML/CSS
resume renderer used for generated materials. `GET /v1/profile/preview.pdf`
remains a compatibility endpoint for callers that need a baseline PDF, but the
Profile web route no longer uses a PDF iframe and no longer has a Profile-level
alternate render override.

## Apply review and outcomes

Apply review and outcome feedback endpoints power the local web
`/apply-review` queue and the job-detail outcome timeline. Gmail feedback
ingestion is Gmail-only and runs through the Python worker, not through the
verification-code MCP server:

- `GET /v1/apply/review-queue` returns active apply-stage jobs that are ready
  or close enough for human review, plus materials readiness, latest apply-run
  context, blockers, latest review state, `compensationSummary` from the job
  list projection, and `applyAudit`, the canonical readiness/blocker/eligibility
  DTO used by Apply Review. The materials preview includes the selected resume
  text artifact, selected resume PDF artifact, and `resumePdfLayoutBoxes` for
  generation-time line/page anchoring when the selected final PDF was rendered
  through the HTML/CSS resume renderer. Requirement-led materials can also
  include `requirementLedAudit`: bounded coverage, generated-claim, pinned
  content, bullet-overflow, revision, and review-blocker summaries derived from
  artifact metadata without projecting raw prompts, full profile/job text,
  local paths, PDFs, logs, browser data, or SQLite contents. The `revision`
  summary labels its `coverageBasis` (`grounded_shipped_text_v1` vs
  `judge_claimed_legacy`), carries `claimedOnlyRequirementIds`, and reports
  `revisionsUsed` (`attempt - 1`) alongside the raw attempt ordinal; when the
  artifact was generated by the grounded gate the audit also carries an optional
  `shippedFit` (the lifecycle-labeled `post_generation_fit_final` record) with
  the grounded shipped must-have coverage, pass state, and post-acceptance
  warnings, so legacy judge-claimed numbers are labeled rather than hidden.
  Apply Review uses
  the selected PDF artifact to fetch the sibling HTML preview for the Plate
  editor and keeps the PDF as the final file link.
- `GET` / `POST /v1/jobs/:jobKey/resume-review/draft` loads or creates the
  separate editable draft for the selected resume artifact generation. Draft
  revisions, structured edit deltas, comment threads, comment replies, and
  feedback signals are stored append-only in the TypeScript API tables and do
  not mutate approved materials in place.
- `POST /v1/resume-review/drafts/:draftId/revisions` saves manual or autosaved
  Plate document revisions and extracts bounded feedback signals from changed
  lines. `POST /v1/resume-review/drafts/:draftId/comment-threads` seeds
  deterministic JobCtrl line-comment threads from audit pins, and
  `POST /v1/resume-review/comment-threads/:threadId/replies` records the user's
  reply without suppressing the original source pointer or risk label.
  `GET /v1/jobs/:jobKey/resume-review/feedback` lists the bounded feedback
  signals extracted from that job's draft edits.
- `POST /v1/resume-review/drafts/:draftId/render` validates the latest saved
  draft, writes a new `job_materials` generation with `tailored_resume` and
  `resume_pdf` artifacts plus layout boxes, and marks the draft promoted. It
  returns structured validation errors instead of replacing materials when the
  edited resume is empty, too short, renderer-incompatible, or carries explicit
  unsupported-claim markers. The `resume_pdf` artifact is produced by rendering
  the edited resume HTML through the same Playwright `HtmlResumePdfAdapter` the
  worker uses (`render_format = 'html_pdf'`), so it captures every edited
  line/section across as many pages as the content needs rather than a truncated
  single page. If that render fails the promotion is aborted and the previous
  approved generation is left intact.
- `GET /v1/jobs/:jobKey` returns the same `applyAudit` DTO on job detail
  payloads so the Jobs drawer and Apply Review consume the same readiness
  facts. The DTO includes state, label, summary, missing prerequisites, hard
  blockers, eligibility concerns, source metadata, and whether review evidence
  remains available.
- `POST /v1/jobs/:jobKey/apply-review/decision` appends an
  `approve_submit`, `approve_dry_run`, `defer`, `decline`, or `reset`
  decision. `approve_submit` records the reviewed materials generation, profile
  version, and application URL, and it is accepted only when matching full
  dry-run evidence exists or the request explicitly names a matching partial
  dry-run run. `approve_submit` requests must include the displayed
  `materialsGeneration`, `profileVersion`, and `applicationUrl`; if any value
  no longer matches the current review row, the API returns `409` with
  `approval_stale_materials`, `approval_stale_profile`, or `approval_stale_url`
  before inserting a decision row. Approval records intent only in this slice;
  it does not dispatch the apply worker.
- `GET /v1/outcomes` and `GET /v1/jobs/:jobKey/outcomes` return reviewed
  outcomes and any outcome suggestions.
- `POST /v1/jobs/:jobKey/outcomes` writes a manual reviewed outcome. For
  `kind: "interview"`, callers may include `interviewPrepGeneration` to link a
  post-interview reflection to an accepted or superseded prep generation for the
  same job. The link is nullable and invalid generations are rejected.
- `POST /v1/outcome-suggestions/:suggestionId/decision` accepts, corrects, or
  ignores a pending suggestion and writes a reviewed outcome for accepted or
  corrected suggestions.
- `POST /v1/outcomes/gmail/scan` runs a bounded Gmail feedback scan over known
  application anchors. The request accepts optional `recipientEmail`, `limit`,
  `maxResultsPerAnchor`, and `windowDays` values. The response returns counts
  plus evidence/suggestion IDs, job keys, kinds, and confidence values only; it
  never returns raw Gmail body text.

The web review queue records approval facts only. `approve_submit` is bound to
the material, profile, URL, and dry-run evidence shown in Apply Review; stale
bindings, missing dry-run evidence, and invalid partial-run overrides are refused
before the decision row is written. The live-apply gate is enforced again at the
Python worker's claim transaction. `approve_submit` does not dispatch browser
submission, and `approve_dry_run` does not start a dry run.
Manual outcomes and suggestion corrections require canonical ISO-8601 UTC
`occurredAt` timestamps when the field is supplied. Application outcome
responses include nullable `interviewPrepGeneration`; it is set only for linked
manual interview reflections.

These routes create `application_review_decisions`, `application_outcomes`,
`application_email_evidence`, and `application_outcome_suggestions`
idempotently in SQLite. Gmail scanning searches only bounded post-application
windows for anchors already known locally, using recipient, employer/ATS,
title/company, application URL/domain, and application timing signals. Full
Gmail bodies are read and stored only after metadata confidently links to a
known application, with provider message ID dedupe. Outcome notes and linked
email bodies may be stored locally, but `job_events.payload_json` stores only
safe IDs, kinds, sources, timestamps, confidence values, prep-generation links,
link signals, and note/body presence flags.

## Contacts

The Contact & Outreach context exposes local, loopback-only JSON routes for
contact records and supervised research. There is still no send or drafting route,
and nothing here sends anything. Contact-record writes are hosted directly in the
TypeScript API (`apps/api/src/contacts.ts`): they write the canonical
`contacts` / `contact_attributes` rows, append durable, SSE-visible events to
`job_events` (`entity_kind = 'contact'`, `entity_ref = <contactId>`), and refresh
the `contact_projections` read model. The Python worker's
`SqliteContactRepository` writes the same tables and event types.

Sensitivity: attribute VALUES (names, emails, notes) live only in
`contact_attributes.value_json` and reach the client solely through the read DTOs
below — never in event payloads, projections, logs, or telemetry. Every rendered
fact carries provenance (`sourceKind`, `sourceRef`, `captureMethod`, `capturedAt`,
`confidence`, `userConfirmed`).

- `GET /v1/contacts` lists contact summaries from `contact_projections`. Optional
  `jobId` and `employer` query parameters filter by the linked application or
  company. Each `ContactSummary` carries `contactId`, `displayName`, `role`,
  `employer`, `jobId`, `attributeCount`, `confirmedCount`, `sourceKinds`,
  `allConfirmed`, and timestamps.
- `GET /v1/contacts/:contactId` returns a `ContactDetail` — the summary fields
  plus `attributes[]`, each with its `value` and full `provenance`. An unknown id
  returns `{ ok: false, error: "contact_not_found" }`.
- `POST /v1/contacts` creates a contact (`ContactCreateRequest`: `role`,
  optional `employer` / `jobId`, and `attributes[]`). A contact must link to at
  least one of `employer` / `jobId`, or the route returns `invalid_contact`.
  Created facts are tagged `sourceKind = user_entered`.
- `PATCH /v1/contacts/:contactId` updates a contact's link, role, and/or
  attributes (`ContactUpdateRequest`). Replacing `attributes` re-tags them as
  `user_entered`; an unknown id returns `contact_not_found`.
- `DELETE /v1/contacts/:contactId` soft-deletes a contact and returns
  `{ ok, contactId, deletedAt }`.
- `POST /v1/contacts/import` imports a CSV list (`ContactImportRequest`:
  `filename`, `csvText`). Every imported fact is tagged
  `sourceKind = user_imported_list`, `sourceRef = <filename>`,
  `captureMethod = manual`; rows that link to neither an employer nor an
  application are skipped. Returns `{ ok, imported, skipped, contactIds }`.

Contact DTOs and request/response schemas live in `packages/contracts`
(`ContactSummary`, `ContactDetail`, `ContactAttributeDto`,
`ContactFactProvenance`, and the create / update / import / delete request and
response shapes).

### Contact research

Supervised research (Phase 2) adds four routes. The **run** is not a direct
SQLite write — the API dispatches the `run_contact_research` JSON-RPC method to
the Python worker, which starts `ContactResearchWorkflow` on Temporal. Fetching
routes only through the merged politeness gateway against the conservative
per-source opt-in allowlist (no public source is auto-fetched by default;
login-walled URLs route to manual capture). Candidates land `needs_review` and
require an explicit confirm command before becoming stored contact facts (INV-4).

- `GET /v1/contacts/research` lists `ContactResearchTaskSummary` rows from
  `contact_research_task_projections`; optional `jobId` / `employer` filters.
- `GET /v1/contacts/research/:taskId` returns a `ContactResearchTaskDetail` — the
  summary plus `sourceAttempts[]` (the per-source outcome audit) and
  `candidates[]`, each with its proposed `attributes[]` (value + provenance).
  An unknown id returns `{ ok: false, error: "research_task_not_found" }`.
- `POST /v1/contacts/research` (`RunContactResearchRequest`: optional `employer` /
  `jobId` — at least one required — plus opted-in `sources[]`) mints a `taskId`,
  pre-creates a `queued` task, dispatches `run_contact_research`, and returns
  `202 { ok, taskId, runId, workflowId, status }`.
- `POST /v1/contacts/research/:taskId/candidates/:candidateId/confirm`
  (`ConfirmContactCandidateRequest`, optional `role`) promotes a `needs_review`
  candidate into a stored `Contact` (preserving its research provenance,
  marking it user-confirmed) and returns `{ ok, contact, task }`. A candidate
  that is unknown or already resolved returns `research_candidate_not_found` /
  `invalid_confirm`.

The `run_contact_research` JSON-RPC method (params `taskId`, optional `employer` /
`jobUrl`, `sources[]`, `llmModel`) is a workflow-mode method returning the
`{ runId, workflowId, firstExecutionRunId }` start shape.

### Outreach drafts

Outreach drafting (Phase 3) generates truthful, reviewable messages. Draft
**generation** and **revision** are not direct SQLite writes — the API dispatches
the synchronous `generate_outreach_draft` JSON-RPC method to the Python worker,
which runs the LLM synthesis plus the full truthfulness gate stack inline (the
reused materials gates: deterministic never-fabricate detector, content validator,
LLM-as-judge, and claim → fact provenance) and persists the gated draft as a new
generation. Draft **approval** and **rejection** are simple lifecycle transitions
hosted in the TypeScript API (`apps/api/src/outreach.ts`); approval is HARD-gated on
the persisted `gate_results_json.passed` (INV-5). There is no send route anywhere —
an approved draft is copied out by the browser clipboard, never sent (INV-1).

Sensitivity: the draft `bodyText`, gate results, and claim provenance live only in
canonical `outreach_drafts` and reach the client through the thread detail read
below; the draft-lifecycle events written to `job_events` (`entity_kind =
'outreach'`, `entity_ref = <threadId>`) carry only ids, kinds, generation, and
timestamps.

- `GET /v1/contacts/:contactId/outreach` returns the `OutreachThreadDetail` for a
  contact (optional `jobId` query resolves the application-scoped thread), or
  `{ ok: true, thread: null }` when no thread exists yet. The detail carries the
  thread summary plus each generation's `bodyText`, `gateResults`, and claim
  `provenance`.
- `POST /v1/contacts/:contactId/outreach/drafts` **generates** a new draft
  (`GenerateOutreachDraftRequest`: optional `kind`, `jobId`, `applicationRole`,
  `llmModel`). It resolves or mints the thread id, dispatches
  `generate_outreach_draft`, and returns `{ ok, thread }` with the freshly gated
  candidate. Requires a ready worker (`503` otherwise).
- `POST /v1/outreach/threads/:threadId/drafts` **revises** the thread
  (`ReviseOutreachDraftRequest`: `editedBodyText`, optional `kind`,
  `applicationRole`, `llmModel`). The edited body becomes a new generation and
  re-runs the identical gates; returns `{ ok, thread }`.
- `POST /v1/outreach/threads/:threadId/drafts/:draftId/approve` approves a
  candidate draft. It returns `409 { error: "draft_gates_not_passed" }` when the
  persisted gates did not pass (INV-5), `404 { error: "outreach_draft_not_found" }`
  for an unknown thread/draft, and `400 { error: "invalid_outreach_transition" }`
  when the draft is not awaiting approval. Approving supersedes the previously
  approved draft.
- `POST /v1/outreach/threads/:threadId/drafts/:draftId/reject` rejects a candidate
  draft (`RejectOutreachDraftRequest`: optional `reason`); the last approved draft
  is left untouched (INV-5).

Send logging and follow-ups (Phase 4) are simple state transitions hosted directly
in the TypeScript API. **No route sends anything (INV-1)** — `send-logs` records a
user-attested fact, and the follow-up routes manage a surfaced-only reminder:

- `POST /v1/outreach/threads/:threadId/send-logs` records that the **user** sent an
  approved draft (`LogOutreachSendRequest`: `draftId`, `channel`, `sentAt`). It is
  the ONLY way a thread reaches a "sent" state; it rejects any draft that is not
  approved with `400 { error: "invalid_outreach_transition" }` (approving and
  logging a send are distinct actions), and returns the updated
  `OutreachThreadDetail` (`sendLogs`, `isSent`). The written `OutreachSendLogged`
  event carries only ids, the channel label, and timestamps.
- `POST /v1/outreach/threads/:threadId/follow-up/schedule` schedules the next
  follow-up (`ScheduleFollowUpRequest`: optional `dueAt`, `basis`, `submittedAt`,
  `hasLoggedReply`). When `dueAt` is omitted the date is DERIVED from the
  application lifecycle (7 days after `submittedAt` for the first follow-up, 14 for
  a subsequent no-reply nudge) — a suggestion the user can edit. Emits
  `FollowUpScheduled`.
- `POST /v1/outreach/threads/:threadId/follow-up/complete` and
  `.../follow-up/dismiss` mark a scheduled follow-up done or dismissed (emitting
  `FollowUpCompleted` / `FollowUpDismissed`); both return `400` when no follow-up
  is scheduled.
- `GET /v1/outreach/follow-ups/due` returns `{ ok, followUps: DueFollowUpSummary[] }`
  — the projected scheduled follow-ups whose `due_at` has arrived (`isDue`
  computed over the clock at read time). It never sends and never auto-acts.

The `generate_outreach_draft` JSON-RPC method (params `threadId`, `contactId`,
optional `jobId` / `kind` / `applicationRole` / `llmModel`, plus `editedBodyText`
to select the revise path) is a synchronous method — like `analyze_job`, it runs
the LLM + gate stack inline and returns `{ threadId, contactId, jobId, draftId,
generation, kind, status, gatePassed }`. Outreach DTOs and request/response schemas
live in `packages/contracts` (`OutreachThreadSummary`, `OutreachThreadDetail`,
`OutreachDraftDto`, `OutreachDraftGateResults`, `OutreachClaimProvenanceDto`,
`OutreachSendLogDto`, `OutreachFollowUp`, `DueFollowUpSummary`, and the generate /
revise / reject / log-send / schedule-follow-up request shapes).

## Pipeline and preparation actions

`POST /v1/pipeline/actions/run-stage` starts global/batch pipeline stage runs
from the UI. The product-facing stage order is `discover -> apply`: the stage
trigger sends `discover` for preparation and `apply` for browser automation.
The low-level contracts still accept internal `score`, `tailor`, and `cover`
values for compatibility, diagnostics, and maintenance commands, but they are
not primary user-facing stages.

The request accepts `stages`, `limit`, `workers`, `minScore`,
`validationMode`, `dryRun`, the default pipeline LLM model (`llmModel`, default
`gemini:gemini-3.5-flash`), tailoring LLM controls (`tailorModels`,
`tailorJudgeModel`, `tailorJudgeMinScore`), and apply flags (`headless`,
`model`, `continuous`). Discover requests may also pass `sourceIds`, a
deduplicated list of source-registry IDs from `GET /v1/discovery/sources`; when
present, the Python runner filters the discovery schedule before any provider
crawl starts. `model` remains apply-only; scoring, tailoring, and cover
generation use `llmModel` unless a tailoring generator or judge override is
supplied. Low-level internal requests can still pass `rescore` and `retailor`
flags for the `score` and `tailor` maintenance stages. The route dispatches the
ordered stage list to JSON-RPC
`run_stage`, which starts `JobPipelineWorkflow`; when `discover` runs, the
Python runner discovers jobs, drains detail enrichment, and then drains
internal preparation work for scoring, tailoring, cover generation for
successfully tailored jobs, and artifact suppression.
When the selected stage is `apply`, the same `run_stage` request remains inside
`JobPipelineWorkflow`, which delegates to `ApplyWorkflow` as a child workflow.
The dedicated apply JSON-RPC method is used by per-job apply actions, not by
this global/batch run-stage route. The route uses the command key `pipeline`
only as the local action response handle, not as a fake job URL. Successful
workflow starts return `202` with the queued workflow ID. Workflow-start
failures return `200` with the dispatcher-derived failed action.
Queued or accepted starts expose that workflow ID to the Pipelines tab so the
user can stop the in-flight run without resolving a fake `pipeline` job row.
`dryRun` defaults to `true`, preserving apply safety. The apply model defaults
to `default`, which omits `--model` and lets the local Claude Code
configuration choose the active model.

`POST /v1/jobs/:jobKey/actions/run-stage` starts one job-scoped preparation
pickup without resetting stage state. It accepts the internal preparation
stages `enrich`, `score`, `tailor`, and `cover`, rejects product-stage starts
such as `apply`, resolves the route key to the canonical job URL, checks worker
readiness, and dispatches `run_stage` for the remaining preparation sequence
from the requested substage. Before dispatch, the route refreshes projections
and checks that the requested substage is still pending and observably eligible;
known-ineligible rows return `status: "not_eligible"` without starting worker
work. The Jobs page uses this route for eligible viewed rows that are `pending`
on a visible preparation substage, and starts at most one pickup per unchanged
list snapshot so pending preparation continues autonomously without page-render
fanout.
- `POST /v1/jobs/bulk-run-pending-preparation` accepts selected jobs or all
  matching jobs. It does not reset stages. It selects the first eligible pending
  preparation substage per job (`enrich`, `score`, `tailor`, or `cover`),
  groups those jobs by substage, and dispatches bounded `run_stage` workflows
  with selected job URLs and the requested worker count. Known-ineligible,
  failed, exhausted, already-complete, low-fit, and `apply`-pending rows are
  ignored. The Jobs toolbar exposes this as `continue pending prep` so pending
  preparation backlogs are not dependent on page-local pickup.

The `limit` field is forwarded to every selected stage. For `discover`, the
Python runner passes it into JobSpy, Workday, Smart Extract, Discovery's
internal detail-enrichment queue drain, and the preparation work-item drains.
Bounded source crawls run sequentially, skipping remaining selected sources once
the cap is reached so `limit: 1` is usable for local debugging. If `sourceIds`
is provided, unselected provider groups are not executed or recorded as skipped;
selected sources that the scheduler disables or quarantines still emit skipped
source-run telemetry. Detail enrichment uses the same `limit` and `workers`
values as Discovery; `enrich` remains an internal retry/diagnostic stage, not a
top-level product `run-stage` value.

Discovery preparation uses `preparation_work_items` to keep internal subwork
durable and idempotent. The work item kinds are `score_job`, `tailor_resume`,
and `suppress_tailored_artifacts`. The queue emits
`PreparationWorkItemQueued`, `PreparationWorkItemStarted`,
`PreparationWorkItemCompleted`, and `PreparationWorkItemFailed`; the owning
contexts still emit their own events such as `JobScored`,
`TailorRetailorRequested`, `TailoredArtifactsSuppressed`, and
`TailoringPolicyUpdated`. These events are part of the SSE catalog and drive
dashboard, jobs, artifacts, and activity invalidation.

Current-version preparation maintenance actions are separate endpoints:

- `POST /v1/jobs/:jobKey/actions/rescore-current-policy` dispatches
  `rescore_job` for one job.
- `POST /v1/scoring/actions/rescore-current-policy` dispatches
  `rescore_jobs_not_on_current_scoring_policy` for selected or bounded active
  jobs.
- `POST /v1/jobs/:jobKey/actions/retailor-current-policy` dispatches
  `retailor_job` for one job and can suppress the prior active artifacts;
  successful re-tailoring continues into cover generation for that job.
- `POST /v1/materials/actions/retailor-current-policy` dispatches
  `retailor_current_policy` for selected or bounded eligible jobs and can
  suppress prior active artifacts.
- `POST /v1/jobs/:jobKey/actions/retry-stage` resets the selected stage. With
  `runAfter: true`, preparation retries dispatch a job-scoped pipeline workflow
  for the remaining preparation stages (`enrich` -> `score` -> `tailor` ->
  `cover`, starting at the retried stage). `apply` retry still dispatches the
  explicit apply action; retries do not auto-submit applications unless the
  requested stage is `apply`.
- `POST /v1/jobs/bulk-retry-failed` accepts selected jobs or all matching jobs.
  With the default `runAfter: false` it only resets each retryable failed stage
  to `pending`. With `runAfter: true`, the API groups reset preparation stages
  (`enrich`, `score`, `tailor`, `cover`) and dispatches bounded batch
  `run_stage` workflows with the selected job URLs and requested worker count.
  The route records pipeline workflow metadata plus per-job `StageQueued`
  events with `source: "bulk_retry_failed"` so later debugging can tell which
  action picked up the reset rows. `apply` failures are reset but not
  auto-run from the bulk retry route.
- The active Jobs bulk toolbar exposes `retry all failed` outside the failed
  state filter. It posts the current Jobs filters with `state: failed` and
  `deleted: active`, sets `runAfter: true`, and sends the saved pipeline worker
  controls so users can recover failed substages from pending or mixed-state
  views without selecting each failed row first.
- The active Jobs bulk toolbar also exposes `continue pending prep`, posting
  the current Jobs filters with `state: pending` and `deleted: active` to the
  bulk pending-preparation endpoint. The endpoint still filters out application
  work, so this control never auto-submits applications.

First-time manual tailoring is not a re-tailor action. The job detail stage
timeline exposes `POST /v1/jobs/:jobKey/actions/tailor` on the internal
`tailor` stage, dispatching JSON-RPC `tailor_job` for the selected job only.
That explicit user action records a `TailorRequested` audit-history event,
overrides the default low-fit auto-tailoring gate for the selected job without
changing the batch `minScore` behavior, and immediately continues into cover
generation when tailoring succeeds.

Other per-job action routes: `POST /v1/jobs/:jobKey/actions/apply` dispatches
the apply JSON-RPC method (and so `ApplyWorkflow`) for one job;
`POST /v1/jobs/:jobKey/actions/generate-materials` dispatches the tailor →
cover preparation stages for one job and returns `202` when the worker is
ready; `POST /v1/jobs/:jobKey/actions/generate-interview-prep` dispatches the
explicit `generate_interview_prep` workflow action for one job and returns `202`
when queued; `POST /v1/jobs/:jobKey/actions/cancel` requests cooperative
cancellation of that job's in-flight work; and
`POST /v1/jobs/:jobKey/actions/mark-applied` /
`POST /v1/jobs/:jobKey/actions/mark-skipped` record manual pipeline outcomes
without browser automation.

The `analyze_job` JSON-RPC method (params `jobUrl`, optional `force`) produces or
returns the canonical employer analysis for one job independently of a full
tailor. Unlike the workflow-mode tailor methods, it runs synchronously: it
executes the three-SDK analysis ensemble to completion (no wall-clock timeout) and
persists the canonical analysis, then returns `{ jobUrl, generation, cacheKey,
cached, legsAttempted, legsSucceeded, degraded }`. The same analysis is produced
automatically as the front-half sub-step of tailoring, so a re-tailor reuses the
cached analysis (keyed by posting snapshot hash) rather than re-reasoning;
`force: true` recomputes and supersedes the prior generation. The standalone
inspector surface can build on the same method, persistence, and read path.

The `generate_interview_prep` JSON-RPC method (params `jobUrl`, optional
`llmModel`) starts `InterviewPrepWorkflow` and returns the normal workflow-start
shape (`runId`, `workflowId`, `firstExecutionRunId`). It is an explicit
stored-preparation action, not a pipeline stage and not an automatic discovery /
tailoring side effect. The workflow runs the standard spend-budget preflight,
loads the job, career evidence-map projections, requirement-fit rows, and the
latest accepted materials, then persists generation-versioned
`job_interview_prep` / `job_interview_prep_items` rows. Failed generations are
durable audit history and do not supersede the last accepted prep. The method
does not expose live, in-session, transcript, microphone, streaming, or
real-time interview assistance surfaces.

The minimum fit score is a live eligibility threshold, not a scoring policy
version. Lowering it can make existing persisted scores eligible for
`tailor_resume`; raising it can make active artifacts ineligible and enqueue
`suppress_tailored_artifacts`. Neither threshold path invokes the scoring LLM.

## Discovery target search

Discover honors the profile Target search saved from the Discovery page.
Target roles replace the active discovery query list with exact role queries;
target tracks, seniority floors, role areas, and specializations add structured
intent for deterministic recall expansion. The Discovery UI constrains target
tracks to IC, management, and executive, and constrains seniority floors to the
engineering IC, management, and executive ladder choices. Recall queries keep
the same search tier as exact queries because relevance is determined after
discovery by scoring, not by query generation. Recall matching enforces both
track and seniority: IC targets stay IC, management targets stay management,
executive targets stay executive, and a candidate who configures multiple
tracks gets per-track recall. Board discovery settings live in SQLite
`discovery_settings`; source adapters normalize scraped postings into the
shared discovery intake and apply query/location acceptance before a job row or
delete tombstone can be persisted. JobSpy uses
exact-plus-recall queries as broad-board retrieval probes. Direct ATS and
Workday, and source-first Smart Extract sources enumerate
their known board/source and apply that same title intent internally, avoiding
repeated board fetches for each role variant. Smart Extract search-only sources
still fan out by query when the source has no useful browse/all-jobs page.
Canonical ATS rows must also include a usable description before they are
inserted; Greenhouse reads the public board content payload for that text. Each
discover run also performs posting staleness checks that move verified
unavailable, expired, removed, or location-incompatible postings to the closed
lifecycle state, and applies the current title, location, and description
contract to active JobSpy, direct ATS, Workday, and Smart Extract rows so rows
that no longer pass those source-family filters are soft-deleted.
Approved role-match feedback adds a user-reviewed title-exclusion layer on top
of that matcher. The rule scope is exact normalized title text, so approving a
bad low-score pattern suppresses repeat false positives without weakening the
broader exact-plus-recall role family.
Target locations replace the active location list, and the
worker falls back to profile city/country when target locations are blank. The
API validates target locations as real places before saving profile preferences.
Hybrid and on-site target work models search and filter only the target
location. Remote target work models search and filter the target country, and
European countries also add an Europe-remote search and accept pattern.
Profile-driven discovery searches at least the last 30 days unless local config
sets a larger window. Spain or Europe targets set JobSpy's Indeed country to
Spain, reject America-only non-remote locations, and filter API-visible
America-only source rows from `GET /v1/discovery/sources`. Discover limits are
new-job budgets: duplicate/rediscovered observations do not consume the cap.
The Pipelines tab uses the same source registry response to offer an optional
source selector for manual Discover runs; leaving it blank keeps the existing
all-runnable-source behavior.

## Worker runtime and health

The JSON-RPC worker is launched with the API runtime `appDir` as
`JOBCTRL_DIR`, so API reads, SSE, and Python automation all use the same
local SQLite database. The API also passes `expectedAppDir` and
`expectedDbPath` into worker-started workflows. Worker activities verify those
runtime values before writing, and fail non-retryably if the Python worker
is connected to a different local app directory or SQLite database. The worker
writes `worker_runtime_heartbeats` into the same database; `GET /v1/health`
returns the API app/database identity plus the latest Python worker
heartbeat status (`healthy`, `missing`, `stale` after 45 s, or `mismatched`
when the worker points at a different app dir/database) and an `llmSpend`
block (`status: ok | over_budget`, today's `estimatedUsd`, and the configured
`dailyBudgetUsd` — default `25`, `0` = unlimited) read from the local
`llm_spend` metering table, plus worker startup concurrency metadata
(`maxConcurrentActivities`, `activityExecutorMaxWorkers`). The web topbar
surfaces missing or stale worker heartbeats, the Settings page surfaces the
worker activity-slot configuration, and the pipeline stage trigger blocks new
worker-backed actions until the worker is healthy. Server-side, worker-backed action routes are
gated by the same check and return
`503 { ok: false, error: "worker_runtime_unavailable", worker }` while the
heartbeat is missing, stale, or mismatched. Action routes share dispatch
semantics: a queued Temporal workflow start returns `202` with the workflow
ID, while synchronous local results return `200`.
Non-apply pipeline runs also emit pipeline-level
`StageStarted` / `StageCompleted` / `StageFailed` rows, and Discover emits
the same lifecycle rows plus `DiscoveryRunStarted`,
`DiscoveryRunCompleted`, and `DiscoveryRunFailed` for its JobSpy, Workday, and
Smart Extract source steps. Those event types are part of the SSE domain
catalog, so the dashboard can refresh recent activity and source health while a
long synchronous stage request is still running.

Every Temporal workflow additionally emits a `Workflow*` lifecycle event
(`WorkflowStarted` at the top; `WorkflowCompleted` / `WorkflowFailed` on exit),
recorded by a finalize activity and folded into `workflow_run_projections`. A
describe-based reconciler in the worker heartbeat loop (15s) terminalizes any
open run whose Temporal execution has closed or vanished (dev-server restart →
`WorkflowTerminated`), so a killed or timed-out worker's runs terminalize on
their own without a reaper. The `Workflow*` types are in the SSE catalog, so the
`/runs` view refreshes as runs start and terminalize.

The JSON-RPC transport is hang-hardened end to end: the Python `jobctrl rpc`
server dispatches each request on a bounded thread pool (responses serialized
under a stdout lock and correlated by JSON-RPC `id`), so a slow or hung handler
no longer head-of-line-blocks `cancel_run` or other fast calls; the TS
subprocess adapter applies a per-request timeout so a dead handler rejects
instead of hanging forever; and the api-client wraps every fetch in an
`AbortController` timeout so a stuck request fails cleanly rather than freezing
the browser tab. (`POST /v1/_internal/rpc` is a separate internal seam that
validates a JSON-RPC 2.0 envelope and acknowledges it with
`{status: "accepted"}` without dispatching anything; malformed envelopes get
a JSON-RPC error response.)

`GET /v1/dashboard/summary` includes a bounded recent `activity[]` slice with
`activity[].eventType` so the web app can render started, completed, and failed
stage states from backend events instead of local button state alone. The
top-level Debug tab uses `GET /v1/debug/activity` for the full activity log as a
paginated, sortable table; this keeps Dashboard lightweight without imposing an
event-history cap.

## Settings And Credentials

- `GET /v1/settings` returns the runtime settings stored in the local
  settings file (`dashboard.json` under the app dir): apply approval gate,
  apply concurrency, discovery scheduling, LLM spend budget, and related
  preferences. `PATCH /v1/settings` updates them; the web Preferences and
  Settings forms use these routes.
- `GET /v1/credentials` lists the supported provider credential keys
  (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `LLM_URL`) with a label, storage kind,
  and a `configured` presence flag only — values are never returned.
  `PATCH /v1/credentials` stores a value in the macOS Keychain
  (service `JobCtrl`) and `DELETE /v1/credentials/:key` removes it; unknown
  keys return `400 invalid_credential_key`.
- `GET /v1/extension/pairing-token` returns the local browser-extension
  capability token for the Settings pairing surface; `POST
  /v1/extension/pairing-token/rotate` replaces it. The token is generated under
  the app dir (`~/.jobctrl/extension-capability-token` by default) with
  restrictive file permissions. These pairing routes are for CLI callers and
  same-origin Settings requests only; arbitrary loopback web origins and
  extension-origin CORS cannot mint or rotate the token.
- Authenticated extension routes under `/v1/extension/*` require `Authorization:
  Bearer <token>`. A valid token allows a `chrome-extension://` origin through
  the route-scoped CORS and unsafe-mutation guards, but only after the loopback
  `Host` check has passed.
- `POST /v1/extension/captures` is the Phase 1 browser-extension capture
  endpoint. It accepts the manual-capture import fields plus `originatingUrl`,
  an optional stable `captureId` retry id, `captureClient:
  "browser_extension"`, and `extensionVersion`, seeds a pending
  `manual_capture_queue` row with reason `browser_extension_capture` and source
  `manual_capture:extension`, then delegates to the existing manual-capture
  worker importer. Re-sending the same `captureId` while import is still pending
  updates the same queue row instead of creating a duplicate; replays of an
  imported row return the original `ManualCaptureImportResponse`; replays of a
  dismissed row return a terminal 2xx no-op so the extension can clear local
  retry state without reopening the dismissed capture.
- `GET /v1/extension/autofill/profile` returns the deterministic autofill
  field list for the extension. The response includes `profileVersion` and
  whitelisted `fields[]` with `path`, `label`, `value`, and profile source
  metadata. It intentionally excludes profile password, resume content,
  generated materials, and free-text answer drafts.

## Related Packages

- `apps/api`: Fastify API app.
- `apps/web`: the React/Vite web app.
- `packages/contracts`: shared schemas, DTOs, enums, JSON-RPC envelopes, and
  re-exported `@jobctrl/domain-types`.
- `packages/domain-types`: pure TypeScript mirror of the Python domain model.
- `packages/api-client`: typed API client.
- `apps/extension`: Manifest V3 local capture extension.

The dependency direction is:

```text
apps/api -> packages/contracts -> packages/domain-types
apps/api -> packages/domain-types
apps/web -> packages/api-client -> packages/contracts
```

The API must not depend on `packages/api-client` at runtime (it appears only
as a devDependency of `apps/api` for API tests).

## Commands

```bash
pnpm api:dev
pnpm api:check
pnpm api:test
pnpm qa:test
pnpm web:dev
pnpm web:build
pnpm extension:check
pnpm extension:e2e
```

The API defaults to `http://127.0.0.1:8766`. The web app proxies `/v1/*` to
that origin unless `VITE_JOBCTRL_API_BASE_URL` is set. The Vite dev-server
proxy target itself is controlled by `VITE_DEV_API_PROXY_TARGET` (default
`http://127.0.0.1:8766`); isolated or multi-worktree stacks override it to
point the proxy at a non-default API port.

## Server-Sent Events — `GET /v1/events/stream`

The API exposes a Server-Sent Events endpoint that the frontend's
`SseEventStreamAdapter` (`apps/web/src/shared/adapters/local/`) consumes via
the browser's native `EventSource`. Per
[`docs/architecture/frontend/realtime.md`](architecture/frontend/realtime.md) §7.1, this endpoint is the
single realtime channel from the worker / API write-side to the frontend's
TanStack Query cache; the frontend's `InvalidationRouter` translates each
`DomainEvent` into the right `invalidateQueries` / `setQueryData` calls.

### Request

```
GET /v1/events/stream?tenantId=<tenantId>&since=<lastEventId>
Accept: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
Last-Event-ID: <lastEventId>      # set by EventSource auto-reconnect
```

`tenantId` is recommended; in local mode (`apps/api/src/event-stream.ts`
`resolveTenantId`) it defaults to `LOCAL_TENANT` and any non-`LOCAL_TENANT`
value is silently overridden to `LOCAL_TENANT`. In hosted mode (named-not-built),
the server resolves `tenantId` from the JWT, the JWT-derived tenant is
canonical, and a mismatched query-string value returns `403 Forbidden`.

`since` is optional and is used only by the planned IndexedDB warm-start path
(`docs/architecture/frontend/integration.md` §9.7) to resume from a persisted watermark on
first connect; the browser's native `EventSource` auto-reconnect uses the
`Last-Event-ID` header instead.

### Response framing

The header block below is abbreviated; the live response also carries
`charset=utf-8` on the Content-Type, `Cache-Control: no-cache, no-transform`,
`Connection: keep-alive`, and CORS headers.

```
HTTP/1.1 200 OK
Content-Type: text/event-stream
X-Accel-Buffering: no

retry: 5000

id: 12345
event: JobScored
data: {"tenantId":"local","jobId":"job-...","fitScore":8,"version":1,"scoredAt":"..."}

id: 12346
event: ResumeApproved
data: {"tenantId":"local","jobId":"job-...","artifactId":"...","generation":2,"approvedAt":"..."}

: keepalive

event: heartbeat
data: {"watermark":12346}
```

Each frame:

- `id: <event_id>` — the row's `event_id` from `job_events`. The browser
  echoes this as `Last-Event-ID` on auto-reconnect.
- `event: <event_type>` — the discriminator from the `DomainEvent` Zod
  schema (e.g., `JobScored`, `ResumeApproved`, `ApplyRunStarted`).
- `data: <payload_json>` — the payload, ready for `JSON.parse`.

### Tenant filtering (COALESCE on the row, not the request)

The server filters `job_events` with the COALESCE on the _event row's_
extracted tenant — falling back to the literal `'local'` string when the
row's `payload_json` lacks a `$.tenantId` key:

```sql
SELECT event_id, event_type, payload_json, occurred_at
FROM job_events
WHERE event_id > ?
  AND COALESCE(JSON_EXTRACT(payload_json, '$.tenantId'), 'local') = ?
ORDER BY event_id ASC
LIMIT ?
```

The right-hand `?` is the resolved request `tenantId` (per `resolveTenantId`
above — `LOCAL_TENANT` in local mode; JWT-derived in hosted). The COALESCE
guarantees that tenantless local rows still match the local-mode filter without
a write-side backfill.

Tenant scope is mandatory; there is no "all tenants" mode
(`docs/architecture/frontend/realtime.md` §7.8).

### Resume-position precedence

1. `Last-Event-ID` HTTP header (preferred — populated by `EventSource`
   auto-reconnect).
2. `?since=<lastEventId>` query string (fallback for IndexedDB warm-start).
3. `MAX(event_id)` on `job_events` for the resolved `tenantId` (default if
   neither is supplied — first connect streams from the current tail with
   no backfill).

If both header and query are present, `Last-Event-ID` wins.

### Cadences

- **`retry: 5000`** — 5 s reconnect baseline (the browser respects this;
  no application code).
- **`: keepalive`** — comment line every 15 s, keeps reverse proxies and
  CDNs from idling the connection out.
- **`event: heartbeat` with `data: {"watermark":<event_id>}`** — every
  30 s, so the client can verify liveness even when no domain events
  fire. The frontend's AppShell renders a "connection lost" banner if
  no heartbeat or domain event arrives for 30 s.

### Reconnect backstop

On reconnect after a "closed" status of more than 30 s, the frontend's
`EventStreamProvider` fires a one-shot `queryClient.invalidateQueries()`
to recover from any events lost during the gap. `Last-Event-ID` covers the
common case; the full invalidation is a backstop.
