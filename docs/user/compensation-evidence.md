# Compensation Evidence

Compensation evidence is JobCtrl's persisted, inspectable record of what an
employer posted and what permitted reported-market sources support for a role,
level, and geography. Employer-posted facts, direct market benchmarks, and
geographically extrapolated benchmarks remain separate authorities. The Jobs
read model may display them together, but it never relabels a posted salary as
market evidence or an extrapolated range as a direct observation.

## How Compensation Is Calculated

JobCtrl produces independent evidence records and displays them together only
for comparison:

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
4. **Keep cash and equity separate.** When a posting states one cash amount and
   mentions stock or equity as an additional benefit, the cash amount remains
   the posted figure and the unpriced equity is not folded into it. Extraction
   certainty describes the parser only; it is not presented as doubt that the
   employer stated the amount.

### Direct and extrapolated market benchmarks

1. **Discover reusable benchmark slices.** At the end of each Discover run,
   active jobs are classified with JobCtrl's versioned role-family taxonomy and
   grouped by role family, seniority, country, and compensation component. Jobs
   whose role family or country cannot be resolved remain explicitly without a
   market benchmark.
2. **Refresh only missing or due slices.** A lease-fenced refresh claims each
   missing slice, or a slice whose seven-day freshness window has expired, at
   most once for that run. Euro Top Tech is a fixed public source. Levels.fyi
   and Glassdoor are loaded only when their Settings policy explicitly permits
   the selected access mode; an absent Levels.fyi preference remains disabled.
3. **Normalize direct evidence.** Supported observations are canonicalized to
   EUR per year with source-dated ECB exchange rates when conversion is needed.
   Direct facts preserve role taxonomy, seniority, exact geography, sample
   count, source snapshot, freshness, confidence interval, attribution, and
   evidence hash. Employer-posted compensation is not a direct market fact.
4. **Extrapolate missing geographies audibly.** When no fresh exact-country
   benchmark exists, JobCtrl may derive one from another country using Eurostat
   price-level evidence and same-company cross-country pay ratios. The company
   bridge is shrunk toward the cost-of-living factor according to its evidence
   weight. A cost-of-living-only range is allowed at low confidence. The raw
   factor and numeric range remain visible even outside the supported `0.1x` to
   `10x` review bound, with a prominent `factor_out_of_bounds` warning.
5. **Materialize the last good result.** The latest direct or extrapolated fact
   is attached to every matching active job, with lineage and warning codes. A
   source outage cannot erase a prior usable range; failed source availability
   retries after one day, while successful or insufficient slices are checked
   again after seven days.

Employer-posted facts may be parsed when Discovery ingests or refreshes a job
and are also reparsed during an explicit compensation refresh. When the
deterministic parser changes, worker startup upgrades known older facts in
bounded, retry-safe batches before rebuilding their read models. Direct benchmark
discovery and geographic extrapolation run automatically at the end of
Discover, after terminal enrichment and before terminal preparation fan-out.
The existing explicit compensation refresh remains available for focused
company-role evidence maintenance. Opening Jobs or Apply Review remains a
passive read of persisted evidence; it does not fetch or recalculate salary.

## What You Can See And Control

- `/jobs` has separate sortable/filterable columns for normalized posted
  minimum and maximum, reported-market estimate, confidence, and warnings. A
  missing value remains visibly missing rather than being guessed.
- `/jobs/:jobId` opens the full **Compensation evidence** section. It separates
  the amount stated by the employer from the market salary estimate and leads
  with those two decision outcomes. If the selected evidence cannot support a
  trustworthy market range, the screen says that no reliable range is
  available and explains why instead of surfacing a candidate span. The actual
  evidence records, reported sample counts, and provider snapshots are
  available under **Evidence reviewed**. Role/level matching, reliability
  percentages, warnings, direct benchmark authority, and geographic
  extrapolation lineage remain available under **How this was assessed**. A
  reliability percentage is an evidence support input, not a probability that
  the salary is correct.
