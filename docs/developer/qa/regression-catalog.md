# Regression Catalog

Use this page when a change touches a product invariant with costly failure.
Choose the risk family first; the
[complete checklist](complete-checklist.md#high-risk-regression-areas) maps each
individual regression to exact test files.

## Risk Families

| Boundary | What must remain true | Proof shape |
| --- | --- | --- |
| Apply safety | Model-driven browsers never own final submit and direct use-case/saga/adapter calls fail closed; their prompt contains no profile, job-description, resume, cover-letter, generated prose, or local artifact paths; reviewed materials are not staged in the agent worker; artifact upload, generic form entry, credentials, and verification-code tools are explicitly denied and absent from the default MCP configuration; no owned email send occurs without exact approval; every Apply page/request stays on the reviewed canonical origin; dry-run grants only one exact reviewed initial navigation, records it, and cannot write; only one exact dedicated terminal result record affects state, and a model-only dry-run claim remains partial evidence; owned submit intent is at most once; confirmed prior applications block or require an evidence-bound one-attempt confirmation. | Apply use-case/saga/adapter tests plus a disposable browser harness. |
| Durable workflows | Accepted work resumes or terminalizes correctly across restart, cancellation, and history loss. | Workflow tests plus targeted fault injection. |
| Storage and projections | Schema versions are guarded; canonical writes and read projections agree; accepted artifacts survive retries, including failed cover-letter refreshes whose rejected bytes remain on separate audit paths; the explicit job-data purge backs up first, clears the Job/generated-material and job/Discovery execution boundary (including stale retry manifests, source-quality summaries, job-stage operational attempts, and projection-rebuilding events), and proves profile/search/template/settings plus unrelated-history preservation. | Repository/projection tests, guarded purge fixtures, and API readback. |
| Credentials and privacy | Secrets, profile content, raw mail, contact values, paths, and artifacts do not leak into settings, events, logs, or projections. | Boundary tests plus response/event inspection. |
| Scoring and materials | Evidence, policy version, provenance, judge output, and fabrication gates remain inspectable and honest; all semantic findings come from cited, persisted model determinations. Retries use the model findings bound to their line and source IDs. Cover generation never treats job-post facts as candidate evidence. | Opposite model-verdict tests, distinct failure/preservation checks, canonical prompt boundaries, and product-path inspector QA. No eval sets, baselines or recorded model-output replay. |
| Frontend state | URL/server/client state stay in their owning layers; every event and stage state has a handler/rendering path. | Hook/component/type tests plus parity tests. |
| Rhea/Base UI system | Tokens, cards, statuses, accessible primitive behavior, and route parity remain coherent across theme, density, and viewport. | Token/boundary tests, focused wrapper tests, route visual QA, and the browser matrix. |
| Pipeline operations | Execution topology, privacy, refresh behavior, ETA, freshness, queue, and capacity remain truthful and separately inspectable. | API/read-model tests, deterministic fixtures, invalidation/polling tests, and browser observation. |
| Provider/browser setup | Environment ownership and passive detection cannot silently become credential or browser adoption. Extension pairing-token presence remains distinct from one explicitly selected installation's fresh live heartbeat; another Chrome profile with the token cannot lease. Integrated Discovery and Enrich prefer the selected connected extension or choose guarded public HTTP/anonymous Playwright before acquisition. Offline status must not block eligible dispatch. Neither mode reads a copied profile; acquisition errors and cancellation never trigger a second transport. Anonymous provider initial/redirect/recreated/detail requests retain public URL/DNS/socket checks and reject proxy routing. Connected worker tasks must not carry browser-owned cookie/user-agent headers. Hanging/canceled tasks close their tabs, active leases remain live past 45 seconds, four-way admission uses backpressure, cross-origin redirects are blocked before dispatch, and UTF-8 byte bounds stop streaming early. | Worker/API bridge tests, two-installation contention and lease-liveness tests, extension persistent-context timeout/redirect E2E, Settings/Pipelines components, and a bounded live Discovery smoke. |
| Retry preflight | Starting a retry cannot erase failure evidence before worker readiness is known. | API state-before/state-after regression plus route smoke. |

For Gmail token replacement, run `test_gmail_token_atomic.py` with the connector
tests using only synthetic files and fake HTTP. Exercise authentication and
refresh, retained refresh tokens, invalid responses, each staging failure,
permission-before-write, atomic publication and hard interruption on either
side of replacement. Test first authorization and reauthorization with missing,
invalid and newly issued refresh tokens without assuming account identity.
Inspect logs for synthetic secret canaries and preserve
the last accepted bytes. POSIX mode tests do not prove a native Windows DACL.
The `Gmail token Windows privacy` workflow exercises a broad synthetic parent,
checks the stage DACL before the first byte and verifies the published token's
DACL for first save and replacement; only a completed Windows job is native
evidence.

Provider recovery regressions exercise an actual adapter over explicit fake SDK
boundaries: a rejected route is excluded from the next automatic acquisition,
the replacement carries its own provider/model, and the failed adapter is never
relabeled. Auth failures, model-specific rate limits, implicit SDK defaults,
explicit reset, malformed responses and budget denial remain distinct. Use
`test_provider_availability_recovery.py`, `test_llm_port.py`,
`test_employer_analysis_leg_config.py` and `test_job_url_import_workflow.py`.
Employer-analysis tests also bind each draft's preferred model and effective
model-set cache identity. Shared determination repair tests repeat budget
admission, retain strict citation checks and prove bounded failure preservation.

## Bounded Combined Jobs Pages (#1003)

The Operations helper must make one combined list request and return its server
page unchanged. Exercise absent, empty, single, duplicate and multiple stages;
explicit arrays override scalar stages. Forward all other filters, sort fields,
directions, page and page size. Failed reads must surface their error without
partial results or a scalar fallback. Keep tenant-first list keys, targeted
invalidation and event patches compatible with combined deep pages.

Use `jobsListQuery.test.ts`, `hooks/useJobsListQuery.test.ts`,
`DemoApiClientAdapter.test.ts`, `jobStageFilters.test.ts` and
`JobsView.test.tsx` for helper, query, demo and view regressions. The actual-router
case must exercise production navigation, saved multi-stage hydration and the
view query, so an extra ordinary-page prefetch cannot pass unnoticed. Exercise scalar
links, selection changes resetting page, saved selection/remount, page-local
filter bulk guards, all-matching stage membership, and server-clamped paging.

At the browser gate run both `jobs-bulk.spec.ts` and
`job-list-pagination.spec.ts` in the existing guarded isolation fixture. The
pagination spec uses `loadE2eDbPath`, seeds 5,001 owned canonical synthetic jobs
across Discover and Apply, then exercises the rendered grid and saved view.
Require page 100/pageSize 50, exact ordered IDs, global totals and no more than
50 jobs; record one combined list request with no preceding-page downloads.
Also inspect ordinary, adjacent, clamped and empty states, page selection and
all-matching selection. Cleanup may delete only the fixture's owned job rows
and their dependent rows, preserving the pre-existing synthetic jobs.

Retain JUnit, complete request/response observations, synthetic inputs,
source/lock hashes, traces and page screenshots. Inspect the screenshots as
well as assertions. Final API regressions, 100/1,000/10,000-job scale evidence,
product QA and publication/resume checks bind to their controller
candidate; historical observations never certify a later stack tip. The
[benchmark owner](../local-scale-benchmark.md#bounded-job-page-contract-and-supplied-comparisons)
defines sampling and comparison limits.

## Ashby Listing And Location Admission

The Ashby public posting adapter excludes only explicit boolean
`isListed: false`. Listed and legacy postings with no flag enter canonical ingestion;
the adapter does not decide their title, description or location relevance. The
primary location or existing `locationName` fallback leads the retained metadata;
trimmed valid `secondaryLocations[].location` strings follow, deduplicated
case-insensitively with first spelling preserved and joined by `; `. Malformed
secondary containers/entries and empty names add no fabricated location.

`workers/automation/tests/test_ats_adapters.py` covers listing flags, malformed
secondary data, duplicate labels, primary fallback and native-ID/canonical-URL
preservation. Its synthetic `run_scheduled_ats_sources` fixture injects HTTP data
into an owned temporary SQLite database. Listed postings enter canonical
ingestion without an admission model, retain both location names and preserve
identity and observations across runs. An unlisted peer is excluded mechanically.
`test_captured_posting_recovery.py` covers bounded recovery of archived raw
postings, literal exclusions, limits and interruption before consumption. No
alias table or geography sentence corpus decides suitability.
These fixtures contact no live board and use no real user data. Local fixture
proof does not replace the product QA or CI gates.

## Archived Smart Extract Snapshot Recovery

Run locked `pytest tests/test_captured_posting_recovery.py tests/test_archived_smart_posting_temporal.py`
with the Smart Extract, limits and source-activity reliability suites. In an
owned exact-schema SQLite workspace, fail actual snapshot persistence after
canonical insertion. Retry the real source activity and replay its Temporal
history: the original qualified bytes and three canonical determination IDs
must converge to one snapshot and enrichment before acknowledgement, with one
observation and no second admission. A last-slot insertion must still finish
when its remaining execution/source allowance is zero; another new capture
remains pending.

Interrupt before each original discovery event, then after each recovered
discovery event; retry must recover all three original event facts without
changing the canonical observation or acquiring another posting. With no legacy
journal and no first event, the capture-bound original owner observation must
refuse before provider setup. A normal observation of a preexisting bare owner
must retain its separate behavior. Seed multiple content-duplicate candidates
and require one idempotent event per candidate across recovery. Change original
event URLs, native/source/run IDs, confidence, extra fields and event/observation
clocks while keeping the qualified capture and canonical rows unchanged; require
refusal before public event publication or acknowledgement. Also alter a frozen
context and its event consistently: the unchanged original canonical observation
must still reject that forged operational claim.

Interrupt after snapshot/enrichment/event/accepted-progress/completion writes
and require atomic publication rollback plus retained capture evidence. Repeat
a completed recovery without duplicate events or snapshots and without page,
browser or provider setup. Use independent writers for changed metadata, later
observations, accepted enrichment/snapshots, stage ownership and owner deletion,
including permanent removal; stale recovery must preserve all their bytes and
never recreate the owner. An unfinished enrichment/snapshot aggregate or stage
owner must retain the capture rather than consume it as an accepted replacement.
Cancellation and superseded source attempt tokens
must retain retry evidence. Corrupt captured publication bytes or a canonical
model receipt and require refusal without a replacement. The private prepared-capture body stays out of bus/log publication, generic
Activity payloads and SSE, while completion/owner events contain references
only. Pre-upgrade partial inserts without their original full-capture receipt
must remain unconsumed and actionable rather than replacing missing history
with newly fetched bytes. These are structural persistence and model-authority
checks, not a semantic evaluation corpus or a live ATS reliability claim.

## Temporal Fault Injection

Use an owned file-backed database and a reused activity thread to prove that
failed and unfinished activity writes release SQLite's writer. Independent
heartbeat writes must succeed afterward, with committed artifacts unchanged.
Hold heartbeat persistence blocked and prove activity coroutines still progress.
During posting interpretation, allow an independent writer and supersede the
lease; the stale producer must not persist a snapshot or terminal success.
`test_activity_connection_lifetime.py`, `test_worker_heartbeat_loop.py` and
`test_discover_reliability.py` cover these boundaries.

For the affected workflow, prove four outcomes:

1. Kill the worker mid-activity: the same workflow resumes from durable history
   or reaches its designed verification state.
2. Cancel the run: cancellation propagates, the requester/source is auditable,
   and the read model eventually shows a terminal state without deleting
   completed facts. For batch Enrich, every unfinished selected row is
   `canceled`, unrelated pending rows stay pending, and a restarted reconciler
   reaches the same result from persisted ownership.
3. Make Temporal unavailable at start: the caller receives a clear error and no
   in-process fallback runs.
4. Lose local dev-server history: the reconciler terminalizes orphaned open rows.

An Enrich restart also proves the API-to-worker ownership handoff: canonical
`job_enrichments` state, not stale projected text, selects the reset row; a
repeat pickup cannot bypass queued/running Enrich; and queued metadata carries
the exact Temporal execution ID (`firstExecutionRunId`). A workflow handle is
never accepted as an execution owner. Matching and foreign-owner worker probes
must respectively process and reject the same prequeued fixture.

Timeout and explicit cancellation are separate fault classes. A timeout,
worker shutdown, or reset releases unfinished Enrich ownership for the same
Temporal execution to retry; only an explicit cancellation request
terminalizes the exact owned cohort. The successful canonical Enrich IDs, not
the original selection, become the Score/Tailor/Cover subset. For authenticated
LinkedIn recovery, ordinary extraction attempts do not consume the independent
three-pass apply-URL budget, and browser extension requests remain blocked
without being misreported as an unsafe posting redirect.

Selected Tailor and Cover batches must use their requested bounded worker count.
A durable item failure yields a partial batch with inspectable item diagnostics;
it does not retry approved jobs or prevent Cover from running for the exact
approved Tailor subset. Their selected-batch activity deadline scales at 30
minutes per worker wave, capped at 6 hours and protected by a Temporal patch
marker so replay of older open histories retains its recorded 30-minute timer.
The heartbeat timeout remains 2 minutes. Concurrent job-specific prompt
snapshots must retain distinct artifact fingerprints while reusing one global
policy revision when the complete tailoring-relevant profile projection,
profile/custom controls, learned rules, prompt/schema versions, models, judge
settings, and validation mode are identical. A tailoring-relevant profile or
control change advances the global revision and rejects stale artifact
persistence; an application-only compensation/authorization/defaults edit does
not. The canonical projection/policy comparison and artifact save share one
SQLite write transaction. The artifact audit digest
must match the exact role/content messages for the selected candidate, including
target-job and retry content. Canceling a real selected Tailor or Cover batch
after its first worker wave starts must prevent later waves, fence every
in-flight write, cancel only unfinished rows still owned by that execution, and
preserve both successor-owned rows and artifacts committed before cancellation.
If a blocking runner ignores the cooperative cancel token, the worker must
record `abandoned_thread`, retire that blocking-executor generation, and prove a
subsequent activity can execute immediately on fresh bounded capacity. The
abandoned generation must be distinct from Temporal's synchronous-activity
executor so capacity recovery cannot break marker or reconciliation activities.
Tailor's inner candidate-repair attempts are audit metadata, not the durable
stage retry counter. Each durable activity execution increments that outer
counter exactly once; repeated transient failures reach non-retryable `exhausted` at the
configured maximum and are excluded from automatic pickup until an explicit
attempt reset. Repeated durable executions of one materials generation must
append audit entries keyed by execution and durable attempt rather than replace
the prior prompt/candidate/validator/judge record.

The Score-to-Tailor evidence handoff is one generation-bound contract. Change a
posting after an earlier employer analysis, then prove Score refreshes through
the analysis cache owner and writes fit evidence for the refreshed generation.
Tailor must never turn a missing or mismatched fit report into a zero-edge plan:
it blocks on Score without spending a durable attempt. The claim-mapping fixture
also covers explicit ordered summary-sentence identity and reconstruction,
sentence-level aliases, exact rendered bullet and skill-group text, mandatory
coverage-edge evidence, missing or duplicate generated surfaces, and immutable
raw audit payloads before any judge call.

Tailoring selection and metric ownership are also one contract. With no
required bullets and a maximum of ten bullets per role, prove the maximum stays
a ceiling: the graph retains only the strongest achievement for each target
requirement, uncovered optional inventory is omitted, and no positioning filler
is added beside covered or pinned evidence. Each emitted experience bullet must
cite exactly one achievement and may use only numbers extracted from that same
achievement, including standalone numeric claims. Profile `GET`/`PATCH` must
lead the legacy flat metric projection with bullet/evidence-derived values,
preserve unmatched old values as non-authoritative and unassigned, and expose
no separate metric editor in the Profile UI. A synthetic voice fixture must
prove a clean, precise achievement cannot be rewritten merely for verb variety; any accepted
voiced line must pass the final mapping, quality, provenance, fabrication, and
judge gates.

The [complete matrix](complete-checklist.md#temporal-fault-injection-matrix)
lists the exact tests for Discover, Pipeline, Preparation, Apply, Profile Import,
Compensation Refresh, and Interview Prep workflows.

For JobStreaming broad-board discovery, killing the activity is not enough: the
fault must land after JobCtrl commits an accepted posting and unit receipt but
before provider acknowledgement. A fresh worker must reclaim the same immutable
query/location/board unit, replay without a second job/event/count, preserve the
run-wide result limit, and expose the recovered-unit count. Cursor reset must
wait for the error acknowledgement revision; a stale activity owner must lose
its write fence; request/cursor-schema incompatibility must fail explicitly;
and cancellation must terminalize unfinished units. The hermetic proof is
`workers/automation/tests/test_jobstreaming_resumable_discovery.py`, backed by
`test_discovery_search_units.py` and `test_jobstreaming_gateway.py`.

## Durable-Execution Recovery Demo

`scripts/reliability-demo.sh` runs an isolated, no-crawl, no-LLM, no-browser
worker-kill demonstration. It verifies that the same diagnostic run IDs remain
running while the worker is down and complete exactly once after restart.

```bash
scripts/reliability-demo.sh
scripts/reliability-demo.sh 5
scripts/reliability-demo.sh 3 40
```

The script uses a throwaway `JOBCTRL_DIR` and isolated ports. Do not adapt it to
run against `~/.jobctrl`.

## Dense HTML Resume Pagination (#907)

For the conditional default-template fit policy, also run locked
`pytest tests/test_default_resume_fit.py`, followed by this entire real-render
module with the opt-in flag. The generated adjacent A4 boundary must print two
balanced pages; the uncustomized built-in adapter must print one complete compact
page with identical ordered physical text. An explicit balanced theme must keep
its two pages. The saved HTML and returned layout boxes must match the selected
render. Cover single-page/large/empty outputs, still-multipage candidates, text
mismatch, renderer failure, temporary-file cleanup and all explicit/custom theme
bypasses. Keep the original rendering when compaction cannot remove the page;
never truncate text or shrink font size. Exercise fresh SQLite template resolution
through the adapter: the populated unassigned built-in theme must admit fitting;
profile/job assignments must bypass it. Verify compaction preserves all resolved
theme tokens except density. Native examples are private product QA, not committed
replay fixtures.


This bounded trial measures the current `HtmlResumePdfAdapter` and
`render_resume_html_to_pdf` path: structured synthetic profile → shipped
HTML/CSS with embedded Geist → fresh Playwright Chromium → physical PDF.
It does not change the pagination architecture. Issue [#907](https://github.com/ebarti/JobCtrl/issues/907)
owns the follow-up; completion of measurement does not establish universal
pagination stability or accurate Apply Review highlights.
The supplied current issue acceptance requires synthetic PDF/layout-box evidence
and repeatability, page-break, clipping and reading-order observations before
any conditional pagination change. The allowed trial also measures layout-box
correspondence; an architecture rewrite remains outside its scope.

The deterministic fixture and measurement code live in
`workers/automation/tests/test_pdf_renderer_ports.py`, selected by
`test_dense_resume_pagination_trial`. Only invented candidate facts are used.
Each case includes summary, role headings, education, skills, wrapped text and
a 144-character unbroken token. Ordered `R907M00001`-style markers identify
fields and individual segments inside the oversized bullet.

| Case, for both A4 and Letter | Required physical coverage |
| --- | --- |
| Dense | Six roles with eight verbose bullets each; at least two printed pages |
| Boundary below | One role with the largest one-page bullet count found by a bounded physical-PDF search |
| Boundary above | The adjacent count, one additional short bullet, must print two pages |
| Oversized | One role with one bullet containing 96 uniquely marked segments; that single target must fragment across pages |

The boundary search brackets counts 1 and 96 and bisects using the shared
renderer and pypdf page counts. It assumes monotonic growth only to find an
adjacent pair, not to characterize every possible breakpoint. The measured
pair is rerendered by both entry points. `boundaries.json` records every probe,
count and page count; final case reports include the selected pair. A failed
bracket or adjacent-pair assertion fails the trial rather than silently
substituting a smaller case. Calibration PDFs are separate from the repeated
case measurements.

The theme is explicit: A4 or Letter, bundled `sans` Geist, balanced density,
normal bullet spacing, font scale 1.0, left text alignment, centered header,
rule section headings, all four sections in summary/experience/education/skills
order, `#111111`, and margins top/right/bottom/left 16.5/17.5/18/17.5 mm.
The renderer viewport remains 794 × 1123 CSS pixels. No CSS is injected to
simulate pagination or repair the result.

### Run and evidence

Use the repository lock and a controller-owned artifact directory. Prerequisites
are the locked worker environment, its matching Playwright Chromium, and
Poppler `pdftotext` plus `pdftoppm` on `PATH`. Browser preparation is a separate
controller gate; where authorized, its command is
`env PLAYWRIGHT_BROWSERS_PATH=workers/automation/.venv/ms-playwright uv --project workers/automation run --locked --all-extras playwright install --only-shell chromium`.
Do not install a floating PDF library or substitute a host browser. Set
`JOBCTRL_QA_ARTIFACT_ROOT` to an existing, disposable, owned directory before
running these commands from the repository root:

```sh
trial_root="$(mktemp -d "${JOBCTRL_QA_ARTIFACT_ROOT:?set an owned artifact directory}/resume-pagination-XXXXXX")"
env -u UV_PROJECT_ENVIRONMENT -u VIRTUAL_ENV -u UV_EXCLUDE_NEWER -u UV_EXCLUDE_NEWER_PACKAGE \
  uv run --project workers/automation --locked --all-extras --no-sync --exclude-newer false \
  ruff check workers/automation/tests/test_pdf_renderer_ports.py --cache-dir="$trial_root/ruff-cache"
env -u UV_PROJECT_ENVIRONMENT -u VIRTUAL_ENV -u UV_EXCLUDE_NEWER -u UV_EXCLUDE_NEWER_PACKAGE \
  JOBCTRL_RUN_DENSE_HTML_PAGINATION_TESTS=1 TMPDIR="$trial_root" \
  PLAYWRIGHT_BROWSERS_PATH="$PWD/workers/automation/.venv/ms-playwright" \
  uv run --project workers/automation --locked --all-extras --no-sync --exclude-newer false \
  pytest -q workers/automation/tests/test_pdf_renderer_ports.py \
  --basetemp="$trial_root/pytest" --junitxml="$trial_root/junit.xml" \
  -o cache_dir="$trial_root/pytest-cache" -o tmp_path_retention_policy=all
```

The trial comprises **eight required cases** (four cases × two paper sizes).
Each runs three adapter renders and three shared-entry renders, all with fresh
Chromium lifecycles and separate `repeat-1`/`repeat-2`/`repeat-3` directories:
**48 measured PDFs**, plus the boundary probes and a browser/font preflight.
The focused selector is `-k dense_resume_pagination_trial`; it must execute
eight cases with zero skips. The full module also runs four required
`test_resume_continuation_pages_keep_selected_template_insets` cases: A4/Letter
with default/asymmetric margins, each through both entry points (eight more
PDFs). Independent Poppler geometry verifies the selected top/bottom inset on
every continuation page with 3 pt top / 2 pt bottom font-metric tolerances;
canonical marker
order and nonblank pages remain required. These cases reproduce the missing
continuation inset without reading private profile data.
The top tolerance includes the 2.85 pt ascent of a 9.5 pt section heading's
Poppler font box; every-page PNG review still checks actual painted insets.
The repeated trial also rejects independently located section headings whose
following content starts on a later physical page.
Ordinary port-test runs without the explicit flag skip these twelve browser
cases and supply no trial evidence. With the flag,
missing imports, Chromium, fonts or Poppler are failures. Do not count a docs
build, fake renderer, zero-test run or skipped case as product QA.
The retention override is required: the ordinary test configuration removes
successful temporary cases, which would discard their PDF/PNG review evidence.
`JOBCTRL_RUN_PAGINATION_TRIAL=1` remains an accepted alias for older invocations;
the managed gate's `JOBCTRL_RUN_DENSE_HTML_PAGINATION_TESTS=1` enables the same
required scenarios even when the alias is unset.

Each case writes `measurements.json` after every completed render and again
before assertions. Reports include the exact Python, OS, Playwright, Chromium,
pypdf, pytest and Poppler versions, worker lock and bundled-font SHA-256,
theme, viewport, source marker sequence, physical page dimensions/counts,
first/last markers per page, PDF words and geometry, layout correspondence,
and repeat comparisons. The reports, saved HTML, PDFs, bbox extraction and
110-DPI PNG for every measured page remain temporary. Calibration files and
any partial report are diagnostic evidence, not a completed run.

| Dimension | Measurement and interpretation |
| --- | --- |
| Repeatability | Compare all six outputs per case against the first adapter render: page count, normalized text per page, marker page assignment, independent PDF word sequence and maximum coordinate delta. Geometry tolerance is 0.25 pt. PDF bytes, IDs, creation times and compression are not compared. |
| Page breaks | Record first/last marker and marker count on every physical page, blank pages, adjacent boundary counts and the oversized target's physical fragments. Record orphan section/role heading candidates where the following target starts on another page. |
| Clipping | Poppler word rectangles more than 1 pt outside the page and word intersections over 1 pt in both axes are visual-review candidates. Inspect every page for cropped glyphs, overlap, bottom-edge loss, whitespace/blank pages and fragments; text extraction alone cannot show painted clipping. |
| Reading order | Locked pypdf extracts each physical page. Whitespace and CSS heading case are normalized; every HTML target's text must be present, including the long token. Canonical fixture markers must occur exactly once in source order across the pages. Check the visual column/order and heading-to-body association as well. |
| Layout-box correspondence | Parse target text from saved HTML without browser geometry, locate it in Poppler's PDF word stream, and union words separately on each physical page. Compare those fragments with the renderer metadata; report missing PDF/layout targets, duplicate/extra layout IDs, invalid page numbers, page/fragment mismatch and text escaping the predicted rectangle. |

PDF dimensions and word rectangles are points (72 pt/in). Poppler bbox already
uses a top-left origin. For a conventional bottom-left PDF rectangle
`(x0, y0, x1, y1)` on height `H`, convert to
`(x0, H-y1, x1, H-y0)`. Convert the renderer's percentages using the **physical**
page dimensions: left = `left_pct × W / 100`, top = `top_pct × H / 100`, right
and bottom add the corresponding percentage width/height. Physical A4/Letter
dimensions allow 1 pt of Chromium rounding. Text must fit inside its declared
box within a 2 pt tolerance; line-box padding and glyph bounds need not be
identical. Fragmented targets require multiple physical rectangles, and a
single matching anchor does not establish full correspondence. Poppler's word
rectangles include font metrics, so an escape is a candidate for inspection,
not proof of painted glyph loss. An unlocated PDF target is a measurement gap,
never an accurate-box result or an independently observed page mismatch.

The current renderer measures `getBoundingClientRect()` before `page.pdf()`
and uses the full `.resume-page` height as its page divisor. That source-level
observation is a reason to measure, not an observed PDF defect. A wrong
pre-pagination approximation must stay visible in the report; the trial does
not assert that incorrect boxes are correct or require their incorrect values
as an invariant.

<a id="results-and-independent-completion"></a>

### Results and completion

On 2026-10-03 the implementation measurement ran with Python 3.12.13 on macOS
26.6.2 arm64, Playwright 1.58.0, bundled Chromium headless shell 145.0.7632.6
(revision 1208), pypdf 6.19.0, pytest 9.1.1, Ruff 0.15.8 and Poppler 26.09.0.
Geist's Latin face loaded; the unused Latin-ext face remained unloaded for these
ASCII inputs. Worker lock SHA-256 was
`c7a3609dab6c93fdaa9f247ef88a943d74629457042ce64d7a92320092ba40d6`.
The Latin font SHA-256 was
`19f9c92546aa300c312235e3125af1b81394d8db9a4bc4a425cd5b641d2d54e1`;
Latin-ext was `824f485b5d26e2f2da3c2b236132ece1bc8e4e43373452950bb0e40548b4313f`.
The explicit themes above produced A4 media boxes 594.95996 × 841.91998 pt and
Letter boxes 612 × 792 pt, zero rotation, with matching crop boxes.

Focused Ruff passed. The full focused module executed **27 tests: 27 passed,
zero errors/failures/skips**, including all eight browser cases. The final run
took 51.48 seconds and generated 48 measured PDFs with 132 pages. Both entry
points used three fresh browser lifecycles per case. An earlier gate supplied
`JOBCTRL_RUN_DENSE_HTML_PAGINATION_TESTS=1` while the harness recognized only
the alias; that defect is repaired and the alias was explicitly unset during
this run. Earlier skipped cases supply no product evidence.

The six page counts below are adapter/shared for repeats 1, 2 and 3. Marker
ranges use the `R907M` prefix; slash-separated ranges are successive physical
pages. Markers bound content positions, not necessarily the first/last word of
a fragmented paragraph.

| Case | Paper | Six page counts | First–last markers on each page |
| --- | --- | --- | --- |
| Dense | A4 | 3, 3, 3, 3, 3, 3 | 00001–00024 / 00025–00046 / 00047–00074 |
| Dense | Letter | 3, 3, 3, 3, 3, 3 | 00001–00024 / 00025–00046 / 00047–00074 |
| Boundary below, 28 bullets | A4 | 1, 1, 1, 1, 1, 1 | 00001–00039 |
| Boundary above, 29 bullets | A4 | 2, 2, 2, 2, 2, 2 | 00001–00037 / 00038–00040 |
| Boundary below, 25 bullets | Letter | 1, 1, 1, 1, 1, 1 | 00001–00036 |
| Boundary above, 26 bullets | Letter | 2, 2, 2, 2, 2, 2 | 00001–00034 / 00035–00037 |
| Oversized | A4 | 5, 5, 5, 5, 5, 5 | 00001–00002 / 00003–00005 / 00006–00056 / 00057–00104 / 00105–00107 |
| Oversized | Letter | 5, 5, 5, 5, 5, 5 | 00001–00002 / 00003–00005 / 00006–00055 / 00056–00101 / 00102–00107 |

**Repeatability and reading order:** All six renders per case had identical
normalized per-page content, marker assignments, independent word sequence and
coordinates: maximum geometry delta **0.0 pt**. Every expected target's text,
including the long token, was present. Markers occurred once in canonical order;
there were no omissions, duplications or blank measured pages. These observed
results support the focused content/order and repeat assertions.

**Printed appearance and fragmentation:** The 132 page images formed 22 groups
of six identical PNGs. Each unique page was visually inspected at 110 DPI;
exact image hashes accounted for every repeat and entry point, and the final
run's image hashes matched the inspected set. No unreadable clipping or painted
overlap was observed. Continuation pages begin at the top edge without a repeated
top inset. Poppler rectangle candidates per PDF (outside-page / intersecting
words) were dense A4 12/926, dense Letter 12/867, below both 0/13, above both
7/13, oversized A4 29/2139 and oversized Letter 46/2134. Font-bound rectangles
can intersect between adjacent lines or extend above the page while the painted
glyphs remain readable; these counts are not confirmed clipping/overlap defects.
Higher-resolution visual inspection remains a separate QA check.

The oversized role moves to page 2, and its one bullet genuinely fragments
across pages 3 and 4. Large unused areas on pages 1 and 2 result from the current
native break-avoid rules. Visually confirmed **Medium** presentation findings
are Skills orphaned on page 1 of both boundary-above cases, with its body on
page 2; Experience orphaned on page 1 of both oversized cases, with the role
on page 2; and Education orphaned on page 4 of oversized Letter, with its body
on page 5. Reproduce these with the documented command and
`-k 'dense_resume_pagination_trial and boundary-above'` or
`-k 'dense_resume_pagination_trial and oversized'`. The measurement does not
assert these undesirable breaks as invariants.

**Layout-box correspondence:** All expected metadata IDs were returned exactly
once, with no missing/extra layout IDs. The following counts were identical
across all six renders. Page/fragment differences are independently observed;
rectangle escapes use the declared 2 pt threshold and require interpretation
against font metrics. Extraction gaps remain explicit and are excluded from
physical mismatch counts.

| Case / paper | Targets | Located / clean comparisons | Page/fragment differences | Rectangle escape candidates | PDF extraction gaps |
| --- | --- | --- | --- | --- | --- |
| Dense / A4 | 70 | 69 / 0 | 45 | 24 | 1 |
| Dense / Letter | 70 | 69 / 0 | 45 | 24 | 1 |
| Boundary below / A4 | 40 | 38 / 32 | 0 | 6 | 2 |
| Boundary below / Letter | 37 | 35 / 28 | 0 | 7 | 2 |
| Boundary above / A4 | 41 | 39 / 16 | 1 | 22 | 2 |
| Boundary above / Letter | 38 | 36 / 2 | 1 | 33 | 2 |
| Oversized / A4 | 13 | 11 / 0 | 7 | 4 | 2 |
| Oversized / Letter | 13 | 11 / 0 | 7 | 4 | 2 |

For example, dense A4 `experience:trial-role-2:heading` has an independently
extracted rectangle on **page 2**, `(49.61, -1.30, 545.66, 29.23)` pt. Metadata
declares **page 1**, `(49.58, 294.15, 545.38, 305.51)` pt after percentage
conversion. The oversized bullet's two physical fragments on pages 3 and 4
are represented by one metadata box on page 1. These are reproducible **Medium**
correspondence findings affecting audit highlighting, not repeat instability.
Their source is the pre-print DOM calculation described above; that owning
renderer is outside the frozen feature paths. Reproduce the dense example with
`-k 'dense_resume_pagination_trial and dense and a4'`, then inspect
`layout_correspondence.targets` in the case report alongside its PDF.

The dense extraction gap is `education:trial-education:subtitle`; other cases
also have `experience:trial-role-0:heading`. Poppler orders right-aligned date
and location words differently from the target's contiguous source text, so
the rectangle matcher cannot locate the complete target. Locked pypdf and the
images confirm those fields are present. These are measurement gaps, not lost
resume content or proof of accurate metadata. Even a single-page name produces
about 6.6 pt of font-bound escape without proving a painted-box defect.

This sample reproduced orphan headings and layout correspondence errors while
preserving repeatable content and order. It supplies evidence for targeted
follow-up, not a requirement to replace pagination architecture. Independent
review, browser/API QA, applicable CI, the full docs build and publication are
**pending controller gates**. The docs build passed its install-asset check but
stopped at missing VitePress/Node dependencies. Implementation measurements
do not replace those gates. Keep JUnit and non-sensitive summaries in an owned
evidence location; remove owned generated HTML/PDF/images and browser workspaces
after inspection. The controller reproduces its required scenarios independently
and records any differences or raised severity before publication.

For every instability or mismatch, report the case, paper size, entry point,
repeat, marker/target, page, expected versus observed geometry/content and a
reproduction command. Classify lost/duplicated content, changed reading order,
unreadable clipping/overlap or nondeterministic page assignment as High;
layout highlight correspondence errors and isolated orphan headings are
Medium unless they make approval materially misleading. Extraction gaps and
visual-review candidates remain unresolved measurements until corroborated.
Any unresolved Blocker/High prevents completion. Visual QA must inspect
**every measured page of every repeat**, record outcomes for all five dimensions,
and reconcile its findings with the JSON and JUnit evidence. Eight passing
automated cases alone do not complete visual QA or prove universal stability.

Add further regression assertions only for behavior supported by these actual
observations. The trial currently checks content/order, physical coverage,
nonblank pages and repeat comparisons; it has no hardcoded dense-page count
or assertion that the DOM layout map is physically accurate. More fonts,
densities, themes, non-ASCII scripts, viewer versions and arbitrary document
sizes are outside this bounded sample. The controller owns current-issue
reconciliation, product QA, mandatory checks and publication at an
unmerged verified head. After it records the summary, remove only the owned
trial artifacts and processes; retain no generated candidate material in Git.

## Accepted DOCX Export

Run locked Ruff on the editable export domain model, infrastructure export
modules, RPC handler, CLI and export tests, then run locked pytest for
`test_accepted_docx_export.py`, `test_accepted_export_api.py` and the RPC boundary.
Use only owned synthetic native-schema workspaces. The suite exercises the real
CLI subprocess plus source ownership/generation/status fences, source drift,
exclusive publication, corrupt output and persistence failure. Verify preserved
accepted bytes, registered prior exports, review decisions and application state.

The standard-library writer must round-trip through the independent `python-docx`
development dependency: compare every paragraph, including blank lines, tabs,
Unicode, contacts, dates and bullet markers, then edit/save/reopen it. Check
heading styles, A4/Letter, locale, source identity and settings hashes. Inspect
rendered synthetic resume and cover-letter pages for clipping or missing glyphs;
exact PDF layout fidelity is outside the editable-export contract. No model
evaluation set or replay fixture is involved. This owner is synchronous and
does not dispatch a Temporal worker or contact a provider.

Run `apps/api/test/accepted-material-exports.test.ts` against the prepared locked
Python interpreter, plus RPC parity. Exercise history, export and binary download
through the production HTTP routes and registered Python RPC. Reject foreign
tenant/job bindings, unknown worker diagnostics, changed source bytes/metadata,
missing files, symlinks and corrupted retained bytes. Read downloaded files with
`python-docx` and prove approval/application/source preservation.

Run the colocated accepted-export component/a11y tests, download-adapter tests,
event invalidation parity, web lint/check/build and affected Storybook stories.
Verify pending controls, A4/Letter selection, unavailable sources, demo refusal,
and retained history across export/refresh/download failures. A retry of Download
must not create another export.

`e2e/tests/accepted-material-exports.spec.ts` runs in the production API/RPC
browser gate (`JOBCTRL_E2E_ISOLATED=0`); the isolated no-subprocess gate deliberately
defers it to that separate CI step. Use an owned synthetic workspace and isolated
ports. Export both material kinds on both paper sizes, inspect each downloaded
document, exercise an edit after selection and a missing-file download/retry,
then prove unchanged approvals and no extra export rows. Inspect desktop/mobile
screenshots, page identity, console health, overflow and critical/serious axe
results. Skipping this production gate is not passing browser evidence.

## Contact Replacement Edit Bases

Use `apps/api/test/contacts.test.ts` and `contact-projection-parity.test.ts` for
canonical detail reads and stale role/link/whole-fact replacements. Run two real
SQLite handles and independently started production writers: one shared base
admits exactly one update, and a barrier after comparison must still exclude a
second writer before replacement. Count canonical facts and events exactly;
rejected saves append no success events. Change provenance alone and facts at an
unchanged contact timestamp; refresh projections without invalidating the base.
Inject attribute and event insert failures and require complete rollback.
Discard a committed HTTP acknowledgement, restart the owned API, reject the old
base again and recover deliberately through a fresh typed-client read.

Preserve imported fact IDs and every provenance column, plus accepted outreach
drafts/reviews/send logs. Pair these tests with the focused worker repository,
provenance, projection-parity and offer/outreach tests. The editor/mutation,
demo and `apps/web/e2e/tests/outreach.spec.ts` regressions cover pinned bases,
rollback/refetch, retained fields, repeated conflict, explicit reconciliation,
keyboard recovery and a 390px viewport. Exercise two editors where one changes
only an employer while the other changes the role and adds a sourced fact: the
reconciled save must retain the newer role, fact identity and provenance. Require
explicit choices for competing field edits and edited-versus-deleted facts;
when changed originals disappear and new fact IDs appear, require choices for
each new fact without inferring identity. Changing the draft invalidates pending
choices. Preserve unsupported or overlong saved facts during other edits; reject
implicit unsupported-kind changes and overlong new values. Round-trip id-less
raw whitespace without losing identity or provenance, and accept a new value
whose trimmed length is exactly 2,000. A fixture or type check alone does not
prove the real API/browser journey. With duplicate kind/value facts and distinct
provenance, delete the old identity and retain the newer identity exactly; reject
foreign and repeated IDs without writes and retain value-only caller behavior.
Interleave a score reset and lost outcome/send-log acknowledgements with contact
updates, then verify action replay, score retention and fact provenance. Type a
newer contact edit during a pending save; success, failure and conflict must
retain it without automatic resubmission. Closing and reopening the editor must
fence the earlier completion from the new session.
Use only owned exact-schema synthetic data
and retain reports under the QA evidence owner.

## Manual Outcome And Send-Log Retry Identity

Run API `test/action-retry.test.ts` with `application-feedback.test.ts`,
`application-feedback-v7.test.ts`, `outreach.test.ts`, `offers.test.ts` and
`outreach-projection-parity.test.ts`. The retry harness starts two independent
loopback API processes over an owned exact-v15 database. It uses the normal
`JobCtrlApiClient`, discards a completed HTTP acknowledgement, restarts the API,
and compares the full original result. Hold an independent writer while equal
and conflicting requests arrive, then require one fact/event per accepted
identity and an explicit 409 for the conflicting loser. Inspect exact IDs,
timestamps, counts and private-text exclusion; a sequential handler-only race
is insufficient.

Cover ordinary outcomes, prep-linked reflections and send logs, including omitted
`occurredAt`, canonical job aliases, foreign tenant/operation/target bindings,
malformed identities, missing receipt facts, receipt IDs redirected to another
equal-payload action, missing or different event fact references, changed accepted
facts and event fields, malformed or duplicate internal prefixes, changed draft/prep bindings, event
failure, deferred commit failure and outer-transaction rollback. Replay after a
later deliberate action, changed draft review or reminder must preserve that
newer state. Fresh requests retain approved-draft, offer-source and
accepted/superseded prep-generation checks. The sealed schema remains exact v15.
For a retained full identity prefix, corrupt its separator to punctuation on
either side of `:` and to Unicode; equal retries, including independent writers,
must refuse without creating another fact or event.
Attempt an offline dictionary guess against the persisted and SSE event payloads
for a short synthetic private note. Neither the note nor its private SQLite
binding may be exposed there. The binding itself remains inside the private
database, which also holds the original note.

Web outcome/reflection/send-log form and mutation tests cover frozen payloads,
identity retention, explicit new actions, accessible errors, input retention and
optimistic reconciliation without overwriting later thread state. With warm
outcome caches and colliding job IDs, switch tenants before and after an
unacknowledged manual outcome or reflection and restore each owner's draft and
exact retry identity. Exercise the real Jobs routes with keyed drawers and cold
tenant reads, including A-B-A job navigation, top-level navigation and nested
run detail; deliver an old acknowledgement after the original form is replaced.
Neither another owner's draft nor a newer action may be cleared. Defer send-log
query cancellation, replace the contact's cached thread, and then settle the
original request with success and failure separately: neither the optimistic
patch nor settlement may change the replacement's drafts, logs, sent status or
reminder. The existing
Interview Prep and Outreach browser paths discard an acknowledgement only after
`route.fetch()` completes the real mutation, retry through the rendered form,
and inspect canonical fact/event counts. Keep offer production API/RPC and
worker preservation checks alongside these scenarios. Retain owned JUnit and
observed product-path evidence; fixture coverage is not independent runtime QA.

## Auditability Checks

For Skip during Apply custody, run `test_apply_stopped_owner_recovery.py` and
`test_apply_crash_custody.py`, with the existing Apply claim, workflow, reset
and projection selections. A real owned source process and retained child must
show that root exit alone is not a native completion proof. The source lifetime
recovery is explicitly best effort, preserves Skip and records its exact claim;
only a separate safe reset releases the stop. Unknown or untracked custody stays
blocked. Installed mode requires the actual native completion proof described in
[Apply Launcher Ownership](../../local-reliability-qa.md#apply-launcher-ownership).
Exercise native retirement after a saved Skip and stale running relabel using
the real claim, custody journal and reset writer with synthetic native proof.
The exact retired owner may restore the stopped stage; unverified custody,
intent and a successor claim must still refuse reset.
Current/older intent and prior Needs verification still refuse reset. Preserve
accepted artifact fingerprints, counts and event/run identity. The
`apply --recover-stopped` CLI must never launch Apply or reset running work.
Use actual HTTP Skip/reset readback; fixture-only events do not establish cleanup.

For durable Apply Skip and submit-intent recovery, run locked
`pytest tests/test_exact_v7_apply_acquire_job_identity.py tests/test_apply_queue_selectors.py tests/test_enrichment_retry.py tests/test_exact_v7_state_reset.py`.
Use exact-schema synthetic jobs and actual claims, final-intent writer, saga and
SQLite event persistence with fake sender/browser/agent transports. Cover manual
Skip from pending/failed/needs_verification across targeted/batch polling,
approval settings and dry runs; retain an eligible peer and retryable DRY_RUN.
An independent writer commits Skip during availability refresh and before final
intent. Post-intent Skip and lost acknowledgement permit at most one fake send;
restart/stage relabel/reset cannot authorize another. Repeat Needs verification
without an intent receipt, retaining its prior state through repeated Skip and
later stage labels. Assert exact intent/sender
counts, original run identity, preserved artifact fingerprints and late-result
ownership. Seed an inherited running attempt with an earlier same-job intent,
including an independent-writer intent committed during agent execution: final
admission must create no second intent/send, while foreign tenant/job evidence
cannot block an unchanged safe submission. Compare the real Apply Review and
Job Detail readers after relabel/restart. Exercise the real CLI manual-failure
command: active ownership, Skip and uncertainty must produce a nonzero refusal,
while safe local failure preserves attempts/materials. Settlement must retain
the claimed attempt count for success, rehearsal, failure and uncertainty.
Also cover both restart recovery branches and real CLI Mark Applied with an
existing budget. Run `test_apply_runs_projection_from_events.py` and
`test/apply-late-settlement.test.ts` for actual claim/saga/fake-sender/Skip/late
settlement through the Python projector and HTTP readers. Successful original-run
history must not become a fabricated submit failure; lost acknowledgement stays
uncertain, Skip and intent still block retry, and accepted artifacts remain
unchanged. Distinguish confirmed late receipts from lost acknowledgements in the
real HTTP audit while retaining the same stop and retry fence. Exercise repeated
Skip after Applied, Needs verification, queued and policy-owned states through
HTTP and both reset owners; reconstruct identifiable legacy authority and verify
that a cleared score policy and ordinary safe Skip remain resettable. Also dispatch
through registered RPC before starting a controlled Temporal worker,
then Skip and reset. The prior workflow cannot claim, a distinct post-reset
request can, and a standing loop renews only between completed polls. Include
legacy histories, independent writer ordering and replay; record loopback listener
ownership and reap the exact synthetic Temporal child.
Check already-cached fallback repair without new events, rollback and caller
transaction ownership, prior terminal outcomes and foreign send evidence.
For each conflicting late status, intent remains Needs verification unless the
exact email operation has its validated receipt and subsequent submitted fact;
unbound, altered, foreign-job/tenant/stage and empty receipts cannot settle it.
Confirm a matching receipt recorded before the unique intent cannot create a
submitted fact or repeat-application evidence, including when a pre-intent row
collides with a later receipt's idempotency key. A valid later receipt settles;
duplicate intents remain uncertain. Exercise the real writer under its lock and
repeat the readback after reopening storage.
The real worker/saga must persist the original owner's private AssistantText,
ToolUse and terminal determination after pre-intent Skip without recording a
failure, claiming a peer or admitting a send. A stopped rehearsal with no intent
retains its actual dry-run result. Repeat after reopening storage and verify that
private observation text is absent from projected timelines.
Regress an automatic score-threshold reset after a relabeled manual Skip: no claim
is admitted until a validated explicit release. Refuse canceled/failed/pending
resets without the exact original owner settlement, including mixed-cohort RPC
rollback. Run `test_workflow_apply.py` through registered RPC, Temporal, real
launcher/use-case/saga and settlement with fake external transports: unchanged
authority, pre-intent Skip, post-intent Skip and lost acknowledgement, followed by
connection restart and repeated RPC. Retain exact event/send counts and artifact
hashes. Open More job actions, activate Skip on running and Needs verification
jobs, and inspect retained run/intent evidence on desktop/mobile after reload
and a refused reset. Exercise CLI/registered RPC mixed-cohort rollback and caller-owned
transactions. API HTTP Skip/reload/reset and focused UI mutation/rollback tests
must preserve visible active-run and verification evidence. These regressions
do not establish live-provider or installed-runtime behavior.

For stale score reset and replacement (#1189), run the focused score
staleness, score atomic-publication and repository tests with the API reset and
web mutation tests. Use owned synthetic SQLite and fake model authority. Reset
and read the prior score through list and detail; retain its stale marker during
pending, failure, cancellation and reuse. Exercise publication and commit
failure, source/tenant mismatches and unrelated markers. Add a marker through an
independent writer during inference: the earlier completion must not resolve
it or reconcile downstream eligibility, while a later matching replacement can.
A newer policy during inference
must preserve the accepted score, report and both invalidations.
Exercise correction of an already-stale score in the API, dashboard, CLI and
browser-local demo. Repeat bounded resets with duplicate markers, an already
pending job and independent queued/running owners; limits apply to distinct
eligible jobs, skipped work is reported, and an event or competing-writer
failure cannot partially reset the cohort. Repeated preparation sweeps preserve
approved artifact identity, status and bytes while score authority is stale.

For current approval at owned email intent, run locked
`pytest tests/test_apply_regressions.py -k owned_email -s` with an owned JUnit path,
alongside the Apply saga/use-case, approval vocabulary, cover review, posting
availability and repeat-application regressions. The fixture retains production
`acquire_job` → `run_job` → use case → saga → final authorizer → SQLite intent →
settlement/recovery; only external browser, agent, DNS and sender transports are
synthetic. It does not replace API/RPC/Temporal dispatch or rendered review QA.

Commit independent defer/reset, profile, application/posting URL, material
generation, same-generation artifact/byte, cover binding and email candidate
changes after claim. Repeat with claim-time approval waiting enabled and disabled,
including changed inputs followed by a new approval, tied decision clocks, missing
authority and read failure. Require zero intent/send on refusal, stable reasons,
unchanged post-edit review/material history and accepted bytes. An enabled claim
gate must reject stale complete email bindings across repeated targeted and
standing polls without consuming attempts. For refusals after claim, require
owner-scoped, idempotent attempt restoration at settlement and after interrupted
settlement, including with claim-time approval disabled. Preserve browser claims,
reject agent-reported or historical unkeyed refund lookalikes, and never refund
after submit intent. The unchanged control requires one committed intent
before one fake send, with decision/source/candidate provenance on the intent.
With approval waiting disabled, exercise real continuous worker and bounded
managed/continuous workflow batches: one refusal parks unchanged authority with
no repeated agent, browser, intent or sender work, while another job progresses.
Change the authority or explicitly request a single-job retry and verify the
job can run again. Start with no candidate or review at all and verify the
normal caller requires a dry run for discovery and blocks live browser entry;
the directly invoked locked saga's refusal still refunds and parks its owner.
Carry a stale approved candidate through an actual continuous Temporal
execution: retain its failed batch count, continue only after the same owner's
refund and settlement, admit a reviewed peer and wake the original job after
its authority changes. Replay the history;
mixed failures, missing proof, worker crashes and cleanup failures must still
end the workflow as failures. Cover authority changed during the earlier run,
interrupted settlement, and a first newly discovered email candidate. Exercise both ended
source-lifetime and verified native-custody recovery: the park, owner-checked
refund and stage transition commit together; intent and successor claims remain
protected. After a saved refusal, make score stale, close the posting or make
materials unavailable before Skip; settlement must still read the exact owner's
authority and restore its attempt without admitting a send. Preserve the changed
sources and decisions. Use synthetic native proof at the custody seam.
On Darwin, carry the email-refusal case through the real source-controller
scope, with real boot/coalition checks and synthetic Apply ports. Repeated
unchanged polls must stay parked; a peer and changed authority can proceed.
Retain exact child birth/session evidence and the owned workspace when the
separate source cleanup probe cannot verify exit; never infer completion from
the source fleet receipt.
Direct saga calls without a final email authority, with availability-only or
malformed authority, or without the same candidate's pinned bytes must refuse
before intent and sender admission.
Run the API approval test with `JOBCTRL_MIGRATION_TEST_PYTHON` set to the locked
worker Python: its synthetic cross-runtime control records a worker-generated
preview through the actual API and carries that approval through worker claim
and intent, with unchanged and late-defer cases and a fake sender.
Run locked `pytest tests/test_material_render_publication.py
tests/test_tailoring_ownership_race.py tests/test_tailoring_artifact_boundary.py
tests/test_material_batch_attempt_fencing.py tests/test_direct_material_attempt_fencing.py
tests/test_approved_material_recovery_ownership.py`.
Drive competing PDF and Cover activity paths and overlapping tailoring activities
against one synthetic SQLite workspace. Require distinct attempt paths, preserved
accepted bytes and source IDs, a writer lock through revalidation/publication,
no stale aggregate overwrite, and owner-specific stale settlement without an
extra attempt. Cover changed source bytes/path/generation, render failure, and
an acknowledgement lost after commit; retain the referenced PDF in that case.
Run overlapping attempts of the same Temporal activity and workflow run in both
completion orders. Once the successor starts, require the older attempt to leave
its publication and terminal stage state untouched. Also recover a committed
cover while its prior PDF render is paused, preserving the accepted text. Delay
an older attempt before stage claim and before retry recovery; neither may claim
or settle the successor's stage, and recovery must stay scoped to its job.
Repeat with selected and unscoped Tailor and Cover batches, and current-policy
Tailor, including distinct Temporal and workflow-owner IDs. Require sibling
jobs and other tenants to retain their work when one attempt is superseded.
Overlap direct and Temporal material calls in both orders, including failures;
the displaced direct call returns its stale/skipped result and cannot settle
or publish over the successor. Also delay direct calls before their stage claim
and request already-approved artifacts while a workflow-owned stage is running.
Replay an older workflow's Tailor and Cover activity against approved materials
while a different workflow, another activity of the same run, or a direct
attempt owns the running replacement. Preserve the complete stage row, start
events, accepted files, material rows and provenance, and verify the current
owner still passes the real publication guard. Retain current-owner recovery as
a positive control.
Use a second real SQLite connection before and after repository save to prove
neither writer admission nor intent visibility can cross validation-to-commit.
Pause repository save containing intent after final authorization, both before
and after insertion. Overwrite or atomically replace the attachment using an
independent writer while its metadata update is SQLite-locked: source changes
must roll back the intent with zero sender/HTTP calls under either approval-wait
setting. Also replace the file between hash validation and byte capture. Retain
the production Gmail adapter and MIME encoder with fake HTTP, decode the outgoing
attachment and compare its hash with the approval. After admission, replacing or
deleting the source path must not alter those bytes or force a path fallback.
The last hash read does not lock an independent filesystem writer through the
SQLite commit. A replacement in that interval can go undetected, although the
sender still receives the pinned approved bytes; these tests do not prove a
filesystem-wide atomic current-source check.
Missing/mutable byte inputs refuse before Gmail access. Repeat acknowledgement
loss and restart through this byte-bound real adapter with no resend.
Also gate the first source-binding read during claim: the running stage must
remain uncommitted and another writer must be excluded. Replace attachment
bytes/metadata or the accepted tailored-resume identity before claim and after
claim separately; neither a new snapshot nor an unchanged generation may adopt
the replacement under older approval. Approve candidate A, change the job title,
and run another production rehearsal to produce B with the same recipient and
attachment but different subject/body. A's recorded fingerprint must refuse B
under both approval-wait settings. The API approval tests also require complete
fingerprint persistence and atomic refusal when accepted file bytes are unavailable.
Repeat tied-clock defer/reset using decision IDs both below and above the prior
approval ID, with approval waiting on and off. API, worker and digest must agree
on the conservative non-submit precedence. Inject a canonical review-reader
failure at each preliminary final-intent read, including the read used by
availability transport: require `approval_authority_unavailable`, zero intent/send
and no extra attempt. Capture preview A, create rehearsal B, then submit A's full
preview identity with unchanged recipient/attachment IDs. Require an atomic API
refusal, preserved decision history and no send; an explicitly reviewed B can
subsequently be approved and sent through the owned path.
At the review-session hook, retain the clicked preview across asynchronous
preparation. Independently replace recipient, subject, body, attachment ID/name,
rehearsal run or timestamp, including an in-place cache update while refreshing:
no approval request may adopt the unseen preview. The unchanged control sends
the complete caller-bound preview, permitting only the exact accepted resume
render's attachment promotion. An API stale-preview refusal preserves the saved
draft and accepted render without dispatching automation.
Fail intent insertion to prove rollback, then exercise lost acknowledgement and
crash after intent through restart and repeated targeted/standing polls: uncertainty
stays `needs_verification` with no resend. Emit scenario identities, exact event
and sender counts, artifact/source hashes and writer ordering for retained QA.

The owning boundaries are
[`_authorize_posting_before_submit` and `SqliteApplyRunRepository.save`](../../../workers/automation/src/jobctrl/apply/launcher.py),
[`_handle_email_only_result`](../../../workers/automation/src/jobctrl/domain/apply/process_manager.py)
and [`_email_application_context`](../../../workers/automation/src/jobctrl/domain/apply/use_cases.py).
Browser final submit remains manual; Gmail verification, provider receipt
validation and manual Skip semantics retain their separate contracts.

For interview-history and Apply Review comment recovery, run the focused
Interviews view, note-form, interview-query and Apply Review session/view tests.
In an owned synthetic workspace, fail preparation and note history reads,
including a later page, and retry the same job, question and page after editing
context, question selection and a note. Repeated failures must retain the last
accepted preparation and leave retry available; successful reads must preserve
the edits without generating preparation. Fail comment persistence after findings
exist, then use the visible recovery action and verify that it replays those
findings without starting a model review or replacing existing comments and edits.
Verify the visible flow in a Linux-isolated browser.

For learning recommendation pagination (#1198), run the focused
`LearningRecommendationReviewPanel.test.tsx` and the isolated
`learning-pagination.spec.ts` browser test against its owned synthetic database.
Reach every recommendation and evidence link over the real API, including a
signal linked to multiple jobs. Fail and retry each later-page read while the
previous page remains visible. Verify the accepted review and policy revision,
terminal exclusion, and tombstoned source authority remain unchanged; no
recommendation or evidence is regenerated by navigation.

For reviewed tailoring-policy restore, run locked
`pytest tests/test_tailoring_policy_revisions.py tests/test_rpc_learning_recommendations.py tests/test_sqlite_learning_recommendations.py`
with the API contract and history-panel tests. Use independent connections in an
owned synthetic SQLite workspace. Race distinct commands and copies of one
command against the same reviewed version; require a stale refusal or one
receipt, respectively. Preserve intervening user and recommendation revisions,
and retry after a lost response, restart, and later accepted change. Check exact
history counts and original receipt, tenant isolation with matching IDs and
versions, malformed and conflicting payloads, and commit-failure rollback. The
actual API and rendered history must show the reviewed transition, stale review,
fresh review, and the difference between a receipt and the current policy; no
restore may start material or application work.

For posted compensation source fencing, run locked
`pytest tests/test_posted_compensation_source_fence.py tests/test_compensation_v7_job_id.py tests/test_posted_compensation_repository.py`.
Use owned synthetic SQLite and fake model ports. Hold extraction while an
independent writer adds or removes salary, changes the selected text, or adds,
removes, or changes the status of an enrichment. Reject a changed preferred
source and preserve the accepted fact, determination binding, and event; permit
one publication when only lower-priority or another tenant's data changes.
Exercise both discovery producers and the per-job refresh core, and confirm
the writer can commit while inference is active. These are source and
transaction checks, not semantic evaluation or live-provider tests.

For contact research acquisition, run locked
`pytest tests/test_contact_research_workflow.py tests/test_company_briefings.py`
with the politeness and public-destination suites. Use only fake transports and
owned synthetic SQLite. Exercise declared and streamed size limits, slowly
progressing headers and chunked bodies, redirects sharing one deadline,
admission and active cancellation, cancellation during page parsing and while
waiting for the result writer, closure, DNS timeouts versus other DNS failures,
stalled DNS and public-address rebinding.
Prove failures remain distinguishable from no-candidate results through the
activity and stored task, do not reach the model, and cannot erase accepted
proposals. Race two SQLite-backed attempts in both completion orders and confirm
a candidate while a failed attempt is still in flight. After a rate-limited
source, allow an independent writer during the next fetch and model call;
reject an already-open caller transaction, and preserve the shared gateway's
explicit commit ownership. Inject event-publication failure and verify its
writer lock is released. Queue a same-host request behind 429 and 503 responses
for both contact research and company briefings, and prove it cannot start before
or during the installed `Retry-After` cooldown, but resumes after it expires.
Verify the contact source outcome labels in the web component.
In the isolated hosted Linux browser gate, run the oversized-page case in
`e2e/tests/outreach.spec.ts`. Its owned synthetic fixture executes the actual
activity in memory with a fake transport and no model call. Its exact persisted
task row is copied into the browser workspace by a Node seeder that checks the
independent E2E capability and the actual opened SQLite descriptor. Run
`test_contact_research_e2e_fixture.py` and `scripts/owned-research-db.test.mjs`
for missing, mismatched and replaced ownership refusals. The real API must return
the handed-off failure, and the opened source disclosure must show the actionable
guidance while the existing proposal remains visible. This handoff is not proof
that the worker itself wrote the browser workspace database.

For contact research inference, run locked
`pytest tests/test_contact_research_inference.py tests/test_contact_research_workflow.py`
plus the contact API and source-outcome component tests. Use only synthetic
pages, fake model authorities and owned SQLite. Opposite valid results for the
same page must yield proposals or an accepted empty decision. Verify receipt
identity, source spans, contact-lane preflight and cache reuse; reject provider,
spend, JSON, schema, enum, source and span failures without a lexical substitute.
An empty fetch is not an empty model decision. An in-flight failure must preserve
the winning review, record its safe failure and event atomically, refresh an open
review and report the failing attempt in workflow output. A successful retry
must clear current failure metadata while retaining prior source attempts. Race
both completion orders with independent writers. No raw prompts, page text or
candidate values enter events or determination receipts. Exercise the actual
activity with Temporal heartbeats, dispatch and replay, including old-format
activity output and both preflight histories, then inspect the API and UI.

For legacy evidence preservation (#1281), run locked
`pytest tests/test_legacy_evidence_preservation.py tests/test_legacy_evidence_recovery.py tests/test_semantic_storage.py tests/test_v12_activation.py`
and the full worker and native launcher suites with this checkout's locked
migration Python and Node explicitly bound. Exercise every applicable exact-v6
through v12 source to current schema, an independently authored collision, a
known historical system-writer record, nonmatching and unconfirmed controls.
Keep every original text/scope/metric/ID/confirmation cell, deterministic private
inventory history, canonical review-required failure, explicit human source
visibility and unchanged accepted material IDs/bytes/anchors. Repeat inventory
and decisions; stale tokens, current edits/deletions, duplicates, independent
writers and malformed/unpaired/changed/symlink backups must refuse safely.
Inject inventory interruption and cutover failure, preserving current/source/
paired-backup/file bytes. Use only owned synthetic workspaces. The recovery path
must not treat independently captured app/Temporal/files as a native pair or
infer authorship from values. Verify the Python-written private journal through
real Profile HTTP, the Profile/Evidence Map warning, excluded interview choices
and the SSE private-source canary. Include confidence `0`, `1e-7`, `1e-6`, a
fraction, `1` and a subnormal value through actual Python review publication and
TypeScript reads; unchanged binary64 values must agree and changed values must
invalidate that binding. Nonfinite values refuse without replacing cells or
history. An original-zero inventory must not authorize a later current one,
malformed flag or duplicate; prove canonical-source refusal, visible pending
state, stale-token refusal and a new explicit human decision, including
backup-zero/current-one recovery. No semantic eval corpus or real user backup
belongs in these checks.

For availability model/network budgets, run locked
`pytest tests/test_availability_model_budget.py tests/test_saved_posting_availability.py tests/test_saved_posting_availability_runtime.py tests/test_posting_availability_rereview.py`
and the full worker suite. Use a virtual monotonic/UTC clock and explicit,
source-bound synthetic page-model decisions to reproduce a slow interpretation
before browser fallback. Model time must leave the remaining cumulative posting
acquisition budget available; slow transport still exhausts that budget. The
original lease, owner/URL/deletion fence and cancellation must prevent browser
startup after ownership is lost. Keep actual browser-resource, process cleanup,
quota and accepted-observation preservation checks.

For preparation capture reuse, also run locked
`pytest tests/test_preparation_capture_reuse.py` with the availability suites.
Through real canonical capture persistence and the score/tailor/cover entry
points in owned synthetic SQLite, prove current active and unknown captures
avoid another acquisition or model call. Repeat reads without adding observations.
Reject stale/future timestamps, exact description changes, URL/deletion changes,
quarantine, low confidence, foreign/missing/damaged judgment receipts, wrong
contracts and later closure. Keep the independent unattended Apply refresh and
writer fencing; capture reuse never manufactures positive availability.

For shared Materials review constraints, run locked
`pytest tests/test_materials_review_constraints.py tests/test_materials_use_cases.py tests/test_material_review_history.py tests/test_parallel_resume_reviews.py`
and the full worker suite. Through the actual use case in owned synthetic
SQLite, inspect the first generator, factual, quality and high-fit persona
requests: summary quantity authority and selected-role rendering constraints
must agree before any repair. Opposing model verdicts remain authoritative;
a failed refresh preserves accepted artifact IDs and bytes. These request
checks establish contract consistency, not prose quality or a latency gain.
Measure any timing benefit through the normal clean UI flow.
For required-role empty-bullet permissions, run the requirement-led tailoring
suite as well. Reproduce baseline-only, confirmed-ledger-only,
unconfirmed-ledger-only, fixed-metadata-only and explicit bullet-pin cases in
standalone and plan-backed first prompts. Field validation and curation must use
the same available authored-evidence authority. Through the real Materials use
case in owned SQLite, retain one first draft, source IDs and opposing factual
and quality verdicts; metadata alone never invents an achievement.
For required skill categories, include `tests/test_required_skill_categories.py`:
one required, one selected optional and one omitted category must agree across
first prompt, field validation, text, ResumeDocument and the actual PDF adapter.
Keep missing required, foreign/duplicate ID, individual skill pin, default-all,
disabled item rewriting and opposing factual/quality verdict cases. Inspect every
page of the owned synthetic PDF; a document-structure assertion alone does not
prove exported selection.

For baseline accomplishment retention, include locked
`pytest tests/test_baseline_accomplishment_retention.py` with the Materials,
requirement-led tailoring and evidence-selection suites, then the full worker
suite. Through real owned Materials persistence, prove selected-role baseline
keep/omit source accounting, same-role ownership, no duplicates, separate pins,
independent opposing factual/quality verdicts and accepted-artifact preservation.
Exercise a baseline larger than the saved hard cap, reject cap omissions from
underfilled roles, and preserve independent opposing relevance judgments. Include
related combined sources, omitted optional roles, wholly inapplicable baselines,
metadata-only roles and disabled rewriting. Render an owned synthetic PDF at the
configured cap with recorded omissions and inspect every page.
These assertions verify the contract, not semantic quality or a speed gain;
inspect the next normal UI-generated resume and its recorded review decisions.

For compact factual-review transport, run locked
`pytest tests/test_claim_review_response.py tests/test_artifact_determinations.py`
and the full worker suite, plus API semantic receipt-version checks. Require
strict request-local reference resolution, unchanged canonical claim and
contribution validation, full persisted citations and explicit span/value
preservation. Wrong-line, foreign, malformed, non-verbatim, changed-value and
oversized/empty-source cases retain safe failures and the existing three-call
budget. Concurrent maps cannot cross; changed inputs cannot reuse an accepted
receipt. Preserve accepted artifacts and known v2 history. Verify one configured
provider request with owned synthetic facts and inspect actual UI completion
timings before claiming a performance gain. For grounded excerpts, prove exact
Unicode/whitespace preservation, duplicate and alias-collision handling, original
source/line permissions, immutable concurrent maps and changed-excerpt cache
fences. Exercise employer analysis through its real grounding and persistence
boundaries; excerpt references cannot add evidence or a positive verdict.

For bounded high-fit review output, run locked
`pytest tests/test_resume_review_response_bounds.py tests/test_artifact_determinations.py tests/test_materials_use_cases.py tests/test_material_review_history.py tests/test_tailor_voice_audit_integration.py`
and the full worker suite. In owned synthetic SQLite, prove every generated
nested string/list is finite, all six explicit model verdicts retain authority,
oversized responses consume only the existing structural-correction budget,
failed refreshes preserve the accepted receipt, and historical wider accepted
reviews remain readable with their complete original diagnostics. Inspect the
real configured-provider request, final receipt and all PDF pages in the UI;
a smaller format alone does not establish latency or quality improvement.

For parallel résumé reviews, run locked pytest for
the parallel-resume, parallel-letter, Materials-use-case, candidate-identity,
review-history and voice-audit suites, then the full worker suite. In owned
file-backed SQLite, prove actual factual/quality overlap, exact complete-request
reuse, a fresh quality verdict after any request change, opposite model verdicts,
unused receipt references on candidate rejection, parent-thread ownership
guards and draining of admitted siblings on cancellation. Reproduce a factual
rejection paired with a quality finding and require both recorded finding sets
in the same next repair. A speculative pass cannot approve a rejected candidate
or survive as the final verdict after a changed draft; repair evidence stays
inside the current catalogue and a final judge supersedes speculative feedback.
Preserve accepted bytes and all six high-fit persona decisions. Custom ports and in-memory
construction remain sequential. Measure live time savings through the normal
UI with the configured model, effort and required reviews unchanged.

For material candidate identities, run locked
`pytest tests/test_material_candidate_identity.py tests/test_material_review_history.py tests/test_materials_use_cases.py tests/test_tailor_voice_audit_integration.py`
and the full worker suite. Identical requests and common-prefix requests must
receive distinct IDs across parse/provider failures, parallel admission, bounded
correction and new generations. Require one unambiguous selected candidate in
the canonical persisted audit, unchanged old-generation selections and unchanged
full-request fingerprints. Model verdicts, factual/quality/persona receipts,
retry budgets and cache reuse keep their existing authority.

For batch Score ownership, run locked
`pytest tests/test_score_batch_ownership.py tests/test_scorer.py tests/test_score_activity_recovery.py tests/test_automatic_preparation.py tests/test_preparation_score_cancellation.py tests/test_v7_score_runtime.py tests/test_activity_score.py tests/test_workflow_job_pipeline.py`
and the full worker suite. In owned exact-schema SQLite, overlap a global
profile-continuation sweep with foreign pending/running ownership, queued
reservations and canonical cancellation. Preserve complete stage and accepted
score bytes while an independent peer succeeds. Race a second writer after
acquisition and revoke ownership after compute and after valid publication;
publication and terminal fences must each preserve the successor. Also cancel during
inference through both global and ordinary selected batch entry points; late
success and provider failure must preserve accepted score bytes and publish no
completion or failure event. Exercise
shared-donor loss without dropping an independently owned duplicate. Selected
sequential/parallel batches skip only typed reservation loss; genuine provider,
structural and determination failures remain visible. Run the actual Temporal
pipeline/Score activity and replay both global and selected paths, including a
global provider failure with a saved healthy peer. Synthetic model ports and
controlled typed scoring seams prove ownership and error propagation, not
semantic accuracy or live provider reliability.


For compensation lookup diagnostics, run locked
`pytest tests/test_compensation_source_outcomes.py tests/test_automatic_compensation_refresh.py tests/test_compensation_refresh_state.py tests/test_market_compensation_repository.py tests/test_levels_fyi_public.py tests/test_compensation_refresh_temporal.py`.
Use owned synthetic acquisition and persisted refresh paths to distinguish
reachable budget exhaustion, reachable unparsed pages, actual HTTP failures and
combined causes. Zero page allowance must make no request. Keep independent
role/country outcomes isolated and unsupported coverage explicit. Require the
same incomplete-lookup retry policy with retained new or previously accepted
direct fallback evidence. Record each protocol reason in the bounded target
receipt without retaining response bodies, headers or exception messages. Verify
the actual Temporal activity result and fresh-history replay for each cause.

For occupied-slot recovery guidance (#1184), exercise a registered synthetic
Apply activity through the worker inventory and heartbeat, the pipeline
operations API and the failed-run view. A fresh occupied slot with no
allowlisted details must remain active without exposing the Apply identity or
payload. Check mixed allowlisted and omitted activity, bounded/truncated detail,
unavailable inventory, and the transition to fresh exact zero. Only the last
state may be called idle. After a failed refetch, retain the cached snapshot but
do not use its idle values to enable Discover; test recovery on a later read.
A stale peer makes global occupancy unknown even when a fresh worker is idle.
Prove that an explicit user start remains available in that case without
claiming global idle, that an active Discover is reused, and that a fresh
positive activity blocks replacement. No test may retire a peer by age or PID.
For a projection-ready selected run with sufficient duration samples, verify
same-queue stale-peer contention withholds overall, stage, and source-family
numeric ETAs; fresh-peer recovery restores them. A failed operations refresh
must also mark a previously available source-family estimate stale without
mutating the cached snapshot, then show the new estimate after a successful read.
Run `test/pipeline-eta.test.ts` and `test/pipeline-operations.test.ts` for zero
selected-stage and source-family demand while Discover membership remains open.
Require `membership_open` rather than `no_work`, retain positive-demand current,
sweep and source ranges with sufficient evidence, and permit `no_work` after
closure. Empty global backlog remains independently scoped. Preserve stale
telemetry and unbounded-contention refusals.

For completed eligibility holds in pipeline operations, run
`corepack pnpm --filter @jobctrl/api exec vitest run test/pipeline-operations.test.ts`
and the API type/full-test gates. In owned exact-schema storage, reproduce a
20-member cohort with nine material sets, nine minimum-score skips and two
non-retryable eligibility holds. Require exact preparation receipt/run/plan and
current accepted Score ownership/version/staleness/gate provenance. Both cohorts
must resolve valid holds without relabeling blocked counts, altering canonical
rows/plans or hiding a real PDF lifecycle. Reject foreign/missing receipts,
replacement owners, newer/stale scores, reset stages and generic/retryable
blocks. Verify stage/overall ETA, remaining paths and swept contention all use
the same completed-hold authority. Exercise actual HTTP readback and preserve
canonical state. These are structural provenance checks, not semantic evals.

For per-job Score cancellation, run locked
`pytest tests/test_preparation_score_cancellation.py tests/test_workflow_job_preparation.py tests/test_workflow_control_capacity.py tests/test_automatic_preparation.py tests/test_score_activity_recovery.py tests/test_v7_score_runtime.py`.
Use owned synthetic storage and real old/new Temporal cancellation histories.
Verify cooperative event delivery, bounded cleanup, exact owner/job/step recovery,
preservation of committed scores and newer owners, and no material dispatch after
cancellation. A late success or failure must preserve canceled/reset state and
publish no score; ownership loss must skip without reclaiming work on retry.
Unavailable or different-run history never releases ownership. Keep the purge's
active-work guard intact.
Exercise both cold admission and accepted-score reuse after cancellation or a
newer owner, including unchanged cache attempt counts and valid explicit
rescores. A nullable/unknown SDK status must preserve ownership; same-owner rows
outside a single-job preparation's canonical job must remain unchanged.

For owned email confirmation, run locked pytest on `tests/test_gmail_connector.py`,
`tests/test_apply_saga.py`, `tests/test_apply_use_cases.py`,
`tests/test_apply_regressions.py`, `tests/test_apply_runs_projection_from_events.py`,
`tests/test_repeat_application_prevention.py`, `tests/test_workflow_apply.py`,
`tests/test_activity_apply.py` and `tests/test_rpc_handlers_apply_workflow.py`.
The receipt cases in `test_apply_regressions.py` traverse production acquisition,
use case, saga, Gmail client/sender, SQLite persistence, settlement and recovery
with synthetic storage and fake external transports. Exercise empty/204,
malformed/nonobject JSON, strict required/optional IDs, provider/transport
failures, forged operation bindings, independent concurrent settlement writers,
late receipts and interruption before/after confirmation persistence. Cover
nonstandard JSON constants inside ignored response fields, missing/foreign
settlement identities and ownership resolution under the writer lock, including
caller-owned commit/rollback and repeated settlement after a valid receipt.
Exercise a caller-owned transaction with both the no-op availability seam and
the production publisher: no send or caller commit may occur before a durable
intent. An independent connection must see the committed intent at transport
admission. After valid settlement, verify every owned event wrapper is published
and reject forged, foreign or successor-owned wrappers.
Inspect exact transport/intent/confirmation/submitted-fact counts and unchanged
accepted bytes. The bounded Temporal activity cases use the production use case and
writer behind a launcher-main seam, avoiding browser/process lifecycle effects.
They do not qualify a real browser or remote Gmail delivery.
Use the production in-process bus and projection subscriber to count success
notifications alongside durable rows. Inject terminal-artifact and submitted-fact
write failures; rollback must publish neither success event and a permitted
settlement retry must publish each once. Exercise inherited commit, rollback,
savepoint rollback and close, with an independent connection observing durable
facts at notification time. Race recovery against confirmation in both writer
orders. Pause the original sender after transport success, run a duplicate on an
independent connection and release the original receipt: one intent, confirmation
and submitted fact must survive, with no competing failure or second send. Also
cover malformed/lost-ack originals, exact replay, changed child identities and
legacy rows without a fingerprint.
Replay direct and wrapped `AgentResult`, `AssistantText`, `ToolUse` and
`ApplyTerminalDetermination` private-content canaries as well as email events.
Exercise historical `ApplicationFailed` ambiguity reasons/results with raw
exception suffixes. The production CLI-adapter regression uses synthetic stream
messages and fake subprocess/Gmail transports. The worker-to-API fixture
`tests/apply_receipt_privacy_fixture.py` feeds actual canonical writes into API
summary/activity/detail, SSE replay and Apply Review reads; broad delivery must
be safe while canonical review and determination provenance retain their source.

Run `corepack pnpm --filter @jobctrl/api exec vitest run test/server.test.ts test/application-feedback.test.ts`
for SSE replay filtering and canonical preview retention. Keep direct and wrapped
publisher canaries, worker-built Apply projections, legacy replay and canonical
Apply Review distinct. Reopening an ambiguous attempt must make no new transport
call; a persisted valid confirmation may settle only its own current operation.

For Outreach publication, run locked pytest for
`workers/automation/tests/test_outreach_repository_v7.py`,
`test_outreach_draft_gates.py`, `test_offer_outreach.py` and the existing Outreach
no-send/projection/follow-up suites. Run API `test/outreach.test.ts` with the
controller-prepared Python `.venv` available: its owned synthetic model ports
exercise real registered RPC, independent SQLite connections and normal HTTP.
Hold revision inside verification, separately commit send/approve/reject/newer
draft/schedule/reschedule/complete/dismiss, then require an explicit conflict
and exact preservation of canonical rows, anchors and lifecycle event counts.
Race revisions, first creation and deleted bases; freeze timestamps, interleave
snapshot reads, retain unrelated tenant/thread controls, inject row/anchor/event
failures, lose an HTTP acknowledgement and reopen the runtime/database. Require
one winner generation/event and no automatic regeneration or send replay.

Frontend form/hook/panel regressions and `e2e/tests/outreach.spec.ts` cover visible
conflict recovery, retained edits/checks after card replacement/removal and
deliberate retry. Type a newer edit while a revision is pending and verify it
survives success, failure and conflict; it must never be resubmitted automatically,
and both deliberate submission and discard must work. Include the real Offer recipient selector with a cached second
recipient: an earlier recipient's edit, completion and comparison controls must
remain suspended until returning to that recipient. Repeat for another job and
for generation's purpose/offer-revision scope, including a completion arriving
while another target is displayed. Exercise delayed generation and competing
first creation through the normal generation caller, preserving completed body,
checks and provenance across refetch and a failed deliberate retry. Global
mutation retry defaults must never cause automatic generation or revision. Browser presentation fixtures are separate from HTTP/RPC
persistence proof. See the [publication design](../../architecture/tailoring.md#outreach-publication-boundary)
and [user recovery](../../user/contacts-and-outreach.md#when-outreach-changes-during-verification).


For interpretation metadata citation sources, run locked
`pytest tests/test_interpretation_citable_fields.py tests/test_remaining_determinations.py tests/test_binding_repair_feedback.py tests/test_analysis_retry_boundaries.py`.
Use owned exact-schema storage and explicit synthetic model decisions. Omit
absent and whitespace-only metadata from both the source catalog and citation
schema; preserve nonblank text and literal zero. Missing fields must not replace
the model's full-posting judgment with a mechanical unknown. Verify model-selected
unknowns, cache/readback identity, and preservation of accepted bindings after a
failed refresh. Foreign IDs and changed quotes still exhaust one bounded
three-call budget; never substitute a quote or increase stage retry budgets.

For implicit per-job preparation after a manual Apply skip, run locked
`pytest tests/test_preparation_manual_decline.py tests/test_automatic_material_decline.py tests/test_preparation_score_material_block.py tests/test_v7_tailor_runtime.py tests/test_v7_cover_runtime.py`.
Use owned exact-schema jobs and real activity/workflow entry points. With a
passing score, a canonical manual Skip must stop implicit Tailor/Cover before
acquisition, model setup and attempt accounting; recheck a decline committed
between early selection and the locked admission. Preserve other tenants,
policy-only/legacy/retryable skips, foreign queued/running owners, unrelated
stops and accepted files/bindings. An Apply reset must reopen only this cause
before real automatic selection. Explicit RPC material actions carry a literal
frozen intent and distinct idempotency identity while retaining normal guards;
automatic identities remain unchanged. Decode absent legacy fields and replay
old/new real Temporal histories without stored model-output fixtures.

For cover-letter publication anchors, run locked
`pytest tests/test_cover_reviewed_anchors.py tests/test_cover_generation_repair.py tests/test_artifact_determinations.py tests/test_material_review_history.py`.
Use owned exact-schema SQLite and explicit synthetic model decisions. A passing
factual reviewer may endorse fewer candidate sources than the generator proposed,
or identify a source after an empty proposal. Persist exactly the reviewer's
source and requirement links, preserve the generator proposals separately, and
require both factual and quality approval. Test source-free lines, rejected first
attempts, failed refresh preservation and foreign IDs. A rejected draft must keep
valid provenance and inspectable findings rather than fail during persistence.
These are structural model-authority checks, not a semantic evaluation corpus.

For bounded JobStreaming source intake, run locked
`pytest tests/test_selected_board_wiring.py tests/test_source_registry.py tests/test_jobstreaming_source_result_budget.py tests/test_discovery_result_budget.py tests/test_workflow_discovery.py`.
Use owned exact-schema SQLite, synthetic adapters and real Temporal histories.
Prove supported boards upgrade their old experimental default while disabled and
quarantined intent survives; interrupt before/after the last admission and during
checkpoint acknowledgement; preserve exact request fingerprints and accepted
counts. Race independent live/capture writers for the last allowance. Fail receipt
insertion/readback, later identity attachment and execution lineage, including a
caller-owned savepoint: no partial canonical job, locator, admission receipt or
membership may commit. A source-specific cap must not stop healthy siblings, and
disabling all boards before retry must settle the frozen units without provider
acquisition. Replay histories with and without the source-budget patch. These are
structural ownership/transaction checks, with no native data or model calls.

For automatic compensation classification and refresh ownership, run locked
`pytest tests/test_compensation_source_outcomes.py tests/test_levels_fyi_public.py tests/test_compensation_classification_parallelism.py tests/test_automatic_compensation_refresh.py tests/test_compensation_refresh_state.py tests/test_compensation_refresh_temporal.py tests/test_workflow_discovery.py`.
Use owned exact-schema SQLite and synthetic provider rows. Prove configured
target-code deduplication and source/derivation error isolation across independent
role, level and country slices. Exercise HTTP rejections, empty/incompatible
responses, parser exceptions, unsupported coverage and exhausted page budgets;
cache upgrades for one level must not change a completed generic target receipt.
Verify exact source fingerprints and cached classification IDs on rejected rows,
bounded receipt omission counts, Unicode receipt sizes through the actual Temporal
payload converter, and activity-result readback and replay, without retaining
source bodies or exception messages. Prove configured
overlap/capacity, exact duplicate/cache identities and ordering, product-lane and
spend admission, thread-local connection cleanup, live renewal, atomic stale-owner
rejection and accepted-range preservation. Hold admitted model calls while a real
Temporal activity times out: its cooperative stop must prevent new admissions and
release current publication leases before those calls drain. Busy refreshes and
failed backoff must remain explicit instead of being reported as fresh success.
Generate and replay both the legacy and new compensation-budget histories; retain
their recorded 30-minute and six-hour budgets respectively. No native data,
provider calls, semantic eval corpora or recorded model-output fixtures belong in
these tests.

For blocking-activity cancellation heartbeats, run locked
`pytest tests/test_p1b_error_inversion.py tests/test_workflow_control_capacity.py tests/test_activity_connection_lifetime.py`.
Use both the ephemeral time-skipping server and an independent real Temporal
dev server. Hold cooperative cleanup longer than the server heartbeat but
shorter than the existing cancellation grace; the actual history must record
activity cancellation with no heartbeat timeout. The time-skipping server alone
does not reproduce the real server's cancellation heartbeat expiry. Preserve
ignored-cancellation abandonment, hard-timeout retry capacity, connection
cleanup, and workflow ownership.

For terminal enrichment preparation handoff, run locked
`pytest tests/test_workflow_discovery.py tests/test_discovery_enrichment_handoff.py tests/test_discovery_preparation_orchestration.py`.
Use an independent Temporal test server and owned exact-schema SQLite data.
Interrupt live capture when its producer finishes, then prove terminal enrichment
reclaims the job and uses the real flag-gated callback only after its commit.
With a second job, assert the first completed job starts preparation before the
next capture. Preserve execution/cohort identity, existing idempotent preparation
ownership, inactive/blocked admission, final fan-out and compensation ordering.
Generate and replay histories with and without the terminal-handoff marker;
old histories and already scheduled activities retain their recorded input.
No native workspace or provider calls belong in these regressions.


For conditional preparation completion, run locked
`pytest tests/test_preparation_outcome_audit.py tests/test_worker_reconciler.py`
and `corepack pnpm --filter @jobctrl/api exec vitest run test/pipeline-operations.test.ts`.
Recover actual synthetic Temporal completion results into owned exact-schema
SQLite, then read those same event bytes through the production API snapshot.
A successful material skip must leave PDF lifecycle absent and the immutable plan
unchanged while its exact run-owned receipt resolves the PDF as skipped in both
cohorts. Current skipped rows without a receipt, wrong tenant/job/owner/run/plan,
malformed or failed results, unknown decoder versions, and unrelated skips remain
insufficient. Ordinary successful work with no skip cannot explain a missing PDF.
Recorded PDF states retain precedence; refreshed pending prerequisites keep the
member unresolved. Prove bounded, starvation-resistant recovery, duplicate
idempotence, successor-owner fencing, transaction/thread ownership and no change
to workflow terminal outcomes or accepted materials. Do not infer historical
attribution from reason prose or nearby timestamps.

For planned PDF progress counts, run
`corepack pnpm --filter @jobctrl/api exec vitest run test/pipeline-operations.test.ts`.
Use owned exact-schema members in both execution cohorts. Without a PDF lifecycle,
recorded pending/queued/running required Score, Tailor or Cover prerequisites must
report waiting. A terminal preparation owner, absent prerequisite state, unrelated
running work, and completed/blocked/failed/canceled prerequisites must preserve an
unknown PDF gap. Recorded queued/running/succeeded/failed PDF steps retain their
own state even while upstream rows remain pending. Preserve exact PDF identity
joins, projection coverage, count partitions and private-input exclusion.

For optional post-approval résumé polish, run locked
`pytest tests/test_resume_polish_policy.py tests/test_tailor_voice_audit_integration.py tests/test_tailor_judge_selection.py tests/test_saved_default_model.py tests/test_tailoring_artifact_boundary.py`.
Prove a missing/false setting never acquires a voice provider; explicit boolean
true and injected ports retain the existing rewrite/no-op/rejection paths.
Required factual, quality and applicable persona verdicts retain authority.
The disabled pass must preserve the exact selected text and provenance, keep the
accepted review IDs, and record a truthful skipped audit. Rejected required
reviews, malformed/stale/foreign receipts, cancellation and rendering failures
must retain their existing failure and accepted-artifact preservation behavior.
Exercise the HTTP Settings route with both booleans and invalid types in owned
workspaces, retaining unrelated config bytes/values and avoiding provider calls
for a polish-only update. Cover the real form's default/saved/reset states,
changed-fields-only save during catalog failure, optimistic update and rollback,
and browser readback. Call counts establish avoided work; report latency only
when measured through completed production work.

For known eligibility blocks in preparation, run locked
`pytest tests/test_preparation_score_material_block.py tests/test_workflow_control_capacity.py tests/test_workflow_job_preparation.py tests/test_score_eligibility_stage_state.py tests/test_automatic_material_decline.py tests/test_v7_score_runtime.py`.
Exercise the actual Score activity and Temporal payload conversion with the
existing typed eligibility predicate, including absent legacy fields and
non-boolean flags. In a real independent Temporal server, finish Score, then
hold every main activity slot at both one and four slots. The blocked preparation
must settle without scheduling Tailor, Cover or PDF while those holds remain.
Replay old histories both with and without the additive field, plus new
short-circuit histories. Preserve low-fit override semantics, separate explicit
material work, accepted newer state, and existing source/profile staleness fences.
Use owned synthetic workspaces and no provider calls or personal data.

For selected broad-board routing, run locked
`pytest tests/test_selected_board_wiring.py tests/test_source_registry.py tests/test_discovery_scheduler_pr4.py tests/test_discover_reliability.py`.
Use owned exact-schema SQLite registry entries with a selected retained board
outside the saved default subset. Exercise the real registry read, explicit
selection, scheduler and durable provider-unit compilation for every registered
board. Prove a two-board selection reaches both identities, disabled sources
remain skipped, quarantined sources retain their existing probe budget, and
owner, URL metadata, saved defaults and persisted registry rows do not change.
An unknown runnable source or missing/malformed board configuration must raise
a typed configuration failure before provider dispatch; disabled unknown sources
remain safely skipped. Keep this format/identity QA independent of model
judgments and native user data.

For scoring evidence payloads, run the score-use-case, scoring-determination,
exact-v7 score-runtime and semantic-determination suites. Inspect the actual
composed request: canonical authored source IDs and exact text must appear once
as a source inventory, `candidate_evidence_ids` must match it, and every
requirement field and analysis generation must remain. Keep unconfirmed
suggestions excluded and retain opposite model verdicts, strict citation/ID
rejection and accepted-score preservation. Do not use native prompt/response
replay fixtures. Regenerate and check the semantic-result registry; the API
receipt-version regression must keep strict v10 history readable and distinguish
v11 current-only reads while rejecting unknown versions and malformed results.
Measure payload sizes separately from token counts, latency and semantic quality;
a smaller representation proves only the former.

For workflow/model trace joins, run locked
`pytest tests/test_worker_trace_context.py tests/test_workflow_run_context.py tests/test_activity_connection_lifetime.py tests/test_p1b_error_inversion.py`
and the existing OTel/RPC span tests. Use in-memory export and synthetic sources
to prove actual activity-to-blocking-to-fan-out parent IDs with both default and
owned executors, distinct concurrent jobs, concurrent reuse of one wrapper,
thread reuse after success/error, and cancellation while a retired generation
settles. Unrelated Python context variables and Temporal activity context must
not cross the handoff. Preserve canonical workflow event ownership, connection
cleanup, heartbeats and cancellation behavior. Prompts, completions, arbitrary
parameters and private exception messages must remain absent from model span
attributes/events/status. Verify a fresh owned operation's actual exported
parent links after activation; a time-window match is not a workflow join.

For posting-server rate limits, run locked
`pytest tests/test_browser_rate_limit_recovery.py tests/test_gateway_http_client.py tests/test_enrichment_politeness_gate.py tests/test_enrichment_url_safety.py`.
Exercise 429/503 responses through batch, connected and one-off acquisition.
Assert no posting capture/model extraction, a recorded HTTP status and cooldown,
server Retry-After pacing before another same-host request, independent other
hosts, bounded long delays and safe handling of absent or malformed headers.
Keep the host slot until response feedback is recorded. A deferred refresh must
retain accepted content and attempt history while the batch processes other
targets. Pair the fixtures with real Chromium and owned synthetic responses to
prove a throttled capture is empty and a later successful capture occurs only
after admission. Never contact live boards from these regression tests.

For anonymous enrichment capture, run locked
`pytest tests/test_enrichment_visible_capture.py tests/test_enrichment_extractors.py tests/test_optional_extension.py`.
Exercise real owned browser DOMs with hidden dialog/comment preambles longer than
the unchanged content cap, both a selected main and body fallback, CSS visibility
inheritance, visible inert content and an actually over-budget visible prefix.
The existing extractor must receive the exact visible description and link;
hidden controls must not win. Prove the original DOM, full status capture and
separately collected JSON-LD remain unchanged. Repeat the production public-page
capture in an owned temporary workspace for an affected URL; keep captures private
and do not replay them as semantic model fixtures.

For selected-job demand, run locked `pytest tests/test_career_learning.py` and
API `vitest run test/career-learning.test.ts` through their package owners.
Require a no-model, read-only preview including all-missing descriptions;
source-fingerprint/pre-spend fences; exact duplicate and missing-description
counts; confirmed-only evidence with exact IDs; opposite valid model outcomes;
provider/spend/schema/foreign-ID/non-verbatim/exact-value failures; and unchanged
accepted comparisons after failure. Race a profile save with the model call.
Choose a proposal through HTTP/registered RPC/SQLite, record completion evidence,
restart and read it back. Rejected/stale writes must preserve origin/history and
Profile/fit rows. Browser and hook checks cover explicit selection, citations,
review before spend, pending state, optimistic rollback, source invalidation,
separate aspirations/capability/activity and the unavailable demo. Inspect the
expanded surface for accessibility and desktop/mobile overflow. Synthetic model
doubles prove authority and failure handling; a configured-provider call with
owned synthetic sources separately establishes live model integration.

For parallel letter reviews, run locked `pytest tests/test_parallel_letter_reviews.py`
and the artifact-determination and worker-lifecycle suites. Exercise the production
builder against an owned file database: a rendezvous must prove both reviews
enter independently on separate connection-owning threads, while owner guards and
acceptance stay on the coordinator. Prove unchanged cached determination IDs,
separate frozen inputs, capacities one/four, the outstanding-pair bound, cancellation
before admission and after submission, terminal failure before blocked-state writes,
first-cause retention, typed source/provider/spend failures, bounded repairs and
accepted-artifact preservation. Stop must precede the next application-level
provider admission; already-admitted calls may settle with accounting. Drain
reviews before closing runtimes or removing temporary data. A real configured
provider call with owned synthetic sources separately proves the integration;
synthetic timing is not a whole-workflow speed claim.

For the optional LinkedIn guest dialog, run locked
`pytest tests/test_linkedin_guest_dialog.py` with the capture and URL-safety suites.
Use owned offline DOMs to prove origin/route scope, one rendered non-submitting
control, opposed explicit/default submit controls, a transparent earlier control,
actual walls without dismissal and zero form submissions. Inject delayed URL and
content changes during both direct and batch capture; both must reject through
the typed acquisition failure after all capture reads. Repeat a fresh affected
public URL through production acquisition and retain only private source captures
and safe control metadata. Do not substitute hidden-page extraction for dismissal.

For sole-provider canonical analysis, run locked
`pytest tests/test_single_provider_analysis.py` with analysis-determination,
ensemble, use-case, repository and provider-configuration checks. A sole admitted
leg must retain strict source verification and exact canonical/per-leg
verification IDs with no synthesis or duplicate verifier inference. Opposing
valid model verdicts must control acceptance, failed refreshes preserve the
accepted record, and a single survivor of multiple admitted legs must still
synthesize. Prove the revised execution cache identity, then run a configured
provider against owned synthetic posting data and inspect actual model/effort,
call provenance and persisted readback. Call-count reduction alone is not a
whole-workflow speed or quality-equivalence result.

Every displayed semantic judgment must trace to a persisted determination:
kind, schema/prompt versions, provider/model, input fingerprint, canonical source
IDs and verbatim citations. Inspect the canonical writer, the accepted artifact
binding, projection/API reads and actual UI joins. Unanchored lines must say
"no recorded source". Read-side similarity cannot repair missing provenance.

Use explicit fake `LlmPort` verdicts to prove authority: the same canonical input
with two different valid model decisions must produce different outcomes. Test
provider unavailable, spend denied, malformed JSON, schema/enum violation,
foreign IDs, non-verbatim quotes and exact-value mismatch distinctly, without a
lexical fallback. Check the lane and spend preflight run before each new call;
unchanged inputs reuse accepted determinations with zero calls. Failed refreshes
preserve the last accepted artifact. Do not create eval sets, labeled corpora,
baseline comparisons, English sentence corpora or recorded-output replay fixtures.

For preparation review gates, seed a latest canonical grade of 8, an older grade
of 10, a conflicting legacy `jobs` grade, and a second tenant sharing the JobId.
The production preparation reader and per-job Tailor entry must deliver only
the selected tenant's latest grade and version to the resume review gate. At
grades 8 and 9, run the actual resume use case from that reader: opposing valid
six-persona verdicts must control acceptance and persist their determination
bindings. A persona-provider failure preserves the accepted resume. A manual
grade-6 request retains grade 6, and an unscored target must remain readable
without adopting the legacy grade.

For material context, use the production plan builder with a synthetic fit edge
to a role date or another canonical context field. The source remains available,
the renderer preserves fixed fields, and omitting a generated context claim
receives neither an inclusion error nor shipped coverage. Selected achievements
and explicitly pinned context still require their claims. Keep the existing
unaffirmed-source rejection checks: context must not be pruned into acceptance.
Through real Temporal Tailor and Cover activity entry points, a bounded content
rejection must fail once as non-retryable `material_rejected`; provider/network
faults must still exercise their configured retries. Include
`tests/test_terminal_material_rejection.py`: all terminal material statuses must
persist non-retryable Tailor/Cover rows and events, remain ineligible for automatic
pickup after cooldown and preserve accepted artifacts. A new explicit Tailor
request may still consume its next durable attempt. Keep the opposing transient
and non-retryable provider cases through the real per-job entry points.

For an overflowing initial material selection, use owned synthetic supported
edges that require five distinct achievements under a four-bullet role ceiling.
Exercise the production selector through the resume use case. Opposite valid
model selections must change the selected graph, persist their source-cited
determination IDs and expose omitted requirements. Feasible seeds and impossible
explicit pins must make no selection call. Enforce pins, edge ownership, complete
requirement decisions, verbatim citations and the unchanged ceiling; distinguish
provider, spend, JSON, schema and binding failures. Unchanged inputs reuse the
accepted determination, changed profile versions invalidate it, and a failed
refresh preserves the prior accepted material and bytes. Prove the production
builder uses the configured generator route and tailoring lane, then make one
real configured-provider call using owned synthetic sources.

For review continuity, run the actual resume and cover use cases through three
synthetic model decisions. Verify exact prior determination IDs and complete
typed findings reach later generation/review inputs and the persisted audit.
Opposing valid final verdicts must control acceptance independently of their
diagnostic score. Repeat an unchanged draft: review history must affect its
determination fingerprint while unchanged claim verification remains cached.
Exercise a rejected high-fit persona review and changed-voice review; retain
all six independent personas and the accepted base when voice is rejected.
Historical quotes cannot become current finding citations. Provider or spend
failure after earlier reviews must preserve the last accepted artifact. Use
owned synthetic sources and explicit model choices, never native prose replay.

For mechanical binding repair, send multiple invalid literal quotes through the
actual scoring/model port. One correction must receive all current violations,
their structural paths and exact canonical sources. Opposing eligibility
decisions remain authoritative. Exercise typed citation mappings as well as
lists; invalid entries must never be cached as accepted. Scoring requirement
spans receive per-field canonical targets, including whitespace-sensitive input,
and blank spans receive no verbatim credit. Unknown requirement IDs must not hide
independent evidence-ID errors. Stubborn invalid output still exhausts the same
three-call limit; provider/spend failures preserve the last accepted score.
Failure text and stored blocked-state records retain safe codes rather than
source/model prose. Pair these owned synthetic cases with a configured-provider
correction probe before claiming live integration.

For version changes, seed an obsolete analysis projection with already-folded
event cursors. The TypeScript detail owner must rebuild it from the current
canonical version on startup or keyed detail read without a new event, or expose
no current analysis if none exists. Python refresh must leave this family untouched. The native
cutover removes the cached shape while preserving canonical history, cursors
and accepted artifact bytes. Citation format checks must reject fragments of
numbers and dotted identifiers while accepting complete values followed by
sentence punctuation or separated by commas.

For Discovery, save literal target settings and plan a run without an interpretation receipt or second approval. Inspect the actual JobStreaming query/location/remote parameters and each provider’s supported filters; capability warnings are not currently displayed in JobCtrl. Structurally valid fetched results must ingest without an extra model gate, even when they do not lexically resemble the query. Exact user-authored title exclusions retain durable filtered receipts. Exercise capture/ack interruption, lease fencing, retry idempotency and limits. Full-posting interpretation/scoring retain model authority and source provenance. Historical native cutovers preserve authored cells, canonical jobs, accepted files and raw captures.

For execution result limits, run locked
`pytest tests/test_discovery_execution_result_plan.py tests/test_discovery_result_budget.py tests/test_discovery_family_result_budget.py tests/test_jobstreaming_source_result_budget.py`
and `discovery-transactions`. Exercise actual family orchestration and real
Temporal plan/source activities plus replay with controlled provider seams in
owned file-backed SQLite workspaces. Race ATS and Workday through independent
connections for the final slot; repeat attempts and verify exactly one canonical
insert, receipt and execution membership. Cover each family's exact/under limit,
archived recovery using the last slot before fresh fetch, per-source cap handoff,
foreign tenant/run and unrelated-job controls, literal exhausted zero, deliberate
unbounded requests, canonical deduplication, receipt/lineage rollback and
search-unit checkpoint interruption. Counts must come from the exact execution's
durable admission receipts; a global Jobs delta is never evidence of exhaustion.
Old bounded payloads missing the frozen plan/execution or explicitly disabling
its authority must refuse before source planning, writes or acknowledgement,
while current direct bounded calls default to the safe authority and completed
workflow histories still replay.
Also reproduce an old `true` plan with a same-execution unreceipted ATS admission:
neither source execution nor reinvoking the planner may create fresh authority.
Verify immutable plan fingerprints, cap/source/mode mismatches from independent
canonical writers, plan disappearance/damage, transaction rollback and the absence
of queries/private settings from the operational marker. Cancel Workday immediately
after acquisition, after its first accepted commit and inside the next canonical
claim: no later job/receipt/membership may commit, and the accepted prefix remains.
Permanently delete an admitted Job and prove its operational receipt still
exhausts the run. Interrupt generic capture recovery after canonical commit but
before acknowledgement, then retry at zero allowance with both retained and
deleted owners: acknowledgement finishes with no new admission, observation or
Job recreation. The separate explicit full job/Discovery purge backs up and
clears these null-Job execution records while preserving source-control state.
An execution-scoped canonical writer that omits its optional budget must refuse
under the transaction when a bounded marker exists, including at an exhausted
cap. Preserve caller savepoints and pending writes, and retain unbounded controls
with no marker or an explicitly unbounded marker.

Compose the frozen result plan with archived Smart Extract recovery through the
production Temporal workflow: limit one, canonical admission, snapshot failure,
then retry with zero remaining allowance. Require one admission, observation
and snapshot, all three original discovery events exactly once, three total
intake model calls, no fresh fetch, and successful history replay. Add a second
unprepared capture: it stays pending without browser/provider setup, while the
prepared first capture completes and is acknowledged.

For actual offers, drive the per-job offer HTTP/client entry and rendered
Application outcomes panel without interview prep. Verify null equity,
benefits/deadlines and explicit unknown currency/time base, source confirmation,
concurrent expected-ID conflicts, accepted-to-declined corrections, retained
prior terms/decisions and unchanged stage/submit records. Read and refresh the
ordinary projections after a correction; the offer reader must retain its
current canonical revision. Inspect the real outreach prompt and persisted
source context: actual terms, canonical achievements and bound compensation
evidence have distinct authority. Opposing fake-model verdicts must control
the gate for identical inputs. Malformed/provider/budget failures and a source
change during generation preserve the last approved text. Stale bindings block
approval, clipboard copy and send logging; general SSE/activity/audit reads must
exclude every private quotation and reason. Browser QA covers recording terms,
deciding/correcting, reload/history, a linked-contact draft entry and mobile
layout, using owned synthetic data only. Run `offer-outcomes.spec.ts` in the
production API/RPC browser gate (`JOBCTRL_E2E_ISOLATED=0`), which exercises
supporting history reads as well. CI names it explicitly in that step; the
isolated fixture skips it because it denies those Python RPCs. An isolated
skip is not offer product-path proof.

For interview preparation, inspect each actual drafting prompt with a supported
question and explicitly empty selections. Only that question's selected evidence
may appear. Drive unsupported/accepted outcomes with verifier verdicts; the
empty selection produces gaps and never borrows another question's evidence.
Accepted preparation and independent notes survive a failed replacement.

When the human flags a visible defect, especially in review, rationale, audit, evidence, scoring, tailoring, or apply-approval surfaces, treat the screenshot as a symptom, not the bug. Do not start by hiding, filtering, renaming, or moving the displayed value. First state the product invariant the surface is supposed to prove, then trace the value end to end: source input, extraction, profile evidence, selected controls, prompt or deterministic transform, generated artifact, validator/judge output, persistence, projection/API read model, and UI rendering.

For auditability features, every displayed claim must have an explicit source of truth. Before editing code, identify whether the source is canonical user profile data, the job post, score evidence, tailoring policy, generated artifact text/PDF, validator output, judge/adversarial response, event log, projection row, or derived read-model computation. If the correct source is missing, compute or persist the missing audit data at the owning layer; do not remove the UI field just because the current data is embarrassing.

Any fix to evidence, rationale, keywords, persona judgments, or generated-material status must preserve user value:

- Missing/covered keyword lists are useful only when computed against the actual generated resume text or explicitly recorded generation-time coverage. Never infer misses from job keywords alone, and never suppress the missing list as a substitute for computing it correctly.
- Persona/judge summaries are not enough. If a persona score or pass/fail is shown, the audit trail must make the prompt, rubric, model response, score basis, blockers, warnings, and repair instructions inspectable when the data exists.
- Post-generation warnings must be labeled by lifecycle: whether they were used to repair a candidate, accepted as residual warnings on the selected candidate, or produced after acceptance and therefore did not influence the artifact.
- Re-tailor/retry actions must not hide or suppress the last accepted artifact until a replacement is approved. Failed refreshes remain audit history; they must not destroy the current reviewable material.

Before claiming "fixed" on these surfaces, add or update a regression fixture that proves the exact invariant the human complained about. Prefer a fixture that reproduces the bad state from canonical data rather than a shallow component snapshot. State what was verified and what was not; do not use "fixed" for cosmetic masking.

Required-bullet findings must come from `LlmPort.chat_json` in
`domain/profile/required_bullet_coaching.py`. No word lists, opening phrases,
strength flags or result regexes may independently create/suppress findings.
Verify identical input can bind different valid model decisions without added
questions. Inspect the actual minimized prompt for the saved claim and linked
evidence. Test unavailable/error/invalid model responses with no heuristic
fallback; failed refreshes preserve the last reviewed output. Worker tests must
check canonical sources and version before spend, the profile accounting lane,
strict references/kinds/guidance, and version after the model returns.

Shared TypeScript fixtures cover mechanical source/version binding, whitespace
applicability, collision/identity safeguards and payload limits, using explicit
model test doubles. Feed bound output into the real form's Accept path and
verify the exact saved bullet/pin/version and preserved evidence. The offline
demo must report coaching unavailable. Follow the
[focused commands](../../local-development.md#required-bullet-coaching-verification)
for worker, API, form and isolated browser proof.

For Required-bullet coaching, use an owned saved profile with required and
optional bullets, a supported metric, and incomplete achievement evidence.
Trace each source reference to the exact saved entry, bullet, and profile
version. Exercise generation, individual rejection and acceptance, missing
evidence questions, local edits during a delayed response, a newer canonical
version, and failed generation/save. A manual Save or autosave during a pending
accept must not send a second profile write; a same-bullet manual edit must
keep its Required pin when unique and block ambiguous duplicate text until
resolved, including after a failed accept. Move that bullet below another one
while Accept is pending, then settle success and failure: the pin must follow
the moved bullet, never the bullet left at its old index. After a successful
or failed accept, also edit the original Required bullet and change another
bullet to its old text while the request is pending. Preserve both edits and
block Save until the ambiguous pin is explicitly resolved; only a proven
reorder may carry the pin to a new index. After a successful accept, an older
query snapshot must not offer or perform a rebase. A proposed
cleanup that would equal another saved bullet or Required pin must not be
applicable. Rebase a different
bullet in the same experience entry after a committed write with a lost
response; keep overlapping or reordered bullet identities blocked.
Do not grade model judgments with a sentence table or evaluation corpus. Test
opposite valid model verdicts and source-binding failures on minimal owned
synthetic inputs. Hold an accept
pending, advance
the five-second autosave timer, and prove no second write occurs on either
success or failure while unrelated draft fields remain. Fence ordinary manual
and autosave full-profile writes to their actual saved base version, permit an
initial version-null save, and rebase non-overlapping edits after a conflict.
After a successful accept, delay the
profile-query refresh, attempt a manual save after another canonical write, and
prove it carries the accepted version fence and preserves the newer fields.
After a failed accept, exercise the actual optimistic query rollback at the
same version and keep the reviewed suggestion available.
Count every achievement row that matches a Required bullet before deciding
whether a source identity is unique, including rows with blank or overlong IDs.
The browser must reject an accept against that ambiguous saved snapshot, and
every emitted source ID must satisfy the response schema's raw length bound.
Malformed saved evidence JSON must not be silently decoded to empty arrays.
After a failed accept, retain the reviewed suggestion and reconcile a later
unique bullet edit before its manual Save or autosave; block duplicate identity.
Generation and rejection must write no profile state. Accepted cleanup must
retain every factual token, the achievement
identity, bullet order, and Required pin. Missing evidence must remain a question
without an applicable fabricated replacement. Verify persistence and reload
through `/profile` and the real API with temporary SQLite storage; label
synthetic provider dependencies separately. An unchanged accepted determination
must make zero new provider calls; a first determination must prove the lane and
spend preflight before its call. These checks prove wiring and model authority,
not model judgment quality.

## Cumulative Redesign Boundaries

The `base-rhea` ancestry, semantic tokens, Helvetica Neue/Helvetica/Arial type,
square geometry, neutral chart ramp, monochrome focus/primary treatment, and
icon/dot-plus-text domain statuses form one contract. Direct Radix imports, raw
native selects, route-local primitive replicas, capsule statuses, and
card-per-datum layouts are regressions even when the page compiles. Body copy is
14px in every density; density changes geometry only. Primary routes share the
compact PageHead hierarchy. Prove the same production-shaped content across
light/dark, all three densities, desktop, collapsed rail, and 390×844.

Jobs has one table with a static multi-select Job state filter for Active,
Deleted, and Hidden; `closed` remains a compatible URL/read-model value for old
links. Active rows omit redundant posting-lifecycle copy, Sources and Warnings
are hidden only in the default presentation, destructive actions retain
destructive treatment, and focus-only row activation remains keyboard
discoverable. At 900px and below,
Jobs, Artifacts, Contacts, Discovery, and Settings record tables must keep their
fields and sort/filter access in labelled cards instead of overflowing the
page. Profile and Evidence Map must stack their desktop regions. Apply Review
keeps the queue left on working desktops, then stacks it above sequential
full-width content and wraps decisions as space narrows. Artifact Detail keeps
the document preview after the audit details.

Pipeline operations uses a deterministic execution with three source families
and exactly two reconciliation steps. Current execution, execution sweep, and
global backlog remain distinct; raw activity inputs and private identifiers
must not enter the read model or DOM. Verify event invalidation, bounded polling,
ETA/freshness/capacity/task-queue degraded states, observation time, and active
inventory without replacing unavailable evidence with a numeric guess. Exact
stage outcomes must remain available even when the primary view summarizes them
as running, waiting, finished, and attention totals. The UI must use **N of M
finished**, never **N% terminal**, and must keep source-family counts visibly
separate from worker and browser capacity. A genuine coverage rebuild must say
**Checking previous run records**, explain that it finishes automatically, and
must not present the internal recovery state as ongoing work. Stopping active
discovery must refresh the pipeline snapshot. Replacement-run setup is allowed
only for an exact zero active-work inventory, never for a positive or unavailable
inventory, and it must not dispatch until the user submits the Discover controls.

Browser reads may detect installations only to return opaque kinds and labels.
They must not disclose paths, launch, adopt, or persist a browser. Enablement is
explicit, re-resolves the selection, and fails closed when stale; manual path
entry and profile-copy consent remain separate. An environment-owned provider
route stays active and read-only while alternative routes remain editable but
inactive until environment removal plus restart.

For retry with `runAfter: true`, worker readiness precedes reset. A readiness
failure leaves state, attempts, error details, retryability, and audit evidence
unchanged and dispatches no work.

For retry presentation and stale-score advice, hold both the retry response and
the subsequent Job Detail read. Exercise the real Job actions caller: Discover
sends `runAfter: false` and remains pending, while a dispatched preparation
retry retains running feedback. If a response reports a reset without dispatch,
the stage and workflow summary both settle to the returned state before the
next read completes. Also return a failed or unsupported dispatch after the
reset: both views retain the returned pending stage through a held and failed
readback, and the dispatch failure remains visible. Check rollback on request
failure. While an earlier retry response is held, publish a newer StageStarted
detail through the event stream; then release the earlier reset, dispatch-failure,
or request-failure response and fail the next read. The newer running stage and
workflow summary must survive. Also cover a newer publication whose projection
is structurally equal to the optimistic data. Publish the old failed stage in
a read before the reset commits, including after query recreation: a delayed
reset response followed by a failed read must leave an explicit uncertainty
notice visible. Hold a pre-commit read across the response and ensure its success
does not clear the notice or substitute for a distinct confirmation read. A
successful post-response read clears that notice. Fail a confirmation and retry
it through Job Detail, reopen an inactive job, and switch jobs and tenants; each
notice must remain scoped to its owner until that owner's confirmation succeeds.
While a confirmation waits, complete a matching post-response read and ensure
no unnecessary second read starts. Close the drawer while its earlier read is
held and another component still subscribes to the query; the closed drawer's
operation must not start a later read, and reopening must still confirm it.
Open Job Detail by a URL alias and retry the canonical Job while response and
readback are held; the mounted alias detail must show the reset without changing
another Job's cache. Navigate both from alias to canonical and from canonical
to alias with a previously cached alternate: it must be stale and refetch on
mount. Its retained state must show its own uncertainty notice through held or
failed readback and clear only after that locator confirms the same canonical
job. Preserve unrelated and other-tenant entries and newer cached values. If an
alternate read was already in flight, including an initially empty cache entry,
recheck the same query instance and returned job key after it completes, then
invalidate the matching entry again; an active alternate must fetch again. A
recreated query or a different canonical job must not be claimed.
Open Screening Answers in an alias detail so it subscribes to the canonical
detail query. A matching post-response read through that subscriber clears the
canonical locator's notice even before its drawer is opened; a pre-response
read cannot clear it. Overlap two retries while that subscriber's initially
empty read is held and confirm both with one subsequent read. Repeat with the
second retry settling during the first confirmation: that earlier confirmation
must not clear the second retry's notice. Reject an application-target refresh
with 409 and ensure no stage-retry uncertainty notice is created for an
alternate locator.
Feed both the API
response and recorded event advice through the registered Python CLI with an
owned no-spend seam; the resulting score workflow input must set `rescore`.
Check Python's stage and event advice the same way and preserve the accepted
score. These checks do not establish stale-marker resolution timing.
For demo mode, use a retained synthetic workspace with a previously retryable
failure: retry controls and diagnostics must reflect the unavailable demo
capability without rewriting the saved record. Local retry behavior remains
covered independently.

## Live Profile Discovery And Automatic Recovery

Require a healthy worker before starting worker-backed stages. With the API
running but the extension offline, prove Settings/Pipelines report that status
while eligible Discover, job-level Enrich, and bulk Enrich launch/retry routes
can dispatch. Worker-unavailable retries must still preserve stage state,
attempt count, diagnostics, metadata and events before reset. The owned
`optional-extension.spec.ts` Chromium flow checks real UI/API dispatch through
the existing stub dispatcher; pair that proof with persisted production worker
fixtures because the browser harness does not run a worker or contact sources.

Pair/reload a built extension, wait for
`GET /v1/discovery/browser-extension/status` to report a fresh selected
heartbeat, and prove the UI reports connected preference. The extension E2E must lease a
synthetic public-looking API task whose origin root is non-HTML, execute it in
the extension service worker from the same persistent Chrome context where a
site cookie was set, return that cookie-observed response, and leave no copied
profile or API tab. Reproduce a request that never responds and prove the hard
task timeout posts a retryable failure without leaving a tab. Reproduce a
public-to-loopback redirect in both HTTP and rendered-page modes and prove the
loopback target receives no request. The rendered-page result must be promptly
non-retryable `unsafe_redirect`, without consuming the task timeout. Render a
fixture that hydrates its posting through a second origin and prove its
page-owned fetch succeeds. Return a retryable task failure for one job/target
and prove remaining Enrich, ATS, and Smart Extract targets complete in the same
attempt; preserve the failed target's retryability. A disconnect after extension selection and
cancellation must still fail or stop that acquisition without another transport;
offline status at a later setup can select guarded anonymous access.
Also lease a rendered-page task against a delayed LinkedIn SDUI fixture:
`JobDetails_AboutTheJob_*` must remain unready while empty, then return its
populated description even when cold hydration takes longer than 12 seconds.
Preserve that section through snapshot cleaning and deterministic extraction,
excluding neighboring company and recommendation content. Background-tab polling uses a monotonic deadline, not
a count of requested sleep intervals; a never-ready page fails and cleans up.
Finish source intake while a live Enrich capture is in flight and prove the
terminal pass reclaims and processes its job instead of leaving it canceled.
Separately cancel the owning workflow and prove its exact cohort still closes,
including queued rows released by the stopping consumer.
Pair two installation IDs and prove only the explicitly
selected one can heartbeat/lease/complete; token rotation must clear that
binding. Admit four concurrent leases, reject a fifth with bounded backpressure,
and prove the worker waits for capacity before starting its lease deadline.
Keep an active lease alive beyond 45 seconds and prove Settings remains
connected. Feed multibyte request/result fixtures and an oversized stream to
prove byte bounds and early cancellation. Worker fixtures must prove every
JobStreaming adapter session plus ATS, Workday, Smart Extract, and
integrated detail enrichment prefer a connected bridge and can select guarded
anonymous acquisition under the same exact `DiscoveryExecutionRef` when offline.
Exercise the actual installed provider/session transport, not only custom fake
adapters: private initial URLs, private DNS and public-to-private redirects must
stop before socket I/O; public redirects must succeed through the real adapter
connection hook, with sockets pinned to validated numeric addresses. Change DNS
between validation and connection, recreate a provider's search session, and
create per-detail Requests/tls-client sessions; all must retain the guard. Verify
headers, cookies, body/query/timeout options, cancellation and proxy rejection.
Keep socket/DNS fixtures owned and prohibit external requests. Browser-owned
Cookie/User-Agent headers must never cross connected worker task contracts. Seed an unresolved legacy WelcomeToTheJungle row and
invoke the outer Temporal `run_enrichment()` entry: workflow/run identity must
be bound before legacy URL repair. Connected selection must not launch
anonymous acquisition, and neither mode may use the copied-profile pre-pass. Serve a denied or unavailable `robots.txt` alongside useful content and prove
neither connected nor anonymous Discovery/Enrich requests or evaluates it.
Use a legacy `honor` source policy and an exploding injected robots port to
prove old values cannot re-enable consultation. Fetch and persist the content
while pacing, request budgets, URL safety and audit history remain active.
Seed historical robots-blocked rows and prove an audited retry succeeds in
either mode without stranding an open transaction. Prove that a Temporal-backed standalone Enrich retry synthesizes its
bridge execution reference, never launches or reads a copied profile, and that
extension reconnection recovers both the current blocked-condition value and
the legacy value without duplicate dispatch. For LinkedIn rendered pages, verify an active task-owned tab in an unfocused
window preserves the current window/tab and obtains the hydrated description
with exact-origin guards installed first. Compare a hidden control using native
Chrome without Playwright page attachment or focus emulation. Unit fixtures must
cover failed window creation, pre-cancellation, late tab/window/rule completion,
timeout, and user-added tabs surviving task cleanup. Loaded-extension fixtures
must assert actual window creation and removal, while reporting their emulated
visibility boundary separately. Finally, run a bounded Discover
product path and confirm the bridge reports task activity and the workflow
reaches a truthful terminal or actionable failed state. Do not use an
application form and do not submit anything.

For automatic preparation recovery, seed canonical failed enrichment and a
saved enriched/unscored job, then exercise worker startup/heartbeat without a
Discover command. Prove enrichment can advance to a persisted score, a restart
or lost dispatch acknowledgement retains one execution, and retries preserve
attempts and cooldowns. Include canceled/unsafe/blocked/exhausted, deleted,
closed, and other-tenant jobs; preserve accepted scores/materials and prove no
Apply dispatch. The historical discovery consumer-stop fixture must require
positive evidence from the exact completed run and reject user cancellations.
Use the real Temporal recovery fixture to prove worker replacement, late
provider results after cancellation, and exact stopped-owner settlement.
Missing workflow history must retain ownership; a recovered enrichment lease
must reject a late predecessor write.
Hold real per-job and one-stage automatic batch activities open together, then
prove normal recovery can enrich and score an unrelated job before either is
released. Resolve exact cohorts from immutable start events, including ordinary
per-job fanout with absent workspace paths; reject foreign paths, copied/wrong-run
history, empty/malformed cohorts and conflicting executions. Exclude every busy
member between activities and retain its attempts, owner and accepted materials.
Verify shared internal capacity, full-capacity refusal and capacity released by
completed members. Active queued manifests must not starve unrelated work.
Unscoped/manual batches, discovery/import workflows and unknown canonical owners
still gate dispatch. Race owner replacement and independent SQLite writers;
require one frozen reservation and one queued event. Recognize Enrich's compound
activity/run/attempt lease, require the exact recorded execution for closed queue
settlement, and prove missing history cannot start a replacement. Replay all
observed production histories and prove no Apply dispatch.
For an automatic batch interrupted by an activity timeout, include one consumed
job and one reservation that never started. Prove the latter returns to pending
with unchanged attempt counters and can enter a new workflow after cooldown,
including when the earlier cleanup already marked it `PREPARATION_RECOVERY_STOPPED`.
Require the exact execution's timeout and durable attempt progress; cancellation,
termination, missing history, mismatched cohorts, and preflight-only failures
must not release reservations. Include copied timeout history in a reset
descendant and a mismatched scheduled activity owner. Recheck protected rows
while holding the write lock.
An owned Score must persist a requirement-fit report for its exact score version,
and real Tailor prerequisite evaluation must consume it. Reproduce a historical
missing report, rescore only that job through the normal workflow, preserve the
old score, and prove both explicit and automatic Tailor continuation. Automatic
continuation must respect the real cooldown. Incoherent or empty reports and
canceled, exhausted, non-retryable, or budget-exhausted rows must remain blocked
from automatic resumption.
Dashboard source-health and digest QA must show JobStreaming names while
retaining the underlying quarantine, failure counts, and stable source IDs.
For fetch-condition recovery, seed the exact legacy `DETAIL_UNSAFE_URL` DNS
failure and a typed equivalent with matching canonical attempts/events. Prove
both posting and failed-request destinations must pass fresh public checks,
normal worker dispatch preserves attempts/cooldown, and private, canceled,
changed-owner, deleted, closed, exhausted, and unrelated rows remain untouched.
Check the five-recheck cap, immutable failure history, and API/worker projection
parity. Exercise DNS rebinding and private redirects through the real guard,
and confirm a later timeout cannot replace stronger destination-denial evidence.
The job drawer must show the typed cause, historical observation, current
recheck result, and manual fallback without claiming the original denial was a
permanent site policy or suppressing technical evidence.
Exercise partial acquisition through both the intake fetcher and anonymous
batch entry point. Inject typed script/ping timeout and DNS failures during
navigation, a navigation exception, and snapshot collection. Both paths must
retain the readable document, carry incomplete status evidence with the exact
acquisition reason, and return unknown availability before any model call.
Main/embedded-document failures, private destinations and resource-size limits
must still prevent extraction. A real Chromium fault probe separately exercises
the batch entry point with owned synthetic documents; it must not access native
data or replace the independent interpretation/description-quality gates.
For summary metric grounding, seed a baseline tenure estimate with no supporting
achievement and a separately pinned verified metric. The normal Tailor use case
must reject the tenure claim even with an unrelated citation, retain that failure
in the audit, accept a grounded qualitative rewrite, and preserve the pinned
metric and original profile. Retry instructions remain code-owned guidance.

## High-Risk Regression Areas

The highest-risk boundaries are apply submission safety, credential/privacy
containment, workflow durability, projection correctness, schema compatibility,
and accepted-artifact preservation. The
[Regression Catalog](regression-catalog.md) explains which layer
proves each class of invariant; the complete page maps every risk to exact tests.

### Automatic compensation discovery and projection

Use disposable exact-schema databases only. The gate must prove that terminal
Discovery invokes the replay-patched automatic activity before terminal
preparation, while histories recorded before the patch schedule no new command.
An absent or explicitly disabled Levels.fyi preference must perform no Levels
request; an enabled preference may load it through the policy-routed client.

For benchmark state, prove a missing slice refreshes, a fresh slice skips until
the seven-day boundary, an unavailable source retries after one day, stale lease
holders cannot publish, and one broken source preserves independent evidence.
For geography, prove exact-country direct evidence stays direct, locality rows
are not promoted to country authority, and a missing country can retain a
low-confidence cost-of-living-only numeric range with direct/price/company
lineage. A raw factor outside `0.1x`–`10x` must remain visible with
`factor_out_of_bounds` in both Python and TypeScript projections. Failed refresh
must preserve the last good per-job range, and employer-posted facts must never
become direct or extrapolated market facts.

```bash
uv --project workers/automation run --extra dev pytest -q \
  workers/automation/tests/test_workflow_discovery.py \
  workers/automation/tests/test_automatic_compensation_refresh.py \
  workers/automation/tests/test_compensation_refresh_state.py \
  workers/automation/tests/test_compensation_benchmark_materialization.py \
  workers/automation/tests/test_market_compensation_repository.py \
  workers/automation/tests/test_levels_fyi_public.py
corepack pnpm --filter @jobctrl/contracts check
corepack pnpm api:check
corepack pnpm --filter @jobctrl/api exec vitest run \
  test/market-compensation-estimates.test.ts \
  test/projections.test.ts
```

### Stable JobId v7 and explicit-feedback cumulative gate

Run this gate on the final stack tip with disposable SQLite fixtures only. Do
not point it at `~/.jobctrl/jobctrl.db`, a real Temporal store, or any live
application target. The Python commands deliberately use the fixed project
virtual environment directly so validation does not rewrite lock metadata.

```bash
PYTHONPATH=workers/automation/src workers/automation/.venv/bin/pytest -q \
  workers/automation/tests/test_v6_to_v7_*.py \
  workers/automation/tests/test_exact_v7_*.py \
  workers/automation/tests/test_detail_projection_job_id_contract.py \
  workers/automation/tests/test_jobstreaming_gateway.py \
  workers/automation/tests/test_jobstreaming_resumable_discovery.py \
  workers/automation/tests/test_learning_recommendations.py \
  workers/automation/tests/test_sqlite_learning_recommendations.py \
  workers/automation/tests/test_rpc_learning_recommendations.py \
  workers/automation/tests/test_tailoring_policy_revisions.py \
  workers/automation/tests/test_scoring_eval_feedback.py
workers/automation/.venv/bin/ruff check workers/automation/src workers/automation/tests

corepack pnpm --filter @jobctrl/api exec vitest run \
  test/exact-v7-projections.test.ts \
  test/read-model-v7.test.ts \
  test/application-feedback-v7.test.ts \
  test/write-model-cancel.test.ts \
  test/server.test.ts
corepack pnpm --filter @jobctrl/web exec vitest run \
  src/contexts/operations/realtimePatches.test.ts \
  src/contexts/operations/realtimeListPatches.test.ts \
  src/contexts/operations/workflowRealtimePatches.test.ts \
  src/contexts/operations/invalidation-router.test.ts \
  src/contexts/apply/components/CancelApplyButton.test.tsx \
  src/contexts/apply/hooks/useCancelApplyMutation.test.ts \
  src/contexts/materials/components/LearningRecommendationReviewPanel.test.tsx \
  src/contexts/materials/components/TailoringPolicyHistoryPanel.test.tsx
corepack pnpm web:test-d
go -C launcher test ./internal/launcher
corepack pnpm check
corepack pnpm test
corepack pnpm docs:build
git diff --check
```

The product path must then verify in a disposable seeded API/web workspace that
Runs shows the shared Discover/preparation/Apply timeline; repeated cancellation
does not overwrite a terminal result; targeted events update an open job,
registered artifact, and workflow detail without resetting filters, selection,
pagination, or scroll; and Dashboard supports recommendation evidence,
accept/reject, policy history, and explicit append-only restore. After
acceptance, explicitly re-score/re-tailor synthetic work and verify the prior
score and accepted artifact remain unchanged until those commands are invoked.
The gate must also prove that no feedback decision or restore automatically
starts scoring, tailoring, Apply, or artifact work. Do not perform a real
application submission or mutate a real user database during this QA.

Run `apps/web/e2e/tests/realtime-list-context.spec.ts` for the realtime
list-patch path. It uses the real SSE adapter to prove that second-page
selection and scroll survive eligible list patches, that eligible lists do not
refetch, and that undeterminable membership or ordering falls back to
exact-page invalidation.

The same product path must prove that a successful Enrich row can display an
explicit non-blocking application-target outcome, including LinkedIn on-site
apply, and that its technical details expose only the allow-listed outcome
rather than raw resolver metadata. The regression fixtures must cover every
application-target outcome, redact a resolver error containing a private local
path, and repair a legacy non-LinkedIn snapshot without browser navigation.
A targeted workflow run must also identify its selected stage scope in the run
heading and details.

The browser-local public demo may cover realtime state preservation, but its
learning capabilities are intentionally unavailable. Recommendation review,
policy acceptance/rejection, and rollback must therefore run through the seeded
non-demo local API/web fixture.

### Repeat-application prevention

Use disposable SQLite fixtures and the simulated web dispatch boundary; never
point this matrix at a real application target. The focused proving surface is:

```bash
uv --project workers/automation run --extra dev pytest -q \
  workers/automation/tests/test_repeat_application_prevention.py \
  workers/automation/tests/test_apply_regressions.py \
  workers/automation/tests/test_apply_saga.py \
  workers/automation/tests/test_workflow_apply.py \
  workers/automation/tests/test_rpc_handlers_apply_workflow.py
corepack pnpm --filter @jobctrl/api exec vitest run \
  test/repeat-application.test.ts \
  test/application-feedback.test.ts \
  test/schema-version-guard.test.ts
corepack pnpm --filter @jobctrl/web exec vitest run \
  src/views/apply-review/ApplyReviewView.test.tsx \
  src/contexts/apply/components/ApplyReviewDecisionControls.test.tsx \
  src/contexts/apply/hooks/useApplyReviewMutations.test.ts
corepack pnpm --filter @jobctrl/web e2e -- tests/repeat-application.spec.ts
```

The fixtures must cover same-canonical-job and accepted-duplicate identities,
alternate URLs, same-employer/equivalent-role confirmation, distinct-role and
similar-employer allowance, dry-run/failed-attempt/pending-suggestion exclusion,
direct dispatch, repeated standing polls, concurrent claims, stale approval,
one-attempt consumption, and immutable audit evidence. The browser path must
show the exact block, prior evidence, reasoned confirmation, refreshed
override-ready state, and a simulated live dispatch while proving no
`ApplicationSubmitted` fact was created.

### Pipeline history recovery and restart regression

Race the real RPC dispatch-start writer against the workflow's detailed start
marker in both orders, with empty and sparse summaries. The exact same Temporal
run must retain its recorded job/configuration keys across projection refreshes.
Reusing the workflow ID for another run must clear prior metadata even when the
new summary is absent. An unidentified execution cannot merge job bindings;
late duplicate starts preserve terminal truth, while explicitly marked
same-run missing-history recovery retains its known inputs. Keep every start
fact in the timeline. Use owned structural SQL fixtures and no model replay.

Reproduce the human-reported partial-projection state with an active Discover
execution, 72 expected execution members, 15 persisted members, 16 expected
pipeline-step keys, four persisted keys, one live source-family activity, three
live tailoring activities, and an approximate activity backlog of 41. Verify:

- the durable checkpoint and operations response remain `recovering`; partial
  row counts, active slots, and fresh telemetry never promote it to `ready`;
- the UI renders **Checking previous run records**, the 15/72 linked-job and
  4/16 stage-record check progress, and the live worker/queue/activity facts;
- selected-run counts, source/reconciliation ledgers, ETAs, **0% terminal**,
  and **No work remaining** stay hidden until the checkpoint is `ready`;
  and
- a stale `ready` row whose exact key digest no longer matches is downgraded to
  `recovering` by the API and selected for worker repair;
- an idle snapshot with no selected execution has `projectionCoverage: null`
  only when fresh available telemetry proves zero active slots; occupied, stale,
  or unavailable runtime inventory reports `recovering` instead of fabricated
  idle or `ready`; and
- a non-ASCII membership and stage-key golden vector hashes identically in the
  Python recovery writer and TypeScript API validator.

For manual URL intake, seed four `job_url_import` activities without a selected
Discover execution. Prove exact slot/detail totals, bounded readable items,
opaque identifiers, null-safe workflow identity, completion cleanup and no
invented pipeline stage. Mix imports with Score and retain the correct Score
counts. Exercise the TypeScript heartbeat reader and rendered **Import job URL**
items; private URLs and arguments must remain absent.

Then exercise the write-side recovery controller with legacy queued, running,
completed, and failed activities, a mixed legacy/native history, and a true
empty native execution. Kill the worker after a partial replay while leaving
Temporal running, restart the worker, and verify that startup reconciliation:

1. resumes from the exact workflow/run history without starting, canceling, or
   signaling a discovery workflow;
2. restores source and backlog memberships, work plans, and step lifecycle
   events without duplicates;
3. records the current Temporal history-event watermark and exact membership
   and step-key digest; and
4. publishes `ready` only after projection refresh and exact set equality.

For native streaming history, verify that the producer-lifetime live enrichment
activity remains runtime-only and is excluded from the durable expected-step
set, while terminal enrichment reconciliation remains required. A closed run
must not retry forever because `streaming:live` intentionally has no persisted
`PipelineStep*` lifecycle.

The legacy fixture must also reproduce the lossy projection shape: repeated
fanout passes declare `0`, `71`, `67`, and `34` targets with legitimate overlap,
the folded workflow projection retains only `jobUrl`, and the append-only event
log retains both causal job-only starts and exact full summaries. Verify decoder
v2 derives the 72-member union from each fanout's exact interval, rejects a
per-pass target-count or workflow-run mismatch, restores all 16 declared stage
keys, persists `legacy_history_recovery` as a valid bounded reason code, and
reaches a verified 72/72-membership and 16/16-step `ready` checkpoint.

For ambiguous mapping or a transient history read, verify `retrying` with a
bounded error code, automatic heartbeat retry, and no mutation of the running
workflow. Run the focused worker reconciliation tests, API checkpoint tests,
Pipelines component tests, and the live browser path together. The live pass
must compare the operations response with the rendered workspace so shared-pool
telemetry cannot be mistaken for selected-run proof.

When source-family provider traversal is present, expand **Crawl sources** at a
desktop viewport and assert that its traversal evidence and exact-outcomes
ledger have disjoint layout rectangles. Repeat below the responsive breakpoint
and assert that traversal finishes above the outcomes ledger. This is the
regression guard for multiple evidence blocks sharing one stage detail row.

Also cover the retry and terminal edge cases. A successful fanout retry with
`attempt > 1` must restore exact membership and steps without inventing a queue
timestamp. A failed attempt that is waiting to retry, or a later attempt that is
still running, must remain non-terminal and cannot publish `ready` or a false
failed step. A canceled or terminally failed fanout with no retry remaining must
preserve its exact partial membership, work plan, failed-step evidence, digest,
and watermark as `projectionCoverage.status = incomplete`. Its expected counts
remain unknown in the API and UI. Restart the worker and verify that the closed
incomplete run is not selected for automatic repair again. Pipelines must label
the history as incomplete, avoid claims about the missing remainder, and expose
**Set up a new Discover run** only when active work is exactly zero.

Finally, begin from a valid `ready` manifest and force a transient history-read
failure. Verify the worker first demotes it to `retrying`, preserves the prior
proof for audit, and returns to `ready` after the authoritative history becomes
readable; it must not leave stale ready data published during the failure.

### Public demo privacy and edge gate

For additive demo settings, reopen a retained current-schema/current-seed
workspace missing the new fields and require a strict, complete settings response
and a rendered settings panel. Preserve identity, revision, authored edits,
receipts and blobs on read; verify both subsequent boolean save directions and
reload, existing saved values, an older tab's latest transaction state, and storage
fallback. Never replace the workspace or relax response-schema assertions to
update an immutable seed digest.

When consent, cookies, telemetry, D1, retention, or Cloudflare configuration
changes, the edge suite must prove that decline creates no analytics identity,
grant is required before telemetry, cookie attributes and versioning remain
exact, event fields stay allowlisted, retries do not double-count, rate limits
fail closed, and expired identities/events/counters are deleted. Before public
cutover, also repeat the consent and retention paths through local Wrangler and
the production-mode browser lane. Verify direct SPA deep links, Pages security
headers, the same-origin `/api/*` route, D1 migration state, and one Pages
rollback before calling the public deployment healthy.

The consented funnel report regression executes the checked-in SQL against
migrated synthetic D1 data produced by the telemetry handler. Every accepted
route must count an install click as an install, while session starts and the
five route views keep their own stages. Require correct release grouping,
distinct visitor/session counts, expired-event exclusion and separation from
denied and operational traffic.

### Provider setup gate

For the isolated Codex SDK environment, merge hostile ambient credential and
auth-endpoint overrides as the real SDK does. Credential values must remain
cleared, while refresh/revocation requests must build valid HTTPS URLs for
OpenAI's default endpoints. Empty URLs must not mask an expired or rejected
saved login as a request-builder failure.

When provider auth, Settings credentials, model routing, or employer analysis
changes, prove each sanctioned provider independently: Codex persisted CLI auth,
Claude API/cloud auth, Google Gemini key, Google standard ADC, and an existing
regular `GOOGLE_APPLICATION_CREDENTIALS` service-account file. Project metadata,
missing credential files, consumer Claude OAuth, raw OpenAI keys, and deferred
local/custom endpoints must not unlock readiness. Inject a failure at every
native credential-store batch boundary and prove exact rollback, then exercise provider-level
revocation, the three-card Settings route at desktop/mobile width, the demo
read-only boundary, sole-provider verified promotion, and retained multi-leg
synthesis without making a live model call. For model selection, use deterministic SDK fakes to prove
catalog order, ready-only listing, Codex hidden/invalid filtering, Google
generate-content filtering, Claude runtime-catalog normalization, stable deduplication, and
sanitized failures. Prove settings reject an unready provider or unoffered ID,
allow a clear while unready, persist no credential data, and exercise precedence
for explicit workflow, selected-provider preference, and provider default
without executing a live provider request. When an active provider route is
environment-owned, prove its secret and removal controls stay read-only while
another supported route remains editable. Saving that alternative must not
displace the active environment route before the environment value is removed
and the relevant process restarts.

### Native credential storage and migration

Credential-store changes require both adapter contract tests and native
read/write/delete evidence on each available host. A mocked Windows or Linux
adapter is contract evidence only; record unavailable native hosts explicitly.
Use a unique synthetic service/account namespace and temporary configuration,
never the user's `JobCtrl` entries or actual `.env` files. Verify deletion with
an independent lookup and remove only fixture-owned entries.

The opt-in `scripts/native-credentials-host.py` harness uses a unique synthetic
namespace to exercise TypeScript writes, Python reads and migration against the
real store. The `Native credential stores` CI workflow runs it on hosted macOS,
Windows (Python 3.12), and Linux. Linux runs a temporary Secret Service inside
an owned D-Bus session; Windows additionally checks restrictive source DACLs
after migration and rollback. A queued or blocked job is not host evidence.
From a prepared source checkout on macOS or Windows, run it with a Python
environment containing `python-dotenv` and the installed Node dependencies.
On Linux, use `dbus-run-session -- python scripts/native-credentials-host.py
--linux-session` after installing `secret-tool` and `gnome-keyring-daemon`.

Exercise the API's presence-only response, fixed key allowlist, unavailable
versus absent distinction, environment-owned edit refusal, batch rollback and
sanitized rollback failure. Verify that the Python reader resolves the same
native target as the API writer, preserves non-empty inherited environment
values, and observes edits only after a new process starts. Keep non-secret
provider configuration in `config.json` and vendor-managed auth in its vendor
store.

For persistent `.env` migration, prove successful write/readback before source
removal, preservation on store/verification/file-write failure, existing-store
conflict handling, safe retry and completed-migration behavior. Include
duplicate assignments, quoted values, malformed input, unrelated settings,
concurrent file changes and symbolic links. Inspect captured output, errors,
process arguments, completion records and temporary artifacts for synthetic
secret leakage. Exercise the actual migration command and a fresh runtime
reader, not only a helper with a fake store.

### Browser capability adoption gate

When browser detection, adoption, legacy profile-copy compatibility, or
Settings browser UI
changes, prove that listing capabilities only performs passive detection and
returns opaque browser kinds plus labels—never executable paths. Listing must
not launch, adopt, or persist a browser. Enabling requires an explicit detected
selection or one advanced manual path, re-resolves a detected selection at
mutation time, and fails closed when the installation disappeared. Profile-copy
consent remains a separate affirmative action on the backward-compatible API;
capability enablement must not imply it. Settings must not expose the legacy
`authenticated-linkedin-browser` capability or any profile-copy action, because
integrated Discovery and Enrich use the paired live-profile extension. With
Default plus at least one `Profile N` fixture, prove the legacy API forwards the
chosen opaque profile ID, copies only that profile as the isolated owned
Default, and never returns a host path. Replacing a prior consented copy must
stage the new profile first, preserve the old copy on pre-publish or
post-publish state-validation failure, and exclude every sibling profile.
Concurrent replacements must serialize through publish, state validation,
rollback, and cleanup so a stale failure cannot overwrite a newer successful
selection.

For Chrome records whose `is_using_default_name` flag is true, use the bounded
`gaia_name` as the recognizable label instead of Chrome's generic default such
as `Your Chrome`. A custom profile `name` must continue to win when that flag is
false, and neither case may return the account `user_name` (email), directory
name, or host path.

<a id="scoring-policy-eval-gate"></a>
<a id="saved-views-smoke"></a>
<a id="daily-digest-smoke"></a>
<a id="resume-tailoring-quality-eval-gate"></a>

### Daily digest

Run the digest CLI against an owned synthetic workspace admitted to the current
schema, both empty and populated. Check canonical job and tenant joins, one
count per job with multiple snapshots, hidden/closed/deleted and active jobs,
score corrections, approvals, follow-ups, threshold and watermark filters, and
deep links. Exercise offsets and fractional precision against instant cutoffs.
A foreign tenant's rows must not change local counts. A failed or
unavailable read or projection refresh must fail instead of returning zeros.
Passive reads preserve the review watermark; explicit acknowledgement records
the canonical review event and watermark together, or leaves both unchanged if
the event write fails. Interleave independent Python and API writers with the
newer acknowledgement committing first; retry a lost response and preserve a
caller-owned transaction on success and failure.

### Saved posting availability

Run `pytest tests/test_preparation_availability_cache.py tests/test_posting_availability_review.py tests/test_saved_posting_availability.py`
for preparation refresh reuse. A recent unknown observation must remove the
foreground wait without changing its verdict, accepted-success clocks, background
due state or ledger bytes. Exercise both six-hour boundaries, expired/missing/
malformed/future timestamps, exact URL and tenant changes, deletion and every
confirmed unavailable state. Old evidence still refreshes; Apply still acquires
its own current evidence. Run the scoring/material entry suites and full worker
suite, then compare actual foreground acquisition spans in a clean UI run.

Use owned synthetic data to verify current closure status outside historical
description, malformed/missing identity and metadata, HTTP 403/429/5xx/login/
timeout uncertainty, timezone-aware deadlines, canonical retained/lost redirects,
conflicting retained signals and exact ATS identity. Greenhouse/Lever EU must use
exact endpoints; missing/partial Ashby rows cannot prove closure and an unlisted
matching direct link can be active. API/page/browser fallbacks retain hashes and
method lineage; extension pairing alone cannot fabricate authenticated evidence.

Exercise saved-job startup/reconnect/heartbeat catch-up before, during and after
enrichment, 25-job selection,
100 posting acquisitions/hour with 20 reserved for foreground work, once/minute
coalescing, two-second actual-host pacing,
backoff/Retry-After, independent process leases, crash recovery and stale fences.
Pacing waits recheck the stored next-start time after wakeup and remain bounded
by the acquisition deadline; an early wakeup never admits a premature request.
Hidden/inactive status templates cannot close a visible posting. Computed browser
visibility and blocked subresources must survive conversion; incomplete renders
remain unknown with reason/hash lineage. Only explicit refused commands surface coalesced durable request
deferral/retry feedback. Local contention, quota and pacing refusals preserve
observation clocks and failure backoff. Independent job claims can overlap.
Real Chromium fixtures must cover the first popup request and iframe resources
through actual-host reservations, blocked service-worker/native connections with
owned HTTP/UDP sinks, and failed status-resource hashes. A hung renderer or
capture/close RPC must terminate and reap the owned browser processes within the
acquisition budget, before five-minute leases admit a successor.
Kill signals alone do not prove cleanup: observe every owned non-zombie browser
group exit within the existing cleanup grace. A surviving group or failed process
inventory must return `browser_cleanup_failed`; parent and foreign groups remain
untouched. Prove delayed group exit, grace exhaustion and inventory failure
mechanically, alongside the real Chromium cancellation fixtures.
Prove a second writer can acquire during transport. GET must make zero employer
requests. Failed observations retain success clocks and byte-identical accepted
content/material/generation/approval/outcome fingerprints. Closure must never
call `retire_invalid_source_jobs`, emit `JobDeleted` or write tombstones.

Real Temporal worker, API/RPC/CLI and rendered browser QA must show explicit
refresh, uncertainty, overdue/offline state and closed-to-active reversal without
Discover. Restore the original body-only, unbound JSON-LD, unzoned-deadline and
guest-LinkedIn fixtures: unknown availability must preserve usable content and
allow preparation and independently bound human-reviewed/rehearsal paths.
Medium/high-confidence unknown content must not create a pending content-review
row or an audit claim that tailoring was quarantined. A confirmed active recheck
resolves a legacy availability-only review row while retaining quality gates.
Unknown Apply needs an exact review from the preceding 15 minutes at claim, run
and owned intent, including when automation approval is disabled. A refused top
candidate must not starve an active peer. Repeat quota-saturated sweeps with zero
per-job ledger writes, and stop deadline/canceled sweeps before later jobs start.
Unattended Apply must remain blocked without positive evidence. Confirmed closure
and canonical URL races stop provider work and submit intent. Approval polls and
manual-ATS refusals must perform zero acquisition; an eligible claim checks only
one candidate. Mix multiple postings needing refresh with a fresh active peer:
one poll refreshes only one posting and can still claim the peer. Exercise a real CSS-dependent closed page with more than 12
resources, one hourly acquisition charge and harmless optional asset errors;
failed/redirected document, data, script, style and frame dependencies must remain
uncertain. A blocked non-read data request must also remain unknown, without
sending the write or trusting its error view as closure. Required-resource local
refusals retain evidence/backoff; optional
image refusals do not invalidate an otherwise sound capture. A submit-time block
before owned intent remains a retryable failure of the already-started Apply run.
Use 300,000 unrelated
events and 500 unchecked jobs, without ANALYZE, to bound read and sweep work. No application is submitted during QA. External transports may be
deterministic; production claims/classifier/dispatch/persistence remain real.

## Optional Company Briefings

Use an owned exact-v14 synthetic workspace. Exercise explicit identity/source confirmation, cross-job reuse, unchanged-input zero-call reuse, concurrent refreshes and a configuration change during generation. Opposing valid model kinds and identity verdicts must control output without lexical fallback. Provider/budget/JSON/schema/foreign-ID/non-verbatim/exact-value failures and failed acceptance commits preserve the accepted snapshot and original clock. Check bounded body/redirect/request behavior, public destination checks, no credentials or personal context, and failed gateway transaction release.

Run `test_company_briefings.py` and API `company-briefings.test.ts` to read real Python-written receipts through TypeScript and HTTP. Render Job Detail, Interviews and the existing digest through `company-briefings.spec.ts` on desktop and mobile; expand source excerpts and check critical/serious accessibility findings. These fixtures inject explicit model decisions and public transport, not recorded-output replay or judgment-quality evaluations. Report live provider/public transport evidence separately.

## Cover-Letter PDF Review (#1042)

Use an owned synthetic workspace. Pair API persistence and frontend race tests
with real API → registered RPC → Chromium → PDF-viewer QA. Render full long text,
HTML-sensitive characters, A4/Letter and all settings bounds. Compare the bytes
and SHA-256 of preview and accepted download, measure paper dimensions and inspect
every rendered page. Retain PDFs, page images, measurements and source hashes
privately. Controlled renderer or browser responses prove boundary behavior only;
they do not prove actual Chromium output or persistence.

Exercise preview-only reads, explicit save, two previews saving concurrently,
source replacement at the same generation, newer generations, tenant/job switches,
rapid edits, edits during saves, reversed responses, unmount, missing/corrupt PDFs,
renderer/RPC/validation/persistence failures, retries, reload, restart and a lost
save acknowledgement. Failures retain accepted settings, provenance, bytes and
approval bindings. Successful saves retain complete material history and resume
behavior while requiring renewed approval for the new generation. Verify email
bindings, resume draft rendering/comments, manual decisions/outcomes and jobs
without a cover as preservation controls. The materials browser spec contains a
real render/save/reload path; product checks against the exact candidate
remain governed by the reliability workflow.

Repeat formatting saves and export both carried text sources as DOCX from each
displayed generation. Inspect one set of resume layout/provenance rows in both
projection writers, not concatenated copies. Seed a higher rejected generation:
the accepted cover identity must remain unchanged while the next allocation
exceeds it. Replace stale PDF provenance with current text metadata and recorded
anchor/binding IDs, also without a prior PDF. During save, undo to the old settings
and deliver canonical refresh before/after success or a lost acknowledgement;
preserve the undo, reject obsolete query snapshots and require reconciliation
before approval when the outcome is uncertain.
Seed current resume PDF/text and cover text alongside older literal aliases with
equal timestamps and higher-sorting IDs. A cover-only save must neither select an
older resume nor refuse an unchanged cover source. Repeat saves and committed
retries, then read warm projections and reopen the database. Exercise both alias
directions, all resume text aliases and same-generation row-order ties. Preserve
original rows, bytes, anchors and bindings; only the changed cover acceptance
stales prior authorization. Keep a no-alias control and the insert-time drift
rollback regressions.
Also seed a selected complete resume pair with a newer text-only generation, and
the reciprocal newer-PDF case. Save, retry and reload twice: preserve the selected
pair, its aggregate metadata, layout and provenance rather than forming a mixed
pair. Check cold and warm projection selection. For cover aliases, oppose ID
ordering and insertion order at equal timestamps; displayed text must equal the
canonical rendered source before/after save and reload, with no alias fallback
when that canonical source becomes unreadable.
Populate artifact projections before saving, then download the new accepted PDF
without restarting. Acceptance must commit its existing `PdfRendered` event
atomically; fail the event insert to prove full rollback, and retry a committed
preview to prove that neither the generation nor event is duplicated.
Start with a current accepted PDF and an existing authorization, then change the
canonical source or attempt PDF during material, artifact and event inserts.
Revalidate the submitted source, PDF, settings, renderer and manifest before
commit; any mismatch must roll back the entire promotion and its event. Preserve
prior material/provenance/decision rows and accepted PDF bytes. A source file
written by another producer must survive rollback; its changed hash must stale
the older PDF rather than being restored. Include source-ID and manifest changes
and a successful fresh render/save after refusal.

Prepare owned outside-root synthetic files and replace the generated directory,
preview root, UUID directory, manifest, PDF and canonical source with symlinks.
Neither preview, download, rendering nor acceptance may follow them. Exercise
literal traversal, direct outside paths, existing output files and hard links;
failed cleanup must preserve replaced directories and outside bytes. Repeat at
the registered worker RPC boundary before its renderer runs.

Replace an accepted PDF with corrupt bytes that retain `%PDF-`/`%%EOF` markers.
Its persisted identity must remain unchanged and approval/download must fail.
Replace text at the same generation and prove the older PDF is noncurrent even
with no review receipt. New default-generated PDFs must carry both hashes and
their source occurrence; missing or invalid identity metadata cannot grant
approval. Keep `test_apply_approval_vocabulary.py`'s refusal assertions on an
exact-schema no-cover connection, exercising the real cover guard.

For retained browser evidence, set an owned `PLAYWRIGHT_JUNIT_OUTPUT_FILE` and
retain its complete sibling `<report path>.artifacts` directory, including
successful attachments. `materials.spec.ts` measures long Unicode/HTML-sensitive
source at defaults and bounds for each font through
`workers/automation/tests/cover_letter_pdf_probe.py` with the prepared worker
interpreter. It requires Poppler on PATH, records source/settings/PDF identities,
paper and text geometry, font sizes, line/paragraph deltas, every-page PNGs and
viewer screenshots. Inspect every page; passing interactions alone cannot prove
visual acceptance. Keep controlled-response race scenarios separate from these
real render measurements.
Use the same bounded full-render readiness wait for initial and reloaded viewers:
PDF.js reports progress for each page before reporting completion. Progress such
as `Rendering page 4 of 4` is not readiness. Keep measured page-count comparisons,
all nine formatting combinations and every-page captures after the ready state.
Persist viewer captures for every preview and reloaded accepted page using
`testInfo.outputPath`, then attach file paths. Retain the viewer-page hash manifests
and competing-save, uncertain-authorization and reload receipts in that same
owned tree. Buffer-only attachments are insufficient evidence retention.

Run materials before shipped-fit lifecycle browser cases in the same owned
workspace. Formatting saves carry resume slots into later material generations;
the lifecycle fixture must change and restore the currently accepted audit,
preserving generation-one history and the exact legacy coverage assertions.
Direct browser-test mutation requests must send the configured first-party
Origin; absent or foreign Origins must still receive 403. For a committed save
whose acknowledgement is lost, inspect the job-qualified authorization buttons:
both must remain disabled with the reconciliation reason until canonical state
is recovered. Check keyboard focus/scroll access to long cover-letter and email
text, and retain the existing critical/serious axe checks.

## Posting-history Source Proposals (#1041)

Use owned exact-schema synthetic workspaces. Exercise the real
`source-proposals from-history`, `list` and `reset` CLI entry points and existing
HTTP locator GET/promote/reject routes. Require deduplicated board/API/posting
coordinates, exact origin JobId/URL/run and extraction receipts, saved samples,
existing source overlaps and unknown completeness. Repeated reads must preserve
database content; repeated scans reuse unchanged receipts. Reject malformed,
credential-bearing, private-address and private-DNS destinations before queue
writes. Retain canonical posting/application authorities and schedule/source
state during proposal generation. Rejection must fence alternate URLs and
ordinary worker learning across restart; only explicit reset permits reproposal.
Disabled sources survive worker seed reconciliation and cannot be enabled by
proposal review. Failed receipt persistence rolls back the decision/queue or
scan and preserves prior history. Pair worker/API checks with rendered source
review and event invalidation tests, frontend boundary checks and web/docs builds.
