# Enrichment & Extraction

Enrichment turns an accepted job lead into a usable, auditable posting by
capturing its full description, application URL, detail-page metadata, active
state, and a provenance-bearing content snapshot. Extraction is the controlled
work used to obtain those facts from an API, posting page, browser render, or
user-mediated capture.

## What You Can See And Control

Enrichment is internal work under the user-facing **Discover** stage, not a
separate primary page or pipeline stage. Its results remain inspectable:

- `/jobs` shows source provenance, durable stage state, and whether a posting is
  active, closed, failed, or awaiting further work.
- `/jobs/:jobId` opens the Job Detail route workspace with the full posting,
  source and enrichment evidence, snapshot confidence or quarantine state,
  application URL, and allow-listed audit history.
- `/discovery` owns source review, quarantined leads, locator candidates, and
  manual-capture decisions.
- `/runs` shows the durable Discover and preparation workflows. A failed
  enrichment can be retried per job or in bulk without resetting unrelated
  completed stages.

When a useful posting cannot be fetched safely, use manual capture rather than
bypassing a site's controls. The current capture boundary accepts user-mediated
URLs or content, including browser-extension captures, and preserves that
origin as provenance. Protected or login-walled pages stay on a manual path.

An explicitly enabled authenticated-LinkedIn browser capability may resolve a
missing external application URL. That pass is bounded to URL resolution and
stops before any application form or submission; the capability and consent
rules remain owned by [Apply](apply.md#browser-apply-automation).

## Source Of Truth And Ownership

Several records participate, but they do not own the same fact:

- **Discovery owns intake and identity:** source observations, canonical job
  identity, deduplication, source-native identifiers, manual capture, and the
  source registry.
- **Enrichment owns posting detail:** fetch attempts, full description,
  application URL, content snapshots, extraction provenance, confidence, and
  active-state verification.
- **Scoring owns interpretation:** employer requirements, fit evidence, and
  scores are derived later from the accepted posting snapshot; they are not
  enrichment facts.
- **Operations owns the read projection:** list/detail pages read projection
  rows. A `GET` does not fetch the posting again or repair missing enrichment.

Canonical job/enrichment rows and `posting_snapshot_sets` live in
`jobctrl.db`. Events explain what changed, while projections make the latest
accepted state efficient to read. Raw captured content is not copied into broad
event payloads.

### The Quality Gate

A low-confidence snapshot that remains quarantined is still visible and may be
scored for cheap triage, but it is excluded from tailoring, cover-letter, and
Apply preparation. Confirming an operator override removes that quarantine
block. A snapshot whose only recoverable omission is the application URL is not
automatically treated as low-confidence.

This gate protects downstream claims without hiding imperfect leads from the
user. The exact selector rules are owned by the
[System Overview](../architecture/index.md#bounded-context-composition).

## Lifecycle

1. **Accept a lead.** Discovery validates search intent, records source
   observations, and resolves or creates the canonical job.
2. **Select missing work.** Discover selects jobs that do not yet have usable
   posting details; “pending” means that usable detail is absent, not that a
   speculative placeholder result exists.
3. **Acquire content safely.** Fetchers use public-destination validation,
   crawl politeness, per-source limits, and the configured honest user-agent.
   Manual capture remains the fallback for access that requires the user.
4. **Persist detail and snapshot.** The worker stores description, URLs,
   attempts, active state, provenance, confidence, and snapshot audit records
   before later stages consume them.
5. **Gate and hand off.** Usable records move into per-job preparation. A
   quarantined low-confidence record remains visible but is stopped before
   employer-facing materials or Apply.
6. **Recover locally.** One failed job does not fail healthy jobs in the same
   site batch. Site-level partial results remain inspectable, and retry resumes
   the failed work rather than rerunning the whole lifecycle.
7. **Recheck active state.** Later hygiene can move a verified unavailable,
   expired, removed, or location-incompatible posting to the Closed view while
   preserving its evidence.

## Implementation And API Pointers

| Layer | Pointer |
| --- | --- |
| User workflow | [Discovery](discovery.md) and [Daily Workflow → Run Discover](normal-flows.md). |
| HTTP contract | `GET /v1/jobs`, `GET /v1/jobs/:jobKey`, Discovery queue/capture routes, and per-job or bulk retry actions; see [Jobs & Materials API](../api/jobs-and-materials.md) and the [complete contract](../api/complete-contract.md#discovery-controls). |
| Workflow entry | Discover starts through the pipeline action routes documented in [Operations & Events API](../api/operations-and-events.md#starting-work). |
| Live worker path | `workers/automation/src/jobctrl/pipeline/runner.py` and `workers/automation/src/jobctrl/enrichment/detail.py`, with fetch adapters under `workers/automation/src/jobctrl/infrastructure/enrichment/`. |
| Deep architecture | [Stage Walkthrough → Detail Enrichment](../architecture/pipeline/stages.md#detail-enrichment), [Crawl Politeness](discovery.md#crawl-politeness), and [Storage](../architecture/storage.md). |
