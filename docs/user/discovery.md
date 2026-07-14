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
outbound user-agent identity. The form shows `saved` or `default` ownership.
Every saved value goes to SQLite. Schedule changes need a
worker restart; boards, limits, and parallelism apply on the next run;
role-filter and user-agent changes apply to the next source family.

Parallel families are capped at four and should not exceed the worker's active
activity slots. See
[Concurrency & Fan-out](../architecture/pipeline/concurrency.md).

The Discovery page also hosts the **Automation settings** disclosure. Its minimum-fit,
auto-apply, and approval controls affect Apply eligibility and submission, so
their behavior is documented in
[Apply → Approval And Automation Modes](apply.md#approval-and-automation-modes).

### How target search controls are used

These controls do not divide cleanly into “search fields” and “filter fields.”
Together they compile the target-search plan, but each one contributes a
different kind of intent:

| Control | Meaning | Search and filtering behavior |
| --- | --- | --- |
| **Target roles** | Specific job titles you want, such as “Director of Engineering.” | Become the primary exact search queries, replace the fallback query list, and act as strict title checks on returned postings. They also seed broader recall queries. |
| **Role areas** | Broad domains such as engineering, security, or platform. | Combine with tracks and floors to generate additional title queries and supply the domain signal required by recall matches. They are not a standalone post-storage filter. |
| **Seniority floors** | The minimum acceptable level, not a list of exact levels. | Limit generated recall queries to that level or higher and reject lower-ranked recall titles. A Staff floor can include Staff and Principal; a VP floor can include VP and Chief. |
| **Target tracks** | The career lane: individual contributor, management, or executive. | Keep recall within the selected lane so, for example, an IC recall query does not accept a management title. |
| **Specializations** | Additional, narrower domain hints. | Contribute to recall-domain inference when they contain recognized domain vocabulary. Unrecognized free text may not change the generated plan. |

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

![JobCtrl Discovery page with target search, seniority floors, job boards, and source registry](../assets/screenshots/discovery.png)
*Target roles, locations, seniority floors, work models, and source controls are edited on the Discovery page and stored in SQLite.*

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
  fetched by `python-jobspy`, which owns its own transport — JobCtrl cannot
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
