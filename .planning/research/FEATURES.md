# Feature Landscape

**Domain:** Job-search salary range estimation and compensation audit triage
**Project:** JobHunter v1.3 Salary Range Estimator
**Researched:** 2026-06-19
**Overall confidence:** HIGH for posted salary extraction and UX/provenance behavior; MEDIUM for exact external-source availability and licensing/API constraints.

## Scope

This research covers only the v1.3 salary-range estimator surface:

- posted salary extraction from job postings;
- market salary estimation from external compensation sources such as Levels.fyi and Glassdoor where appropriate;
- statistical confidence and uncertainty display;
- compensation provenance;
- Jobs list and drawer triage.

It does not cover broad scoring redesign, auto-apply behavior, resume/material generation, new discovery sources, or public compliance/legal advice.

## Table Stakes

Features users expect. Missing = compensation triage feels incomplete or untrustworthy.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Posted salary extraction with source text | Salary is one of the first filters job seekers use, and pay-transparency norms increasingly make posted ranges a first-class job fact. | MEDIUM | Extract structured min/max, exact amount, period, currency, compensation type, and the original snippet. Treat the job posting as the primary source when present. |
| Posted-vs-estimated separation | LinkedIn and Glassdoor distinguish employer-provided/expected salaries from platform-estimated salaries; users need the same separation to avoid over-trusting a model. | LOW | In Jobs list and drawer, label "Posted" and "Market estimate" separately. Never merge them into one unlabeled range. |
| Normalized compensation model | Raw strings like "$150k-$180k + equity" are useful to preserve, but triage needs comparable annual/base fields. | MEDIUM | Store raw text plus normalized annual base range, currency, period, hourly/annual flag, bonus/equity/commission indicators, and parse warnings. |
| Parse confidence and warnings | Salary text is often ambiguous: hourly vs annual, OTE vs base, "up to", "competitive", broad ranges, bonus-heavy roles, or location-dependent bands. | MEDIUM | Confidence must attach to the parse, not just the final displayed number. Warnings should name the ambiguity. |
| Market estimate only when evidence matches the job | LinkedIn shows estimates only when enough matching role/company/location data exists. Levels.fyi and Glassdoor data are most useful when title, level/seniority, company, and location align. | HIGH | If evidence is thin or mismatched, show "not enough benchmark evidence" rather than a fabricated-looking estimate. |
| Source provenance for every market range | Compensation benchmarks are crowdsourced, modelled, or employer-provided; the user needs to know which. | MEDIUM | Persist source name/type, URL or source key when allowed, captured range/median, compensation components, sample/source count where available, freshness, and applicability notes. |
| Statistical confidence visible at point of decision | Estimates should carry confidence/range width where the user decides whether to inspect, defer, or apply. | MEDIUM | Jobs list can show compact confidence; drawer should explain what drives it: sample count, freshness, source agreement, role/location/company match, parse certainty. |
| Profile-floor comparison | JobHunter already stores `compensation.salary_expectation`, `salary_range_min/max`, currency note, target locations, work models, and seniority floors. | MEDIUM | Show whether posted max and/or market estimate clears the user floor. If below floor, render as an audit concern, not an automatic hide/filter. |
| Jobs list triage column | Salary facts must be visible before opening the drawer. | MEDIUM | Add a compact compensation cell: posted range first, market estimate second if present, below/near/above floor indicator, confidence badge, and warning marker. |
| Jobs drawer compensation audit section | The drawer is the existing audit workspace for "why this job is here." Salary belongs there with rank/readiness context. | MEDIUM | Add a dedicated compensation group near ranking/eligibility: posted salary, market estimate, floor comparison, source trail, assumptions, and warnings. |
| Honest empty states | Missing salary is common and can be caused by reposting or extraction loss. | LOW | Show "No posted salary found" and whether market estimation was skipped due to missing role/location/company/seniority evidence. |

## Differentiators Worth Considering

