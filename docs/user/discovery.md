<script setup lang="ts">
import DiscoveryPipeline from "../.vitepress/theme/DiscoveryPipeline.vue";
</script>

# Discovery & Sources

Discovery turns your target search into source queries, checks returned jobs
against that intent, and prepares accepted jobs for scoring and materials. This
page owns the target-search controls, source/runtime settings, scheduling, crawl
policy, and supervised contact-research boundary. For the end-to-end loop, start
with [Daily Workflow](normal-flows.md); for providers and the shared spend
ceiling, use [Configuration](configuration.md).

<DiscoveryPipeline />

::: info One persistence authority
Every value editable anywhere on `/discovery` is stored in
`~/.jobctrl/jobctrl.db`. SQLite is the sole persistence authority for target
search, Automation settings, broad-board controls and limits, role-filter
execution, source-family parallelism, crawler identity, runtime and schedule,
the source registry, locator candidates, quarantine, manual capture, and other
Discovery-page state. `config.json` does not own or provide a fallback for any
of these fields.
:::

| Surface | SQLite authority | When a saved change applies |
| --- | --- | --- |
| Target search | Candidate Profile rows | Next Discover run |
| Automation settings | Discovery-owned control rows | Next relevant run or standing-loop poll |
| Runtime and schedule | `discovery_settings` | Next run or source family; schedule changes require a worker restart |
| Sources, locator candidates, quarantine, and manual capture | Discovery context tables | Immediately for review state; next use for source execution |

## Runtime, Sources, And Schedule

Use **Discovery → Runtime settings** for boards, results per site, posting age,
schedule, role-filter mode/model, bounded source-family parallelism, and the
outbound user-agent identity. Every saved value goes to SQLite. Schedule
changes need a worker restart; boards, limits, and parallelism apply on the
next run; role-filter and user-agent changes apply to the next source family.

Parallel families are capped at four and should not exceed the worker's active
activity slots. See
[Concurrency & Fan-out](../architecture/pipeline/concurrency.md).

### Runtime setting reference

The help control beside each Runtime setting opens a short explanation and a
deep link to the matching entry below.

<a id="runtime-setting-job-boards"></a>
**Job boards.** Choose which broad-board providers run for every generated
target query. A Discover execution snapshots the selected boards when the run
starts, so a change affects the next run rather than work already in progress.

<a id="runtime-setting-results-per-board"></a>
**Results per board.** Set the maximum number of results requested from each
selected board for one search unit. This is a provider request limit, not a
promise that every board will return that many accepted jobs; title, location,
age, and deduplication checks still apply. The next Discover run snapshots the
new value.

<a id="runtime-setting-posting-lookback-hours"></a>
**Posting lookback hours.** Limit broad-board discovery to postings no older
than this many hours when the provider supports age filtering. The next
Discover run snapshots the window.

<a id="runtime-setting-role-title-filtering"></a>
**Role title filtering.** Choose how returned titles are checked against the
target-search plan. **Auto** uses model-backed matching when a configured model
provider is ready and otherwise uses deterministic local title rules.
**Deterministic** always uses local rules. **LLM** requires model-backed
matching. A change applies to the next source family.

<a id="runtime-setting-role-filter-model"></a>
**Role filter model.** Optionally pin the model used by model-backed role-title
matching. Leave the value blank to use the configured provider routing. A
change applies to the next source family.

<a id="runtime-setting-parallel-source-families"></a>
**Parallel source families.** Limit how many source families may crawl at the
same time inside a Discover execution. JobCtrl bounds the value to four and to
the worker's available activity slots. The next run snapshots the limit;
downstream enrichment remains separately bounded.

<a id="runtime-setting-crawler-product-name"></a>
**Crawler product name.** Set the product token in JobCtrl's honest outbound
user-agent identity. It identifies the crawler without impersonating a browser.
A change applies to the next source family.

<a id="runtime-setting-crawler-contact"></a>
**Crawler contact.** Optionally add a URL or contact address to the outbound
user-agent identity so site owners can identify the operator. A change applies
to the next source family.

<a id="runtime-setting-enable-scheduled-discovery"></a>
**Enable scheduled discovery.** Control whether worker startup reconciles a
recurring Temporal Discover schedule. This is off by default. Restart the
worker after changing the setting so it can create or remove the schedule.

<a id="runtime-setting-schedule-cron"></a>
**Schedule cron.** Define the recurring local schedule with a five-field cron
expression. JobCtrl uses it only while scheduled discovery is enabled, with
`SKIP` overlap behavior so one scheduled execution does not overlap the next.
Restart the worker after changing the expression.

