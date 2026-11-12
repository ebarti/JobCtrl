# Discovery ownership

Discovery is optional. It owns saved search controls, explicit targets/query
plans, the source registry, reviewed source proposals, capture review lifetimes,
literal feedback filters, schedules and durable provider intake. It sends
observations through the public Jobs writer and never reads Jobs private tables.
Removing it leaves manual Jobs operational.

`DiscoveryService` orchestrates application policy through `DiscoveryStore`,
`JobsPort`, `ModelPort`, `DestinationPolicy` and `ExecutionPort`. Provider
selection is explicit in bootstrap. JobStreaming, ATS and browser execution are
in owned adapters. Target-plan storage uses semantic repository actions and a
public Profile source guard; application modules contain no SQL or database
escape hatch.

## Retained capabilities

- Saved boards, per-board limits, posting age, bounded source-family parallelism,
  crawler identity and schedule settings retain optimistic revision fences.
  Source create-only writes cannot reactivate an existing disabled source.
- Literal authored role queries remain exact queries. Additional track/function/
  seniority recall queries require source-bound model output and persisted
  receipts. Location/work-model rows remain paired exactly as authored. An
  unspecified location does not silently authorize a location-free Remote row.
- Profile target plans, explicit Discovery query controls and one-run overrides
  are distinct authorities. Model suggestions do not change Profile preferences.
  Unknown or invalid refreshes preserve the previous accepted plan.
- New runs isolate each selected board into a stable query/location/board unit;
  each owns its provider checkpoint and outcome. Terminal board failures are
  reused on same-run worker recovery; a new explicit run is required to retry
  them after the SDK exhausts its bounded attempts. Auth/unsupported-scope failures
  never label healthy boards failed or cancel their work. Older persisted runs
  retain their original unit identities; a missing age reference refuses an
  adapted request before network work and requires a new explicitly started run.
- Final settlement reads fulfilled units and failed source IDs/codes from
  canonical storage, including registered ATS/careers sources. Recovery cannot
  forget a failure when another source has already filled the shared budget.
  At that limit, existing running units become `budget_exhausted`; failed units
  remain failed and unstarted/scoped-out sources do not count as completed.
  A completed empty source still constitutes completed acquisition. `partial`
  requires both fulfilled bounded work and a failed source; all-source failure
  remains `failed`, independently of how many jobs were accepted.
- Provider request normalization retains authored criteria in the run. Indeed
  Remote removes only the conflicting acquisition age parameter. Whole-day
  providers round acquisition hours up. Before intake, the exact local cutoff
  uses persisted run time and provider date metadata: Indeed dates have UTC-day
  precision, while other date-only providers retain a conservative 38-hour lower
  margin for discarded timezone/relative-day precision. Unknown, future or
  cutoff-overlapping dates become filtered receipts with reason/provenance.
  Glassdoor Remote+location is a board-local unsupported scope because returned
  location text cannot establish eligibility. No lexical inference or extra
  acquisition compensates for exclusions.
- The actual pinned JobStreaming explicit-ack gateway is retained. Accepted or
  filtered receipts commit before provider acknowledgement. Provider cursor
  fingerprint/schema errors fail explicitly. Epoch-fenced admissions prevent an
  abandoned activity from writing after a retry or cancellation.
- Workday CXS, Greenhouse, Lever and Ashby public adapters are retained, with
  configured request policy. Live-browser ATS transport retains that policy
  admission while Chrome owns identity/session headers; GET sends no body and
  JSON bodies are serialized only for POST. The broker still rejects forbidden
  headers, unsafe URLs, invalid bodies and stale/cancelled leases. Public careers/Smart Extract acquisition uses
  source-bound posting selection and qualification. Search templates fan out
  authored query/location rows under a shared per-source request budget.
- Packaged Workday and careers sources remain available in the fresh registry.
  Their initial state is disabled pending explicit review/enablement. Existing
  persisted state is never overwritten during seeding. Selected broad-board
  defaults remain active. Unconfigured Workday and unsupported regional Lever
  coordinates stay reviewable with promotion limits.
- Source proposals from saved history are opt-in, proposal-only and retain
  source observations, exact extraction/hash provenance, bounded samples,
  registry overlaps and unknown completeness. Rejection suppresses the literal
  source coordinate until explicit reset; listing never promotes or fetches.
- Capture prepare/supersede creates a new 64-character review lifetime. Import
  claims, input fingerprints, canonical posting writes and acknowledgement
  fences preserve ambiguity honestly. Exact receipt replay performs no model
  work. A changed submitted body needs a new lifetime.
- Content quarantine is owned by Jobs. Discovery composes its public review
  data. Literal whole-title exclusions run only after user approval; approving a
  source-bound exclusion proposal persists the exact literal filter atomically.
- Source health reports recorded counts and failures. Unknown rates remain
  null. Failed sources retain bounded cooldowns, source cadence and accepted
  jobs. Parallel source families share a transactional new-job budget.

Application automation/fit thresholds are composed from the canonical runtime
policy owner. Changing those shared values requires `expectedPolicyRevision`;
ordinary Discovery changes use `expectedRevision`. Exact application approval
cannot be disabled. Discovery stores no competing application-policy authority.

## Public entry points

Settings, sources, previews, locator candidates, source proposals, manual capture,
quarantine, feedback, target plans and run/cancel routes live under
`/v1/discovery`. Reads never perform model work. Durable actions are
`discovery.search`, `discovery.refresh_targets`, `discovery.refresh_feedback` and
`discovery.propose_sources_from_history`. Search results include committed
`jobIds` and `newJobIds` for the preparation owner. `schedule_definition()`
publishes an explicit `discovery.search` schedule to the foundation worker.

Search registers a constant workspace admission scope. The foundation's write
transaction admits one active search across tabs, CLI and schedules, before
planning or acquisition. It includes pending, dispatch-failed, queued and running
states; competing new keys receive `action_scope_busy` with the existing run ID.
Exact-key retries retain their original identity. This does not serialize source
families inside that search or alter their shared new-job budget.

Public `get_crawler_settings()` returns the exact neutral request-identity input
for independently removable consumers. `digest_summary()` returns read-only
source/run summaries. Cross-feature consumers use those services, never private
tables.

The authenticated `JOBCTRL_DISCOVERY_PROVIDER_ENDPOINT` protocol is permitted
only in a foundation-owned synthetic workspace. It replaces an external provider
boundary while exercising real public HTTP actions, application logic, Jobs
admission, SQLite receipts and cancellation fences. It does not replace internal
dispatch, domain decisions or repositories. Integrated Temporal restart/browser
acceptance remains in the root E2E journey suite.

`JOBCTRL_JOBSTREAMING_PROVIDER_ENDPOINT` separately confines the real installed
SDK's Indeed transport to the authenticated owned loopback boundary. The
restricted registry also exercises ZipRecruiter's real missing-auth refusal;
unknown boards cannot create a production adapter. Only addresses and synthetic
auth are configured: parsing, request filters, stream delivery, checkpointing,
limits and cancellation remain the installed SDK. The generic HTTP provider
protocol is not evidence of pinned-SDK behavior.

Saved-search launch composes model accounting capability from the read-only
settings snapshot when a fresh semantic query plan is needed. Missing native
accounting under a finite cap opens a setup action rather than disabling Start
search or submitting a known-to-fail action. The ModelGateway admission gate
remains authoritative. Pricing setup preserves criteria, provider, cap and the
originating route; saving never retries the search.
