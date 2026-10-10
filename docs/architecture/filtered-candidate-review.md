# Filtered Candidate Review

This investigation for [issue #1021](https://github.com/ebarti/JobCtrl/issues/1021)
describes what Discovery retains about rejected postings and proposes a separate,
read-only review contract. The review capability is future architecture, not an
implemented production feature.

**Read this if** you need to distinguish a rejected posting from an existing Job,
understand the available rejection evidence, or scope subsequent implementation.

## Current implementation

### Scope and auditability invariant

The source baseline is `315aa323848bbd8da2ed95bccbb47f0fe685d27f`.
Source links below pin that revision; fixture descriptions are source inspection
unless the evidence section explicitly records execution.

A **filtered candidate** in this proposal is a rejected posting observation:
something a source returned but an admission decision declined. It is distinct
from a source locator candidate (a possible board/source to crawl), a Job's
active/deleted/hidden lifecycle, and suitability scoring of an admitted Job.
[`run_deterministic_source_locator`][wiring] validates and promotes source
locations; it does not implement this rejected-posting review capability.

The [auditability invariant](../developer/qa/regression-catalog.md#auditability-checks)
is that a reviewable rejection identifies its original posting, evaluated policy,
and actual decision basis. A present-day classifier rerun cannot manufacture a
historical decision, missing source text, or model response. The distinction
between canonical facts, events, projections and telemetry follows
[Data, Events & Projections](data-events-and-projections.md); physical ownership
remains with [Storage](storage.md). Logs and aggregate counts are not posting
evidence. Failed refreshes must preserve the last accepted state and artifacts.

### Source owners and admission boundaries

| Boundary | Exact frozen owner | Current behavior and evidence limit |
| --- | --- | --- |
| Title admission | [`discovery/title_filter.py:title_matches_query`][title] | Returns a Boolean after approved exact-title feedback, deterministic matching and, for eligible loose matches, optional model adjudication. Strict/recall mode, track and seniority affect matching. `role_matcher=None` bypasses model adjudication; an unavailable matcher preserves loose-match recall. The Boolean does not carry an explanation or policy snapshot. Feedback lookup currently uses tenant `local`. |
| Location admission | [`infrastructure/discovery/location_filter.py:location_matches_target`][location] | Explicit rejected geography takes precedence over remote signals; accepted country context disambiguates short aliases. Missing location fails when concrete accepted geography exists. Remote-required searches can admit non-remote local exceptions only through `local_accept`. Returns a Boolean, not a durable reason. |
| Broad-board caller filter | [`discovery/jobspy.py:_filter_jobstreaming_event_frame`, `run_discovery`][jobspy] | Checks location, then title, on one provider event. An empty accepted frame records `record_filtered_result(lease, event.job_key)` before provider acknowledgement. An accepted frame goes through `store_jobspy_results` and the canonical Discovery use case before acknowledgement. The receipt branch does not retain the original frame or which check failed. This describes the resumable path; legacy DataFrame filtering is not evidence of universal receipts. |
| Durable filtered accounting | [`SqliteDiscoverySearchUnitRepository.record_filtered_result`, `execution_filtered_count`, `fence_write`][receipts] | Strips and SHA-256 hashes the non-empty provider key; fences the lease and inserts with conflict suppression. Identity includes tenant, exact workflow/run and unit. Counts query this receipt ledger for the exact execution, independently of Jobs. The hash cannot recover the provider key or posting. |
| Receipt schema | [`database.py:ensure_discovery_search_unit_tables`][schema] | Defines six receipt columns, a composite primary key and a cascading search-unit foreign key. The tracked exact-schema lineage also defines this table in [`schema_v7.sql`][schema-sql]. A unit's request JSON/fingerprint can supply search context, but the receipt supplies neither posting text nor an actual rejection reason/full evaluated-policy snapshot. |
| Workday prefilter | [`discovery/workday.py:search_employer`][workday] | Uses expanded query specs or title matching and optional location matching before appending a posting. Rejected results disappear from the returned list. `store_results` also requires usable description content. These early omissions do not become broad-board filtered receipts. |
| Smart Extract prefilter | [`discovery/smartextract.py:_store_jobs_filtered`][smart] | Skips unusable URLs, wrong location/title and missing description before calling Discovery. Title/location and missing-description totals are logged separately; there is no per-rejection review record in this branch. |
| Typed ATS adapters | [`infrastructure/discovery/ats_adapters.py`][ats] — `WorkdayBoardAdapter`, `GreenhouseBoardAdapter`, `LeverBoardAdapter`, `AshbyBoardAdapter` and their `_to_scraped` methods | Can return `None` for malformed identity, title or geography before yielding a `ScrapedJobPosting`. Ashby checks each available location. Downstream persistence cannot recover postings that were never yielded. |
| Production acceptance | [`production_wiring.py:_posting_acceptance_policy`, `_source_rejection_reasons`][policy] | Selects query specs by source family and returns structured codes `missing_description`, `title_mismatch`, `location_mismatch`. Direct families require usable descriptions; JobSpy listing leads can enter enrichment without one. Location evidence combines title and location. Unrecognized source families are accepted by this policy. These decisions are not identical to every adapter's earlier filters. |
| Canonical Job write | [`domain/discovery/use_cases.py:DiscoverJobsUseCase._ingest_one`, `_observe_existing_job`][ingest] | Resolves canonical ownership, then content ownership where appropriate, before policy disposition. New policy rejection returns a decision without creating a Job or publishing discovery events. Same-owner policy rejection can retire an existing Job. Distinct content-matched rejection has a different owner-preservation path, detailed below. |
| Jobs read path | [`apps/api/src/read-model.ts:listJobs`][list-jobs], [`jobSqlFilter`][jobs-filter] | Refreshes and selects `job_list_projections` with tenant and existing-Job lifecycle/stage/source filters. Neither SQL nor in-memory free-text filtering reconstructs rejected observations that never became Jobs. Showing deleted Jobs is not a substitute for this proposal. |

### Three different domain dispositions

1. **New posting, policy rejected:** `_ingest_one` returns
   `_policy_rejected_decision` before `claim_new_job`. The generated decision IDs
   are not proof of stored Jobs/observations. The inspected fixture
   [`test_discover_jobs_use_case_rejects_new_policy_mismatches_without_creating_job`][identity-tests]
   asserts zero new/observed/duplicate-rejected Jobs, no URL owner, and no events.
2. **Accepted same owner, now policy rejected:** `_observe_existing_job` calls
   `_soft_delete_policy_rejected_job`, attaches/publishes a source observation,
   and leaves the prior accepted metadata rather than replacing it with rejected
   metadata. The inspected fixtures
   `test_discover_jobs_use_case_soft_deletes_active_job_rejected_by_current_policy`
   and `test_discover_jobs_use_case_keeps_policy_rejected_deleted_job_hidden`
   assert retirement and non-restoration under rejection. The first expects
   `JobDeleted` then `JobSourceObserved`, with the original title preserved.
   [`retire_invalid_source_jobs`][wiring] also performs hygiene on stored Jobs;
   [production-wiring fixtures][wiring-tests] cover ATS and JobSpy retirement.
   Retirement is existing-Job history, not a historical rejected-posting inbox.
3. **Distinct content-matched posting, policy rejected:**
   [`_reject_content_matched_duplicate` and `_record_and_publish_rejected_duplicate`][duplicate]
   preserve the accepted owner and record `DuplicateJobLinkRejected` against it.
   They do not attach the rejected posting as an owner observation, preventing
   replay from turning it into a same-owner rejection that retires the owner.
   The audit is deduplicated by owner/candidate URL. The inspected fixture
   `test_discover_jobs_use_case_keeps_accepted_owner_when_content_duplicate_rejected`
   asserts one active Job, unchanged location, only the original source
   observation and stable replay. This policy rejection does not increment
   `DiscoveryRunSummary.duplicates_rejected`; that count concerns the separate
   low-confidence duplicate branch. A duplicate audit is not a complete original
   posting/policy archive.

These source-backed distinctions are not runtime verification of a new review
surface. Rejection can happen at several layers; a future writer must capture
the decision at the layer that actually made it, including early omissions.

## Synthetic evidence

### Executed classifier probes

On 2026-10-06, the original role probe imported the two frozen classifier files
directly with
`importlib.util.spec_from_file_location`, without importing application bootstrap.
Title feedback was bound to a synthetic, empty in-memory SQLite table named
`role_match_feedback_suggestions`, with columns `tenant_id`, `status`,
`rule_kind`, `title_pattern`. The lookup returned approved local exact-title
exclusions only; there were no rows. `role_matcher=None` disabled model
adjudication. No personal configuration, network, provider or user database was
used. The original imports generated only ignored Python bytecode. A retained
reproduction at `2026-10-06T11:29:29.022262+00:00` used the controller-prepared
`workers/automation/.venv/bin/python` (Python 3.12.13), disabled bytecode writes,
and produced byte-for-byte identical stdout, empty stderr and exit 0. The
reproduction is a new measurement, not a retroactive original-run receipt.

For every row, title matching used `match_mode="strict"`, with no track/seniority
override. Location matching used `accept=["Spain", "Europe"]`,
`reject=["USA", "Canada"]`, `search_location="Spain"`, `remote_required=True`,
`is_remote=None`, `local_accept=()`. The observed admission is the conjunction of
the two Booleans, not a call to the full production acceptance policy.

| Case | Original synthetic title | Query | Location | Title match | Location match | Expected / observed admission |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Director of Engineering | Director of Engineering | Remote EMEA | true | true | admitted / admitted |
| 2 | Director of Software Engineering | Director of Engineering | Barcelona, Spain (Remote) | true | true | admitted / admitted |
| 3 | Platform Director | Director of Platform Engineering | Remote Europe | true | true | admitted / admitted |
| 4 | Sales Director Platform | Director of Platform Engineering | Remote Europe | false | true | rejected / rejected |
| 5 | Director, Electrical Engineering | Director of Engineering | Remote Europe | false | true | rejected / rejected |
| 6 | Director of Engineering | Director of Engineering | Remote, United States | true | false | rejected / rejected |
| 7 | Director of Engineering | Director of Engineering | empty string | true | false | rejected / rejected |
| 8 | Director of Engineering | Director of Engineering | Madrid, Spain | true | false | rejected / rejected |

Result: **3 admitted, 5 rejected, 8/8 matched expectations; probe exit 0**.
The rejected rows are successful measurements of rejection, not execution
failures. The returned Booleans do not produce structured reasons; the table
does not claim to have captured them. Cases 7 and 8 show missing geography and
remote-required behavior under these particular inputs, not general geography
or eligibility truth.

Limitations: no description requirement, production source-family selection,
approved feedback, model judgment, adapter acquisition, canonical ownership,
real account, API or UI was exercised. Empty feedback is a fixture, not evidence
that production feedback is empty or tenant isolation is already complete.

### Executed tracked-schema probe and failed review query

The probe parsed `database.py` with `ast`, extracted the unchanged
`ensure_discovery_search_unit_tables` function, compiled it with postponed
annotations and `sqlite3` in scope, and supplied `sqlite3.connect(":memory:")`.
It did not call the default connection path or initialize an installed database.
Actual returned tables were `discovery_search_units`,
`discovery_search_unit_jobs`, `discovery_search_unit_filtered_events`.

| Executed read | Actual result | Interpretation |
| --- | --- | --- |
| `PRAGMA table_info(discovery_search_unit_filtered_events)` | `tenant_id`, `discover_workflow_id`, `discover_run_id`, `unit_id`, `provider_event_key_hash`, `filtered_at` | Six columns; no posting title, reason or policy snapshot in this receipt. |
| `SELECT COUNT(*) FROM discovery_search_unit_filtered_events` | `0` | Empty synthetic harness only; no claim about user history. |
| `SELECT title, rejection_reason FROM discovery_search_unit_filtered_events` | `sqlite3.OperationalError: no such column: title` | Actual failed query. SQLite stops on the first absent column; the PRAGMA separately shows both fields absent. This is a schema evidence gap, not a service outage or a failed admission decision. |

The harness created synthetic tables only. It does not prove installed migration
compatibility, receipt insertion/fencing, replay or foreign-key behavior. No Jobs
were seeded and the legacy helper's accepted-job foreign key was not exercised.
The full probe exited 0 because it explicitly caught and reported the expected
failed review query; that does not make the query successful.

### Retained probe provenance

The controller allocated durable evidence directory
`role-artifacts/authoring/implement/ae82e991e93d67d061e92fb6e66f35a7466de21b2d6cdfbe15cf1a14ab3d3a29`
for this run. The following are retained-run file identifiers, not published
documentation assets. `manifest.json` inventories their paths/hashes;
`probe-run.json` records the executed argv, UTC start/end, interpreter hash,
source/lock hashes and input-candidate identity. Reproduce with the prepared
project interpreter on `synthetic-probes.py`, supplying `--root CHECKOUT` and
`--inputs RETAINED_DIRECTORY/synthetic-inputs.json`. Substitute the checkout and
retained directory paths; all eight inputs, fixture SQL and schema queries are
in the input file. This reproducer has actually executed.

| Retained file | SHA-256 | Provenance |
| --- | --- | --- |
| `original-synthetic-probes.py` | `55aaa7eecc46b0446b6235a9c9f0f72a139b8fe7898f0c846daf0832bd046d38` | Original scratch script recovered unchanged |
| `original-synthetic-probes.txt` | `af973a0edfaa1add5be6738c0c4f9648a8c48bca83bd19429a27423ceed1d4b2` | Original full stdout recovered unchanged |
| `synthetic-probes.py` | `b06d234ededea31611d7434cf6be84227cc8568e30b4e924d070007d9329fe12` | Newly executed reproducer, independent output capture |
| `synthetic-inputs.json` | `9e618fa2048de01fa774e0ab2544ce573b80d980b3b30843e0759547544e70e8` | Complete synthetic inputs and expected results |
| `synthetic-stdout.txt` | `af973a0edfaa1add5be6738c0c4f9648a8c48bca83bd19429a27423ceed1d4b2` | New full stdout, identical to original |
| `synthetic-stderr.txt` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | New full stderr, empty |

The recovered original files came from the first role invocation's scratch
directory, whose input candidate was
`c817d98c9fe1a484720b60f9c13ca3384a1066688d8e67b0c6e3cbb0250dae80`
at the frozen baseline. Recovery hashes are measured now; the original exact
UTC, interpreter hash and sealed execution receipt were not retained and are
not invented. `broker-inspection.json` preserves that limit, the recovery UTC
and the recovered historical failed-build/static-check logs. The fresh probe
ran with input candidate
`38ee5fa3f7c915ff6907aa4370f67b26afec8c8aba069a53f752575883b52c68`
at head `d1ee640be349ef6488ce2b94b5695226954cd27b`, before this prose revision.
Its input page hash was
`f186e3997d0de4fd9fc5078b53b600434adfdbffa30d67446b2ff813df519189`.

Before reproduction, each imported source was compared byte-for-byte with
baseline `315aa323848bbd8da2ed95bccbb47f0fe685d27f`:

| Input source/lock | SHA-256 |
| --- | --- |
| `discovery/title_filter.py` | `596c648231a983ae5a9b6633322f40ef02914208985109189ab1ab88b5a58294` |
| `infrastructure/discovery/location_filter.py` | `f2b59841dec5235b6104c3287711e6b632bf80156015430ea31c48b76f640598` |
| `database.py` | `97b0b49cb2c3feac2e722c70d4e608dd47628adb999220408112b8657faf669b` |
| `workers/automation/uv.lock` | `c7a3609dab6c93fdaa9f247ef88a943d74629457042ce64d7a92320092ba40d6` |
| `workers/automation/pyproject.toml` | `a8671f5ae58e48007f89e36e56d110d3e915a8d0caaf41738f8c5b05ee4af13d` |

### Broker checkpoint: executed fixtures

The supplied read-only `receipts.json` handoff has SHA-256
`c04e3456cdd8e6caaf99b0e333e473ddd7554391bba4640eb8b7edbfd38ec8d5`.
Its `checks.local` measurements belong to candidate
`38ee5fa3f7c915ff6907aa4370f67b26afec8c8aba069a53f752575883b52c68`,
head `d1ee640be349ef6488ce2b94b5695226954cd27b`, content digest
`bc763ff43629b3ccee6e85132bd17e70260df5f744cbf928ac97237a61d3bb7d`.
They are broker measurements inspected by this role, not role-executed tests
or proof that the subsequently edited document passes. The handoff's earlier
prepublication candidate `18de317ccf96f2bb64def2da4485f8988801500575521867ea0595c3119ae661`
is historical and is not combined with these results.

The broker used locked Python dependency preparation, then its prepared
`.venv/bin/python -m pytest` with all nine selected paths, `-q`,
`-o pythonpath=src` and its allocated `--junitxml` output. This is the actual
recorded invocation, not a claim that this role executed the literal
`checks.python` uv argv. The retained JUnit and full log show **146 passed in
14.94 seconds, zero failures, errors or skips**, with these per-module counts.
Each filename is under `workers/automation/tests/`.

| Selected module | Source evidence relevant to this investigation | Broker passed cases |
| --- | --- | --- |
| [`test_title_filter.py`][title-tests] | Strict/recall, adjudicator, feedback, track and seniority behavior | 14 |
| [`test_discovery_title_filter.py`][discovery-title-tests] | Leadership aliases and loose Workday rejection | 2 |
| [`test_discovery_location_filter.py`][location-tests] | Remote country rejects, local exceptions, missing target matches and multiple Ashby locations | 12 |
| [`test_discovery_search_units.py`][unit-tests] | Immutable search plan, competing/stale ownership, `test_jobspy_storage_records_new_receipt_once_across_replay` | 15 |
| [`test_jobstreaming_resumable_discovery.py`][stream-tests] | `test_store_before_ack_replay_resumes_without_duplicate_counts_or_events`, `test_filtered_count_survives_loss_after_acknowledgement` | 18 |
| [`test_discovery_identity.py`][identity-tests] | New policy rejection, accepted-job retirement and duplicate-owner preservation described above | 33 |
| [`test_discovery_production_wiring.py`][wiring-tests] | Source-family acceptance, missing descriptions and stored-Job hygiene | 25 |
| [`test_workday_discovery.py`][workday-tests] | Query expansion, loose title rejection and missing-description storage gates | 10 |
| [`test_smartextract_discovery.py`][smart-tests] | Title/location/content filtering, canonical deduplication and restoration | 17 |

The inspected broad-board recovery fixture injects worker loss while saving
checkpoint revision 2 after filtered acknowledgement. Its assertions require
revision 1 and one durable filtered receipt after interruption; recovery must
report `new=0`, `filtered=1`, `raw_total=1`, one recovery and zero Jobs.
The broker JUnit records this case passed. It also records these baseline
invariants passed; their assertions were traced to the frozen fixture sources.

| Verified baseline invariant | Executed fixture and observed scope |
| --- | --- |
| New policy rejection without a Job | `test_discover_jobs_use_case_rejects_new_policy_mismatches_without_creating_job`: no stored URL owner or discovery events; new/observed/duplicate-rejected counts remain zero |
| Existing accepted-Job retirement | `test_discover_jobs_use_case_soft_deletes_active_job_rejected_by_current_policy`: deleted Job retains original title; rejection reason, source observation and `JobDeleted`/`JobSourceObserved` events are present |
| Rejection does not restore a deleted Job | `test_discover_jobs_use_case_keeps_policy_rejected_deleted_job_hidden`: the rejected owner remains deleted |
| Distinct duplicate preserves owner | `test_discover_jobs_use_case_keeps_accepted_owner_when_content_duplicate_rejected`: active owner and accepted location/source observation survive replay; rejected duplicate is audited without attaching it as an owner observation |
| Store/ack replay accounting | `test_store_before_ack_replay_resumes_without_duplicate_counts_or_events` and `test_filtered_count_survives_loss_after_acknowledgement`: injected interruption/replay preserves durable receipts and counts |
| Ownership fencing | `test_same_owner_claim_reentry_returns_the_active_lease_and_rejects_a_competing_owner` and `test_late_cancel_from_stale_attempt_cannot_cancel_new_owner`: competing/stale attempts do not take the current owner's authority |

These are existing synthetic baseline fixtures. They do not exercise a new
rejection-review endpoint, full historical policy/evidence capture, an artifact
fingerprint preservation scenario, or live ATS/account reliability.

### Broker checkpoint: documentation and report provenance

The original role's availability probe failed with `No module named pytest`;
zero tests ran in that attempt. Its first docs build exited 1 after install-asset
parity passed, because `vitepress`/`node_modules` were absent. Those are retained
historical environment failures, superseded by the supplied broker results;
they are not current product facts. No production source repair occurred.

| Broker measurement for candidate `38ee5fa…` | Actual result |
| --- | --- |
| Exact `checks.scripts` JUnit argv from [`scripts/checks.toml`][checks] | Exit 0; 163 tests passed, zero failures/errors/skips; report parsed and hash-verified. The separate `scripts:test` log also shows 163 passed, not an additional set of tests. |
| Selected worker fixtures | Exit 0; 146 tests passed, zero failures/errors/skips, as detailed above |
| `corepack pnpm docs:build` | Exit 0; install-asset parity, VitePress build/render, emitted-link check (14,089 references across 453 emitted files) and permanent Product Tour redirect check passed |
| Emitted `/architecture/filtered-candidate-review.html` | Broker's four assertions passed: three required heading anchors and issue link. This role independently parsed the copied full HTML and found the exact headings, issue link, eight tables, 25 frozen source-link targets and visible future-status heading. |
| `git diff --check` | Broker exit 0; historical candidate whitespace measurement |

The handoff stores the following hash-addressed files under
`role-evidence/ae82e991e93d67d061e92fb6e66f35a7466de21b2d6cdfbe15cf1a14ab3d3a29/files/`.
The role verified all 25 referenced copied artifacts against their declared
hashes and parsed the full JUnit/HTML, recording that inspection in the durable
`broker-inspection.json` file.

| Evidence file (filename is its SHA-256 plus extension) | Kind |
| --- | --- |
| `bf159e2bfd12ada64b6a21a83539f761fd9c4f25447ca0676a98acb1aca001a5.xml` | Scripts JUnit, 163 cases |
| `70a8b8c19afcbc5686a2aef7d1da8fdc550e240f5bd4244d0b60fc1ce49f5184.xml` | Selected worker JUnit, 146 cases |
| `7d6f656c13388a97864d4f7ffdb7c05dd98040bf7225ca99bf11659580f060e6.log` | Full selected pytest stdout/stderr log |
| `194639f39f721f2687654fb9b31a909e3976ce0201830017a5f6db9812fabded.log` | Successful configured docs build log |
| `72e2698eab168368acbd926fb9a8a37bc73fc1192b1446ac023d020a6dc05079.html` | Full emitted page, 104,214 bytes |

Emitted-HTML inspection is not browser runtime QA: it does not prove hydration,
visual layout, images loading or interactions. The supplied handoff contains no
`docs:check:runtime` result or screenshots. The tracked runtime script also has
a fixed page list that excludes this new page. All broker results above precede
this prose revision; they remain attributable baseline investigation evidence,
not proof of final-head verification or an implemented future feature.

## Future architecture, not implemented

### Compatible rejected-observation contract

The proposed authority is a Discovery-owned rejected-observation record, separate
from Jobs, source locator candidates and suitability scoring. Nothing in this
section adds a shipped table, endpoint, event, UI or admission rule.

| Proposed information | Required meaning and compatibility boundary |
| --- | --- |
| Observation identity | Tenant, exact execution/workflow/run where available, source family/source ID/native posting ID, observed URL, observation timestamp and decision stage. Direct-source observations need their own execution identity; do not invent JobStreaming units for them. A rejected observation ID must not masquerade as a canonical JobId. |
| Replay identity | Preserve broad-board execution/unit/provider-key-hash semantics and lease fences. Add a separate stable source-observation/decision key for direct adapters. A retry of the same decision inserts once; a new execution or explicit evaluation under a new policy is a distinguishable observation/version. Repeated reviews never increase raw/filtered/accepted counts. |
| Bounded original evidence | Source title, employer label, locations/remote flags, observed/native/canonical locators, retained decision-relevant posting text or excerpts, acquisition time and content fingerprint. Distinguish raw from normalized fields. Record absent, truncated, invalid and expired evidence explicitly. A hash alone does not make missing content reviewable. Never fetch extra detail merely to display a rejection. |
| Evaluated policy | Persist effective query/spec, mode, track, seniority, geography/local exceptions, family-specific description requirement, effective feedback rule/version and classifier version/fingerprint. Capture the policy used at the rejecting layer, not just today's settings. For model decisions, retain bounded actual adjudication inputs/result and model/rubric provenance when available under the owning privacy policy. |
| Actual decision basis | Structured reason codes plus field/excerpt references and decision-stage provenance. Separate deterministic mismatch, missing evidence, model denial and unavailable/error judgment. Unavailable evidence is not an invented reason. Boolean-only current adapters need an owning-layer decision result before they can supply this contract; the UI cannot reverse-engineer one. |
| Optional canonical association | A reference to an existing owner or duplicate audit may aid review, but never claims, merges, restores or retires a Job. Preserve confidence/native identity safeguards and the accepted owner's source observations, metadata, materials and approvals. |
| Privacy and retention | Tenant-bound writes, reads, joins, cursors and exports; allow-listed public posting evidence only. No credentials, browser state, profile/resume facts or unrelated logs. Retention, byte/row limits, purge ownership and expiry disclosures must be specified before implementation. |

Capture must occur where the decision happens: before Workday/ATS/Smart Extract
omissions and at the broad-board caller filter or domain policy branch. It must
not relax title, geography, content, canonical identity or enrichment admission.
Preserve the existing distinction between a new rejection, same-owner retirement
and distinct duplicate rejection. Their counts/events remain owned by their
current contracts; review counts must not silently redefine them.

For resumable boards, write required rejection evidence and the existing receipt
under the same fenced transaction before acknowledgement. If that required
write fails, do not acknowledge and lose the only posting copy; retry through
the existing recovery path. Capacity/retention omissions require an explicit
bounded evidence-unavailable disposition rather than a false complete record.
Do not replace `execution_filtered_count` with an inbox count that decreases as
review evidence expires. Cleanup must account for the current cascading unit
foreign key separately from any longer-lived evidence.

Historical receipts can disclose their execution, unit, hash, time and joined
search context; historical duplicate/retirement events can disclose only what
they actually retained. Label missing posting/policy/reasons unavailable.
Current-policy reevaluation is a new decision, never backfilled historical fact.
Pin the effective policy/evidence binding for replay of an in-flight observation.
A separate explicit reevaluation must not rekey its original provider receipt
or increase that execution's raw/filtered/new counts. Supporting a later policy
is not permission to retroactively overwrite an earlier rejection.

### Bounded read-only review and failure behavior

Proposed list/detail reads expose original observed metadata, source, decision
time/stage, historical policy, retained reasons and evidence availability.
Useful proposed filters are execution/source family, observation interval,
reason and evidence completeness. Cursor pagination must have a stable tenant
scope and snapshot/watermark; changing rows cannot silently repeat or omit
entries. Any association to an accepted owner must be validated in that tenant.
No exact API route name or client contract is accepted by this investigation.

Opening, searching or refreshing this view must not initiate acquisition,
enrichment, scoring, materials generation, source promotion, Apply or a Job
write. Rebuilding a derived projection is separate from canonical mutation and
must be transactional. Reads disclose projection watermark/staleness and show
unavailable detail for absent/expired evidence. A failed read/refresh keeps the
last successful review snapshot with a visible error; it cannot show an empty
inbox as evidence of zero rejections or hide accepted artifacts.

An optional future reconsideration is an explicit audited command, independently
scoped from viewing. It records actor, prior observation, chosen policy/version,
new decision, idempotency key and disposition. Before any admission it reruns
current safeguards through the canonical identity resolver and Discovery write
boundary, checks concurrent owner/policy versions and preserves accepted-owner
and artifact boundaries. It must not promote a rejected observation by copying
it directly into `jobs`. Model/network work requires its own explicit command
and existing budget/consent controls. Apply remains separately approved.

### Design assumptions to validate

- Start with local read-only review and immutable decision evidence; reconsideration
  is a separate follow-up. No new permissions are inferred from opening a page.
- Provisional evidence limits are 8 KiB per posting excerpt, 1,000 detailed
  rejected observations per execution and 30 days of detailed retention. These
  are reversible sizing hypotheses, not supported defaults. Measure source
  volume/privacy needs before accepting them; cap/expiry disclosures and durable
  replay accounting must survive those limits. If decisive text exceeds a cap,
  mark the decision evidence incomplete instead of presenting an excerpt as full.
- A future policy fingerprint covers effective source-specific inputs, approved
  feedback and classifier/model provenance, not merely a hash of global settings.
  Investigate the current local-only feedback lookup before promising multi-tenant
  isolation. No production policy or tenant behavior changes in this document.
- Legacy evidence stays explicitly partial; no historical reconstruction or
  reclassification migration is assumed.

### Future acceptance scenarios

These are proposed acceptance requirements, not observed feature results.

| Scenario | Required observable outcome |
| --- | --- |
| Admitted and rejected controls | Preserve the eight measured classifier outcomes under their exact fixture; admitted controls create Jobs through existing safeguards, rejected controls create review evidence without Jobs. Record source/family-specific requirements separately. |
| Missing evidence | Empty location/description, unavailable adjudication, truncated/expired snapshot and a legacy receipt expose distinct availability and actual decision states. Never invent posting text or historical reasons. |
| Multiple source families | Synthetic JobSpy, Workday, Greenhouse, Lever, Ashby and Smart Extract rejected observations remain separately traceable, including early adapter omissions and each family/location policy. Same-title postings alone do not establish canonical identity. |
| Replay and stale ownership | Inject loss before/after provider acknowledgement; one receipt/decision remains, existing raw/filtered/new accounting stays stable, and a stale lease cannot write evidence, acknowledge or advance the checkpoint. |
| Policy change | Retain original policy and reasons, label any new-policy evaluation separately, and preserve existing same-owner retirement/restoration semantics. Viewing under changed settings does not reclassify history. |
| Duplicate owner preservation | Replay a rejected India content duplicate of an accepted owner; only duplicate audit/rejection evidence changes. Owner identity, metadata, observations, accepted artifacts and approval fingerprints remain unchanged. |
| Tenant isolation | Identical provider keys/URLs in two synthetic tenants cannot expose, count, join or reconsider each other's records; cursors and all optional owner links stay tenant-bound. |
| Read-only review | Repeated list/detail/filter/refresh reads change no canonical Job, source registry, execution accounting, score, materials, approval or Apply state and trigger no network/model work. |
| Failed refresh | Force projection/query or replacement-evidence failure; show an actionable stale/error state and retain the last successful review snapshot and every accepted Job/artifact. Partial projection replacement rolls back. |
| Retention and errors | Hit every cap and expiry, delete an execution, and fail evidence persistence before acknowledgement. Disclose partial coverage, preserve durable accounting and apply documented retry/purge boundaries. |
| Explicit future reconsideration | Concurrent policy/owner changes fail safely; retries are idempotent; successful admission uses current canonical identity/admission and an auditable new decision. No automatic scoring/materials/Apply merely from review. |

### Separate follow-up implementation scope

| Owner | Subsequent work and proof required |
| --- | --- |
| Worker/domain Discovery | Introduce decision-bearing filter results and rejected-observation persistence ports at each actual rejection layer; wire fenced atomic capture without changing admission or duplicate disposition. Extend the existing selected synthetic fixtures with actual review-write/failure assertions. |
| Storage/schema | Design exact-version compatible migration and bounded retention/purge lifecycle, keys/indexes, tenant constraints and legacy-unavailable states. Prove replay/transaction behavior against the supported tracked schema, not this isolated harness. Update the owning storage reference. |
| Projections/events | Define derived review shapes, watermarks, transaction rollback and sanitized invalidations. Keep posting text/policy detail at the canonical owner rather than unbounded event/log payloads. Update the data/events/projections owner. |
| API/contracts | Specify tenant-bound paginated read contracts, evidence/error/staleness shapes and separate optional command semantics. Update shared types and the owning API references; test isolation and canonical-state preservation. |
| Client/UI | Implement a separate rejected-observation view with partial-history labels and source/policy evidence inspection. Preserve Jobs lifecycle vocabulary and accepted artifact review; prove read-only behavior and failed-refresh preservation in synthetic browser/API QA. |
| Owning documentation/delivery | Update Discovery/user/API/storage/projection documentation and navigation only in the separately authorized implementation. This investigation changes one page only. Independent review and QA must validate compatible contracts before any production feature claim. |

[title]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/discovery/title_filter.py#L240
[location]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/infrastructure/discovery/location_filter.py#L286
[jobspy]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/discovery/jobspy.py#L1647
[receipts]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/infrastructure/discovery/sqlite_search_unit_repository.py#L442
[schema]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/database.py#L2550
[schema-sql]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/infrastructure/migrations/schema_v7.sql#L558
[workday]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/discovery/workday.py#L290
[smart]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/discovery/smartextract.py#L142
[ats]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/infrastructure/discovery/ats_adapters.py#L204
[policy]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/infrastructure/discovery/production_wiring.py#L895
[wiring]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/infrastructure/discovery/production_wiring.py
[ingest]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/discovery/use_cases.py#L285
[duplicate]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/src/jobctrl/domain/discovery/use_cases.py#L693
[list-jobs]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/apps/api/src/read-model.ts#L1015
[jobs-filter]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/apps/api/src/read-model.ts#L4814
[title-tests]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/tests/test_title_filter.py
[discovery-title-tests]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/tests/test_discovery_title_filter.py
[location-tests]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/tests/test_discovery_location_filter.py
[unit-tests]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/tests/test_discovery_search_units.py
[stream-tests]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/tests/test_jobstreaming_resumable_discovery.py
[identity-tests]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/tests/test_discovery_identity.py
[wiring-tests]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/tests/test_discovery_production_wiring.py
[workday-tests]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/tests/test_workday_discovery.py
[smart-tests]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/workers/automation/tests/test_smartextract_discovery.py
[checks]: https://github.com/ebarti/JobCtrl/blob/315aa323848bbd8da2ed95bccbb47f0fe685d27f/scripts/checks.toml
