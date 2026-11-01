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
| Broad-board provider acquisition | [jobstreaming_gateway.py][gateway]: `JobStreamingGateway.frame_for_job_event`, `collect`, `build_request` | Delegates provider formatting to `jobs_to_dataframe`; the event path adds `jobstreaming_job_key`. `hours_old` is an acquisition filter passed to the provider, not a persisted publication claim. The synthetic formatter retained `date_posted`; live date coverage and publication semantics remain unmeasured. |
| Provider row to domain intake | [discovery/jobspy.py][jobspy]: `store_jobspy_results`, `_jobspy_posting_from_row`, `_record_jobspy_source_observation` | Maps selected row facts into date-free intake, and separately records an observation. `store_jobspy_results` obtains a UTC `now`; `_record_jobspy_source_observation` uses its caller's `observed_at`. There is no date argument in `_jobspy_posting_from_row`. |
| SmartExtract intelligence and extraction | [smartextract.py][smart]: `collect_live_page_intelligence`, `execute_json_ld`, `execute_api_response` | Intelligence can retain parsed JSON-LD and intercepted data. The two executors enumerate only `title`, `company`, `salary`, `description`, `location`, `url`, even if the plan contains another key. `execute_json_ld` accepts only top-level `@type == "JobPosting"`; it does not walk `@graph`. This is distinct from the enrichment extractor below. |
| Intake and metadata | [ports/discovery.py][port]: `ScrapedJobPosting`; [discovery/value_objects.py][metadata]: `JobMetadata` | The intake has no publication-date slot. Metadata contains title, salary, discovery description and location. An unknown constructor keyword is rejected, rather than stored as evidence. |
| Canonical Job and observations | [discovery/aggregate.py][job]: `Job.discover`, `with_metadata`, `to_dict`; [discovery/identity.py][identity]: `JobSourceObservation` | Job stores `discovered_at`. Observation stores source identity, URL, run and `observed_at`. Timestamp checks here require nonempty strings, not ISO parsing. Neither object stores publication evidence. |
| Discovery write boundary | [discovery/use_cases.py][discovery-use-cases]: `DiscoverJobsUseCase._ingest_one`, `_create_new_job`, `_observe_existing_job` | The injected/default clock produces `observed_at`; a new Job receives that same value as `discovered_at`. Existing-owner observations follow a separate path. Canonical identity and duplicate decisions do not infer publication time. |

Dates such as synthetic `postedOn`, `date_posted`, `createdAt`, `updated_at`
or `publishedAt` must not be treated as interchangeable. Their names alone
do not certify their semantics or their availability on any live source.
All four adapters were executed with synthetic date-bearing payloads. Those
injected fields do not establish vendor payload reliability or semantics.

### Enrichment, persistence and presentation owners

| Boundary | Canonical source and symbols | Inspected behavior |
| --- | --- | --- |
| Detail-page payload and fetch clock | [enrichment/value_objects.py][detail-page]: `DetailPage`; [playwright_fetcher.py][fetcher]: `PlaywrightDetailPageFetcher.fetch` | `DetailPage` carries parsed `json_ld` and `fetched_at`. The fetcher obtains UTC time locally before acquisition. Carrying a `datePosted` key inside JSON-LD is not equivalent to extracting or accepting it. |
| Description extraction | [enrichment/services.py][extractors]: `JsonLdExtractor.extract`, `_find_job_posting`, `ExtractionResult` | JSON-LD enrichment walks lists and `@graph`, extracts a sufficiently long description and best-effort application URL. `ExtractionResult` has only `ok`, description and application URL. No normalized publication result is produced. |
| Availability and content acquisition | [snapshot_services.py][acquisition]: `ActiveStateVerifier.verify`, `_parse_deadline`, `ContentAcquisitionService.acquire` | `validThrough` is deadline evidence for availability: invalid deadlines produce unknown, contradictory availability signals can produce unknown, and elapsed deadlines can produce expired. The parser requires a timezone, so date-only deadlines also produce unknown. Expiry is not a publication date. Acquisition returns description/hash, apply URL, availability, confidence and capture evidence, or structured failure. |
| Snapshot clock and failure history | [snapshot_value_objects.py][snapshot-values]: `PostingContentSnapshot`; [snapshot_set.py][snapshot-set]: `PostingSnapshotSet.record_snapshot`, `record_capture_failure`; [snapshot_use_case.py][snapshot-use-case]: `CapturePostingSnapshotUseCase.execute` | Snapshot stores `captured_at`. The use case passes local `_utc_now()` after acquisition. Capture failure appends failure history without appending a replacement snapshot. No publication evidence value object is present. An imported use-case/repository probe preserved the accepted snapshot after an injected fetch failure. This proves content preservation, not a publication implementation. |
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

