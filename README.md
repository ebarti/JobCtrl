<div align="center">

# JobCtrl

**Find the right jobs, prove the fit, and apply — from one local, auditable
mission control.**

JobCtrl discovers jobs, scores them against your real profile, tailors
truthful materials you review, and helps you apply with guardrails — while
your profile, job database, generated resumes, browser state, and logs stay
on your machine.

**[Try the live demo](https://demo.jobctrl.dev) ·
[Install on Apple-silicon macOS](https://jobctrl.dev/user/getting-started) ·
[Take the product tour](https://jobctrl.dev/user/product-tour) ·
[Compare approaches](https://jobctrl.dev/comparison) ·
[Join the discussion](https://github.com/ebarti/JobCtrl/discussions)**

[![TypeScript CI](https://github.com/ebarti/JobCtrl/actions/workflows/typescript.yml/badge.svg)](https://github.com/ebarti/JobCtrl/actions/workflows/typescript.yml)
[![Release Privacy Gate](https://github.com/ebarti/JobCtrl/actions/workflows/release-check.yml/badge.svg)](https://github.com/ebarti/JobCtrl/actions/workflows/release-check.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
![Source Python 3.11+](https://img.shields.io/badge/source-Python%203.11%2B-3776AB)
![Source Node 20.19+](https://img.shields.io/badge/source-Node%2020.19%2B-339933)

<img src="docs/assets/screenshots/dashboard.png" alt="JobCtrl dashboard with pipeline health, active work, review queues, and recent activity (synthetic data)" width="880" />

*Every screenshot in this repo is generated from synthetic sample data —
no real people, resumes, or applications.*

If JobCtrl's local-first approach is useful to you, starring the repository
helps other job seekers and open-source contributors find it.

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

## Live Demo

Open [demo.jobctrl.dev](https://demo.jobctrl.dev) to explore synthetic jobs,
scoring evidence, tailored materials, dry-run rehearsals, and workflow history
before installing JobCtrl. Demo actions are simulated and cannot contact
employers, providers, Gmail, job boards, or the local JobCtrl app.

The demo requires analytics-cookie acceptance before it creates its
browser-local workspace. Acceptance enables bounded first-party demo
measurement and Google Analytics with advertising and personalization signals
disabled. Declining returns to `jobctrl.dev`; a later visit asks again. Read the
[demo data notice](https://jobctrl.dev/user/data-and-safety#public-demo) before
entering, and do not type personal data, credentials, or secrets.
When a deployment updates the canonical synthetic examples, the next demo load
refreshes that browser-local workspace once; cookie consent is unchanged.

## Get Started

Install the signed Apple-silicon macOS release with the bundled installer:

```bash
curl -fsSL https://jobctrl.dev/install.sh | sh
```

Or acquire the same signed build with Homebrew:

```bash
brew install ebarti/tap/jobctrl
```

These public acquisition paths currently target Apple-silicon macOS. Native
Windows is not yet a supported public installation path.

Both methods install one native `jobctrl` command plus its managed private
runtime. Start the complete local product from any directory:

```bash
jobctrl start
jobctrl setup
jobctrl doctor
```

`jobctrl start` waits for the local services to become healthy and opens the
app in your browser. The bundle targets Apple-silicon macOS 15 or newer and
carries the API/web/worker, Node, Python, Temporal, PDF.js, Python Playwright,
and Playwright MCP runtimes. It neither creates a source checkout nor needs Git,
Node, pnpm, Corepack, uv, Python, Temporal, Poppler, Playwright, or `npx` on the
user's `PATH`.

The managed headless browser covers discovery, enrichment, and PDF rendering.
A system Chrome/Chromium installation remains optional unless you explicitly
enable an authenticated-browser or auto-apply capability that needs it.

The web app does not require `jobctrl init`. Run it only when you want starter
files for terminal-driven workflows. The same executable owns every lifecycle
and domain command: `jobctrl status`, `jobctrl logs`, `jobctrl stop`,
`jobctrl pipeline-status`, and `jobctrl <domain-command>`.

<details>
<summary><b>Build and run from source instead</b></summary>

Use the source option when you want to inspect, modify, or contribute to
JobCtrl:

```bash
git clone https://github.com/ebarti/JobCtrl.git
cd JobCtrl
scripts/install
corepack pnpm dev
```

Only this option requires Git and the contributor toolchain. Keep the
`corepack pnpm dev` terminal open while using the source build. See
[Local Development](docs/local-development.md) for prerequisites, component
commands, isolated workspaces, and QA.

</details>

Full first-run guide: [jobctrl.dev/user/getting-started](https://jobctrl.dev/user/getting-started).

## Screenshots

| | |
| --- | --- |
| [<img src="docs/assets/screenshots/pipelines.png" alt="Pipelines workspace with launch controls, a visual stage flow, and diagnostics (synthetic data)" width="440" />](docs/assets/screenshots/pipelines.png) | [<img src="docs/assets/screenshots/jobs.png" alt="Jobs table with fit scores, stages, and filters (synthetic data)" width="440" />](docs/assets/screenshots/jobs.png) |
| **Pipelines** — launch bounded work and inspect cohorts, backlog, capacity, ETA, and active tasks | **Jobs** — scored, filterable, and ready for bulk or individual triage |
| [<img src="docs/assets/screenshots/job-detail.png" alt="Route-level Job Detail workspace with requirement evidence and audit history (synthetic data)" width="440" />](docs/assets/screenshots/job-detail.png) | [<img src="docs/assets/screenshots/apply-review.png" alt="Application Review workspace editing a tailored resume with audit evidence (synthetic data)" width="440" />](docs/assets/screenshots/apply-review.png) |
| **Job detail** — one bookmarkable workspace for fit, provenance, materials, progress, and history | **Apply Review** — edit and approve the exact resume and evidence binding that ships |

Full tour with captions: [Product Tour](https://jobctrl.dev/user/product-tour).
Documentation screenshots must be generated from synthetic data — refresh
them with `pnpm docs:screenshots`
([how it works](https://jobctrl.dev/local-development#documentation-screenshots)).

## How It Compares

The projects solve a similar problem through different operating models. This
summary is pinned to reviewed snapshots; the
[full comparison](https://jobctrl.dev/comparison) includes source links, issue
evidence, qualifications, and the complete capability matrix.

| Capability | JobCtrl | Career-Ops | AI Job Search |
| --- | --- | --- | --- |
| **Primary surface** | Web app + local API/worker; supporting CLI | Files + AI coding CLIs; terminal dashboard | Claude Code commands/skills + local utilities |
| **Graphical UI** | **Supported product surface** | **Partial:** optional Next.js alpha | **Partial:** generated offline HTML dashboard |
| **Tailored documents** | Resume, cover letter, HTML, and PDF | CV/HTML/PDF and cover letter | LaTeX CV, cover letter, and PDF |
| **Submission boundary** | Browser rehearsal + manual final submit; exact-approval Gmail sends | Form autofill; the user clicks Submit | Reviewed documents; the user submits |
| **Interrupted work** | Temporal history, retries, stable workflow identities, and checkpointed broad-board discovery | File integrity + resumable batch flags; no workflow engine | No checkpointed apply resumption evidenced |
| **Application-level cost control** | Daily estimated-spend ceiling | Spend tiers, batch pre-screen/cap, dry run, and resume controls | Token-efficiency instructions; no app-level budget evidenced |

## What It Does

- Discover jobs from configured searches and supported source registries,
  driven by your target roles, locations, and seniority — recording which
  source each job came from.
- Stream broad-board results through JobStreaming and commit each accepted
  posting before acknowledging its provider checkpoint. If the worker stops,
  the same Discover execution resumes unfinished query/location/board units;
  accepted postings and the run-wide new-job limit survive replay, and
  Pipelines reports how many units resumed.
- Optionally reconcile a local Temporal Schedule for discovery; it is disabled
  by default and uses the configured cron only after you enable it.
- Enrich postings with full descriptions, canonical posting URLs, and apply
  URLs.
- Keep each job under one tenant-scoped, immutable `JobId`. Posting and
  application URLs are locators resolved only at explicit capture/import/API
  boundaries, so a URL change cannot detach scores, materials, outcomes, or
  workflow history. Source and employer remain separate persisted facts.
- Fetch politely: anonymous discovery/enrichment requests route through one
  gateway that honors `robots.txt`, paces each host, bounds each run's request
  budget, and sends an honest `User-Agent` that never impersonates a browser.
  A separately enabled, explicitly consented authenticated LinkedIn profile may
  recover the full posting and inspect its application target without applying
  the anonymous robots verdict. An external URL is stored when one exists;
  LinkedIn on-site apply and other unresolved-target cases receive distinct,
  auditable reasons. Public-destination checks, host pacing, run budgets, audit
  history, and the no-submission boundary still apply (details in
  [Local Data And Safety](#local-data-and-safety)).
- Capture a current browser job page through the optional local browser
  extension, which feeds the existing manual-capture import path.
- Work through one compact route hierarchy with 14px/20px body copy in every density.
  Compact, regular, and comfy modes change row/control spacing, while
  record-heavy Jobs, Artifacts, Contacts, Discovery, and Settings surfaces
  reflow into labelled cards at narrower widths.
- Score jobs as an applicant-side triage aid with auditable evidence — never
  employer-side screening.
- Persist normalized scoring keywords per score version. The jobs API filters
  by the canonical normalized key, while `/v1/scoring/keywords` exposes the
  current-version aggregation used by typed clients.
- Generate tailored resumes, cover letters, PDFs, and review artifacts.
- Triage jobs through the real **Active**, **Deleted**, and **Hidden** queues.
  The default Active view keeps source and warning columns available but hidden,
  uses destructive styling for deletion, and opens a row through its focused
  activation control instead of adding a competing always-visible action.
- Review generated resumes in Apply Review as editable rich-text documents:
  change text and formatting, add hyperlinks, save a draft, render the
  replacement PDF, and approve only the exact reviewed artifact.
- Inspect the evidence map to see which profile achievements and skills are
  reused in generated materials, requirement-fit decisions, and recorded gaps.
  Job and artifact audit surfaces show those references as human-readable
  evidence; storage identifiers remain under technical details.
- Generate stored interview prep **(Beta)** for a selected job from grounded
  JobCtrl data, with evidence links and gap drills kept inspectable before the
  interview. Its truthfulness gates are shipped, but output quality has not yet
  been validated through real-user usage.
- Edit resume PDF style templates in Preferences, choose a default template,
  and override the template per job without modifying candidate profile data.
- Launch bounded Discover and Apply work from Pipelines, then inspect the same
  workspace's live stage cards and diagnostics: current-execution and
  execution-sweep cohorts, unrelated global backlog, source-family intake versus
  reconciliation, exact terminal and attention outcomes, ETA, worker capacity,
  approximate task-queue pressure, read-model freshness, and active work. An
  active Discover run can be stopped there. A failed run reports whether work
  remains before offering to set up a replacement run; setup never starts work
  by itself. Runs keeps the durable workflow history; Jobs and route-level
  detail workspaces keep record-specific evidence and actions adjacent.
- Inspect Discover, preparation, and Apply through the same Runs vocabulary,
  timeline, terminal-state rules, and cancellation control. Repeated cancel
  requests are harmless, the requester/source remains in the run timeline, and
  an already-terminal result remains inspectable. Canceling Enrich terminalizes
  only that run's unfinished selected jobs; unrelated pending work is untouched.
  Run detail names the selected stage scope from the workflow input, so a
  cover-only maintenance run is labeled **Cover letter run** instead of the
  generic pipeline workflow name.
- Treat `pending` as work that can still start. When a current score is below
  the live materials threshold, Tailor, Cover, and Apply instead show
  **skipped** with the `MIN_SCORE` reason and the exact score/threshold pair.
  A score hard blocker remains **blocked**. Lowering the threshold, recording a
  higher score, or deliberately choosing **Tailor this job** clears only that
  threshold-owned skip; it does not consume a failed-generation retry.
- Review privacy-bounded learning recommendations on the Dashboard. JobCtrl
  derives them only from explicit reviewed signals, requires compatible
  evidence across jobs, and changes Materials behavior only after you accept a
  recommendation. Tailoring policy history is versioned, superseded revisions
  remain inspectable, and restore creates a new append-only revision without
  re-scoring jobs or replacing artifacts.
- Keep recruiter, hiring-manager, and referrer contact records per company or
  application, each fact carrying its provenance, with CSV import. Draft
  truthful, reviewable outreach messages under the same anti-fabrication gates
  as your resumes, then **you** send them yourself and **log the send** (date
  + channel) — the only way a thread is marked sent. Follow-up reminders are
  surfaced-only suggestions. JobCtrl never sends anything to your contacts —
  it drafts, previews, and records only, with no send transport of any kind.
- Optionally run browser-based apply automation, starting with dry runs.

Auto-apply is powerful and must be treated as an employer-facing tool. It is off
by default (`autoApply: false`), so no standing apply loop runs unless you opt
in. It also requires the separately disabled `auto-apply-browser` capability to
be enabled with an explicit Chrome/Chromium executable choice. When
`autoApply: true`, a worker maintains one continuous Apply workflow, visible in
Runs as the standing apply loop. The model-driven browser is transport-locked:
it may rehearse a form, but it cannot perform the final browser submit. Browser
form runs stop with `trusted_final_submit_required` before a live browser or
model starts, so you complete the reviewed form manually. The only automated
live submission path is JobCtrl's owned Gmail sender, after a dry run records
the exact recipient/attachment candidate and Apply Review approves that binding.
Turning `applyApprovalRequired` off can remove the claim-time review gate, but
it does not grant browser-submit authority or bypass the email sender's exact
approval check. The dry-run browser grants only one exact navigation to the
reviewed application URL; replays and path/query changes are blocked and
recorded.
The auto-apply toggle, approval requirement, and minimum fit threshold are all
owned by **Discovery → Runtime settings**.

Repeat-application protection remains active independently of those automation
settings. A confirmed prior application to the same canonical opening, including
an accepted duplicate identity reached through another URL, blocks another live
attempt by default. A confirmed application to the same employer and a
materially equivalent role requires a deliberate, reasoned confirmation for one
live attempt. Distinct roles at the same employer remain eligible. The worker
rechecks the current evidence while atomically claiming the run, so disabling
Apply Review approval, using the standing loop, or dispatching through the API
does not bypass this protection. See
[Apply → Repeat-Application Protection](docs/user/apply.md#repeat-application-protection).

System Chrome/Chromium is never a core requirement. A source checkout uses its
managed Playwright Chromium installs; the bundled release carries exactly one
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

- Browser apply automation can inspect and fill employer forms, but it cannot
  perform the final browser submit. Rehearse with dry runs, target one job or
  site at a time, then review and complete the form manually.
- Email-based application sending is also a live employer submission. JobCtrl
  sends only through its owned Gmail connector after a dry-run records the
  recipient and attachment candidate and Apply Review approves that exact
  binding; the path requires Gmail `gmail.send` and otherwise fails closed.
- Browser automation can type non-secret profile fields. For job-site
  password fields, the apply agent can call a local credential tool only when
  the active application origin exactly matches an independently configured
  trusted credential origin. The tool types the stored password into the
  focused field without returning the value to the model; without that
  enrollment, login fails closed.
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
- **CAPTCHA solving** — configure CapSolver only when you explicitly authorize
  sending a supported widget's site key and page URL during apply; the owned
  local tool keeps the solver key and returned token out of the model prompt.
- **Langfuse / OpenTelemetry** — metadata-only traces, only when you configure
  them: provider/model, operation/stage, outcome, token counts, and safe sizes,
  never raw prompts, job/profile/material text, or completions.

The apply prompt is the largest single batch of personal data that can leave.
Full per-call breakdown:
[Security → What Leaves Your Machine](https://jobctrl.dev/user/security#what-leaves-your-machine);
storage-and-privacy inventory:
[Data, Privacy & Safety](https://jobctrl.dev/user/data-and-safety).

## Current vs Roadmap

Everything in [What It Does](#what-it-does) above is **shipped and runs on
your machine today** through the installed distribution or a source build.
Workspace export/import and any hosted or multi-user deployment (accounts,
billing, hosted browsers, object storage, cloud sync) live in
[ROADMAP.md](ROADMAP.md). Nothing presented as current depends on a hosted
JobCtrl service.

## Local Data And Safety

By default, JobCtrl writes local data under `~/.jobctrl/`:

- `jobctrl.db` — local SQLite database with profile, jobs, discovery settings,
  events, projections, and artifact metadata.
- `temporal.db` — bundled-runtime Temporal persistence;
  `temporal/temporal.db` is the source-development equivalent. It is
  rollback-critical alongside `jobctrl.db`: a bundled release transition
  snapshots and restores the two databases as one verified pair, never as
  independent files. Source launchers likewise keep both stores under the same
  `JOBCTRL_DIR` so restarting from another worktree cannot split their runtime
  identity.
- `.env` — plaintext, cross-platform fallback for provider/API credentials; it
  is not encrypted at rest.
- `config.json` — non-secret runtime settings, including `dailyBudgetUsd`,
  apply controls, provider-scoped model IDs, compensation source policy, and
  browser capability choices. It never stores provider credentials or feed
  contents.
- `codex_home/` — the stable JobCtrl-owned Codex CLI home. Valid normal Codex
  CLI authentication may be imported once when its `auth.json` is absent. This
  stable authentication import never overwrites existing JobCtrl credentials
  or changes the normal Codex home. Prompt-driven reads are limited to
  `codex_home/workspace/`.
- `gmail/` — Gmail OAuth client and private refresh/access token state.
- `browser-profiles/`, `extension-capability-token`, `chrome-workers/`,
  `apply-workers/` — copied profiles, extension pairing, and browser/apply
  state. Browser capability choices live in `config.json`.
- `provider-packs/`, `provider-runtime/`, `claude_home/` — provider runtime
  packages and isolated provider state when those paths are used.
- `tailored_resumes/`, `cover_letters/`, `logs/` — generated artifacts and
  logs.
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

Anonymous discovery and enrichment fetch politely: each request runs through
one gateway that honors `robots.txt` — failing closed on an inconclusive fetch
(`5xx` or timeout) but failing open with a warning when the host has no
robots endpoint at all (DNS failure or refused connection) — paces each host,
bounds each run's request budget, and sends an honest `User-Agent`
(`JobCtrl/<version> (+<repo url>)`) that never impersonates a browser. Review
review or change that identity in **Discovery → Runtime**; the saved policy is
held in SQLite and `jobctrl doctor` prints the effective value. Direct targets,
redirects, and Playwright subrequests must also be public HTTP(S) destinations;
loopback, private, link-local, metadata-service, and file URLs are blocked
before content extraction or LLM enrichment. JobCtrl does not evade login,
paywall, CAPTCHA, rate-limit, or bot-control gates. The one explicit carve-out
is owner-authenticated LinkedIn recovery: after the capability is enabled and a
profile copy is separately consented, JobCtrl may use that existing session to
recover the full posting and inspect its application target without applying
the anonymous robots verdict. It records whether an external URL was recovered,
LinkedIn owns the application flow, the control or external target was missing,
navigation failed, or the target was unsafe. Missing an external URL does not
downgrade a readable posting or block Tailor. The recovery retains public-route
validation, pacing, request budgets, and audit history, and it cannot submit an
application.

### Back Up And Restore

Application records live in `jobctrl.db`. Snapshot them any time — even while
the app runs:

```bash
jobctrl backup
```

The command above is the canonical installed spelling. Source contributors can
invoke the same Python command through the checkout as described in
[Local Development](docs/local-development.md).

This writes `~/.jobctrl/backups/jobctrl-<timestamp>.db` via SQLite
`VACUUM INTO` and never deletes anything (`--output <path>` to choose a
target).

The native v7 update performs its own paired migration safeguard. For an
admitted v6 installation it stops and quiesces JobCtrl, backs up both
`jobctrl.db` and bundled Temporal state, builds and verifies the JobId-keyed v7
candidate in one transaction, then activates the verified pair. Any failed
build, verification, or activation restores the previous pair. The API and
worker run exact v7 only; there is no mixed-version, dual-write, or permanent
fallback runtime.

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
`temporal.db` as one hash-verified pair. Local development distribution
fixtures are never a production upgrade path.

</details>

## Normal Flow

1. Create or import a candidate profile.
2. Configure target roles, locations, work models, and application
   preferences. In Settings, opt into tokenless public Levels.fyi salary pages,
   a licensed Levels.fyi feed, or Glassdoor only when you have the matching
   permitted access.
3. Run Discover from Pipelines, optionally targeting one or more sources for a
   lighter run. Keep the same workspace open to distinguish the selected
   execution, its execution sweep, and unrelated global backlog while watching capacity,
   task-queue pressure, freshness, active work, and ETA. Stop the active run
   there when needed; after a failure, start over only when the runtime
   inventory confirms no work is still active.
4. Review jobs, scores, blockers, compensation evidence, and audit history.
5. Open Evidence from the main nav, Profile, or the Job Detail workspace to
   inspect which profile evidence backs generated materials and
   requirement-fit gaps.
6. Generate or inspect materials and Beta stored interview prep for promising
   jobs; review it carefully because output quality lacks real-user validation.
7. Use Apply Review's rich-text resume editor to edit text, formatting, and
   hyperlinks, review comments, and compare a rendered draft against the
   accepted artifact before approval. The desktop queue stays beside a
   full-width, top-to-bottom review flow; narrow screens move the queue above it
   and wrap decision actions without dropping evidence.
8. Run apply dry-runs before browser-form work. The model-driven browser cannot
   perform the final submit; live browser claims stop for manual completion.
   Apply Review approval can authorize the exact recipient and attachment for
   JobCtrl's owned Gmail sender. If you enable Auto apply, Runs shows the
   standing loop and its rehearsals, manual boundaries, or approved email sends.
9. Track progress in Dashboard, Pipelines, Analytics, Jobs, Runs, Artifacts,
   Evidence, Apply Review, and Debug; open their route-level detail
   workspaces when you need the complete timeline, payload, provenance, or
   comparison.

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

The command table omits the `jobctrl` prefix. The installed native executable
owns `jobctrl start` and dispatches every domain command as
`jobctrl <command>` from any directory. Curl and Homebrew do not create
different CLI surfaces. Source contributors can use
`uv --project workers/automation run jobctrl <command>` inside a checkout.

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
| `apply` | Start apply automation; utility modes: `--mark-applied`, `--mark-failed`, `--reset-failed`, inspection-only dry-run prompt generation with `--gen`, and `--continuous`. |
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

Configuration comes from SQLite-backed profile/discovery stores,
`config.json` Settings values, credential environment variables
(`~/.jobctrl/.env`, repo `.env`, or the shell), and package-shipped source
registries. Compensation-source policy is managed from Settings and stored
locally; it is not a feed connection. Start with [.env.example](.env.example); full reference:
[Configuration](https://jobctrl.dev/user/configuration).

The web app centralizes launch configuration across **Settings → General**
(spend, capacity, scoring, apply runtime), **Credentials**, **Model selection**
(provider preference and AI execution policy), and **Browser & extension**.
Discovery owns its target, runtime, automation, source, and schedule controls
in SQLite. Settings owns every non-secret Settings value in `config.json`.
Saved changes are labeled as live, next poll/run/workflow, or restart-required;
worker activity slots show desired versus active values.

Providers that accept environment credentials can use the plaintext
`~/.jobctrl/.env` file or the process environment. On macOS, **Settings →
Credentials** guides one of three providers: an authenticated Codex CLI,
Claude Agent SDK (Anthropic API key or supported cloud-provider credentials),
or Google (Gemini key or Vertex AI ADC). One ready provider is sufficient for
all core AI stages; a second provider is optional. After a provider is ready,
Settings can save a preferred model for that provider. Codex, Claude, and Google
choices come from the live catalog exposed by the authenticated provider
runtime; JobCtrl does not maintain a hand-written model list. A saved model never
selects another provider. New adapters resolve models in this order: an
explicit non-default workflow model, the saved model for the selected ready
provider, then that provider's default. Secret values managed by the
panel are stored in the system Keychain, while AWS, Google, and Azure credential
files remain owned by their vendor CLIs. At Python process startup, a non-empty
environment value takes precedence over the corresponding Keychain entry.
Claude, Google, and CapSolver Keychain edits are not hot-reloaded by Python, so
restart the relevant process after saving or removing one. Preferred models,
browser capabilities, and extension pairing do not require that restart.
Native Windows Credential Manager and Linux Secret
Service/keyring adapters are planned, not shipped; use `.env` or the shell on
those platforms today. The macOS panel
distinguishes **not configured** from **status unknown**: an unknown
(`inspection_failed`) result means Keychain could not be inspected, not that the
entry is absent. Unlock Keychain if it is locked, then retry; operational
save/remove failures return a generic unavailable message rather than raw
Keychain output.

<details>
<summary><b>Common variables</b></summary>

- `JOBCTRL_DIR` — override the local app directory.
- `ANTHROPIC_API_KEY` or a supported Claude cloud-provider route — Claude.
- `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or Vertex AI ADC — Google.
- `VITE_GOOGLE_MAPS_API_KEY` — optional address search in the Profile form.
- `PLAYWRIGHT_SKIP_BROWSER_GC=1` — keep other worktrees' Playwright browsers
  when running `playwright install` from this checkout.
- `JOBCTRL_SKIP_BROWSER_PREFLIGHT=1` — skip the worker's startup Chromium
  check (workers running only non-browser activities).
- `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` —
  optional OpenTelemetry/Langfuse export; `LANGFUSE_DISABLE=1` opts out.

</details>

Discovery scheduling is stored in SQLite through
`GET/PATCH /v1/discovery/settings`: `scheduling_enabled` defaults to
`false`; `schedule_cron` defaults to `0 7 * * *` and only runs after you
enable it. LLM spend is tracked locally; its `dailyBudgetUsd` ceiling is stored
in `config.json`, defaults to `25`
(`0` = unlimited), spendful workflows run a budget preflight, and the health
surface shows today's estimated spend.

Optional system-browser capabilities and extension pairing are also available
from **Settings → Browser & extension**. JobCtrl can list supported local
Chrome/Chromium installations by label, but detection is read-only: it does not
launch, enable, or persist a browser. Choosing a detected browser and clicking
Enable explicitly adopts it; an advanced manual executable path remains
available. For authenticated LinkedIn, JobCtrl can also detect a standard local
default profile and copy it by browser label after separate affirmative consent;
no filesystem path entry is required. That detected flow copies only the
`Default` profile plus sanitized root metadata needed by Chrome; sibling
profiles are excluded. A write-only manual profile path remains an advanced
fallback. Browser enable/disable and pairing-token rotation are live, and
extension pairing remains separate from browser adoption.

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
