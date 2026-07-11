---
pageClass: jh-user-guide-page
---

# Getting Started

JobCtrl runs entirely on your own computer. The current guide begins with Git
already available, then takes you from a new source checkout to the app open in
your browser. It is not yet a literal empty-machine bootstrap: `scripts/install`
cannot run until after `git clone`. A bundled implementation exists, but no
signed and notarized public artifact or stable Homebrew formula has been
published yet. It is local-first: your data stays on your machine unless you
explicitly configure an external provider.

::: tip Want to see the product first?
The [Product Tour](screenshots.md) walks through every screen with captioned,
zoomable screenshots — no install required.
:::

## What You'll Have When You're Done

- JobCtrl running locally, open in your browser at a local web address.
- A local workspace under `~/.jobctrl/` holding your database, settings, and
  generated files.
- At least one LLM (large language model) provider connected for scoring and
  materials, plus vendor auth for any enabled employer-analysis ensemble legs.
- The commands to start, check, and stop the app whenever you need it.

::: warning Current source path versus the installed command contract
The commands on this page run JobCtrl from a source checkout because that is
the only public path today. Git, Node, Corepack/pnpm, uv, Python, Temporal,
Playwright browsers, and checkout-relative commands are source-development
concerns.

Once the first signed bundled release is published, both curl and Homebrew will
acquire the same runtime and the same native `jobctrl` executable. Every
installed user will run `jobctrl start` from any directory and use that same
binary for `jobctrl init`, `jobctrl doctor`, and all other domain commands.
There will be no install-method-specific start command and no source clone.
The first bundle targets Apple-silicon macOS 15 or newer.
:::

## 1. Source-Checkout Requirements

These are requirements for building and running the repository, not for the
future bundled product. Installing them is the bulk of source setup — expect
roughly 15–30 minutes end to end, mostly downloads.

- **Git** — downloads and updates the source checkout. JobCtrl's application
  runtime does not use Git; the requirement exists only because the current
  public setup starts with `git clone`. Install Git yourself before following
  this guide.
- **Python 3.11 or newer** — the language the Python worker is written in.
- **Node.js 20.19 or newer** — the JavaScript runtime behind the TypeScript API
  and the web app.
- **pnpm, via Corepack** — installs the project's JavaScript dependencies.
  Some current Node distributions, including Homebrew Node, do not bundle
  Corepack; the guided installer can offer `brew install corepack` when needed.
- **uv** — a fast installer and environment manager for Python.
- **Temporal CLI** — runs a local Temporal (the workflow engine) with
  `temporal server start-dev`.
- **Two Playwright Chromium installs** — the source workspace currently keeps
  one for web/E2E development and one for the Python worker's discovery and
  tailored-resume PDF rendering.
- **Chrome or Chromium** (optional) — adopt one explicitly only if you enable
  authenticated apply capabilities; it is not required for core setup.

::: details Optional tools — skip these on a first install
- **Google Maps API key** — enables address autocomplete in the Profile form.
- **Gmail OAuth Desktop client** — enables bounded verification-code and
  application-outcome lookups plus approval-bound application sends.
- **CAPTCHA-solving key** — only for auto-apply runs that explicitly opt into it.
:::

The source dependency audit currently records 83 unique direct JavaScript
packages, 1,428 pnpm lock records, and 103 uv lock records. A simple sum of the
preserved 2026-07-10 planning observations is about 4.28 GiB with system Chrome
skipped, or 5.58 GiB with the separately optional 1.3 GiB Chrome from that
reference machine included. `scripts/install` never installs system Chrome.
The observations include the whole 1.18 GiB reference-machine Homebrew closure
and mix accounting contexts, so they are directional—not a reproducible
additive install size or the production bundle size.

The tracked bundle inventory instead declares 15 core runtime components, one
bundled optional-capability adapter, three provider packs fetched only from
their official channels when selected, and two developer-only components
excluded from the artifact. The core carries the API/web/worker, Node, Python,
Temporal, PDF.js, Python Playwright, Playwright MCP, and one Playwright Chromium
headless shell—not a full Chrome/Chromium app. There is no public bundle-size
claim until the first signed artifact publishes its per-component size report.

## 2. Prepare The Source Checkout

Clone the repository and run the guided installer:

```bash
git clone https://github.com/ebarti/JobCtrl.git
cd JobCtrl
scripts/install
```

The guided first-run installer checks your system tools, installs the JavaScript
and Python dependencies, and downloads both source-development Playwright
Chromium builds. It also runs `jobctrl setup`,
which detects Claude/Codex/Antigravity auth and persists any intentionally
enabled or skipped analysis legs. Expect a few minutes on the first run.
It can offer missing machine tools through Homebrew only when Homebrew is
already installed; otherwise it reports what you must install yourself.

If your machine already has the system tools and browsers, this non-interactive
command is enough:

```bash
corepack pnpm dev:setup
```

Syncs the JavaScript and Python dependencies without the guided system checks.

If Playwright Chromium is missing:

```bash
uv --project workers/automation run playwright install chromium
```

Downloads the Chromium build that Playwright uses for PDF rendering.

## 3. Optionally Initialize The Source CLI {#source-cli}

