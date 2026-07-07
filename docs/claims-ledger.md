# Public Claims Ledger

> **Repository-only.** This file is intentionally excluded from the published
> docs site (registered in `docs/.vitepress/config.ts` `UNPUBLISHED_FILES` +
> `srcExclude`, mirroring `docs/backlog.md`). It is a launch-governance
> artifact, not user documentation.
>
> Implements Phase A / GATE G1 of
> [`docs/plans/2026-07-05-launch-readiness-artifacts-plan.md`](plans/2026-07-05-launch-readiness-artifacts-plan.md)
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

> **PROVISIONAL FREEZE — not yet owner-signed.** Re-anchored and verified
> against `main` @ `48714f95` on **2026-07-06**, after the R10
> crawl-politeness train (#297–#316), the I0 vendor-auth setup train
> (#254/#317), the R7a launch-asset train (#262–#305), and the post-freeze
> currency set merged. Since the prior `fec1940f` stamp, web quality and test
> stabilization landed without new public-surface claims (#321/#322/#323,
> #327/#329/#334); #328 hardened apply prompt boundaries and updated safety
> docs, strengthening the existing apply/privacy rows without adding a new
> claim row; #326 recorded the R1 post-train NO-GO inventory and owner-action
> checklist; #339 recorded owner launch decisions; #318 recorded R9 decision
> resolutions without adding a public-surface claim; and #324 refreshed this
> ledger's politeness/setup currency. This pass applies the owner's §11.6
> decision by reclassifying CL-029 to `Beta`, records the "synthetic may
> illustrate, never measure" evidence rule, and updates stale #328 apply
> boundary pointers. Every `Current` and `Beta` row's verification pointer
> resolved at `48714f95`. GATE G1 is satisfied only
> once the repository owner reviews this ledger, assigns per-claim sign-off
> owners (§11.7 of the plan), and re-stamps this line with the dated `main` sha
> at actual freeze time. `main` is advancing quickly while the launch trains
> merge, so the freeze sha **must be re-recorded at sign-off**; the pointers
> below are stable handles (`docs/requirements.md` BR/TR ids, architecture docs,
> source/test paths) that resolve at any recent `main`.
>
> Unless a row's `Last verified` says otherwise, every row was last verified in
> this pass (2026-07-06 @ `48714f95`).

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

**Owner column.** Defaults to `repo owner` pending per-claim sign-off assignment
(plan §11.7). Assign named owners at freeze.

**Verification pointer.** Prefers an existing requirement handle in
[`requirements.md`](requirements.md); otherwise an architecture doc, source
path, or test path that resolves on `main`.

**Synthetic evidence standard (owner decision, plan §11.6).** Synthetic data may
illustrate product behavior, drive screenshots/GIFs, and prove deterministic QA
invariants, but it may never measure public performance, speed, accuracy, or
outcome claims. Any public measurement claim needs a non-synthetic measurement
source and a resolving pointer.

## Claims

### Discovery and enrichment

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-001 | Multi-source discovery is driven by the user's target roles, locations, and seniority, and records which source each job came from. | Hero (Profile-Driven Discovery); README (What It Does); Tour (Configure Discovery) | Current | repo owner | `BR-042` (requirements.md); [pipeline stages](architecture/pipeline/stages.md) | 2026-07-06 |
| CL-002 | Discovery removes duplicate postings and retires postings that have closed. | Hero (Profile-Driven Discovery) | Current | repo owner | [pipeline stages](architecture/pipeline/stages.md) (dedupe); [envelope](architecture/pipeline/envelope.md) (CLOSED/NOT_FOUND reconcile) | 2026-07-06 |
| CL-003 | Scheduled discovery is off by default; a local Temporal Schedule runs on the configured cron only after the user enables it. | README (What It Does); Configuration | Current | repo owner | [pipeline operations](architecture/pipeline/operations.md) ("off by default"); [configuration](user/configuration.md) | 2026-07-06 |
| CL-004 | Enrichment adds full descriptions, canonical posting URLs, and apply URLs to postings. | README (What It Does) | Current | repo owner | [pipeline stages](architecture/pipeline/stages.md) | 2026-07-06 |
| CL-005 | The optional local browser extension captures the active job page (URL and visible text) over loopback and feeds it into the existing manual-capture importer, so dedupe, snapshots, quarantine, and source provenance stay identical to other user-mediated captures. It is loaded unpacked in the browser's developer mode. | README (What It Does; Browser Extension Capture And Autofill) | Current | repo owner | `BR-019` (requirements.md); [local TS API](local-ts-api.md) (`POST /v1/extension/captures`); `apps/api/src/server.ts` (route → `manualCaptureImporter`) | 2026-07-06 |
| CL-006 | Every discovery and enrichment fetch — `urllib` API calls and Playwright navigations alike — routes through one crawl-politeness gateway that honors `robots.txt` (a `2xx` is parsed and enforced; a `4xx`/`404` means the file is absent and the fetch is allowed per RFC 9309; a `5xx` or timeout is inconclusive and fails closed with a short-TTL recheck; a DNS failure or refused connection fails open with a warning), paces each host (minimum interval + concurrency cap; a server `Retry-After` is honored but clamped), and bounds each run's request budget. | README (What It Does — polite fetching); Security (Crawl Politeness); Configuration (Crawl Politeness) | Current | repo owner | [decisions](decisions.md) (2026-07-06 Crawl Politeness ADR); `workers/automation/src/jobctrl/infrastructure/network/politeness.py` (`PolitenessGateway`, `RunBudgetCounter`), `.../network/robots.py`, `.../network/rate_limiter.py` | 2026-07-06 |
| CL-007 | Outbound crawling stamps one honest `User-Agent` — `JobCtrl/<version> (+<repo url>)` by default, product token and contact overridable via `JOBCTRL_CRAWL_UA_PRODUCT` / `JOBCTRL_CRAWL_UA_CONTACT` — that never impersonates a browser on a surface JobCtrl controls, and `jobctrl doctor` prints the effective identity. | README (What It Does — polite fetching); Security (Crawl Politeness); Configuration (Crawl Politeness) | Current | repo owner | `workers/automation/src/jobctrl/infrastructure/network/politeness.py` (`resolve_honest_user_agent`); `workers/automation/src/jobctrl/cli.py` (doctor prints effective UA); [configuration](user/configuration.md) (Crawl Politeness) | 2026-07-06 |
| CL-008 | A blocked fetch is recorded as a first-class outcome — robots-disallowed, rate-limited, or budget-exhausted — never a scrape error, and is surfaced per source in the Source Health card and discovery controls. Broad boards fetched through `python-jobspy` own their internal per-board transport, so JobCtrl cannot robots-gate those individual requests and applies pacing + budget at its own invocation boundary, with `jobctrl doctor` disclosing when broad boards are active; the authenticated LinkedIn path uses the user's own logged-in browser session with its real browser identity — an owner-scoped exception that remains rate- and budget-limited. | Security (Crawl Politeness); Data & Safety (External Services) | Current | repo owner | `workers/automation/src/jobctrl/infrastructure/network/politeness.py` (outcomes → `operational_attempt_metrics`); `apps/web/src/contexts/discovery/components/SourcePolitenessBadges.tsx`; [security](user/security.md) (Crawl Politeness) | 2026-07-06 |

### Scoring

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-010 | A deterministic, versioned scoring policy scores fit 1–10 from structured evidence. | Hero (Explainable Scoring); README (What It Does); Tour (Job Detail) | Current | repo owner | [scoring](architecture/scoring.md) (`FitScore 1-10` from structured evidence) | 2026-07-06 |
| CL-011 | A per-requirement fit ledger explains why each score happened, with per-requirement evidence and match/gap. | Hero (Explainable Scoring); Tour (Job Detail) | Current | repo owner | [scoring](architecture/scoring.md); `job_requirement_fit_items` (`apps/api/test/qa-seed.ts`) | 2026-07-06 |
| CL-012 | Scoring is an applicant-side triage aid only — not employer-side candidate screening or a hiring decision. | README (Score jobs …); Data & Safety (Scoring Safety); Security (Scoring Is Applicant-Side Only) | Current | repo owner | `BR-022` (requirements.md) | 2026-07-06 |

### Compensation

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-013 | Employer-posted salary is parsed deterministically from the posting text (versioned parser, bounded source excerpt, confidence/warning codes), and a separate deterministic, versioned market estimate is computed from recorded reported-compensation observations (Levels.fyi / Glassdoor / manual imports, plus opt-in public Euro Top Tech data) — surfaced as a range with an explicit confidence band, or an `insufficient_evidence` / `unsupported` / `source_unavailable` state instead of a fabricated number. Both the posted fact and the estimate, with their audit, appear as the job-detail compensation evidence and the jobs-table compensation columns; it is an estimate, not the employer's offer or verified pay. | Tour (Job Detail; Jobs table); README (Review jobs …; CLI `compensation-refresh`); Normal Flows (Review Jobs); Configuration (Compensation Sources) | Current | repo owner | `TR-008` (requirements.md) (`CompensationRefreshWorkflow`); [configuration](user/configuration.md) (Compensation Sources); `workers/automation/src/jobctrl/domain/compensation/posted.py` (`parse_posted_compensation`), `.../compensation/market.py` (`estimate_market_compensation`); `apps/api/src/projections.ts` (`buildCompensationProjection` → `compensation_summary_json` / `compensation_audit_json`) | 2026-07-06 |

### Materials and tailoring

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-020 | Every tailored-resume bullet traces back to its source evidence (provenance). | Hero (Audited Materials); README (Score/Generate …) | Current | repo owner | [tailoring](architecture/tailoring.md) (provenance rows built from final generated text); `job_bullet_provenance` | 2026-07-06 |
| CL-021 | Deterministic fabrication gates block invented facts (no fabricated metric, date, title, employer, or ungrounded named technology); the gate fails closed. | Hero (Audited Materials) | Current | repo owner | [tailoring](architecture/tailoring.md) (Fabrication gate: `fabrication_detector.py`, `claim_grounding.py`) | 2026-07-06 |
| CL-022 | Keyword coverage is computed against the actual rendered resume text, never inferred from the job keywords alone. | Hero (Audited Materials) | Current | repo owner | [tailoring](architecture/tailoring.md) ("computed against the rendered resume text"); [materials](architecture/materials.md) | 2026-07-06 |
| CL-023 | Apply Review renders the current HTML/CSS resume from the same source that prints the final PDF, with line selection and in-document audit annotations, and lets the user edit before approval. | README (Review and edit …); Tour (Apply Review) | Current | repo owner | `BR-046` (requirements.md) | 2026-07-06 |
| CL-024 | Apply Review supports draft edits, named revisions, and comment threads with draft-aware approval; revising never destroys the last accepted artifact. | Data & Safety (Auto-Apply Safety) | Current | repo owner | `BR-052` (requirements.md) | 2026-07-06 |
| CL-025 | A failed material refresh (including a template change) preserves the last accepted artifacts instead of destroying them. | Data & Safety (Auto-Apply Safety) | Current | repo owner | `TR-032`, `BR-041` (requirements.md) | 2026-07-06 |
| CL-026 | Resume PDF style templates are editable in Preferences with a default template and a per-job override, without modifying candidate profile data. | README (Edit resume PDF style templates …) | Current | repo owner | [materials](architecture/materials.md) | 2026-07-06 |
| CL-027 | Apply Review can compare a freshly rendered resume draft against the last accepted artifact before approval, using the same rendered text and keyword-coverage source the audit uses; the comparison is read-only and does not replace the accepted artifact. | README (Normal Flow, step 7) | Current | repo owner | [materials](architecture/materials.md) (rendered text + coverage source); `apps/web/src/contexts/materials/selectors/compareCoverage.ts` | 2026-07-06 |

### Cover letters

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-042 | Cover letters are generated from the approved tailored resume plus canonical profile evidence (an approved resume is required first) and run the same deterministic never-fabricate and prose skill/tool gates as the resume body (CONTROL-03): a fabricated metric, date, title, or employer, or an ungrounded job-target technology, downgrades the letter to REJECTED — never shipped as approved — and every accepted or rejected letter carries a minimal truthfulness trail (`fabrication_audit`). Cover letters do not carry the resume's per-bullet provenance or keyword-coverage audit. | Hero (Audited Materials); README (What It Does); Normal Flows (Generate And Inspect Materials) | Current | repo owner | [materials](architecture/materials.md) (Cover-letter truthfulness gate); `workers/automation/src/jobctrl/scoring/cover_letter.py`; `.../domain/materials/use_cases.py` (`GenerateCoverLetterUseCase`); `scan_cover_letter` (`.../domain/materials/fabrication_detector.py`) | 2026-07-06 |

### Career evidence map

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-028 | The evidence map inverts the profile's achievements and skills into how they were actually used — resume-bullet usage, requirement-fit usage, generation-time skill coverage, and missing / blocked / transferable gaps — computed only from recorded generation-time linkages, with deleted or hidden jobs excluded. | README (What It Does); Normal Flows (Inspect The Evidence Map) | Current | repo owner | [read model](architecture/read-model.md) (`evidence_usage_projections`); `apps/api/src/server.ts` (`GET /v1/evidence-map` → `listEvidenceMap`) | 2026-07-06 |

### Interview preparation

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-029 | Grounded, stored interview prep is generated per job, reusing the resume-tailoring fabrication, claim-grounding, and adversarial-review gates behind a spend preflight; generation is a durable workflow (deterministic id, heartbeats, run-scoped retry idempotency via `origin_run_id`) and a failed refresh preserves the last accepted prep. It is stored pre-interview material with inspectable evidence links — explicitly not a live interview assistant (no transcript, no real-time copilot). | README (What It Does; Responsible Use); Normal Flows (Generate Interview Prep) | Beta | repo owner | [materials](architecture/materials.md) (Stored Interview Preparation); `workers/automation/src/jobctrl/interview/workflow.py` (spend preflight, deterministic id); `.../interview/activities.py` (`origin_run_id` idempotency, heartbeats); `.../domain/interview/use_cases.py` (materials gates reused, preserve-on-failure) | 2026-07-06 |

> **Why Beta.** CL-029 is shipped and pointer-backed, and its reused gates prove
> the no-fabrication floor. Per the owner's 2026-07-06 §11.6 bar, it remains
> `Beta` because it is a brand-new LLM-generated user-facing surface carried
> into high-stakes interview preparation without real-usage validation.

### Apply safety

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-030 | By default, no standing apply loop is enabled (`autoApply: false`) and live browser submission requires an explicit Apply Review approval (`applyApprovalRequired: true`), enforced in the worker's claim transaction rather than only surfaced in the UI. | Hero (Supervised Apply); README (Auto-apply …); Security (Apply Approval Is Required); Data & Safety | Current | repo owner | `BR-023` (requirements.md); [security](user/security.md) (worker claim transaction); `apps/api/src/application-feedback.ts`; `workers/automation/src/jobctrl/apply/launcher.py` | 2026-07-06 |
| CL-031 | The live-submit approval is bound to the reviewed materials generation, profile version, and application URL, and requires matching dry-run evidence. | Security (Apply Approval); Data & Safety (Auto-Apply Safety) | Current | repo owner | [security](user/security.md); `apps/api/src/application-feedback.ts`; `apps/api/test/application-feedback.test.ts` (approval binding, #271) | 2026-07-06 |
| CL-032 | A partial dry run satisfies the gate only through an explicit partial-evidence approval action that names the specific run and shows the blocked channels being accepted. | Security (Apply Approval); Data & Safety | Current | repo owner | [security](user/security.md); `apps/api/src/application-feedback.ts` (blocked channels, #271) | 2026-07-06 |
| CL-033 | Dry run submits nothing: the agent is told not to click submit, and a browser-level CDP guard blocks non-loopback POST/PUT/PATCH and overrides form submits. | Hero (Supervised Apply); README (Auto-apply …); Security (Dry-Run Cannot Submit) | Current | repo owner | [security](user/security.md); `workers/automation/src/jobctrl/apply/chrome.py` (`install_dry_run_cdp_guard` / `_DryRunCdpGuard`; non-loopback POST/PUT/PATCH → `Fetch.failRequest`; `_FORM_SUBMIT_GUARD_SOURCE` form-submit override) | 2026-07-06 |
| CL-034 | No application is ever submitted twice: claiming excludes runs already in progress / succeeded / parked for verification, a submit-intent checkpoint is recorded before submit, and a crash after that intent parks the run for manual verification instead of retrying. | Hero (Supervised Apply); README; Security (Applications Submit At Most Once); Data & Safety | Current | repo owner | `BR-054` (requirements.md); `workers/automation/src/jobctrl/apply/launcher.py` (`_has_apply_submit_intent`, needs_verification) | 2026-07-06 |
| CL-035 | JobCtrl never submits applications, runs destructive profile/database actions, or bypasses third-party controls (CAPTCHA, paywall, login, rate-limit, bot-control) without explicit user authorization; the apply agent stops on SSO, declines permission prompts, refuses ID/biometric verification, and never enters payment details. | README (Responsible Use); Security (No Third-Party Bypass; The Apply Agent) | Current | repo owner | `BR-001` (requirements.md); [security](user/security.md) | 2026-07-06 |
| CL-036 | Application outcomes can be recorded manually without browser automation, and web approval facts do not submit anything by themselves. | Data & Safety (Auto-Apply Safety) | Current | repo owner | [security](user/security.md); `apps/api/src/application-feedback.ts` | 2026-07-06 |
| CL-037 | The apply agent is a local Claude runtime subprocess that reads untrusted job pages; prompt injection is a real exposure that the explicit tool allowlist, reduced environment, and model instructions limit but do not remove. | Security (The Apply Agent) | Current | repo owner | [security](user/security.md) (prompt-injection controls and owned tool allowlist); `workers/automation/src/jobctrl/infrastructure/apply/claude_code_cli.py` (`_ALLOWED_TOOLS`, `_ENV_ALLOWLIST`) | 2026-07-06 |
| CL-038 | On supported ATS pages the browser extension offers deterministic, profile-backed field suggestions and shows each value's profile source; the user chooses what to fill, the extension generates no free-text answers, and it has no submission path (it prevents the form's own submit and never submits on the user's behalf). | README (Browser Extension Capture And Autofill); Security (Browser Extension Pairing) | Current | repo owner | `BR-056` (requirements.md); [local TS API](local-ts-api.md) (`GET /v1/extension/autofill/profile`); `apps/extension/src/content-script.ts` (submit prevented) | 2026-07-06 |
| CL-039 | Autonomous browser submission exists only behind explicit opt-in: `autoApply: true` keeps one visible continuous Apply workflow running, and submitting without Apply Review approval also requires `applyApprovalRequired: false`; minimum score, spend ceiling, at-most-once submit intent, dry-run guards, and CAPTCHA fail-closed behavior still apply. | README (Auto-apply); Configuration (Browser Apply Automation); Normal Flows (Rehearse With A Dry Run); Pipeline Operations (Standing Auto-Apply Loop) | Current | repo owner | [pipeline operations](architecture/pipeline/operations.md); `workers/automation/src/jobctrl/apply/auto_apply.py`; `workers/automation/src/jobctrl/apply/activities.py`; `apps/api/src/read-model.ts`; `apps/web/src/contexts/profile/forms/settings-form.tsx` | 2026-07-06 |

### LLM spend

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-040 | A configurable daily LLM spend ceiling (`dailyBudgetUsd`, default 25; 0 = unlimited) runs a budget preflight before each spendful workflow and stops it with a non-retryable budget error once the day's estimated spend reaches the ceiling. It is a per-workflow preflight over an estimated ledger, not a mid-call interrupt and not the provider's bill. | Hero (Temporal-Native Pipeline); README (Configuration); Security (Daily LLM Spend Ceiling); Data & Safety | Current | repo owner | `BR-050` (requirements.md); [pipeline operations](architecture/pipeline/operations.md) | 2026-07-06 |
| CL-041 | Today's estimated spend against the budget is visible on `GET /v1/health` and in the web app's health surface. | Data & Safety (LLM Spend Ceiling); Security | Current | repo owner | `BR-050` (requirements.md); `apps/api/src/server.ts` (`/v1/health` → `readLlmSpendHealth`) | 2026-07-06 |

### Orchestration and runs

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-050 | Every stage runs as a durable Temporal workflow with heartbeats and classified, bounded retries. | Hero (Temporal-Native Pipeline); README (What It Does) | Current | repo owner | `TR-008` (requirements.md); [envelope](architecture/pipeline/envelope.md); [concurrency](architecture/pipeline/concurrency.md) | 2026-07-06 |
| CL-051 | The Runs page shows every workflow run with status, mode, timing, and a deep link into the Temporal web UI. | README (Track pipeline …); Tour (Runs History) | Current | repo owner | `BR-005` (requirements.md); [read model](architecture/read-model.md); `workflow_run_projections` | 2026-07-06 |

### Outcome analytics

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-055 | A local Analytics view summarizes recorded application outcomes as a conversion funnel (applied → reply → interview → offer / rejection) broken down by source, score band, fit band, apply mode, accepted resume template, and tailoring policy. Low-sample cells are suppressed and rates are presented descriptively, without causal claims. | README (Track progress … Analytics) | Beta | repo owner | [read model](architecture/read-model.md) (`dashboard_projections` `outcome_conversion_json`); `apps/web/src/views/analytics/SmallSampleNotice.tsx` (small-sample suppression) | 2026-07-06 |
| CL-056 | Post-interview reflection notes can be recorded against the specific accepted prep generation they followed, via a nullable, immutable link on `application_outcomes`; recording a reflection does not change outcome-conversion counts. | README (Responsible Use); Normal Flows (Generate Interview Prep); Data & Safety (Auto-Apply Safety) | Current | repo owner | [read model](architecture/read-model.md) (nullable `interview_prep_generation` link; conversion counts unaffected) | 2026-07-06 |

> **Why Beta.** The capability is shipped and pointer-backed, but the honest
> reading of outcome rates requires a load-bearing qualifier (small samples are
> suppressed; the rates are descriptive, not causal). That qualifier is carried
> at the point of claim — in the Analytics view itself (`SmallSampleNotice` plus
> the non-causal caption) — so the surface stays truthful; the `Beta` label
> records that the qualifier is load-bearing rather than a mere scope note.

### Local-first and privacy

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-060 | JobCtrl is local-first: no hosted backend and no account system; the profile, SQLite database, generated materials, browser state, and logs live under the user's home directory, and nothing leaves the machine except steps the user explicitly configures and runs. | Hero (Local-First & Private); README; Data & Safety (Privacy Quick Answer); Security | Current | repo owner | [security](user/security.md); [data & safety](user/data-and-safety.md); `TR-005` (requirements.md) | 2026-07-06 |
| CL-061 | The outbound calls that can carry private data are enumerated and each is opt-in / configuration-gated: LLM providers, the apply-agent prompt, job boards/ATS/posting pages, Gmail (read-only), Google Maps autocomplete, CAPTCHA solving, and Langfuse telemetry. | README (What Leaves Your Machine); Security (What Leaves Your Machine); Data & Safety (External Services) | Current | repo owner | [security](user/security.md) (What Leaves Your Machine table); [data & safety](user/data-and-safety.md) | 2026-07-06 |
| CL-062 | The shipped Gmail connector is read-only (it does not request `gmail.send`); raw email bodies stay local and are not copied into events, telemetry, broad projections, or logs. | README (Responsible Use); Security; Data & Safety | Current | repo owner | [security](user/security.md); `workers/automation/src/jobctrl/infrastructure/gmail/feedback.py` | 2026-07-06 |
| CL-063 | The local API defaults to a loopback bind (`127.0.0.1`); browser-extension routes additionally require a local capability token stored under `~/.jobctrl/` and accepted only on loopback `/v1/extension/*` routes, and that token does not grant application-submission authority. | README (Responsible Use); Security (Browser Extension Pairing) | Current | repo owner | `TR-005` (requirements.md); [security](user/security.md) | 2026-07-06 |
| CL-064 | LLM provider keys can be stored in the macOS Keychain (never written to SQLite, logs, traces, or artifacts) or in `.env`; a profile password, if configured, is used only by local autofill/login handling and does not enter the apply-agent model prompt. | Security (Credentials) | Current | repo owner | [security](user/security.md) | 2026-07-06 |
| CL-065 | Langfuse/OpenTelemetry export is off unless configured; `LANGFUSE_DISABLE=1` opts out even when credentials are present. | Data & Safety (Telemetry); Security; Configuration | Current | repo owner | [observability](architecture/observability.md); [configuration](user/configuration.md) | 2026-07-06 |
| CL-066 | The local database, `.env`, and generated artifacts are not encrypted at rest; their protection is the operating-system account and disk security. | Security (Local data is not encrypted) | Current | repo owner | [security](user/security.md) | 2026-07-06 |

### Local operations

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-070 | A local `jobctrl backup` command produces a consistent copy of the SQLite database via `VACUUM INTO` without deleting anything, and schema migrations are guarded by a schema-version check. | README (Back Up And Restore) | Current | repo owner | `BR-053` (requirements.md); [storage](architecture/storage.md) | 2026-07-06 |
| CL-071 | The daily digest is local-only: `jobctrl digest` and the Dashboard digest read from the database without sending notifications or advancing review state, and only the explicit acknowledge action advances the digest watermark. | README (Local Data And Safety) | Current | repo owner | [read model](architecture/read-model.md); `jobctrl digest` (README CLI Reference) | 2026-07-06 |
| CL-072 | Documentation screenshots and QA fixtures use synthetic data only for illustration and deterministic invariant tests, never as the source for public performance, speed, accuracy, or outcome measurements; `scripts/release_check.py` enforces synthetic/public hygiene on every push/PR (scanning for real-profile needles, secrets, prompt tripwires, blocked file types, and blocked distribution paths). | README (Screenshots); Data & Safety (Public Bug Reports); Tour (info callouts) | Current | repo owner | `scripts/release_check.py`; [local development](local-development.md#documentation-screenshots) | 2026-07-06 |
| CL-073 | First-run setup (`jobctrl setup`, reached from the guided installer) detects local vendor auth, persists intentionally enabled or skipped employer-analysis legs, and hands off to `doctor`; employer-analysis readiness always requires Claude synthesis auth — every ensemble run reconciles through the Claude synthesis pass — even when the `claude` draft leg is disabled, with `setup` warning that analysis is not ready and `doctor` reporting a dedicated `Claude synthesis auth` row. | README (Get Started; CLI Reference `setup`); Getting Started; Configuration (Employer-Analysis Ensemble) | Current | repo owner | `workers/automation/src/jobctrl/infrastructure/setup_probes.py` (`probe_analysis_setup`, `probe_claude_synthesis_auth`); `workers/automation/tests/test_setup_synthesis_auth.py`; [configuration](user/configuration.md) (Employer-Analysis Ensemble) | 2026-07-06 |

### Profile

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-080 | The Profile is the single source of truth that scoring and tailoring build on; it is created or imported locally without any external account. | README (Normal Flow); Tour (Set Up Your Profile) | Current | repo owner | [scoring](architecture/scoring.md); [tailoring](architecture/tailoring.md) | 2026-07-06 |

### Install & Distribution

| Claim ID | Claim (neutral) | Surfaces | Status | Owner | Verification pointer | Last verified |
| --- | --- | --- | --- | --- | --- | --- |
| CL-081 | A one-line bootstrap script clones (or fast-forwards) a user-owned checkout and hands off to the guided interactive installer, which asks before any system-level (Homebrew) install and reports what it skipped. | README (Get Started); Getting Started (Install Dependencies) | Current | repo owner | `scripts/get`; `scripts/install` (confirm prompts, summary) | 2026-07-07 |
| CL-082 | A Homebrew formula installs the toolchain dependencies (git, node, uv, temporal, poppler) plus a global `jobctrl` launcher that bootstraps and then proxies CLI commands into the user-owned checkout; the formula is staged in the existing `ebarti/homebrew-tap` (owner pushes at release), and the in-repo copy is installable today via `brew install --formula … --HEAD`. | README (Get Started); Getting Started (Install Dependencies) | Current | repo owner | `packaging/homebrew/Formula/jobctrl.rb`; `scripts/jobctrl-launcher`; [publish checklist §9.5](publish-checklist.md) | 2026-07-07 |
| CL-083 | Contact records are kept per company or application with per-fact provenance and CSV import; outreach drafts are truthful and reviewable under the same anti-fabrication gates as resumes; the user sends messages themselves and logs the send (date + channel) — the only way a thread is marked sent; follow-up reminders are surfaced-only suggestions; there is no send transport of any kind. | README (What It Does — contacts/outreach); Normal Flows §11 (Keep Contacts); Configuration (Contact Research; Outreach Follow-Ups) | Current | repo owner | Outreach planner close-out (`plans/implemented/2026-07-05-outreach-planner-plan.md`, INV-1 no-auto-send, four-layer enforcement + fixtures); [normal flows](user/normal-flows.md) §11; [configuration](user/configuration.md) (Contact Research, Outreach Follow-Ups) | 2026-07-07 |

## Maintenance cadence and re-review

Per plan §5 and §8.3, re-run the claim review and refresh each row's
`Last verified` whenever a public surface changes, and at minimum **every
release**. The review process:

1. Enumerate candidate claims from the live public surfaces (`README.md`,
   `docs/index.md` hero `features`, `docs/user/screenshots.md` captions,
   `docs/user/normal-flows.md`, `docs/user/data-and-safety.md`,
   `docs/user/security.md`).
2. For each, confirm Status + owner + verification pointer and resolve every
   `Current` pointer. Treat synthetic fixtures as illustrative or invariant-test
   evidence only; never use them to substantiate public measurement claims.
3. Reconcile against `ROADMAP.md` so nothing labelled `Current` is actually a
   "Now / Next / Later" roadmap item.
4. Re-record the freeze `main` sha and date on the [Freeze status](#freeze-status)
   line.

Any new public claim must land a row here (Status + owner + resolving pointer)
in the same change that introduces it.

## Owner decisions for this ledger

Carried from the plan's open owner decisions (§11); resolve at sign-off:

- **§11.1 Location/publication.** Proposed: this file at `docs/claims-ledger.md`,
  repository-only (registered in `UNPUBLISHED_FILES` + `srcExclude`). Confirm.
- **§11.6 Current-vs-Beta threshold.** Resolved on 2026-07-06 by owner decision:
  brand-new LLM-generated user-facing surfaces without real-usage validation are
  `Beta` even when truthfulness gates pass, because those gates prove a
  no-fabrication floor, not output quality. This pass applies the recorded
  verdict by reclassifying **CL-029** to `Beta`. The same owner decision records
  the evidence rule that synthetic data may illustrate, never measure. Remaining
  candidates to review at freeze sign-off under this bar: **CL-030/CL-031/CL-032/CL-033/CL-034/CL-037** (live
  apply automation is the highest-risk surface); **CL-040** (the spend ceiling's
  "estimate, not billing truth" and "per-workflow preflight, not mid-call
  interrupt" qualifiers may be load-bearing); **CL-005/CL-038** (the browser
  extension ships unpacked in developer mode, not from a browser store); and
  **CL-008** (the `python-jobspy` invocation-boundary caveat — JobCtrl cannot
  robots-gate the library's individual per-board requests). **CL-055** is
  already classified `Beta` (see its "Why Beta" note). The earlier `BR-052`
  duplicate-handle defect was resolved on `main` by #309 (autofill renumbered to
  `BR-056`), so CL-024 and CL-038 now carry clean one-hop citations.
- **§11.7 Sign-off owners.** Replace the `repo owner` default in the Owner column
  with named accountable owners, and record who owns the claim-freeze sign-off.
