---
pageClass: jh-user-guide-page
---

# Configuration

Most people never need this page. JobCtrl ships with working defaults, and the
Discovery targets and preferences you set in the web app cover day-to-day use.
The two settings worth knowing first are an **LLM provider** (required before
scoring or materials can run) and the **daily LLM spend budget** (which caps
cost). A single ready Codex, Claude, or Google provider is sufficient for every
core AI stage, including employer-analysis synthesis. A second provider can add
ensemble diversity, but it is not mandatory.

JobCtrl configuration is intentionally local. Some settings live in the local
SQLite database, set through the web app; working runtime credentials and
runtime switches are read from environment variables. Everything here is
optional unless a feature you want depends on it.

::: info Command spelling
Command blocks on this page use the canonical installed spelling,
`jobctrl <command>`. The native executable is both the app launcher and the
domain CLI from any directory after either curl or Homebrew acquisition.
Contributors running from source can use the checkout-prefixed commands in
[Local Development](../local-development.md).
:::

## Start Here

| You want to change… | Use |
| --- | --- |
| Candidate facts, target role, location, work model, or writing preferences | Profile / Preferences in the web app |
| Discovery sources, schedules, quarantine, or manual capture | Discovery in the web app |
| Approval, spend, worker, or provider behavior | Settings in the web app |
| Provider secret used by the Python runtime | `~/.jobctrl/.env`, shell environment, or the macOS credential panel |
| One isolated development/QA stack | `JOBCTRL_DIR`, API/web ports, and [Test And Documentation Workspaces](#test-and-documentation-workspaces) |

The rest of this page is a lookup table. [Data, Privacy & Safety](data-and-safety.md)
explains what is stored or sent; [Security](security.md) explains the controls
around risky actions.

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

On macOS, **Settings → Credentials** is the preferred guided provider setup. It
stores Anthropic or Gemini API keys and the selected provider-mode settings in
macOS Keychain. Codex credentials stay in JobCtrl's isolated Codex home, and
AWS, Google, and Azure credentials stay in their native CLI-managed stores;
JobCtrl records only the activation flags and non-secret identifiers needed to
select those routes.

At Python process startup, after env-file loading, JobCtrl uses a Keychain value
only when the corresponding environment value is missing or empty; any
non-empty environment value wins. Saving or removing a value is therefore
**restart-to-activate**: restart JobCtrl before provider work. Native Windows
and Linux credential-store adapters are planned; use `.env` or the shell on
those platforms today. `jobctrl doctor` reports the effective source without
printing secrets. **Status unknown** (`inspection_failed`) is distinct from
**not configured**: it means JobCtrl could not inspect Keychain. Provider-mode
replacement is all-or-nothing from the web contract; a failed change preserves
the previous configuration or reports an explicit sanitized recovery failure.

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
| `JOBCTRL_DASHBOARD_CONFIG_PATH` | `$JOBCTRL_DIR/dashboard.json` | Non-secret settings file written by the TypeScript API and read by both API and worker (preferences, provider-scoped model IDs, apply approval gate, spend budget). |
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

Choose one provider in **Settings → Credentials**, then restart JobCtrl and use
`jobctrl doctor`. The pipeline model spec defaults to `default`, which resolves
through a ready provider. Explicit model specs use `codex:`, `claude:`, or
`google:`; `gemini:` remains an alias for the Google SDK route.

Model selection becomes available only after the corresponding provider is
ready. The Codex and Google lists are live catalogs fetched through their
authenticated SDKs. Claude's Agent SDK has no safe universal list across its
API and cloud routes, so JobCtrl labels its list as provider aliases and offers
`sonnet`, `opus`, and `haiku`. Only provider and model IDs are written to
`dashboard.json`; credentials remain on the credential boundary.

A saved preference is scoped to its provider and cannot change which provider
JobCtrl selects. Newly constructed adapters use this precedence:

1. explicit non-default workflow model;
2. `LLM_MODEL`;
3. saved preference for the selected ready provider;
4. that provider's default.

Provider selection itself keeps the default readiness order Claude, then
Codex, then Google. Explicit `provider:model` workflow values and
`LLM_MODEL=provider:model` keep selecting the named provider. Existing adapters
and in-flight work keep their resolved model. Newly started work rechecks the
effective selection when it acquires the shared adapter and receives a new
adapter object when `LLM_MODEL` or the saved preference changed; no worker
restart is required for a preferred-model edit. The initially selected ready
provider stays process-stable on warm acquisitions so status checks do not rerun
for every workflow. Provider credential/readiness changes retain their existing
restart requirement (or require an explicit adapter reset).

### Codex

JobCtrl uses persisted Codex CLI authentication only. A raw
`OPENAI_API_KEY` in JobCtrl's environment or Keychain is not a direct model
route and does not satisfy readiness. If your normal Codex CLI is already
authenticated, click **Reuse existing login or verify** in **Settings →
Credentials**. Setup and the first generation retain the same one-time reuse
behavior. Each path validates the regular CLI `auth.json` against the pinned
Codex runtime in private staging before publishing it to JobCtrl's stable
isolated home, without changing the normal Codex home.

If there is no reusable normal Codex CLI login, fall back to authenticating the
stable JobCtrl-owned home with a ChatGPT subscription or an API key enrolled
through Codex:

```bash
CODEX_HOME="${JOBCTRL_DIR:-$HOME/.jobctrl}/codex_home" codex login

printenv OPENAI_API_KEY | \
  CODEX_HOME="${JOBCTRL_DIR:-$HOME/.jobctrl}/codex_home" \
  codex login --with-api-key
```

`jobctrl setup --launch-logins` uses the bundled Codex runtime for the fallback
flow. The Settings card can invoke the same reusable-login importer and verify
the resulting isolated login without making a model call. Codex stores local
state under `CODEX_HOME`, and `codex login status`
exits successfully when credentials are present. See the official
[Codex login command](https://learn.chatgpt.com/docs/developer-commands#codex-login)
and [state-location reference](https://learn.chatgpt.com/docs/config-file/config-advanced#config-and-state-locations).

JobCtrl keeps authentication outside the model-readable
`codex_home/workspace/` directory. If isolated auth is absent, setup,
generation, and the Settings verify action use one shared safe importer. It
publishes only a candidate that passes staged live verification; a failed or
expired candidate leaves no isolated auth and can be retried after the source
login is refreshed. It never overwrites an existing isolated login, changes
the normal Codex home, or creates a transient per-run runtime home.

### Claude

Choose exactly one Claude Agent SDK route. Consumer Claude CLI login/OAuth does
not count as provider readiness. The supported routes follow the official
[Agent SDK authentication guidance](https://code.claude.com/docs/en/agent-sdk/quickstart):

| Route | Settings stored by JobCtrl | Credential owned outside JobCtrl |
| --- | --- | --- |
| Anthropic API | `ANTHROPIC_API_KEY` | None |
| Google Vertex AI | `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_PROJECT_ID`, `CLOUD_ML_REGION` | Google Application Default Credentials (`gcloud auth application-default login`) or `GOOGLE_APPLICATION_CREDENTIALS` naming an existing service-account JSON file |
| Amazon Bedrock | `CLAUDE_CODE_USE_BEDROCK=1`, optional `AWS_PROFILE` / `AWS_REGION` | AWS credential chain ([Bedrock setup](https://code.claude.com/docs/en/amazon-bedrock)) |
| Claude Platform on AWS | `CLAUDE_CODE_USE_ANTHROPIC_AWS=1`, `ANTHROPIC_AWS_WORKSPACE_ID`, optional `AWS_PROFILE` / `AWS_REGION` | AWS credential chain ([Claude Platform on AWS](https://code.claude.com/docs/en/claude-platform-on-aws)) |
| Microsoft Foundry | `CLAUDE_CODE_USE_FOUNDRY=1`, `ANTHROPIC_FOUNDRY_RESOURCE` | Azure credential chain (`az login`; [Foundry setup](https://code.claude.com/docs/en/microsoft-foundry)) |

The Vertex route is documented separately in the official
[Claude on Vertex AI guide](https://code.claude.com/docs/en/google-vertex-ai).

### Google

Choose one:

| Route | Configuration |
| --- | --- |
| Gemini API | `GEMINI_API_KEY` (the runtime also accepts `GOOGLE_API_KEY` from the environment) |
| Vertex AI | `GOOGLE_GENAI_USE_VERTEXAI=1`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, plus valid Google Application Default Credentials |

Vertex project and location values select the target; they are not credentials.
If `GOOGLE_APPLICATION_CREDENTIALS` is set, it must name an existing regular,
loadable service-account JSON file. Otherwise JobCtrl checks the standard local
gcloud ADC location, whose officially loadable ADC types (including
`authorized_user`) remain supported.

`LLM_MODEL` optionally overrides both the saved preference and the selected
provider's default model.

## Employer-Analysis Ensemble

Run this after first setup or whenever vendor auth changes:

```bash
jobctrl setup
jobctrl doctor
```

The ensemble legs use vendor SDK runtimes pinned in the Python environment. The
setup command detects auth before prompting and writes only local `.env`
configuration; it never commits or ships credentials. Every run drafts and
synthesizes with at least one ready provider. Unavailable optional legs degrade
independently; the only ready provider is automatically included even when a
stale `JOBCTRL_ANALYSIS_LEGS` value omitted it.

| Variable | What it does |
| --- | --- |
| `JOBCTRL_ANALYSIS_LEGS` | Comma-separated optional draft legs: `claude,codex,antigravity` by default. Setup writes this when you intentionally skip an unauthenticated leg. It does not impose a separate synthesis-provider requirement. |
| `JOBCTRL_CODEX_BIN` | Explicit Codex runtime override. The default is the pinned `openai-codex-cli-bin` bundled binary. |

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

The default resume renderer is HTML/CSS printed through Playwright. Apply Review
loads the generated HTML source into a rich-text editor so text, formatting, and
hyperlink edits, comments, validation, final PDF rendering, and layout boxes stay
tied to the same material generation.

## Browser Apply Automation

| Variable | Default | What it does |
| --- | --- | --- |
| `JOBCTRL_CLAUDE_BIN` | unset | Explicit apply-agent Claude runtime override. By default apply uses a system `claude` when present, then the pinned Claude Agent SDK bundled binary. |
| `JOBCTRL_APPLY_TIMEOUT_SECONDS` | `900` | Per-job autonomous apply timeout. |
| `CAPSOLVER_API_KEY` | unset | Optional key used only by the owned local `solve_captcha` apply tool for supported widgets. Provider keys and solver tokens are not sent through the model prompt; unsupported or unconfigured CAPTCHA flows fail closed. |
| `JOBCTRL_LINKEDIN_APPLY_RESOLVER` | capability-controlled | Set to `0` to disable authenticated LinkedIn outbound apply URL resolution after it has been explicitly enabled. It cannot enable the feature by itself. |
| `JOBCTRL_LINKEDIN_APPLY_CHROME_PROFILE` | browser default | Chrome profile name inside the resolver user-data directory. |
| `JOBCTRL_LINKEDIN_APPLY_HEADLESS` | visible Chrome | Set to `1` to run the resolver headless. |

The source checkout installs managed Playwright Chromium for discovery,
enrichment, and PDF rendering. The bundled release contains exactly
one managed Playwright Chromium headless shell for those core paths and no full
Chrome/Chromium application. System Chrome/Chromium is optional in both modes
and is never auto-detected or adopted for authenticated operations. Its choices
are stored in `$JOBCTRL_DIR/browser-capabilities.json` with private `0600`
permissions:

```bash
jobctrl capability list
jobctrl capability enable auto-apply-browser --browser-path /path/to/Chrome
jobctrl capability enable authenticated-linkedin-browser --browser-path /path/to/Chrome \
  --copy-profile-from /path/to/Chrome-profile --consent-copy-profile
jobctrl capability disable auto-apply-browser
```

The managed optional browser-pack choice intentionally reports unavailable until
JobCtrl has a signed pack supply chain; the command does not download an
unsigned browser. Authenticated LinkedIn resolution remains unavailable until a
separate, explicitly consented copy of an existing profile exists under
`$JOBCTRL_DIR/browser-profiles/linkedin-apply-url-resolver`. JobCtrl never
persists the source-profile path, and `--yes` cannot imply profile-copy consent.

Apply automation can submit applications. Use dry runs and narrow targets before
approving real submission.

The web app writes the apply safety settings to `dashboard.json`:

| Setting | Default | What it does |
| --- | --- | --- |
| `autoApply` | `false` | When `true`, a running worker keeps exactly one continuous Apply workflow active for eligible prepared jobs only while `auto-apply-browser` is explicitly ready. The loop appears in Runs as the standing apply loop. Turning it back off cancels that loop. |
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
jobctrl gmail-auth
jobctrl doctor
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

Settings > General > Compensation sources lets you opt into Levels.fyi and
Glassdoor at your discretion. Choose the access basis you actually have,
confirm Europe coverage for Levels.fyi, and then enable the source. The choice
is stored locally in `dashboard.json` and is consumed by both the TypeScript API
and the Python compensation refresh worker. Once you save a source preference,
it overrides the compatibility environment-variable gate for that source;
before that, the environment variables below remain the fallback.

Enabling a source does not obtain a license, create permission, bypass provider
controls, or scrape a provider website. You must still supply an authorized
JSON or CSV feed using the corresponding path or URL variable. Turning the
source off in Settings prevents the worker from loading that feed even when an
access-mode environment variable is present.

| Variable | What it does |
| --- | --- |
| `JOBCTRL_LEVELS_FYI_ACCESS_MODE` | Compatibility fallback for the Levels.fyi access basis until an explicit Settings preference exists. |
| `JOBCTRL_LEVELS_FYI_EUROPE_COVERAGE` | Compatibility fallback for explicit Levels.fyi Europe coverage confirmation. |
| `JOBCTRL_LEVELS_FYI_OBSERVATIONS_PATH` / `JOBCTRL_LEVELS_FYI_OBSERVATIONS_URL` | JSON or CSV observations feed. |
| `JOBCTRL_GLASSDOOR_ACCESS_MODE` | Compatibility fallback for the Glassdoor access basis until an explicit Settings preference exists. |
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
| `JOBCTRL_DOCS_SCREENSHOTS` | Opts the Playwright run into rewriting the synthetic documentation screenshots under `docs/`. |
| `VITE_JOBCTRL_SHOW_DEVTOOLS` | Shows TanStack Router and Query devtools in local Vite dev builds. |
| `VITE_JOBCTRL_HIDE_DEVTOOLS` | Compatibility override that hides TanStack devtools even when the show flag is set. |

Use these only for synthetic QA, screenshot generation, and CI.
