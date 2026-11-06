# Requirements

Requirements owns reusable qualified meanings, immutable meaning revisions,
posting occurrences, model equivalence/novelty authority and catalog retrieval.
`bootstrap.build_feature(runtime, jobs=...)` registers its actual HTTP routes and
durable actions. The application composition loads it after Jobs and before Fit.
It uses the public Jobs snapshot/current-version port and never accesses Jobs,
Profile or Fit private storage.

The previous employer-analysis `Requirement` fields are retained: job-specific
text, must-have/preferred tier, priority weight, coverage scope and exact posting
evidence. Job-local IDs become explicit occurrences joined to reusable canonical
IDs/revisions. Requirement extraction no longer depends on Materials or an
employer-analysis ensemble. Employer role framing, narratives and company
research belong to their corresponding owners; person qualification and wording
coverage belong to Fit.

## Source and semantic authority

Every new extraction, comparison, novelty decision and correction calls the
configured `Runtime.model` gateway in the `requirements` lane. Its persisted
provider/model/prompt/input receipt accompanies the accepted owner binding.
Domain checks enforce strict schemas, complete candidate ID inventories,
revisions and exact contiguous posting spans. The model alone decides support,
qualified meaning, equivalence and novelty. Unsupported, uncertain or malformed
output never replaces an accepted snapshot.

Duration, scale, seniority, domain, logical alternatives, exceptions and scope
remain part of qualified meaning. Tier/weight belong to an occurrence. A
paraphrase may reuse a canonical ID only through a recorded model decision.
Externally authored source labels remain provenance data. Generated
`posting:<job-id>:<revision>:<hash>` model source IDs cannot alias catalog sources
or sweep certificates.

SQLite FTS ranks candidates separately for each incoming meaning; it has no semantic authority. A
candidate match requires an explicit equivalence judgment. A miss requires
model comparisons against the rest of the revision-fenced catalog in pages of
at most twelve meanings and 60,000 bytes of meaning text. Only a complete
negative sweep can reach the separate source-bound novelty decision. The sweep
certificate records the catalog revision, candidate count/set fingerprint and
comparison receipt fingerprint. New meanings awaiting publication in the same
extraction also participate, preventing repeated paraphrases within one source
from creating additional canonical IDs.

The FTS index, canonical heads and catalog epoch update in the same transaction.
Readers verify index identities/revisions/documents against the canonical heads;
a stale or damaged index fails explicitly. Each refresh permits at most 128
**new model calls across the complete extraction**, and 192,000 posting-source
bytes. There is no permanent catalog-size ceiling. At the work bound, the
owner reports `requirements_scan_pending`, retains accepted artifacts and saves
accepted exact-call progress. Retrying the exact refresh inputs resumes that
progress; cached calls consume zero new-call allowance. A partial sweep cannot
establish novelty. Model lane, capacity and spend checks apply to every new
external call.
Explicit index repair copies current canonical meanings under a catalog-version
guard and makes zero model calls; it cannot create or change a meaning.

The feature-owned progress cache records one bounded result and immutable
gateway receipt per exact call, never a copy of the complete catalog per
requirement. Its key binds the configured provider/model, prompt and output
schema, every source and the exact context. Comparison/novelty context binds the
catalog epoch and candidate IDs/revisions; extraction context also binds the
expected accepted snapshot revision and force selection. Source changes,
semantic revisions, catalog publications, model changes and prompt/schema
changes therefore cannot reuse unsafe negative judgments. Every reused result
passes the same strict schema and source-citation checks and joins its recorded
ID through the gateway's public receipt reader. The live receipt must be
succeeded with the same operation/provider/model/lane/prompt/input binding and
canonical typed result; missing or mismatched authority refuses reuse without a
new-model fallback. Cache acceptance
shares a transaction with the public Jobs source guard and catalog-epoch guard.
Failed/invalid calls are never cached as accepted decisions.

Unpublished same-source canonical IDs derive mechanically from the accepted
extraction receipt, local occurrence ID and qualified meaning fingerprint. This
keeps bounded comparison keys stable across interrupted multi-requirement
refreshes; only an actual model equivalence decision can reuse another meaning.
No source-dependent semantic interpretation is replaced by that identifier rule.

## Concurrency, corrections and recovery

Inference occurs outside the write transaction. Publication uses one
`BEGIN IMMEDIATE`, checks the expected accepted snapshot revision, invokes Jobs'
public posting revision/hash guard in that same connection, and checks the
catalog epoch before writing meanings, occurrences, the accepted snapshot and
its committed event. A competing catalog publication triggers a fresh bounded
resolution pass, up to four passes, so simultaneous discoveries reuse the
winning canonical ID. A changed posting or accepted snapshot refuses the write.

Binding correction records an explicit user reason and a fresh source-bound
model judgment, then publishes a new immutable job snapshot. Canonical meaning
correction adds a revision and updates the retrieval index. Readers retain the
old accepted snapshot with `stale=true`; they never silently reinterpret an old
binding under a new meaning revision. Fit and Resumes use `assert_current` in
their own publication transactions.

Durable actions bind `ActionContext.run_id` to the exact accepted feature result
inside the canonical transaction. A retry after feature commit and before the
shared action receipt reuses that result without another model call. A later
source/artifact revision marks the returned historical result stale. Reusing an
action ID with another input conflicts. Failed, cancelled and interrupted
attempts retain accepted artifacts and the shared model gateway's real spend
uncertainty. A pending scan may retain the same durable operation ID: accepted
call progress is separate from accepted Requirements publication, and no final
artifact binding is created before the complete fenced transaction succeeds.

