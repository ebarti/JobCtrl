# Discovery ownership

Discovery is optional. It owns saved search controls, explicit targets/query
plans, the state of SDK boards, historical capture review lifetimes,
literal feedback filters, schedules and durable provider intake. It sends
observations through the public Jobs writer and never reads Jobs private tables.
The Jobs feature independently owns direct posting URL imports and their durable model-capacity queue.

`DiscoveryService` orchestrates application policy through `DiscoveryStore`,
`JobsPort`, `ModelPort` and `ExecutionPort`. The discovery adapter obtains board identities from JobStreaming’s installed registry and uses its native search and detail APIs. Target-plan storage uses semantic repository actions and a
public Profile source guard; application modules contain no SQL or database
escape hatch.

## Retained capabilities

- Saved boards, the shared new-job limit, posting age,
  crawler identity and schedule settings retain optimistic revision fences.
  Board-state writes require the saved board revision. An upgrade retains existing board choices.
- Literal authored role queries remain exact queries. Additional track/function/
  seniority recall queries require source-bound model output and persisted
  receipts. Location/work-model rows remain paired exactly as authored. An
  unspecified location does not silently authorize a location-free Remote row.
- Profile target plans, explicit Discovery query controls and one-run overrides
  are distinct authorities. Model suggestions do not change Profile preferences.
  Unknown or invalid refreshes preserve the previous accepted plan.
- New searches with an accepted authored role plan freeze `saved-role-scope-v1`.
  Before Jobs admission, Discovery validates a typed `discovery.role_target_match`
  against the exact public posting and authored role, track, seniority, function
  and specialization sources. Only a source-supported match spends new-job
  capacity. A filtered observation retains the source and decision, and an
  accepted job records the receipt and frozen plan identity. A listing without
  a description requires native detail or records a missing source. Explicit query
  overrides and earlier runs retain their respective acquisition contracts.
  An exact saved LinkedIn card records an observation at the existing Jobs
  revision before targeted detail or role qualification. It uses no new-job
  slot and provides no role verdict for the current run.
  Gateway admission atomically records the paid receipt for the run and candidate,
  or for the exact historical review revision. Recovery resolves that receipt
  before any provider call. A matching interrupted legacy receipt also blocks
  redispatch. A recovered older saved-role run without exact paid-call custody
  needs a new deliberate search for a candidate whose outcome cannot be recovered.
  Durable intake publishes `DiscoveryRoleTargetWaiting` while the
  configured lane or monetary accounting is occupied. Historical reviews return
  current contention or the earlier call's outcome to the requesting client.
- New runs isolate each selected board into a stable query/location/board unit;
  each owns its provider checkpoint and outcome. Terminal board failures are
  reused on same-run worker recovery; a new explicit run is required to retry
  them after the SDK exhausts its bounded attempts. Auth/unsupported-scope failures
  never label healthy boards failed or cancel their work. Older persisted runs
  retain their original unit identities; a missing age reference refuses an
  adapted request before network work and requires a new explicitly started run.
- New multi-query board searches freeze `boardQueryScheduling=fair-new-jobs-v1`.
  Discovery distributes the remaining slots across distinct query strings and
  uses frozen plan order to break ties. All locations and boards for a query
  spend its share. When a query exhausts its units, Discovery redistributes its
  unused slots before opening the next query's stream.
  Only a committed new Jobs identity spends a slot. On restart, intake receipts
  restore each query's count and the provider checkpoint restores its position.
  Backfill can revisit a partial page, preserving its acknowledged receipts.
  On LinkedIn, a 429 pauses that board until its saved retry time. Other boards
  can end their remaining units for the run when they supply no retry time.
  A streamed error and a directly raised detail error use the same safe
  rate-limit diagnostic. The run list explains older generic messages from
  their recorded board rate-limit code, including after an upgrade.
  Previously admitted board requests retain their original scheduling policy.
- The board adapter translates SDK authentication/configuration errors using
  the reported exception type and known SDK messages. It commits a safe
  diagnostic, the failed unit, source outcome and warning event together
  before acknowledging the SDK. Provider response prose stays private.
