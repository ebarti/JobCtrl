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

## Ashby Listing And Location Admission

The Ashby public posting adapter excludes only explicit boolean
`isListed: false`. Listed and legacy postings with no flag enter model triage;
the adapter does not decide their title, description or location relevance. The
primary location or existing `locationName` fallback leads the retained metadata;
trimmed valid `secondaryLocations[].location` strings follow, deduplicated
case-insensitively with first spelling preserved and joined by `; `. Malformed
secondary containers/entries and empty names add no fabricated location.

`workers/automation/tests/test_ats_adapters.py` covers listing flags, malformed
secondary data, duplicate labels, primary fallback and native-ID/canonical-URL
preservation. Its synthetic `run_scheduled_ats_sources` fixture injects HTTP data
into an owned temporary SQLite database and uses opposing valid `LlmPort`
verdicts for the same listing payload. Admission follows the model, retains both
location names and preserves identity and observations across runs; rejection
persists the model decision without creating a job. An unlisted peer is excluded
mechanically. `test_discovery_determinations.py` covers durable pending intake,
bounded recovery and foreign-listing citation rejection. No alias table or
geography sentence corpus establishes the expected semantic verdict.
These fixtures contact no live board and use no real user data. Local fixture
proof does not replace the independent review, QA, or CI gates.

## Temporal Fault Injection

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
counter exactly once; repeated failures reach non-retryable `exhausted` at the
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
  -o cache_dir="$trial_root/pytest-cache"
```

The trial comprises **eight required cases** (four cases × two paper sizes).
Each runs three adapter renders and three shared-entry renders, all with fresh
Chromium lifecycles and separate `repeat-1`/`repeat-2`/`repeat-3` directories:
**48 measured PDFs**, plus the boundary probes and a browser/font preflight.
The focused selector is `-k dense_resume_pagination_trial`; it must execute
eight cases with zero skips. Ordinary port-test runs without the explicit flag
skip these eight browser cases and supply no trial evidence. With the flag,
missing imports, Chromium, fonts or Poppler are failures. Do not count a docs
build, fake renderer, zero-test run or skipped case as product QA.
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

### Results and independent completion

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
Higher-resolution independent inspection remains a separate QA gate.

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
Any unresolved Blocker/High prevents completion. Independent QA must inspect
**every measured page of every repeat**, record outcomes for all five dimensions,
and reconcile its findings with the JSON and JUnit evidence. Eight passing
automated cases alone do not complete visual QA or prove universal stability.

Add further regression assertions only for behavior supported by these actual
observations. The trial currently checks content/order, physical coverage,
nonblank pages and repeat comparisons; it has no hardcoded dense-page count
or assertion that the DOM layout map is physically accurate. More fonts,
densities, themes, non-ASCII scripts, viewer versions and arbitrary document
sizes are outside this bounded sample. The controller owns current-issue
reconciliation, independent review/QA, mandatory checks and publication at an
unmerged verified head. After it records the summary, remove only the owned
trial artifacts and processes; retain no generated candidate material in Git.

## Auditability Checks

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

For version changes, seed an obsolete analysis projection with already-folded
event cursors. Both builders must rebuild it from the current canonical version
without a new event, or expose no current analysis if none exists. The native
cutover removes the cached shape while preserving canonical history, cursors
and accepted artifact bytes. Citation format checks must reject fragments of
numbers and dotted identifiers while accepting complete values followed by
sentence punctuation or separated by commas.

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

When consent, cookies, telemetry, D1, retention, or Cloudflare configuration
changes, the edge suite must prove that decline creates no analytics identity,
grant is required before telemetry, cookie attributes and versioning remain
exact, event fields stay allowlisted, retries do not double-count, rate limits
fail closed, and expired identities/events/counters are deleted. Before public
cutover, also repeat the consent and retention paths through local Wrangler and
the production-mode browser lane. Verify direct SPA deep links, Pages security
headers, the same-origin `/api/*` route, D1 migration state, and one Pages
rollback before calling the public deployment healthy.

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
read-only boundary, and a sole-provider draft plus synthesis path without making
a live model call. For model selection, use deterministic SDK fakes to prove
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

### Saved posting availability

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
