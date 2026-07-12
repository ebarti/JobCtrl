<div align="center">

# JobCtrl

**Find the right jobs, prove the fit, and apply — from one local, auditable
mission control.**

JobCtrl discovers jobs, scores them against your real profile, tailors
truthful materials you review, and helps you apply with guardrails — while
your profile, job database, generated resumes, browser state, and logs stay
on your machine.

[![TypeScript CI](https://github.com/ebarti/JobCtrl/actions/workflows/typescript.yml/badge.svg)](https://github.com/ebarti/JobCtrl/actions/workflows/typescript.yml)
[![Release Privacy Gate](https://github.com/ebarti/JobCtrl/actions/workflows/release-check.yml/badge.svg)](https://github.com/ebarti/JobCtrl/actions/workflows/release-check.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
![Source Python 3.11+](https://img.shields.io/badge/source-Python%203.11%2B-3776AB)
![Source Node 20.19+](https://img.shields.io/badge/source-Node%2020.19%2B-339933)

<img src="docs/assets/screenshots/dashboard.png" alt="JobCtrl dashboard with pipeline, spend, and review queues (synthetic data)" width="880" />

*Every screenshot in this repo is generated from synthetic sample data —
no real people, resumes, or applications.*

</div>

---

## Why JobCtrl

| 🔒 Yours, locally | 🧾 Proof, not vibes | 🛡️ Guarded apply |
| --- | --- | --- |
| One SQLite database and generated files under `~/.jobctrl/`. No account, no hosted backend. Nothing leaves your machine by default. | Every score has a per-requirement evidence ledger; every resume bullet traces to your profile; fabrication gates fail closed. | Dry runs submit nothing. Live submission needs an explicit approval bound to the exact reviewed materials — and never submits twice. |

Job-search tools tend to hand you either loose scripts or a black box that
takes the wheel. JobCtrl runs the whole pipeline — **discover → enrich →
score → tailor → review → apply** — as crash-resumable local workflows with
a daily spend ceiling, and shows its work at every step.

## Public Demo Rollout

The browser-local demo is deployment-ready but is not public yet. It will be
linked here only after the production consent boundary, telemetry retention,
direct routes, and rollback path pass their launch checks. Once live, it will
let visitors explore synthetic jobs, scoring evidence, tailored materials,
dry-run rehearsals, and workflow history before installing JobCtrl. Demo
actions are simulated and cannot contact employers, providers, Gmail, job
boards, or the local JobCtrl app.

The demo requires first-party analytics-cookie acceptance before it
creates its browser-local workspace. Declining returns to `jobctrl.dev`; a
later visit asks again. Read the
[demo data notice](https://jobctrl.dev/user/data-and-safety#public-demo) before
entering, and do not type personal data, credentials, or secrets.
When a deployment updates the canonical synthetic examples, the next demo load
refreshes that browser-local workspace once; cookie consent is unchanged.

## Get Started

**Current public path: run the source checkout.** The first signed bundled
release is not published yet, so today the supported public setup is:

```bash
git clone https://github.com/ebarti/JobCtrl.git
cd JobCtrl
scripts/install
corepack pnpm dev   # open the printed loopback URL
```

Git is used only to download and update this source checkout. JobCtrl's product
runtime does not use Git. `scripts/install` checks the source-development
toolchain and can offer missing tools through an existing Homebrew install;
otherwise it reports what you must install yourself. It installs both workspace
dependency closures and runs `jobctrl setup`. Keep the `corepack pnpm dev`
terminal open while using the app; stop it with Ctrl-C.

The web app does not require `jobctrl init`. Initialize the local CLI profile
only if you want to drive workflows directly from a terminal:

```bash
uv --project workers/automation run jobctrl init
uv --project workers/automation run jobctrl doctor
```

`uv --project workers/automation run` is source-checkout plumbing: it syncs the
repository's Python environment when needed, selects it, and invokes the
existing `jobctrl` console entry point. It is not a separate CLI and it is not
the installed command surface.

**Bundled distribution status.** P0–P6 implement one native `jobctrl`
executable plus a private runtime payload, but no signed and notarized public
artifact or stable Homebrew formula has been published. Until that release is
available, do not treat `jobctrl.dev/install.sh`, a local release fixture, or a
generated formula as a live install channel.

After publication, curl and Homebrew will be acquisition choices for the same
bundle. They will not select different ways to start JobCtrl. From any
directory, every installed user will use the same executable for both app
lifecycle and domain CLI commands:

```bash
jobctrl start
jobctrl init
jobctrl doctor
jobctrl <domain-command>
```

The first bundle targets Apple-silicon macOS 15 or newer. Its payload carries
the API/web/worker, Node, Python, Temporal, PDF.js, Python Playwright, and
Playwright MCP runtimes. It neither creates a source checkout nor needs Git,
Node, pnpm, Corepack, uv, Python, Temporal, Poppler, Playwright, or `npx` on the
user's `PATH`. `jobctrl dev` remains only a deprecated alias for `jobctrl start`.

The bundled core browser is exactly one managed Playwright Chromium headless
shell for discovery, enrichment, and PDF rendering. It does **not** include a
full Chrome/Chromium application. A system Chrome/Chromium installation is
optional and can be skipped unless the user explicitly enables an
authenticated-browser or auto-apply capability and selects that browser.

The tracked bundle inventory declares 15 core runtime components, one bundled
optional-capability adapter, three provider packs fetched only from their
official channels when selected, and two developer-only components excluded
from the artifact. Every release gate emits a fresh per-component size report;
there is no public download-size claim until a signed artifact publishes that
evidence.

<details>
<summary><b>Source-checkout requirements and footprint</b></summary>

Running from source requires Git for clone/update; Python 3.11+; Node.js 20.19+
with pnpm through Corepack; uv; Temporal CLI; two source-development Playwright
Chromium installs; and an LLM provider key or local LLM endpoint (plus vendor
auth for any enabled employer-analysis ensemble legs). `scripts/install`
reports missing prerequisites and can offer Homebrew installs where supported.
A machine without Git cannot run the clone command; Git is not needed after
moving to the future bundled install.

The reproducible source audit currently records 85 unique direct JavaScript
packages, 1,480 pnpm lock records, and 103 uv lock records. A simple sum of the
preserved 2026-07-10 source-planning observations is about 4.28 GiB with system
Chrome skipped, or 5.58 GiB with the separately optional 1.3 GiB Chrome from
that reference machine included. `scripts/install` never installs system
Chrome. Those observations also include the whole 1.18 GiB reference-machine
Homebrew closure and mix accounting contexts, so they are directional—not a
reproducible additive install size or the bundle inventory above.

For an already provisioned source machine, sync dependencies without the
guided checks, or rerun setup after vendor-auth choices change:

```bash
corepack pnpm dev:setup
uv --project workers/automation run jobctrl setup
```

Playwright Chromium is the managed source browser, installed per Python
virtualenv. A bare `uv sync` or a fresh git worktree needs
`uv --project workers/automation run playwright install chromium` (set
`PLAYWRIGHT_SKIP_BROWSER_GC=1` when installing from another checkout that
shares the browser cache). `jobctrl doctor` validates the browser and the
worker refuses to start without it
(`JOBCTRL_SKIP_BROWSER_PREFLIGHT=1` overrides for non-browser workers).

</details>

Full first-run guide: [jobctrl.dev/user/getting-started](https://jobctrl.dev/user/getting-started).

## Screenshots

| | |
| --- | --- |
| [<img src="docs/assets/screenshots/jobs.png" alt="Jobs table with fit scores, stages, and filters (synthetic data)" width="440" />](docs/assets/screenshots/jobs.png) | [<img src="docs/assets/screenshots/apply-review.png" alt="Apply Review editing a tailored resume with audit evidence (synthetic data)" width="440" />](docs/assets/screenshots/apply-review.png) |
| **Jobs** — scored, filterable, every score inspectable | **Apply Review** — rich-text edit and approve the exact resume that ships |
| [<img src="docs/assets/screenshots/job-detail.png" alt="Job detail with requirement-level fit evidence (synthetic data)" width="440" />](docs/assets/screenshots/job-detail.png) | [<img src="docs/assets/screenshots/runs.png" alt="Runs page with durable workflow history (synthetic data)" width="440" />](docs/assets/screenshots/runs.png) |
| **Job detail** — requirement-by-requirement fit evidence | **Runs** — durable workflows you can watch, retry, and audit |

Full tour with captions: [Product Tour](https://jobctrl.dev/user/screenshots).
Documentation screenshots must be generated from synthetic data — refresh
them with `pnpm docs:screenshots`
([how it works](https://jobctrl.dev/local-development)).

## How It Compares

The projects solve a similar problem through different operating models. This
summary is pinned to reviewed snapshots; the
[full comparison](https://jobctrl.dev/comparison) includes source links, issue
evidence, qualifications, and the complete capability matrix.

| Capability | JobCtrl | Career-Ops | AI Job Search |
| --- | --- | --- | --- |
| **Primary surface** | Web app + local API/worker; supporting CLI | Files + AI coding CLIs; terminal dashboard | Claude Code commands/skills + local utilities |
| **Graphical UI** | **Supported product surface** | **Partial:** optional Next.js alpha | **Not evidenced** in the reviewed snapshot |
| **Tailored documents** | Resume, cover letter, HTML, and PDF | CV/PDF and cover letter | LaTeX CV, cover letter, and PDF |
| **Submission boundary** | Dry run + guarded browser/Gmail paths; approval on by default | Form autofill; the user clicks Submit | Reviewed documents; the user submits |
| **Interrupted work** | Temporal history, retries, and stable workflow identities | File integrity + resumable batch flags; no workflow engine | No checkpointed apply resumption evidenced |
| **Application-level cost control** | Daily estimated-spend ceiling | Model choice + batch cap, dry run, and resume controls | Token-efficiency instructions; no app-level budget evidenced |

## What It Does

- Discover jobs from configured searches and supported source registries,
  driven by your target roles, locations, and seniority — recording which
  source each job came from.
- Optionally reconcile a local Temporal Schedule for discovery; it is disabled
  by default and uses the configured cron only after you enable it.
- Enrich postings with full descriptions, canonical posting URLs, and apply
  URLs.
- Fetch politely: every discovery/enrichment request routes through one
  gateway that honors `robots.txt`, paces each host, bounds each run's request
  budget, and sends an honest `User-Agent` that never impersonates a browser
  (details in [Local Data And Safety](#local-data-and-safety)).
- Capture a current browser job page through the optional local browser
  extension, which feeds the existing manual-capture import path.
- Score jobs as an applicant-side triage aid with auditable evidence — never
  employer-side screening.
- Generate tailored resumes, cover letters, PDFs, and review artifacts.
- Review generated resumes in Apply Review as editable rich-text documents:
  change text and formatting, add hyperlinks, save a draft, render the
  replacement PDF, and approve only the exact reviewed artifact.
- Inspect the evidence map to see which profile achievements and skills are
  reused in generated materials, requirement-fit decisions, and recorded gaps.
- Generate stored interview prep **(Beta)** for a selected job from grounded
  JobCtrl data, with evidence links and gap drills kept inspectable before the
  interview. Its truthfulness gates are shipped, but output quality has not yet
  been validated through real-user usage.
- Edit resume PDF style templates in Preferences, choose a default template,
  and override the template per job without modifying candidate profile data.
- Track pipeline state, failures, retries, workflow runs, artifacts, and apply
  history in a local web UI.
- Keep recruiter, hiring-manager, and referrer contact records per company or
  application, each fact carrying its provenance, with CSV import. Draft
  truthful, reviewable outreach messages under the same anti-fabrication gates
  as your resumes, then **you** send them yourself and **log the send** (date
  + channel) — the only way a thread is marked sent. Follow-up reminders are
  surfaced-only suggestions. JobCtrl never sends anything to your contacts —
  it drafts, previews, and records only, with no send transport of any kind.
- Optionally run browser-based apply automation, starting with dry runs.

Auto-apply is powerful and must be treated as an explicit submission tool. It
is off by default (`autoApply: false`), so no standing apply loop runs unless
you opt in. It also requires the separately disabled
`auto-apply-browser` capability to be enabled with an explicit Chrome/Chromium
executable choice. When `autoApply: true`, a worker maintains one continuous Apply
workflow, visible in Runs as the standing apply loop. With the default
approval gate still on (`applyApprovalRequired: true`), that loop only submits
jobs already approved in Apply Review and parks the rest for review. If you
turn the approval gate off in Preferences, the settings form shows a
persistent warning because the standing loop may submit eligible prepared
jobs autonomously — still bounded by minimum fit score, the daily spend
ceiling, at-most-once submit intent tracking, CAPTCHA fail-closed behavior,
and the dry-run guard when a dry-run apply path is used. Use dry-run paths
and narrow targets before allowing live submission.

System Chrome/Chromium is never a core requirement. A source checkout uses its
managed Playwright Chromium installs; the bundled candidate carries exactly one
Playwright Chromium headless shell. Inspect the split with
`jobctrl capability list`; adopt a system browser only for authenticated apply
features:

```bash
jobctrl capability enable auto-apply-browser --browser-path /path/to/Chrome
jobctrl capability enable authenticated-linkedin-browser --browser-path /path/to/Chrome \
  --copy-profile-from /path/to/Chrome-profile --consent-copy-profile
```

LinkedIn profile copying always requires its own consent flag: `--yes` never
grants it. JobCtrl copies only into its owned data directory and does not retain
the source-profile path.

### Browser Extension Capture And Autofill

The optional Manifest V3 extension is a local capture and assist surface:
build with `pnpm extension:build`, load `dist/extension/` unpacked, and pair
it with the token shown in JobCtrl Settings. **Save job** captures the active
page over loopback into the manual-capture importer (same dedupe, snapshots,
quarantine, and source provenance as any user-mediated capture), with a
bounded offline queue when the stack is down. On supported ATS pages,
**Review autofill** shows deterministic, profile-sourced field suggestions —
you choose what to fill. The extension does not generate free-text answers
and has no submission path.

## Responsible Use

JobCtrl is an applicant-side automation tool. Treat the paths that touch
employers, accounts, provider APIs, and third-party sites as live operations:

- Live apply automation can submit real applications to real employers. Keep
  `autoApply` off until you intentionally want a standing loop, keep
  `applyApprovalRequired` on unless you intentionally want autonomous submit,
  rehearse with dry runs, and target one job or site at a time until you
  trust the behavior.
- Email-based application sending is also a live employer submission. JobCtrl
  sends only through its owned Gmail connector after a dry-run records the
  recipient and attachment candidate and Apply Review approves that exact
  binding; the path requires Gmail `gmail.send` and otherwise fails closed.
- Browser automation can type non-secret profile fields. For job-site
  password fields, the apply agent calls a local credential tool that types
  the stored password into the focused field without returning the value to
  the model; if the tool is unavailable, login fails closed.
- CAPTCHA solving is available only through the owned local solver tool for
  supported widgets. Image/audio, unsupported, or unconfigured challenges
  fail closed. Do not solve challenges manually, switch to stealth browsers,
  or bypass bot controls.
- Scraping and source access can violate site terms. Default discovery
  options include LinkedIn and Indeed; disable any source you are not allowed
  to query automatically.
- The local API is intended for loopback use. Browser-extension routes
  additionally require a local capability token shown in Settings and stored
  under `~/.jobctrl/`; token display and rotation are restricted to CLI or the
  same-origin Settings surface, not arbitrary loopback web origins. Unsafe API
  calls from non-browser local clients need that token; arbitrary loopback web
  origins remain blocked. Do not bind the API to a network interface or tunnel
  it unless you accept exposing private profile, job, and artifact data.
- LLM work can spend money and send job, profile, and generated-material text
  to configured providers. `dailyBudgetUsd` caps new spendful workflows
  locally, but it is an estimate rather than the provider bill.
- Beta interview prep is stored pre-interview material only; its output quality
  has not yet been validated through real-user usage. You can record
  post-interview reflections against an accepted prep generation, but JobCtrl
  is not a live interview assistant; it has no transcript, microphone,
  streaming, websocket, or real-time answer surface.
- Profiles, generated materials, browser state, logs, SQLite databases, and
  local worker state are sensitive local artifacts. Public bug reports and
  screenshots should use synthetic data only; `pnpm qa:seed` creates a
  disposable synthetic workspace for that purpose.

## What Leaves Your Machine

Nothing leaves your machine by default. Privacy-sensitive content leaves only
when you deliberately run a step that needs an outside service, and each path
is opt-in and configuration-gated:

- **LLM providers** — scoring, employer analysis, resume tailoring, and
  cover-letter generation, plus contact-research extraction for opted-in public
  pages (job text, your profile evidence, generated material text, and fetched
  public page text for that research run).
- **The apply agent's model** — the apply prompt during apply or dry-run
  (your profile summary and the tailored materials). The prompt never
  includes profile passwords or CAPTCHA-provider keys; password typing uses a
  local credential tool that never returns the secret to the model.
- **Job boards, ATS APIs, posting pages, and contact-research public pages** —
  discovery, enrichment, and supervised contact-research fetches. Contact
  research rejects loopback, private-network, link-local, and metadata URLs or
  redirects before page text can enter the LLM extraction prompt.
- **Gmail** — verification-code and application-outcome lookups, plus
  approved email application sends, only if you authenticate the connector.
  Raw email bodies stay local; outgoing sends require the `gmail.send` scope.
- **Google Maps** — address autocomplete, only if you set
  `VITE_GOOGLE_MAPS_API_KEY`.
- **CAPTCHA solving** — supported widgets are handled only through the owned
  local solver tool when configured; no solver key travels through the model
  prompt.
- **Langfuse / OpenTelemetry** — traces, only when you configure it
  (`LANGFUSE_DISABLE=1` opts out even with credentials present).

The apply prompt is the largest single batch of personal data that can leave.
Full per-call breakdown:
[Security → What Leaves Your Machine](https://jobctrl.dev/user/security#what-leaves-your-machine);
storage-and-privacy inventory:
[Data, Privacy & Safety](https://jobctrl.dev/user/data-and-safety).

## Current vs Roadmap

Everything in [What It Does](#what-it-does) above is **shipped and runs on
your machine today** through the source path. [Get Started](#get-started)
separately labels the bundled distribution implementation as **not published**;
its install channel and clean-machine QA remain Roadmap until signed release
evidence exists. Workspace export/import and any hosted or multi-user
deployment (accounts, billing, hosted browsers, object storage, cloud sync)
also live in [ROADMAP.md](ROADMAP.md). Nothing presented as current depends on
a hosted service.

## Local Data And Safety

By default, JobCtrl writes local data under `~/.jobctrl/`:

- `jobctrl.db` — local SQLite database with profile, jobs, events,
  projections, settings, and artifact metadata.
- `temporal.db` — bundled-runtime Temporal persistence. It is rollback-critical
  alongside `jobctrl.db`: a bundled release transition snapshots and restores
  the two databases as one verified pair, never as independent files.
- `.env` — plaintext, cross-platform fallback for provider/API credentials
  and local runtime settings; it is not encrypted at rest.
- `tailored_resumes/`, `cover_letters/`, `logs/` — generated artifacts and
  logs.
- `chrome-workers/`, `apply-workers/` — local browser/apply worker state.
- `codex_home/` — JobCtrl-owned Codex home for local analysis. The adapter
  copies Codex auth here from the user's regular Codex home and runs
  prompt-driven commands from `codex_home/workspace/` only.
- `backups/` — source-mode `jobctrl backup` snapshots and, once the P6-signed
  bundled channel is public, verified paired lifecycle snapshots.

Unless noted otherwise, those paths are relative to `JOBCTRL_DIR`, whose
default is `~/.jobctrl/`. On macOS, the three provider settings supported by
the web credential panel can live in the system Keychain instead of this
directory.

The daily digest is local-only: `jobctrl digest` and the Dashboard panel read
from `jobctrl.db` without sending notifications; only the explicit
acknowledge action advances the `digest_state` watermark.

The default workspace is outside the repository, and the repository's
`.gitignore` excludes the known `.env`, SQLite, generated-artifact, browser,
worker, log, resume, and `.dev/` paths. The release privacy check adds a second
guard before publication. These protections reduce accidental commits; they do
not make a manually copied or force-added private file safe to publish. Use
`pnpm qa:seed` for shareable screenshots and reproduction data. See
[Data, Privacy & Safety](https://jobctrl.dev/user/data-and-safety) and
[SECURITY.md](SECURITY.md).

Discovery and enrichment fetch politely: every request runs through one
gateway that honors `robots.txt` — failing closed on an inconclusive fetch
(`5xx` or timeout) but failing open with a warning when the host has no
robots endpoint at all (DNS failure or refused connection) — paces each host,
bounds each run's request budget, and sends an honest `User-Agent`
(`JobCtrl/<version> (+<repo url>)`) that never impersonates a browser. Review
or override that identity before crawling real sites via
`JOBCTRL_CRAWL_UA_PRODUCT` / `JOBCTRL_CRAWL_UA_CONTACT`
([Configuration → Crawl Politeness](https://jobctrl.dev/user/configuration#crawl-politeness));
`jobctrl doctor` prints the effective value. Direct targets, redirects, and
Playwright subrequests must also be public HTTP(S) destinations; loopback,
private, link-local, metadata-service, and file URLs are blocked before content
extraction or LLM enrichment. JobCtrl never bypasses login, paywall, CAPTCHA,
rate-limit, or bot-control gates.

### Back Up And Restore

Application records live in `jobctrl.db`. Snapshot them any time — even while
the app runs:

```bash
jobctrl backup
```

The command above is the canonical installed spelling. While the source
checkout remains the only public path, invoke it with the source prefix shown
in [Get Started](#get-started).

This writes `~/.jobctrl/backups/jobctrl-<timestamp>.db` via SQLite
`VACUUM INTO` and never deletes anything (`--output <path>` to choose a
target).

<details>
<summary><b>Restore steps</b></summary>

Stop the app (`jobctrl stop` when installed, or Ctrl-C on `corepack pnpm dev`
from a source checkout), clear stale WAL sidecars, and copy a backup over the
live database:

```bash
rm -f ~/.jobctrl/jobctrl.db-wal ~/.jobctrl/jobctrl.db-shm
cp ~/.jobctrl/backups/jobctrl-<timestamp>.db ~/.jobctrl/jobctrl.db
```

Always restore the whole file — never hand-import individual tables. The
read-model's projection watermark only moves forward; if you ever rebuild the
database piecemeal, delete the watermark row so projections rebuild:

```bash
sqlite3 ~/.jobctrl/jobctrl.db \
  "DELETE FROM event_watermarks WHERE projection_name = 'operations_projections';"
```

The bundled distribution adds a separate `temporal.db` runtime store. Its
native update, rollback, and backup boundary treats `jobctrl.db` and
`temporal.db` as one hash-verified pair. The implementation exists, but the
signed channel is not public yet; do not use local distribution fixtures as a
production upgrade path.

</details>

## Normal Flow

1. Create or import a candidate profile.
2. Configure target roles, locations, work models, and application
   preferences. In Settings, opt into Levels.fyi or Glassdoor compensation
   feeds only when you have the matching licensed or permitted access.
3. Run Discover from the UI or CLI, optionally targeting a single source from
   the Pipelines tab when you want a lighter retry.
4. Review jobs, scores, blockers, compensation evidence, and audit history.
5. Open Evidence from the main nav, Profile, or a job detail drawer to
   inspect which profile evidence backs generated materials and
   requirement-fit gaps.
6. Generate or inspect materials and Beta stored interview prep for promising
   jobs; review it carefully because output quality lacks real-user validation.
7. Use Apply Review's rich-text resume editor to edit text, formatting, and
   hyperlinks, review comments, and compare a rendered draft against the
   accepted artifact before approval.
8. Run apply dry-runs before approving any real browser submission; the
   default live path requires an `approve_submit` decision in Apply Review
   before the backend claim can proceed. If you enable Auto apply, Runs shows
   the standing loop; with approval still required it parks unapproved jobs
   for review, and with approval disabled it may submit eligible jobs
   autonomously.
9. Track progress in Dashboard, Analytics, Jobs, Runs, Artifacts, Evidence,
   Apply Review, and Debug.

Commands and expected state transitions:
[Daily Workflow](https://jobctrl.dev/user/normal-flows).

## Under The Hood

Three local runtime components, with SQLite and local files as the source of
truth:

- `apps/api` — local TypeScript/Fastify API for read models, profile and
  settings, structured actions, artifacts, and worker dispatch.
- `apps/web` — React/Vite app on TanStack Router/Query/Form with SSE-backed
  cache invalidation.
- `workers/automation` — Python automation engine, CLI, and Temporal worker:
  discovery, scoring, materials, PDF rendering, apply automation.

Commands that start work (`jobctrl run`, per-stage commands, `jobctrl job
<url>`, `jobctrl apply`, `jobctrl action profile_import`,
`jobctrl compensation-refresh`) start Temporal workflows and require a
reachable Temporal server plus a running JobCtrl worker — `corepack pnpm dev`
provides both in a source checkout, while `jobctrl start` owns the complete
installed runtime. Architecture deep dives: [system architecture](https://jobctrl.dev/architecture/)
and the [pipeline walkthrough](https://jobctrl.dev/architecture/pipeline/).

## CLI Reference

The command table omits the invocation prefix. The current source checkout runs
commands as `uv --project workers/automation run jobctrl <command>`. After the
first signed bundled release, the same native executable that owns
`jobctrl start` dispatches every domain command as plain
`jobctrl <command>` from any directory. Homebrew does not create a different
CLI surface.

<details>
<summary><b>Command table</b></summary>

| Command | What it does |
| --- | --- |
| `init` | Create local configuration under `~/.jobctrl/`. |
| `setup` | Check/sync dependencies, detect vendor auth, and persist enabled employer-analysis legs. |
| `doctor` | Report feature tiers: database, LLM, Temporal, browser, Gmail, telemetry. |
| `run [stages]` | Start pipeline workflows (default `all`, which maps to `discover`). |
| `discover` / `enrich` / `score` / `tailor` / `cover` | Start one stage; `score --rescore` re-scores reset stale scores. |
| `job <url>` | Tailor and/or apply one job (`--tailor`, `--apply`, `--dry-run`). |
| `apply` | Start apply automation; utility modes: `--mark-applied`, `--mark-failed`, `--reset-failed`, `--gen`, `--continuous`. |
| `retry <stage> <url>` | Reset one failed stage for one job (`--reset-attempts`, `--run`). |
| `action <stage>` | Low-level single-action dispatch with JSON output (used by scripts). |
| `compensation-refresh` | Re-parse posted salaries and refresh market estimates (`--url`, `--observations-json`). |
| `pipeline-status` / `runs` | Inspect database stats and run telemetry (`runs --failed-only`). |
| `digest` | Print the local daily digest (`--json`, `--acknowledge`, `--min-fit-score`). |
| `worker` | Run the long-lived Temporal worker. |
| `rpc` | JSON-RPC server spawned by the TypeScript API (internal). |
| `backup` | Snapshot the SQLite database via `VACUUM INTO` (`--output`). |
| `migrate-resume-html` | Convert/refresh approved resume PDFs onto the HTML/CSS renderer. |
| `gmail-auth` | Authenticate the Gmail connector for verification, outcome lookup, and approved email application sends. |

</details>

## Configuration

Configuration comes from local profile/settings stores, environment variables
(`~/.jobctrl/.env`, repo `.env`, or the shell), and package-shipped source
registries. Compensation-source opt-ins are managed from Settings and stored
locally. Start with [.env.example](.env.example); full reference:
[Configuration](https://jobctrl.dev/user/configuration).

The cross-platform provider-credential path is the plaintext
`~/.jobctrl/.env` file or the process environment. On macOS only, Settings can
instead store `OPENAI_API_KEY`, `GEMINI_API_KEY`, and `LLM_URL` in the system
Keychain. At Python process startup, after env files are loaded, a non-empty
environment value takes precedence; only a missing or empty allowlisted value
is copied from Keychain into that process. Keychain edits are not hot-reloaded,
so restart the worker or full stack after saving or removing one. Native Windows
Credential Manager and Linux Secret Service/keyring adapters are planned, not
shipped; use `.env` or the shell on those platforms today. The macOS panel
distinguishes **not configured** from **status unknown**: an unknown
(`inspection_failed`) result means Keychain could not be inspected, not that the
entry is absent. Unlock Keychain if it is locked, then retry; operational
save/remove failures return a generic unavailable message rather than raw
Keychain output.

<details>
<summary><b>Common variables</b></summary>

- `JOBCTRL_DIR` — override the local app directory.
- `GEMINI_API_KEY`, `OPENAI_API_KEY`, or `LLM_URL` — general LLM access.
- `ANTHROPIC_API_KEY` or local Claude credentials — Claude employer-analysis
  leg.
- `CODEX_HOME/auth.json` — Codex employer-analysis leg; a bare
  `OPENAI_API_KEY` must be enrolled with `codex login --with-api-key` or
  `jobctrl setup`.
- `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or Vertex ADC env — Antigravity/Gemini
  employer-analysis leg.
- `JOBCTRL_ANALYSIS_LEGS` — comma-separated enabled analysis legs when setup
  intentionally skips an unauthenticated leg.
- `LLM_MODEL` — default model for the configured provider.
- `VITE_GOOGLE_MAPS_API_KEY` — optional address search in the Profile form.
- `PLAYWRIGHT_SKIP_BROWSER_GC=1` — keep other worktrees' Playwright browsers
  when running `playwright install` from this checkout.
- `JOBCTRL_SKIP_BROWSER_PREFLIGHT=1` — skip the worker's startup Chromium
  check (workers running only non-browser activities).
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` —
  optional OpenTelemetry/Langfuse export; `LANGFUSE_DISABLE=1` opts out.

</details>

Discovery scheduling is stored in SQLite: `scheduling_enabled` defaults to
`false`; `schedule_cron` defaults to `0 7 * * *` and only runs after you
enable it. LLM spend is tracked locally; `dailyBudgetUsd` defaults to `25`
(`0` = unlimited), spendful workflows run a budget preflight, and the health
surface shows today's estimated spend.

## Development

```bash
scripts/install            # or: corepack pnpm install:interactive when Corepack exists
pnpm check                 # cross-stack typecheck + lint
pnpm test                  # API + web build + Python tests
```

Focused commands (`pnpm api:test`, `pnpm web:test`, `pnpm web:e2e`,
`pnpm extension:test`, `uv --project workers/automation run --extra dev
pytest -q`, …) are listed in
[Local Development](https://jobctrl.dev/local-development). Contributor
workflow: [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [User Guide](https://jobctrl.dev/user/getting-started) — setup, product tour, configuration, normal
  flows, data & safety, security model.
- [Developer Guide](https://jobctrl.dev/developer/) — contributor onboarding and
  architecture reading path.
- [System Architecture](https://jobctrl.dev/architecture/) — runtime boundaries,
  pipeline, storage, scoring, materials audit, read model, observability.
- [Reliability & QA](https://jobctrl.dev/local-reliability-qa) — regression
  matrix and QA gates.
- [Decisions](docs/decisions.md) — accepted architecture decisions.
- [docs/backlog.md](docs/backlog.md) · [docs/plans/](docs/plans/) — backlog
  and implementation records.

## License

Copyright (C) 2026 Eloi Barti.

JobCtrl is licensed under **AGPL-3.0-only**. See [LICENSE](LICENSE) and
[NOTICE](NOTICE). The license and copyright notices must be preserved in
redistributions. The complete corresponding source is published in this
[repository](https://github.com/ebarti/JobCtrl).
