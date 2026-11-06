# Compensation feature

This package owns source permission settings, posted and reported pay evidence,
normalization and compensation refresh actions. `core/` uses only standard
Python and receives neutral sources, model judgments, rates and policies; it
imports no JobCtrl database, ID, HTTP, Temporal, configuration or model types.
The JobCtrl adapters map public Jobs snapshots, host configuration, strict
model receipts, provider transports, feature-owned SQLite and durable actions.

The model gateway makes meaning decisions using the compensation lane and
spend preflight. A result is accepted only when its exact source hash, source
reference, citation spans and (for amounts) cited numeric values agree. Exact
occupation, seniority and country codes select comparable rows. Unknown
currency, period, dates, one-sided values and component differences remain
explicit. A source-bound classification is reused only for an exact model
input fingerprint after validating its saved receipt again.

A refresh leases its job and snapshots source permissions. Its accepted posted
and market records publish together only if the lease, posting revision/hash,
source permissions and optional automatic-refresh switch remain current. Failure
or cancellation preserves the prior records. The feature stores bounded, safe
provider receipts and emits identifier-only invalidations. Committed Jobs
changes can request the `compensation.refresh_stale` action; automatic retries
respect the seven-day freshness window and one-day source failure backoff.

The provider adapters support Euro Top Tech, explicitly permitted Levels.fyi
public pages and licensed feeds, permitted Glassdoor feeds, explicit manual
imports, and dated ECB/Eurostat inputs. Direct benchmark inputs with a known
sample, country, role and level can be normalized to EUR/year using an explicit
rate and retain both original and normalized evidence. When an ECB rate is not
available, the original reported range is retained rather than an inferred rate.
Country-level extrapolation uses a verified direct country benchmark and
compatible Eurostat price levels. City observations cannot become country
anchors. When two provider-owned company references and a separate source-bound
identity determination establish the same employer, their direct observations
may contribute to the adjustment; names alone never establish an identity.
Direct target-country market evidence takes precedence.
If no direct market or geographic benchmark is available, an otherwise valid
same-location company observation can provide a company-scoped fallback; that
does not establish that the observation's employer is the job's employer.

Verified direct inputs and official ECB/Eurostat snapshots are reusable across
jobs while their original acquisition windows remain fresh. The feature
revalidates their source data, model receipts and exact acquisition records on
publication and readback. Reuse does not extend an input's life: the reported
expiry is the earliest expiry of the inputs actually used. Expired accepted
evidence remains readable with `evidenceFresh: false`, and schedules a refresh.
The feature-owned repository and unit of work keep the posting, policy, lease,
model-receipt, cancellation and record publication fences in one transaction.

## Public application surface

- `GET/PATCH /v1/compensation/sources`: read and revision-fence user policy.
- `GET /v1/jobs/{id}/compensation[/posted|/market]`: inspect combined or
  individual evidence. `sourceCurrent` signals whether a retained result still
  matches its posting; `evidenceFresh` and `evidenceFreshUntil` report whether
  market inputs are still within their actual acquisition windows. A failed
  refresh does not remove that result.
- `POST /v1/jobs/{id}/actions/refresh-compensation` and
  `POST /v1/jobs/actions/refresh-compensation`: submit durable refreshes.
- Public application methods include `posted`, `market`, `combined`,
  `outreach_sources` and `delete_job_data`; sibling features use these methods,
  never Compensation's tables.

Licensed feed paths can be configured explicitly or discovered at the existing
home-directory locations only when the matching source permission is enabled;
synthetic QA never inspects those defaults. The synthetic application journeys
exercise direct and geographic calculations, company identity, official data,
source failures and cross-job reuse with controlled external boundaries. The
coordinator owns overall browser/Temporal verification, cutover and removal of
legacy writers.