- Newly admitted requests freeze `sourceFetchPolicy=source-native-v1`. Their
  units carry `results_per_site=None`, translated to actual SDK
  `results_wanted=None`; native page sizes and the SDK's 50-page safety bound
  remain. Legacy saved/API/CLI result counts cannot affect new acquisition.
  Unmarked admitted requests retain their finite units, exact SDK fingerprints
  and resume semantics. Missing SDK support fails explicitly without a numeric
  substitute. `SiteCompleteEvent.reason` is persisted before acknowledgement;
  only `source_exhausted` establishes upstream exhaustion. Page/provider limits
  and unknown termination remain explicit source failures with accepted jobs
  retained, including recovery after the completion acknowledgement.
- Final settlement reads fulfilled units and failed source IDs/codes from
  canonical storage for each selected board. Recovery cannot
  forget a failure when another source has already filled the shared budget.
  At that limit, existing running units become `budget_exhausted`; failed units
  remain failed and unstarted/scoped-out sources do not count as completed.
  The quota-filling admission transaction returns its committed budget state.
  The transactional gate closes admissions at capacity with
  `termination=budget_exhaustion`. Additional postings already received on the
  same page remain recorded as beyond the limit.
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
  location text cannot establish eligibility. Exclusions consume no new-job
  quota; traversal follows the frozen native or legacy finite source policy.
  No lexical inference changes the authored criteria.
- The pinned JobStreaming explicit-ack stream saves provider cursor headers,
  ordered seen keys and each received posting in PostgreSQL. A listing and
  its acknowledgement commit together. The adapter drains pending postings
  before opening the next page. During saved-role LinkedIn intake, one targeted
  detail read may overlap the preceding card's role review within that page.
  The read uses the same source pacing and persists to its own receipt. The
  worker settles the current intake before acting on a later detail failure
  and joins the read within its lease. Accepting a new job, its intake receipt, the
  new-job count and its independent DBOS assessment enqueue share a transaction.
  Cursor schema/fingerprint errors fail explicitly. Epoch checks fence stale writers.
- When LinkedIn returns the same native posting ID to overlapping queries in one run,
  Discovery reuses the first nonblank targeted description recorded in PostgreSQL,
  including after worker replacement. Each unit retains its own intake receipt.
  A missing description or failed request leaves the next unit free to fetch it.
- Discovery seeds state only for boards provided by the installed JobStreaming registry. Selection limits a search to the saved board IDs. Reopening an existing database retains its job and run history. An unfinished search with a retired active source records `discovery_source_retired` and requires a fresh launch.
- Capture prepare/supersede creates a new 64-character review lifetime. Import
  claims, input fingerprints, canonical posting writes and acknowledgement
  fences preserve ambiguity honestly. Exact receipt replay performs no model
  work. A changed submitted body needs a new lifetime.
- Content quarantine is owned by Jobs. Discovery composes its public review
  data. Literal whole-title exclusions run only after user approval; approving a
  source-bound exclusion proposal persists the exact literal filter atomically.
- Source health reports recorded counts and failures. Unknown rates remain
  null. Accepted jobs survive later board failures. All boards share the transactional new-job limit.

Application automation/fit thresholds are composed from the canonical runtime
policy owner. Changing those shared values requires `expectedPolicyRevision`;
ordinary Discovery changes use `expectedRevision`. Exact application approval
cannot be disabled. Discovery stores no competing application-policy authority.

## Public entry points

Settings, board states, saved observation previews, historical capture review, quarantine, feedback, target plans and run/cancel routes live under `/v1/discovery`. `GET /v1/discovery/sources` lists SDK boards and `PATCH /v1/discovery/sources/{source_id}/state` updates an existing board with its expected revision. Durable actions include `discovery.search`, `discovery.refresh_targets` and `discovery.refresh_feedback`. Search results include committed
`jobIds` and `newJobIds` for the preparation owner. `schedule_definition()`
publishes an explicit `discovery.search` schedule to the foundation worker.

