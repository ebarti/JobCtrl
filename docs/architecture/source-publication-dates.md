# Source publication dates

JobCtrl records when it observes a posting; those clocks do not establish when
the employer published it. This page investigates the existing boundaries and
proposes optional publication evidence for [issue #1022](https://github.com/ebarti/JobCtrl/issues/1022).
It implements no production feature and does not resolve the issue as shipped.

**Read this if** you need to distinguish posting age from local discovery time,
or plan publication-date extraction, persistence and presentation.

## Current implementation

The inspected baseline is `315aa323848bbd8da2ed95bccbb47f0fe685d27f`.
The following claims come from code inspection unless the
[Synthetic evidence](#synthetic-evidence) section identifies an executed probe.
Source links below pin that baseline, rather than an evolving branch.

The audit invariant is that a displayed publication claim must trace to the
posting's own evidence, including its meaning and precision. An observation
clock cannot supply missing publication evidence. This follows the
[Auditability Checks](../developer/qa/regression-catalog.md#auditability-checks):
trace source input through extraction, persistence, projections and rendering;
preserve accepted evidence on failed refreshes. This investigation neither
renames nor hides the existing Discovered column.

### Acquisition and handoff owners

| Boundary | Canonical source and symbols | Inspected behavior |
| --- | --- | --- |
| Application tracking system (ATS) listing adapters | [ats_adapters.py][ats]: `WorkdayBoardAdapter._to_scraped`, `GreenhouseBoardAdapter._to_scraped`, `LeverBoardAdapter._to_scraped`, `AshbyBoardAdapter._to_scraped` | Each constructs `ScrapedJobPosting` with identity, employer and four metadata strings. None transfers a publication field. Workday's constructor reads title/path/location; the other three also require usable description text. An extra date-bearing payload key does not create date evidence. |
| Broad-board provider acquisition | [jobstreaming_gateway.py][gateway]: `JobStreamingGateway.frame_for_job_event`, `collect`, `build_request` | Delegates provider formatting to `jobs_to_dataframe`; the event path adds `jobstreaming_job_key`. `hours_old` is an acquisition filter passed to the provider, not a persisted publication claim. Provider formatting and live date coverage were not executed here. |
| Provider row to domain intake | [discovery/jobspy.py][jobspy]: `store_jobspy_results`, `_jobspy_posting_from_row`, `_record_jobspy_source_observation` | Maps selected row facts into date-free intake, and separately records an observation. `store_jobspy_results` obtains a UTC `now`; `_record_jobspy_source_observation` uses its caller's `observed_at`. There is no date argument in `_jobspy_posting_from_row`. |
| SmartExtract intelligence and extraction | [smartextract.py][smart]: `collect_live_page_intelligence`, `execute_json_ld`, `execute_api_response` | Intelligence can retain parsed JSON-LD and intercepted data. The two executors enumerate only `title`, `company`, `salary`, `description`, `location`, `url`, even if the plan contains another key. `execute_json_ld` accepts only top-level `@type == "JobPosting"`; it does not walk `@graph`. This is distinct from the enrichment extractor below. |
| Intake and metadata | [ports/discovery.py][port]: `ScrapedJobPosting`; [discovery/value_objects.py][metadata]: `JobMetadata` | The intake has no publication-date slot. Metadata contains title, salary, discovery description and location. An unknown constructor keyword is rejected, rather than stored as evidence. |
| Canonical Job and observations | [discovery/aggregate.py][job]: `Job.discover`, `with_metadata`, `to_dict`; [discovery/identity.py][identity]: `JobSourceObservation` | Job stores `discovered_at`. Observation stores source identity, URL, run and `observed_at`. Timestamp checks here require nonempty strings, not ISO parsing. Neither object stores publication evidence. |
| Discovery write boundary | [discovery/use_cases.py][discovery-use-cases]: `DiscoverJobsUseCase._ingest_one`, `_create_new_job`, `_observe_existing_job` | The injected/default clock produces `observed_at`; a new Job receives that same value as `discovered_at`. Existing-owner observations follow a separate path. Canonical identity and duplicate decisions do not infer publication time. |

Dates such as synthetic `postedOn`, `date_posted`, `createdAt`, `updated_at`
or `publishedAt` must not be treated as interchangeable. Their names alone
do not certify their semantics or their availability on any live source.
Only Workday's synthetic `postedOn` mapping was executed here; inspection of
the other adapter mappings does not establish vendor payload reliability.

### Enrichment, persistence and presentation owners

| Boundary | Canonical source and symbols | Inspected behavior |
| --- | --- | --- |
| Detail-page payload and fetch clock | [enrichment/value_objects.py][detail-page]: `DetailPage`; [playwright_fetcher.py][fetcher]: `PlaywrightDetailPageFetcher.fetch` | `DetailPage` carries parsed `json_ld` and `fetched_at`. The fetcher obtains UTC time locally before acquisition. Carrying a `datePosted` key inside JSON-LD is not equivalent to extracting or accepting it. |
| Description extraction | [enrichment/services.py][extractors]: `JsonLdExtractor.extract`, `_find_job_posting`, `ExtractionResult` | JSON-LD enrichment walks lists and `@graph`, extracts a sufficiently long description and best-effort application URL. `ExtractionResult` has only `ok`, description and application URL. No normalized publication result is produced. |
| Availability and content acquisition | [snapshot_services.py][acquisition]: `ActiveStateVerifier.verify`, `ContentAcquisitionService.acquire` | `validThrough` is deadline evidence for availability: invalid deadlines produce unknown, contradictory availability signals can produce unknown, and elapsed deadlines can produce expired. It is not a publication date. Acquisition returns description/hash, apply URL, availability, confidence and capture evidence, or structured failure. |
| Snapshot clock and failure history | [snapshot_value_objects.py][snapshot-values]: `PostingContentSnapshot`; [snapshot_set.py][snapshot-set]: `PostingSnapshotSet.record_snapshot`, `record_capture_failure`; [snapshot_use_case.py][snapshot-use-case]: `CapturePostingSnapshotUseCase.execute` | Snapshot stores `captured_at`. The use case passes local `_utc_now()` after acquisition. Capture failure appends failure history without appending a replacement snapshot. No publication evidence value object is present. Preservation is inspected, not executed through this use case here. |
| Discovery persistence | [discovery/sqlite_repository.py][job-repository]: `SqliteJobRepository._update_existing_job`, `_attach_source_observation`, `_find_observation_owner` | Existing nonempty `discovered_at` is preserved when metadata changes. Source observations replace their current `observed_at` for the matching source/native identity or normalized URL; a different owner is returned instead of re-homing the observation. This current-row replacement is not immutable publication-evidence history. |
| Enrichment persistence | [enrichment/sqlite_repository.py][enrichment-repository]: `SqlitePostingSnapshotSetRepository.save`, `load`, `_snapshot_from_dict` | Stores the snapshot-set JSON and summary columns; rehydrates `captured_at` from each snapshot. There is no dedicated normalized publication contract. |
| Python projection | [projection_builder.py][python-projection]: `ProjectionBuilder._rebuild_job` | Copies canonical Job `discovered_at` into `JobListProjection.discovered_at`. A projection rebuild's own `last_updated_at` is another local clock. |
| TypeScript projection | [projections.ts][ts-projection]: `rebuildJobProjections` | Writes `nullableString(job.discovered_at)` to `job_list_projections.discovered_at`; it does not compute publication time. |
| API and shared contract | [read-model.ts][read-model]: `rowToJobSummary`, `SQL_JOB_SORT_COLUMNS`; [schemas.ts][contracts]: `JobSummary`, `JOB_SORT_FIELDS` | Maps the projection clock to nullable `discoveredAt`; existing sorting uses `discovered_at`. `JobSummary` declares `discoveredAt`, with no publication evidence field. |
| Jobs date column | [columns.tsx][columns]: `jobColumns` | The `discovered_at` column is labeled **Discovered** and renders `RelativeTime` using `row.discoveredAt`. Relative presentation describes local discovery age, not employer posting age. |

The [data/event/projection distinction](data-events-and-projections.md) and
[storage authority](storage.md) remain the current owners of those broader
contracts. A new projection field alone would not establish canonical evidence.

### Observation clocks are not publication clocks

| Existing clock | Meaning at its owning boundary | What it cannot prove |
| --- | --- | --- |
| `fetched_at` | Local detail-fetch attempt time carried by `DetailPage`; may be empty on constructed payloads. | Publication time, or even successful extraction. |
| `discovered_at` | Local first accepted discovery time on Job; repository refresh preserves a prior nonempty value. | Employer publication, source creation or repost time. |
| `observed_at` | Time supplied for a source observation; repeated observations replace the current row's clock. | Immutable first publication or a complete observation history. |
| `captured_at` | Local accepted content-snapshot capture time; snapshot versions retain their own clocks. | A date asserted by the employer within that content. |

## Synthetic evidence

These measurements ran on 2026-10-06 in the dedicated owned checkout, against
the baseline above. Inputs used `example.com`, a synthetic employer and a
synthetic UUID. No external transport, personal workspace, account, profile or
application was used. SQLite probes used only disposable in-memory tables.

### Method and retained records

The host's default `python3` was Python 3.9.6: an initial import stopped at a
union-type expression in `domain/pipeline_types.py`, before intake construction.
The subsequent probe used the installed CPython 3.14.7 interpreter. That native
import succeeded for Discovery domain objects but not the ATS or enrichment
modules. It was **not** the locked worker environment.

To obtain bounded additional measurements without preparing dependencies,
`probe.py` compiled unchanged selected function/class definitions from the
frozen files using Python's abstract syntax tree. It recorded source SHA-256
hashes and used the real domain value objects and unchanged location/title
filters. Workday's HTTP callable returned a synthetic payload; its tracing
context alone was replaced by a no-op context. No HTML cleaner, date parser,
provider formatter or evidence result was substituted. This bypasses module
imports and proves only the selected bodies under the specified inputs.

The first two source-isolated harness attempts stopped with `NameError` for
missing harness bindings `dataclass` and `Employer`. Both failed transcripts
were retained as `probe-attempt-1.log` and `probe-attempt-2.log`. After correcting
the temporary harness, the final transcript `probe.log` ended with
`ALL_EXECUTED_ASSERTIONS_PASSED_INCLUDING_SQLITE`. Those harness failures are
neither product extraction failures nor locked-environment failures.

The harness, transcripts, `initial-python.log`, `scripts.junit.xml`,
`scripts-junit-summary.json`, `scripts-failure-diagnostic.log`,
`focused-python.log`, `docs-build.log`, `docs-build-candidate.log` and
`docs-runtime.log` are retained outside source control in this role's owned
evidence staging directory. The controller
report destination was not supplied to this role; transfer to controller-owned
artifact paths is pending. No controller-owned report or rendered-page evidence
is claimed here. The implementation handoff identifies the staging location.

### Actual outcomes

| Probe | Observed result | Limit or interpretation |
| --- | --- | --- |
| Native intake constructor | `ScrapedJobPosting` constructed successfully with its nine declared fields. | Constructor proof only; no acquisition or persistence. |
| Additional intake `published_at="2026-10-01"` | Expected `TypeError`: unexpected keyword argument `published_at`. | Demonstrates the present boundary lacks the field; does not test a future contract. |
| Native ATS module import | `ModuleNotFoundError: No module named 'bs4'`. | Environment failure before adapter execution; no conclusion about live ATS reliability. |
| Native enrichment services import | `ModuleNotFoundError: No module named 'temporalio'`. | Failure through package imports before `JsonLdExtractor.extract`; no description-extractor measurement. |
| Isolated `WorkdayBoardAdapter.scrape`, `postedOn="Posted 3 Days Ago"` | One injected HTTP call; one posting; no `postedOn` or publication field in output. | Measures listing acquisition and handoff through unchanged Workday bodies, with import/tracing integration bypassed. No relative-date parsing occurred. |
| Same Workday payload with date missing or `postedOn="not-a-date"` | Each made one HTTP call and returned the same date-free posting shape. | An ignored malformed date is not a successful validation or normalization. |
| Workday payload with missing title | One HTTP call; zero postings. | Actual rejection by the current title/path admission check, independent of date content. |
| Isolated `_jobspy_posting_from_row` with selected facts from a row also carrying `date_posted="2026-10-01"` | Intake constructed; output has no `date_posted`. | Demonstrates the selected-fact handoff only. Provider stream, formatter, DataFrame filtering and full `store_jobspy_results` were not run. |
| Isolated `execute_json_ld`, top-level JobPosting containing `datePosted="2026-10-01"` and `validThrough="2099-01-01"` | One six-key job dictionary; both dates absent, even with plan mapping `date_posted` to `datePosted`. | Measures SmartExtract's executor, not intelligence collection, enrichment, provider acquisition or availability. |
| Same executor with missing date or malformed object-valued `datePosted` | Each returned one six-key job dictionary without dates. | No date validation occurs on this ignored field. |
| Same executor with `@graph` wrapper, or entries `[null, "bad", {}]` | Zero jobs in each case. | Current SmartExtract executor limitation; does not contradict enrichment's separate recursive `_find_job_posting`. |
| Same executor with missing `extraction` plan key | Expected `KeyError: 'extraction'`. | Malformed-plan failure, not a transport error or live-source measurement. |
| Native `Job.with_metadata` | Changed title while preserving `discovered_at="2026-10-06T10:00:00+00:00"`. | Pure aggregate behavior; the following SQL probe measures a separate write boundary. |
| Isolated `SqliteJobRepository._update_existing_job` | A supplied newer discovery time, `2026-10-07T10:00:00+00:00`, did not replace the stored October 6 time. | Executed unchanged SQL against minimal in-memory `jobs` columns, not exact-v12 database admission or full `save`/`load`. |
| Isolated `_attach_source_observation` and `_find_observation_owner` | October 6 then October 7 observations left one row with October 7 `observed_at`; a third `not-a-date` value also replaced it. | Executed unchanged SQL on minimal in-memory observation columns; no public commit wrapper, events, concurrency, fences, uniqueness constraints or migration proof. |
| Native `JobSourceObservation` validation | Nonempty `observed_at="not-a-date"` accepted; empty string rejected with `ValueError`. | Current nonempty-string invariant, not ISO validity. Malformed synthetic clocks were never written to production state. |

Measured gaps are loss of date-bearing input at selected handoffs, narrow
SmartExtract JSON-LD traversal and permissive nonempty observation-clock
validation. The proposal below addresses publication evidence; hardening the
existing observation validators would require separately scoped compatibility
work. This document does not repair any production gap.

### Verification results and remaining gates

Checks followed [local reliability QA](../local-reliability-qa.md) and the
tracked recipes in [scripts/checks.toml][checks]. A failed command is recorded
as a failed attempt; it is not described as a passed gate or replaced by an
unexecuted command.

| Check actually attempted | Actual evidence | Pending completion |
| --- | --- | --- |
| `checks.scripts`, exact tracked shell argv, staging path substituted for `{report_path}` | Exit 1; retained XML parses and contains 86 testcase records: 81 passing, 5 failing, 0 error elements, 0 skips. Four failing records are test-file load failures, not executed test bodies. | Frozen dependencies and controller-owned JUnit rerun. The brace-expansion test could not load the installed module; a diagnostic rerun of the four distribution files confirmed missing `ajv` before their tests loaded. No scripts source repair is authorized. |
| Focused locked worker invocation for the six accepted tracked test paths | `uv --project workers/automation run --locked --all-extras pytest -q -m 'not system_browser'` with those explicit paths, JUnit target and owned `--basetemp`; `UV_NO_SYNC=1` and `UV_PYTHON_DOWNLOADS=never` prevented role-owned dependency/interpreter preparation. Exit 2: could not spawn `pytest`. Zero tests executed, no JUnit emitted. | Controller preparation, then all six files with real retained JUnit: `test_ats_adapters.py`, `test_jobstreaming_gateway.py`, `test_enrichment_extractors.py`, `test_job_repository.py`, `test_job_list_projection.py`, `test_enrichment_snapshot_pr3.py`, under `workers/automation/tests/`. |
| `checks.docs`: `corepack pnpm docs:build` | Exit 1. Install-asset comparison passed; build stopped at `vitepress: command not found`, with missing `node_modules`. | Complete build, emitted link/redirect checks and `architecture/source-publication-dates.html`. No emitted new-page artifact was observed. |
| `corepack pnpm docs:check:runtime` after attempted build | Exit 1: missing `@playwright/test`, before preview/browser startup. | Run after a successful build. Its fixed page list excludes this page; separately inspect the new route on a fresh owned preview and retain browser/rendered headings, evidence tables and source links. |
| `checks.diff`: `git diff --check origin/main...HEAD`; pending-change whitespace and scope checks | Committed diff and `git diff --check` exited 0. `git diff --no-index --check /dev/null docs/architecture/source-publication-dates.md` emitted no whitespace diagnostics and exited 1 because the new page differs from the empty input. Direct trailing-whitespace inspection also passed. `git status --short --untracked-files=all` showed only the allowed page; tracked source diff was empty. Required headings, issue link, 25 pinned source files and local file links passed direct inspection. | Committed exact-head diff and final controller checks. The baseline committed diff does not include this uncommitted new page. Static link inspection does not establish rendered site links or browser behavior. |

Missing dependencies do not prove a network restriction or an implementation
defect. They leave required verification incomplete. The controller owns frozen
dependency preparation and the mandatory prepublication/final checks; this
checkpoint cannot satisfy those gates.

Unmeasured boundaries include Greenhouse/Lever/Ashby execution, JobStreaming
event/date formatting, native enrichment JSON-LD/CSS/LLM extraction, real
detail fetching, availability deadline handling, full canonical database
round trips, refresh use cases, both projection runtimes, API and browser
behavior, timezones, live source field semantics and reliability. Independent
review and QA, browser/API QA, exact-head required CI, tracker/assignee readback,
claim release, publication and owned cleanup remain controller gates. The
controller's one PR must remain open and unmerged; this design must not close
#1022 as an implemented feature.

## Future architecture, not implemented

Everything in this section is proposed, including field names, enums,
normalization, selection policies, persistence and acceptance scenarios.
Routine choices below are design assumptions to verify in follow-up work,
not new guarantees for current installations.

### Compatible, optional evidence contract

Keep `fetched_at`, `discovered_at`, `observed_at` and `captured_at` unchanged in
meaning and retain existing sorting, filtering and the Discovered column.
Add a nullable publication summary and independent source evidence; do not
backfill unknown publication time from a local clock. Old callers can omit
the new fields, and old records remain unknown. Merely extracting a date must
not change canonical Job identity, source attribution, application authority,
availability, scoring or automation approval.

Proposed canonical `PublicationDateEvidence` belongs to an identified Job
and source observation or content snapshot. It retains the following bounded
fields; the names are illustrative, not an existing Python or API schema.

| Proposed field | Proposed contract |
| --- | --- |
| `evidenceId`, `tenantId`, `jobId` | Stable evidence reference and canonical owner. Never identify a Job solely by URL. |
| `sourceId`, `sourceNativeId`, `sourceUrl`, `finalUrl` | Source registry/native identity and actual observed posting locator; retain redirect provenance separately from identity. |
| `observationId`, `runId`, `snapshotVersion`, `observedAt` | Bind to the specific acquisition, run or snapshot. `observedAt` is the anchor at which the raw claim was read, not the claimed publication value. Where no snapshot exists, retain the observation/run binding. |
| `rawValue`, `rawType`, `fieldLocation` | Original bounded JSON scalar or raw visible text and exact JSON pointer, JSON-LD node path, HTML selector/attribute or text span. Keep an evidence/hash reference for larger captures, not an entire provider payload. |
| `semanticKind`, `semanticBasis` | `publication`, `creation`, `modification`, `expiry`, `relative_age` or `unknown`; name the source adapter's versioned field mapping or explicit page label supporting that interpretation. Relative age additionally identifies whether it refers to publication. |
| `normalizedDate`, `normalizedInstant`, `intervalStart`, `intervalEnd` | Nullable alternatives: calendar date, offset-aware UTC instant, or approximate interval. Never manufacture an instant for a date-only value. Invalid, unbound or unknown evidence has no accepted normalized value. |
| `precision`, `timezone`, `timezoneBasis` | `date`, `minute`, `second`, `approximate_interval` or `unknown`; preserve source precision. Record explicit offset or documented source zone; otherwise zone is unknown. |
| `validationStatus`, `reason` | Valid, missing, invalid, future, ambiguous, unbound or unsupported, with a bounded actionable reason. A successful HTTP response alone is not valid evidence. |
| `extractorVersion`, `normalizerVersion`, `captureHash` | Reproducible normalization and a reference to the acquisition content. Allow reviewers to follow the selected value back to its exact raw fact. |

The proposed optional TypeScript/API `publicationDate` summary would expose
nullable value, precision, status (`accepted`, `unknown`, `conflicted`), selected
evidence references and refresh state. Absent evidence reads as unknown, with
no invented date. A separate inspectable `lastAccepted` reference preserves
the prior selection when a conflict prevents selecting a current value.
Refresh attempt/success clocks are named as clocks and cannot become the
summary's value. The proposed wire representation must match Python canonical
state and both projection builders before presentation uses it.

### Semantics, precision and normalization

Publication means a source explicitly asserts posting publication. An adapter
may map JSON-LD `datePosted` to publication only when the JobPosting node is
bound to the identified posting. An employer ATS field can qualify only after
its semantics are established. `createdAt` is creation unless the source
contract proves publication equivalence; `updated_at`/`dateModified` is
modification; `validThrough` is expiry. None is an automatic publication
fallback. A date embedded in an unrelated JobPosting node is unbound evidence.

Proposed normalization rules:

- Retain ISO date-only values as dates with date precision. Do not append
  midnight, choose the user's timezone or pretend the date is a UTC instant.
- Preserve an explicit offset and normalize a genuine datetime to UTC, keeping
  its original precision and raw value. Fractional seconds must not imply
  precision the source did not supply.
- Interpret naive datetimes only with a documented source timezone. Without
  one, keep the raw local value as ambiguous evidence and no selected instant.
  Ambiguous or nonexistent daylight-saving times remain ambiguous unless the
  source supplies a resolving offset. Do not use the host's timezone.
- Reject impossible calendar values and unsupported units/formats without
  guessing. Missing dates are unknown; malformed values are invalid evidence.
  Keep a bounded reason and raw reference so the distinction is auditable.
- A relative label such as “Posted 3 days ago” is approximate publication
  evidence only under a validated source rounding/unit convention. For an
  assumed floor-of-elapsed-24-hour-days convention, at observation time `T`
  it means `(T - 4 days, T - 3 days]`, not a precise timestamp. Retain `T`,
  timezone/unit convention and the original label. Calendar-day labels require
  source-zone day boundaries instead. Unconfirmed semantics stay unknown.
- Store future values as flagged evidence, not accepted publication facts.
  A proposed timestamp tolerance of five minutes handles acquisition clock
  skew; larger positive differences are future. For date precision, a later
  source-local calendar day is future only when that source zone is known;
  otherwise future assessment is ambiguous. The tolerance itself requires
  follow-up tests and must be versioned. Never silently clamp a date to now.

For example, a synthetic offset datetime `2026-10-01T09:30:00+02:00` would
normalize to `2026-10-01T07:30:00Z`; a raw `2026-10-01` would remain that
calendar date. These are future expected results, not measurements above.

### Provenance, conflicts and refreshes

Persist per-source evidence before choosing a canonical summary. A proposed
deterministic selection ranks validated employer publication assertions above
syndicated publication assertions, and explicit publication facts above
approximate relative age within the same authority. Authority requires source
identity and a semantic mapping, not just a field name or an ATS-looking URL.
Creation, modification and expiry remain independently inspectable and cannot
win a publication selection. Record the selected evidence IDs and policy
version so another runtime can reproduce the decision.

Normalize candidates according to their own precision. An instant within a
known-zone calendar date or overlapping approximate intervals is compatible;
do not claim that compatibility proves equal precision. Disjoint equally
authoritative publication assertions produce a conflicted summary with null
current value and all competing evidence retained. Higher-authority selection
may resolve lower-authority disagreement, but must disclose the disagreement.
Where unknown timezone prevents comparison, retain ambiguity rather than
declaring agreement. Do not blindly choose minimum, maximum or latest fetch.

Re-observing a source must not rewrite its older date evidence in place.
Append evidence bound to the observation/snapshot; an identical raw claim can
reuse a content reference while retaining acquisition lineage. Duplicate-source
merges keep the distinct source assertions and reversible identity decisions.
A newly reported later date is not proof of a repost: preserve earlier evidence
and require a source posting-version/native-identity signal or review to label
a new publication episode. Do not reset first discovery or infer a new Job
from date changes alone.

A failed fetch, missing/invalid extraction, or rejected normalization must
retain the last accepted publication value, precision and evidence references.
Record attempt time, error/missing reason and freshness separately. A successful
fetch with no new usable date is not proof that an earlier assertion was false:
keep the accepted claim with `no_new_evidence` disclosure. With no prior accepted
claim the summary stays unknown. A newly validated contradictory claim follows
the conflict policy and keeps `lastAccepted` inspectable; a deliberate correction
or retraction must be an explicit auditable decision. No failure may overwrite
the prior accepted artifact with a synthesized observation date.

Presentation would add an independently labeled **Published** value only when
the future contract is implemented. Unknown must be visible; approximate dates
must be labeled approximate, and date precision must not render as an exact
age. Show source, raw fact, timezone/precision, competing assertions and refresh
status in evidence detail. Retain **Discovered** as its own value. Any future
publication sort/filter must be separate, with explicit null ordering, rather
than changing `discovered_at` behavior.

### Future acceptance scenarios

These are follow-up proof requirements, not tests executed in this investigation.

| Synthetic scenario | Required future result and proof |
| --- | --- |
| Date-bearing ATS payload and provider event | Native locked adapter and provider tests retain raw field/location, semantics, source identity and acquisition clock through intake and canonical persistence. Date-free payloads still succeed under the old contract. |
| Direct, list and `@graph` JSON-LD JobPosting | Extract publication only from the node bound to this Job; distinguish unsupported traversal from unknown date. Verify description/apply extraction still works when date is absent or invalid. |
| Date-only, offset datetime and naive datetime | Preserve date precision; normalize the offset example above; leave naive unknown-zone input ambiguous. Round-trip exact raw fact and timezone basis. |
| Daylight-saving transition and ambiguous locale text | Ambiguous/nonexistent local times and locale-ambiguous dates never acquire an invented instant. Explicit resolving evidence is required. |
| Relative “3 days ago” observed at fixed `T` | Produce the documented approximate interval only for a validated unit/rounding convention. Re-rendering later must not re-anchor to the new wall clock. |
| Missing, malformed, impossible and future date | Unknown or flagged evidence with explicit reasons; discovery and description extraction remain usable. Exercise tolerance boundaries and date-only timezone limits. |
| Creation, modification or expiry without publication | No accepted publication fallback. Availability still owns expiry behavior. |
| Employer and syndication disagreement; equal authority conflict | Deterministic provenance-based selection or explicit conflict; retain every competing raw assertion. Both runtimes reproduce the same selection. |
| Re-observation, duplicate-source merge and alleged repost | Preserve evidence history and reversible identity lineage, retain first discovery, and require explicit episode evidence for a repost. |
| Accepted claim followed by fetch failure or unusable date | Previous accepted value/precision/references remain byte-for-byte unchanged; failure history and freshness change separately. Reload from canonical state and inspect through API/browser. |
| Old records and old clients | Additive migration leaves publication unknown and every observation clock unchanged. Omitted optional fields remain accepted. No inference during backfill. |
| Python and TypeScript rebuilds | Rebuild from the same canonical fixture in each runtime; compare full publication summary/evidence references, null handling, policy version and observation clocks. Do not test only a DTO mock. |
| Jobs list and Job detail | Show separate Published/Discovered values, visible unknown/approximation/conflict/stale state and inspectable raw evidence. Required browser/API proof includes reload and unsuccessful refresh. |

### Follow-up implementation scope and owners

| Future work | Owning layer and expected scope |
| --- | --- |
| Source semantics and acquisition | ATS adapters, `jobstreaming_gateway.py`, `discovery/jobspy.py`, `smartextract.py`, enrichment `services.py` and detail fetcher. Verify native source payload semantics and retain exact field/node references; add transport-double and malformed fixtures. |
| Intake and normalization | Discovery `value_objects.py`, `ports/discovery.py`, `identity.py`, `aggregate.py`, `use_cases.py`; enrichment `snapshot_value_objects.py`, `snapshot_services.py`, `snapshot_set.py`, `snapshot_use_case.py`. Define optional evidence, deterministic normalization/selection and failure preservation at the domain boundary. |
| Canonical persistence and migration | Discovery/enrichment SQLite repositories, [database.py][database], `infrastructure/migrations/` and the paired TypeScript schema owners described in [Storage](storage.md). Use the exact-schema migration/admission protocol; immutable evidence must not rely only on replaced observation rows or a projection. Preserve old clocks and test rollback/reload. |
| Projection parity | Python `ProjectionBuilder._rebuild_job` and TypeScript `rebuildJobProjections`. Read canonical evidence rather than scraping or guessing in either builder; prove identical rebuilds. |
| API contracts and readers | `packages/contracts/src/schemas.ts`, `apps/api/src/read-model.ts` and the owning [API jobs reference](../api/jobs-and-materials.md). Specify additive nullable/optional wire fields and explicit unknown, provenance and freshness. GET remains a read; it does not acquire evidence. |
| Presentation | Jobs `columns.tsx` and Job detail/evidence consumers, following the frontend and web agent instructions when implemented. Add distinct labels and precision-aware rendering without changing Discovered semantics. |
| Documentation and verification | Update every affected owning user/API/architecture reference when production behavior ships. Add canonical synthetic fixtures, migration preservation tests, Python–TypeScript parity, API and browser proof under local reliability QA. This page remains investigation history until a separately scoped implementation is verified. |

This checkout changes only this page. Shared navigation, requirements/decisions,
production code, schemas, migrations, check definitions and another task's work
are outside this investigation. Dependency repair and publication remain with
the controller; no commit, push, PR, merge, tracker action or external account
operation is performed by this role.

[ats]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/infrastructure/discovery/ats_adapters.py
[gateway]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/infrastructure/discovery/jobstreaming_gateway.py
[jobspy]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/discovery/jobspy.py
[smart]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/discovery/smartextract.py
[port]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/ports/discovery.py
[metadata]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/discovery/value_objects.py
[job]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/discovery/aggregate.py
[identity]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/discovery/identity.py
[discovery-use-cases]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/discovery/use_cases.py
[detail-page]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/enrichment/value_objects.py
[fetcher]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/infrastructure/enrichment/playwright_fetcher.py
[extractors]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/enrichment/services.py
[acquisition]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/enrichment/snapshot_services.py
[snapshot-values]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/enrichment/snapshot_value_objects.py
[snapshot-set]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/enrichment/snapshot_set.py
[snapshot-use-case]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/enrichment/snapshot_use_case.py
[job-repository]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/infrastructure/discovery/sqlite_repository.py
[enrichment-repository]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/infrastructure/enrichment/sqlite_repository.py
[python-projection]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/infrastructure/projections/projection_builder.py
[ts-projection]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/apps/api/src/projections.ts
[read-model]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/apps/api/src/read-model.ts
[contracts]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/packages/contracts/src/schemas.ts
[columns]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/apps/web/src/views/jobs/columns.tsx
[checks]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/scripts/checks.toml
[database]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/database.py
