# Enrichment & Extraction

Enrichment turns an accepted job lead into a usable, auditable posting by
capturing its full description, application URL, detail-page metadata, active
state, and a provenance-bearing content snapshot. Extraction is the controlled
work used to obtain those facts from an API, posting page, browser render, or
user-mediated capture.

Every accepted job receives one system-generated `JobId` inside its tenant.
Posting and application URLs remain external locators: changing a URL does not
change identity or detach the job's score, materials, stages, outcomes, events,
or workflow references. URL resolution happens only at explicit API, import,
capture, or migration boundaries.

## How A Lead Becomes A Usable Snapshot

Enrichment separates “we found a listing” from “we have enough trustworthy
posting detail to use it.” The current decision path is:

1. **Fetch once, then walk the configured extraction cascade.** JSON-LD, CSS
   selectors, and optional LLM-assisted extraction are tried in order. The first
   result with a usable full description wins; an application URL found by an
   earlier attempt can be retained for that result.
2. **Verify active state independently.** Extraction quality and whether the job
   still appears active are separate findings, so a well-extracted but
   unverifiable posting is not silently treated as active.
3. **Assign confidence from the posting-content evidence.** Description length
   and extraction tier determine whether the posting text is trustworthy. An
   application URL can strengthen structured extraction, but its absence never
   downgrades an otherwise complete description:

   | Extraction result | High | Medium | Low |
   | --- | --- | --- | --- |
   | JSON-LD | Application URL and at least 200 characters | At least 200 characters without the URL | Fewer than 200 characters |
   | CSS selectors | Application URL and at least 400 characters | At least 200 characters | Fewer than 200 characters |
   | LLM-assisted | — | At least 400 characters, with or without an application URL | Fewer than 400 characters |
   | Other configured tier | — | At least 200 characters | Fewer than 200 characters |

4. **Quarantine instead of guessing.** Unknown active state or low content
   confidence without an override is held for review. An explicit operator
   override can admit a low-confidence snapshot and is persisted with the audit
   trail; unknown active state remains quarantined. Application-target readiness
   is a separate fact, so a missing external application URL cannot quarantine
   readable posting content or block Tailor. A posting verified as closed,
   expired, or removed is recorded separately as `posting_inactive` rather than
   mislabeled as a low-confidence extraction.
5. **Surface duplicate candidates from content evidence.** An exact description
   hash is a `1.0` signal, the same normalized application URL is `0.95`, and
   token-Jaccard content similarity must reach `0.85`. These signals propose a
   duplicate for Discovery to resolve; Enrichment does not silently merge jobs.

A failed fetch or exhausted cascade records a retryable attempt without
manufacturing a snapshot. Failure remains isolated to that job, so useful
results from the rest of the source batch survive.

Application-target discovery has its own explicit outcome and retry policy:

| Outcome | What it means | Automatic retry |
| --- | --- | --- |
| External URL recovered | A public external application destination was verified and stored. | No |
| LinkedIn on-site apply | LinkedIn owns the application flow, so no external ATS URL exists. | No |
| Application control missing | No visible application control was found on the authenticated posting page. | Yes |
| External target missing | An application control was visible, but no external destination could be verified. | Yes |
| Navigation failed | The authenticated posting page could not be inspected. | Yes |
| Unsafe target rejected | The discovered destination failed the public-URL safety check. | No |

These outcomes describe application readiness; they do not change the posting
snapshot's content confidence. LinkedIn on-site apply is a successful terminal
discovery, while transient inspection failures remain eligible for recovery.
When an older snapshot was quarantined only because it lacked an application
URL, the next Enrich maintenance pass appends a corrected snapshot for any
source and resumes Tailor without requiring browser access. Resolver exception
details remain local diagnostics; the product surfaces only the stable outcome
code, message, method, and retry policy.

## What You Can See And Control

Enrichment is internal work under the user-facing **Discover** stage, not a
separate primary page or pipeline stage. Its results remain inspectable:

- `/jobs` shows source provenance, durable stage state, and whether a posting is
  active, closed, failed, or awaiting further work.
- `/jobs/:jobId` opens the Job Detail route workspace with the full posting,
  source and enrichment evidence, snapshot confidence or quarantine state,
  application URL, an explicit application-target outcome even when Enrich
  succeeded, and allow-listed audit history.
- `/discovery` owns source review, quarantined leads, locator candidates, and
  manual-capture decisions.