The complete application composes that existing action with Preparation's
fit-only `search` recipe, using the same public run ID for source progress,
checkpointed job stages and cancellation. Only newly committed `newJobIds` enter
initial assessment; prior accepted scores are never implicitly refreshed.
The action stays active through enrichment, role analysis, Requirements and Fit,
with no wording coverage, authoring or resume generation. Its result adds
`preparationAvailable: true` and `preparation` with `status`, `assessedJobs`,
`failedJobs` and per-job `{jobId, stage, code}` failures. Existing `failures`
contains source failures only. Either kind makes the overall result `partial`.
The composite's `ok` is true only on complete success; `acquisitionStatus` retains
the independent source status. `search_outcome(run_id)` returns that exact
committed acquisition outcome for application recovery, including failed sources
that already saved jobs. Preparation assesses only those recorded new IDs and
does not repeat acquisition to recover them. Source failure with no new jobs
remains failed. Its action finalizer seals interrupted preparation, and worker
replay preserves failed job stages until an explicit retry.
The initial assessment can reuse a complete targeted LinkedIn detail from that
acquisition when its accepted intake receipt matches the current posting
revision. An initial check that needs another LinkedIn fetch during the
cooldown records `posting_check_deferred_source_rate_limited`.
An explicit retry or selected-job assessment can check those postings later.
The LinkedIn transport records each observed HTTP 429 and its effective Unix
retry timestamp together. The `DiscoverySourceRateLimited` activity event and
the run's `cooldowns` expose the same deadline.
Standalone Discovery remains acquisition-only and reports
`preparationAvailable: false`. The separate explicit `assess` preparation recipe
recovers selected saved jobs without another acquisition.

Search registers a constant workspace admission scope. The foundation's write
transaction admits one active search across tabs, CLI and schedules, before
planning or acquisition. It includes pending, dispatch-failed, queued and running
states; competing new keys receive `action_scope_busy` with the existing run ID.
Exact-key retries retain their original identity. The admitted search owns the shared new-job budget.

Public `get_crawler_settings()` returns the exact neutral request-identity input
for independently removable consumers. `digest_summary()` returns read-only
source/run summaries. Cross-feature consumers use those services, never private
tables.

`JOBCTRL_JOBSTREAMING_PROVIDER_ENDPOINT` confines registered SDK board traffic to the authenticated loopback boundary of an owned synthetic workspace. Journeys exercise native Indeed responses, LinkedIn listing and detail pages, and the SDK's missing-credential refusal. The installed SDK owns parsing, checkpointing, limits and cancellation throughout these journeys.

Saved searches freeze literal role titles and location/work-arrangement filters.
Model admission and accounting apply to source-bound role matching and Fit.
A new saved-role search checks the selected model's monetary accounting before
creating an acquisition run. The gateway checks the live policy again before
dispatching each model call.
LinkedIn listings and targeted details share a persisted four-second request
interval across runs. A server-supplied retry time stays in PostgreSQL, including
delays longer than the SDK's internal sleep limit. A DBOS timer releases the
acquisition step until that deadline. Other ready boards advance before a search
sleeps. Independent job assessment workflows and the shared provider/model
accounting remain available. The search can be stopped during its wait.
A LinkedIn 429 without a positive server deadline uses the same durable wait
as other throttles. An observed HTTP 429 raises the board's ordinary request
spacing by four seconds, capped at 16. Each HTTP 2xx returned to the search
transport reduces it by one second, down to four. The shared reservation gate
applies this interval to listing, detail and search-assessment requests using
the persisted source request clock. Only the interrupted unit, phase and
available detail receipt may resume at the saved retry deadline with the
original minimum interval. A headerless 429 chooses its retry delay
with exponential backoff and equal jitter. The first wait is 4–8 seconds and
each fallback is at most 120 seconds. Search passes the absolute deadline to
DBOS so offline time counts even when the worker exits before registering the
timer. Each new 429 can defer another turn. The original run owns
its unfinished work, criteria, budget and accepted postings across retries.
The board-response record commits the interrupted unit, phase, detail receipt
when available, and effective deadline alongside the 429. Once eligible, the
oldest interrupted unit takes the next LinkedIn turn. A repeat throttle allows
one different ready unit a turn. The worker records the actual retry response
with its original deadline and request start time.

An explicit `discovery.search` with only `resumeFromRunId` can continue unfinished
LinkedIn units from an older terminal rate-limit outcome. Admission verifies the
prior outcome, source state and persisted cooldown. The new run freezes the original criteria
and remaining budget. Each interrupted unit seeds its own SDK checkpoint with
the acknowledged cursor and seen keys, including excluded postings. A transactional
parent-to-child link prevents two successors from spending the same remaining
budget. Completed jobs retain their original assessment history.