Features that set JobHunter apart. Not required for the first slice, but valuable if they stay audit-first.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Source agreement score | Helps the user see whether Glassdoor, Levels.fyi, posted range, and other benchmarks broadly agree or conflict. | HIGH | Useful only if multiple source families exist. Show "sources disagree" instead of averaging away conflict. |
| Negotiation anchor range | Converts compensation evidence into a practical discussion range without pretending it is an offer. | MEDIUM | Use posted range, market p50/p75, profile floor, and uncertainty. Label as "negotiation prep", not "expected offer". |
| Compensation component breakdown | Tech compensation often includes base, bonus, equity/RSU, commission, and OTE. Levels.fyi explicitly emphasizes total compensation and components. | HIGH | For v1.3, detect and label components; defer full equity vesting math unless source data is structured. |
| Freshness decay indicator | A 2023 salary report may be less useful than a current posted range; freshness is a major trust signal. | MEDIUM | Show captured/updated date and down-rank stale source data in confidence. |
| Comparable-role assumptions | Makes title/level mapping inspectable, especially for Staff/Principal/EM/Director roles. | MEDIUM | Store assumptions such as "mapped Staff Platform Engineer to Software Engineer L6 / Staff IC." Let the drawer reveal them. |
| "Why not estimated?" explanation | Avoids a blank market estimate feeling like a bug. | LOW | Examples: no matching role, location mismatch, company too small, no recent source, source terms unavailable, variable-comp role. |
| User correction loop | Lets the user correct parsed salary/floor comparison and improve future parsing. | MEDIUM | Could mirror scoring correction discipline later. Initial v1.3 can persist parse warnings and allow future correction. |
| Compensation source quality registry | Reuses JobHunter's source-health mindset for compensation sources. | MEDIUM | Track source family, allowed use, freshness, sample visibility, component coverage, and reliability notes. |

## Anti-Features

Features to explicitly not build.

| Anti-Feature | Why Avoid | What to Do Instead |
|--------------|-----------|-------------------|
| A single unlabeled salary number | It hides whether the value came from the employer, a parser, a benchmark, or a model. | Always label posted salary, extracted salary, and market estimate separately. |
| Automatic job blocking from opaque market estimates | The project brief explicitly says uncertain compensation should not silently rank, filter, or block jobs. | Render low-confidence or below-floor estimates as audit concerns and allow user judgment. |
| Averaging incompatible sources | Posted base salary, total compensation, OTE, Glassdoor employee reports, and Levels.fyi total comp are not interchangeable. | Normalize components separately; show conflicts and assumptions. |
| Scraping gated/prohibited data as a hidden dependency | External compensation products may restrict automated extraction, and access patterns may change. | Prefer public, official, allowed sources/APIs/export paths; record source availability and terms as provenance. |
| Presenting Glassdoor or crowd data as verified truth | Crowdsourced salary data varies by sample size, freshness, company size, role specificity, and self-selection. | Display confidence, sample/source count when available, freshness, and cross-source agreement. |
| Suppressing missing salary facts | Hiding the salary section when no posted pay exists makes the absence invisible. | Show an explicit missing state and the reason market estimation did or did not run. |
| Recomputing audit facts only in the UI | JobHunter's audit discipline requires displayed claims to have a source of truth. | Persist posted salary facts, estimate inputs, source records, assumptions, confidence, and warnings in the owning projection/read model. |
| Treating broad pay ranges as equally useful | Very wide ranges can be compliance theater or compensation ambiguity. | Flag broadness using range ratio/width and explain that wide ranges reduce decision usefulness. |
| Currency conversion without audit | The profile has a currency note, and postings may use USD/EUR/GBP or local currencies. | Store original currency and any converted value with rate/date/source or mark conversion unavailable. |
| Full compensation ranking redesign in v1.3 | Salary should enrich triage, not replace fit/readiness ranking. | Add compensation facts to existing Jobs list/drawer audit surfaces and keep scoring/readiness separate. |

## Specific UX Facts Jobs Triage Should Show

### Jobs List

The list should support fast scan, not full explanation. Add a compact compensation cell or group with these facts:

| UX Fact | Display Recommendation | Source of Truth |
|---------|------------------------|-----------------|
| Posted salary | Show the normalized range, e.g. `Posted $150k-$180k base`, preserving period/currency. | Structured posted salary fact from job posting/raw salary text. |
| Posted parse state | Small warning marker when parse confidence is not high or warnings exist. | Salary parse confidence + warnings. |
| Market estimate | Show only if supported: `Market ~$170k-$220k`, clearly labelled as estimate. | Persisted market estimate record. |
| Estimate confidence | Compact badge: High, Medium, Low, or Insufficient. | Estimate confidence bucket derived from evidence. |
| Floor comparison | Small status: `above floor`, `near floor`, `below floor`, or `floor unknown`. | Profile compensation fields + normalized salary/estimate. |
| Source count/agreement | Compact secondary text when useful: `3 sources agree`, `sources conflict`, `1 source`. | Salary-source registry/provenance. |
| Missing state | `No posted salary` or `No reliable estimate` rather than blank. | Extraction/estimation status. |

### Jobs Drawer

The drawer should make the compensation decision inspectable:

