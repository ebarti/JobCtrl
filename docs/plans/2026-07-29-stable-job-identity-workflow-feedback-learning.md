# Stable Job Identity, Workflow Parity, And Feedback Learning

- **Date:** 2026-07-29
- **Status:** Accepted — implementation in progress
- **Delivery shape:** Small stacked review PRs assembled into one release. PR
  boundaries are not database versions, and intermediate branches are not
  installed independently.
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
2. A posting URL remains unique per tenant and may resolve through the
   canonical locator/alias relation at an explicit user, API, or import
   boundary. New writes, foreign keys, events, projections, API DTOs, and
   internal routes use `JobId`.
3. The schema migration is transactional, idempotent, and covered by the backup
   and schema-version guard. It preserves every canonical row, reference,
   accepted artifact, score version, event, and workflow association.
   The shipped schema advances exactly once from v6 to v7 after migration and
   referential verification succeed in the same commit. Review PRs do not
   increment it.
4. Projection builders read canonical aggregate tables only. They do not fall
   back to legacy nullable columns or synthesize artifacts without a
   `job_artifacts` row.
5. `Source.board` and `Employer.name` are persisted independently. Unknown
   employer data stays explicit rather than being guessed from a URL or source
   label.
6. Normalized scoring keywords are stored per score version and indexed. Search
   and aggregation return the keyword version that produced the visible score.
7. Historical domain event facts remain immutable. The v6-to-v7 migration uses
   one deterministic identity upcaster to replace URL ownership in event
   columns and root payload identity fields. The current runtime and projection
   builders accept only the migrated stable-ID event shape; the upcaster is not
   a runtime compatibility path.

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
- Define rollback, exact cutover, and cumulative QA boundaries before changing
  persisted user data.

### Phase 1 — one exact v6-to-v7 identity cutover

- Replace pre-migration schema stamping with one forward migration owned by the
  local upgrade path. It accepts shipped schema v6, creates the exact v7 shape,
  backfills it, verifies counts/references/foreign keys, and stamps v7 only
  after success.
- Rebuild the canonical jobs relation around `(tenant_id, job_id)`, retain
  posting/application URLs as locators, and migrate every job-owned table,
  durable event, workflow input/idempotency key, API DTO, and projection key in
  the same release cutover.
- Generate UUIDs for existing and new jobs. Resolve a URL only at migration or
  an explicit user/API/import locator boundary; downstream repositories receive
  `JobId` and never inspect old table shapes.
- Stop the local JobCtrl process tree before migration, require no in-flight
  workflow that carries the old identity contract, take the paired
  `jobctrl.db`/`temporal.db` backup, migrate, verify, and then start the new
  runtime. There is no rolling or mixed-version mode.
- Migrate historical event identity with the shared deterministic upcaster,
  then require current Python and TypeScript writers/readers to use the exact
  stable-ID event schema.
- Add representative v6 fixtures and prove failed migration retry, exact
  row/reference preservation, fresh v7 creation, forward reopen, and paired
  pre-upgrade restore.

### Phase 2 — canonical projection and field cleanup

- Remove projection fallbacks to legacy `jobs.*` status, score, application,
  and artifact columns.
- Remove phantom PDF synthesis; expose only database-backed artifacts.
- Persist and project `Source.board` and `Employer.name` independently.

### Phase 3 — searchable scoring keywords

- Normalize latest-score keywords into a versioned relation with tenant, job,
  score-version, normalized keyword, and display text.
- Add indexed keyword filtering and aggregation to the TypeScript API and typed
  client contracts.
- Remove free-text reasoning parsing after the migration fixture proves
  equivalent canonical coverage.

### Phase 4 — workflow-run parity

- Give Discover, `JobPreparation`, and Apply rows consistent labels, related-job
  context where applicable, timelines, actions, and cancel behavior.
- Reuse the context-owned cancellation mutation from both Pipelines and Workflow
  Runs rather than adding a view-owned API path.
- Cover accepted, canceling, canceled, already-terminal, worker-unavailable, and
  refresh-after-cancel states.

### Phase 5 — targeted realtime patches

- Add exact job, artifact, dashboard, and workflow-run patch handlers.
- Keep query keys tenant-first and retain a documented invalidation fallback for
  payloads that cannot support a truthful patch.
- Extend registry-derived event parity and patch/rollback tests.

### Phase 6 — feedback ledger and recommendations

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

### Phase 7 — review, accept, reject, and apply

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
- The Python upgrade owner accepts shipped v6 only long enough to run the one
  v6-to-v7 transaction. Afterward, both the TypeScript API and Python worker
  require exact v7 and neither inspects old columns, performs a partial
  compatibility write, or invokes the historical event upcaster.
- The migration verifies v6 before DDL and stamps v7 only after all DDL,
  backfills, count checks, and foreign-key checks pass. A failed attempt
  therefore remains retryable at v6. Fresh installs create exact v7 directly.
- The migration fixture records before/after counts and canonical references.
  Rollback tests restore and reopen the exact pre-cutover SQLite/Temporal pair
  with the previous release; forward-recovery tests reopen the migrated pair
  with the current release and retain IDs.
- Learning records are append-only audit facts. Disabling learning stops
  derivation and policy acceptance without deleting feedback or reverting
  accepted policy revisions.

## Verification

This is Tier 3 because it changes persisted identity, private feedback
boundaries, and workflow controls.

- Intermediate PRs are review slices of one unreleased cumulative build. They
  do not introduce schema versions or runtime compatibility modes. Each runs
  focused schema/repository, API, frontend, or workflow tests plus one
  independent review.
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
3. The local upgrade refuses to migrate while an old-identity workflow is
   active, and upgrade/restart fixtures prove the stopped v6 runtime is backed
   up and replaced by one exact v7 runtime.
4. The v6-to-v7 migration resolves every historical event-column and root
   payload URL through the migration-only upcaster; current Python and
   TypeScript projection rebuilds consume only stable IDs.
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
