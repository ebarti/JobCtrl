# Profile & Settings API

This route family owns candidate facts, preferences, discovery configuration,
ordinary settings, and credential references. The important distinction is
authority: profile facts and preferences live in the profile model; runtime
settings control product behavior; secrets use the credential boundary.

For every request/response field, use the
[complete contract](complete-contract.md#profile-and-preferences).

## Candidate Profile

| Route | Purpose |
| --- | --- |
| `GET /v1/profile` | Read the normalized candidate profile and current preferences. |
| `PATCH /v1/profile` | Save validated profile fields and preference changes. |
| `GET /v1/profile/preview.html` | Render the baseline profile resume as HTML. |
| `GET /v1/profile/preview.pdf` | Render the baseline profile resume as PDF. |

Profile writes are explicit saves/autosaves of canonical candidate data. A job
tailoring run consumes a versioned snapshot; it does not silently mutate the
profile to fit a posting.

## Discovery Controls

| Surface | Representative routes |
| --- | --- |
| Runtime discovery preferences | `GET/PATCH /v1/discovery/settings` |
| Source registry | `GET/POST /v1/discovery/sources`, source state and preview routes |
| Review queues | locator candidates, quarantine, and manual-capture routes |
| Feedback | discovery feedback and role-match decision routes |

These controls decide where discovery may look and how proposed sources or jobs
enter the system. They do not hold provider credentials or raw feed contents.

## Settings And Credentials

| Route | Storage boundary |
| --- | --- |
| `GET/PATCH /v1/settings` | File-backed non-secret Settings values in [`config.json`](#config-json-field-reference); no Discovery-page values. |
| `GET/PATCH /v1/discovery/settings` | SQLite-backed discovery controls, including scheduling. |
| `GET /v1/credentials` | Availability/status metadata, not secret values. |
| `PATCH /v1/credentials` | Store or replace a credential through the local credential adapter. |
| `PATCH /v1/credentials/batch` | Atomically replace or remove one guided provider configuration. |
| `DELETE /v1/credentials/:key` | Remove a stored credential. |
| `GET /v1/providers/status` | Read-only sanitized Codex/Claude/Google configuration and readiness; never copies ambient Codex auth. |
| `GET /v1/providers/models` | Read-only sanitized model choices in stable Codex/Claude/Google order from each authenticated provider runtime; never copies ambient Codex auth. |
| `POST /v1/providers/codex/verify` | Explicitly validate and import a reusable normal Codex CLI `auth.json` once when isolated auth is absent, then verify isolated auth without a model call. |
| `GET /v1/extension/pairing-token` | Read the local extension pairing state. |
| `POST /v1/extension/pairing-token/rotate` | Rotate the token immediately and disconnect existing extension clients. |
| `GET /v1/browser-capabilities` | Read managed/optional capability states plus transient supported-browser candidates and their selectable profiles as opaque IDs and safe labels; no local path is returned or adopted. |
| `POST /v1/browser-capabilities/:capabilityId/enable` | Explicitly adopt exactly one transient `detectedBrowserId` or one write-only `executablePath` for an optional capability. |
| `POST /v1/browser-capabilities/:capabilityId/disable` | Disable an optional capability immediately. |
| `POST /v1/browser-capabilities/authenticated-linkedin-browser/profile-copy` | Copy exactly one explicitly selected detected profile by opaque browser/profile IDs, retain the legacy browser-only Default arm, or accept one write-only manual source path; every arm requires explicit consent. |

Credential responses expose enough state for the UI to show whether a provider
is configured, but do not return stored secret material. Guided provider
replacement rolls back on failure; an unrecoverable rollback is reported as an
explicit sanitized store failure. See the
[Security guide](../user/security.md) for the user-facing trust boundary.

The Codex verify response remains secret-free: it reports only provider,
boolean result, bounded status, and a bounded message. The explicit import
never overwrites JobCtrl's existing isolated auth or changes the normal Codex
home. It invokes the same copy-once behavior retained by setup and generation.

Browser detection is read-only discovery, not consent. The list response may
offer supported Chrome/Chromium candidates as bounded `{ id, label, profiles }`
values. Each profile contains only an opaque transient ID and Chrome's bounded
display label; executable, user-data, and profile paths stay inside the worker,
and nothing is launched, copied, or persisted. Enablement is a strict XOR input: send either
`{ detectedBrowserId }` or `{ executablePath }`, never both or neither. A
detected ID is resolved again at mutation time. If it is stale or no longer
available, enablement fails closed with `400 browser_capability_failed` and
does not retain or fall back to an earlier path.

`PATCH /v1/settings` stores provider-scoped model choices as
`preferred_models` in `config.json` and returns them as `preferredModels`.
Each supplied non-null ID must be in the current catalog for a ready provider;
`null` clears a choice even when that provider is unavailable. The setting
contains provider and model IDs only, never credentials or account metadata.
The settings and discovery responses also include effective-source and
activation metadata for managed controls.

### `config.json` field reference {#config-json-field-reference}

`~/.jobctrl/config.json` is one JSON object containing non-secret values owned
by the Settings routes. The API returns camel-case field names, while API
writes persist the canonical snake-case keys below.

This file owns General settings, provider connection metadata, model-execution
policy, compensation-source policy, and browser-adoption metadata. Every
durable control composed on `/discovery` is stored in SQLite instead.

| File field | Value and default | Meaning |
| --- | --- | --- |
| `apply_concurrency` | Integer `1–16`, default `1` | Maximum number of Apply jobs processed concurrently by the standing loop. |
| `pipeline_internal_concurrency` | Integer `1–16`, default `1` | Shared internal parallelism for newly started manual Pipeline actions and automatic profile-update preparation batches. |
| `worker_activity_slots` | Integer `1–64`, default `4` | Desired Python Temporal activity capacity. A saved change becomes active after the worker restarts. |
| `daily_budget_usd` | Non-negative number, default `25` | Daily LLM spend ceiling in USD. `0` disables the daily ceiling. |
| `analysis_legs` | Non-empty array of `codex`, `claude`, and/or `google`; default all three | Provider legs used by newly started employer-analysis work. |
| `tailoring_generator_models` | Non-empty array of model IDs or `null`; default `null` | Ordered generator-model policy for newly started tailoring workflows. `null` uses the provider/default policy. |
| `tailoring_judge_model` | Model ID or `null`; default `null` | Judge model for newly started tailoring workflows. `null` uses the provider/default policy. |
| `tailoring_judge_min_score` | Number `0–1`, default `0.82` | Minimum judge score for accepting a tailored candidate. |
| `apply_max_budget_usd` | Non-negative number, default `5` | Per-application AI-agent budget cap in USD. |
| `apply_timeout_seconds` | Integer `60–3600`, default `900` | Time limit for one application agent run. |
| `score_criteria` | String up to 8,000 characters, default `""` | User scoring guidance consumed by subsequent scoring runs. |
| `target_criteria` | String up to 8,000 characters, default `""` | Additional target-company or role guidance consumed by subsequent scoring runs. This is guidance, not the target-search title list. |
| `preferred_models` | Object keyed by `codex`, `claude`, and/or `google`; default `{}` | Preferred model ID for each provider. It contains model identifiers only, never credentials. |
| `compensation_sources` | Optional object; absent by default | Saved user-owned Levels.fyi and Glassdoor source-policy choices. It is written through `/v1/compensation/sources`, not `/v1/settings`. |
| `provider_connections` | Optional object; absent by default | Non-secret Claude/Google route, project, region, profile, and credential-path configuration written through the Credentials API. Actual API keys remain in Keychain. |
| `browser_capabilities` | Optional object; absent by default | Non-secret adoption metadata for optional system-browser capabilities. Copied browser contents remain outside this file. |

Within `compensation_sources`, the supported source keys are `levels_fyi` and
`glassdoor`. Each source stores `enabled` and `access_mode`; `levels_fyi` also
stores `europe_coverage_confirmed`. These are policy declarations only: the
file does not contain credentials, feed locations, or compensation records.

## Which Screen Owns What?

| Screen | Owns |
| --- | --- |
| Profile (`/profile`) | Candidate facts, experience, skills, evidence, resume content. |
| Preferences (`/preferences`) | Target role, location, work model, and fit/tailoring preferences. |
| Discovery (`/discovery`) | Target search, sources, scheduling, quarantine, and capture controls. |
| Settings → General (`/settings`) | Spend/apply/worker controls and compensation source policy (not a feed connection). |
| Settings → Credentials (`/settings/credentials`) | Provider modes, credential presence, and explicit Codex verification. |
| Settings → Model selection (`/settings/models`) | Provider-scoped preferred model IDs plus analysis and tailoring execution policy. |
| Settings → Browser & extension (`/settings/browser`) | Browser capability adoption/removal, consented profile copy, and extension pairing/rotation. |

This split keeps a configuration change from masquerading as candidate evidence.
