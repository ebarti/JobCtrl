---
pageClass: jh-user-guide-page
---

# Configuration

Most people never need this page. JobHunter ships with working defaults, and the
Discovery targets and preferences you set in the web app cover day-to-day use.
The two settings worth knowing first are an **LLM provider key** (required before
scoring or materials can run) and the **daily LLM spend budget** (which caps
cost). Employer-analysis also has per-vendor auth checks because it runs a
Claude + Codex + Antigravity ensemble; `jobhunter setup` and `jobhunter doctor`
report those separately.

JobHunter configuration is intentionally local. Some settings live in the local
SQLite database, set through the web app; secrets and runtime switches are read
from environment variables. Everything here is optional unless a feature you want
depends on it.

## Configuration Sources

| Source | Purpose |
| --- | --- |
| `~/.jobhunter/jobhunter.db` | Candidate profile, discovery settings, preferences, tailoring controls, jobs, events, projections, and artifact metadata. |
| `~/.jobhunter/.env` | Personal provider keys and runtime environment. |
| repo `.env` | Development-only overrides for the current checkout. |
| shell environment | One-off overrides for commands and CI. |
| `workers/automation/src/jobhunter/config/*.yaml` | Packaged employer and site behavior registries (`employers.yaml`, `sites.yaml`). The dynamic source registry lives in SQLite. |

The development launcher loads `~/.jobhunter/.env`, repo `.env`, and the optional
`JOBHUNTER_USER_ENV_PATH` file before starting local services.

## Candidate Profile Application Fields

`profile.example.json` includes an `application_attestations` block for legal
or screening questions that apply automation is not allowed to infer:

- `age_18_plus`
- `background_check_consent`
- `felony_conviction`
- `previously_worked_at_employer`

Use `true` or `false` only when the answer is explicitly true or false for you.
Leave unknown answers as `null`; live apply automation fails with
`missing_profile_data:<field>` instead of guessing. `jobhunter doctor` warns
when required attestations are incomplete, and Apply Review surfaces the same
missing fields before approval when the local profile row has unknown values.

The profile also supports `application_preferences.how_heard` for common
"How did you hear about us?" questions. It is a preference, not a legal
attestation; leave it empty when there is no truthful answer.

## Core Runtime

| Variable | Default | What it does |
| --- | --- | --- |
| `JOBHUNTER_DIR` | `~/.jobhunter` | Local app directory for database, settings, artifacts, logs, browser worker state, and `.env`. |
| `JOBHUNTER_DB_PATH` | `$JOBHUNTER_DIR/jobhunter.db` | TypeScript API database path. The Python worker ignores it and always uses `$JOBHUNTER_DIR/jobhunter.db`, so overriding it desynchronizes the API from the worker — prefer `JOBHUNTER_DIR` to move both. |
| `JOBHUNTER_DASHBOARD_CONFIG_PATH` | `$JOBHUNTER_DIR/dashboard.json` | Settings file read and written by the TypeScript API (preferences, apply approval gate, spend budget). |
| `JOBHUNTER_API_HOST` | `127.0.0.1` | Local API bind host. Non-loopback hosts require explicit opt-in. |
| `JOBHUNTER_API_PORT` / `PORT` | `8766` | Local API port. |
| `JOBHUNTER_API_ALLOW_REMOTE_BIND` | unset | Set to `1`, `true`, or `yes` to allow non-loopback API binding. This can expose private local data. |
| `JOBHUNTER_WEB_PORT` | `5173` | Requested Vite development port. |
| `VITE_JOBHUNTER_API_BASE_URL` | proxied `/v1` | Browser API origin when not using the default Vite proxy. |
| `JOBHUNTER_TEMPORAL_DB` | `.dev/temporal/temporal.db` | Temporal (the workflow engine) dev-server SQLite history store. |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server address used by the worker, CLI, and workflow-starting RPC. |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace. |
| `JOBHUNTER_MAX_CONCURRENT_ACTIVITIES` | `4` | Maximum Temporal activities the local worker runs at once (shown on the Settings page). Set in the worker environment and restart the worker to apply. |
| `JOBHUNTER_API_SSE_POLL_MS` | `250` | API event-stream database poll interval in milliseconds. |
| `VITE_DEV_API_PROXY_TARGET` | `http://127.0.0.1:8766` | Vite dev-server `/v1` proxy target; override it for isolated or multi-worktree stacks. |
| `VITE_GOOGLE_MAPS_API_KEY` | unset | Enables Google Maps address search in the Profile form. |

## LLM Providers

