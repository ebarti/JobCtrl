# Jobs ownership

Jobs owns canonical job identity, manual capture, immutable posting revisions,
source observations, extraction review, current availability evidence and
employer-side role context. It has no dependency on the optional Discovery or
Companies packages. Requirements, Fit, documents and applications use public
snapshots and guards; they do not read Jobs tables.

`bootstrap.build_feature` composes the SQLite adapter and source-bound page/model
adapters. `JobsService` uses owned repository/acquisition ports. The neutral
`jobctrl.network` boundary supplies public-address pinning, request limits,
read-only browser guards, host pacing and Retry-After handling without loading
legacy configuration or opening a legacy database.

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
and model audit history remain and are disclosed in the preview. File retirement
uses owner journals and post-commit callbacks. The response distinguishes
committed deletion from pending cleanup; exact acknowledgement replay never
deletes twice or pretends a cleanup failure rolled back committed data.

## Controlled external proof

`JOBCTRL_POSTING_PROVIDER_ENDPOINT` is admitted only with the foundation's owned
synthetic-workspace marker/token. Its authenticated page protocol replaces the
external page boundary, not Jobs internals. Production uses the public browser
acquirer. Target recurring tests are E2E-only; focused development proofs use the
real HTTP application and SQLite with controlled page/model endpoints.