These measurements use frozen runtime source at
`315aa323848bbd8da2ed95bccbb47f0fe685d27f`. Fresh imported probes ran on
2026-10-06 at checkout head `5462433b6ce7040cb4d098bc917f07224450dc31`;
the harness compared each of its 14 owning source files byte-for-byte against
the baseline before execution. Inputs use `example.com`, Synthetic Co and
owned disposable databases. No personal workspace, account or application
was involved. Socket connections were forbidden in the native harness;
transport doubles supplied ATS/provider responses and detail pages.

### Reproducible retained evidence

The controller-authorized retained investigation bundle
`1d0a039e557e293f8dd4d7f58d846e3e6fdf438cf31d0198ad435106696956d8`
contains complete probe source, inputs, outputs and failed attempts. Its
location is the supplied `role-artifacts/authoring/implement/` allocation,
not a temporary directory. `evidence-manifest.json` inventories retained
files with SHA-256 hashes.

| Retained file | Contents |
| --- | --- |
| `native-probe.py`, `run.py` | Reproducible imported-function harness and command runner. The runner uses the controller-named interpreter, repository `PYTHONPATH` and a synthetic `JOBCTRL_DIR`; it records exact argv and UTC start/end times. No abstract-syntax-tree extraction or source substitution is used in fresh probes. |
| `native-probe.inputs.json` | Base ATS/provider/JSON-LD fixtures, extraction plan and synthetic clocks. Variant construction is explicit in the harness; full variant inputs also appear beside their outputs. |
| `native-probe.stdout.log`, `native-probe.stderr.log`, `native-probe.outputs.json` | Full actual output and stderr, plus 41 structured outcome records. The final run ended `ALL_NATIVE_PROBE_ASSERTIONS_PASSED 41`. That number counts outcome records, not tests or live sources. |
| `native-probe.provenance.json`, `native-probe.receipt.json` | Source-file paths/hashes, source baseline, checkout head, interpreter/package versions, lock hashes, environment and timestamps. |
| `native-probe-attempt-1.*`, `native-probe-attempt-2.*`, `native-probe-attempt-3.*` | Earlier native harness revisions and actual outputs/receipts. Attempt 1 stopped at an incorrect harness expectation for an unzoned deadline; subsequent runs measured unknown and then asserted zoned and unzoned cases. No production function changed to make the probe pass. |
| `historical/probe.py`, `historical/probe.log`, `historical/probe-attempt-1.log`, `historical/probe-attempt-2.log`, `historical/initial-python.log`, `historical-copy.json` | Original pre-preparation source and historical results, including both import failures and source-isolated measurements. The copy inventory records hashes. These are historical environment/function-body evidence, not fresh imported execution. |

Fresh imported probes used the explicitly supplied, controller-prepared
CPython **3.12.13** interpreter. The preparation receipt identifies
`uv sync --locked --no-install-project --extra dev`; the probe did not prepare
or change dependencies. The worker lock SHA-256 is
`c7a3609dab6c93fdaa9f247ef88a943d74629457042ce64d7a92320092ba40d6`.
Recorded versions include JobStreaming 0.0.5, BeautifulSoup 4.14.3,
Temporal SDK 1.26.0 and pandas 2.3.3. The final native command ran from
`13:32:14.735667Z` to `13:32:18.256152Z` on 2026-10-06.

