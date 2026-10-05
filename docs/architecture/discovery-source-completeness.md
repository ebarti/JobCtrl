# Discovery Source Completeness

Bounded investigation and proposed design for
[issue #1025](https://github.com/ebarti/JobCtrl/issues/1025).
**Design only: the completion summary below is not implemented.** This page
changes no production behavior, schema, endpoint, navigation, or source policy.
It does not establish that the entire job market, or even an employer's entire
inventory, has been searched.

Completeness should answer: *Did this acquisition exhaust its declared source,
provider query, location and time scope, and what evidence supports that claim?*
Execution success, usable descriptions, accepted jobs, and newly persisted jobs
answer different questions. A bounded successful search can return no jobs;
a successful capped search cannot establish exhaustion.

## Current implementation

Source inspection and the synthetic measurements below use revision
`67b4175aa2d9e8f96e62da545886b1e8712bf691`. References are pinned to that revision;
comments mentioning RFC phases or historical PRs are not proof of wiring.
Tests in this table were inspected as supporting specifications. The locked
worker regression command did **not** execute in this implementation checkout.

### Source owners and callers

| Boundary | Current owner and behavior | Supporting tests, inspected |
| --- | --- | --- |
| Family dispatch and run lifecycle | [runner.py][runner]: `run_discovery_source_family` calls scheduled ATS, `run_workday_discovery`, `run_smart_extract`, or broad-board discovery. `_run_discovery_source` saves `DiscoveryRun` counts and emits `DiscoveryRunCompleted`, including failed-source IDs for partial ATS failure. This is a lifecycle outcome, not exhaustion proof. | [test_discovery_production_wiring.py][wiring-tests]: `test_runner_records_partial_ats_source_without_losing_successes`, `test_repeated_partial_ats_failures_keep_failed_source_quarantined`. |
| ATS declarations | [ats_adapters.py][ats]: `GreenhouseBoardAdapter`, `LeverBoardAdapter`, and `AshbyBoardAdapter` fetch one response per invocation. Their parsers filter title/location and require usable description text. `WorkdayBoardAdapter._iter_postings` also exists, with offset/total pagination and a default 25-page cap; its listing metadata has an empty description. | [test_ats_adapters.py][ats-tests]: mapping, country-scoped remote rejection, loose title rejection, and parameterized serialized-null description cases. |
| Scheduled ATS production composition | [production_wiring.py][wiring]: `run_scheduled_ats_sources` and `_adapter_for_source` wire Greenhouse, Lever and Ashby; `_adapter_for_source` explicitly excludes `workday:`. Acquisition passes `query=""` per configured location, then applies all target queries locally and collapses repeated `(source_id, source_native_id, canonical_url)` keys within that source. The new-job limit applies during ingestion. Other source failures retain successful jobs and produce `DiscoveryRunFailed` evidence. | [wiring tests][wiring-tests]: `test_canonical_ats_scheduler_fetches_each_source_once_then_filters_queries`, `test_canonical_ats_limit_counts_new_jobs_not_existing_observations`, `test_canonical_ats_scheduler_preserves_successes_when_one_source_fails`. |
| Workday production acquisition | [workday.py][workday]: `run_workday_discovery` enumerates each employer with empty provider search text and local query specifications. `search_employer` uses 20-row offsets, a first-response total, page/result caps and title/location filters. `_workday_max_pages_per_employer` defaults to 25 without a new-job limit and 1 with a positive limit. `_search_and_fetch_one`, `fetch_details`, `scrape_employers`, and `store_results` then fetch details and persist accepted postings. Returned `found/new/existing` totals do not expose the pagination terminal reason. | [test_workday_discovery.py][workday-tests]: source-first expanded query filters, bounded page caps, missing/serialized-null description rejection before the storage limit, and parallel global new-job limits. |
| Smart Extract acquisition and admission | [smartextract.py][smart]: `build_scrape_targets` selects source-first or query targets. `_run_one_site` acquires page intelligence and runs JSON-LD, intercepted API, or CSS extraction selected through an LLM. `execute_api_response` consumes the first matching captured response; it does not traverse a provider cursor. `PASS/PARTIAL/FAIL` assess extracted row usability. `_run_all` and `_store_jobs_filtered` apply admission and a new-job limit; their totals count sites and persisted jobs, not exhausted provider pages. | [test_smartextract_discovery.py][smart-tests]: source capability targets, static-site filters, missing descriptions, relative URLs, ATS/content deduplication, and bundled/source browser behavior. |
| Broad-board provider boundary | [jobstreaming_gateway.py][gateway]: `JobStreamingGateway.open_stream` translates the pinned `jobstreaming==0.0.5` contract with explicit acknowledgement. `collect` is an in-memory compatibility collector without durable checkpoints. It retains failures, warnings and provider `SearchCompleteEvent.completed`; neither a compatibility frame nor that Boolean is a JobCtrl source-completeness summary. The [worker manifest][manifest] pins the dependency. | [test_jobstreaming_gateway.py][gateway-tests]: `test_collect_preserves_partial_results_and_projects_typed_failure`, `test_durable_stream_does_not_checkpoint_until_the_consumer_acknowledges`, event-key preservation. |
| Durable broad-board orchestration | [jobspy.py][jobspy]: `run_discovery` selects `_durable_full_crawl` for execution-scoped acquisition. It plans/claims units, stores or records filtered `JobEvent` results before `stream.ack`, records typed failures before their acknowledgement, and acknowledges `SearchCompleteEvent` before marking completion or retrying. A new-job limit marks the current/pending units skipped. Progress exposes provider `has_more`, raw items and emitted jobs diagnostically. | [test_jobstreaming_resumable_discovery.py][resume-tests]: store-before-ack replay, durable limits, cursor reset after error acknowledgement, healthy partial output, cancellation, progress privacy, and the Temporal worker-loss fixture. |
| Search-unit authority | [search_units.py][units] defines `DiscoverySearchSpec`, its immutable fingerprint, execution/unit identity and lease fields. [sqlite_search_unit_repository.py][unit-repo]: `plan_units`, `claim_next`, `fence_write`, and `save_checkpoint` preserve the immutable plan, lease attempt/epoch fencing and checkpoint compare-and-swap. `record_accepted_job` stores receipts by execution/unit/JobId; `record_filtered_result` hashes provider keys for replay-idempotent filtering. `execution_counts` sums receipt rows across units, not distinct JobIds. `execution_provider_job_count` reads checkpoint adapter `emitted_count`; its `rawTotal` is acknowledged provider-emitted unique jobs, not every upstream row or HTTP page. | [test_discovery_search_units.py][unit-tests]: plan conflict, checkpoint compare-and-swap/reclaim fencing, deferred reset, late cancel fencing, new receipts and audit repair. |
| Canonical job admission | [use_cases.py][use-cases]: `DiscoverJobsUseCase.execute` owns identity resolution, acceptance decisions, source observations and duplicate links. Its `total` counts ingestion decisions. [sqlite_repository.py][job-repo]: `save`, `claim_new_job`, and observation side effects preserve canonical JobId and record accepted search-unit receipts under the current fence. Repeated observations and new jobs are different quantities. | [wiring tests][wiring-tests] and [Smart Extract tests][smart-tests] cover intake/deduplication; [unit tests][unit-tests] cover `test_job_write_and_new_receipt_share_the_fenced_repository_path` and replay. |
| Quality and acceptance reads | [source_quality.py][quality]: `project_source_quality` folds durable events into run/quality projections, preserving failed-source quarantine during partial completion. [production_wiring.py][wiring]: `build_discovery_acceptance_report` counts tenant observations and downstream evidence; it does not establish attempted source/query exhaustion. `adapter_fetch_span` instrumentation in [adapter_spans.py][spans] is diagnostic. | [test_source_quality_projection_pr4.py][quality-tests]: event aggregation, failed-source quarantine and `test_source_quality_does_not_reset_failed_sources_on_partial_completion`; [wiring tests][wiring-tests]: the acceptance-report fixture. |
| Transport and policy | [production wiring][wiring] selects guarded HTTP or connected extension transport; execution-scoped ATS refuses an injected HTTP override. [http_client.py][http] returns `None` for a disallowed fetch; [live_browser.py][live] owns connected transport selection and its guarded client. [politeness.py][politeness] and [source_registry.py][registry] own request budgets, host pacing/concurrency and policy. Current robots policy is ignored; old comments claiming robots enforcement are stale. Broad-board internal traversal remains provider-owned. | [test_optional_extension.py][extension-tests], [test_gateway_http_client.py][http-tests], [test_politeness_gateway.py][policy-tests], plus the execution-scoped ATS and Smart Extract fixtures in the suites above. These additional tests were inspected, not executed here. |

The canonical explanations remain [Discovery](../user/discovery.md),
[Storage](storage.md), [Data, Events & Projections](data-events-and-projections.md),
and [Contracts, Types & API Boundaries](contracts-types-and-api-boundaries.md).
This proposal preserves their ownership; historical plans do not supersede
the current execution paths listed above.

### Observed gaps

These are existing behaviors to account for, not production fixes delivered by
this page. Each measurement is identified in the next section.

- `search_employer` returns a list without a terminal reason. In the probe,
  an early empty second page and an exception after the first page both return
  20 rows. The error is logged and caught within the search loop, so callers
  cannot recover its termination reason from the returned list. An initial
  empty response with a positive total also returns zero rows.
- Workday defaults a missing first-response total to zero. The probe stops
  after one 20-row page. Offsets advance by the requested page size, not the
  number of received rows. A provider total or an empty page needs validated
  semantics before either can prove exhaustion.
- Workday checks the total and page cap before `max_results`. The direct
  helper returns 1 row when a second page would remain but 20 when the first
  page reaches total, with `max_results=1` in both probes. Production
  `_search_and_fetch_one` passes `max_results=0` and applies the new-job limit
  later; this is a helper-level edge case, not evidence of an integrated
  storage-limit violation.
- A Greenhouse `scrape` returns zero for valid empty jobs, missing jobs and
  blocked `None` in the iterator probe. All three ATS adapters have analogous
  falsey-payload defaults in source, but only Greenhouse was executed here.
  The transport still owns diagnostic blocked-fetch evidence; the list does
  not carry it.
- Smart Extract's measured `FAIL` is identical for empty acquisition,
  malformed API item shape and a blocked rendered-page result. Conversely,
  `PASS` describes one usable extracted row, without evidence that more rows
  do not exist. A dictionary description is stringified into nonempty text by
  `_usable_description_text`; the probe demonstrates conversion, not content
  validation or an actual persisted malformed job.
- Local filters and repeated rows change cardinality independently of
  acquisition coverage: Workday returns 8 from 20 title/location fixtures;
  two identical paths remain two list entries. Scheduled ATS collapses keys
  before admission, while durable broad-board acceptance counts come from
  receipts. These quantities cannot be treated as a common provider total.
  The read-only receipt fixture also shows 3 accepted receipts across two
  units for 2 distinct fixture jobs; current execution totals count receipts.
- Existing lifecycle completion and provider completion are useful evidence,
  but source inspection finds no shared versioned contract recording bounded
  scope, exhaustion proof and terminal reason across these families. Existing
  completed run/search-unit states must retain their current meanings.

## Synthetic evidence

### Execution record and limitations

Executed on 2026-10-05 against the revision above with `python3`
(CPython 3.9.6; the separate uv attempt selected CPython 3.14.7).
All fixture URLs use `fixture.invalid`; transports, page
intelligence and LLM results are injected. No external source was crawled,
no credential or profile was read, and no application was submitted.
Acquisition probes use no database. The receipt-count read uses a disposable
in-memory SQLite fixture; its setup does not access any application workspace.

The harness compiles actual functions extracted through Python's abstract
syntax tree (AST). It executes the full standard-library title/location helper
files, disables profile-backed title feedback, and supplies no LLM adjudicator.
The Greenhouse conversion step is an identity stub: it measures iterator/HTTP
default behavior only, not ATS parsing or description acceptance. Smart Extract
uses actual API extraction and reporting functions with synthetic collection
and strategy selection. It does not exercise Playwright, a connected browser,
LLM spend or a real provider.

**AST-extracted functions and synthetic HTTP/title matching do not prove
gateway, persistence, or Temporal behavior.** Observed distinct paths are not
canonical JobIds, observations are not receipts, and the probe does not measure
real persisted/new-job counts. A separate read-only `execution_counts` call
over three preloaded receipt rows measures receipt aggregation: two units
reference the same fixture job, so accepted receipts are 3 and distinct jobs 2.
Its minimal table, synthetic string IDs and absent lease/write path do not
validate the current schema, canonical identity, persistence or replay safety.
The owning integration regressions remain required.
No earlier intake probe output was supplied with this task; this section records
new measured output and does not invent intake evidence.

Run from the repository root at the inspected revision. Save the following
block as `probe.py` in an owned temporary directory, then execute:

```sh
git rev-parse HEAD
python3 --version
python3 /path/to/owned/probe.py
```

The fixture inputs and extraction choices are included in full so the results
can be independently reproduced without installing worker dependencies.

```python
import ast
import json
import logging
from pathlib import Path
from types import SimpleNamespace
import threading
import time
from contextlib import nullcontext

root = Path.cwd() / 'workers/automation/src/jobctrl'
logging.disable(logging.CRITICAL)

def extracted(path, names, namespace, owner=None):
    tree = ast.parse((root / path).read_text())
    nodes = tree.body if owner is None else next(
        n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == owner
    ).body
    selected = [n for n in nodes if isinstance(n, ast.FunctionDef) and n.name in names]
    assert {n.name for n in selected} == set(names)
    module = ast.Module(body=[ast.ImportFrom(module='__future__', names=[
        ast.alias(name='annotations')], level=0), *selected], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), str(root / path), 'exec'), namespace)

title = {}
exec((root / 'discovery/title_filter.py').read_text(), title)
# Never read profile-backed feedback or invoke an LLM adjudicator.
title['_approved_role_feedback_title_patterns'] = lambda: ()
location = {}
exec((root / 'infrastructure/discovery/location_filter.py').read_text(), location)

class SyntheticCanceled(Exception):
    pass

wd = dict(log=logging.getLogger('probe'), TransientNetworkError=SyntheticCanceled,
          title_matches_query=lambda t, q: title['title_matches_query'](t, q, role_matcher=None),
          location_matches_target=location['location_matches_target'])
extracted('discovery/workday.py', ['search_employer', '_location_ok',
          '_positive_int', '_workday_max_pages_per_employer'], wd)

def posting(i, title='Director of Engineering', location='Madrid, Spain'):
    return dict(title=title, locationsText=location, externalPath=f'/job/{i}')

page = [posting(i) for i in range(20)]

def workday_case(name, responses, **options):
    offsets = []
    responses = iter(responses)
    def fetch(*args, **kwargs):
        offsets.append(kwargs['offset'])
        value = next(responses)
        if isinstance(value, Exception):
            raise value
        return value
    wd['workday_search'] = fetch
    args = dict(accept_locs=['Spain'], reject_locs=['USA'])
    args.update(options)
    try:
        jobs = wd['search_employer']('fixture', {'name': 'Synthetic'},
                                      'Director of Engineering', **args)
        output = dict(returned=len(jobs), distinct_paths=len({j['external_path'] for j in jobs}))
    except Exception as exc:
        output = dict(raised=type(exc).__name__)
    print(name, json.dumps(dict(offsets=offsets, **output), sort_keys=True))

workday_case('wd-total-end', [dict(total=40, jobPostings=page),
                            dict(total=40, jobPostings=[posting(i) for i in range(20, 40)])])
workday_case('wd-cap', [dict(total=1000, jobPostings=page)], max_pages=1)
workday_case('wd-empty-first', [dict(total=40, jobPostings=[])])
workday_case('wd-empty-after', [dict(total=40, jobPostings=page), dict(total=40, jobPostings=[])])
workday_case('wd-error-after', [dict(total=40, jobPostings=page), RuntimeError('synthetic')])
workday_case('wd-missing-total', [dict(jobPostings=page)])
workday_case('wd-limit-before-end', [dict(total=40, jobPostings=page)], max_results=1)
workday_case('wd-limit-at-end', [dict(total=20, jobPostings=page)], max_results=1)
filtered = [posting(i) for i in range(8)] + [posting(i, title='Designer') for i in range(8, 18)]
filtered += [posting(i, location='Remote, United States') for i in range(18, 20)]
workday_case('wd-local-filter', [dict(total=20, jobPostings=filtered)])
workday_case('wd-repeat', [dict(total=2, jobPostings=[posting(1), posting(1)])])
canceled = threading.Event()
canceled.set()
workday_case('wd-canceled', [], cancel_event=canceled)
print('wd-default-caps', json.dumps({str(limit): wd['_workday_max_pages_per_employer']({}, limit=limit)
                                   for limit in (0, 1)}, sort_keys=True))

# Exercise HTTP/list termination only; conversion is an identity stub.
ats = dict(adapter_fetch_span=lambda **kw: nullcontext(), log=logging.getLogger('probe'))
extracted('infrastructure/discovery/ats_adapters.py', ['scrape'], ats, 'GreenhouseBoardAdapter')
for name, payload in [('ats-empty', {'jobs': []}), ('ats-blocked-none', None),
                      ('ats-missing-jobs', {}), ('ats-repeat', {'jobs': [posting(1), posting(1)]})]:
    calls = []
    def fetch(url):
        calls.append(url)
        return payload
    adapter = SimpleNamespace(_source_id='greenhouse:fixture', url='https://fixture.invalid/jobs',
                              _http=fetch, _to_scraped=lambda raw, **kw: raw)
    jobs = ats['scrape'](adapter, tenant_id='local', query='', location='Spain')
    print(name, json.dumps(dict(fetches=len(calls), returned=len(jobs)), sort_keys=True))

smart = dict(log=logging.getLogger('probe'), time=time, json=json,
             TransientNetworkError=SyntheticCanceled,
             _NULL_DESCRIPTION_SENTINELS={'<na>', 'nan', 'nat', 'none', 'null'})
extracted('discovery/smartextract.py', ['_usable_description_text', '_job_description_text',
          'resolve_json_path_raw', 'resolve_json_path', 'execute_api_response',
          '_empty_page_intelligence', '_raise_if_canceled', '_run_one_site'], smart)
plan = {'strategy': 'api_response', 'extraction': {'url_pattern': '/jobs', 'items_path': 'jobs',
        'title': 'title', 'url': 'url', 'description': 'description'}}
smart.update(STRATEGY_PROMPT='{briefing}', format_strategy_briefing=lambda intel: 'synthetic',
             ask_llm=lambda prompt: ('{}', 0, {'response_chars': 2}), extract_json=lambda raw: plan)
for name, raw_data in [('smart-empty', {'jobs': []}), ('smart-malformed-items', {'jobs': {}}),
                       ('smart-good', {'jobs': [{'title': 'Director of Engineering',
                        'url': 'https://fixture.invalid/1', 'description': 'Synthetic text'}]}),
                       ('smart-missing-description', {'jobs': [{'title': 'Director of Engineering',
                        'url': 'https://fixture.invalid/1'}]})]:
    intel = smart['_empty_page_intelligence']('https://fixture.invalid')
    intel['api_responses'] = [{'url': 'https://fixture.invalid/jobs', '_raw_data': raw_data}]
    smart['collect_page_intelligence'] = lambda url: intel
    smart['judge_api_responses'] = lambda responses: responses
    result = smart['_run_one_site']('Synthetic', 'https://fixture.invalid')
    print(name, json.dumps({key: result[key] for key in ('status', 'total', 'titles')}, sort_keys=True))
browser = SimpleNamespace(rendered_page=lambda *args, **kwargs: None)
result = smart['_run_one_site']('Synthetic', 'https://fixture.invalid', browser_client=browser)
print('smart-blocked-none', json.dumps({key: result[key] for key in ('status', 'total', 'titles')}, sort_keys=True))
values = [None, '', 'null', '<NA>', 'Synthetic text', {'unexpected': 'shape'}]
print('smart-description-values', json.dumps([smart['_job_description_text']({'description': v})
                                            for v in values]))

# Read existing synthetic receipt rows; this does not exercise the write path.
import sqlite3
receipt = {}
extracted('infrastructure/discovery/sqlite_search_unit_repository.py',
          ['_execution_params'], receipt)
extracted('infrastructure/discovery/sqlite_search_unit_repository.py',
          ['execution_counts'], receipt, 'SqliteDiscoverySearchUnitRepository')
with sqlite3.connect(':memory:') as conn:
    conn.execute('CREATE TABLE discovery_search_unit_jobs (tenant_id, discover_workflow_id, '
                 'discover_run_id, unit_id, job_id, was_new)')
    rows = [('local', 'fixture-workflow', 'fixture-run', 'a', 'job-1', 1),
            ('local', 'fixture-workflow', 'fixture-run', 'b', 'job-1', 0),
            ('local', 'fixture-workflow', 'fixture-run', 'b', 'job-2', 0)]
    conn.executemany('INSERT INTO discovery_search_unit_jobs VALUES (?, ?, ?, ?, ?, ?)', rows)
    execution = SimpleNamespace(tenant_id='local', workflow_id='fixture-workflow',
                                temporal_run_id='fixture-run')
    result = receipt['execution_counts'](SimpleNamespace(_conn=conn), execution)
    print('receipt-counts', json.dumps(result, sort_keys=True))
    print('receipt-distinct-fixture-jobs', conn.execute(
        'SELECT COUNT(DISTINCT job_id) FROM discovery_search_unit_jobs').fetchone()[0])
```

### Actual output

```text
wd-total-end {"distinct_paths": 40, "offsets": [0, 20], "returned": 40}
wd-cap {"distinct_paths": 20, "offsets": [0], "returned": 20}
wd-empty-first {"distinct_paths": 0, "offsets": [0], "returned": 0}
wd-empty-after {"distinct_paths": 20, "offsets": [0, 20], "returned": 20}
wd-error-after {"distinct_paths": 20, "offsets": [0, 20], "returned": 20}
wd-missing-total {"distinct_paths": 20, "offsets": [0], "returned": 20}
wd-limit-before-end {"distinct_paths": 1, "offsets": [0], "returned": 1}
wd-limit-at-end {"distinct_paths": 20, "offsets": [0], "returned": 20}
wd-local-filter {"distinct_paths": 8, "offsets": [0], "returned": 8}
wd-repeat {"distinct_paths": 1, "offsets": [0], "returned": 2}
wd-canceled {"offsets": [], "raised": "SyntheticCanceled"}
wd-default-caps {"0": 25, "1": 1}
ats-empty {"fetches": 1, "returned": 0}
ats-blocked-none {"fetches": 1, "returned": 0}
ats-missing-jobs {"fetches": 1, "returned": 0}
ats-repeat {"fetches": 1, "returned": 2}
smart-empty {"status": "FAIL", "titles": 0, "total": 0}
smart-malformed-items {"status": "FAIL", "titles": 0, "total": 0}
smart-good {"status": "PASS", "titles": 1, "total": 1}
smart-missing-description {"status": "FAIL", "titles": 1, "total": 1}
smart-blocked-none {"status": "FAIL", "titles": 0, "total": 0}
smart-description-values [null, null, null, null, "Synthetic text", "{'unexpected': 'shape'}"]
receipt-counts {"accepted": 3, "existing": 2, "new": 1}
receipt-distinct-fixture-jobs 2
```

`wd-total-end` reaches the fixture's declared 40-row total; it measures offset
behavior, not live Workday snapshot consistency. `wd-cap` uses total 1000 and a
one-page cap. `wd-empty-after` and `wd-error-after` use total 40 and interrupt
after 20 rows. `wd-local-filter` supplies eight matching Spain rows, ten wrong
titles and two United States remote rows. `wd-repeat` supplies the same path
twice. Smart Extract's inputs include valid empty and non-list `jobs`, one
usable row, one row without description, and blocked `None`.
These are measured current outcomes. They are not passing tests of the future
contract and do not establish public provider pagination semantics.

### Local check evidence at the implementation checkpoint

Reports are outside tracked feature paths in the task-owned temporary directory
`/tmp/jobctrl-1025-implement.Q4zblT`. They are local handoff artifacts, not a
published runtime dependency. Preserve them through independent review/QA;
the reproducible script and its measured outputs above survive cleanup.

| Check | Observed result | Limitation / remaining gate |
| --- | --- | --- |
| Synthetic probe | Executed; 24 output records, preserved above. | Partial function-level evidence only. |
| Focused document evidence | Exact headings/issue, 29 source/test paths, 43 owning function/class symbols, named tests and relative documentation links checked; the embedded probe reproduces all 24 exact outputs. | Source existence and self-reproduction do not replace independent review/QA or site link checks. |
| Configured scripts recipe | Exit 1: JUnit records 86 entries, 81 passing, 5 failures, 0 skipped. One brace-expansion case lacks its installed module; four distribution files fail loading missing `ajv`. | Four entries are file-load failures, not executed test cases. No full scripts pass is claimed; rerun after controller dependency preparation. |
| Focused locked worker regressions | Did not execute: `uv run --no-sync --locked --all-extras` could not spawn `pytest`; the empty checkout-local virtual environment it created was removed at handoff. | All eight suites below remain pending, including any Temporal fixture/skips. Dependency preparation is controller-owned. |
| Docs build | Installer asset parity passed; build stopped at `vitepress: command not found` with no `node_modules`. | Source dead-link checking, emitted links and redirects did not run. Final page build remains pending. |
| Rendered documentation | Not executed because the site could not build. | Runtime gate and direct desktop/mobile inspection remain pending; no screenshot or browser-error pass is claimed. |
| Diff scope and whitespace | `git diff --check`, `git diff --check origin/main...HEAD`, and `git diff --no-index --check /dev/null docs/architecture/discovery-source-completeness.md` passed. Status shows only this new page; HEAD remains the inspected revision. | The committed-range check cannot cover this uncommitted page; the direct no-index check does. Final committed exact-head scope/CI belongs to the controller. |

The configured script command from `scripts/checks.toml` was:

```sh
sh -c 'exec node --test --test-reporter=junit --test-reporter-destination="$1" scripts/*.test.mjs' \
  jobctrl-scripts /tmp/jobctrl-1025-implement.Q4zblT/scripts.xml
```

The worker command deliberately avoided dependency preparation in this role:

```sh
env -u UV_PROJECT_ENVIRONMENT -u VIRTUAL_ENV -u UV_EXCLUDE_NEWER \
  -u UV_EXCLUDE_NEWER_PACKAGE uv run --project workers/automation \
  --no-sync --locked --all-extras --exclude-newer false pytest -q \
  workers/automation/tests/test_ats_adapters.py \
  workers/automation/tests/test_discovery_production_wiring.py \
  workers/automation/tests/test_workday_discovery.py \
  workers/automation/tests/test_smartextract_discovery.py \
  workers/automation/tests/test_discovery_search_units.py \
  workers/automation/tests/test_jobstreaming_gateway.py \
  workers/automation/tests/test_jobstreaming_resumable_discovery.py \
  workers/automation/tests/test_source_quality_projection_pr4.py \
  --junitxml=/tmp/jobctrl-1025-implement.Q4zblT/worker.xml
```

## Future architecture, not implemented

### Minimal additive completion contract

Propose a JobCtrl-owned `AcquisitionCompletionSummary`, version 1, produced
for one bounded acquisition attempt. This is a design name, not an existing
type, event, table or endpoint. Keep existing lists, run counts and lifecycle
states compatible; add the summary beside them rather than reinterpreting them.

| Proposed field group | Meaning and invariants |
| --- | --- |
| `schema_version` and identity | Version 1; tenant, Discover execution, source ID/family, acquisition ID and attempt revision. Reference an existing search-unit ID when applicable. Stable replay identity is separate from an operational activity/run ID. An orchestrator may resume one acquisition across activity retries; a deliberate new acquisition gets a new identity. |
| `scope` | Source registry identity/revision, provider/employer or board identity, adapter/provider contract version, provider query, provider location, original target location, time/remote filters, and fingerprints of local query/acceptance policy. Record effective page/result/request/time bounds and transport kind. An empty provider query means source-first enumeration, not a missing local filter. Raw queries and URLs stay in authorized local canonical state; events/projections expose safe references and hashes. |
| `execution_outcome` | `succeeded`, `failed`, `blocked`, `canceled`, or `skipped`. Describes whether execution met its declared operational bound. A cap can be an operational success while coverage remains partial. Persisting rows does not turn a failed attempt into success. |
| `coverage` | `exhausted`, `partial`, or `unknown`. Exhausted requires affirmative adapter-owned evidence for the declared scope. Partial means a known boundary prevented exhaustion; unknown means evidence is absent, ambiguous or unsupported. Missing legacy evidence stays unknown, even when lifecycle status is completed. |
| `terminal_reason` | One explicit reason: validated cursor end, validated total reached, validated complete response, page cap, provider result cap, JobCtrl new-job cap, request budget, deadline, canceled, transport blocked, transport error, malformed response, unsupported semantics, or not scheduled. Keep a safe typed error code when relevant. Never use empty output or a yield ratio as the reason. |
| `counts` | Separately name upstream raw rows observed (including repeats), provider-emitted unique jobs when available, caller-filtered events/rows with reason buckets, local eligible rows, repeated source observations, and durable accepted/new/existing receipt counts. Each count carries its counting unit and provenance; unsupported measurements are null/unknown, never guessed zero. Include fetched pages/requests only where the adapter actually observes them. |
| `provider_total` | Nullable value with units, scope, provider/version and observation time; identify whether it is exact, approximate or unstable. Do not compare a board-wide total to locally eligible or persisted jobs. Contradictory totals invalidate total-based exhaustion evidence. |
| `exhaustion_evidence` | Bounded typed proof: validated response shape plus a contract/version permitting a complete response; cursor-end fact; or comparable total and traversal accounting. Include safe response/checkpoint references, request fingerprint and acknowledgement revision. Do not copy HTML, job text, credentials, browser state or raw resume cursors into product events/telemetry. |
| Temporal context | Started/finished timestamps and observation window. Exhaustion describes traversal observed during that interval, not a perpetual or atomic market snapshot. Record a known snapshot token only if a provider supports it; otherwise state the consistency limitation. |

Raw, filtered and persisted counts are not interchangeable. Filter buckets
must use an explicit counting order or overlapping labels with no claim they
sum to the raw total. Distinct eligible rows can map to the same canonical
JobId, and receipt uniqueness is execution/unit/JobId rather than HTTP-row
uniqueness. Preserve existing execution receipt totals. If the new summary
reports distinct
canonical Jobs across units, expose a separate deduplicated count; never present
the sum of unit receipts as distinct execution jobs.
For JobStreaming, the current checkpoint `emitted_count` remains
provider-emitted count; do not rename it to upstream rows inspected.

`exhausted` does not assert description validity or successful persistence.
A fully acquired response followed by a persistence failure can retain proven
acquisition coverage with outcome `failed` and incomplete persistence counts.
Incomplete persistence must remain visible and retryable; consumers must not
label that case a fully successful discovery run. Complete-empty means validated
exhaustion with zero upstream jobs, not zero jobs accepted after filtering or
deduplication. Exhausted-but-filtered-empty has nonzero raw rows and separate
rejection counts.

### Classification rules and unresolved provider semantics

| Evidence / stop | Proposed classification |
| --- | --- |
| Validated complete empty response or validated cursor end with zero raw jobs | `succeeded / exhausted`; complete-empty. |
| Validated traversal exhausted, all rows filtered or already known | `succeeded / exhausted`; counts explain filtered-empty or existing-only persistence. |
| Page/provider result/new-job cap, budget or deadline before end proof | Coverage `partial`, with the specific reason; retain rows already accepted. If no acquisition occurred, counts can be zero and the scheduled unit is skipped. |
| Transport policy refuses acquisition | Outcome `blocked`; coverage `unknown` before any acquisition, `partial` after confirmed pages. Do not call it empty. |
| Error after confirmed rows | Outcome `failed`, coverage `partial`; keep accepted rows and safe error evidence. |
| Missing total, early empty page contradicting a total, malformed shape, unexplained short page | No total-based exhaustion. Coverage `unknown` unless a known remaining boundary establishes partial coverage; outcome records malformed response/failure where appropriate. |
| Cancellation | Outcome `canceled`; coverage `partial` after rows, otherwise `unknown`. Already accepted rows survive. Proven acquisition-end evidence may survive cancellation during a later persistence step, but does not make the attempt operationally successful. |
| Legacy completed state or unsupported adapter semantics | Coverage `unknown`; retain old lifecycle state and explain unsupported evidence. |

Initial assumption: a single complete response may support Greenhouse/Lever/Ashby
exhaustion only after the implementation slice validates the relevant public
contract and response shape for that board and version. Current adapter comments
and these synthetic responses are not sufficient public-provider proof.
Workday totals are provisionally advisory until stable scope, missing-total,
short-page and changing-total semantics are validated. Smart Extract cannot
claim exhaustion from its current one-page intelligence or LLM extraction
quality alone. JobStreaming owns internal provider traversal: inspect and
translate its pinned terminal semantics before allowing an exhausted label;
`completed=true` and `has_more=false` alone are insufficient without that
contract and the applicable cap/failure evidence.

These are reversible design assumptions: version 1 prefers unknown to an
unsupported completeness claim, uses the smallest source/query/location attempt,
and avoids a market-wide percentage. A count/provider-total ratio can be a
diagnostic only when both use the same units and scope; it is never an
exhaustion criterion by itself. Provider semantics and snapshot consistency
remain follow-up evidence work, not results measured in this investigation.

### Ownership, compatibility and preservation

Adapters own acquisition evidence and terminal reasons. Discovery orchestration
owns scope identity, local filters, cancellation and finalization. Canonical
job identity, observations, accepted jobs, enrichment snapshots, and accepted
materials stay with their existing owners. Completion evidence must not change
deduplication, relax description admission, withdraw accepted artifacts, alter
source registry state, or silently increase budgets to obtain a complete label.
No submission, auto-apply or profile/database cleanup is authorized by a
completion status.

Propose canonical local persistence for acquisition attempts under Discovery,
separate from rebuildable quality/read projections. The physical schema and
migration are deferred to a separately authorized slice; this page introduces
no current table or column. Failed refreshes retain the last accepted jobs,
artifacts and prior successful completion evidence as history. A newer failed
attempt is shown separately, with its scope/time, rather than replacing an
earlier accepted result with an apparently complete zero.

For execution-scoped broad boards, preserve the existing immutable plan, lease
attempt/epoch, stale-owner rejection, receipt idempotency and checkpoint
compare-and-swap. Do not acknowledge a provider job before its durable admission
or filtered receipt. Do not move acknowledgement into the gateway. Provider
terminal evidence must be durably staged before acknowledgement, then finalized
under the same fence after the acknowledged revision is known. Crash/replay
between those steps must repair finalization without double counting; an old
owner must be unable to finalize a newer attempt. Cursor-reset intent stays
behind error acknowledgement and reclaim, as today. Do not rewrite old frozen
plans merely to attach version 1.

Preserve connected-extension preference, guarded anonymous transports, public
destination/access-control checks, current robots policy, per-host limits,
invocation-level broad-board accounting and cancellation. Completion evidence
must not cause external probes, extra detail requests, proxy bypasses or access
control circumvention. Keep safe identifiers/counts in events, with sensitive
canonical context local and authorized. Telemetry remains diagnostic; neither
spans nor browser caches can supply missing canonical completion state.

Future domain events/types must have Python/TypeScript parity, durable producers,
projection folds and frontend invalidation coverage as required by
[Data, Events & Projections](data-events-and-projections.md). A summary projection
is derived from canonical attempt evidence plus durable counts; it is not a
new command authority. API/UI consumers preserve legacy fields, display unknown
for absent/unsupported versions, distinguish latest attempt from last accepted
result, and show scope, time and counting units alongside coverage. Reject
invalid new writes; tolerate unsupported read versions without upgrading them
to exhausted. No endpoint or event name is committed by this design.

### Future acceptance cases

These are required implementation proofs, **not executed tests of this page**.

| Case | Required future observation |
| --- | --- |
| Exact empty and nonempty exhaustion | Validated provider end proof yields exhausted with correct scope/interval and raw counts, including zero. No whole-market claim. |
| Local filtering, descriptions and duplicate rows | Acquisition evidence remains independent of title/location rejects, missing/malformed descriptions, repeated observations and canonical deduplication. Counters disclose their units and missing measurements. |
| Page/result/new-job caps | A still-open traversal remains partial; cap precedence is explicit. Reproduce both Workday helper limit-order cases and verify the production new-job limit separately. Existing jobs do not consume that new-job cap. |
| Missing/changing totals and early empty | No false exhausted label; preserve received rows, contradictions and unsupported semantics. Include short and repeated pages. |
| Blocked transport, timeouts, malformed response | Complete-empty is never substituted for blocked/failed/unknown; reproduce errors both before and after partial acquisition. |
| Cancellation and budgets | Stop without extra requests, keep durable accepted work, and expose the terminal reason. Pending units stay distinct from attempted units. |
| Store/ack/finalize crash windows | Kill after persistence before ack, after error ack before cursor reset, and after terminal ack before summary finalization. Replay repairs state with stable counts and rejects stale leases. |
| Partial peer success | One failing source does not remove a healthy source's accepted jobs or reset failed-source quarantine; per-attempt evidence remains attributable. |
| Persistence failure after exhausted acquisition | Preserve exhaustion proof but show failed execution and incomplete receipt counts; retain accepted artifacts and repair safely on retry. |
| Compatibility and privacy | Legacy/unsupported summary versions remain unknown; frozen search plans stay stable. Events, projections, SSE and telemetry expose no content, credentials, raw cursors or private profile/query text. |
| Projection/API/consumer parity | Rebuild from canonical evidence; Python/TypeScript agree, invalidation triggers refetch, and empty/capped/failed/latest-versus-prior distinctions render correctly. |

### Separately authorized implementation scope

1. Validate each provider's exhaustion semantics and add adapter summaries with
   hermetic malformed/empty/cap/partial-error fixtures. Update the owning
   Discovery and acquisition documentation before changing supported behavior.
2. Add orchestration scope and attempt finalization while preserving Workday,
   scheduled ATS, Smart Extract and JobStreaming ownership. Cover cancellation,
   budgets, new-job limits and source-peer success independently.
3. Design canonical attempt persistence/migration and replay-safe finalization;
   extend existing fencing and receipt paths. Update Storage and pipeline
   reliability owners and prove failure/rollback preservation.
4. Add the domain contract, Python/TypeScript event/type parity, safe payloads
   and diagnostic telemetry; update Contracts, Types & API Boundaries and
   Data, Events & Projections.
5. Add derived projections/API reads and consumer presentation without
   reinterpreting lifecycle completion. Update the owning API, read-model and
   user Discovery references; prove rendering, accessibility and invalidation.

Each production slice requires separate authorization and owning documentation
updates. This investigation does not implement or close #1025 as a production
feature.

### Remaining delivery gates

The controller prepares frozen dependencies, reruns the configured scripts,
executes the eight locked worker suites above with actual passed/failed/skipped
counts, and runs `corepack pnpm docs:build`. The build must pass source dead-link,
installer parity, emitted-link and redirect checks. After that, run
`corepack pnpm docs:check:runtime` and inspect
`/architecture/discovery-source-completeness` directly in a fresh owned preview:
the existing runtime gate's page list does not include this page. Capture
desktop/mobile rendered evidence outside tracked paths; check all three exact
headings, table readability/scrolling, issue/source links, browser errors and
failed requests. No shared navigation edit is included in this task.

Require independent review of source ownership, compatibility, claims,
assumptions and privacy boundaries, and independent QA reproduction of this
script and the rendered page. Resolve every Blocker/High before publication.
Run `git diff --check` and configured `git diff --check origin/main...HEAD`;
confirm the final committed feature diff contains only this page and no private
artifacts. The implementation role leaves source uncommitted; the controller
creates and validates the author-signed Conventional Commit.

The controller publishes one PR referencing #1025 without an implementation-
closing keyword and leaves it open/unmerged. Enumerate actual required checks
and verify them on the final PR head; workflow names such as Docs Site, Repo
Scripts, Release Privacy Gate and conditional DCO are clues, not branch
protection readback. Read back the final head, open/unmerged state, issue
tracking and assignee state. Preserve task evidence until review/QA finish,
then remove disposable resources and stop only task-owned previews. No sibling
checkout or external tracking state is owned by this implementation role.

[runner]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/pipeline/runner.py
[ats]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/discovery/ats_adapters.py
[wiring]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/discovery/production_wiring.py
[workday]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/discovery/workday.py
[smart]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/discovery/smartextract.py
[gateway]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/discovery/jobstreaming_gateway.py
[manifest]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/pyproject.toml
[jobspy]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/discovery/jobspy.py
[units]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/discovery/search_units.py
[unit-repo]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/discovery/sqlite_search_unit_repository.py
[use-cases]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/discovery/use_cases.py
[job-repo]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/discovery/sqlite_repository.py
[quality]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/projections/source_quality.py
[spans]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/observability/adapter_spans.py
[http]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/network/http_client.py
[live]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/discovery/live_browser.py
[politeness]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/infrastructure/network/politeness.py
[registry]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/src/jobctrl/domain/discovery/source_registry.py
[wiring-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_discovery_production_wiring.py
[ats-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_ats_adapters.py
[workday-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_workday_discovery.py
[smart-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_smartextract_discovery.py
[gateway-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_jobstreaming_gateway.py
[resume-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_jobstreaming_resumable_discovery.py
[unit-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_discovery_search_units.py
[quality-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_source_quality_projection_pr4.py
[extension-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_optional_extension.py
[http-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_gateway_http_client.py
[policy-tests]: https://github.com/ebarti/JobCtrl/blob/67b4175aa2d9e8f96e62da545886b1e8712bf691/workers/automation/tests/test_politeness_gateway.py
