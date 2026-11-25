# Jobs ownership

Jobs owns canonical job identity, manual capture, immutable posting revisions,
source observations, extraction review, current availability evidence and
employer-side role context. It has no dependency on the optional Discovery or
Companies packages. Requirements, Fit, documents and applications use public
snapshots and guards; they do not read Jobs tables.

`bootstrap.build_feature` composes the PostgreSQL adapter and source-bound page/model
adapters. `JobsService` uses owned repository/acquisition ports. The neutral
`jobctrl.network` boundary supplies public-address pinning, request limits,
read-only browser guards, host pacing and Retry-After handling without loading
legacy configuration or opening a legacy database. Each posting capture owns its
browser and pinned connections. Stopping it closes those connections and releases
its host slot before the action settles. Other concurrent captures can finish.

## Public owner contract

- `get_posting_snapshot(job_id, connection=None, include_deleted=False)` and
  `get_job(job_id, connection=None)` return detached JSON copies. Posting fields
  include `revision`, `source_hash`, source identity, title, employer, the
  description sources, application URL, source observation time and provenance.
- `assert_posting_current(job_id, revision, source_hash=None, connection=None)`
  is the acceptance fence. The caller can pass the active foundation transaction
  so a dependent artifact cannot race a changed posting.
- `select_job_ids(filters, connection=None)` performs a bounded ID-only scan.
  `get_job_snapshots(ids, connection=None, include_deleted=False)` reads at most
  1,000 snapshots in one SQL batch. Cross-feature list composition applies its
  public-owner filters and sorting before final pagination.
- `capture`, `ingest`, `capture_external`, `refresh`, `check_availability` and
  `analyze` share this feature's canonical writer. Discovery and extension
  adapters can provide same-transaction admission and acknowledgement ports.
- `read_capture_receipt` returns the original immutable accepted revision,
  including its observation provenance. It cannot silently return a newer
  posting. A receipt reused for different input conflicts.
- `application_admissibility` exposes pending content quarantine, source
  revision/hash, availability and enrichment readiness without private SQL.

Exact normalized URLs, exact provider identifiers and exact full content can
establish identity. Equal title/employer alone only triggers selective provider
detail acquisition; it cannot merge jobs. An unfamiliar refresh redirect needs
source-bound identity evidence. An unknown/different redirect preserves the last
accepted posting.

Discovery observations without accepted detail attach to the saved full posting.
This includes provider summaries with nonempty description text. The upgrade
recovers earlier discovery-only downgrades by appending the exact retained
accepted detail as a new head. Historical revisions and observations keep their
original identities, and the recovery uses the saved capture rationale.

Typed manual fields remain an explicit user source. Captured pages use strict
page interpretation, exact source-range description selection and a separate
source-bound quality determination. Citation and structural failures preserve
accepted content. Availability checks retain description provenance and record
their own current evidence; an access wall, incomplete capture or identity loss
stays unknown. Repeating the same availability state still records a fresh
observation without manufacturing a new content version.

## HTTP and durable entry points

Jobs exposes `/v1/jobs`, `/v1/jobs/capture`, `/v1/jobs/import-url`, per-job detail,
snapshot history, refresh, analysis, availability, visibility and reviewed
permanent-delete selection routes. Durable actions are `jobs.capture_url`,
`jobs.refresh`, `jobs.analyze` and `jobs.check_availability`.

The Jobs URL form submits `jobs.capture_url` with an idempotency key and the
selected database identity. Equivalent simultaneous URL requests share the
active capture scope. `GET /v1/jobs/url-imports` lists open imports and the
five most recent closed imports. Its statuses join the durable action receipt
to the waiting reason recorded by Jobs. Cancellation uses the action run ID.
Jobs advertises `jobs.url_import_queue` in `/v1/health` for clients that display
this projection. A client connected to a predecessor can follow the native
`jobs.capture_url` action receipt and filtered action-run history.
Each model reservation records its receipt under the import and operation in
the same transaction. A recovering worker can reuse a successful determination
only for its exact model request, subject to source and citation validation.
An interrupted call with unresolved usage requires review. The synchronous
`POST /v1/jobs/import-url` continues to return the captured posting directly.

