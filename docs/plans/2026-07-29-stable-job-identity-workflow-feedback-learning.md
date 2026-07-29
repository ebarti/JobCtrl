# Stable Job Identity, Workflow Parity, And Feedback Learning

- **Date:** 2026-07-29
- **Status:** Accepted — implementation in progress
- **Delivery shape:** Small stacked PRs; intermediate phases are not released
  independently.
- **Goal:** Finish the remaining identity and projection cleanup, give Discover,
  preparation, and Apply one coherent run experience, replace broad realtime
  invalidation where exact patches are possible, and let JobCtrl learn from
  reviewed user feedback without silently rewriting prior decisions.

## Product outcome

JobCtrl treats a job, its external locations, and the user's judgments as
different facts:

- `JobId` is the immutable identity of a job inside one tenant.
- `PostingUrl` and `ApplicationUrl` are mutable external locators, not
  aggregate identity.
- `Source` is the board or career site; `Employer` is the hiring company.
- `WorkflowRun` is the Operations read contract projected from authoritative
  Temporal history and append-only lifecycle events for Discover,
  `JobPreparation`, and Apply; it is not a second workflow authority.
- `FeedbackSignal` is an explicit, reviewed user fact with provenance.
- `LearningRecommendation` is a non-executable, versioned proposal derived
  from compatible reviewed signals.
- `PolicyRevision` is created only after the user accepts a recommendation.

JobCtrl already has two bounded learning slices. Score corrections become
calibration anchors under BR-027, and approved role-match suggestions become
exact-title exclusions for future discovery. Resume review also stores
structured tailoring feedback, but does not yet use it to improve a versioned
tailoring policy. This plan preserves the shipped behavior and gives the three
paths one auditable contract rather than creating a parallel feedback system.
Reviewed application outcomes may provide sample-gated supporting evidence,
but descriptive outcome associations are not treated as proof that a policy
caused an outcome.

## Invariants

### Stable identity and canonical storage

1. `JobId` is generated once and never changes when a posting URL changes, an
   application URL is added, or another source observes the same job.
2. A posting URL remains unique per tenant and resolves as a bounded legacy
   alias during migration, but new writes, foreign keys, events, projections,
   API DTOs, and routes use `JobId`.
3. The schema migration is transactional, idempotent, and covered by the backup
   and schema-version guard. It preserves every canonical row, reference,
   accepted artifact, score version, event, and workflow association.
   `PRAGMA user_version` advances only after migration and referential
   verification succeed in the same commit.
4. Projection builders read canonical aggregate tables only. They do not fall
   back to legacy nullable columns or synthesize artifacts without a
   `job_artifacts` row.
5. `Source.board` and `Employer.name` are persisted independently. Unknown
   employer data stays explicit rather than being guessed from a URL or source
   label.
6. Normalized scoring keywords are stored per score version and indexed. Search
   and aggregation return the keyword version that produced the visible score.
7. Historical domain events remain immutable. A versioned identity upcaster
   resolves legacy URL values from both event columns and payload fields through
   the canonical alias map before either runtime rebuilds a projection.

### Workflow and realtime parity

8. Discover, `JobPreparation`, and Apply appear in one run history with the same
   status vocabulary, event timeline, terminal-state rules, and cancellation
   affordance. A cancel request is idempotent and the terminal result remains
   inspectable.
9. Realtime events patch the exact tenant-scoped job, artifact, dashboard, or
   run queries when the event payload contains enough canonical data. A bounded
   invalidation remains the explicit fallback when a truthful patch cannot be
   computed.
10. Targeted patches preserve filters, selection, pagination, and scroll
   context. Event-registry parity tests prevent a new event from silently
   bypassing freshness handling.

### Feedback learning

11. Only an explicit user action or a user-reviewed suggestion creates a
    `FeedbackSignal`. Raw model output, unreviewed email suggestions, inferred
    sentiment, and private free-text content are not learning facts.
12. A signal records its kind, canonical subject IDs, source action, revision,
    timestamp, and non-sensitive evidence references. Corrections never erase
    the original score, artifact, outcome, or review history.
13. A recommendation records its supporting and contradicting signal IDs,
    scope, proposed effect, derivation version, sample counts, confidence limits,
    and status. It is explainable, rejectable, and reproducible.
14. Recommendations cannot mutate the profile, discovery targets, scoring or
    tailoring policies, historical scores, accepted artifacts, thresholds, or
    Apply eligibility. Explicit acceptance creates a new versioned policy or
    preference revision; existing work changes only through the normal explicit
    rescore, re-tailor, or future-work path.
    A direct score correction or role-rule approval is already an explicit user
    command and may create its corresponding revision without a second
    confirmation.
15. Raw notes, resumes, job descriptions, mail bodies, prompts, model output,
    credentials, and local paths never enter the learning ledger, broad events,
    telemetry, or recommendation API.
16. Scoring owns calibration-anchor revisions, Discovery owns exact-title
    exclusion revisions, and Materials owns tailoring-rule revisions. Operations
    exposes their read-only union. No cross-context service may write another
    context's policy.
