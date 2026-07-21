# Compensation Evidence

Compensation evidence is JobCtrl's persisted, inspectable record of what an
employer posted and what permitted reported-market sources support for a
company-role match. Posted facts and market estimates stay separate so a parsed
job-post salary is never presented as crowdsourced market data, or vice versa.

## How Compensation Is Calculated

JobCtrl produces two independent records and displays them together only for
comparison:

### Employer-posted compensation

1. **Record parse state.** A deterministic parser reads a bounded copy of the
   posting's salary text and records `missing`, `unparseable`, `ambiguous`, or
   `parsed_range` rather than forcing every string into a number.
2. **Interpret bounds conservatively.** One amount becomes an exact or one-sided
   range according to wording such as “up to” or “from.” More than two amounts,
   mixed compensation components, or additive bonus wording becomes ambiguous
   instead of being summed.
3. **Annualize only with a known period.** Annual amounts stay unchanged,
   monthly amounts use `12` months, and hourly amounts use `2,080` work hours.
   Unknown periods are not annualized. Missing currency/period, hourly
   conversion, broad ranges, and ambiguity lower confidence and remain visible
   as warnings.

### Reported-market estimate

1. **Load only permitted evidence.** An explicit refresh loads only enabled,
   supported observations. Rows older than 36 months, unsupported components,
   and unusable samples are excluded.
2. **Score the weakest factor.** Candidate rows are matched on company, role,
   level, location, component, freshness, sample support, agreement, and company
   tier. The estimate's confidence score is the **lowest** of those factor
   scores, so one weak link cannot be hidden by stronger unrelated matches.
   Critical company, role, and level factors below `0.55` are recorded as
   insufficiency reasons.
3. **Build the range and interval.** Selected evidence contributes the observed
   minimum and maximum. The confidence interval widens for fallback scopes, low
   sample count, location mismatch, dispersion, posted-only evidence, or low
   confidence. High confidence starts at `0.85` without a low-sample warning;
   medium starts at `0.62` when an estimated range is otherwise supportable.
4. **Persist uncertainty.** If the support does not clear the scope-specific
   evidence floor, JobCtrl persists an explicit insufficient/unavailable state
   rather than inventing a range. A material difference from the employer-posted
   range becomes a source conflict warning, never a fit-score adjustment.

Employer-posted facts may be parsed when Discovery ingests or refreshes a job
and are also reparsed during an explicit compensation refresh. Loading enabled
reported sources and matching market evidence happen only during that explicit
refresh. Opening Jobs or Apply Review remains a passive read of persisted
evidence; it does not fetch or recalculate salary.

## What You Can See And Control

- `/jobs` has separate sortable/filterable columns for normalized posted
  minimum and maximum, reported-market estimate, confidence, and warnings. A
  missing value remains visibly missing rather than being guessed.
- `/jobs/:jobId` opens the full **Compensation evidence** section. It separates
  the posted-salary parse from the reported company-role market estimate and
  exposes parse/estimate state, range, confidence, warnings, attribution,
  source trail, selected evidence, and matching factors when recorded.
- The Job Detail workspace can start a focused compensation refresh. The Jobs
  toolbar can refresh the current backlog. An optional local observation import
  can be supplied to an explicit refresh; it is never loaded by a passive read.
- `/apply-review` shows the persisted compensation summary as context. It is not
  an Apply readiness or approval gate.
- `/settings` owns **Compensation sources** policy. Enabling or disabling a
  permitted public or licensed source changes what a future explicit refresh
  may load; saving policy does not fetch a provider.

