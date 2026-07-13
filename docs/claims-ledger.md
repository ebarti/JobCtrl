# Public Claims Ledger

> **Repository-only.** This file is intentionally excluded from the published
> docs site (registered in `docs/.vitepress/config.ts` `UNPUBLISHED_FILES` +
> `srcExclude`, mirroring `docs/backlog.md`). It is a launch-governance
> artifact, not user documentation.
>
> Implements Phase A / GATE G1 of
> [`docs/plans/implemented/2026-07-05-launch-readiness-artifacts-plan.md`](plans/implemented/2026-07-05-launch-readiness-artifacts-plan.md)
> §5. No listed document in `CLAUDE.md` owns "public claim provenance," so this
> new doc is justified under the "avoid new docs unless nothing owns it" rule.

## Purpose

A single source of truth for every claim JobCtrl makes on a **public
surface**, each labelled `Current` / `Beta` / `Roadmap` and backed by a
resolving verification pointer, so the claim set can be **frozen** before any
launch asset (README, demo assets, hero, alternatives page) is built on top of
it. Every hero / README / product-tour claim must trace to exactly one row here
in one hop.

## Freeze status

> **OWNER-SIGNED CLAIM SET — FINAL FREEZE SHA PENDING.** The
> previous provisional stamp (`48714f95`, 2026-07-06) became stale when later
> changes added controlled Gmail application sending, the JobCtrl rename and UI
> refresh, public bootstrap and Homebrew distribution, and additional security
> hardening without refreshing their ledger rows. This audit re-anchored every
> `Current` / `Beta` recommendation and every verification pointer against
> `origin/main` @ `15356b39` on **2026-07-10**, then reconciled the in-progress
> launch-readiness changes in this worktree. On **2026-07-09**, the repository
> owner approved the repository-only location, the Current/Beta and synthetic
> evidence rules, single-owner accountability, the post-merge freeze rule, and
> every claim's scope and status through the guided review recorded in [Owner
> sign-off record](#owner-sign-off-record). A subsequent independent review
> narrowed CL-052's wording to match the already approved `Current` scope and
> canonical health behavior; it introduced no new capability or status choice.
>
> GATE G1 remains unsatisfied only because the signed claim set is not yet
> anchored to a post-merge commit. After the current worktree changes land,
> replace `15356b39` with that exact dated `origin/main` SHA and rerun the
> pointer, build, runtime, and release checks. A worktree state or an unrun
> workflow is not a freeze anchor.
>
> Unless a row says otherwise, `Last verified` means pointer resolution and
> claim-to-source reconciliation on 2026-07-09. Owner sign-off records an
> approved public statement; it does **not** constitute production benchmarking.

## How to read this ledger

**Status labels.**

- **Current** — shipped on `main`, has a resolving verification pointer, and its
  public wording needs no qualifier beyond what the claim already states to keep
  a reader from being misled. Only `Current` claims may appear above a README
  Current-vs-Roadmap boundary, on the hero, or in a demo asset.
- **Beta** — shipped and pointer-backed, but the capability has a known rough
  edge such that the public claim **must carry a load-bearing qualifier** to
  stay truthful. Beta claims may ship but only with that qualifier.
- **Roadmap** — not shipped. Roadmap claims may appear **only** in clearly
  labelled roadmap sections (`ROADMAP.md`); they never gate a demo asset and
  never appear above a README boundary or on the hero.

**Current-vs-Beta threshold (owner decision, plan §11.6).**
The owner set the bar on 2026-07-06: a brand-new LLM-generated user-facing
surface without real-usage validation is `Beta` in public copy even when its
truthfulness gates pass, because those gates prove a no-fabrication floor, not
output quality. Other shipped claims stay `Current` only when their honest
qualifiers are scope notes carried in the claim text, not load-bearing
reliability, maturity, or measurement caveats.

**Owner column.** `repo owner` is the owner-approved accountable role for every
row and for Phase C publication. The guided-review record below captures the
approval; a future ownership change must update both the affected rows and that
record.

**Verification pointer.** Prefers an existing requirement handle in
[`requirements.md`](requirements.md); otherwise an architecture doc, source
path, or test path that resolves on `main`.

**Synthetic evidence standard (owner decision, plan §11.6).** Synthetic data may
illustrate product behavior, drive screenshots/GIFs, and prove deterministic QA
invariants, but it may never measure public performance, speed, accuracy, or
outcome claims. Any public measurement claim needs a non-synthetic measurement
source and a resolving pointer.

## Claims

### Product surface

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-009 | The supported operator surface is a local React/Vite web application backed by the local TypeScript API and Python/Temporal worker. Its first-party routes cover Profile, Discovery, Pipelines, Dashboard, Jobs and job-detail audit, Apply Review, Runs, Artifacts, Evidence, Analytics, Outreach, Preferences, and Debug; mutations go through the API and server-side changes refresh through SSE-backed invalidation. | Comparison (Graphical user interface); Tour; README | Current | repo owner | [frontend architecture](architecture/frontend/index.md); [product tour](user/screenshots.md); `apps/web/src/routes/`; `apps/web/src/contexts/operations/invalidation-router.ts` | 2026-07-09 |

### Discovery and enrichment

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-001 | Multi-source discovery is driven by the user's target roles, locations, and seniority, and records which source each job came from. | Hero (Profile-Driven Discovery); README (What It Does); Tour (Configure Discovery) | Current | repo owner | `BR-042` (requirements.md); [pipeline stages](architecture/pipeline/stages.md) | 2026-07-09 |
| CL-002 | Discovery removes duplicate postings and retires postings that have closed. | Hero (Profile-Driven Discovery) | Current | repo owner | [pipeline stages](architecture/pipeline/stages.md) (dedupe); [envelope](architecture/pipeline/envelope.md) (CLOSED/NOT_FOUND reconcile) | 2026-07-09 |
| CL-003 | Scheduled discovery is off by default; a local Temporal Schedule runs on the configured cron only after the user enables it. | README (What It Does); Configuration | Current | repo owner | [pipeline operations](architecture/pipeline/operations.md) ("off by default"); [configuration](user/configuration.md) | 2026-07-09 |
| CL-004 | Enrichment adds full descriptions, canonical posting URLs, and apply URLs to postings. | README (What It Does) | Current | repo owner | [pipeline stages](architecture/pipeline/stages.md) | 2026-07-09 |
| CL-005 | The optional local browser extension captures the active job page (URL and visible text) over loopback and feeds it into the existing manual-capture importer, so dedupe, snapshots, quarantine, and source provenance stay identical to other user-mediated captures. It is loaded unpacked in the browser's developer mode. | README (What It Does; Browser Extension Capture And Autofill) | Current | repo owner | `BR-019` (requirements.md); [local TS API](local-ts-api.md) (`POST /v1/extension/captures`); `apps/api/src/server.ts` (route → `manualCaptureImporter`) | 2026-07-09 |
| CL-006 | Every discovery and enrichment fetch — `urllib` API calls and Playwright navigations alike — routes through one crawl-politeness gateway that honors `robots.txt` (a `2xx` is parsed and enforced; a `4xx`/`404` means the file is absent and the fetch is allowed per RFC 9309; a `5xx` or timeout is inconclusive and fails closed with a short-TTL recheck; a DNS failure or refused connection fails open with a warning), paces each host (minimum interval + concurrency cap; a server `Retry-After` is honored but clamped), and bounds each run's request budget. | README (What It Does — polite fetching); Security (Crawl Politeness); Configuration (Crawl Politeness) | Current | repo owner | [decisions](decisions.md) (2026-07-06 Crawl Politeness ADR); `workers/automation/src/jobctrl/infrastructure/network/politeness.py` (`PolitenessGateway`, `RunBudgetCounter`), `.../network/robots.py`, `.../network/rate_limiter.py` | 2026-07-09 |
| CL-007 | Outbound crawling stamps one honest `User-Agent` — `JobCtrl/<version> (+<repo url>)` by default, product token and contact overridable via `JOBCTRL_CRAWL_UA_PRODUCT` / `JOBCTRL_CRAWL_UA_CONTACT` — that never impersonates a browser on a surface JobCtrl controls, and `jobctrl doctor` prints the effective identity. | README (What It Does — polite fetching); Security (Crawl Politeness); Configuration (Crawl Politeness) | Current | repo owner | `workers/automation/src/jobctrl/infrastructure/network/politeness.py` (`resolve_honest_user_agent`); `workers/automation/src/jobctrl/cli.py` (doctor prints effective UA); [configuration](user/configuration.md) (Crawl Politeness) | 2026-07-09 |
| CL-008 | A blocked fetch is recorded as a first-class outcome — robots-disallowed, rate-limited, or budget-exhausted — never a scrape error, and is surfaced per source in the Source Health card and discovery controls. Broad boards fetched through `python-jobspy` own their internal per-board transport, so JobCtrl cannot robots-gate those individual requests and applies pacing + budget at its own invocation boundary, with `jobctrl doctor` disclosing when broad boards are active; the authenticated LinkedIn path uses the user's own logged-in browser session with its real browser identity — an owner-scoped exception that remains rate- and budget-limited. | Security (Crawl Politeness); Data & Safety (External Services) | Current | repo owner | `workers/automation/src/jobctrl/infrastructure/network/politeness.py` (outcomes → `operational_attempt_metrics`); `apps/web/src/contexts/discovery/components/SourcePolitenessBadges.tsx`; [security](user/security.md) (Crawl Politeness) | 2026-07-09 |

### Scoring

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-010 | A deterministic, versioned scoring policy scores fit 1–10 from structured evidence. | Hero (Explainable Scoring); README (What It Does); Tour (Job Detail) | Current | repo owner | [scoring](architecture/scoring.md) (`FitScore 1-10` from structured evidence) | 2026-07-09 |
| CL-011 | A per-requirement fit ledger explains why each score happened, with per-requirement evidence and match/gap. | Hero (Explainable Scoring); Tour (Job Detail) | Current | repo owner | [scoring](architecture/scoring.md); `job_requirement_fit_items` (`apps/api/test/qa-seed.ts`) | 2026-07-09 |
| CL-012 | Scoring is an applicant-side triage aid only — not employer-side candidate screening or a hiring decision. | README (Score jobs …); Data & Safety (Scoring Safety); Security (Scoring Is Applicant-Side Only) | Current | repo owner | `BR-022` (requirements.md) | 2026-07-09 |

### Compensation

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-013 | Employer-posted salary is parsed deterministically from the posting text (versioned parser, bounded source excerpt, confidence/warning codes), and a separate deterministic, versioned market estimate is computed from recorded reported-compensation observations (Levels.fyi / Glassdoor / manual imports, plus opt-in public Euro Top Tech data) — surfaced as a range with an explicit confidence band, or an `insufficient_evidence` / `unsupported` / `source_unavailable` state instead of a fabricated number. Both the posted fact and the estimate, with their audit, appear as the job-detail compensation evidence and the jobs-table compensation columns; it is an estimate, not the employer's offer or verified pay. | Tour (Job Detail; Jobs table); README (Review jobs …; CLI `compensation-refresh`); Normal Flows (Review Jobs); Configuration (Compensation Sources) | Current | repo owner | `TR-008` (requirements.md) (`CompensationRefreshWorkflow`); [configuration](user/configuration.md) (Compensation Sources); `workers/automation/src/jobctrl/domain/compensation/posted.py` (`parse_posted_compensation`), `.../compensation/market.py` (`estimate_market_compensation`); `apps/api/src/projections.ts` (`buildCompensationProjection` → `compensation_summary_json` / `compensation_audit_json`) | 2026-07-09 |

### Materials and tailoring

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-020 | Every tailored-resume bullet traces back to its source evidence (provenance). | Hero (Audited Materials); README (Score/Generate …) | Current | repo owner | [tailoring](architecture/tailoring.md) (provenance rows built from final generated text); `job_bullet_provenance` | 2026-07-09 |
| CL-021 | Deterministic fabrication gates block invented facts (no fabricated metric, date, title, employer, or ungrounded named technology); the gate fails closed. | Hero (Audited Materials) | Current | repo owner | [tailoring](architecture/tailoring.md) (Fabrication gate: `fabrication_detector.py`, `claim_grounding.py`) | 2026-07-09 |
| CL-022 | Keyword coverage is computed against the actual rendered resume text, never inferred from the job keywords alone. | Hero (Audited Materials) | Current | repo owner | [tailoring](architecture/tailoring.md) ("computed against the rendered resume text"); [materials](architecture/materials.md) | 2026-07-09 |
| CL-023 | Apply Review renders the current HTML/CSS resume from the same source that prints the final PDF, with line selection and in-document audit annotations, and lets the user edit text, formatting, and hyperlinks before approval. | README (Review generated resumes …); Tour (Apply Review) | Current | repo owner | `BR-046` (requirements.md); `apps/web/src/contexts/materials/components/ResumeAuditPins.tsx` | 2026-07-09 |
| CL-024 | Apply Review supports draft edits, named revisions, and comment threads with draft-aware approval; revising never destroys the last accepted artifact. | Data & Safety (Auto-Apply Safety) | Current | repo owner | `BR-052` (requirements.md) | 2026-07-09 |
| CL-025 | A failed material refresh (including a template change) preserves the last accepted artifacts instead of destroying them. | Data & Safety (Auto-Apply Safety) | Current | repo owner | `TR-032`, `BR-041` (requirements.md) | 2026-07-09 |
| CL-026 | Resume PDF style templates are editable in Preferences with a default template and a per-job override, without modifying candidate profile data. | README (Edit resume PDF style templates …) | Current | repo owner | [materials](architecture/materials.md) | 2026-07-09 |
| CL-027 | Apply Review can compare a freshly rendered resume draft against the last accepted artifact before approval, using the same rendered text and keyword-coverage source the audit uses; the comparison is read-only and does not replace the accepted artifact. | README (Normal Flow, step 7) | Current | repo owner | [materials](architecture/materials.md) (rendered text + coverage source); `apps/web/src/contexts/materials/selectors/compareCoverage.ts` | 2026-07-09 |

### Cover letters

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-042 | Cover letters are generated from the approved tailored resume plus canonical profile evidence (an approved resume is required first) and run the same deterministic never-fabricate and prose skill/tool gates as the resume body (CONTROL-03): a fabricated metric, date, title, or employer, or an ungrounded job-target technology, downgrades the letter to REJECTED — never shipped as approved — and every accepted or rejected letter carries a minimal truthfulness trail (`fabrication_audit`). Cover letters do not carry the resume's per-bullet provenance or keyword-coverage audit. | Hero (Audited Materials); README (What It Does); Normal Flows (Generate And Inspect Materials) | Current | repo owner | [materials](architecture/materials.md) (Cover-letter truthfulness gate); `workers/automation/src/jobctrl/scoring/cover_letter.py`; `.../domain/materials/use_cases.py` (`GenerateCoverLetterUseCase`); `scan_cover_letter` (`.../domain/materials/fabrication_detector.py`) | 2026-07-09 |

### Career evidence map

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-028 | The evidence map inverts the profile's achievements and skills into how they were actually used — resume-bullet usage, requirement-fit usage, generation-time skill coverage, and missing / blocked / transferable gaps — computed only from recorded generation-time linkages, with deleted or hidden jobs excluded. | README (What It Does); Normal Flows (Inspect The Evidence Map) | Current | repo owner | [read model](architecture/read-model.md) (`evidence_usage_projections`); `apps/api/src/server.ts` (`GET /v1/evidence-map` → `listEvidenceMap`) | 2026-07-09 |

### Interview preparation

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-029 | Grounded, stored interview prep is generated per job, reusing the resume-tailoring fabrication, claim-grounding, and adversarial-review gates behind a spend preflight; generation is a durable workflow (deterministic id, heartbeats, run-scoped retry idempotency via `origin_run_id`) and a failed refresh preserves the last accepted prep. It is stored pre-interview material with inspectable evidence links — explicitly not a live interview assistant (no transcript, no real-time copilot). | README (What It Does; Responsible Use); Normal Flows (Generate Interview Prep) | Beta | repo owner | [materials](architecture/materials.md) (Stored Interview Preparation); `workers/automation/src/jobctrl/interview/workflow.py` (spend preflight, deterministic id); `.../interview/activities.py` (`origin_run_id` idempotency, heartbeats); `.../domain/interview/use_cases.py` (materials gates reused, preserve-on-failure) | 2026-07-09 |

> **Why Beta.** CL-029 is shipped and pointer-backed, and its reused gates prove
> the no-fabrication floor. Per the owner's 2026-07-06 §11.6 bar, it remains
> `Beta` because it is a brand-new LLM-generated user-facing surface carried
> into high-stakes interview preparation without real-usage validation.

### Apply safety

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-030 | By default, no standing apply loop is enabled (`autoApply: false`) and live browser submission requires an explicit Apply Review approval (`applyApprovalRequired: true`), enforced in the worker's claim transaction rather than only surfaced in the UI. | Hero (Supervised Apply); README (Auto-apply …); Security (Apply Approval Is Required); Data & Safety | Current | repo owner | `BR-023` (requirements.md); [security](user/security.md) (worker claim transaction); `apps/api/src/application-feedback.ts`; `workers/automation/src/jobctrl/apply/launcher.py` | 2026-07-09 |
| CL-031 | The live-submit approval is bound to the reviewed materials generation, profile version, and application URL, and requires matching dry-run evidence. | Security (Apply Approval); Data & Safety (Auto-Apply Safety) | Current | repo owner | [security](user/security.md); `apps/api/src/application-feedback.ts`; `apps/api/test/application-feedback.test.ts` (approval binding, #271) | 2026-07-09 |
| CL-032 | A partial dry run satisfies the gate only through an explicit partial-evidence approval action that names the specific run and shows the blocked channels being accepted. | Security (Apply Approval); Data & Safety | Current | repo owner | [security](user/security.md); `apps/api/src/application-feedback.ts` (blocked channels, #271) | 2026-07-09 |
| CL-033 | Dry run submits nothing: the agent is told not to click submit, and a browser-level CDP guard blocks non-loopback POST/PUT/PATCH and overrides form submits. | Hero (Supervised Apply); README (Auto-apply …); Security (Dry-Run Cannot Submit) | Current | repo owner | [security](user/security.md); `workers/automation/src/jobctrl/apply/chrome.py` (`install_dry_run_cdp_guard` / `_DryRunCdpGuard`; non-loopback POST/PUT/PATCH → `Fetch.failRequest`; `_FORM_SUBMIT_GUARD_SOURCE` form-submit override) | 2026-07-09 |
| CL-034 | No application is ever submitted twice: claiming excludes runs already in progress / succeeded / parked for verification, a submit-intent checkpoint is recorded before submit, and a crash after that intent parks the run for manual verification instead of retrying. | Hero (Supervised Apply); README; Security (Applications Submit At Most Once); Data & Safety | Current | repo owner | `BR-054` (requirements.md); `workers/automation/src/jobctrl/apply/launcher.py` (`_has_apply_submit_intent`, needs_verification) | 2026-07-09 |
| CL-035 | JobCtrl never submits applications, runs destructive profile/database actions, or bypasses third-party controls (CAPTCHA, paywall, login, rate-limit, bot-control) without explicit user authorization; the apply agent stops on SSO, declines permission prompts, refuses ID/biometric verification, and never enters payment details. | README (Responsible Use); Security (No Third-Party Bypass; The Apply Agent) | Current | repo owner | `BR-001` (requirements.md); [security](user/security.md) | 2026-07-09 |
| CL-036 | Application outcomes can be recorded manually without browser automation, and web approval facts do not submit anything by themselves. | Data & Safety (Auto-Apply Safety) | Current | repo owner | [security](user/security.md); `apps/api/src/application-feedback.ts` | 2026-07-09 |
| CL-037 | The apply agent is a local Claude runtime subprocess that reads untrusted job pages; prompt injection is a real exposure that the explicit tool allowlist, reduced environment, and model instructions limit but do not remove. | Security (The Apply Agent) | Current | repo owner | [security](user/security.md) (prompt-injection controls and owned tool allowlist); `workers/automation/src/jobctrl/infrastructure/apply/claude_code_cli.py` (`_ALLOWED_TOOLS`, `_ENV_ALLOWLIST`) | 2026-07-09 |
| CL-038 | On supported ATS pages the browser extension offers deterministic, profile-backed field suggestions and shows each value's profile source; the user chooses what to fill, the extension generates no free-text answers, and it has no submission path (it prevents the form's own submit and never submits on the user's behalf). | README (Browser Extension Capture And Autofill); Security (Browser Extension Pairing) | Current | repo owner | `BR-056` (requirements.md); [local TS API](local-ts-api.md) (`GET /v1/extension/autofill/profile`); `apps/extension/src/content-script.ts` (submit prevented) | 2026-07-09 |
| CL-039 | Autonomous browser submission exists only behind explicit opt-in: `autoApply: true` keeps one visible continuous Apply workflow running, and submitting without Apply Review approval also requires `applyApprovalRequired: false`; minimum score, spend ceiling, at-most-once submit intent, dry-run guards, and CAPTCHA fail-closed behavior still apply. | README (Auto-apply); Configuration (Browser Apply Automation); Normal Flows (Rehearse With A Dry Run); Pipeline Operations (Standing Auto-Apply Loop) | Current | repo owner | [pipeline operations](architecture/pipeline/operations.md); `workers/automation/src/jobctrl/apply/auto_apply.py`; `workers/automation/src/jobctrl/apply/activities.py`; `apps/api/src/read-model.ts`; `apps/web/src/contexts/profile/forms/settings-form.tsx` | 2026-07-09 |

### LLM spend

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-040 | A configurable daily LLM spend ceiling (`dailyBudgetUsd`, default 25; 0 = unlimited) runs a budget preflight before each spendful workflow and stops it with a non-retryable budget error once the day's estimated spend reaches the ceiling. It is a per-workflow preflight over an estimated ledger, not a mid-call interrupt and not the provider's bill. | Hero (Temporal-Native Pipeline); README (Configuration); Security (Daily LLM Spend Ceiling); Data & Safety | Current | repo owner | `BR-050` (requirements.md); [pipeline operations](architecture/pipeline/operations.md) | 2026-07-09 |
| CL-041 | Today's estimated spend against the budget is visible on `GET /v1/health` and in the web app's health surface. | Data & Safety (LLM Spend Ceiling); Security | Current | repo owner | `BR-050` (requirements.md); `apps/api/src/server.ts` (`/v1/health` → `readLlmSpendHealth`) | 2026-07-09 |

### Orchestration and runs

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-050 | Every stage runs as a durable Temporal workflow with heartbeats and classified, bounded retries. | Hero (Temporal-Native Pipeline); README (What It Does) | Current | repo owner | `TR-008` (requirements.md); [envelope](architecture/pipeline/envelope.md); [concurrency](architecture/pipeline/concurrency.md) | 2026-07-09 |
| CL-051 | The Runs page shows every workflow run with status, mode, timing, and a deep link into the Temporal web UI. | README (Track pipeline …); Tour (Runs History) | Current | repo owner | `BR-005` (requirements.md); [read model](architecture/read-model.md); `workflow_run_projections` | 2026-07-09 |
| CL-052 | The Dashboard summarizes current and stuck work, active workflow runs, bounded recent activity, and recent apply history. `work.active` counts queued stages plus running stages not classified as stuck. `work.stuck` and `stuckItems[]` identify running canonical stages whose latest timestamp is older than the explicit 150-second dashboard threshold while canonical worker health is missing, stale, invalid, or mismatched. | Tour (Dashboard); Local TypeScript API | Current | repo owner | `BR-007` (requirements.md); [local TypeScript API](local-ts-api.md); `apps/api/test/server.test.ts`; `apps/web/src/views/dashboard/DashboardView.test.tsx`; `apps/web/src/views/dashboard/ActiveRunsCard.test.tsx`; `apps/web/src/views/dashboard/active-runs.test.ts`; `apps/web/src/views/dashboard/DashboardOperations.a11y.test.tsx` | 2026-07-10 |

### Outcome analytics

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-055 | A local Analytics view summarizes recorded application outcomes as a conversion funnel (applied → reply → interview → offer / rejection) broken down by source, score band, fit band, apply mode, accepted resume template, and tailoring policy. Low-sample cells are suppressed and rates are presented descriptively, without causal claims. | README (Track progress … Analytics) | Beta | repo owner | [read model](architecture/read-model.md) (`dashboard_projections` `outcome_conversion_json`); `apps/web/src/views/analytics/SmallSampleNotice.tsx` (small-sample suppression) | 2026-07-09 |
| CL-056 | Post-interview reflection notes can be recorded against the specific accepted prep generation they followed, via a nullable, immutable link on `application_outcomes`; recording a reflection does not change outcome-conversion counts. | README (Responsible Use); Normal Flows (Generate Interview Prep); Data & Safety (Auto-Apply Safety) | Current | repo owner | [read model](architecture/read-model.md) (nullable `interview_prep_generation` link; conversion counts unaffected) | 2026-07-09 |

> **Why Beta.** The capability is shipped and pointer-backed, but the honest
> reading of outcome rates requires a load-bearing qualifier (small samples are
> suppressed; the rates are descriptive, not causal). That qualifier is carried
> at the point of claim — in the Analytics view itself (`SmallSampleNotice` plus
> the non-causal caption) — so the surface stays truthful; the `Beta` label
> records that the qualifier is load-bearing rather than a mere scope note.

### Local-first and privacy

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-060 | JobCtrl is local-first: no hosted backend and no account system; the profile, SQLite database, generated materials, browser state, and logs live under the user's home directory, and nothing leaves the machine except steps the user explicitly configures and runs. | Hero (Local-First & Private); README; Data & Safety (Privacy Quick Answer); Security | Current | repo owner | [security](user/security.md); [data & safety](user/data-and-safety.md); `TR-005` (requirements.md) | 2026-07-09 |
| CL-061 | The outbound calls that can carry private data are enumerated and configuration- or action-gated: LLM providers, the apply-agent prompt, job boards/ATS/posting pages, Gmail lookups and approved application sends, Google Maps autocomplete, CAPTCHA solving, and Langfuse telemetry. | README (What Leaves Your Machine); Security (What Leaves Your Machine); Data & Safety (External Services) | Current | repo owner | [security](user/security.md) (What Leaves Your Machine table); [data & safety](user/data-and-safety.md) | 2026-07-09 |
| CL-062 | The shipped Gmail connector requests `gmail.readonly` and `gmail.send`. Read access supports bounded verification-code and application-outcome lookup; the owned send path is limited to an email-application candidate whose recipient and attachment were recorded by a dry run and exactly approved in Apply Review, and it fails closed without that binding or send scope. Raw email bodies stay local and are not copied into events, telemetry, broad projections, or logs; Gmail send is not exposed as an apply-agent tool. | README (Responsible Use); Security; Data & Safety | Current | repo owner | [security](user/security.md); `workers/automation/src/jobctrl/infrastructure/gmail/auth.py` (`GMAIL_SCOPES`); `workers/automation/src/jobctrl/infrastructure/gmail/client.py` (`send_email_application`); `workers/automation/src/jobctrl/domain/apply/process_manager.py` (approval-bound send) | 2026-07-09 |
| CL-063 | The local API defaults to a loopback bind (`127.0.0.1`); browser-extension routes require a local capability token stored under `~/.jobctrl/`, and unsafe non-browser local API mutations can use that token while arbitrary loopback browser origins remain blocked. | README (Responsible Use); Security (Browser Extension Pairing) | Current | repo owner | `TR-005` (requirements.md); [security](user/security.md) | 2026-07-09 |
| CL-064 | Claude/Google provider keys and cloud-mode settings can be stored in macOS Keychain (never written to SQLite, logs, traces, or artifacts) or in `.env`; Codex uses its isolated CLI credential home, and AWS/Google/Azure credential files stay in vendor-owned stores. Guided replacement is rollback-safe, and a profile password, if configured, remains local to autofill/login handling and does not enter the apply-agent prompt. | Security (Credentials) | Current | repo owner | [security](user/security.md); `apps/api/src/credentials.ts`; `workers/automation/src/jobctrl/config.py` (`load_macos_keychain_fallbacks`); `workers/automation/tests/test_keychain_credentials.py` | 2026-07-12 |
| CL-065 | Langfuse/OpenTelemetry export is off unless configured; `LANGFUSE_DISABLE=1` opts out even when credentials are present. | Data & Safety (Telemetry); Security; Configuration | Current | repo owner | [observability](architecture/observability.md); [configuration](user/configuration.md) | 2026-07-09 |
| CL-066 | The local database, `.env`, and generated artifacts are not encrypted at rest; their protection is the operating-system account and disk security. | Security (Local data is not encrypted) | Current | repo owner | [security](user/security.md) | 2026-07-09 |

### Local operations

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-070 | A local `jobctrl backup` command produces a consistent copy of the SQLite database via `VACUUM INTO` without deleting anything, and schema migrations are guarded by a schema-version check. | README (Back Up And Restore) | Current | repo owner | `BR-053` (requirements.md); [storage](architecture/storage.md) | 2026-07-09 |
| CL-071 | The daily digest is local-only: `jobctrl digest` and the Dashboard digest read from the database without sending notifications or advancing review state, and only the explicit acknowledge action advances the digest watermark. | README (Local Data And Safety) | Current | repo owner | [read model](architecture/read-model.md); `jobctrl digest` (README CLI Reference) | 2026-07-09 |
| CL-072 | Documentation screenshots and QA fixtures use synthetic data only for illustration and deterministic invariant tests, never as the source for public performance, speed, accuracy, or outcome measurements. `scripts/release_check.py` scans tracked and untracked files plus built distributions for real-profile needles, secrets, prompt tripwires, blocked file types, and blocked distribution paths; the main/manual privacy workflow and post-build publication scan enforce strict prompt tripwires, while public pull requests intentionally receive maintainer-run local or manual validation after review rather than automatic heavyweight CI. | README (Screenshots); Data & Safety (Public Bug Reports); Tour (info callouts) | Current | repo owner | `scripts/release_check.py`; `.github/workflows/release-check.yml`; `.github/workflows/release-distribution.yml`; `.github/pull_request_template.md`; [developer security](developer/security.md); [local development](local-development.md#documentation-screenshots) | 2026-07-11 |
| CL-073 | First-run setup and Settings detect Codex, Claude, and Google auth and report provider readiness without requiring the CLI profile created by `jobctrl init`. Any one ready provider unlocks core AI stages and employer-analysis synthesis; additional ensemble providers are optional. Codex requires persisted CLI auth, Claude accepts its supported API/cloud routes, and Google accepts a Gemini key or verified Vertex ADC. | README (Configuration; CLI Reference `setup`); Getting Started; Configuration (LLM Providers; Employer-Analysis Ensemble) | Current | repo owner | `workers/automation/src/jobctrl/infrastructure/setup_probes.py` (`probe_analysis_setup`, `ready_llm_providers`); `workers/automation/tests/test_setup_synthesis_auth.py`; `workers/automation/tests/test_llm_provider_routing.py`; [configuration](user/configuration.md) | 2026-07-12 |

### Profile

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-080 | The Profile is the single source of truth that scoring and tailoring build on; it is created or imported locally without any external account. | README (Normal Flow); Tour (Set Up Your Profile) | Current | repo owner | [scoring](architecture/scoring.md); [tailoring](architecture/tailoring.md) | 2026-07-09 |

### Install & Distribution

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-081 | Building and running from a source checkout remains an advanced contributor option. It uses `scripts/install` followed by `corepack pnpm dev`; Git, uv, pnpm, and the rest of the source toolchain belong only to that option and are not installed-product prerequisites. The source audit records 85 unique direct JavaScript packages, 1,480 pnpm lock records, 103 uv lock records, and two Playwright browser revisions. Preserved mixed-context observations are contributor-path measurements, not the installed-product footprint. | README (Build and run from source); Getting Started (Build and run from source); Local Development | Current | repo owner | `scripts/install`; `packaging/distribution/source-baseline.json`; `docs/local-development.md` | 2026-07-12 |
| CL-082 | P0–P6 implement a deterministic Apple-silicon bundle, one native launcher/CLI, the explicit browser-capability split, immutable acquisition/lifecycle contracts, and a fail-closed signed release workflow. The tracked inventory declares 15 core components, one bundled optional-capability adapter, three official-channel provider packs, and two excluded developer-only components. This is not a public installation claim: no signed and notarized artifact, authenticated release pointer, stable Homebrew formula, or published-artifact clean-machine QA exists yet. Once published, curl and Homebrew must resolve the same payload and plain `jobctrl` command surface, with no source clone or user-installed toolchain. | ROADMAP (Now); README (Bundled distribution status); Getting Started (current source path versus installed contract); Local Development | Roadmap | repo owner | `launcher/internal/launcher/launcher.go`; `packaging/distribution/component-inventory.json`; `.github/workflows/release-distribution.yml`; `scripts/get`; `packaging/homebrew/Formula/jobctrl.rb.tmpl` | 2026-07-11 |
| CL-083 | Contact records are kept per company or application with per-fact provenance and CSV import; outreach drafts are truthful and reviewable under the same anti-fabrication gates as resumes; the user sends messages themselves and logs the send (date + channel) — the only way an outreach thread is marked sent; follow-up reminders are surfaced-only suggestions; there is no outreach send transport. This does not describe the separately approval-bound Gmail email-application path in CL-062. | README (What It Does — contacts/outreach); Normal Flows §11 (Keep Contacts); Configuration (Contact Research; Outreach Follow-Ups) | Current | repo owner | Outreach planner close-out (`plans/implemented/2026-07-05-outreach-planner-plan.md`, INV-1 no-auto-send, four-layer enforcement + fixtures); [normal flows](user/normal-flows.md) §11; [configuration](user/configuration.md) (Contact Research, Outreach Follow-Ups) | 2026-07-09 |
| CL-084 | JobCtrl's source is distributed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). | README (License); Comparison (Open-source license) | Current | repo owner | [`LICENSE`](../LICENSE); `package.json`; `workers/automation/pyproject.toml` | 2026-07-09 |
| CL-085 | Native Windows Credential Manager and Linux Secret Service/keyring adapters are planned with parity to the shipped macOS Keychain boundary: environment precedence, presence-only API responses, restart-to-activate lifecycle, bounded failure behavior, and platform-host validation before promotion. | ROADMAP (Next) | Roadmap | repo owner | [`ROADMAP.md`](../ROADMAP.md) | 2026-07-10 |

> **Why CL-082 remains roadmap work.** The bundle, launcher, installer,
> lifecycle, and release authority now have local implementation and QA
> evidence, but publication is the missing product fact. Promote the claim only
> after a Developer ID-signed and notarized artifact, authenticated release
> pointer, stable formula, immutable release, and both clean-machine acquisition
> paths have been executed and read back successfully. Checked-in workflows and
> local candidates are not public-install evidence.

> **Launch-cutover draft.** Public install copy may be prepared in a draft pull
> request before the external release exists, but that pull request must not be
> merged or deployed while CL-082 remains `Roadmap`. Promote CL-082 to
> `Current`, record the final release evidence and verification date, and
> refresh the owner-signed freeze SHA only after the signed/notarized artifact,
> authenticated stable pointer, immutable release, Homebrew formula, and both
> clean-machine acquisition paths have been executed and read back.

## Maintenance cadence and re-review

Per plan §5 and §8.3, re-run the claim review and refresh each row's
`Last verified` whenever a public surface changes, and at minimum **every
release**. The review process:

1. Enumerate candidate claims from the live public surfaces (`README.md`,
   `docs/index.md` hero `features`, `docs/user/screenshots.md` captions,
   `docs/user/normal-flows.md`, `docs/user/data-and-safety.md`,
   `docs/user/security.md`, `docs/comparison.md`, and `docs/requirements.md`).
2. For each, confirm Status + owner + verification pointer and resolve every
   `Current` and `Beta` pointer. Treat synthetic fixtures as illustrative or
   invariant-test evidence only; never use them to substantiate public
   measurement claims.
3. Reconcile against `ROADMAP.md` so nothing labelled `Current` is actually a
   "Now / Next / Later" roadmap item.
4. Re-record the freeze `main` sha and date on the [Freeze status](#freeze-status)
   line.

Any new public claim must land a row here (Status + owner + resolving pointer)
in the same change that introduces it.

## Owner sign-off record

The repository owner completed the guided review on **2026-07-09**. Governance
and every high-judgment claim were prompted separately. The remaining
pointer-backed claims were presented in three explicit ID groups — pipeline,
materials, and operations — with an option to request individual prompts; the
owner approved each group as `Current`. No decision below was inferred from
silence.

### Governance decisions

| Decision | Recommendation | Consequence | Verdict |
| --- | --- | --- | --- |
| GOV-01 — Ledger location and publication (§11.1) | Keep `docs/claims-ledger.md` repository-only through `UNPUBLISHED_FILES` and `srcExclude`. | Publishing it would expose launch-governance notes; moving it requires updating plan and docs-index pointers. | **APPROVED 2026-07-09** |
| GOV-02 — Classification and evidence rule (§11.6) | Preserve the recorded rule: new LLM-generated user-facing surfaces without real-usage validation are `Beta`; synthetic evidence may illustrate but never measure. | Changing the bar can promote or demote CL-029 and future generated surfaces, and changes what may appear unqualified on the hero/README. | **APPROVED 2026-07-09** |
| GOV-03 — Accountability (§11.7) | Keep the repository owner as the single claim-freeze holder and Phase C publisher; each row still needs an explicit guided-review verdict. | Choosing multiple owners requires naming one accountable person per row and publish step before freeze. | **APPROVED 2026-07-09** |
| GOV-04 — Freeze anchor | After all remediation changes land, rerun validation and record that exact dated `origin/main` SHA; never freeze an uncommitted worktree. | Without this, GATE G1 remains unsatisfied and the ledger can drift from the released code. | **APPROVED; EXECUTION PENDING POST-MERGE** |

### Classification decisions needing explicit attention

The owner accepted every status below after a separate prompt (including
CL-030 through CL-034 individually). These rows received extra discussion
because their qualifiers, risk, maturity, or recent behavior change could have
altered the `Current`/`Beta` verdict.

| Claim | Owner-approved status | Why this needed an owner choice | Consequence of promotion/demotion |
| --- | --- | --- | --- |
| **CL-005** | `Current` | The extension works but is an unpacked developer-mode install, not a browser-store release. | `Beta` would require that maturity qualifier anywhere it is promoted publicly. |
| **CL-008** | `Current` | `python-jobspy` transport cannot be robots-gated per request; the claim carries the invocation-boundary exception. | `Beta` treats that exception as a load-bearing reliability limitation rather than a scope boundary. |
| **CL-009** | `Current` | This is a newly ledgered public claim that the web app is the supported operator surface. | `Beta` would require qualifying the UI in the comparison, tour, and README. |
| **CL-029** | `Beta` | Grounded interview prep is a new LLM-generated, high-stakes user-facing surface without real-usage validation. | `Current` would reverse the recorded §11.6 rule for this surface. |
| **CL-030–CL-034** | `Current` individually | These are high-risk live-submit safety invariants; implementation and tests support the exact bounded claims. | Any `Beta` verdict requires the matching safety claim to carry a maturity qualifier on every public surface. |
| **CL-037** | `Current` | Prompt-injection controls reduce but cannot eliminate exposure; the limitation is explicit. | `Beta` treats residual exposure as a maturity caveat rather than the stated security boundary. |
| **CL-038** | `Current` | Autofill is shipped but shares the unpacked extension distribution limitation. | `Beta` requires the extension maturity qualifier wherever autofill is advertised. |
| **CL-039** | `Current` | Autonomous browser submission is shipped, high-risk, and explicitly opt-in with remaining gates. | `Beta` requires a maturity warning in addition to the existing safety boundaries. |
| **CL-040** | `Current` | The ceiling is estimated per-workflow preflight, not provider billing truth or a mid-call interrupt. | `Beta` treats those exact limitations as load-bearing maturity caveats. |
| **CL-052** | `Current` | Dashboard work/stuck/activity visibility is newly implemented and ledgered in this change. | `Beta` requires the new tour wording to identify the operational summary as beta. |
| **CL-055** | `Beta` | Outcome rates are descriptive and small-sample gated, not causal measurements. | `Current` would remove the maturity signal while the load-bearing qualifiers remain necessary. |
| **CL-062** | `Current` | Gmail changed after the prior freeze from read-only to approval-bound application sending. | `Beta` requires Gmail-send claims in README/Security/Data & Safety to carry the label; `Current` accepts the deterministic gates as sufficient maturity. |
| **CL-072** | `Current` | Public PR CI is intentionally manual after review, not automatic; the claim now states the real policy. | `Beta` would imply the scanner itself is rough rather than distinguish trigger policy from capability. |
| **CL-082** | `Roadmap` | P0–P6 are implemented locally, but signing/notarization, public pointer publication, stable formula promotion, and published-artifact QA have not executed. | Promote only after both acquisition paths resolve the same signed artifact and the clean-machine/readback gates pass. |

### Claim-by-claim guided-review checklist

- [x] CL-001 — owner-approved `Current` on 2026-07-09
- [x] CL-002 — owner-approved `Current` on 2026-07-09
- [x] CL-003 — owner-approved `Current` on 2026-07-09
- [x] CL-004 — owner-approved `Current` on 2026-07-09
- [x] CL-005 — owner-approved `Current` on 2026-07-09
- [x] CL-006 — owner-approved `Current` on 2026-07-09
- [x] CL-007 — owner-approved `Current` on 2026-07-09
- [x] CL-008 — owner-approved `Current` on 2026-07-09
- [x] CL-009 — owner-approved `Current` on 2026-07-09
- [x] CL-010 — owner-approved `Current` on 2026-07-09
- [x] CL-011 — owner-approved `Current` on 2026-07-09
- [x] CL-012 — owner-approved `Current` on 2026-07-09
- [x] CL-013 — owner-approved `Current` on 2026-07-09
- [x] CL-020 — owner-approved `Current` on 2026-07-09
- [x] CL-021 — owner-approved `Current` on 2026-07-09
- [x] CL-022 — owner-approved `Current` on 2026-07-09
- [x] CL-023 — owner-approved `Current` on 2026-07-09
- [x] CL-024 — owner-approved `Current` on 2026-07-09
- [x] CL-025 — owner-approved `Current` on 2026-07-09
- [x] CL-026 — owner-approved `Current` on 2026-07-09
- [x] CL-027 — owner-approved `Current` on 2026-07-09
- [x] CL-028 — owner-approved `Current` on 2026-07-09
- [x] CL-029 — owner-approved `Beta` on 2026-07-09
- [x] CL-030 — owner-approved `Current` on 2026-07-09
- [x] CL-031 — owner-approved `Current` on 2026-07-09
- [x] CL-032 — owner-approved `Current` on 2026-07-09
- [x] CL-033 — owner-approved `Current` on 2026-07-09
- [x] CL-034 — owner-approved `Current` on 2026-07-09
- [x] CL-035 — owner-approved `Current` on 2026-07-09
- [x] CL-036 — owner-approved `Current` on 2026-07-09
- [x] CL-037 — owner-approved `Current` on 2026-07-09
- [x] CL-038 — owner-approved `Current` on 2026-07-09
- [x] CL-039 — owner-approved `Current` on 2026-07-09
- [x] CL-040 — owner-approved `Current` on 2026-07-09
- [x] CL-041 — owner-approved `Current` on 2026-07-09
- [x] CL-042 — owner-approved `Current` on 2026-07-09
- [x] CL-050 — owner-approved `Current` on 2026-07-09
- [x] CL-051 — owner-approved `Current` on 2026-07-09
- [x] CL-052 — owner-approved `Current` on 2026-07-09
- [x] CL-055 — owner-approved `Beta` on 2026-07-09
- [x] CL-056 — owner-approved `Current` on 2026-07-09
- [x] CL-060 — owner-approved `Current` on 2026-07-09
- [x] CL-061 — owner-approved `Current` on 2026-07-09
- [x] CL-062 — owner-approved `Current` on 2026-07-09
- [x] CL-063 — owner-approved `Current` on 2026-07-09
- [x] CL-064 — owner-approved `Current` on 2026-07-09
- [x] CL-065 — owner-approved `Current` on 2026-07-09
- [x] CL-066 — owner-approved `Current` on 2026-07-09
- [x] CL-070 — owner-approved `Current` on 2026-07-09
- [x] CL-071 — owner-approved `Current` on 2026-07-09
- [x] CL-072 — owner-approved `Current` on 2026-07-09
- [x] CL-073 — owner-approved `Current` on 2026-07-09
- [x] CL-080 — owner-approved `Current` on 2026-07-09
- [x] CL-081 — owner-approved `Current` on 2026-07-09
- [x] CL-082 — owner-approved `Roadmap` on 2026-07-09
- [x] CL-083 — owner-approved `Current` on 2026-07-09
- [x] CL-084 — owner-approved `Current` on 2026-07-09
- [x] CL-085 — owner-approved `Roadmap` on 2026-07-10
