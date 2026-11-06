# Profile transformation implementation record

Feature issue: #1430. Parent: #1428. This records the implementation in the
shared transformation branch; it does not establish release or deployment.

## Capability inventory and ownership

| Existing capability | Target owner and public path |
| --- | --- |
| Candidate facts, authored experience/summary, education, skills and voluntary fields | `features/profile/service.py`, `GET/PATCH /v1/profile` |
| Application attestations, preferences, writing preferences, baseline rendering settings and authored template text | Complete Profile document plus `style` and `templateText`; version-fenced Profile save |
| Achievement evidence and confirmation authority | Immutable source versions and exact decisions; `/v1/profile/sources` and source confirmation action |
| Historical original/current confirmation review, recovery and explicit decisions | Profile legacy-evidence service and `/v1/profile/legacy-evidence` routes; runtime-owned CLI adapter |
| PDF import with selected section acceptance | Injected `ResumeImportPort`, `pdf_import.py`; model extraction, recorded PDF/source receipt and exact acceptance transaction |
| Required-bullet coaching | Shared model gateway with saved source citations; returned source IDs are actual achievement IDs, with exact saved field positions |
| Target-role and historical preference suggestions | Shared model gateway; unselected source-bound suggestions, exact receipt-linked user acceptance |
| Baseline HTML/PDF preview | Profile route calls the public Resumes preview renderer; no model calls; HEAD never invokes rendering |
| Complete profile-only transition | `transfer.export_legacy_profile`, `export_profile`, `import_profile`; source remains untouched and existing target Profile refuses overwrite |
| Approved wording alternatives | Profile wording library with exact approve/reject/defer decisions; alternatives remain under their original achievement |

The retired normal runtime used both `apps/api/src/profile-store.ts` and
`infrastructure/profile/sqlite_repository.py` as writers, with separate
Python coaching/import models. The target feature does not import either
writer, JSON-RPC handlers, legacy factories or old global configuration. Its
one-off transfer decoder reads the historical SQLite layout directly; it does
not instantiate a legacy runtime or business store.

## Public interfaces

`bootstrap.build_feature(runtime, **ports)` registers the actual service,
Starlette routes and explicit durable actions. The service depends on
feature-owned `ProfileStore`, `SemanticPort` and `ResumeImportPort` protocols.
SQL, SQLite connections, process recovery checks and transactions belong to
the repository/import/transfer adapters. Pure models and application actions
do not import HTTP, SQLite or Temporal SDKs.

`ProfileService.snapshot(profile_id="default", connection=None,
tenant_id="local")` returns an immutable `ProfileSnapshot` with:

- `profile_id`, `profile_revision`, `fact_semantics_version`,
  `wording_revision` and `fingerprint`;
- a copied complete `document`, plus saved rendering style/template;
- ordered `roles`, each with every authored achievement and its
  `achievement_id`, `baseline_variant_id` and exact `source_refs`;
- `evidence_sources` with stable IDs, revisions, literal source text,
  confirmation/provenance and supporting attachment records;
- only source-current approved variants, after joining their exact recorded
  wording approval IDs, texts and source references.

`to_dict()` returns a JSON copy of the entire snapshot; `document` and
`as_dict()` return copied authored Profile data with current confirmation
authority projected honestly. Raw historical source cells remain preserved in
owned storage and transfer provenance. A bare historical `user_confirmed`
flag does not appear as a current confirmed fact.

`assert_current(snapshot, connection=None, facts_only=False)` fences reads in
the caller's canonical transaction. Fit may use `facts_only=True`: approving
wording does not invalidate factual qualification. Full document readers can
fence the complete snapshot. No consumer reads Profile's private tables.

`request_authoring(brief, cancelled=...)` accepts an immutable `AuthoringBrief`
containing the caller's stable `origin_key`, exact Profile/factual revisions,
one `achievement_id`, source/version references, persisted support receipt
reference, requested expression and opaque origin metadata. Profile imports no
Fit/Requirements implementation and stores no requirement matches or scores.
It includes the exact original achievement source in the model input and
persists the gateway receipt, response and source binding. Distinct concurrent
proposals can publish when their factual sources remain current; unrelated
wording changes do not make them stale.

`get_authoring_request(origin_key, ...)` and
`get_authoring_proposal(proposal_id, ...)` expose retained status. Repeated
origins reuse pending, approved, rejected, deferred, failed or interrupted
records without another model call. Rejection/deferment is not silently
regenerated for another job.

`approve_authored_variant(profile_id, expected_profile_revision,
achievement_id, text, source_refs, user_confirmed=True, connection=None)` is
the exact user-authorized edit boundary used by Resumes. It never promotes a
new factual qualification. A source-current identical approved variant is
reused; otherwise the exact text, sources and approval remain recorded.

Every role's `achievement_ids` travels alongside its ordered string bullets.
New client-generated opaque UUID identities are preserved. Duplicate IDs,
foreign-role ownership and changed bullet lists without saved identities
refuse. Reordering and editing do not use positional meaning guesses.

Canonical sources, baseline variants and coaching references use a kind
namespace plus a hash of canonical JSON containing explicitly ordered identity
tuples. Source tuples include the Profile ID, so punctuation in opaque role or
evidence identifiers cannot merge two records or share confirmation authority.
Attached intake IDs retain their exact original value separately from their
canonical storage identity. Original authored IDs and structural JSON paths
remain intact. Imported document entry IDs use a fixed server-issued UUID and
numeric index; their typed boundaries are unambiguous and duplicate entries
refuse rather than replacing existing authored data.

