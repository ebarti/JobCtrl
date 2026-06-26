# Configuration

JobHunter configuration is intentionally local. Some settings are stored in the
local SQLite database through the web UI; secrets and runtime switches are read
from environment variables.

## Configuration Sources

| Source | Purpose |
| --- | --- |
| `~/.jobhunter/jobhunter.db` | Candidate profile, discovery settings, preferences, tailoring controls, jobs, events, projections, and artifact metadata. |
| `~/.jobhunter/.env` | Personal provider keys and runtime environment. |
| repo `.env` | Development-only overrides for the current checkout. |
| shell environment | One-off overrides for commands and CI. |
| `workers/automation/src/jobhunter/config/*.yaml` | Packaged employer, source, ATS, and site behavior registries. |

The development launcher loads `~/.jobhunter/.env`, repo `.env`, and the optional
`JOBHUNTER_USER_ENV_PATH` file before starting local services.

## Core Runtime

| Variable | Default | What it does |
| --- | --- | --- |
| `JOBHUNTER_DIR` | `~/.jobhunter` | Local app directory for database, settings, artifacts, logs, browser worker state, and `.env`. |
| `JOBHUNTER_DB_PATH` | `$JOBHUNTER_DIR/jobhunter.db` | TypeScript API database path. Use only when API and worker must point at a specific copy. |
| `JOBHUNTER_DASHBOARD_CONFIG_PATH` | `$JOBHUNTER_DIR/dashboard.json` | Legacy settings-path override still used by local runtime compatibility surfaces. |
| `JOBHUNTER_API_HOST` | `127.0.0.1` | Local API bind host. Non-loopback hosts require explicit opt-in. |
| `JOBHUNTER_API_PORT` / `PORT` | `8766` | Local API port. |
| `JOBHUNTER_API_ALLOW_REMOTE_BIND` | unset | Set to `1`, `true`, or `yes` to allow non-loopback API binding. This can expose private local data. |
| `JOBHUNTER_WEB_PORT` | `5173` | Requested Vite development port. |
| `VITE_JOBHUNTER_API_BASE_URL` | proxied `/v1` | Browser API origin when not using the default Vite proxy. |
| `JOBHUNTER_TEMPORAL_DB` | `.dev/temporal/temporal.db` | Temporal dev-server SQLite history store. |

## LLM Providers

| Variable | What it does |
| --- | --- |
| `GEMINI_API_KEY` | Enables Gemini-backed scoring/materials. |
| `OPENAI_API_KEY` | Enables OpenAI-backed scoring/materials. |
| `LLM_URL` | Enables a local OpenAI-compatible HTTP endpoint. |
| `LLM_MODEL` | Overrides the provider default model. |

The pipeline default model spec is currently `gemini:gemini-3.5-flash` unless a
stage or UI control overrides it.

## Discovery

| Variable | Default | What it does |
| --- | --- | --- |
| `JOBHUNTER_DISCOVERY_LLM_ROLE_FILTER` | `auto` | Uses an LLM to adjudicate loose role-title matches when an LLM provider is configured. Set `0` to force deterministic matching only. |
| `JOBHUNTER_DISCOVERY_ROLE_FILTER_MODEL` | configured LLM model | Optional model spec for discovery role adjudication. |
| `PROXY` | unset | Optional scraping proxy in `host:port:user:pass` form. |

Discovery target roles, locations, seniority, work models, source controls, and
automation preferences are normally edited in the Discovery page and stored in
SQLite.

## Materials And Resume Rendering

| Variable | Default | What it does |
| --- | --- | --- |
| `TAILORING_GENERATOR_MODELS` | provider default | Comma-separated generator model specs for resume tailoring. |
| `TAILORING_JUDGE_MODEL` | provider default | Optional separate model spec for the structured tailoring judge. |
| `TAILORING_JUDGE_MIN_SCORE` | `0.82` | Minimum judge score for auto-approval. |
| `TAILOR_LLM_MODELS` | alias | Backward-compatible alias for `TAILORING_GENERATOR_MODELS`. |
| `TAILOR_JUDGE_MODEL` | alias | Backward-compatible alias for `TAILORING_JUDGE_MODEL`. |
| `TAILOR_JUDGE_MIN_SCORE` | alias | Backward-compatible alias for `TAILORING_JUDGE_MIN_SCORE`. |
| `JOBHUNTER_RESUME_RENDERER` | `html_pdf` | Set to `latex_pdf` only for the legacy LaTeX resume renderer. |
| `PDFLATEX_PATH` | auto-detected | Override `pdflatex` location when using the legacy renderer. |

The default resume renderer is HTML/CSS printed through Playwright. Apply Review
loads the generated HTML source so edits, comments, validation, final PDF
rendering, and layout boxes stay tied to the same material generation.

## Browser Apply Automation

| Variable | Default | What it does |
| --- | --- | --- |
| `CHROME_PATH` | auto-detected | Chrome/Chromium executable path. |
| `JOBHUNTER_APPLY_TIMEOUT_SECONDS` | `900` | Per-job autonomous apply timeout. |
| `CAPSOLVER_API_KEY` | unset | Optional CAPTCHA solving support for explicitly authorized apply runs. |
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
