# Profile and Settings API

The Python transformation is in progress. Profile and foundation adapters own
their respective HTTP contracts; this page states target semantics, not a
verified exhaustive wire schema. Read the current feature implementation and
exercise the composed application before relying on a specific route.

## Candidate Profile

The Profile feature owns facts, source attachments, evidence, confirmations,
preferences, the complete authored baseline and wording text/approval. It imports
no Fit or Requirements implementation. Other owners consume immutable public
snapshots and source/revision guards.

| Route | Contract |
| --- | --- |
| `GET /v1/profile` | `{ok, profileVersion, profile, style, templateText}`; initialized profiles also expose `factSemanticsVersion` and `wordingRevision`. |
| `PATCH /v1/profile` | Requires `expectedProfileVersion` (`null` for creation); accepts `profile`/`profileText`, `style`/`styleText`, and/or `templateText`. |
| `GET /v1/profile/sources` | `{ok, profileVersion, sources}` with stable `source_id`, `revision`, literal `text`, `kind`, provenance and confirmation status. |
| `POST /v1/profile/sources` | `{expectedProfileVersion, source}` adds or revises owned supporting evidence; attachment bytes require their SHA-256 digest. |
| `POST /v1/profile/sources/{source_id}/confirmation` | Requires `expectedProfileVersion`, `expectedSourceRevision`, `exactText`, and `decision: confirm\|reject\|defer`. |
| `GET /v1/profile/wording` | `{ok, profileVersion, wordingRevision, roles, variants, proposals}`. Every role retains ordered achievement IDs and its baseline variant IDs. |
| `POST /v1/profile/wording` | `{expectedProfileVersion, achievementId, text, sourceRefs}` creates a pending manual variant. |
| `POST /v1/profile/wording/{variant_id}/decision` | Requires `expectedProfileVersion`, `expectedVariantRevision`, `exactText`, and `decision: approve\|reject\|defer`; returns the refreshed library. |
| `POST /v1/profile/import-resume` | `{filename, pdfBase64, importProfile?, importStyle?}` extracts a recorded draft with `source.attemptId`, `determinationId`, observed style and the original base Profile version. |
| `POST /v1/profile/target-role-suggestions` | `{expectedProfileVersion, maximumSuggestions?}` requests 1–5 source-bound, unselected model suggestions; no search consent is inferred. |
| `POST /v1/profile/required-bullet-suggestions` | `{expectedProfileVersion, maximumSuggestions?}` requests 1–24 source-bound coaching findings, joining actual achievement IDs and saved positions. |
| `GET /v1/profile/preview.html` / `.pdf` | Render the complete saved baseline through the public Resumes renderer with zero model calls. Slash-form preview aliases are also retained. |
| `GET /v1/profile/legacy-evidence` | Inspect original/current cells, conflicts, historical receipts and exact review tokens. |
| `POST /v1/profile/legacy-evidence/recover` | `{expectedProfileVersion, bundle}` inventories a retained legacy Profile export without replacing authored facts. |
| `POST /v1/profile/legacy-evidence/decision` | Exact source confirmation fields plus `sourceId` and `token`; only `confirm` or `reject` is accepted. |

A source reference is `{source_id, revision}`. Confirmation is `confirmed`,
`authored`, `unconfirmed`, `review_required`, `rejected` or `deferred`. Authored
baseline data is distinct from independently confirmed evidence. Incoming
`user_confirmed` or `confirmation_review_required` flags cannot manufacture or
clear persisted authority. Wording status is `approved`, `pending`, `rejected`,
`deferred` or `stale`. An approved variant carries an exact `approval_id`,
`revision`, text and source references; readers rejoin the recorded approval.
Canonical source and derived baseline-wording IDs are opaque hashes of a
namespace and an explicitly ordered identity tuple, including the Profile ID.
Readers use returned IDs and source `path`/`role_id`/`evidence_id` metadata;
they never reconstruct composite IDs from punctuation in authored identifiers.
A new attached source's caller-supplied intake ID is retained exactly as
`authored_source_id`; use its returned canonical `source_id` for later edits or
confirmation. Raw authored role, evidence and achievement IDs remain unchanged.

Before initialization, Profile returns an empty editable draft with
`profileVersion: null`. Source and wording reads return 200 empty collections;
the empty wording library has `wordingRevision: 0`. They do not invent an
experience role or any source/approval authority. Saving an initialized baseline
requires at least one authored role. GET/HEAD readers never enter write paths,
and preview HEAD returns format headers without launching the renderer.

Every mutation compares and writes under the same SQLite transaction as its
committed invalidation. Conflicts return `409 revision_conflict`, with the safe
reason such as `stale_profile_version`, `stale_source_revision` or
`stale_wording_revision`. Validation returns `400`; provider/output failures use
the shared gateway's safe error envelope. No private source/model text enters
SSE. `ProfileUpdated`, `ProfileSourceUpdated` and `ProfileWordingUpdated` contain
only IDs and the committed Profile version. Unchanged Profile saves do not
advance its version or emit an update.

Factual source changes advance `factSemanticsVersion`. Approving or rejecting
wording advances the overall Profile and wording revisions without changing
factual fit. Failed authoring preserves accepted variants and records its
failed request separately. An immutable authoring brief is deduplicated by its
caller-owned `origin_key`; rejected and deferred requests are not regenerated
for each job.

PDF extraction uses the configured model with verbatim field spans. Import
acceptance rejoins the recorded attempt/determination and selected sections in
the version-fenced Profile transaction. It appends experience/education/skills,
changes only selected personal fields/summary, retains original source bytes and
never creates confirmed achievement evidence. Invalid extraction or acceptance
leaves the saved Profile and draft recovery data unchanged.

Coaching findings retain their exact per-finding `citations`; the response also
retains the recorded root `citations`, `rationale`, `determinationId` and
provider provenance. `GET /v1/profile/determinations/{determinationId}` exposes
the feature-owned recorded request, result, source/Profile revision and gateway
receipt metadata for inspection. A no-model empty inspection invents no receipt.

The one-off transfer API is `features.profile.transfer.export_legacy_profile`,
`export_profile` and `import_profile`. The legacy exporter reads SQLite without
writing and requires a complete `jobctrl.profile-browser-sources.v1` supplement
for import. Known browser-held PDF bytes cannot be dropped; incomplete transfers
return `409 profile_transfer_incomplete` before creating Profile state. Historic
unavailable references remain explicit. Target export/import preserves every
Profile-owned row, source/wording/approval ID and supporting attachment byte.
See [Candidate Profile](../user/candidate-profile.md#preserve-profile-during-the-fresh-state-transition).

## Settings and Credentials

Foundation owns the reserved `/v1/settings` and `/v1/credentials` boundaries.
Settings must not expose secret values. Credential mutations, storage and
failure responses must preserve the [security boundary](../developer/security.md).
The Python HTTP server, CLI and workers must use the same effective settings
and canonical feature services, rather than independent business writers.

## Config JSON Field Reference

Configuration field names and defaults are determined by the integrated Python
settings adapter. Consult that implementation before relying on an old field or
restart claim. Settings and credentials have different storage and disclosure
rules; never put a secret in general settings, events or diagnostic output.

## Provider Endpoint Compatibility

Model operations use the configured provider/model through the shared gateway.
Lane/spend preflight, strict source-bound response validation and provenance are
required. A provider being configured is not proof that a specific model or
operation is available. Failure or invalid output has no lexical fallback.

## Discovery Controls

Search targets, source enablement and schedules belong to Discovery even when a
Settings page links to them. A disabled optional feature must not alter Profile
ownership or remove manual Jobs.