Permanent Job deletion calls `delete_job_data(job_id, connection=...)` through
the reviewed Jobs owner transaction. It removes only per-job requirement
snapshots, occurrences and attempts. Neutral reusable catalog meanings,
their quoted provenance and immutable model/revision records remain independent.
Per-job exact-call cache rows are removed with the other private per-job state.

## Public application contract

Reads return fresh JSON DTO copies and make no model calls:

- `get_job_requirements(job_id, connection=None)` returns the accepted snapshot,
  its current stale status and latest attempt; absent acceptance is 404.
- `find_job_requirements(job_id, connection=None)` returns that snapshot or
  `None` for an existing Job without acceptance. A missing/deleted Job remains
  404. HTTP uses this nullable reader for honest first-use state.
- `job_bindings(job_ids, connection=None, postings=None)` returns narrow accepted
  binding summaries for at most 1,000 IDs. Unassessed IDs are omitted. One owner
  query joins recorded canonical revisions to current heads, and one public
  Jobs batch read fences posting revisions/hashes; callers may supply their
  same-transaction public posting snapshot map. Summaries contain the accepted
  snapshot/posting versions, accepted/current requirement revision lists and
  explicit staleness. They make no model calls or per-job sibling queries.
- `get_requirement(requirement_id, revision=None, connection=None)` reads the
  current or exact historical canonical revision.
- `assert_current(snapshot, connection=None)` fences accepted snapshot identity,
  posting revision/hash and every canonical meaning revision. Consumers pass
  their existing write connection to make publication atomic.
- `catalog(limit=50, offset=0, query="")` lists current meanings. The query is a
  literal user filter; it does not judge semantic identity.
- `delete_job_data(job_id, connection=None)` participates in the Jobs owner's
  authorized permanent-deletion transaction.

A snapshot contains `job_id`, `revision`, `posting_revision`, `posting_hash`,
`source_id`, `source_revision`, `catalog_revision`, `created_at`,
`extraction_determination_id` and `requirements`. Public reads add `stale` and
`latest_attempt`. Each occurrence contains `occurrence_id`, `requirement_id`,
`requirement_revision` (also `revision` for canonical-reader convenience),
`definition`, `qualifiers`, `scope`, job-specific `text`, `tier`, `weight`,
posting/source IDs/revisions/hash, exact `spans`, `model_source_id`, model receipt
IDs and full immutable provenance. Correction adds the previous occurrence ID
and a recorded reason/receipt. An unrelated catalog addition does not invalidate
a current snapshot.

## HTTP and durable actions

| Entry point | Behavior |
| --- | --- |
| `GET /v1/jobs/{job_id}/requirements` | Accepted snapshot, staleness and latest attempt, or HTTP 200 JSON `null` for an existing unassessed Job. Missing/deleted Job is 404. |
| `HEAD /v1/jobs/{job_id}/requirements` | Same safe read status; it never parses a refresh body or invokes a model/write. |
| `POST /v1/jobs/{job_id}/requirements` | Refresh with `expected_posting_revision`, `expected_revision` (zero initially), optional `force`. |
| `GET /v1/requirements?limit=50&offset=0&q=literal` | Current catalog with epoch and total. |
| `GET /v1/requirements/index` | Exact catalog/index revision, counts and freshness. |
| `POST /v1/requirements/index/rebuild` | Mechanical repair guarded by `expected_catalog_revision`; zero model calls. |
| `GET /v1/requirements/{requirement_id}` | Current meaning and accepted job occurrences; `?revision=N` reads immutable history. |
| `POST /v1/jobs/{job_id}/requirements/{occurrence_id}/binding` | Explicit target ID/revision, expected posting/snapshot versions and user reason. |
| `POST /v1/requirements/{requirement_id}/revisions` | Source-bound proposed meaning correction with expected meaning/posting versions and user reason. |
| `requirements.refresh` | Same refresh action through the durable dispatcher; payload also includes `job_id`. |
| `requirements.correct_binding` | Same correction action; payload also includes `job_id` and `occurrence_id`. |
| `requirements.revise` | Same canonical correction; payload also includes `requirement_id`. |

Events are `RequirementsUpdated`, `RequirementBindingCorrected` and
`RequirementMeaningRevised` and `RequirementIndexRebuilt`. Payloads contain only invalidation IDs/revisions.
The HTTP layer exposes safe failure codes; private posting/model prose never
enters exception messages. Provider/spend failures retain their gateway status,
source/schema validation failures are 422, and revision/index/cancellation
conflicts are 409. Bounded scans return 409 `requirements_scan_pending` with a
saved-progress message and safe `details`: `continuation_id`, new/reused model
call counts and maximum, Job/posting/catalog revisions, completed/total incoming
requirements, local requirement ID and examined/total candidates. Continue by
resending the original refresh body and operation ID; do not advance expected
versions or change force selection. The UI can offer explicit continuation, and
Preparation can continue bounded steps with cancellation/heartbeats. No previous
artifact is cleared on a failed or pending refresh.

## Verification boundary

The target suite is application E2E with owned synthetic state and controlled
external model HTTP responses. Source binding, semantic authority and structural
failures are exercised through real application routes, SQLite and model
admission; there are no semantic matcher fallbacks, replay corpora or internal
domain/repository mocks. Recurring E2E belongs to the transformation E2E owner.
Local static validation uses the shared environment's Ruff and compilation of
this feature. Root integration separately owns Temporal scheduling, browser
journeys, removal of legacy entrypoints and final capability closure.
