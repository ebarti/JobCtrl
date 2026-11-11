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
- The actual pinned JobStreaming explicit-ack gateway is retained. Accepted or
  filtered receipts commit before provider acknowledgement. Provider cursor
  fingerprint/schema errors fail explicitly. Epoch-fenced admissions prevent an
  abandoned activity from writing after a retry or cancellation.
- Workday CXS, Greenhouse, Lever and Ashby public adapters are retained, with
  configured request policy. Public careers/Smart Extract acquisition uses
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
