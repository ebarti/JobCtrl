---
pageClass: jh-user-guide-page
---

# Configuration

Most people never need this page. JobCtrl ships with working defaults, and the
Discovery targets and preferences you set in the web app cover day-to-day use.
The two settings worth knowing first are an **LLM provider key** (required before
scoring or materials can run) and the **daily LLM spend budget** (which caps
cost). Employer-analysis also has per-vendor auth checks because it runs a
Claude + Codex + Antigravity ensemble; `jobctrl setup` and `jobctrl doctor`
report those separately.

JobCtrl configuration is intentionally local. Some settings live in the local
SQLite database, set through the web app; secrets and runtime switches are read
from environment variables. Everything here is optional unless a feature you want
depends on it.

## Configuration Sources

| Source | Purpose |
| --- | --- |
| `~/.jobctrl/jobctrl.db` | Candidate profile, discovery settings, preferences, tailoring controls, jobs, events, projections, and artifact metadata. |
| `~/.jobctrl/.env` | Personal provider keys and runtime environment. |
| repo `.env` | Development-only overrides for the current checkout. |
| shell environment | One-off overrides for commands and CI. |
| `workers/automation/src/jobctrl/config/*.yaml` | Packaged employer and site behavior registries (`employers.yaml`, `sites.yaml`). The dynamic source registry lives in SQLite. |

The development launcher loads `~/.jobctrl/.env`, repo `.env`, and the optional
`JOBCTRL_USER_ENV_PATH` file before starting local services.

## Candidate Profile Application Fields

`profile.example.json` includes an `application_attestations` block for legal
or screening questions that apply automation is not allowed to infer:

- `age_18_plus`
- `background_check_consent`
- `felony_conviction`
- `previously_worked_at_employer`

Use `true` or `false` only when the answer is explicitly true or false for you.
Leave unknown answers as `null`; live apply automation fails with
`missing_profile_data:<field>` instead of guessing. `jobctrl doctor` warns
when required attestations are incomplete, and Apply Review surfaces the same
missing fields before approval when the local profile row has unknown values.

The profile also supports `application_preferences.how_heard` for common
"How did you hear about us?" questions. It is a preference, not a legal
attestation; leave it empty when there is no truthful answer.

## Core Runtime

