# Resumable JobStreaming Discovery Plan

- **Date:** 2026-07-17
- **Status:** Active — implementation is being delivered as a three-PR stack on
  top of PR #467.
- **Provider contract:** `jobstreaming==0.0.2`
- **Goal:** A broad-board discovery activity backed by JobStreaming that is
  interrupted after accepting a posting resumes from durable caller-owned state
  without losing accepted work, double-counting the run limit, or allowing an
  older attempt to overwrite a newer attempt.

## Product invariant

For every immutable query/location/board plan, each provider event is either
durably consumed and acknowledged or replayed. A newer Temporal activity
attempt fences the older attempt before reclaiming unfinished work. A canceled
workflow stays canceled; only infrastructure interruption and retry trigger
resume.

JobCtrl owns the execution plan, accepted-result count, unit lifecycle,
attempt fencing, checkpoint storage, and product-visible recovery status.
JobStreaming owns board concurrency, board-specific cursors, replay keys,
typed provider failures, and explicit acknowledgement mechanics.

## Delivery stack

- **Phase 1:** published as PR #468; focused verification and independent
  review passed.
- **Phase 2:** published as PR #469; focused verification and independent
  review passed.
- **Phase 3:** published as PR #470 on PR #469; implementation, canonical
  documentation, and cumulative validation are complete, with independent
  review and QA gates in progress.

### Phase 1 — provider boundary

- Replace `python-jobspy` with the pinned JobStreaming 0.0.2 release.
- Translate immutable JobCtrl search specs into provider requests in one
  infrastructure adapter.
- Consume typed events with explicit acknowledgement while preserving the
  current DataFrame/storage behavior.
- Prove option, result, partial-failure, and checkpoint parity with focused
  tests.

### Phase 2 — durable search units

- Persist immutable search units under the exact Discover workflow/run
  identity.
- Store the provider checkpoint and its revision in SQLite with compare-and-
  swap and an activity-attempt lease epoch.
- Persist accepted counts and lifecycle/recovery facts so retry does not reset
  a global run limit.
- Reject stale writes from a superseded attempt and keep event consumption
  idempotent.

### Phase 3 — Temporal resume and product contract

- Have the broad-board source activity (internally the `jobspy` compatibility
  family) plan or load units, claim unfinished work, stream each unit, consume
  each posting, then acknowledge it.
- Map retryable, terminal, cursor-reset, and cancellation outcomes without
  treating cancellation as resume.
- Surface recovery/error state through existing discovery progress and run
  evidence.
- Update canonical user, architecture, storage, development, and reliability
  documentation; run a worker-kill recovery fixture and cumulative review/QA.

## Acceptance criteria

1. Killing a worker after one accepted event causes a retry to continue from
   the persisted checkpoint; the accepted posting remains stored.
2. Replayed events are harmless and cannot increase the durable new-job count
   twice.
3. The run-wide limit is enforced from durable accepted state across activity
   attempts.
4. A stale activity attempt receives a checkpoint conflict after a newer
   attempt claims its unit.
5. A request fingerprint or cursor-schema mismatch fails explicitly rather
   than silently restarting.
6. Cancellation interrupts provider waits and leaves unfinished units canceled
   rather than retryable/stale.
7. Partial board success is retained while typed failures identify the board,
   retryability, and whether its cursor must be reset.

Canonical documentation is intentionally deferred to the final PR because the
three phases are one unreleased behavior stack. Intermediate PRs carry focused
tests and independent review; the final PR carries cumulative product QA.