| UX Fact | Display Recommendation | Source of Truth |
|---------|------------------------|-----------------|
| Original source text | Show the exact excerpt or raw salary field that produced the posted salary fact. | Job posting salary string / compensation text snapshot. |
| Normalized posted range | Show min/max, currency, period, compensation type, and component labels. | Salary normalization model. |
| Parse warnings | List warnings such as "annualized hourly rate", "range is broad", "OTE/commission detected", "currency unspecified", "upper bound only". | Parser warnings. |
| Market estimate | Show estimated low/median/high or p25/p50/p75 if available, plus whether it is base or total comp. | Market estimate record. |
| Evidence basis | Show role, company, location, seniority/level, source families, captured dates, and sample/source count where available. | Source registry + estimate inputs. |
| Source trail | One row per source: source name, source type, value captured, freshness, match quality, and caveats. | Salary-source provenance rows. |
| Confidence explanation | Plain-language explanation of what makes confidence high/medium/low. | Confidence factor breakdown. |
| Profile-floor result | Compare user min/expectation/range to posted and market ranges; call out whether only the estimate clears the floor or the posted range does. | Profile compensation + normalized salary facts. |
| Decision caveat | Explain that estimates are for triage/negotiation prep and do not guarantee an offer. | Static product copy tied to estimate state. |
| Estimation skipped reason | If skipped, show why: insufficient matching evidence, source terms unavailable, variable-heavy role, missing location/seniority, or external lookup failed. | Estimation status. |

## How Statistical Confidence Should Be Displayed

Use two layers: a scan-friendly badge and an inspectable explanation.

| Confidence Layer | User-Facing Display | Backing Factors |
|------------------|---------------------|-----------------|
| Parse confidence | `Parsed: high/medium/low` with warning chips. | Explicit salary field vs body text, clear min/max, known period/currency, component ambiguity, range width, and parsing pattern reliability. |
| Estimate confidence | `Estimate confidence: high/medium/low/insufficient`. | Source count, sample count where available, data freshness, source agreement, company match, title/role match, seniority/level match, location match, compensation-component match, and source quality. |
| Range uncertainty | Prefer a visible range over a point estimate. Use median only as supporting detail. | Low/high, p25/p75, or confidence interval where the estimator actually supports it. |
| Confidence explanation | One sentence plus expandable factor list: e.g. "Medium: company and location match, but only one recent benchmark source and seniority mapping is inferred." | Factor breakdown persisted with the estimate. |
| Insufficient evidence | Show no range. Explain why the system withheld the estimate. | Estimation status and missing evidence list. |

Recommended behavior:

1. Display the range first, confidence second, source label third.
2. Use "estimate" in the label whenever the value is modelled or benchmark-derived.
3. Do not imply precision with unnecessary exact dollars; round estimates to sensible bands such as nearest `$1k`, `$5k`, or local equivalent.
4. Use plain language for confidence: "High confidence" means enough recent, matching, agreeing evidence; "Low confidence" means the range is a weak signal only.
5. Show confidence drivers in the drawer, not only a color badge. Users should know whether uncertainty comes from parsing, old data, one source, source conflict, or title/location mismatch.
6. If confidence is low, do not use the estimate for hard blockers. Use the posted salary, if present, for below-floor blocker/warning logic, and show low-confidence estimates as advisory context.
7. Treat wide posted ranges as a confidence issue. A range where max/min is unusually large should warn that the employer range may be too broad for precise triage.

## Dependencies on Existing JobHunter Features

| Existing Feature | Dependency | v1.3 Implication |
|------------------|------------|------------------|
| Jobs projection/read model | Jobs list and drawer already read `JobSummary` / `JobDetail` from Operations. | Add salary facts and estimate summaries as additive read-model fields; keep views as composers. |
| `JobOverview.tsx` | Currently displays raw `job.salary` beside location. | Replace or augment with structured posted salary and confidence while preserving raw/missing state access in the drawer. |
| `JobAuditTriage.tsx` | Existing audit workspace shows ranking confidence, apply concerns, sources, and readiness. | Add a compensation triage section using the same audit tone: facts, warnings, sources, confidence, and floor comparison. |
| Jobs table columns | Current columns include fit score, title, company, sources, location, stage, state, discovered, and apply. | Add salary/compensation as a scannable column or TitleStack-style secondary fact; avoid crowding ranking columns. |
| Profile compensation fields | Structured profile already stores salary expectation, currency, min/max range, and currency note. | Use these as the profile floor. Do not invent separate salary preferences unless normalization requires explicit annual/base semantics later. |
| Profile target search fields | Target locations, work models, tracks, and seniority floors already exist. | Use them to improve market-estimate matching and explain assumptions. |
| Existing scoring eligibility | Scoring already has logic for posted compensation below profile minimum. | Make this source-backed and visible; avoid a second hidden compensation gate. |
| Source provenance conventions | Jobs already expose discovery/posting source and apply audit sources. | Extend provenance patterns to salary sources rather than introducing an opaque estimator. |
| SSE/invalidation router | JobHunter refreshes projection-backed UI through Operations. | Add salary extraction/estimation events to read-model invalidation if v1.3 includes async worker computation. |
| Local-first safety | JobHunter treats profile, job, and generated artifacts as sensitive. | Keep salary-source snapshots bounded; do not expose local profile details or raw private source payloads in fixtures/stories. |