17. The initial tailoring recommendation type is closed:
    `TailoringRuleRevision(signalKind, ruleKey, ruleValue)`, where `signalKind`
    is one of the existing five tailoring feedback kinds and `ruleKey` plus
    `ruleValue` come from a versioned allowlist. Free text is never a rule value.
18. A derived recommendation requires at least three compatible accepted
    signals across two jobs, no unresolved contradictory accepted signal, and a
    passing deterministic evaluation fixture for its derivation version.
19. Active derived signals are retained until the user clears learning data or
    the owning canonical source is deleted. Correction or deletion appends a
    tombstone containing only non-sensitive IDs, lifecycle timestamps, and
    derivation versions, then triggers re-derivation. Accepted revisions remain
    auditable and rollbackable but stop being current when superseded or rolled
    back.

## Delivery stack

### Phase 0 — contract and migration plan

- Record this accepted plan, requirements, and architecture decision.
- Resolve `JobId` as an opaque UUID and feedback learning as
  recommendation-first and human-approved.
- Define rollback, compatibility, and cumulative QA boundaries before changing
  persisted user data.

### Phase 1 — migration runner and stable identity introduction

- Replace pre-migration schema stamping with an explicit versioned runner that
  stamps only after DDL, backfill, count, and foreign-key verification succeed.
- Add `job_id` plus a tenant-scoped URL alias map and backfill every existing job
  exactly once without changing read/write behavior yet.
- Add migration fixtures with representative references and prove failed
  migration retry, forward reopen, and paired pre-upgrade restore.

### Phase 2 — canonical repository compatibility

- Teach the canonical Job repository and shared identity resolver to read/write
  stable IDs while accepting a URL only at the bounded compatibility input.
- Generate UUIDs for new jobs, return stable IDs from deduplication lookups, and
  preserve posting URLs as locators.
- Keep downstream URL-keyed table families unchanged behind the resolver so
  this slice is independently reversible.

### Phase 3 — table-family reference migrations

- Migrate references as separate stacked PRs with before/after count and reopen
  fixtures:
  1. discovery observations, dedup identity, search-unit receipts, and
     preparation/orchestration state;
  2. enrichment, scoring, materials, artifacts, and stage state;
  3. Apply review, outcomes, repeat-application evidence, contacts, outreach,
     tombstones, and remaining job-owned authorities.
- Rebuild the canonical jobs relation with `(tenant_id, job_id)` identity and a
  unique posting URL only after every authority family resolves stable IDs.

### Phase 4 — event and projection identity cutover

- Require a registry-derived quiescent migration preflight across every
  workflow whose deterministic ID or serialized input carries job identity.
  Authoritative Temporal queries must report no such open execution—including
  Discover, `JobPreparation`, Apply, `JobPipeline`, `InterviewPrep`,
  `ContactResearch`, and `CompensationRefresh`—and durable search-unit or
  preparation ownership must be terminal. The migration never derives this
  decision from a possibly stale projection alone.
- Add upgrade/restart fixtures showing that legacy URL-based workflow IDs and
  inputs, plus preparation idempotency keys, cannot coexist with new UUID-based
  executions. Registry parity makes a newly added URL-bearing workflow fail the
  cutover test until it defines a drain or upcast path. A non-terminal legacy
  execution blocks cutover rather than allowing a dual start.
- Emit stable IDs in new events and add one shared versioned upcast contract for
  historical URL values in both event columns and payloads.
- Rebuild Python and TypeScript projections from pre-cutover event fixtures and
  prove neither runtime can reintroduce URL-shaped identity.
- Cut API DTOs, routes, workflow inputs, and projection keys to stable `JobId`;
  retain URL resolution only at the compatibility input.

### Phase 5 — canonical projection and field cleanup

- Remove projection fallbacks to legacy `jobs.*` status, score, application,
  and artifact columns.
- Remove phantom PDF synthesis; expose only database-backed artifacts.
- Persist and project `Source.board` and `Employer.name` independently.

### Phase 6 — searchable scoring keywords

- Normalize latest-score keywords into a versioned relation with tenant, job,
  score-version, normalized keyword, and display text.
- Add indexed keyword filtering and aggregation to the TypeScript API and typed
  client contracts.
- Remove free-text reasoning parsing after the migration fixture proves
  equivalent canonical coverage.

### Phase 7 — workflow-run parity

- Give Discover, `JobPreparation`, and Apply rows consistent labels, related-job
  context where applicable, timelines, actions, and cancel behavior.
- Reuse the context-owned cancellation mutation from both Pipelines and Workflow
  Runs rather than adding a view-owned API path.
- Cover accepted, canceling, canceled, already-terminal, worker-unavailable, and
  refresh-after-cancel states.

### Phase 8 — targeted realtime patches

- Add exact job, artifact, dashboard, and workflow-run patch handlers.
- Keep query keys tenant-first and retain a documented invalidation fallback for
  payloads that cannot support a truthful patch.
- Extend registry-derived event parity and patch/rollback tests.

