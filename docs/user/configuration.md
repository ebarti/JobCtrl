# Configuration & Credentials

Most people use [Discovery](discovery.md) and [Apply](apply.md) for
feature-specific setup. This page owns the shared configuration boundary:
effective-value precedence, local storage, LLM providers and model policy, the
daily LLM spend ceiling, compensation-source policy, and advanced operator
controls. A single ready Codex, Claude, or Google provider is sufficient for
every core AI stage, including employer-analysis synthesis. A second provider
can add ensemble diversity, but it is not mandatory.

JobCtrl configuration is intentionally local. Every value edited anywhere on
`/discovery` lives in SQLite. Every non-secret desired value edited anywhere
under `/settings/**` lives in `config.json`. Secrets entered through Settings
remain in macOS Keychain or native provider stores; operator-supplied `.env` and
launch-environment secrets stay outside the saved Settings document. Everything
here is optional unless a feature you want depends on it.

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
| Candidate facts and resume evidence | **Profile** (`/profile`) |
| Work model, application, or writing preferences | **Preferences** (`/preferences`) |
| Target roles/locations, runtime, sources, schedules, quarantine, manual capture, or crawl identity | [**Discovery**](discovery.md) (`/discovery`) |
| Materials, application fields, approval modes, browser automation, or Gmail | [**Apply**](apply.md) |
| Spend/capacity, scoring guidance, or compensation source policy | **Settings → General** (`/settings`) |
| Provider secret or cloud mode | **Settings → Credentials** (`/settings/credentials`) on macOS, or `~/.jobctrl/.env` / the shell |
| Preferred provider model or employer-analysis perspectives | **Settings → Model selection** (`/settings/models`); see [Employer Analysis Perspectives](discovery.md#employer-analysis-perspectives) for how the selection is used during Discover preparation |
| Pairing and live Discovery browser readiness | **Settings → Browser & extension** (`/settings/browser`); integrated Discovery requires the extension's live heartbeat from the user's current Chrome profile |

The rest of this page is a shared-settings lookup. [Data, Privacy & Safety](data-and-safety.md)
explains what is stored or sent; [Security](security.md) explains the controls
around risky actions.

### How a setting becomes effective

For non-secret values editable in the UI, JobCtrl uses the first available
value from the top of this hierarchy:

<script setup>
import SettingsPrecedence from "../.vitepress/theme/SettingsPrecedence.vue";
</script>

<SettingsPrecedence />

Environment variables are not an alternate persistence store for non-secret UI
settings. Secret loading is separate: a non-empty environment secret can take
precedence over Keychain at process startup. Hard deny switches such as
`LANGFUSE_DISABLE=1` are also authoritative: they can force a corresponding
feature off, but cannot turn it on.

| Surface | Storage | API | When a saved change applies |
| --- | --- | --- | --- |
| Settings → General | [`config.json`](../api/profile-and-settings.md#config-json-field-reference) | `/v1/settings` | Live, next poll/run/workflow, or restart, as labeled; worker activity slots show desired versus active values |
| Settings → Credentials | Non-secret desired values in `config.json`; secrets in macOS Keychain, the launch environment, or native provider stores | `/v1/credentials` | Claude and Google Keychain edits require the relevant Python process to restart; an environment-owned active route remains authoritative until its value is removed and the process restarts; Codex verification is immediate |
| Settings → Model selection | [`config.json`](../api/profile-and-settings.md#config-json-field-reference) | `/v1/settings`; `/v1/providers/models` | Newly started work; no worker restart |
| Settings → Browser & extension | Non-secret Apply-browser choices and adopted executable configuration in `config.json`; the pairing token and mode-`0600` selected-extension installation ID remain separate; live Discovery task status is transient | `/v1/browser-capabilities`; `/v1/extension/pairing-token`; `/v1/extension/discovery/claim`; `/v1/discovery/browser-extension/status` | Saving the token from an extension explicitly selects that Chrome installation; token rotation clears it. Integrated Discovery and Enrich become launchable only while that selected installation heartbeats from the user's current Chrome profile. Settings does not create a LinkedIn profile copy. |

[Discovery](discovery.md) and [Apply](apply.md) document the storage and
activation timing for their feature-specific controls.

## Configuration Sources

| Source | Purpose |
| --- | --- |
| `~/.jobctrl/jobctrl.db` | Candidate profile, every field edited on `/discovery`, preferences, tailoring controls, jobs, events, projections, and artifact metadata. |
| [`~/.jobctrl/config.json`](../api/profile-and-settings.md#config-json-field-reference) | Every non-secret desired value edited under `/settings/**`, including budgets and capacity, application runtime, scoring guidance, model policy, browser capability choices, and compensation source policy. It never owns a field shown on `/discovery`. |
| `~/.jobctrl/.env` | Personal provider keys and runtime environment. |
| repo `.env` | Development-only overrides for the current checkout. |
| shell environment | One-off overrides for commands and CI. |
| `workers/automation/src/jobctrl/config/*.yaml` | Packaged employer and site behavior registries (`employers.yaml`, `sites.yaml`). The dynamic source registry lives in SQLite. |

The development launcher loads `~/.jobctrl/.env`, repo `.env`, and the optional
`JOBCTRL_USER_ENV_PATH` file before starting local services.

On macOS, **Settings → Credentials** is the preferred guided provider setup. It
stores Anthropic or Gemini API keys and selected provider-mode settings in
macOS Keychain. Codex uses an authenticated Codex CLI, and AWS, Google, and
Azure credentials stay in their native CLI-managed stores; JobCtrl records only
the activation flags and non-secret identifiers needed to select those routes
in `config.json`.

At Python process startup, after env-file loading, JobCtrl uses a Keychain value
only when the corresponding environment value is missing or empty; any
non-empty environment value wins. Saving or removing a value is therefore
**restart-to-activate** for Python consumers: restart the relevant worker or
provider process before Claude or Google work. Preferred-model changes do not
require that restart.

Environment ownership is scoped to the active secret or auth route, not to the
whole provider card. While an environment-owned route is active, its secret
field and provider-removal control remain read-only, but Settings still lets you
prepare another supported auth route. Saving that alternative does not override
the active environment value. Remove the environment value and restart the
relevant process before expecting the saved route to become effective.

The Credentials screen groups readiness, ownership, secret input, and actions
as one responsive row for each supported route. At narrow widths those actions
move below the field instead of squeezing it. Stored secret values are never
rendered; the screen shows a human-readable configured/readiness state and a
sanitized error when inspection fails. Settings section headers likewise use
their product names and explanations rather than internal context tags or raw
configuration keys as decorative metadata.

Native Windows
and Linux credential-store adapters are planned; use `.env` or the shell on
those platforms today. `jobctrl doctor` reports the effective source without
printing secrets. **Status unknown** (`inspection_failed`) is distinct from
**not configured**: it means JobCtrl could not inspect Keychain. Provider-mode
replacement is all-or-nothing from the web contract; a failed change preserves
the previous configuration or reports an explicit sanitized recovery failure.

## Local Data

JobCtrl stores its local database, settings, provider environment file,
generated artifacts, logs, and browser state under `~/.jobctrl` by default.
Most users should leave this location unchanged. Advanced users can set
`JOBCTRL_DIR` before starting JobCtrl to relocate the entire local data
directory. See
[Data, Privacy & Safety](data-and-safety.md) for what stays local and what may
leave the machine. Contributors who need custom data paths, ports, Temporal
settings, API/Vite proxy targets, or isolated stacks should use
[Local Development → Runtime Overrides](../local-development.md#runtime-overrides).

## LLM Providers

Choose one provider in **Settings → Credentials**, restart the relevant Python
process after a Keychain edit, and use `jobctrl doctor`. The pipeline model spec defaults to `default`, which resolves
through a ready provider. Explicit model specs use `codex:`, `claude:`, or
`google:`; `gemini:` remains an alias for the Google SDK route.

After first setup or whenever provider authentication changes, run:

```bash
jobctrl setup
jobctrl doctor
```

`jobctrl setup` detects existing authentication before prompting and writes
only local configuration; it never commits or ships credentials. `jobctrl
doctor` then reports which providers are ready without printing their secrets.

Model selection becomes available only after the corresponding provider is
ready. Codex, Claude, and Google choices come from the same authenticated
provider runtimes that execute the work: Codex App Server `model/list`, Claude
Agent SDK initialization metadata, and the Google SDK model list. JobCtrl does
not maintain a second hard-coded model registry. The picker shows the exact
runtime model ID alongside a friendly name when they differ. Only provider and
model IDs are written to `config.json`; credentials remain on the credential
boundary. A model absent from the active runtime catalog is intentionally not
selectable, even if that model exists in the provider's broader product lineup.

A saved preference is scoped to its provider and cannot change which provider
JobCtrl selects. Newly constructed adapters use this precedence:

1. explicit non-default workflow model;
2. saved preference for the selected ready provider;
3. that provider's default.

Provider selection itself keeps the default readiness order Claude, then
Codex, then Google. Explicit `provider:model` workflow values select the named
provider. Existing adapters and in-flight work keep their resolved model. Newly
started work rechecks the effective selection when it acquires the shared
adapter and receives a new adapter object when the saved preference changed; no worker
restart is required for a preferred-model edit. The initially selected ready
provider stays process-stable on warm acquisitions so status checks do not rerun
for every workflow. Provider credential/readiness changes retain their existing
restart requirement (or require an explicit adapter reset).

The **Employer analysis perspectives** selection is also saved here. Its
execution behavior belongs to the Discover preparation workflow and is
documented under
[Discovery → Employer Analysis Perspectives](discovery.md#employer-analysis-perspectives).

### Codex

JobCtrl requires an already authenticated Codex CLI and reuses that
authentication. Install Codex CLI and complete its supported sign-in flow
before verifying it in JobCtrl.

Advanced operators can set `JOBCTRL_CODEX_BIN` to override the Codex runtime.
By default, JobCtrl uses its pinned, bundled `openai-codex-cli-bin` binary.

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
loadable service-account JSON file. The path is write-only and is not shown again.
Otherwise JobCtrl checks the standard local gcloud ADC location, whose
officially loadable ADC types (including `authorized_user`) remain supported.

## LLM Spend Budget

### Daily LLM budget {#runtime-setting-daily-llm-budget}

The daily LLM budget is stored in `config.json` and edited in **Settings →
General** (`dailyBudgetUsd`, default `25`; `0` means unlimited). Workflows that spend LLM tokens run a
budget preflight before their heavy activities and stop with a non-retryable
budget error once the estimated daily spend reaches the ceiling.
`GET /v1/health` reports today's estimated spend against the configured
budget.

## Execution Concurrency

Settings separates pipeline parallelism from the worker capacity that executes
it. Increasing either value does not create provider quota or bypass the daily
budget.

### Concurrent applications {#runtime-setting-concurrent-applications}

**Concurrent applications** (`applyConcurrency`, default `1`) limits how many
application jobs the standing Apply loop may process at the same time. The loop
re-reads the saved value from `config.json` on its next poll. It does not control
Score, Tailor, Cover, or the number of Temporal activities the worker can run.

### Pipeline internal concurrency {#runtime-setting-pipeline-internal-concurrency}

**Pipeline internal concurrency** (`pipelineInternalConcurrency`, default `1`)
is one saved value shared by manual Pipeline actions and automatic Score →
Tailor → Cover preparation after a profile update. Changing the field on the
Pipelines page saves the same `config.json` value shown under **Settings →
General**; newly started batches use it. Existing in-flight workflows keep the
value they started with.

This setting controls parallel work inside a pipeline batch. It does not create
Temporal activity slots, and effective execution remains bounded by the active
worker capacity.

### Worker activity slots {#runtime-setting-worker-activity-slots}

**Worker activity slots** (`workerActivitySlots`, default `4`) is the desired
total Temporal activity capacity for the Python worker. A saved change requires
a worker restart. The Settings screen shows both the desired value and the
active value reported by the worker so pending restart state is explicit.

This capacity is distinct from **Pipeline internal concurrency**:
activity slots bound how many activities can execute at once, while internal
concurrency bounds parallel work inside an activity or batch. Temporal queues
work above the active slot count.

## Compensation Sources

**Settings → General → Compensation sources** stores the non-secret source and
access-policy choices in `config.json`. Saving the setting changes policy only;
it does not connect to a provider or fetch a feed.

[Compensation Evidence](compensation-evidence.md) owns the source modes,
licensing boundaries, refresh behavior, provenance, normalization, and
confidence rules. Provider payloads, restricted datasets, and credentials are
not general settings and must never be committed.

## Observability

| Variable | What it does |
| --- | --- |
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL` | Enable OpenTelemetry export of LLM, workflow, and JSON-RPC spans to Langfuse. |
| `LANGFUSE_DISABLE=1` | Disable export even when credentials are present. |
| `LANGFUSE_OTEL_TIMEOUT_SECONDS` | OTLP/HTTP export timeout, default `5.0`. |
| `JOBCTRL_ENV` | Environment attribute stamped on exported traces, default `local`. |

When enabled, export is metadata-only: provider/model identifiers, operation or
stage, success/failure, token counts, and safe size metrics. Raw prompts,
messages, job text, profiles, generated materials, completions, credentials,
local paths, logs, and database content are not span attributes.
