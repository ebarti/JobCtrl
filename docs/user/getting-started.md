---
pageClass: jh-user-guide-page
---

# Getting Started

JobCtrl runs entirely on your own computer. This guide takes you from an
empty machine to the app open in your browser. The app runs from a source
checkout you own, but you do not have to assemble it by hand: a **one-line
bootstrap** (or the **Homebrew launcher**) clones it and walks you through a
guided install. It is local-first: your data stays on your machine unless you
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

## 1. Install Requirements

JobCtrl builds on a handful of standard developer tools. Installing them is
the bulk of the setup — expect roughly 15–30 minutes end to end, mostly
downloads. Each line says what the tool is for.

- **Python 3.11 or newer** — the language the Python worker is written in.
- **Node.js 20.19 or newer** — the JavaScript runtime behind the TypeScript API
  and the web app.
- **pnpm, via Corepack** — installs the project's JavaScript dependencies.
  Corepack ships with Node, so there is nothing extra to install.
- **uv** — a fast installer and environment manager for Python.
- **Temporal CLI** — runs a local Temporal (the workflow engine) with
  `temporal server start-dev`.
- **Chrome or Chromium** — the browser JobCtrl automates and uses to render
  PDFs.
- **Playwright Chromium** — a browser build that Playwright controls to turn
  tailored resumes into PDFs.
- **Poppler** (with `pdftoppm` on your `PATH`) — turns PDF pages into the
  preview images shown in the app.

::: details Optional tools — skip these on a first install
- **TeX / `pdflatex`** — only if you switch the resume renderer to
  `JOBCTRL_RESUME_RENDERER=latex_pdf`.
- **Google Maps API key** — enables address autocomplete in the Profile form.
- **Gmail OAuth Desktop client** — enables read-only scans for verification
  codes and application outcomes.
- **CAPTCHA-solving key** — only for auto-apply runs that explicitly opt into it.
:::

## 2. Install Dependencies

The fastest path is the bootstrap script — it clones the repository to
`~/JobCtrl` (override with `JOBCTRL_HOME` or `--dir`) and runs the same
guided installer described below:

```bash
curl -fsSL https://raw.githubusercontent.com/ebarti/JobCtrl/main/scripts/get | bash
```

Homebrew users can install the toolchain plus a global `jobctrl` launcher
instead, then bootstrap through it:

```bash
brew install ebarti/tap/jobctrl
jobctrl bootstrap
```

The launcher proxies every CLI command (`jobctrl doctor`, `jobctrl dev`, …)
into the checkout, so you can skip the long `uv --project …` prefixes shown
in this guide. The tap is published together with the first public release;
from an existing checkout, `brew install --formula
packaging/homebrew/Formula/jobctrl.rb --HEAD` installs the same launcher.

Or do the same steps by hand:

```bash
git clone https://github.com/ebarti/JobCtrl.git
cd JobCtrl
pnpm install:interactive
```

Downloads the project and runs the guided first-run installer: it checks your
system tools, installs the JavaScript and Python dependencies, and downloads the
Playwright Chromium browser. It also runs `jobctrl setup`, which detects
Claude/Codex/Antigravity auth and persists any intentionally enabled or skipped
analysis legs. Expect a few minutes on the first run.

If your machine already has the system tools and browsers, this non-interactive
command is enough:

```bash
pnpm dev:setup
```

Syncs the JavaScript and Python dependencies without the guided system checks.

If Playwright Chromium is missing:

```bash
uv --project workers/automation run playwright install chromium
```

Downloads the Chromium build that Playwright uses for PDF rendering.

## 3. Create Local Configuration

```bash
uv --project workers/automation run jobctrl init
uv --project workers/automation run jobctrl setup
uv --project workers/automation run jobctrl doctor
```

The first command creates your local workspace and configuration under
`~/.jobctrl/`. The second checks your setup and reports which features are
available: local database, LLM provider, Temporal, browser automation, the
Gmail connector, and telemetry.

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

## 4. Start The App

```bash
pnpm dev
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
pnpm dev:status
pnpm dev:logs worker
```

The first lists the running services and their health; the second streams the
Python worker's logs. Stop the whole stack with Ctrl-C in the terminal running
`pnpm dev`.

### Optional Browser Extension

To save a job directly from the current browser tab, build the local extension:

```bash
pnpm extension:build
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
pnpm qa:seed -- /tmp/jobctrl-qa
JOBCTRL_DIR=/tmp/jobctrl-qa pnpm dev
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
uv --project workers/automation run jobctrl status
uv --project workers/automation run jobctrl runs
curl http://127.0.0.1:8766/v1/health
```

The first prints a status summary; the second lists recent workflow runs; the
third asks the TypeScript API whether it is healthy and reports today's
estimated LLM spend against your budget.

If the app shows the worker as missing or stale, check `pnpm dev:status` and the
worker logs before starting any pipeline stage. When you are ready to run the
pipeline, [Daily Workflow](normal-flows.md) walks through the daily loop.