The [Profile API owner](../api/profile-and-settings.md#candidate-profile)
documents the actual routes and wire fields. Empty first-run source and
wording readers return honest 200 empty states with `profileVersion: null`;
they do not invent a role, evidence or an approval.

## Authority and failure invariants

Profile saves perform no model calls. Every accepted mutation and its bounded
invalidation commit in the same transaction. Stale profile/source/wording
versions refuse without partial writes. Source history, previous Profile
versions, decisions and approved wording remain inspectable.

New semantic calls go through the shared model gateway, including configured
lane/spend admission. Missing persisted gateway provenance, malformed/schema
output, foreign IDs, non-verbatim citations and inconsistent output refuse.
No lexical matching or semantic fallback is used. Whitespace cleanup is only
a literal formatting operation after an explicit model grammar finding.

Source confirmation is a separate explicit current-text decision. Incoming
Profile flags cannot create authority or clear unresolved historical review.
Confirmed reads rejoin the exact source decision or validated historical
receipt. Historical unassigned metric indexes remain preserved data and are
not published as independent factual evidence.

Cancellation is checked before authoring starts and again inside publication.
An interrupted request retains failed/interrupted status and its original
brief. Existing approved wording is preserved. Durable PDF import receives a
stable attempt identity from the action run; an already committed draft is
returned after an acknowledgement loss instead of repeating extraction.

GET/HEAD paths cannot enter mutation branches. Preview HEAD returns only
format headers and never invokes the renderer. Events contain identifiers and
versions, not source bodies, PDFs, private Profile values or model prose.

## Full-profile one-off transfer

The legacy transfer bundle contains complete Profile rows, authored baseline,
evidence, preferences/rendering settings, original confirmation events,
Profile extraction/coaching/interpretation receipts and source bindings.
Historical confirmations are checked against the exact current original row,
the recorded human-review event and its previous-event chain. Missing or
damaged authority remains review required. Original cells are retained even
when current authority is uncertain.

The old SQLite importer did not contain uploaded PDF bytes. The browser owner
therefore exports a read-only `jobctrl.profile-browser-sources.v1` supplement
from the current origin's selected/legacy uploads and exact review/recovery
records. It supplies source record identities, known attachment IDs, original
bytes/digests, raw records and explicit unavailable references. A read/hash or
concurrent storage change produces an incomplete export. Known held bytes
cannot be omitted. Historical bytes are preserved without imposing a new
transfer size/signature requirement; malformed historical bytes remain marked
as such instead of disappearing.

Missing/incomplete browser supplements refuse before target Profile creation.
Already unavailable historical references remain honestly unavailable. The
runtime owns explicit cutover authorization and destination-workspace
admission. No real-user reset or real workspace transfer was executed during
development. Target-to-target export/import retains every Profile-owned row,
stable ID, source/approval history and attachment byte exactly.

## Observed verification

All checks used owned synthetic workspaces under
`/private/tmp/jobctrl-transform-1428`. Proof scripts/artifacts remain private
temporary QA data and are not committed replay fixtures or eval corpora.

| Proof | Observed result |
| --- | --- |
| `profile-core-proof.py` | Real Python HTTP server with Profile/Jobs/Requirements/Fit/Resumes: create/edit, all roles/achievements retained, exact wording approval/defer, unchanged factual revision after wording decisions, source confirmation, stale conflicts, two racing saves with exactly one winner, malformed body/PDF refusal, HEAD write bodies causing zero state/event changes, all preview HEAD aliases creating no artifacts, complete real HTML preview. PASS. |
| `profile-recovery-proof.py` | The core HTTP journey plus exact confirm/reject/defer decisions on three saved evidence sources. Authority-unavailable recovery preserves all three decisions, source revisions and Profile version instead of downgrading known decisions. PASS. |
| `profile-identity-proof.py` | Actual HTTP preserves independent evidence for opaque `a:b`/`c` versus `a`/`b:c` identifiers; confirming one cannot confirm its peer. Role/preference and attached/canonical namespaces remain distinct, attached updates retain original intake identity, all raw authored IDs survive and baseline variant IDs remain distinct. PASS. |
| `profile-provider-proof.py` | Real HTTP/shared gateway/SQLite and controlled external provider only: target-role receipt acceptance, actual stable coaching IDs, invalid foreign citation preserving the accepted library, real PDF text extraction with no fact mutation, exact selected-section acceptance and original PDF bytes retained. PASS. |
| `profile-authoring-proof.py` | Registered `Application.execute` action, shared gateway and controlled external provider: two concurrent independent proposals, zero-call reject/defer origin reuse, stable factual revision, invalid-citation preservation and explicit cancellation during provider wait refusing publication. PASS. |
| `profile-transfer-proof.py` | Separate one-off canonical historical SQL fixture to fresh target: full Profile/baseline integrity, validated known versus unknown confirmation authority, browser PDF bytes/raw review data retained, exact source DB digest unchanged, unrelated edit retaining human authority, exact target round trip, overwrite refusal and incomplete-browser refusal before mutation. PASS. |
| Scoped static checks | Profile Ruff, Python compilation and changed-document whitespace checks. PASS. Current Python canonical saved shape equals the current TypeScript `ProfileSchema.parse` result in a structural comparison. |

The direct action proof does not establish Temporal worker restart behavior.
The shared E2E owner owns browser journeys, real Temporal cancellation/restart,
CI routing/timings and final composed-application coverage. Controlled provider
proof establishes authority and failure handling, not semantic accuracy of a
real model. No real provider, real Profile, application submission or external
communication was used by this workstream.