Replay uses the preparation receipt's interpreter, with the repository's
`workers/automation/src` on `PYTHONPATH` and an owned synthetic `JOBCTRL_DIR`,
by running `run.py probe` from the checkout. Full argv is retained in
`native-probe.receipt.json`. The harness creates and removes its own synthetic
database. Generated Job IDs and actual capture clocks can differ on replay:
compare the asserted behavior, not byte equality of newly generated IDs or
wall-clock output. Full stdout and stderr are retained even on failure.

### Historical intake and environment failures

These earlier results preceded the prepared environment above:

| Historical probe | Actual result | Limit |
| --- | --- | --- |
| Default Python 3.9.6 import | Failed at a union-type expression in `domain/pipeline_types.py`, before intake construction. | Unsupported host interpreter; not an extraction result. |
| CPython 3.14.7 intake constructor | Constructed `ScrapedJobPosting` with its nine fields. Additional `published_at="2026-10-01"` raised expected `TypeError`, unexpected keyword argument. | Native domain constructor outside the locked environment. Fresh locked execution below reproduced both results. |
| ATS module import on that host interpreter | `ModuleNotFoundError: No module named 'bs4'`. | Failed before adapter execution; prepared imports succeeded. |
| Enrichment services import on that host interpreter | `ModuleNotFoundError: No module named 'temporalio'`. | Failed before `JsonLdExtractor.extract`; prepared imports succeeded. |
| First two source-isolated attempts | `NameError` for missing harness bindings `dataclass`, then `Employer`. | Harness defects, distinct from dependency or production failures. |
| Corrected source-isolated harness | Workday dropped `postedOn`; selected provider handoff and SmartExtract dropped dates; private SQL bodies preserved first discovery and replaced source clocks. | Unchanged definitions compiled from source with imports bypassed and tracing replaced by a no-op. This did not prove imported integration, exact-schema admission, public repository APIs or live reliability. Native probes supersede those limits only where explicitly measured. |

### Fresh imported outcomes

All rows below describe actual execution through imported production functions.
Retained JSON/logs identify each case, input, output and source hash.