| Variable | What it does |
| --- | --- |
| `GEMINI_API_KEY` | Enables Gemini-backed scoring/materials and the Antigravity/Gemini analysis leg. |
| `OPENAI_API_KEY` | Enables OpenAI-backed scoring/materials. For the Codex analysis leg, enroll this into `CODEX_HOME/auth.json`; a bare env key is not enough. |
| `LLM_URL` | Enables a local OpenAI-compatible HTTP endpoint. |
| `LLM_API_KEY` | Optional bearer token for the `LLM_URL` endpoint. |
| `GOOGLE_API_KEY` | Fallback for the Antigravity/Gemini analysis leg when `GEMINI_API_KEY` is unset. |
| `LLM_MODEL` | Overrides the provider default model. |

The pipeline default model spec is currently `gemini:gemini-3.5-flash` unless a
stage or UI control overrides it.

## Employer-Analysis Ensemble

Run this after first install or whenever vendor auth changes:

```bash
uv --project workers/automation run jobhunter setup
uv --project workers/automation run jobhunter doctor
```

The ensemble legs use vendor SDK runtimes pinned in the Python environment. The
setup command detects auth before prompting and writes only local `.env`
configuration; it never commits or ships credentials.

Every employer-analysis run reconciles its legs with a Claude Agent SDK
synthesis pass, so Claude auth (`ANTHROPIC_API_KEY` or local Claude credentials)
is required even when you disable the `claude` leg via `JOBHUNTER_ANALYSIS_LEGS`.
`jobhunter setup` warns that analysis is not ready when synthesis auth is
missing, and `jobhunter doctor` reports a dedicated `Claude synthesis auth` row
that stays red until Claude auth is present.