Your salary expectations in the Candidate Profile are personal preferences,
not evidence about the employer or market. [Configuration → Compensation
Sources](configuration.md#compensation-sources) owns where the non-secret policy
is stored and when a saved value applies. This page owns the source modes,
access boundaries, attribution, and refresh behavior that policy controls.

## Source Of Truth And Ownership

| Record | Authority | Important boundary |
| --- | --- | --- |
| Raw posting salary | Canonical job/source observation | Retained for compatibility and source review; UI reads do not repeatedly parse it. |
| Posted compensation fact | `job_posted_compensation_facts` | A versioned deterministic parse with explicit missing, ambiguous, unparseable, or legal range state and warnings. |
| Reported-market estimate | `job_market_compensation_estimates` | A persisted estimate state with selected sanitized evidence, provenance, match scope, confidence factors, and interval when support exists. |
| Source policy | `config.json` through `/v1/compensation/sources` | Safe enablement/access declarations only. No credentials, feed location, provider rows, or private-account state. |
| Jobs read model | Compensation JSON in list/detail projections | Displays already-persisted facts and estimates. `GET` routes neither fetch nor estimate. |

Reported observations preserve whether their provenance is public, licensed,
manual, or employer-posted. Safe public URLs and required attribution may be
shown; raw benchmark pages, private URLs, credentials, local paths, feeds, and
provider payloads are excluded from the API read model.

Compensation evidence does not change fit score, ranking policy, tailoring
eligibility, Apply readiness, review handoff, or Apply mutation behavior. A
source conflict is a warning to inspect, not a hidden decision rule.

## Lifecycle

1. **Capture source text.** Discovery and enrichment preserve the posting's raw
   salary field and bounded compensation text with the job record.
2. **Choose source policy.** Settings records which user-controlled reported
   sources a future refresh may use. This step is network-free.
3. **Start an explicit refresh.** A per-job, all-jobs, or CLI action starts
   `CompensationRefreshWorkflow`; it does not rerun discovery, scoring,
   tailoring, cover generation, or Apply.
4. **Parse posted evidence.** The worker deterministically records a posted-fact
   state, normalized legal range fields when available, parser identity,
   confidence, and warnings without overwriting the raw salary.
5. **Load and match permitted market evidence.** The refresh imports configured
   observations, selects company/role/location evidence, and persists either an
   estimated range or an explicit unsupported/unavailable/insufficient state.
   The fallback and confidence algorithm are owned by the
   [complete compensation contract](../api/complete-contract.md#compensation).
6. **Project and display.** A privacy-bounded compensation event refreshes Jobs
   list/detail reads. Both Python and TypeScript projection builders materialize
   the same summary/audit shape; the UI renders it without client-side salary
   parsing.

A later source-policy change affects later refreshes only. Previously persisted
evidence remains an auditable snapshot of what supported that estimate at the
time.

## Implementation And API Pointers

| Layer | Pointer |
| --- | --- |
| User surfaces | `/settings`, `/jobs`, `/jobs/:jobId`, and `/apply-review`; the review loop starts at [Daily Workflow → Review Jobs](normal-flows.md). |
| HTTP contract | `GET/PATCH /v1/compensation/sources`, posted and market inspection routes, and per-job/all-jobs refresh actions; see [Jobs & Materials API → Compensation](../api/jobs-and-materials.md#compensation). |
| Canonical API implementation | `apps/api/src/compensation-source-policy.ts`, `posted-compensation-facts.ts`, `market-compensation-estimates.ts`, `read-model.ts`, and `projections.ts`. |
| Worker implementation | `workers/automation/src/jobctrl/domain/compensation/` and `workers/automation/src/jobctrl/infrastructure/compensation/`. |
| Web implementation | `apps/web/src/contexts/enrichment/components/CompensationEvidence.tsx`, `apps/web/src/contexts/scoring/components/CompensationSourcePolicyPanel.tsx`, and Jobs/Apply Review composers. |
| Deep architecture | [Storage → Schema At A Glance](../architecture/storage.md#schema-at-a-glance), [Apply Feedback & Projections → Evidence, Analytics, And Compensation](../architecture/read-model.md#evidence-analytics-and-compensation), and the [complete compensation contract](../api/complete-contract.md#compensation). |