Role analysis retains source-bound mission, seniority, ideal-candidate context,
keywords and optional model observations/failures. It creates no canonical
requirement meanings. Stable operation IDs also bind cache reuse to an exact
accepted analysis revision, preventing a restart from selecting another result.

GET and implicit HEAD requests are read-only. Model execution and posting
acquisition require their explicit POST actions.

Permanent deletion requires a reviewed, expiring selection containing exact IDs,
posting revisions and visibility revisions. A restore or changed source makes
the selection stale. Public owner callbacks remove job-owned records in the
same transaction. Independent learning cohorts, company history, source reviews
and model audit records remain. Requirements also removes canonical meanings
with no occurrence on another retained Job, including soft-deleted and historical
occurrences, and invokes owner callbacks for their Fit links in that same
transaction. Shared meanings, authored Profile facts and approved wording remain;
the preview discloses removal and retention. File retirement
uses owner journals and post-commit callbacks. The response distinguishes
committed deletion from pending cleanup; exact acknowledgement replay never
deletes twice or pretends a cleanup failure rolled back committed data.

## Exact role-analysis reuse

`SourceBoundRoleAnalysis` uses `posting-content:v1:<fingerprint>` over the
complete exact description as its semantic source. Prompt
`role-analysis-v3-offered-sources` binds that source, all supplied qualified
requirements, strict output schema and a frozen execution descriptor.
Every citation source ID is restricted to the exact offered source by a
request-local enum, retained by the native provider's strict-schema adaptation.
Provider/model, effective saved reasoning effort and the digest of allowlisted
nonsecret provider configuration are resolved once for both exact lookup and
native invocation. Credentials stay outside that identity, and admission uses
current budget policy. A change in model or effort cannot reuse a result for
different execution inputs.

Ordinary analysis first reuses a current same-job result with the same request
fingerprint, or revalidates an exact succeeded gateway receipt across postings.
The structural v3 upgrade preserves an accepted v2 same-job result only when
its legacy request identity still matches the current source/selection, its
destination/content binding is unchanged, and every observation and accepted
result still matches immutable receipt metadata/value and exact citations.
Accepted reads remain unchanged; an unaccepted old cache entry gains no authority.
Receipt identity, strict schema, verbatim citations and qualified-reference
membership must pass. Gateway success alone cannot establish owner acceptance;
an invalid raw observation is not reusable, and a separately admitted attempt
may make only its planned call without a repair loop. A force action binds a
new `refresh_identity`; replay of that durable action retains the same identity.

Configured single- or multi-model observation order is preserved. When more
than one observation succeeds, `role-analysis-synthesis-v3-offered-sources` can
reuse only the exact ordered observations, complete source/requirement context
and frozen synthesis execution. Model agreement does not establish a fact.
Partial failures remain recorded and do not invent a successful perspective.

The result's `source_binding` maps its content source to the actual destination
Job ID, posting revision and source hash. The shared model receipt is never
rewritten, no new source observation is fabricated, and exact publication and
cancellation guards still fence the destination. Semantic result reuse does
not merge job identities or reuse a person-fit score. Similar descriptions,
lexical matches, truncated inputs and automatic chunks provide no reuse
authority.

## Controlled external proof

`JOBCTRL_POSTING_PROVIDER_ENDPOINT` is admitted only with the foundation's owned
synthetic-workspace marker/token. Its authenticated page protocol replaces the
external page boundary, not Jobs internals. Production uses the public browser
acquirer. Target recurring tests are E2E-only; focused development proofs use the
real HTTP application and PostgreSQL with controlled page/model endpoints.