### Phase 9 — feedback ledger and recommendations

- Define one typed read contract over existing score-correction anchors,
  discovery feedback, approved role-match suggestions, and tailoring feedback;
  add canonical `FeedbackSignal` and `LearningRecommendation` records only where
  an existing table cannot preserve the required provenance and version.
- Backfill stable references without double-applying an existing score anchor or
  approved title exclusion. Ingest explicit material-review decisions as
  reviewed signals. Outcome facts may be linked as sample-gated supporting
  associations but cannot generate a recommendation by themselves.
- Project tailoring inputs through an allowlist that records kind, structured
  rule code, source IDs, hashes, and lifecycle metadata only. Never copy
  `tailoring_feedback_signals.summary`, edit text, reply bodies, or source
  artifact text into the shared ledger or API.
- Derive recommendations deterministically from compatible signals, expose the
  evidence and contradictions, and deduplicate by derivation version and input
  set.
- Gate each derivation version with synthetic positive, negative,
  contradictory, privacy, deduplication, correction, deletion, and rollback
  fixtures before its recommendations can be accepted.

### Phase 10 — review, accept, reject, and apply

- Add a local review surface for pending recommendations.
- Accepting creates a new versioned policy/preference revision and records the
  decision; rejecting leaves the current policy unchanged.
- Preserve the existing role-match review surface and score-correction action;
  expose their decisions through the shared audit contract instead of requiring
  users to approve them again.
- Reuse existing explicit rescore and re-tailor controls. Never silently replace
  an accepted artifact or retroactively rewrite history.
- Finish canonical user/API/architecture/storage docs and run the cumulative
  high-risk regression matrix.

## Migration and rollback

- Forward recovery and previous-release rollback are different operations.
  Retrying or reopening with the same/new release keeps committed generated
  IDs. Rolling back to the previous release restores the paired pre-upgrade
  SQLite and Temporal snapshot and therefore intentionally removes IDs and
  writes created after that snapshot; there is no in-place down-migration.
- The stable-ID cutover runs only after authoritative Temporal quiescence,
  durable-owner, and referential-count preflights pass and a consistent paired
  SQLite/Temporal snapshot exists. A failed transaction leaves the prior schema
  untouched.
- The application refuses an unsupported schema in both the TypeScript API and
  Python worker; neither side performs a partial compatibility write.
- The migration runner verifies the current version before DDL and stamps the
  new version only after all DDL, backfills, count checks, and foreign-key checks
  pass. A failed attempt therefore remains retryable at the prior version.
- Each migration fixture records before/after counts and canonical references.
  Rollback tests restore and reopen the exact pre-cutover SQLite/Temporal pair
  with the previous release; forward-recovery tests reopen the migrated pair
  with the current release and retain IDs.
- Learning records are append-only audit facts. Disabling learning stops
  derivation and policy acceptance without deleting feedback or reverting
  accepted policy revisions.

## Verification

This is Tier 3 because it changes persisted identity, private feedback
boundaries, and workflow controls.

- Intermediate PRs run focused schema/repository, API, frontend, and workflow
  tests plus one independent review.
- The final cumulative branch updates canonical documentation and runs the
  cross-stack checks, migration/reopen fixtures, projection parity, workflow
  cancellation product path, realtime patch tests, feedback privacy tests, and
  independent reviewer and QA gates.
- All fixtures use synthetic jobs, employers, feedback, artifacts, and outcomes.
  No local profile, resume, application, database, or log data is committed.

## Acceptance criteria

1. Editing a posting URL does not change the job's ID or disconnect any score,
   artifact, event, stage state, outcome, or workflow reference.
2. Existing schema data migrates with exact canonical row/reference counts and
   reopens successfully through both the Python worker and TypeScript API.
3. The registry-derived cutover preflight refuses to start while any
   authoritative URL-bearing workflow or durable unit is active, and
   upgrade/restart fixtures prove no legacy/new workflow identity can
   dual-start.
4. A full Python and TypeScript projection rebuild from pre-cutover immutable
   events resolves every event-column and payload URL through the upcaster and
   emits only stable IDs.
5. Job projections contain no URL-shaped identity, legacy-column fallback, or
   synthetic artifact row.
6. Source and employer filters operate independently, and scoring-keyword search
   uses an indexed canonical relation.
7. Discover, preparation, and Apply runs can be inspected and canceled from the
   same run experience with truthful terminal history.
8. Common job, artifact, dashboard, and run events update visible data without
   broad list reloads, while incomplete payloads use the bounded fallback.
9. Every learning recommendation is traceable to allowlisted reviewed signals,
   meets the support and cross-job threshold, exposes contradictions and sample
   limits, passes its deterministic evaluation fixture, and contains no source
   free text.
10. Correcting, deleting, or tombstoning a signal deterministically re-derives
    pending recommendations without erasing canonical review history.
11. Accepting a recommendation creates a context-owned versioned revision and
    leaves prior scores, artifacts, profile facts, and Apply decisions unchanged
    until the user invokes the normal explicit recomputation path.
