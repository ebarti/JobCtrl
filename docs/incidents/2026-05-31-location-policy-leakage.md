# Incident Report: Location Policy Leakage

Date: 2026-05-31
Status: investigated; fix required
Severity: High

## Summary

Jobs that did not match the active target-location policy reappeared in the
active Jobs view. The visible examples were remote postings restricted to
non-target geographies, including titles or locations carrying India or Poland
constraints, while the active profile target was Spain-centered.

The immediate cause was not the table sorter or display normalization. The
database shows these rows had already been classified as current-policy
violations by discovery hygiene, then were restored by later source observations.
The durable problem is that discovery ingestion treats a fresh observation of an
existing deleted job as enough to restore it, without replaying the policy check
that caused the deletion.

This report intentionally avoids raw job URLs, company names, profile PII, and
generated local artifacts.

## Expected Behavior

Repository documentation says active jobs from JobSpy, direct ATS, Workday, and
Smart Extract must be rechecked against the current title, location, and
description contract, and rows that no longer pass should be soft-deleted rather
than remaining visible.

For the current local configuration, the profile-derived target search resolves
to:

- target location: Barcelona, Spain
- target work models: Remote, Hybrid, On-site
- effective search locations: Barcelona, Spain; Spain; European Union
- effective accept patterns: Barcelona, Spain; Spain; Espana; ES; Europe;
  European Union; EU; EMEA
- effective reject patterns include America-only regions and explicit
  non-target countries such as India

Under that policy, plain `Remote`, `Poland (Remote)`, `Work from Home - Poland`,
and `Remote India` do not match the target.

## Evidence

Observed active rows:

- A country-restricted title with displayed location `Remote`.
- A second country-restricted title with displayed location `Remote`.
- A non-target-country remote location displayed as `Poland (Remote)`.

Database checks showed:

- The affected rows were active in `job_list_projections` with current stage
  `tailor` and state `pending`; they had no active tombstone.
- The same rows had earlier `jobhunter_deleted_jobs` entries with reasons such
  as `location_mismatch` and `title_mismatch, location_mismatch`.
- Those tombstones later had `restored_at` values after `deleted_at`, which made
  the read model treat them as active again.
- `job_events` contained repeated `JobSourceObserved` events for the same rows
  after the hygiene deletions, but no matching `JobRestored` audit event from the
  domain restore path.

Code checks showed:

- `retire_invalid_source_jobs` correctly computes source-family hygiene reasons
  and writes tombstones for rows that fail the current discovery contract.
- `DiscoverJobsUseCase` restores an existing deleted job whenever a new source
  observation resolves to that job. The restoration happens before any
  current-policy guard is applied to the restore decision.
- Full discovery has before/after hygiene hooks, but the restore path itself is
  not policy-aware, so any source-specific run or interrupted run can leave a
  restored policy violation visible until another successful hygiene pass
  catches it.

A current dry run of the Greenhouse and Ashby adapters with the active
configuration did not emit the visible off-policy examples. That reduces the
likelihood of a current adapter filter bug, but it does not remove the incident:
the database already proves that an observation can resurrect a row previously
deleted for `location_mismatch`.

## Root Cause

The lifecycle boundary between discovery observation and current-policy
eligibility is wrong.

Discovery has two separate mechanisms:

- Hygiene can soft-delete a row when current title, location, or description
  policy rejects it.
- Ingestion can restore a soft-deleted row when a source observes it again.

Those mechanisms are not symmetric. Deletion is policy-aware; restoration is not.
As a result, a row deleted for `location_mismatch` can become active again if a
later source observation reaches the write boundary.

## Five Whys

1. Why were non-target jobs visible?
   Because their active tombstones had `restored_at` values later than
   `deleted_at`, so active-list queries no longer filtered them out.

2. Why were the tombstones restored?
   Because `DiscoverJobsUseCase` restores deleted existing jobs on source
   observation.

3. Why did restoration ignore the location mismatch?
   Because the restore path does not evaluate the current discovery contract or
   preserve the tombstone when the observation still fails policy.

4. Why did hygiene not prevent the visible regression?
   Because hygiene is a cleanup pass around discovery orchestration, not an
   invariant at the restoration boundary. If a source-specific run restores a row
   after a cleanup pass, or a run is interrupted before cleanup, the row can
   remain visible.

5. Why was this not caught earlier?
   The tests verify filtering and hygiene independently, but they do not cover
   the lifecycle sequence `hygiene deletes -> source observes -> ingestion
   restores -> active read model`.

## Correct Fix Layer

The fix should be at the domain/application boundary where source observations
resolve to existing jobs, not only in the UI and not only in individual source
adapters.

Required behavior:

- Before restoring a deleted job, evaluate the same current discovery contract
  used by hygiene.
- If the observation still fails policy, keep the tombstone active and record an
  audit event that the observation was ignored because the job remains
  policy-incompatible.
- Emit a real `JobRestored` event only when restoration is intentional and
  policy-valid.
- Make source-specific discovery paths and full discovery paths share the same
  invariant so a future partial run cannot re-expose known-bad jobs.

## Regression Tests Required

Add tests for the full lifecycle:

- Seed a job with a target-location mismatch and an active tombstone.
- Feed a later source observation for the same job.
- Assert the row remains deleted when the current policy still rejects it.
- Assert the active Jobs list does not include it.
- Assert a valid re-observation can restore a deleted row only when it now
  matches current policy.
- Include title-embedded geography, such as a country name in parentheses, and
  location-field geography, such as a non-target country remote label.

## Immediate Containment

Running discovery hygiene with the current config should soft-delete the visible
off-policy rows again. That is containment only. It does not fix the root cause
because a later source observation can restore the same rows until the restore
decision becomes policy-aware.

## Open Questions

- Whether the source emission that restored these rows came from stale worker
  code, stale worker configuration, or a transient source-specific run path.
  Current adapter dry runs did not reproduce emission of the visible examples.
- Whether the UI should expose a filter or warning for rows that have recently
  flipped between deleted and restored due to discovery lifecycle churn.
