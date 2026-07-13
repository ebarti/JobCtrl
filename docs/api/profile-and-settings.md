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
| `GET/PATCH /v1/settings` | File-backed non-secret runtime settings in `dashboard.json`; not discovery scheduling. |
| `GET/PATCH /v1/discovery/settings` | SQLite-backed discovery controls, including scheduling. |
| `GET /v1/credentials` | Availability/status metadata, not secret values. |
| `PATCH /v1/credentials` | Store or replace a credential through the local credential adapter. |
| `PATCH /v1/credentials/batch` | Atomically replace or remove one guided provider configuration. |
| `DELETE /v1/credentials/:key` | Remove a stored credential. |
| `GET /v1/providers/status` | Read-only sanitized Codex/Claude/Google configuration and readiness; never copies ambient Codex auth. |
| `GET /v1/providers/models` | Read-only sanitized model choices in stable Codex/Claude/Google order; never copies ambient Codex auth. Codex and Google are live; Claude is explicitly provider aliases. |
| `POST /v1/providers/codex/verify` | Explicitly validate and import a reusable normal Codex CLI `auth.json` once when isolated auth is absent, then verify isolated auth without a model call. |
| `GET /v1/extension/pairing-token` | Read the local extension pairing state. |
| `POST /v1/extension/pairing-token/rotate` | Rotate the token immediately and disconnect existing extension clients. |
| `GET /v1/browser-capabilities` | Read the managed and optional browser capability states. |
| `POST /v1/browser-capabilities/:capabilityId/enable` | Enable an optional capability with an explicit, write-only browser executable path. |
| `POST /v1/browser-capabilities/:capabilityId/disable` | Disable an optional capability immediately. |
| `POST /v1/browser-capabilities/authenticated-linkedin-browser/profile-copy` | Copy a profile only with explicit consent; the source path is request-only. |

Credential responses expose enough state for the UI to show whether a provider
is configured, but do not return stored secret material. Guided provider
replacement rolls back on failure; an unrecoverable rollback is reported as an
explicit sanitized store failure. See the
[Security guide](../user/security.md) for the user-facing trust boundary.

The Codex verify response remains secret-free: it reports only provider,
boolean result, bounded status, and a bounded message. The explicit import
never overwrites JobCtrl's existing isolated auth or changes the normal Codex
home. It invokes the same copy-once behavior retained by setup and generation.

`PATCH /v1/settings` stores provider-scoped model choices as
`preferred_models` in `dashboard.json` and returns them as `preferredModels`.
Each supplied non-null ID must be in the current catalog for a ready provider;
`null` clears a choice even when that provider is unavailable. The setting
contains provider and model IDs only, never credentials or account metadata.
The settings and discovery responses also include effective-source,
editability, and activation metadata for managed controls; an environment-owned
field is read-only instead of being silently shadowed by a saved value.

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