The Discovery page also hosts the **Automation settings** disclosure. Its minimum-fit,
auto-apply, and approval controls affect Apply eligibility and submission, so
their behavior is documented in
[Apply → Approval And Automation Modes](apply.md#approval-and-automation-modes).

### Canonical identity and repeat applications

Discovery preserves canonical posting identity, source-native identity, source
observations, and reviewed duplicate links rather than treating every URL as a
different opening. An accepted duplicate link may therefore prove that an
alternate URL represents an already-known canonical job. Candidate or rejected
duplicate links do not establish that relationship.

Identity evidence alone does not claim that an application happened. Repeat
protection combines it only with a confirmed application fact. A conservative
same-employer/equivalent-role comparison can require confirmation, but it does
not merge the jobs or turn either record into application history. See
[Apply → Repeat-Application Protection](apply.md#repeat-application-protection).

## Launch And Observe Discovery

Discovery owns the controls that decide what may enter a run; **Pipelines** owns
starting and observing that run. In Pipelines, choose the Discover action, set a
bounded result limit, internal source concurrency, optional sources, and dry-run
mode, then keep the operations workspace open while work proceeds. The source
picker supports up to 50 selections and labels broad-board adapters as
JobStreaming; the persisted `jobspy:` prefix remains only a compatibility ID.

The workspace deliberately keeps different scopes and units separate:

- **Current execution** is work admitted to the selected Discover execution.
- **Execution sweep** is eligible pre-existing backlog that execution adopted.
- **Global outside execution** is unrelated backlog and is not part of the
  selected execution's completion claim.
- **Source-family progress** reports source intake; enrichment and preparation
  reconciliation report the downstream drain. A finished crawl can therefore
  coexist with preparation that is still running. Broad-board progress also
  reports how many interrupted search units resumed. While a board is active,
  its latest provider traversal facts show completed pages, raw listings,
  emitted jobs, and whether more pages are known to exist. When the provider
  does not publish a total page count, JobCtrl says the total is unavailable
  instead of inventing a percentage or finish time.
- **Worker capacity** reports Temporal workers and shared activity slots.
  Source-family internal concurrency is a separate control, and approximate
  task-queue depth is not a count of domain jobs.

Per-stage rows expose outcomes, existing backlog, capacity, observation time,
and ETA. ETA is an observed range with confidence and basis when enough evidence
exists; calibrating, paused, stale, unavailable, and no-work states stay explicit
instead of becoming a guessed finish time. Freshness and the bounded active-work
inventory show whether the operational facts are current.

Exact selected-run stage tracking is durable. New executions record their
membership and stage lineage natively. For an execution created by an older
JobCtrl version, worker startup and heartbeats rebuild the same lineage from the
exact Temporal workflow/run history. During that bounded repair, Pipelines shows
**Restoring pipeline history**, keeps fresh shared-worker and queue facts visible,
and hides selected-run counts, percentages, and ETAs until the recovered key sets
have been verified. Partial rows or live-worker telemetry never become a false
completion claim.

### Stop Or Recover A Discover Run

While the selected Discover workflow is actively discovering or draining,
**Stop discovery** requests Temporal cancellation and refreshes the Pipelines,
Runs, and Dashboard read models. A closed workflow that is only draining
already-admitted work is not presented as stoppable.

When an execution fails, Pipelines reports whether the runtime inventory shows
active work before suggesting another run. A positive total tells you to review
that work first; unavailable inventory is reported as unknown, never as idle.
If an authoritative history read is temporarily unavailable or cannot yet be
mapped unambiguously, JobCtrl shows that history repair will retry automatically.
It does not present permanent missing tracking, infer completion from partial
rows, or require a manual retry. Reconnecting to the exact history restores that
run or records its actual closed outcome. If an older run ended before its
history recorded every target, JobCtrl marks that run **Historical run
incomplete**, preserves all exact recovered evidence, and does not invent or
repeatedly retry the missing remainder. **Set up a new Discover run** is
appropriate only when the prior execution is closed or genuinely absent and
fresh runtime capacity confirms zero active slots. It selects the Discover
launch controls but does not dispatch anything until you submit them. Raw
workflow identifiers, the exact
Temporal run ID, and the bounded repair reason code remain available under
**Technical details**.

### Resumable Broad-Board Searches

Broad-board discovery uses JobStreaming 0.0.3. At the beginning of the source
activity, JobCtrl compiles an immutable unit for every query, target/provider
location, and board under the exact Discover workflow/run identity. JobCtrl,
not the provider, owns whether that unit is pending, running, completed, failed,
skipped, or canceled.

For each posting event, JobCtrl applies the title/location policy and commits
the accepted job, source observation, event records, and an idempotent unit
receipt before acknowledging the JobStreaming event. The acknowledgement then
advances the provider checkpoint. If the process stops in that gap, the event
is delivered again and the durable receipt makes the replay harmless. Results
rejected by the caller's title/location policy get a separate hashed receipt
before acknowledgement. Accepted new/existing counts, filtered counts, and the
run-wide new-job limit are therefore read from durable receipts, so a retry
cannot lose progress or start the limit over.

Temporal retries reclaim only unfinished units with a newer activity-attempt
fence. Retryable board errors resume from their checkpoint; an expired board
cursor is reset only after its error event has been acknowledged. Request or
cursor-schema incompatibility fails explicitly instead of silently starting a
different search. Healthy boards and already accepted postings remain useful
when another board fails. Pipelines shows `N resumed` when recovery happened.

JobStreaming page progress is projected separately from JobCtrl acceptance
counts. The provider payload contains no cursor or resume dictionary, and the
Pipelines operations view binds it to the exact Discover workflow/run before
displaying it. These traversal facts explain current crawl activity; they do
not override a whole-stage ETA that is unavailable because shared worker-pool
contention or an authoritative provider total is still unknown.

**Stop discovery** is different from interruption: cooperative cancellation
interrupts provider waits and marks active and pending units canceled. Canceled
units are terminal and are not reclaimed as stale work. Changes to boards,
queries, or locations apply to the next Discover execution; they cannot rewrite
the persisted plan of an execution that is retrying. The internal `jobspy:`
source-ID prefix remains a compatibility identifier for existing local data and
API selections; it no longer names the provider library.

### How target search controls are used

These controls do not divide cleanly into “search fields” and “filter fields.”
Together they compile the target-search plan, but each one contributes a
different kind of intent:

| Control | Meaning | Search and filtering behavior |
| --- | --- | --- |
| **Target roles** | Specific job titles you want, such as “Director of Engineering.” | Become the primary exact search queries, replace the fallback query list, and act as strict title checks on returned postings. They also seed broader recall queries. |
| **Role areas** | Broad domains such as engineering, security, or platform. | Combine with tracks and floors to generate additional title queries and supply the domain signal required by recall matches. They are not a standalone post-storage filter. |
| **Seniority floors** | A role-area-independent minimum career level: Junior IC, Mid IC, Senior IC, Staff IC, Principal IC, Manager, Senior Manager, Director, VP, SVP, or C-Level. | Limit generated recall queries to that level or higher and reject lower-ranked recall titles. A Staff IC floor can include Staff and Principal IC roles; a VP floor can include VP, SVP, and C-Level roles; an SVP floor excludes VP roles and treats EVP titles as the same floor. |
| **Target tracks** | The career lane: individual contributor, management, or executive. | Keep recall within the selected lane so, for example, an IC recall query does not accept a management title. |
| **Specializations** | Additional, narrower domain hints. | Contribute to recall-domain inference when they contain recognized domain vocabulary. Unrecognized free text may not change the generated plan. |

Seniority is deliberately separate from role area. The ladder describes career
scope, while **Role areas** supplies domains such as engineering, security, or
platform. Existing saved `engineer` and `cto` values remain compatible and are
shown as **Mid IC** and **C-Level**; the next seniority edit writes the
canonical `mid` and `c_level` values. VP, SVP, and C-Level are distinct floors
in both query generation and title acceptance; EVP titles map to SVP.

Discovery then applies that plan in four steps:

1. Target roles and the structured controls compile into exact and recall query
   specifications.
2. Broad boards are searched with those query strings. Direct ATS and Workday
   sources enumerate their postings and use the same intent as an internal title
   check.
3. Returned postings must pass title and location acceptance before JobCtrl
   persists them.
4. JobCtrl scores accepted jobs afterward. Of these target-search controls,
   target roles currently become scoring preferences; role areas, target tracks,
   and seniority floors affect discovery planning and title acceptance rather
   than the fit score.

An explicitly entered target role remains an exact query without a separate
seniority floor attached. An exact title match can therefore pass even when it
is below a selected floor; the floor is principally enforced on generated
recall queries.

::: warning Multiple tracks and floors
Tracks and seniority floors are currently stored as independent ordered lists,
not as explicit track-to-floor pairs. Recall generation can associate those
values with target roles by list position, so selecting several tracks and
floors does not create a clean per-track matrix and can produce surprising
expansions.

For a predictable mixed-track search, treat **Target roles** as the authority:
list every title you would accept, including Staff or Principal roles when
desired, instead of relying on several simultaneous track/floor selections.
:::

A scraping proxy, when needed, is part of the SQLite discovery settings
(`host:port:user:pass` form); there is no `PROXY` environment variable.

![JobCtrl Discovery workspace with target search, sources, schedules, runtime, capture, and diagnostics](../assets/screenshots/discovery.png)
*Discovery owns the SQLite-backed controls that shape source intake; Pipelines launches and observes the resulting execution.*

Discovery scheduling is also a SQLite-backed setting: `scheduling_enabled`
defaults to `false`, `schedule_cron` defaults to `0 7 * * *`, and worker
startup reconciles the local Temporal schedule — creating it (with `SKIP`
overlap semantics) when enabled and deleting it when disabled.

## Employer Analysis Perspectives

After Discovery accepts a posting, the Discover preparation workflow turns it
into one structured, inspectable reading of the employer's requirements,
priorities, and ideal candidate. Each enabled provider first analyzes the
posting independently. JobCtrl compares those drafts, records agreement and
provider failures, and asks a ready provider to synthesize the surviving drafts
into the canonical analysis used by scoring and tailoring.

Choose the participating providers under **Settings → Model selection →
Employer analysis perspectives**. This provider policy is a non-secret Settings
value stored in `config.json`; it is not a `/discovery` field. One ready
provider is sufficient. Adding more perspectives can expose disagreements and
improve the evidence available to synthesis. If an optional perspective fails,
preparation continues with the successful drafts; it stops only when no draft
succeeds. Changes apply to the next employer analysis.

## Crawl Politeness

Every discovery/enrichment fetch routes through one politeness gateway
(`robots.txt` + per-host rate limit + per-run budget + honest user-agent). The
defaults are conservative and fail-closed and need no configuration; the one
value you should review before real crawls is the **outbound user-agent** under
**Discovery → Runtime settings**. Both its product token and optional contact
are persisted in SQLite with the rest of the page.

The effective identity is `<product>/<version> (+<contact>)` — for example
`JobCtrl/0.3 (+https://github.com/ebarti/JobCtrl)`. It **never impersonates
a browser**. The built-in default points at the public project repository, not
any personal identity; **owners should review it (and set a contact they own)
before crawling real sites** — `jobctrl doctor` prints the effective value.

The rest of crawl policy also lives on the SQLite-backed Discovery boundary, so
per-source overrides ride the existing registry rather than a parallel config
surface:

- **Per-host rate/concurrency + per-run request budget** are fields on each
  source's `SourcePolicy` (`domain/discovery/source_registry.py`), with
  conservative fail-closed values (robots honored for page rendering, a non-zero
  min-interval, a concurrency of one, a finite run budget). Per-source overrides
  ride the existing `SourceRegistryEntry` rows; a registry policy editor is a
  planned addition, not yet in the UI.
- **Broad boards** (`indeed`, `linkedin`, `glassdoor`, `zip_recruiter`) are
  fetched by JobStreaming, which owns its board transports — JobCtrl cannot
  robots-gate or count its per-board requests, so it applies budget + pacing at
  the invocation boundary only, and `jobctrl doctor` warns when they are on.
- A malformed `proxy` value (the SQLite discovery setting, `host:port[:user:pass]`)
  now **fails loud** rather than silently degrading to a direct connection, so a
  crawl never quietly runs without the proxy you intended.

## Contact Research

Supervised contact research has no configuration keys and no schedule — it runs
only when you start a run from the UI. Its posture is conservative by design:

- **No public source is auto-fetched.** A public page is fetched only when you
  supply its URL for that run (per-source opt-in); with no URL, the run fetches
  nothing and just records the source-attempt audit.
- **Login-walled / paywalled / bot-protected pages are never auto-fetched** — they
  are routed to the manual-capture path instead.
- **Fetching reuses the crawl-politeness gateway above** (`robots.txt` + per-host
  rate limit + per-run budget + the same honest user-agent).
- **LLM spend reuses the daily budget** (`dailyBudgetUsd`) and the same preflight
  as every other spendful workflow — there is no separate research budget.