- The Job Detail workspace can still start a focused compensation refresh. The
  Jobs toolbar can refresh the current backlog. The normal job-detail action
  uses configured sources and has no per-job file-path field. Advanced local
  observation imports remain available only through the CLI or API; automatic
  discovery does not infer permission from the presence of a local file.
- `/apply-review` shows the persisted compensation summary as context. It is not
  an Apply readiness or approval gate.
- `/settings` owns **Compensation sources** policy. Enabling or disabling a
  permitted public or licensed source changes what future automatic and
  explicit refreshes may load; saving policy does not fetch a provider.

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
| Direct market benchmark | `compensation_direct_benchmark_facts` | Append-only, source-dated role/level/geography evidence normalized to EUR/year. Never employer-posted compensation. |
| Price-level evidence | `compensation_price_level_facts` | Append-only official geography inputs used only for an auditable bridge. |
| Extrapolated market benchmark | `compensation_extrapolated_benchmark_facts` plus lineage tables | Append-only derived range with the exact direct anchor, price-level inputs, matched-company inputs, factor, confidence, and warnings. |
| Per-job market estimate | `job_market_compensation_estimates` | The latest matching direct or extrapolated benchmark projected onto an active job with sanitized source/evidence lineage. |
| Refresh state | `compensation_market_refresh_state` | Lease-fenced missing/due/failure status and the latest successful result reference for each reusable benchmark slice. |
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
   sources a future automatic or explicit refresh may use. This step is
   network-free, and an absent preference is not consent.
3. **Finish Discovery.** After terminal enrichment, `DiscoverWorkflow` invokes
   the replay-safe `automatic_compensation_refresh` activity. It deduplicates
   active role/level/country slices and skips every slice that is still fresh.
4. **Parse posted evidence.** The worker deterministically records a posted-fact
   state, normalized legal range fields when available, parser identity,
   confidence, and warnings without overwriting the raw salary.
5. **Refresh and derive market evidence.** Missing or due slices load permitted
   reported sources, normalize direct facts, and use official price levels plus
   matched-company ratios when an exact country is unavailable. Source-family
   failures are isolated; a failed automatic activity is reported as a bounded
   Discover warning and does not block healthy discovery or preparation.
6. **Project and display.** A privacy-bounded compensation event refreshes Jobs
   list/detail reads. Both Python and TypeScript projection builders materialize
   the same summary/audit shape; the UI renders it without client-side salary
   parsing.

A per-job, all-jobs, or CLI action can also start the independent
`CompensationRefreshWorkflow`; it does not rerun discovery, scoring, tailoring,
cover generation, or Apply.

A later source-policy change affects later refreshes only. Previously persisted
evidence remains an auditable snapshot of what supported that estimate at the
time, and the next Discover run checks any missing or due slice against the new
policy.

## Implementation And API Pointers

| Layer | Pointer |
| --- | --- |
| User surfaces | `/settings`, `/jobs`, `/jobs/:jobId`, and `/apply-review`; the review loop starts at [Daily Workflow → Review Jobs](normal-flows.md). |
| HTTP contract | `GET/PATCH /v1/compensation/sources`, posted and market inspection routes, and per-job/all-jobs refresh actions; see [Jobs & Materials API → Compensation](../api/jobs-and-materials.md#compensation). |
| Canonical API implementation | `apps/api/src/compensation-source-policy.ts`, `posted-compensation-facts.ts`, `market-compensation-estimates.ts`, `read-model.ts`, and `projections.ts`. |
| Worker implementation | `workers/automation/src/jobctrl/domain/compensation/` and `workers/automation/src/jobctrl/infrastructure/compensation/`. |
| Web implementation | `apps/web/src/contexts/enrichment/components/CompensationEvidence.tsx`, `apps/web/src/contexts/scoring/components/CompensationSourcePolicyPanel.tsx`, and Jobs/Apply Review composers. |
| Deep architecture | [Storage → Schema At A Glance](../architecture/storage.md#schema-at-a-glance), [Apply Feedback & Projections → Evidence, Analytics, And Compensation](../architecture/read-model.md#evidence-analytics-and-compensation), and the [complete compensation contract](../api/complete-contract.md#compensation). |
