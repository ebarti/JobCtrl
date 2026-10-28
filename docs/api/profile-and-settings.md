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
| `POST /v1/profile/target-role-suggestions` | Generate transient evidence-backed role proposals from an exact saved profile version. |
| `POST /v1/profile/required-bullet-suggestions` | Inspect LLM coaching for Required bullets from an exact saved profile version. |
| `GET /v1/profile/preview.html` | Render the baseline profile resume as HTML. |
| `GET /v1/profile/preview.pdf` | Render the baseline profile resume as PDF. |

Profile writes are explicit saves/autosaves of canonical candidate data. A job
tailoring run consumes a versioned snapshot; it does not silently mutate the
profile to fit a posting.

`GET /v1/profile` may include `legacyEvidenceReview: { status:
"review_required", count }`. Affected achievement entries retain their original
`user_confirmed` value and expose computed `confirmation_review_required: true`.
Clients cannot clear that authority marker by saving a false flag. The bounded
local [legacy review commands](../user/candidate-profile.md#review-legacy-confirmations)
record explicit human decisions; this adds no browser mutation endpoint. Evidence
Map freshness exposes `confirmationReviewRequired` and interview choices exclude
pending rows. Private inventory and review payloads never enter generic SSE.
Unresolved canonical authority reports `legacy_evidence_review_required` before
new evidence-based generation, preserving accepted artifacts.

`GET /v1/profile` includes `profileVersion` (`null` before initialization, then
a positive monotonic integer). The API remains backward-compatible with
callers that omit `expectedProfileVersion`, but the web form includes its saved
base version on every full-profile manual and autosave write. It omits the field
only for the initial save while the version is `null`. A suggestion-derived
save uses its reviewed version. The API compares and writes in one transaction;
a mismatch returns `409
stale_profile_version`, writes no profile row, records no `ProfileUpdated`
event, and creates no preparation-continuation work.

Saving authored profile or preference edits never starts an LLM call. It returns
the committed version without waiting for target-role interpretation, scoring, or
material generation. Target-role suggestions run only after the user chooses
**Get suggestions for target roles** in Discovery.

The target-role suggestion route accepts `{ expectedProfileVersion, maximumSuggestions }`,
where the maximum is `1–5` and defaults to `3`. It reads only that canonical
saved snapshot and returns `profileVersion`, `strategy`, bounded `warnings`, and
zero to five editable role suggestions and up to five historical preference
rows. Each role suggestion includes `title`,
`classification` (`direct` or `adjacent`), an explicitly supported `track` and
`seniority`, a concise `rationale`, and valid evidence references. Generation
is transient: it writes no role, profile event, or Discovery plan. Only the
user's selected acceptance enters the normal profile save path, where roles are
appended and case-insensitively deduplicated instead of replacing existing
values. Each `preferenceSuggestions[]` row has `location` (possibly empty),
`workModel` (`Remote`, `Hybrid`, `On-site`, or empty), and canonical experience
`evidenceIds`. Location and model remain paired by row position, including an
empty counterpart. All role and historical preference rows are unselected by default; accepting a row
adds it to the draft without changing existing location/model pairs. Normal
profile place validation applies when the draft is saved.
The Discovery compiler preserves empty positional counterparts: a model-only
Remote row does not make a following city remote, and a location-only row keeps
its local search behavior. It does not invent a city for a model-only Hybrid or
On-site row. Rows with neither field set are jointly discarded before the
home-location fallback and Discovery overlay.

The API binds the RPC request to its trusted app-directory and database
identity; those values are never accepted from the browser. The worker checks
that identity before loading the profile snapshot. The currently managed
Claude, Codex, and Google SDK adapters cannot enforce this feature's requested
output-token ceiling and conservative maximum call cost, so the production RPC
does not invoke them. The production `deterministic` strategy uses exact saved
experience titles and a small conservative adjacent-title policy. An adjacent
title needs cited experience and independently relevant achievement evidence;
every substantive title modifier must be supported, and saved track and
seniority must match. Zero roles remain valid for sparse or incompatible
evidence. The `model` strategy remains reserved in the wire contract and is
exercised with synthetic adapters in domain tests; production does not emit it.
The `provider_token_or_cost_bound_unsupported` warning explains that no model
ran. Historical location rows come only from explicit experience locations;
work models require an unambiguous exact marker in that field. Neither past
location nor work arrangement expresses present search willingness.

If a suggestion-derived save conflicts with a newer canonical profile, the web
keeps the local draft but does not authorize it with the newer version. The user
must explicitly rebase non-overlapping edits onto the refreshed snapshot,
regenerate suggestions, review them, and then save against that new version.
The guard covers accepted roles and historical preference rows, including
subsequent edits to those draft values.
A common sequence of appended bullets can be combined with later additions and
independent edits to existing bullets. Deletions, reordered originals, duplicate
texts, competing appended sequences and conflicting edits to the same original
bullet remain blocked for manual resolution or discard.

Required-bullet coaching accepts a saved `expectedProfileVersion` and optional
`maximumSuggestions` (`1–24`, default `12`). It calls the configured LLM once
with selected saved bullets, role/company context and matching achievement
evidence. All coaching determinations come from the model; there is no heuristic
fallback. Source binding and acceptance remain version-checked, and only an exact
model-proposed whitespace cleanup can be applied automatically. Provider/invalid
response failures preserve saved facts and the previous reviewed suggestions.
Budget denial identifies daily spend or profile-lane token scope (429); provider
setup/authentication failure asks for connection in Settings (503). Other provider
failures and invalid responses return safe retry guidance (502). Admission checks
observed daily/lane usage; current SDKs do not enforce per-call token/cost ceilings.
The offline demo disables inspection and links to local installation. See the
[complete Required-bullet contract](complete-contract.md#candidate-profile) for
source fields, input/output limits, model-use flags and error codes.


## Discovery Controls

| Surface | Representative routes |
| --- | --- |
| Runtime discovery preferences | `GET/PATCH /v1/discovery/settings` |
| Source registry | `GET/POST /v1/discovery/sources`, source state and preview routes |
| Review queues | locator candidates, quarantine, and manual-capture routes |
| Feedback | discovery feedback and role-match decision routes |

Source-locator reads are strictly read-only. The opt-in
`source-proposals from-history` CLI path feeds the same queue and registry with
saved origin/extraction receipts and unknown completeness. Explicit review
records coordinate-scoped decisions; rejection persists until a CLI reset.
Promotion preserves an existing active overlap and refuses held/disabled
sources. See [Discovery](../user/discovery.md#propose-sources-from-saved-posting-history)
and the [wire contract](complete-contract.md#discovery-controls).

These controls decide where discovery may look and how proposed sources or jobs
enter the system. They do not hold provider credentials or raw feed contents.
The Manual Capture queue retains user-submitted pending page content locally for
review and retry; see the [capture contract](complete-contract.md#discovery-controls).

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
| `POST /v1/browser-capabilities/authenticated-linkedin-browser/profile-copy` | Backward-compatible operator API for copying one explicitly selected detected profile by opaque browser/profile IDs, retaining the legacy browser-only Default arm, or accepting one write-only manual source path; every arm requires explicit consent. It is not exposed by current Settings and is never used by integrated Discovery or Enrich. |

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
The same readiness and exact catalog membership checks apply to explicit
`defaultLlmModel`, `tailoringGeneratorModels` and `tailoringJudgeModel` choices. Provider-qualified
IDs use that provider's catalog; legacy bare IDs must be uniquely offered by a
ready provider and are saved with that provider prefix. Unoffered or ambiguous
choices return `400 invalid_default_model` for the default route or
`400 invalid_tailoring_model` for a material override; unavailable
providers return `409 provider_not_ready`, and a failed live catalog returns
`503 provider_models_failed`. Validation precedes every settings write, so an
invalid model cannot partially save other changes. `null` and provider-neutral
`default` material selections remain available without a catalog request.
The settings and discovery responses also include effective-source and
activation metadata for managed controls.

`codexReasoningEfforts` patches a mapping of bare Codex model IDs to effort IDs.
Each non-null effort must appear in that ready model's current
`supportedReasoningEfforts` catalog. Unsupported pairs return
`400 invalid_reasoning_effort`; readiness and catalog failures use the same
409/503 boundary as model choices. Validation is atomic with other settings.
A `null` entry clears just that model's effort without requiring provider
availability. Readback includes `codexReasoningEfforts` and its effective-source
metadata; the mapping persists as `codex_reasoning_efforts`.

The same route accepts `laneTokenLimits`, an object whose only valid keys are
`discovery`, `enrichment`, `scoring`, `tailoring`, `apply`, `contact`,
`interview`, `profile`, and `compensation`. Values are non-negative integers;
omitted keys and `0` mean unlimited. `GET /v1/settings` returns every known lane
with its effective value. Unknown keys, negative values, booleans, and
fractional values are rejected.

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
| `pipeline_internal_concurrency` | Integer `1–16`, default `1` | Shared internal parallelism for newly started manual Pipeline actions, automatic profile-update preparation, and idle recovery batches. |
| `worker_activity_slots` | Integer `1–64`, default `4` | Desired Python Temporal activity capacity. A saved change becomes active after the worker restarts. |
| `daily_budget_usd` | Non-negative number, default `25` | Daily LLM spend ceiling in USD. `0` disables the daily ceiling. |
| `lane_token_limits` | Object keyed only by the nine LLM product lanes, each a non-negative integer; default all `0` | UTC daily observed input-plus-output token thresholds. `0` means unlimited. |
| `analysis_legs` | Non-empty array of `codex`, `claude`, and/or `google`; default all three | Provider legs used by newly started employer-analysis work. |
| `default_llm_model` | Provider-qualified model ID or `null`; default `null` | Default route for newly acquired core model calls and the optional writing pass. Explicit workflow and material choices take precedence. `null` restores automatic provider selection. |
| `codex_reasoning_efforts` | Object mapping bare Codex model IDs to effort IDs; default `{}` | Explicit effort for newly constructed Codex adapters. Applies to thread and turn, overrides legacy numeric thinking budgets, and preserves unrelated models when patched. An absent entry retains existing per-call behavior. |
| `tailoring_generator_models` | Non-empty array of model IDs or `null`; default `null` | Ordered generator-model policy for newly started tailoring workflows. `null` uses the provider/default policy. |
| `tailoring_judge_model` | Model ID or `null`; default `null` | Judge model for newly started tailoring workflows. `null` uses the provider/default policy. |
| `resume_voice_polish` | Boolean, default `false` | **Extra résumé polish** under Settings → Model selection. Newly constructed résumé preparation skips the additional post-approval writing pass by default. `true` requests it; changed prose still needs fresh factual, quality and applicable persona reviews. Already-constructed résumé generations retain their choice and accepted artifacts are unchanged; queued or later Tailor steps read the new value, including within an existing workflow. |
| `cover_letter_generation` | Boolean, default `false` | **Generate cover letters** under Settings → Model selection; API field `coverLetterGeneration`. New preparation plans omit Cover when off. Generation admission and automatic recovery enforce the saved choice before starting a letter; accepted letters and already-admitted work remain intact. Enabling releases only this setting's own skipped Cover rows. |
| `tailoring_judge_min_score` | Number `0–1`, default `0.82` | Minimum judge score for accepting a tailored candidate. |
| `apply_max_budget_usd` | Non-negative number, default `5` | Per-application AI-agent budget cap in USD. |
| `apply_timeout_seconds` | Integer `60–3600`, default `900` | Time limit for one application agent run. |
| `score_criteria` | String up to 8,000 characters, default `""` | User scoring guidance consumed by subsequent scoring runs. |
| `target_criteria` | String up to 8,000 characters, default `""` | Additional target-company or role guidance consumed by subsequent scoring runs. This is guidance, not the target-search title list. |
| `preferred_models` | Object keyed by `codex`, `claude`, and/or `google`; default `{}` | Preferred model ID for each provider. It contains model identifiers only, never credentials. |
| `compensation_sources` | Optional object; absent by default | Saved user-owned Levels.fyi and Glassdoor source-policy choices. It is written through `/v1/compensation/sources`, not `/v1/settings`. |
| `provider_connections` | Optional object; absent by default | Non-secret Claude/Google route, project, region, profile, and credential-path configuration written through the Credentials API. Actual API keys remain in the native OS credential store. |
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
| Settings → Browser & extension (`/settings/browser`) | Apply-browser capability adoption/removal plus live-profile extension pairing, installation selection, status, and token rotation. It does not expose profile copying. |

This split keeps a configuration change from masquerading as candidate evidence.

## Provider Endpoint Compatibility

The provider family is declared in the shared endpoint registry and handled by
`apps/api/src/provider-handlers.ts`. Generated `providerStatus`,
`providerModels` and `verifyCodexProvider` clients parse the sanitized success
schemas. GET calls send no body; verification sends `{}` by default. The server
continues to ignore extra query/body inputs. Existing loopback Host/peer, CORS
and mutation Origin/Referer/capability checks apply before dispatch.

| Operation | RPC error | Invalid result | Transport failure |
| --- | --- | --- | --- |
| Status | 502 `provider_status_failed` | 502 `provider_status_failed` | 503 `provider_status_failed` |
| Models | 503 `provider_models_failed` | 503 `provider_models_failed` | 503 `provider_models_failed` |
| Codex verification | 502 `provider_verification_failed` | 502 `provider_verification_failed` | 503 `provider_verification_failed` |

Errors expose fixed messages, never dispatcher exception text or error data.
An unsuccessful verification result is still HTTP 200 with outer `ok: true`
and inner `verification.ok: false`, status `not_configured` or `failed`.
These synchronous routes do not require a healthy Temporal action worker.
Settings uses the same checked model-catalog function before accepting a
non-null preferred model; clearing a choice retains its readiness exception.

The demo retains disconnected synthetic status and a synthetic model catalog;
it cannot verify host authentication. Provider route tests inject synthetic
results and failures without accessing credentials. See the
[migration and verification boundaries](../architecture/contracts-types-and-api-boundaries.md#incremental-endpoint-migration).