| Variable | What it does |
| --- | --- |
| `JOBHUNTER_ANALYSIS_LEGS` | Comma-separated enabled legs: `claude,codex,antigravity` by default. Setup writes this when you intentionally skip an unauthenticated leg so runs do not burn retries. Disabling the `claude` leg does **not** remove the Claude synthesis-auth requirement above. |
| `ANTHROPIC_API_KEY` | Supported Claude Agent SDK auth path. |
| `ANTHROPIC_AUTH_TOKEN` | Alternate Claude auth token path. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Local/dev Claude subscription convenience. The distributed product path remains API/provider auth. |
| `CLAUDE_CONFIG_DIR` | Overrides the local Claude credential directory checked for `.credentials.json`. |
| `CODEX_HOME` | Codex home containing `auth.json`. Defaults to `~/.codex`; the JobHunter adapter copies this auth into isolated `~/.jobhunter/codex_home`. |
| `JOBHUNTER_CODEX_BIN` | Explicit Codex runtime override. The default is the pinned `openai-codex-cli-bin` bundled binary. |
| `GOOGLE_GENAI_USE_VERTEXAI` | Set to `1` to allow the Antigravity leg to use Vertex AI ADC instead of an API key. |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_PROJECT_ID` / `GCLOUD_PROJECT` | Project used with Vertex AI ADC. |
| `GOOGLE_CLOUD_LOCATION` / `GOOGLE_VERTEX_LOCATION` | Optional Vertex location for Antigravity. |

Codex auth is the common gotcha: `OPENAI_API_KEY` and `CODEX_API_KEY` can feed
other surfaces, but the Codex SDK app-server path used by JobHunter needs
persisted `auth.json`. Enroll a key with:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

or run the Codex device login locally, then rerun `jobhunter setup`.

## LLM Spend Budget

The daily LLM budget is a preference stored in SQLite (`dailyBudgetUsd`,
default `25`; `0` means unlimited). Workflows that spend LLM tokens run a
budget preflight before their heavy activities and stop with a non-retryable
budget error once the estimated daily spend reaches the ceiling.
`GET /v1/health` reports today's estimated spend against the configured
budget, and the Preferences form edits the value.

## Discovery

| Variable | Default | What it does |
| --- | --- | --- |
| `JOBHUNTER_DISCOVERY_LLM_ROLE_FILTER` | `auto` | Uses an LLM to adjudicate loose role-title matches when an LLM provider is configured. Set `0` to force deterministic matching only. |
| `JOBHUNTER_DISCOVERY_ROLE_FILTER_MODEL` | configured LLM model | Optional model spec for discovery role adjudication. |
| `JOBHUNTER_MAX_PARALLEL_DISCOVERY_FAMILIES` | `1` | How many discovery source families (`jobspy`, `ats_api`, `workday`, `smartextract`) crawl at once. `1` (default) keeps families sequential — the safe, isolated behavior. Values `> 1` run that many source crawls concurrently to cut total discovery wall-clock; enrichment still runs once per batch (never concurrently). Read at run start and applied for the whole run; change it in the worker environment and restart the worker. **Tune conservatively:** each concurrent family may launch its own headless browser, so keep this ≤ `JOBHUNTER_MAX_CONCURRENT_ACTIVITIES` and mind memory (~roughly 300–600 MB per Chromium). Uncontrolled browser concurrency has historically destabilized long runs — see [Concurrency & Fan-out](../architecture/pipeline/concurrency.md) for the worker-capacity analysis before raising it. |

Discovery target roles, locations, seniority, work models, source controls, and
automation preferences are normally edited in the Discovery page and stored in
SQLite. A scraping proxy, when needed, is part of those SQLite discovery
settings (`host:port:user:pass` form); there is no `PROXY` environment
variable.

![JobHunter Discovery page with target search, seniority floors, job boards, and source registry](../assets/screenshots/discovery.png)
*Target roles, locations, seniority floors, work models, and source controls are edited on the Discovery page and stored in SQLite.*

Discovery scheduling is also a SQLite-backed setting: `scheduling_enabled`
defaults to `false`, `schedule_cron` defaults to `0 7 * * *`, and worker
startup reconciles the local Temporal schedule — creating it (with `SKIP`
overlap semantics) when enabled and deleting it when disabled.

## Crawl Politeness

Every discovery/enrichment fetch routes through one politeness gateway
(`robots.txt` + per-host rate limit + per-run budget + honest user-agent). The
defaults are conservative and fail-closed and need no configuration; the one
knob you should review before real crawls is the **outbound user-agent**.

| Variable | Default | What it does |
| --- | --- | --- |
| `JOBHUNTER_CRAWL_UA_PRODUCT` | `JobHunter` | Product token in the outbound `User-Agent`. |
| `JOBHUNTER_CRAWL_UA_CONTACT` | project repo URL | Contact appended as `(+<contact>)`. Set it **empty** to drop the suffix. |

The effective identity is `<product>/<version> (+<contact>)` — for example
`JobHunter/0.3 (+https://github.com/ebarti/JobHunter)`. It **never impersonates
a browser**. The built-in default points at the public project repository, not
any personal identity; **owners should review it (and set a contact they own)
before crawling real sites** — `jobhunter doctor` prints the effective value.

The remaining defaults are not env-tunable and live where the rest of discovery
policy lives, so per-source overrides ride the existing registry rather than a
parallel config surface:

- **Per-host rate/concurrency + per-run request budget** are fields on each
  source's `SourcePolicy` (`domain/discovery/source_registry.py`), with
  conservative fail-closed values (robots honored for page rendering, a non-zero
  min-interval, a concurrency of one, a finite run budget). Per-source overrides
  ride the existing `SourceRegistryEntry` rows; a registry policy editor is a
  planned addition, not yet in the UI.
- **Broad boards** (`indeed`, `linkedin`, `glassdoor`, `zip_recruiter`) are
  fetched by `python-jobspy`, which owns its own transport — JobHunter cannot
  robots-gate or count its per-board requests, so it applies budget + pacing at
  the invocation boundary only, and `jobhunter doctor` warns when they are on.
- A malformed `proxy` value (the SQLite discovery setting, `host:port[:user:pass]`)
  now **fails loud** rather than silently degrading to a direct connection, so a
  crawl never quietly runs without the proxy you intended.

## Materials And Resume Rendering

| Variable | Default | What it does |
| --- | --- | --- |
| `TAILORING_GENERATOR_MODELS` | provider default | Comma-separated generator model specs for resume tailoring. |
| `TAILORING_JUDGE_MODEL` | provider default | Optional separate model spec for the structured tailoring judge. |
| `TAILORING_JUDGE_MIN_SCORE` | `0.82` | Minimum judge score for auto-approval. |
| `TAILOR_LLM_MODELS` | alias | Backward-compatible alias for `TAILORING_GENERATOR_MODELS`. |
| `TAILOR_JUDGE_MODEL` | alias | Backward-compatible alias for `TAILORING_JUDGE_MODEL`. |
| `TAILOR_JUDGE_MIN_SCORE` | alias | Backward-compatible alias for `TAILORING_JUDGE_MIN_SCORE`. |
| `JOBHUNTER_RESUME_RENDERER` | `html_pdf` | Set to `latex_pdf` only for the LaTeX resume compatibility renderer. |
| `PDFLATEX_PATH` | auto-detected | Override `pdflatex` location when using the LaTeX compatibility renderer. |

The default resume renderer is HTML/CSS printed through Playwright. Apply Review
loads the generated HTML source so edits, comments, validation, final PDF
rendering, and layout boxes stay tied to the same material generation.

## Browser Apply Automation

| Variable | Default | What it does |
| --- | --- | --- |
| `CHROME_PATH` | auto-detected | Chrome/Chromium executable path. |
| `JOBHUNTER_CLAUDE_BIN` | unset | Explicit apply-agent Claude runtime override. By default apply uses a system `claude` when present, then the pinned Claude Agent SDK bundled binary. |
| `JOBHUNTER_APPLY_TIMEOUT_SECONDS` | `900` | Per-job autonomous apply timeout. |
| `CAPSOLVER_API_KEY` | unset | Optional key used only by the owned local `solve_captcha` apply tool for supported widgets. Provider keys and solver tokens are not sent through the model prompt; unsupported or unconfigured CAPTCHA flows fail closed. |
| `JOBHUNTER_LINKEDIN_APPLY_RESOLVER` | enabled | Set to `0` to disable authenticated LinkedIn outbound apply URL resolution. |
| `JOBHUNTER_LINKEDIN_APPLY_PROFILE_DIR` | `~/.jobhunter/chrome-workers/linkedin-apply-url-resolver` | Dedicated Chrome profile for LinkedIn apply URL resolution. |
| `JOBHUNTER_LINKEDIN_APPLY_SOURCE_PROFILE_DIR` | platform Chrome profile dir | Optional source profile copied into the resolver profile on first use. |
| `JOBHUNTER_LINKEDIN_APPLY_CHROME_PROFILE` | browser default | Chrome profile name inside the resolver user-data directory. |
| `JOBHUNTER_LINKEDIN_APPLY_HEADLESS` | visible Chrome | Set to `1` to run the resolver headless. |

Apply automation can submit applications. Use dry runs and narrow targets before
approving real submission.

## Gmail Connector

| Variable | Default | What it does |
| --- | --- | --- |
| `JOBHUNTER_GMAIL_DIR` | `~/.jobhunter/gmail` | First-party Gmail connector auth directory. |
| `JOBHUNTER_GMAIL_OAUTH_CLIENT_PATH` | `$JOBHUNTER_GMAIL_DIR/oauth-client.json` | Google OAuth Desktop client file. |
| `JOBHUNTER_GMAIL_TOKEN_PATH` | `$JOBHUNTER_GMAIL_DIR/token.json` | Token written by `jobhunter gmail-auth`. |

Authenticate with:

```bash
uv --project workers/automation run jobhunter gmail-auth
uv --project workers/automation run jobhunter doctor
```

The first runs the Gmail sign-in and writes your local token; the second
re-checks that the connector is now available.

The connector requests Gmail read-only scope. Raw Gmail bodies stay local and are
not copied into events, telemetry, broad projections, or logs.

## Compensation Sources

| Variable | What it does |
| --- | --- |
| `JOBHUNTER_LEVELS_FYI_ACCESS_MODE` | Enables configured licensed Levels.fyi rows only when the mode permits the source. |
| `JOBHUNTER_LEVELS_FYI_EUROPE_COVERAGE` | Marks configured Levels.fyi evidence as Europe-capable. |
| `JOBHUNTER_LEVELS_FYI_OBSERVATIONS_PATH` / `JOBHUNTER_LEVELS_FYI_OBSERVATIONS_URL` | JSON or CSV observations feed. |
| `JOBHUNTER_GLASSDOOR_ACCESS_MODE` | Enables configured Glassdoor rows only when access is permitted. |
| `JOBHUNTER_GLASSDOOR_OBSERVATIONS_PATH` / `JOBHUNTER_GLASSDOOR_OBSERVATIONS_URL` | JSON or CSV observations feed. |

Provider payloads and restricted datasets should never be committed.

## Observability

| Variable | What it does |
| --- | --- |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | Enable OpenTelemetry export of LLM, workflow, and JSON-RPC spans to Langfuse. |
| `LANGFUSE_DISABLE=1` | Disable export even when credentials are present. |
| `LANGFUSE_OTEL_TIMEOUT_SECONDS` | OTLP/HTTP export timeout, default `5.0`. |
| `JOBHUNTER_ENV` | Environment attribute stamped on exported traces, default `local`. |

When Langfuse export is enabled, LLM prompts and completions are exported to the
configured Langfuse instance. Do not enable it for private runs unless that is
intentional.

## Test And Documentation Workspaces

| Variable | What it does |
| --- | --- |
| `JOBHUNTER_E2E_APP_DIR` | Disposable app directory used by Playwright e2e. |
| `JOBHUNTER_E2E_DB_PATH` | E2E database path. |
| `JOBHUNTER_E2E_SETTINGS_PATH` | E2E settings path. |
| `JOBHUNTER_E2E_API_PORT` | E2E API port. |
| `JOBHUNTER_E2E_WEB_PORT` | E2E web port. |
| `JOBHUNTER_E2E_STUB_DISPATCH` | Routes selected dispatches through deterministic test stubs. |
| `VITE_JOBHUNTER_HIDE_DEVTOOLS` | Hides TanStack devtools in Vite builds used for public screenshots. |

Use these only for synthetic QA, screenshot generation, and CI.
