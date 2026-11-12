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

Every new extraction, catalog matching determination and correction calls the
configured `Runtime.model` gateway in the `requirements` lane. Its persisted
provider/model/prompt/input receipt accompanies the accepted owner binding.
Domain checks enforce strict schemas, complete incoming ID inventories,
revisions and exact contiguous posting spans. The model alone decides support,
qualified meaning, equivalence and novelty. Unsupported, uncertain or malformed
output never replaces an accepted snapshot.

Duration, scale, seniority, domain, logical alternatives, exceptions and scope
remain part of qualified meaning. Tier/weight belong to an occurrence. A
paraphrase may reuse a canonical ID only through a recorded model decision.
Externally authored source labels remain provenance data. Generated
`posting:<job-id>:<revision>:<hash>` model source IDs cannot alias catalog sources
or the catalog inventory source.

Extraction remains a separate source-bound call. The complete incoming batch
and the **entire current canonical catalog**, including each definition, scope
and qualifier, then enter one `requirements.match_catalog` determination. It
returns exactly one `equivalent`, `new` or `uncertain` decision per incoming
local ID. Canonical equivalence names an exact catalog ID/revision. Equivalence
within the incoming batch points to an earlier, genuinely new representative;
all occurrences remain recorded while only the representative creates a
canonical meaning. There is no top-k selection, widening, paging, chunking,
separate novelty judge or lexical fallback.

Every decision cites the posting, its incoming qualified meaning and the
catalog inventory. Equivalence also cites its canonical or incoming target.
The response echoes the exact catalog epoch. The inventory records canonical
count and ID/revision/meaning fingerprints; it does not claim a prior negative
sweep. Unknown, missing or duplicate incoming IDs, foreign targets, stale
revisions, invalid local-reference graphs and non-verbatim citations refuse the
whole result. Any uncertain decision preserves the previous accepted snapshot.

Matching reads canonical heads and meanings in one read transaction, independent
of the repairable FTS index. Missing canonical revisions refuse the snapshot.
The index, canonical heads and catalog epoch still update together on writes;
the separate index-status reader verifies index documents against those heads.
Explicit index repair copies current canonical meanings under a catalog-version
guard and makes zero model calls; it cannot create or change a meaning.

Each refresh permits at most five new model calls: extraction plus at most four
whole-catalog attempts when a concurrent publication changes the catalog.
Posting input remains bounded to 192,000 bytes. The gateway checks its full
serialized request against a 1 MiB structural limit before provider admission;
model lane, capacity and spend admission apply to each new external call. That
byte limit does not establish token-context fit. The current gateway exposes no
selected-model token-context capacity for a separate token preflight. Known
context refusals remain explicit when the gateway exposes them; generic
provider failures retain their actual failure code. Size, work, spend, provider
or context refusal never triggers smaller requests or an automatic retry and
never publishes a partial catalog decision.

The feature-owned cache records one bounded result and immutable gateway receipt
per exact call. Its key binds the configured provider/model, prompt and output
schema, every source and the exact context. Matching context binds the complete
incoming inventory, catalog epoch and canonical IDs/revisions; extraction also binds the
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
keeps new identifiers stable across interrupted refreshes; only an actual model
equivalence decision can reuse another meaning.
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
model judgment against exactly the user-selected canonical target, then publishes
a new immutable job snapshot. This targeted correction does not search the
catalog or establish newness. Canonical meaning
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
uncertainty. Cached model results are separate from accepted Requirements
publication; no final artifact binding exists before the complete fenced
transaction succeeds. Requirement writes emit invalidations and do not schedule
Fit reassessment or wording-coverage refreshes.

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
- `catalog_snapshot(connection=None)` returns the complete current catalog in
  stable canonical-ID order, with `catalog_revision`, `meanings_fingerprint`
  and `requirements`. Every row contains `requirement_id`, `revision`,
  `definition`, `qualifiers` and `scope`; there is no pagination, filtering,
  model work or search-index dependency. The returned JSON values are detached
  from the immutable canonical revision records. Passing a connection joins the
  caller's read transaction so Profile/catalog snapshots share one source view.
- `assert_current_catalog(snapshot, connection=None)` re-reads the catalog and
  checks its exact epoch, complete ID/revision inventory, semantic contents and
  fingerprint. Consumers retain the unmodified public snapshot and pass their
  publication connection to fence the complete operation atomically. Any added,
  revised, missing or changed meaning refuses publication; this guard never
  widens the original work set or schedules model work.
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
| `GET /v1/requirements/{requirement_id}/history?kind=revisions` | Bounded immutable meaning-revision inventory with the current canonical revision and explicit current/stale labels. |
| `GET /v1/requirements/{requirement_id}/history?kind=occurrences` | Bounded retained occurrence history, including superseded accepted job snapshots, original source spans and exact canonical revisions. |
| `POST /v1/jobs/{job_id}/requirements/{occurrence_id}/binding` | Explicit target ID/revision, expected posting/snapshot versions and user reason. |
| `POST /v1/requirements/{requirement_id}/revisions` | Source-bound proposed meaning correction with expected meaning/posting versions and user reason. |
| `requirements.refresh` | Same refresh action through the durable dispatcher; payload also includes `job_id`. |
| `requirements.correct_binding` | Same correction action; payload also includes `job_id` and `occurrence_id`. |
| `requirements.revise` | Same canonical correction; payload also includes `requirement_id`. |

The history endpoint accepts `limit` (default 50, maximum 200) and `offset` and
returns `requirement_id`, `current_revision`, `kind`, `total`, `limit`, `offset`
and `rows`. Revision rows retain their original definition, scope, qualifiers
and provenance. Occurrence rows add `snapshot_revision` and `accepted`; the
latter means the occurrence belongs to the current accepted job snapshot, not
that its posting or meaning remains current. `current` and `stale_reasons`
separately check the recorded canonical revision, accepted snapshot and public
Jobs posting revision/hash in one read transaction. This is retained accepted
occurrence history, not a claim that failed extraction attempts published
requirements. Permanent job deletion removes that job's occurrences under the
existing retention contract. Reading any catalog/history endpoint makes no
model call and grants no approval or factual support.

Events are `RequirementsUpdated`, `RequirementBindingCorrected` and
`RequirementMeaningRevised` and `RequirementIndexRebuilt`. Payloads contain only invalidation IDs/revisions.
The HTTP layer exposes safe failure codes; private posting/model prose never
enters exception messages. Provider/spend failures retain their gateway status,
source/schema validation failures are 422, and revision/index/cancellation
conflicts are 409. Complete-input or work refusal returns 503
`requirements_catalog_unavailable` with a safe reason and relevant catalog/count
metadata. It has no continuation or chunk fallback. A missing canonical revision
returns 503 `catalog_snapshot_invalid`. Provider/spend refusal keeps the actual
gateway status. The user can retry explicitly after changing the limiting
condition; no previous artifact is cleared by a failed or unavailable refresh.

## Verification boundary

The target suite is application E2E with owned synthetic state and controlled
external model HTTP responses. Source binding, semantic authority and structural
failures are exercised through real application routes, SQLite and model
admission; there are no semantic matcher fallbacks, replay corpora or internal
domain/repository mocks. Recurring E2E belongs to the transformation E2E owner.
Local static validation uses the shared environment's Ruff and compilation of
this feature. Root integration separately owns Temporal scheduling, browser
journeys, removal of legacy entrypoints and final capability closure.