## MVP Recommendation

Prioritize:

1. Structured posted salary extraction with raw source text, normalized annual/base range, currency/period, parse confidence, and parse warnings.
2. Jobs list and drawer triage that shows posted salary, floor comparison, confidence, missing states, and source text.
3. Market estimate record/provenance model that can render "estimate unavailable" honestly before full external coverage exists.
4. One or two allowed external benchmark source adapters, only if they can produce provenance and confidence factors without violating access constraints.
5. Regression fixtures proving below-floor, no-salary, low-confidence, broad-range, and posted-vs-market-conflict states.

Defer:

- Deep equity/RSU vesting math: useful for Levels.fyi-style total compensation, but not needed for the first audit slice.
- Negotiation recommendation generation: depends on trustworthy source agreement and user correction loops.
- Automatic salary-based filtering/ranking: violates the v1.3 audit-first constraint until confidence and user preferences are validated.
- Broad compensation-source marketplace: start with a small source registry and explicit gaps.

## Sources

- JobHunter project brief and v1.3 scope: `.planning/PROJECT.md`
- JobHunter local QA and Jobs drawer smoke expectations: `docs/local-reliability-qa.md`
- JobHunter frontend architecture and Operations read-model conventions: `docs/frontend-target.md`
- JobHunter local API/read-model behavior: `docs/local-ts-api.md`
- Current Jobs drawer salary/ranking surfaces: `apps/web/src/views/jobs/JobOverview.tsx`, `apps/web/src/views/jobs/JobAuditTriage.tsx`
- Current profile compensation fields: `apps/web/src/contexts/profile/components/StructuredProfileEditor.tsx`
- Glassdoor salary estimate behavior and user need for salary before applying: https://www.glassdoor.com/blog/salary-estimates-announcement/
- Glassdoor salary-estimate inputs and distinction from personalized market value: https://www.glassdoor.com/blog/use-salary-estimates-determine-next-employees-salary/
- Glassdoor pay-range accuracy research and caveats around broad/variable-comp ranges: https://www.glassdoor.com/blog/pay-range-accuracy/
- Glassdoor Help Center salary confidence snippets from search result, including high/low confidence and estimate interpretation: https://help.glassdoor.com/s/article/What-Salary-Information-is-on-Glassdoor?language=en_US
- Levels.fyi verified salary documentation: https://www.levels.fyi/verified/
- Levels.fyi compensation benchmarking source description: https://www.levels.fyi/offerings/data/
- Levels.fyi public company salary pages showing role, level, total compensation, freshness, and source attribution patterns: https://www.levels.fyi/companies/google/salaries
- LinkedIn Salary Insights distinction between employer expected salary and LinkedIn estimated salary: https://www.linkedin.com/business/talent/blog/product-tips/introducing-linkedin-salary-insights
- Indeed pay transparency/job posting salary guidance: https://www.indeed.com/hire/resources/howtohub/can-you-post-a-job-on-indeed-without-salary
- Indeed Hiring Lab pay transparency trend data: https://www.hiringlab.org/2023/03/14/us-pay-transparency-march-2023/
- NYC Council Data Team salary transparency analysis on missing salaries and range-width ratios: https://council.nyc.gov/data/salary-transparency/
- Schema.org `JobPosting`, `estimatedSalary`, and `salaryCurrency` semantics: https://schema.org/JobPosting
- Schema.org `baseSalary`: https://schema.org/baseSalary
- Google Search Central JobPosting structured-data guidance and visible-content consistency requirement: https://developers.google.com/search/docs/appearance/structured-data/job-posting
- Province of British Columbia pay-transparency posting guidance for examples of acceptable/unacceptable salary wording: https://www2.gov.bc.ca/gov/content/governments/about-the-bc-government/gender-equity/wage-or-salary-information-on-job-postings
- UK Government Analysis Function guidance on communicating quality and uncertainty: https://analysisfunction.civilservice.gov.uk/policy-store/communicating-quality-uncertainty-and-change/
- Nielsen Norman Group explanation of confidence intervals and why ranges need accompanying uncertainty: https://www.nngroup.com/articles/confidence-interval/

