# Getting Started

This guide gets JobHunter running locally with a disposable or personal local
workspace. JobHunter is local-first: your profile, jobs, artifacts, logs, and
browser state stay on your machine unless you explicitly configure external
providers.

## 1. Install Requirements

Install these tools first:

- Python 3.11 or newer
- Node.js 20.19 or newer
- pnpm through Corepack
- uv
- Temporal CLI with `temporal server start-dev`
- Chrome or Chromium
- Playwright Chromium for HTML/CSS PDF rendering
- Poppler with `pdftoppm` on `PATH` for PDF page previews

Optional:

- TeX / `pdflatex` only when using `JOBHUNTER_RESUME_RENDERER=latex_pdf`
- Google Maps API key for address autocomplete in Profile
- Gmail OAuth Desktop client for read-only verification-code and outcome scans
- CAPTCHA solving key for auto-apply workflows that explicitly opt into it

## 2. Install Dependencies

```bash
git clone https://github.com/ebarti/JobHunter.git
cd JobHunter
pnpm install:interactive
```

`pnpm install:interactive` is the guided first-run installer. It checks
machine-level tools, offers Homebrew installs when available, installs the Node
workspace dependencies with the lockfile, syncs the uv-managed Python worker
environment, and installs the Playwright Chromium browsers used by web tests and
Python PDF/rendering paths.

If your machine already has the system tools and browser dependencies, this
non-interactive command is enough to sync the Node and Python dependencies:

```bash
pnpm dev:setup
```

If Playwright Chromium is missing:

```bash
uv --project workers/automation run playwright install chromium
```

## 3. Create Local Configuration

```bash
uv --project workers/automation run jobhunter init
uv --project workers/automation run jobhunter doctor
```

`jobhunter init` creates local configuration under `~/.jobhunter/`.
`jobhunter doctor` reports which feature tiers are available: local database,
LLM provider, Temporal, browser automation, Gmail connector, and telemetry.

At minimum, configure one LLM access path:

```bash
cp .env.example ~/.jobhunter/.env
```

Then edit `~/.jobhunter/.env` and set one of:

- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `LLM_URL`

## 4. Start The App

```bash
pnpm dev
```

The launcher starts:

- Temporal dev server
- local TypeScript API
- React/Vite web app
- JobHunter Python worker

Keep the terminal open while using the app. The launcher prints the web URL; it
normally uses `http://127.0.0.1:5173/`, but Vite can move to another port when
5173 is busy.

Opening the printed URL lands on the operations dashboard.

![JobHunter dashboard showing pipeline progress, job counts, and apply runs](../assets/screenshots/dashboard.png)
*The dashboard summarizes pipeline progress, job counts, source health, and recent apply runs.*

Inspect the stack from another terminal:

```bash
pnpm dev:status
pnpm dev:logs worker
```

Stop the foreground stack with Ctrl-C.

## 5. Use A Disposable Workspace For QA

Use this when testing destructive flows, taking screenshots, or sharing bug
reports:

```bash
pnpm qa:seed -- /tmp/jobhunter-qa
JOBHUNTER_DIR=/tmp/jobhunter-qa pnpm dev
```

The seed uses synthetic profile, job, score, materials, and worker-heartbeat
data. It must not be mixed with your real `~/.jobhunter` workspace.

## 6. First Useful Checks

```bash
uv --project workers/automation run jobhunter status
uv --project workers/automation run jobhunter runs
curl http://127.0.0.1:8766/v1/health
```

If the UI shows the worker as missing or stale, check `pnpm dev:status` and the
worker logs before starting pipeline stages.