Most users can start with the local web app; it does not require
`jobctrl init`. A dedicated welcome/onboarding flow can make profile and search
setup smoother later, but initialization is not a prerequisite for opening the
web experience.

Use the CLI initialization path only when you want to drive JobCtrl through
terminal commands such as `jobctrl run`, `jobctrl discover`, or `jobctrl job`:

```bash
uv --project workers/automation run jobctrl init
uv --project workers/automation run jobctrl doctor
```

The `uv --project workers/automation run` prefix tells uv to sync the Python
environment owned by this checkout when needed, select it, and run its
`jobctrl` console entry point. It is not a second CLI. An installed bundled
release drops that source-only prefix because the native `jobctrl` executable
dispatches the same commands through its private Python runtime.

`jobctrl init` creates your local CLI workspace, profile, resume, and search
configuration under `~/.jobctrl/`. `jobctrl doctor` checks which features are
available: local database, LLM provider, Temporal, browser automation, the Gmail
connector, approval-gate posture, broad-board/CAPTCHA warnings, application
attestations, and telemetry. The installer already ran `jobctrl setup`; rerun it
later only when vendor auth or analysis-leg choices change.

At minimum, connect one general LLM provider. Start from the example file:

```bash
cp .env.example ~/.jobctrl/.env
```

Copies the example environment file into your local workspace so you can fill in
your own keys.

Then open `~/.jobctrl/.env` in any editor and set one of:

- `GEMINI_API_KEY` — a Google Gemini key.
- `OPENAI_API_KEY` — an OpenAI key.
- `LLM_URL` — the address of a local, OpenAI-compatible model server.

The employer-analysis ensemble is checked separately by `jobctrl setup` and
`jobctrl doctor`:

- Claude uses `ANTHROPIC_API_KEY` or local Claude credentials
  (`CLAUDE_CODE_OAUTH_TOKEN` / existing Claude login) as a local convenience.
- Codex needs persisted `CODEX_HOME/auth.json`; a bare `OPENAI_API_KEY` must be
  enrolled with `codex login --with-api-key` before that leg is ready.
- Antigravity uses `GEMINI_API_KEY`, `GOOGLE_API_KEY`, or Vertex ADC env.

Every run reconciles the ensemble with a Claude synthesis pass, so Claude auth is
required even if you disable the `claude` leg via `JOBCTRL_ANALYSIS_LEGS`. When
it is missing, `setup` reports analysis as not ready and `doctor` shows a red
`Claude synthesis auth` row.

See [Configuration](configuration.md) for the full list of settings.

## 4. Start The Source Stack

```bash
corepack pnpm dev
```

Starts everything and keeps it running in the foreground. The launcher starts:

- **Temporal** (the workflow engine) — keeps each pipeline stage running
  reliably.
- **the TypeScript API** — the local service the web app talks to.
- **the web app** — the page you open in your browser to use JobCtrl.
- **the Python worker** — a Temporal worker process that does the actual
  pipeline work.

Keep the terminal open while you use the app. The launcher prints the web
address; it is normally `http://127.0.0.1:5173/`, but Vite may pick another port
if 5173 is busy. Opening that address lands you on the dashboard.

![JobCtrl dashboard showing pipeline progress, job counts, and apply runs](../assets/screenshots/dashboard.png)
*The dashboard summarizes pipeline progress, job counts, source health, and recent apply runs.*

To watch the stack from a second terminal:

```bash
corepack pnpm dev:status
corepack pnpm dev:logs worker
```

The first lists the running services and their health; the second streams the
Python worker's logs. Stop the whole stack with Ctrl-C in the terminal running
`corepack pnpm dev`.

### Optional Browser Extension

To save a job directly from the current browser tab, build the local extension:

```bash
corepack pnpm extension:build
```

Then load `dist/extension/` as an unpacked Chrome/Chromium extension, open
JobCtrl Settings, copy the browser-extension pairing token into the extension
popup, and click **Save job** on an http(s) job page. On supported ATS
application pages, **Review autofill** opens deterministic profile-backed
suggestions that you accept before fields are filled. The extension talks only
to the local API. It cannot submit applications.

## 5. Use A Disposable Workspace For Testing

Use a throwaway workspace when testing risky flows, taking screenshots, or
preparing a bug report — never your real `~/.jobctrl` data.

```bash
corepack pnpm qa:seed /tmp/jobctrl-qa
JOBCTRL_DIR=/tmp/jobctrl-qa corepack pnpm dev
```

The first command fills a separate folder with synthetic profile, job, score,
materials, and worker data. The second starts the app pointed at that folder
instead of your real one.

::: warning
The seeded workspace is synthetic and safe to share. Keep it separate from your
real `~/.jobctrl` workspace so real data never mixes in.
:::

## 6. First Useful Checks

```bash
uv --project workers/automation run jobctrl pipeline-status
uv --project workers/automation run jobctrl runs
curl http://127.0.0.1:8766/v1/health
```

The first prints a status summary; the second lists recent workflow runs; the
third asks the TypeScript API whether it is healthy and reports today's
estimated LLM spend against your budget.

If the app shows the worker as missing or stale, check
`corepack pnpm dev:status` and the worker logs before starting any pipeline
stage. When you are ready to run the pipeline,
[Daily Workflow](normal-flows.md) walks through the daily loop.
