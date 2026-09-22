# Public Claims Ledger

This repository-only reference maps public product claims to their supporting
code and documentation. It distinguishes shipped behavior, known limitations
and planned features; it is not a publication approval process.

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

**Owner column.** `repo owner` identifies the maintainer responsible for
keeping each claim and its verification pointer accurate.

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
| CL-009 | The supported operator surface is a local React/Vite web application backed by the local TypeScript API and Python/Temporal worker. Its first-party routes cover Profile, Discovery, Pipelines, Dashboard, Jobs and job-detail audit, Apply Review, Runs, Artifacts, Evidence, Analytics, Outreach, Preferences, and Debug; mutations go through the API and server-side changes refresh through SSE-backed invalidation. | Comparison (Graphical user interface); Tour; README | Current | repo owner | [frontend architecture](architecture/frontend/index.md); [product tour](user/product-tour.md); `apps/web/src/routes/`; `apps/web/src/contexts/operations/invalidation-router.ts` | 2026-07-09 |

### Discovery and enrichment

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-001 | Multi-source discovery is driven by the user's target roles, locations, and seniority, and records which source each job came from. | Hero (Profile-Driven Discovery); README (What It Does); Tour (Configure Discovery) | Current | repo owner | `BR-042` (requirements.md); [pipeline stages](architecture/pipeline/stages.md) | 2026-07-09 |
| CL-002 | Discovery removes duplicate postings and retires postings that have closed. | Hero (Profile-Driven Discovery) | Current | repo owner | [pipeline stages](architecture/pipeline/stages.md) (dedupe); [envelope](architecture/pipeline/envelope.md) (CLOSED/NOT_FOUND reconcile) | 2026-07-09 |
| CL-003 | Scheduled discovery is off by default; a local Temporal Schedule runs on the configured cron only after the user enables it. | README (What It Does); Configuration | Current | repo owner | [pipeline operations](architecture/pipeline/operations.md) ("off by default"); [configuration](user/configuration.md) | 2026-07-09 |
| CL-004 | Enrichment adds full descriptions, canonical posting URLs, and apply URLs to postings. | README (What It Does) | Current | repo owner | [pipeline stages](architecture/pipeline/stages.md) | 2026-07-09 |
| CL-005 | The local browser extension captures the active job page (URL and visible text) over loopback and feeds it into the existing manual-capture importer, so dedupe, snapshots, quarantine, and source provenance stay identical to other user-mediated captures. Both capture and the extension are optional; integrated Discovery prefers the extension when connected. | README (What It Does; Browser Extension Discovery, Capture, And Autofill) | Current | repo owner | `BR-019`, `BR-069` (requirements.md); [local TS API](local-ts-api.md) (`POST /v1/extension/captures`); `apps/api/src/server.ts` (route → `manualCaptureImporter`) | 2026-09-02 |
| CL-006 | Discovery and Enrich do not request, evaluate or enforce robots.txt in connected or anonymous acquisition. Source pacing, concurrency, request budgets, public destinations, redirects, cancellation, audit and no-submit boundaries remain enforced; historical robots blocks remain retryable. | README (What It Does — polite fetching); Security (Crawl Politeness); Discovery (Crawl Politeness) | Current | repo owner | `BR-069`, `TR-046` (requirements.md); `workers/automation/src/jobctrl/infrastructure/discovery/live_browser.py`; `workers/automation/src/jobctrl/enrichment/detail.py`; `workers/automation/src/jobctrl/infrastructure/network/politeness.py` | 2026-09-13 |
| CL-007 | Integrated Discovery preserves Chrome's current browser user agent and returns it as transport metadata. The configurable `JobCtrl/<version> (+<contact>)` identity remains authoritative for standalone/non-extension gateway operations, and `jobctrl doctor` prints that configured identity. | README (What It Does — polite fetching); Security (Crawl Politeness); Discovery (Runtime) | Current | repo owner | `TR-046` (requirements.md); `workers/automation/src/jobctrl/infrastructure/discovery/live_browser.py`; `workers/automation/src/jobctrl/infrastructure/network/politeness.py` (`resolve_honest_user_agent`) | 2026-09-13 |
| CL-008 | A blocked fetch is recorded as a first-class outcome—rate-limited or budget-exhausted, with historical robots-disallowed records retained—rather than a generic scrape error. JobStreaming retains invocation-level request accounting, while provider sessions prefer the connected extension and can use guarded anonymous acquisition. The current Chrome profile is the one authenticated browser identity for integrated Discovery and Enrich recovery; Temporal retries skip the copied-profile pre-pass, and Settings exposes no LinkedIn profile-copy action. | Security (Crawl Politeness); Data & Safety (External Services) | Current | repo owner | `workers/automation/src/jobctrl/infrastructure/discovery/live_browser.py`; `workers/automation/src/jobctrl/enrichment/detail.py`; [security](user/security.md) (Crawl Politeness) | 2026-09-13 |
| CL-086 | Broad-board discovery commits accepted postings before acknowledging JobStreaming events. An interrupted Temporal activity resumes unfinished query/location/board units from caller-owned checkpoints without losing accepted work or double-counting the run limit; Pipelines reports the number of resumed units, while explicit cancellation terminalizes unfinished units instead of resuming them. | README (What It Does; Interrupted work); Discovery (Resumable Broad-Board Searches) | Current | repo owner | `BR-062`, `TR-041` (requirements.md); `workers/automation/tests/test_jobstreaming_resumable_discovery.py`; [pipeline envelope](architecture/pipeline/envelope.md) | 2026-07-17 |
| CL-087 | Integrated Discovery and Enrich prefer the selected paired extension after a bounded connected-status check and otherwise use guarded public HTTP or anonymous Playwright. Pairing token presence is not readiness. Active work retains execution identity, cancellation, timeout cleanup, bounded capacity, destination guards and UTF-8 bounds; acquisition failures never switch transport or copy a profile. | README; Discovery; Browser & extension Settings | Current | repo owner | `BR-069`, `TR-046` (requirements.md); [runtime](architecture/runtime.md); [local TS API](local-ts-api.md); live-profile Discovery QA in [Reliability & QA](local-reliability-qa.md) | 2026-09-13 |

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
| CL-030 | By default, no standing apply loop is enabled (`autoApply: false`) and live claims require an explicit Apply Review approval (`applyApprovalRequired: true`) in the worker transaction. Independently, model-driven browser work is transport-locked and final browser submit remains manual. | Hero (Supervised Apply); README (Auto-apply …); Security (Apply Approval Is Required); Data & Safety | Current | repo owner | `BR-023`, `BR-064` (requirements.md); [security](user/security.md); `workers/automation/src/jobctrl/apply/launcher.py`; `workers/automation/src/jobctrl/domain/apply/use_cases.py` | 2026-07-29 |
| CL-031 | The live-submit approval is bound to the reviewed materials generation, profile version, and application URL, and requires matching dry-run evidence. | Security (Apply Approval); Data & Safety (Auto-Apply Safety) | Current | repo owner | [security](user/security.md); `apps/api/src/application-feedback.ts`; `apps/api/test/application-feedback.test.ts` (approval binding, #271) | 2026-07-09 |
| CL-032 | A partial dry run satisfies the gate only through an explicit partial-evidence approval action that names the specific run and shows the blocked channels being accepted. | Security (Apply Approval); Data & Safety | Current | repo owner | [security](user/security.md); `apps/api/src/application-feedback.ts` (blocked channels, #271) | 2026-07-09 |
| CL-033 | Dry run submits nothing: the agent is told not to click submit, and a browser-level CDP guard blocks non-loopback POST/PUT/PATCH and overrides form submits. | Hero (Supervised Apply); README (Auto-apply …); Security (Dry-Run Cannot Submit) | Current | repo owner | [security](user/security.md); `workers/automation/src/jobctrl/apply/chrome.py` (`install_dry_run_cdp_guard` / `_DryRunCdpGuard`; non-loopback POST/PUT/PATCH → `Fetch.failRequest`; `_FORM_SUBMIT_GUARD_SOURCE` form-submit override) | 2026-07-09 |
| CL-034 | Automated owned submissions are at-most-once: claiming excludes runs already in progress, succeeded, or parked for verification; the owned email path records submit intent immediately before send; and a crash or provider exception after that intent parks the run for manual verification instead of retrying. | Hero (Supervised Apply); README; Security (Browser Final Submit Is Not Delegated); Data & Safety | Current | repo owner | `BR-054` (requirements.md); `workers/automation/src/jobctrl/domain/apply/process_manager.py`; `workers/automation/src/jobctrl/apply/launcher.py` (`_has_apply_submit_intent`, needs_verification) | 2026-07-29 |
| CL-035 | JobCtrl never submits applications, runs destructive profile/database actions, or bypasses third-party controls (CAPTCHA, paywall, login, rate-limit, bot-control) without explicit user authorization; the apply agent stops on SSO, declines permission prompts, refuses ID/biometric verification, and never enters payment details. | README (Responsible Use); Security (No Third-Party Bypass; The Apply Agent) | Current | repo owner | `BR-001` (requirements.md); [security](user/security.md) | 2026-07-09 |
| CL-036 | Application outcomes can be recorded manually without browser automation, and web approval facts do not submit anything by themselves. | Data & Safety (Auto-Apply Safety) | Current | repo owner | [security](user/security.md); `apps/api/src/application-feedback.ts` | 2026-07-09 |
| CL-037 | The apply agent is a local Claude runtime subprocess that reads untrusted job pages; prompt injection is a real exposure that the explicit tool allowlist, reduced environment, and model instructions limit but do not remove. | Security (The Apply Agent) | Current | repo owner | [security](user/security.md) (prompt-injection controls and owned tool allowlist); `workers/automation/src/jobctrl/infrastructure/apply/claude_code_cli.py` (`_ALLOWED_TOOLS`, `_ENV_ALLOWLIST`) | 2026-07-09 |
| CL-038 | On ordinary HTTP(S) application forms the browser extension offers deterministic, profile-backed field suggestions and shows each value's profile source; its all-sites content script remains passive until the user requests review, the user chooses what to fill, the extension generates no free-text answers, and it never submits on the user's behalf. HTTP(S) host access is wildcarded for explicit brokered Discovery tasks, while capture/autofill API traffic remains loopback-only. | README (Browser Extension Discovery, Capture, And Autofill); Security (Browser Extension Pairing) | Current | repo owner | `BR-056` (requirements.md); [local TS API](local-ts-api.md) (`GET /v1/extension/autofill/profile`); `apps/extension/public/manifest.json` (wildcard HTTP(S) access); `apps/extension/src/discovery-executor.ts` (brokered HTTP execution); `apps/extension/src/content-script.ts` (review-only fill) | 2026-09-02 |
| CL-039 | Autonomous browser submission is disabled. `autoApply: true` keeps one visible continuous Apply workflow running, but browser-form claims stop for manual final submit. The only automated live sink is the owned Gmail sender for an exact-approved recipient/attachment candidate. | README (Auto-apply); Apply (Final Browser Submission Is Manual); Normal Flows (Rehearse With A Dry Run); Pipeline Operations (Standing Auto-Apply Loop) | Current | repo owner | `BR-064` (requirements.md); [pipeline operations](architecture/pipeline/operations.md); `workers/automation/src/jobctrl/domain/apply/use_cases.py`; `workers/automation/src/jobctrl/domain/apply/process_manager.py`; `workers/automation/src/jobctrl/infrastructure/apply/claude_code_cli.py` | 2026-07-29 |

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
| CL-064 | Guided provider secrets use the native OS credential store, while cloud-mode metadata uses `config.json`. Environment overrides retain precedence; API responses are presence-only and provider replacement compensates on failure. Codex and cloud-vendor auth stay in their existing stores. Legacy plaintext migration is explicit and verifies native persistence before removing allowlisted assignments. | Security (Credentials) | Beta | repo owner | [configuration](user/configuration.md); `apps/api/src/credentials.ts`; `apps/api/src/native-credential-store.ts`; [native credential QA gate](developer/qa/regression-catalog.md#native-credential-storage-and-migration) | 2026-09-22 (native macOS, Windows and Linux host matrix passed) |
| CL-065 | Langfuse/OpenTelemetry export is off unless configured; `LANGFUSE_DISABLE=1` opts out even when credentials are present. | Data & Safety (Telemetry); Security; Configuration | Current | repo owner | [observability](architecture/observability.md); [configuration](user/configuration.md) | 2026-07-09 |
| CL-066 | The local database, `.env`, and generated artifacts are not encrypted at rest; their protection is the operating-system account and disk security. | Security (Local data is not encrypted) | Current | repo owner | [security](user/security.md) | 2026-07-09 |

### Local operations

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-070 | A local `jobctrl backup` command produces a consistent copy of the SQLite database via `VACUUM INTO` without deleting anything, and schema migrations are guarded by a schema-version check. | README (Back Up And Restore) | Current | repo owner | `BR-053` (requirements.md); [storage](architecture/storage.md) | 2026-07-09 |
| CL-071 | The daily digest is local-only: `jobctrl digest` and the Dashboard digest read from the database without sending notifications or advancing review state, and only the explicit acknowledge action advances the digest watermark. | README (Local Data And Safety) | Current | repo owner | [read model](architecture/read-model.md); `jobctrl digest` (README CLI Reference) | 2026-07-09 |
| CL-072 | Documentation screenshots and QA fixtures use synthetic data only for illustration and deterministic invariant tests, never as the source for public performance, speed, accuracy, or outcome measurements. `scripts/release_check.py` scans tracked and untracked files plus built distributions for real-profile needles, secrets, prompt tripwires, blocked file types, and blocked distribution paths; the main/manual privacy workflow and post-build publication scan enforce strict prompt tripwires, while public pull requests intentionally receive maintainer-run local or manual validation after review rather than automatic heavyweight CI. | README (Screenshots); Data & Safety (Public Bug Reports); Tour (info callouts) | Current | repo owner | `scripts/release_check.py`; `.github/workflows/release-check.yml`; `.github/workflows/release-distribution.yml`; `.github/pull_request_template.md`; [developer security](developer/security.md); [local development](local-development.md#documentation-screenshots) | 2026-07-11 |
| CL-073 | First-run setup and Settings detect Codex, Claude, and Google auth and report provider readiness without requiring the CLI profile created by `jobctrl init`. Any one ready provider unlocks core AI stages and employer-analysis synthesis; additional ensemble providers are optional. Codex requires persisted CLI auth, Claude accepts its supported API/cloud routes, and Google accepts a Gemini key or verified Vertex ADC. | README (Configuration; CLI Reference `setup`); Getting Started; Configuration (LLM Providers; Employer Analysis Perspectives) | Current | repo owner | `workers/automation/src/jobctrl/infrastructure/setup_probes.py` (`probe_analysis_setup`, `ready_llm_providers`); `workers/automation/tests/test_setup_synthesis_auth.py`; `workers/automation/tests/test_llm_provider_routing.py`; [configuration](user/configuration.md) | 2026-07-12 |

### Profile

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-080 | The Profile is the single source of truth that scoring and tailoring build on; it is created or imported locally without any external account. | README (Normal Flow); Tour (Set Up Your Profile) | Current | repo owner | [scoring](architecture/scoring.md); [tailoring](architecture/tailoring.md) | 2026-07-09 |

### Install & Distribution

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-081 | Building and running from a source checkout remains an advanced contributor option. It uses `scripts/install` followed by `corepack pnpm dev`; Git, uv, pnpm, and the rest of the source toolchain belong only to that option and are not installed-product prerequisites. The source audit records 73 unique direct JavaScript packages, 1,452 pnpm lock records, 20 direct core-runtime Python packages, 102 uv lock records, and two Playwright browser revisions. Preserved mixed-context observations are contributor-path measurements, not the installed-product footprint. | README (Build and run from source); Getting Started (Build and run from source); Local Development | Current | repo owner | `scripts/install`; `packaging/distribution/source-baseline.json`; `docs/local-development.md` | 2026-08-12 |
| CL-083 | Contact records are kept per company or application with per-fact provenance and CSV import; outreach drafts are truthful and reviewable under the same anti-fabrication gates as resumes; the user sends messages themselves and logs the send (date + channel) — the only way an outreach thread is marked sent; follow-up reminders are surfaced-only suggestions; there is no outreach send transport. This does not describe the separately approval-bound Gmail email-application path in CL-062. | README (What It Does — contacts/outreach); Normal Flows §11 (Keep Contacts); Configuration (Contact Research; Outreach Follow-Ups) | Current | repo owner | Outreach planner close-out (`plans/implemented/2026-07-05-outreach-planner-plan.md`, INV-1 no-auto-send, four-layer enforcement + fixtures); [normal flows](user/normal-flows.md) §11; [configuration](user/configuration.md) (Contact Research, Outreach Follow-Ups) | 2026-07-09 |
| CL-084 | JobCtrl's source is distributed under the GNU Affero General Public License v3.0 only (`AGPL-3.0-only`). | README (License); Comparison (Open-source license) | Current | repo owner | [`LICENSE`](../LICENSE); `package.json`; `workers/automation/pyproject.toml` | 2026-07-09 |
| CL-085 | Windows Credential Manager, Linux Secret Service and macOS Keychain pass native host checks for API/Python readback, migration, presence-only responses and cleanup using synthetic credentials. Windows migration also preserves protected access permissions and exact source bytes during rollback. The native host matrix remains a required regression gate; mock-only evidence is not a native-platform pass. | Native credential stores | Beta | repo owner | [#888](https://github.com/ebarti/JobCtrl/issues/888); [native credential QA gate](developer/qa/regression-catalog.md#native-credential-storage-and-migration) | 2026-09-22 ([native host matrix](https://github.com/ebarti/JobCtrl/actions/runs/35739355706), `0e61fb0e`) |



## Maintenance

Update the affected claims and verification pointers when public behavior
changes. Use the owning product documentation for current behavior and
`ROADMAP.md` for planned work. Synthetic fixtures can illustrate behavior and
prove invariants; they do not substantiate real-world performance or outcome
measurements.