| Probe | Observed result | Limit or interpretation |
| --- | --- | --- |
| Intake success and rejected field | Constructed the nine-field intake. Additional `published_at="2026-10-01"` raised `TypeError`: unexpected keyword argument. ATS and enrichment modules imported successfully. | Constructor and module-load proof; the date contract remains absent. |
| Four ATS adapters, date-bearing payloads | Workday `postedOn="Posted 3 Days Ago"`, Greenhouse `updated_at="2026-10-01"`, Lever `createdAt="2026-10-01"`, Ashby `publishedAt="2026-10-01"`: each made one injected HTTP call and returned one date-free posting. | Real adapter bodies and HTML cleaners ran. Synthetic key names do not certify provider publication semantics. |
| Four ATS adapters, missing or malformed date | Each variant returned one date-free posting; malformed values were `{"bad": true}`. | Ignoring malformed input is not date validation or normalization. |
| Four ATS adapters, missing title | Each made one injected HTTP call and returned zero postings. | Actual admission rejection, independent of date content. |
| `JobStreamingGateway.collect` with injected adapter | One event carrying typed `date_posted=2026-10-01` produced one DataFrame row retaining `date_posted`; completed was true and failures empty. `_jobspy_posting_from_row` produced date-free intake. | Provider streaming/formatting and handoff against a transport double, not a live board. |
| Malformed provider date | `JobPost(date_posted="not-a-date", ...)` raised Pydantic `ValidationError`. | Provider-model rejection before acquisition; distinct from ignored ATS dates. |
| Full `store_jobspy_results` | Date-bearing provider frame returned `(1, 0)`. Canonical Job and observation used `2026-10-06T13:32:18.067461+00:00`, not provider date October 1. Repeat returned `(0, 1)`, kept that discovery time and replaced the single observation clock with `2026-10-06T13:32:18.126529+00:00`. | Full synthetic storage path with public repository reload and observation readback. No live source, concurrency or downstream workflow proof. |
| SmartExtract and enrichment, direct JSON-LD | `execute_json_ld` returned one six-key dictionary without dates despite plan mapping `date_posted` to `datePosted`. `JsonLdExtractor.extract` returned `ok=True`, description and application URL, without publication evidence. | Input contained `datePosted="2026-10-01"` and `validThrough="2099-01-01"`; neither result creates a publication claim. |
| Same JSON-LD with missing or object-valued `datePosted` | SmartExtract returned one date-free dictionary; enrichment returned `ok=True` for usable description. | No date validation occurs on the ignored publication field. |
| `@graph` JobPosting and invalid entries | SmartExtract returned zero jobs for `@graph`; enrichment returned `ok=True`. Entries `[null, "bad", {}]` produced zero jobs and enrichment `ok=False`. | Distinguishes traversal owners. No page collection or arbitrary JSON-LD conformance proof. |
| Missing plan and short description | SmartExtract raised `KeyError: 'extraction'`. Enrichment with description `tiny` returned `ok=False`. | Actual malformed-plan and extraction failures, not transport or environment failures. |
| Availability, date-only expiry | `2099-01-01` and `2000-01-01` returned unknown, `invalid_deadline`. | `_parse_deadline` rejects unzoned dates. The first native harness incorrectly expected active for the future date and stopped; corrected cases retained and asserted this measured limit. |
| Availability, zoned and malformed expiry | `2099-01-01T00:00:00Z` returned active; `2000-01-01T00:00:00Z` returned expired, both `json_ld_valid_through`. `not-a-date` returned unknown, `invalid_deadline`. | Bound synthetic JobPosting only. Availability outcomes, not publication evidence. |
| Public `SqliteJobRepository.save`/`load` | Metadata refresh with a supplied newer clock preserved stored `2026-10-06T10:00:00+00:00` discovery time. | `init_db` exact-v12 synthetic database and public APIs, not isolated SQL. No migration or concurrent-writer proof. |
| Public observation write/read | October 6, October 7 and `not-a-date` successively replaced one row's `observed_at`. Empty string construction raised `ValueError`. | Nonempty-string invariant, not ISO validation. Malformed clocks were never written to real data. |
| Content snapshot followed by failed refresh | Imported `CapturePostingSnapshotUseCase` and SQLite snapshot repository captured version 1 at `2026-10-06T13:32:18.129200+00:00`. Injected fetch failure returned `ok=False`, `FETCH_ERROR`; reload retained exactly the prior snapshot dictionary and added one failure. | Supplied `fetched_at="2026-10-06T10:00:00+00:00"` differs from local capture time. Content preservation is implemented; no publication field was introduced. Availability was unknown because expiry was date-only. No generated materials or approval path ran. |

The retained snapshot description hash was
`7257dc7c6e3948465dea633bae0e8240edf660ef23ac214fcde4f188219446bb`.
Its accepted hash, apply URL, capture clock, confidence and version remained
unchanged after failed fetch. The comparison used the complete accepted
snapshot dictionary, not a cosmetic UI assertion.

Measured gaps are date loss after acquisition, narrow SmartExtract JSON-LD
traversal and permissive nonempty observation-clock validation. The proposal
addresses publication evidence. Changing observation validators or date-only
expiry policy requires separately scoped compatibility work; these probes
implement neither change.

Unmeasured boundaries include live ATS/provider semantics and reliability,
browser detail acquisition, arbitrary HTML/JSON-LD, timezone and relative-date
normalization, migrations and concurrent refreshes, Python–TypeScript
publication projection parity, and publication API/browser behavior. Existing
content preservation does not prove a future publication implementation.
Source inspection and synthetic transport cannot establish live reliability.

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

Production code, schemas, migrations and shared navigation remain outside this
investigation. The compatible contract and scenarios above require separately
scoped implementation; #1022 is not an implemented-feature completion claim.

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