| Variable | Default | What it does |
| --- | --- | --- |
| `JOBCTRL_DIR` | `~/.jobctrl` | Local app directory for database, settings, artifacts, logs, browser worker state, and `.env`. |
| `JOBCTRL_DB_PATH` | `$JOBCTRL_DIR/jobctrl.db` | TypeScript API database path. The Python worker ignores it and always uses `$JOBCTRL_DIR/jobctrl.db`, so overriding it desynchronizes the API from the worker — prefer `JOBCTRL_DIR` to move both. |
| `JOBCTRL_DASHBOARD_CONFIG_PATH` | `$JOBCTRL_DIR/dashboard.json` | Settings file read and written by the TypeScript API (preferences, apply approval gate, spend budget). |
| `JOBCTRL_API_HOST` | `127.0.0.1` | Local API bind host. Non-loopback hosts require explicit opt-in. |
| `JOBCTRL_API_PORT` / `PORT` | `8766` | Local API port. |
| `JOBCTRL_API_ALLOW_REMOTE_BIND` | unset | Set to `1`, `true`, or `yes` to allow non-loopback API binding. This can expose private local data. |
| `JOBCTRL_WEB_PORT` | `5173` | Requested Vite development port. |
| `VITE_JOBCTRL_API_BASE_URL` | proxied `/v1` | Browser API origin when not using the default Vite proxy. |
| `JOBCTRL_TEMPORAL_DB` | `.dev/temporal/temporal.db` | Temporal (the workflow engine) dev-server SQLite history store. |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal server address used by the worker, CLI, and workflow-starting RPC. |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace. |
| `JOBCTRL_MAX_CONCURRENT_ACTIVITIES` | `4` | Maximum Temporal activities the local worker runs at once (shown on the Settings page). Set in the worker environment and restart the worker to apply. |
| `JOBCTRL_API_SSE_POLL_MS` | `250` | API event-stream database poll interval in milliseconds. |
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
uv --project workers/automation run jobctrl setup
uv --project workers/automation run jobctrl doctor
```

The ensemble legs use vendor SDK runtimes pinned in the Python environment. The
setup command detects auth before prompting and writes only local `.env`
configuration; it never commits or ships credentials.

Every employer-analysis run reconciles its legs with a Claude Agent SDK
synthesis pass, so Claude auth (`ANTHROPIC_API_KEY` or local Claude credentials)
is required even when you disable the `claude` leg via `JOBCTRL_ANALYSIS_LEGS`.
`jobctrl setup` warns that analysis is not ready when synthesis auth is
missing, and `jobctrl doctor` reports a dedicated `Claude synthesis auth` row
that stays red until Claude auth is present.

| Variable | What it does |
| --- | --- |
| `JOBCTRL_ANALYSIS_LEGS` | Comma-separated enabled legs: `claude,codex,antigravity` by default. Setup writes this when you intentionally skip an unauthenticated leg so runs do not burn retries. Disabling the `claude` leg does **not** remove the Claude synthesis-auth requirement above. |
| `ANTHROPIC_API_KEY` | Supported Claude Agent SDK auth path. |
| `ANTHROPIC_AUTH_TOKEN` | Alternate Claude auth token path. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Local/dev Claude subscription convenience. The distributed product path remains API/provider auth. |
| `CLAUDE_CONFIG_DIR` | Overrides the local Claude credential directory checked for `.credentials.json`. |
| `CODEX_HOME` | Codex home containing `auth.json`. Defaults to `~/.codex`; the JobCtrl adapter copies this auth into isolated `~/.jobctrl/codex_home`. |
| `JOBCTRL_CODEX_BIN` | Explicit Codex runtime override. The default is the pinned `openai-codex-cli-bin` bundled binary. |
| `GOOGLE_GENAI_USE_VERTEXAI` | Set to `1` to allow the Antigravity leg to use Vertex AI ADC instead of an API key. |
| `GOOGLE_CLOUD_PROJECT` / `GOOGLE_PROJECT_ID` / `GCLOUD_PROJECT` | Project used with Vertex AI ADC. |
| `GOOGLE_CLOUD_LOCATION` / `GOOGLE_VERTEX_LOCATION` | Optional Vertex location for Antigravity. |

Codex auth is the common gotcha: `OPENAI_API_KEY` and `CODEX_API_KEY` can feed
other surfaces, but the Codex SDK app-server path used by JobCtrl needs
persisted `auth.json`. Enroll a key with:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

or run the Codex device login locally, then rerun `jobctrl setup`.

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
| `JOBCTRL_DISCOVERY_LLM_ROLE_FILTER` | `auto` | Uses an LLM to adjudicate loose role-title matches when an LLM provider is configured. Set `0` to force deterministic matching only. |
| `JOBCTRL_DISCOVERY_ROLE_FILTER_MODEL` | configured LLM model | Optional model spec for discovery role adjudication. |
| `JOBCTRL_MAX_PARALLEL_DISCOVERY_FAMILIES` | `1` | How many discovery source families (`jobspy`, `ats_api`, `workday`, `smartextract`) crawl at once. `1` (default) keeps families sequential — the safe, isolated behavior. Values `> 1` run that many source crawls concurrently to cut total discovery wall-clock; enrichment still runs once per batch (never concurrently). Read at run start and applied for the whole run; change it in the worker environment and restart the worker. **Tune conservatively:** each concurrent family may launch its own headless browser, so keep this ≤ `JOBCTRL_MAX_CONCURRENT_ACTIVITIES` and mind memory (~roughly 300–600 MB per Chromium). Uncontrolled browser concurrency has historically destabilized long runs — see [Concurrency & Fan-out](../architecture/pipeline/concurrency.md) for the worker-capacity analysis before raising it. |

Discovery target roles, locations, seniority, work models, source controls, and
automation preferences are normally edited in the Discovery page and stored in
SQLite. A scraping proxy, when needed, is part of those SQLite discovery
settings (`host:port:user:pass` form); there is no `PROXY` environment
variable.

![JobCtrl Discovery page with target search, seniority floors, job boards, and source registry](../assets/screenshots/discovery.png)
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
| `JOBCTRL_CRAWL_UA_PRODUCT` | `JobCtrl` | Product token in the outbound `User-Agent`. |
| `JOBCTRL_CRAWL_UA_CONTACT` | project repo URL | Contact appended as `(+<contact>)`. Set it **empty** to drop the suffix. |

The effective identity is `<product>/<version> (+<contact>)` — for example
`JobCtrl/0.3 (+https://github.com/ebarti/JobCtrl)`. It **never impersonates
a browser**. The built-in default points at the public project repository, not
any personal identity; **owners should review it (and set a contact they own)
before crawling real sites** — `jobctrl doctor` prints the effective value.

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

## Outreach Follow-Ups

Outreach follow-ups are **surfaced-only reminders** — JobCtrl never sends and
has no send capability. Their posture:

- **Conservative cadence defaults.** When you schedule a follow-up without picking
  a date, JobCtrl suggests one **7 calendar days after the application was
  submitted** for the first nudge, and **14 calendar days** for a subsequent nudge
  if you have logged no reply. Every suggested date is **fully editable per
  thread** — the suggestion is only a starting point.
- **Default-off automation.** Any optional recurring follow-up reminder is
  **disabled by default** (`reminders_enabled = false`, mirroring discovery
  `scheduling_enabled`). Even when enabled it only *surfaces* due items in the
  **Follow-ups** list and badge — it never sends and never acts on your behalf.
- **A follow-up is due** purely as a read-time computation over its date and the
  clock; marking one done or dismissing it is always your explicit action.

## Materials And Resume Rendering

| Variable | Default | What it does |
| --- | --- | --- |
| `TAILORING_GENERATOR_MODELS` | provider default | Comma-separated generator model specs for resume tailoring. |
| `TAILORING_JUDGE_MODEL` | provider default | Optional separate model spec for the structured tailoring judge. |
| `TAILORING_JUDGE_MIN_SCORE` | `0.82` | Minimum judge score for auto-approval. |
| `TAILOR_LLM_MODELS` | alias | Backward-compatible alias for `TAILORING_GENERATOR_MODELS`. |
| `TAILOR_JUDGE_MODEL` | alias | Backward-compatible alias for `TAILORING_JUDGE_MODEL`. |
| `TAILOR_JUDGE_MIN_SCORE` | alias | Backward-compatible alias for `TAILORING_JUDGE_MIN_SCORE`. |
| `JOBCTRL_RESUME_RENDERER` | `html_pdf` | Set to `latex_pdf` only for the LaTeX resume compatibility renderer. |
| `PDFLATEX_PATH` | auto-detected | Override `pdflatex` location when using the LaTeX compatibility renderer. |

The default resume renderer is HTML/CSS printed through Playwright. Apply Review
loads the generated HTML source so edits, comments, validation, final PDF
rendering, and layout boxes stay tied to the same material generation.

## Browser Apply Automation

| Variable | Default | What it does |
| --- | --- | --- |
| `CHROME_PATH` | auto-detected | Chrome/Chromium executable path. |
| `JOBCTRL_CLAUDE_BIN` | unset | Explicit apply-agent Claude runtime override. By default apply uses a system `claude` when present, then the pinned Claude Agent SDK bundled binary. |
| `JOBCTRL_APPLY_TIMEOUT_SECONDS` | `900` | Per-job autonomous apply timeout. |
| `CAPSOLVER_API_KEY` | unset | Optional key used only by the owned local `solve_captcha` apply tool for supported widgets. Provider keys and solver tokens are not sent through the model prompt; unsupported or unconfigured CAPTCHA flows fail closed. |
| `JOBCTRL_LINKEDIN_APPLY_RESOLVER` | enabled | Set to `0` to disable authenticated LinkedIn outbound apply URL resolution. |
| `JOBCTRL_LINKEDIN_APPLY_PROFILE_DIR` | `~/.jobctrl/chrome-workers/linkedin-apply-url-resolver` | Dedicated Chrome profile for LinkedIn apply URL resolution. |
| `JOBCTRL_LINKEDIN_APPLY_SOURCE_PROFILE_DIR` | platform Chrome profile dir | Optional source profile copied into the resolver profile on first use. |
| `JOBCTRL_LINKEDIN_APPLY_CHROME_PROFILE` | browser default | Chrome profile name inside the resolver user-data directory. |
| `JOBCTRL_LINKEDIN_APPLY_HEADLESS` | visible Chrome | Set to `1` to run the resolver headless. |

Apply automation can submit applications. Use dry runs and narrow targets before
approving real submission.

The web app writes the apply safety settings to `dashboard.json`:

| Setting | Default | What it does |
| --- | --- | --- |
| `autoApply` | `false` | When `true`, a running worker keeps exactly one continuous Apply workflow active for eligible prepared jobs. The loop appears in Runs as the standing apply loop. Turning it back off cancels that loop. |
| `applyApprovalRequired` | `true` | When `true`, live submit waits for Apply Review approval; the standing loop parks unapproved jobs as awaiting approval. When `false`, manually started live runs and the standing loop may submit eligible jobs without review. |
| `minFitScore` | `7` | Minimum score for jobs claimed by apply automation, including the standing loop. |
| `applyConcurrency` | `1` | Number of concurrent apply workers used by apply automation. The standing loop re-reads this setting when it polls. |

Combinations matter:

- `autoApply: false`, `applyApprovalRequired: true` is the default supervised
  mode: no standing loop exists and live submit requires Apply Review approval.
- `autoApply: true`, `applyApprovalRequired: true` is a supervised standing
  loop: eligible approved jobs can submit, and unapproved jobs are parked for
  Apply Review.
- `autoApply: true`, `applyApprovalRequired: false` is autonomous live submit:
  the standing loop may submit eligible prepared jobs without human review,
  while the minimum score, daily spend ceiling, at-most-once submit intent,
  CAPTCHA fail-closed behavior, and dry-run guard still apply.

## Gmail Connector

| Variable | Default | What it does |
| --- | --- | --- |
| `JOBCTRL_GMAIL_DIR` | `~/.jobctrl/gmail` | First-party Gmail connector auth directory. |
| `JOBCTRL_GMAIL_OAUTH_CLIENT_PATH` | `$JOBCTRL_GMAIL_DIR/oauth-client.json` | Google OAuth Desktop client file. |
| `JOBCTRL_GMAIL_TOKEN_PATH` | `$JOBCTRL_GMAIL_DIR/token.json` | Token written by `jobctrl gmail-auth`. |

Authenticate with:

```bash
uv --project workers/automation run jobctrl gmail-auth
uv --project workers/automation run jobctrl doctor
```

The first runs the Gmail sign-in and writes your local token; the second
re-checks that the connector is now available.

The connector requests Gmail read-only and send scopes. Read scope is used for
bounded verification-code and outcome lookups. Send scope is used only for the
owned email-application path after a dry-run records the recipient and
attachment candidate and Apply Review approves that exact binding. Raw Gmail
bodies stay local and are not copied into events, telemetry, broad projections,
or logs.

## Compensation Sources

| Variable | What it does |
| --- | --- |
| `JOBCTRL_LEVELS_FYI_ACCESS_MODE` | Enables configured licensed Levels.fyi rows only when the mode permits the source. |
| `JOBCTRL_LEVELS_FYI_EUROPE_COVERAGE` | Marks configured Levels.fyi evidence as Europe-capable. |
| `JOBCTRL_LEVELS_FYI_OBSERVATIONS_PATH` / `JOBCTRL_LEVELS_FYI_OBSERVATIONS_URL` | JSON or CSV observations feed. |
| `JOBCTRL_GLASSDOOR_ACCESS_MODE` | Enables configured Glassdoor rows only when access is permitted. |
| `JOBCTRL_GLASSDOOR_OBSERVATIONS_PATH` / `JOBCTRL_GLASSDOOR_OBSERVATIONS_URL` | JSON or CSV observations feed. |

Provider payloads and restricted datasets should never be committed.

## Observability

| Variable | What it does |
| --- | --- |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | Enable OpenTelemetry export of LLM, workflow, and JSON-RPC spans to Langfuse. |
| `LANGFUSE_DISABLE=1` | Disable export even when credentials are present. |
| `LANGFUSE_OTEL_TIMEOUT_SECONDS` | OTLP/HTTP export timeout, default `5.0`. |
| `JOBCTRL_ENV` | Environment attribute stamped on exported traces, default `local`. |

When Langfuse export is enabled, LLM prompts and completions are exported to the
configured Langfuse instance. Do not enable it for private runs unless that is
intentional.

## Test And Documentation Workspaces

| Variable | What it does |
| --- | --- |
| `JOBCTRL_E2E_APP_DIR` | Disposable app directory used by Playwright e2e. |
| `JOBCTRL_E2E_DB_PATH` | E2E database path. |
| `JOBCTRL_E2E_SETTINGS_PATH` | E2E settings path. |
| `JOBCTRL_E2E_API_PORT` | E2E API port. |
| `JOBCTRL_E2E_WEB_PORT` | E2E web port. |
| `JOBCTRL_E2E_STUB_DISPATCH` | Routes selected dispatches through deterministic test stubs. |
| `VITE_JOBCTRL_HIDE_DEVTOOLS` | Hides TanStack devtools in Vite builds used for public screenshots. |

Use these only for synthetic QA, screenshot generation, and CI.