- `/runs` shows the durable Discover and preparation workflows. A failed
  enrichment can be retried per job or in bulk without resetting unrelated
  completed stages.

When a useful posting cannot be fetched safely, use manual capture rather than
evading a site's controls. The current capture boundary accepts user-mediated
URLs or content, including browser-extension captures, and preserves that
origin as provenance. Protected or login-walled pages stay on a manual path
unless they use the explicit owner-authenticated LinkedIn recovery below.

The Jobs page's **Import job** action applies the same boundary to one explicit
public URL. A readable page is ingested immediately with its extracted title,
employer, description, location, and posted salary evidence. A blocked or
ambiguous page creates a pending Manual Capture item and never a fabricated
"imported" job. Credential-bearing, private, loopback, and otherwise
non-public destinations are rejected before worker dispatch or browser
navigation. When the captured posting is active and clears snapshot policy,
the import records completed intake and enrichment, then starts the same
durable per-job preparation used by Discover: score, tailor, cover letter, and
PDF rendering. A missing separate application URL does not block that
preparation. Quarantined or inactive captures do not start it, and URL import
never starts Apply.

After the authenticated-LinkedIn browser capability is explicitly enabled and
the user selects one detected Chrome profile and separately consents to copy
it, JobCtrl may use that isolated owned session to recover the full posting and
external application URL. Settings shows Chrome's profile display labels while
keeping executable and profile paths private; choosing another profile stages
the new copy before replacing the prior JobCtrl-owned copy. The anonymous
`robots.txt` verdict is not applied to this
owner-authenticated request. Public-destination validation, per-host pacing,
the shared run request budget, and audit history remain enforced. Recovery
stops before the application form and cannot submit an application; capability
and consent ownership remains documented under
[Apply](apply.md#browser-apply-automation).

When that capability becomes fully ready, JobCtrl immediately continues the
browser-conditioned Enrich → Score → Tailor → Cover path for the affected
LinkedIn jobs only; unrelated robots blocks and ordinary pending jobs are not
retriggered, and another Discover run is not required. Legacy snapshots that
coupled readable content to a missing application URL are repaired by appending
a new immutable snapshot version and releasing only the stale
`ENRICHMENT_QUARANTINED` Tailor blocker. This content-trust repair does not need
a browser navigation and does not invent an application URL. A successfully
recovered external URL also creates a new immutable snapshot version.

Authenticated Apply-URL inspection records one explicit outcome instead of a
generic “unresolved” message:

| Outcome | Meaning | Automatic retry |
| --- | --- | --- |
| External URL recovered | LinkedIn points to a verified public company or ATS URL. | No further lookup needed |
| LinkedIn on-site apply | LinkedIn owns the application flow, so no external URL exists. | No |
| Apply control missing | The authenticated page did not expose an application control. | Yes, within the bounded recovery budget |
| External target missing | A control was visible, but no external URL could be verified. | Yes, within the bounded recovery budget |
| Navigation failed | The authenticated page could not be inspected. | Yes, within the bounded recovery budget |
| Unsafe target | The discovered target failed JobCtrl's public-URL safety policy. | No |

The outcome code, plain-language reason, resolver method, and retryability are
kept in Enrich stage metadata and append-only job events. “LinkedIn on-site
apply” is a successful terminal discovery about target readiness, not an
Enrichment or Tailor failure. JobCtrl still stops before any application form or
submission.

## Source Of Truth And Ownership

Several records participate, but they do not own the same fact:

- **Discovery owns intake and identity:** source observations, canonical job
  identity, deduplication, source-native identifiers, manual capture, and the
  source registry.
- **Employer and source are independent facts:** Employer identifies the
  hiring organization; Source identifies where JobCtrl observed the posting.
  Neither is guessed from the other or from a URL during projection reads.
- **Enrichment owns posting detail:** fetch attempts, full description,
  application URL, content snapshots, extraction provenance, confidence, and
  active-state verification.
- **Scoring owns interpretation:** employer requirements, fit evidence, and
  scores are derived later from the accepted posting snapshot; they are not
  enrichment facts.
- **Operations owns the read projection:** list/detail pages read projection
  rows. A `GET` does not fetch the posting again or repair missing enrichment.

Canonical job/enrichment rows are keyed by `(tenant_id, job_id)` in
`jobctrl.db`; posting URLs are unique locators rather than primary or foreign
keys. `posting_snapshot_sets` and source observations retain their own
provenance. Events explain what changed, while projections make the latest
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
