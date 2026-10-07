# Compensation Evidence

Compensation evidence is JobCtrl's persisted, inspectable record of what an
employer posted and what permitted reported-market sources support for a role,
level, and geography. Employer-posted facts, direct market benchmarks, and
geographically extrapolated benchmarks remain separate authorities. The Jobs
read model may display them together, but it never relabels a posted salary as
market evidence or an extrapolated range as a direct observation.

## How Compensation Is Calculated

### Employer-posted compensation

A configured model extracts what the posting states: amounts, currency, period and base/OTE/bonus/equity component, with verbatim citations and a rationale. Code checks exact numbers and quotes, then performs explicit annualization arithmetic. Missing or ambiguous pay remains visible; a nearby salary word or an annual-pay threshold cannot invent a period. The accepted fact cites its extraction determination.

### Direct and extrapolated market benchmarks

Job interpretation and cached provider-row classifications use the same occupation, seniority and place codes. Exact code equality selects comparable rows. Source/sample/freshness and currency arithmetic remain explicit. Provider ranges retain their source currency unless a persisted exchange-rate snapshot supports conversion; missing rates never use a hardcoded conversion. Direct benchmarks use documented EUR/year normalization; the displayed estimate cites row classification IDs. Levels.fyi routing uses code-to-slug tables, while fixed-format Markdown/structured payload parsing stays mechanical.

A failed refresh retains a previously accepted model-backed estimate and reports the blocked reason. It never substitutes a title/location classifier or fixed exchange rate. Compensation remains warning-only and cannot manufacture a hard eligibility blocker. The offline demo reports refresh unavailable. Native schema 13 withdraws old inferred estimates for recomputation from source evidence; the paired pre-upgrade backup remains recoverable.

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

### Source policy access mode {#source-policy-access-mode}

An access mode records the permitted basis JobCtrl may use for a compensation
source, such as attributed public pages or a separately licensed feed. Choosing
one does not connect a provider, create permission, or store credentials.

### Source policy Europe coverage {#source-policy-europe-coverage}

When a source requires it, explicitly confirm that the configured agreement
covers European compensation data. JobCtrl keeps the source disabled until the
access basis and required coverage declaration are both present.

### Enable a compensation source {#source-policy-enable-source}

Enabling a source makes it eligible for future automatic and explicit
compensation refreshes. It does not fetch immediately, and it never authorizes
an access mode that the saved policy or provider terms do not permit.

## Source Of Truth And Ownership

| Record | Authority | Important boundary |
| --- | --- | --- |
| Raw posting salary | Canonical job/source observation | Retained for compatibility and source review; UI reads do not repeatedly parse it. |
| Posted compensation fact | `job_posted_compensation_facts` | A source-bound model extraction with explicit missing, ambiguous, unparseable, or legal range state and warnings. |
| Direct market benchmark | `compensation_direct_benchmark_facts` | Append-only, source-dated role/level/geography evidence normalized to EUR/year. Never employer-posted compensation. |
| Price-level evidence | `compensation_price_level_facts` | Append-only official geography inputs used only for an auditable bridge. |
| Extrapolated market benchmark | `compensation_extrapolated_benchmark_facts` plus lineage tables | Append-only derived range with the exact direct anchor, price-level inputs, matched-company inputs, factor, confidence, and warnings. |
| Per-job market estimate | `job_market_compensation_estimates` | The latest matching direct or extrapolated benchmark projected onto an active job with sanitized source/evidence lineage. |
| Refresh state | `compensation_market_refresh_state` | Lease-fenced missing/due/failure status and the latest result reference for each reusable benchmark slice. A failed Levels role-and-level lookup keeps its lower-level direct fallback as that reference and retries after one day; other source-family failures do not mark a slice with a direct fact failed. |
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
4. **Parse posted evidence.** The worker records a model-backed posted-fact
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
