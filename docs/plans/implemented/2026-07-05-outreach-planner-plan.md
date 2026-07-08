# Contact Research And Outreach Planner — Implementation Plan

> **Status:** implemented — delivered as the R6 stacked train: #266 (plan),
> #325 (P0 contracts), #331 (P1 contacts), #332 (P2 research), #333 (P3
> drafts), #335 (P4 send logging + follow-ups), and #347 (P5 product QA, docs,
> regression matrix). Canonical behavior now lives in the owning user,
> architecture, API, frontend, and QA docs; this file is the historical delivery
> plan and acceptance record.

> **Anchors verified against `main` @ `a488e4e9853dde292badc74a88c7de24160edc52`.**
> Every repository path and symbol cited below was checked against that commit in
> a worktree. When an implementer picks this up, re-verify anchors against the
> then-current `main` before coding (per the repo's anchor-validation discipline).

> **For implementers:** you are capable models at high reasoning effort. This plan
> specifies objectives, invariants, contracts, acceptance criteria, and
> verification — not step-by-step edits. Follow the existing patterns cited by
> path; do not invent parallel machinery where a cited seam already exists.

---

## 0. Reading list (read before coding)

- `CLAUDE.md` — engineering conventions, worktree rules, root-cause/auditability discipline, frontend conventions.
- `docs/architecture/domain-model/index.md` and its subpages `strategic.md`, `tactical.md`, `ports.md`, `integration.md`, `persistence.md` — the DDD + hexagonal architecture this plan extends.
- `docs/architecture/read-model.md` — event → projection → SSE flow and the apply-feedback tables.
- `docs/architecture/frontend/` (`contexts.md`, `patterns.md`, `integration.md`, `structure.md`) — the frontend bounded-context contract.
- `docs/local-reliability-qa.md` — the regression matrix format and required commands.
- `docs/plans/implemented/2026-06-01-apply-review-outcome-feedback-design.md` — the closest existing analog (review queue, append-only decisions, read-only Gmail feedback, "records approval facts only, does not act").
- `docs/plans/2026-07-03-oss-release-remediation-spec.md` §W1.7 (owned email send) and §W1.8 (fail-closed defaults) — the adjacent send capability this plan deliberately stays **stricter** than.

---

## 1. Goal

Add a **contact research and outreach planning** capability so a user can, for a
company or a specific application:

1. Keep **contact records** (recruiter, hiring manager, referrer) attached to a
   company and/or an application, with **provenance for every stored fact**.
2. Run **research tasks** ("find the hiring manager / recruiter for this
   application") as **supervised** enrichment over an **explicit, conservative
   set of allowed data sources**, where research *proposes* candidates and the
   user *confirms* them.
3. Identify **warm intros** from **user-provided relationship data only**.
4. Generate **reviewable, editable outreach drafts** (intro requests,
   follow-ups) under the **same truthfulness discipline** as generated resumes
   and cover letters.
5. **Schedule follow-ups** tied to the application lifecycle and surface **due
   follow-ups** in the UI.
6. **Log outreach** with an explicit **user-performed-send** model: the system
   drafts, previews, and records; **the user sends through their own channels**.

### 1.1 Product invariants (non-negotiable)

| # | Invariant | Enforced by (design) |
|---|---|---|
| INV-1 | **No auto-send. Ever.** No code path sends an email/message/DM. Sending is a user action outside JobHunter; the system only records that the user sent it. There is no "auto-send" or "send on schedule" option in this scope. | Aggregate-level invariant (§8) + a no-send-transport grep test + an adapter-never-called test (§8.3). |
| INV-2 | **Every stored contact fact has inspectable provenance.** Source kind, source reference, capture method, timestamp, and confidence are recorded and viewable; nothing is displayed without a source of truth. | Provenance value object on every attribute (§6); research proposals carry provenance; projection surfaces it (§10, §11). |
| INV-3 | **Allowed sources are explicit and conservative.** Only user-entered data, public web pages fetched through existing enrichment infrastructure, and user-imported contact lists. No third-party account scraping, no login-walled harvesting. Respecting platform terms is a product invariant. | A source-access policy modelled on the existing conservative policies (§5); reuses `SourcePolicy.third_party_control_bypass=False`; the authenticated/login-walled resolver is out of scope as a source. |
| INV-4 | **Research is supervised.** Research proposes; the user confirms before a proposed fact becomes a stored contact fact. | `ContactResearchTask` proposes candidates in a `needs_review` state; a user command promotes them (§4, §9). |
| INV-5 | **Drafts are truthful and reviewable.** Outreach drafts pass the same anti-fabrication gates as materials and are editable before use; a re-draft never destroys the last approved draft until a replacement is approved. | Reuse of the materials gate stack + `ArtifactStatus`-style lifecycle with generation versioning (§7). |
| INV-6 | **Warm intros come only from user-provided relationships.** No inference of relationships from scraped network graphs. | Warm-intro signals are derived from a user-owned relationship dataset only (§4.4). |

---

## 2. Ubiquitous language (this context)

- **Contact** — a person relevant to a company or application (recruiter, hiring
  manager, referrer, warm intro). Entity with identity.
- **ContactAttribute** — one fact about a contact (name, role/title, public
  profile URL, email the *user* holds, notes). Value object; **carries
  `ContactFactProvenance`**.
- **ContactFactProvenance** — where a fact came from: `sourceKind`
  (`user_entered | public_web_page | user_imported_list | derived`),
  `sourceRef` (URL / import filename / user note id), `captureMethod`,
  `capturedAt`, `confidence`, `userConfirmed`. Models the existing
  `AchievementEvidence` provenance shape.
- **ContactResearchTask** — a supervised run that fetches allowed public sources
  for a company/application and *proposes* candidate contacts/attributes for user
  review.
- **ContactCandidate** — an unconfirmed proposed contact/attribute produced by a
  research task; not a stored contact fact until the user confirms it.
- **RelationshipRecord** — a user-provided statement that the user knows a person
  (the only warm-intro input).
- **WarmIntroSignal** — a computed link between a `Contact` and a
  `RelationshipRecord` the user already owns.
- **OutreachThread** — the outreach state for one `(Contact, optional
  application)`: its drafts, its send log, and its follow-up schedule.
- **OutreachDraft** — a generated, reviewable, editable message (intro request or
  follow-up). Generation-versioned; lifecycle `candidate | approved | rejected |
  superseded`, reusing the materials `ArtifactStatus` semantics.
- **OutreachSendLog** — a **user-attested** record that the user sent a specific
  approved draft on a date through a named channel. The only way a thread reaches
  a "sent" state.
- **FollowUpSchedule** — the next follow-up due date for a thread, derived from
  the application lifecycle; surfaces as **due follow-ups**.

Naming is neutral by design: this plan never names external platforms as
outreach targets. Source *categories* (user-entered, public web page,
user-imported list) are the vocabulary; the disallowed categories
(third-party-account scraping, login-walled harvesting) are named only to
exclude them.

---

## 3. Owning bounded context

### 3.1 A new ninth bounded context: **Contact & Outreach** (Supporting Domain)

The eight contexts in `docs/architecture/domain-model/strategic.md` do not own a
person/relationship concept, and none owns generated *relationship* messages.
Contacts have their own vocabulary, lifecycle, and data, so they warrant a
bounded context rather than bolting onto Discovery (which owns `Employer` only as
a value object) or Apply (which owns `ApplyRun`).

**Relationships to existing contexts** (all via published domain events / read
models, never by reaching into another context's internals — per
`docs/architecture/domain-model/integration.md`):

- **Discovery** — a `Contact` links to an `Employer` (company) and, optionally,
  to a `JobId` (the application). It **consumes** job identity; it does not own
  it.
- **Apply Automation / Operations** — the follow-up schedule keys off apply and
  outcome facts already present in `job_events` / `application_outcomes`
  (`docs/architecture/read-model.md`). Contact & Outreach **consumes** those
  events; it never triggers apply.
- **Materials Generation** — outreach drafts **reuse** the materials
  truthfulness gates (§7). Contact & Outreach does not own resume/cover
  artifacts.
- **Job Enrichment** — research **reuses** the enrichment fetch/extraction
  infrastructure (§5). It does not own the `JobEnrichment` aggregate.
- **Candidate Profile** — the user's identity/voice for drafts and the
  user-owned relationship dataset are read from Profile as a snapshot
  (Conformist), following the `ProfileSnapshot` pattern.
- **Operations / Read-Side** — projects Contact & Outreach read models exactly as
  it projects every other context.

### 3.2 Aggregates (three roots, each a transactional-consistency boundary)

Owning three roots in one context is consistent with the codebase: Materials owns
a multi-entity `MaterialsSet`, Apply owns a lifecycle `ApplyRun`. Each root below
encloses exactly the data that must be consistent in one transaction.

| Aggregate root | Identity | Why its own boundary |
|---|---|---|
| **`Contact`** | `(TenantId, ContactId)` | A durable person record + its provenance-bearing attributes + links + warm-intro signals. One command mutates one contact. |
| **`ContactResearchTask`** | `(TenantId, ResearchTaskId)` | A supervised run with its own lifecycle (`queued → running → needs_review → completed/failed`) and its proposed candidates. Distinct lifecycle from a durable contact — mirrors how `ApplyRun` is separate from `Job`. |
| **`OutreachThread`** | `(TenantId, OutreachThreadId)` | Drafts (generation-versioned), the user-attested send log, and the follow-up schedule for one `(Contact, optional application)`. Its invariants (no-auto-send, draft lifecycle) must hold atomically. |

Directory layout follows the existing per-context Python shape
(`workers/automation/src/jobhunter/domain/<context>/{aggregate,entities,value_objects,services,use_cases}.py`;
compare `workers/automation/src/jobhunter/domain/apply/`,
`workers/automation/src/jobhunter/domain/materials/`): a new
`workers/automation/src/jobhunter/domain/contact/` package.

---

## 4. Domain model

### 4.1 `Contact` aggregate

- **Entities:** `Contact` (root). **Value objects:** `ContactAttribute`
  (with `ContactFactProvenance`), `ContactLink` (`employer` and/or `jobId`),
  `ContactRole` (enum: `recruiter | hiring_manager | referrer | warm_intro |
  other`), `WarmIntroSignal`.
- **Invariants:**
  - Every `ContactAttribute` carries a non-null `ContactFactProvenance`
    (INV-2). Constructing an attribute without provenance is impossible
    (dataclass `__post_init__` raise, mirroring
    `workers/automation/src/jobhunter/domain/apply/aggregate.py` `__post_init__` guards).
  - A `Contact` links to at least one of `{employer, jobId}`.
  - `ContactId` is immutable once assigned.
- **Domain services (pure):** `WarmIntroMatcher` — given a `Contact` and the
  user-owned `RelationshipRecord` set, computes `WarmIntroSignal`s. No I/O, no
  network graph inference (INV-6).
- **Domain events:** `ContactCreated`, `ContactUpdated`,
  `ContactAttributeRecorded` (payload includes provenance), `ContactDeleted`,
  `WarmIntroIdentified`.

### 4.2 `ContactResearchTask` aggregate

- **Root:** `ContactResearchTask` with `status` discriminated union
  (`queued | running | needs_review | completed | failed`).
  **Entities/VOs:** `ContactCandidate` (proposed contact + attributes, each with
  provenance), `ResearchSourceAttempt` (which allowed source was fetched, outcome,
  timestamp — provenance of the *search itself*).
- **Invariants:**
  - A task only fetches sources permitted by the source-access policy (§5); an
    attempt against a disallowed source is rejected before any fetch.
  - Candidates land in `needs_review`; **no candidate becomes a stored `Contact`
    fact without an explicit user confirmation command** (INV-4).
  - Every `ContactCandidate` attribute carries provenance (INV-2).
- **Execution:** a **Temporal workflow** `ContactResearchWorkflow`
  (deterministic id, e.g. `contact-research-{idempotency_key}`), one activity
  per allowed source family with heartbeats — modelled on `DiscoverWorkflow`
  (`docs/architecture/domain-model/persistence.md` §8.4). Reuses the LLM spend
  preflight (§5.4). Automation is **off by default** (no schedule).
- **Domain events:** `ContactResearchTaskStarted`, `ContactCandidateProposed`
  (with provenance), `ContactResearchTaskNeedsReview`,
  `ContactResearchTaskCompleted`, `ContactResearchTaskFailed`.

### 4.3 `OutreachThread` aggregate

- **Root:** `OutreachThread`. **Entities:** `OutreachDraft` (generation-versioned,
  `ArtifactStatus`-style lifecycle), `OutreachSendLog` (user-attested),
  `FollowUpSchedule`.
- **Invariants:**
  - **No `OutreachThread` can reach a "sent" state except through an
    `OutreachSendLog` created by an explicit user action** (INV-1). This is an
    aggregate `__post_init__`/transition guard, mirroring the `ApplyRun`
    dry-run invariant (`workers/automation/src/jobhunter/domain/apply/aggregate.py`: a `DryRunComplete` result
    MUST coincide with `dry_run = True`; the analog here is "a `sent` marker MUST
    coincide with a user-attested `OutreachSendLog`").
  - An `OutreachDraft` must pass the truthfulness gates (§7) before it can be
    `approved`.
  - Re-drafting creates a **new generation** and supersedes the prior; the last
    `approved` draft stays readable until a replacement is `approved` (INV-5),
    mirroring `MaterialsSetFactory.next_generation`.
- **Domain events:** `OutreachDraftGenerated`, `OutreachDraftRevised`,
  `OutreachDraftApproved`, `OutreachDraftRejected`, `OutreachSendLogged`,
  `FollowUpScheduled`, `FollowUpCompleted`, `FollowUpDismissed`.

### 4.4 Warm-intro identification (user data only)

- Input is a **user-owned `RelationshipRecord` dataset** (people the user says
  they know), entered/edited in Profile or imported by the user. No source other
  than user-provided data feeds warm-intro logic.
- `WarmIntroMatcher` (pure) links a `Contact` to `RelationshipRecord`s and emits
  `WarmIntroIdentified`. The match basis (which relationship, why) is itself
  provenance and is displayed.

### 4.5 Ports & repositories

Follow the per-aggregate repository rule
(`docs/architecture/domain-model/persistence.md` §7.1) and the
publisher-injected repository shape proven by
`workers/automation/src/jobhunter/infrastructure/profile/sqlite_repository.py`
(ctor takes `publisher: EventPublisher`; `save()` persists then publishes a
domain event inside a try/except so event publication never blocks the write):

- **Driven ports** (new, in `workers/automation/src/jobhunter/domain/ports/contact.py`):
  `ContactRepository`, `ContactResearchTaskRepository`, `OutreachThreadRepository`
  (all tenant-scoped `load/save/list_*`).
- **Reused driven ports:** `DetailPageFetcherPort`
  (`workers/automation/src/jobhunter/domain/ports/enrichment.py`) for public-page fetch; `LlmPort`
  (`workers/automation/src/jobhunter/domain/ports/llm.py`) for extraction/drafting; `EventPublisher`
  (`workers/automation/src/jobhunter/domain/ports/events.py`).
- **Driving ports (use cases):** `CreateContactUseCase`, `UpdateContactUseCase`,
  `ImportContactsUseCase`, `RunContactResearchUseCase`,
  `ConfirmContactCandidateUseCase`, `GenerateOutreachDraftUseCase`,
  `ReviseOutreachDraftUseCase`, `ApproveOutreachDraftUseCase`,
  `LogOutreachSendUseCase`, `ScheduleFollowUpUseCase`,
  `CompleteFollowUpUseCase`. Simple state transitions (create/update/import
  contact, confirm candidate, log send, schedule/complete follow-up) can be hosted
  in the TypeScript API directly per
  `docs/architecture/domain-model/integration.md` §6.8; research and draft
  generation (LLM + fetch) go to the Python worker via JSON-RPC / Temporal.

### 4.6 Event registry parity (hard rule)

Every new domain event type lands, **in the same PR**, in BOTH registries plus
the web handler plus web fixtures (per `docs/plans/2026-07-03-oss-release-remediation-spec.md`
§0.2 and the frontend conventions in `CLAUDE.md`):

1. Python: a per-context module `workers/automation/src/jobhunter/domain/events/contact.py`
   (`<Event>Payload` dataclass + `create_<event>` factory, snake_case payload),
   registered in `workers/automation/src/jobhunter/domain/events/__init__.py`
   `DOMAIN_EVENT_TYPES`.
2. TypeScript: `packages/domain-types/src/events/contact.ts` (interface +
   `DomainEvent<...>` type + `create<Event>` factory, camelCase payload), added
   to `DomainEventUnion` and `DOMAIN_EVENT_TYPES` in
   `packages/domain-types/src/events/index.ts` (the compile-time
   `AssertEnumExhaustive` forces this).
3. Web: a handler per event in
   `apps/web/src/contexts/outreach/handlers.ts`, registered in the `handlers`
   map in `apps/web/src/contexts/operations/invalidation-router.ts` (the
   `HandlerMap` mapped type makes a missing handler a compile error).
4. Fixtures: a `create<Event>()` fixture and an entry in
   `apps/web/src/test/fixtures/events.ts` so
   `apps/web/src/contexts/operations/every-event-has-handler.test.ts` passes;
   Python parity is guarded by `workers/automation/tests/test_domain_event_parity.py`.

---

## 5. Allowed data sources and access policy

### 5.1 The conservative allowlist (INV-3)

Exactly three source categories are permitted, defaulting to the most restrictive
posture (fail-closed), modelled on the existing conservative access policies:

| Source category | Access mode | Default | Fetch path |
|---|---|---|---|
| **User-entered** | direct user input | always available | none (typed in UI/CLI) |
| **Public web page** | unauthenticated GET of a public URL | available, **rate-limited + robots/ToS-respecting** | reuse enrichment fetch (§5.2) |
| **User-imported contact list** | local file import the user provides | available | none (local file parse) |
| Third-party account scraping / login-walled harvesting | — | **permanently disallowed (not modelled as a source)** | — |

The policy is expressed as a new value object (e.g.
`ContactResearchSourcePolicy`) that reuses the guardrails already in
`workers/automation/src/jobhunter/domain/discovery/source_registry.py`:

- `SourcePolicy.third_party_control_bypass` is hard-locked to `False`
  (source_registry.py raises `"SourcePolicy.third_party_control_bypass must
  remain false"`); the contact-research policy inherits that stance and never
  sets an authenticated `SourceAuthenticationMode` other than `none`.
- `LocatorPolicy.domain_allowlist` and `allow_autonomous_broad_discovery=False`
  are the template for "only fetch a source the user or the policy explicitly
  allows; never autonomously crawl the web."
- The fail-closed env-allowlist idiom in
  `workers/automation/src/jobhunter/infrastructure/compensation/sqlite_market_repository.py`
  (`_load_configured_provider_observations`: return nothing unless an access mode
  is explicitly permitted) and its TS summary in
  `apps/api/src/compensation-source-policy.ts` (`CompensationSourceAccessMode`
  union; sources report `availability`, `disabledReason`, `configured`) are the
  template for how the contact-research source registry is *displayed and
  enforced*: default unavailable, enabled only when the user opts in per source,
  with a stated reason when disabled.

The **login-walled boundary must not be crossed.** The existing authenticated
apply-URL resolver
(`workers/automation/src/jobhunter/infrastructure/enrichment/linkedin_apply_resolver.py`,
gated by `JOBHUNTER_LINKEDIN_APPLY_RESOLVER`) is the marker of the line: no
contact-research source may use an authenticated session, a stored login, or any
paywalled/bot-protected endpoint. The existing `ManualActionReason`
(`captcha | login_required | paywall | bot_detection | ...`) and
`_looks_protected`
(`workers/automation/src/jobhunter/infrastructure/discovery/production_wiring.py`)
classification routes protected URLs to a **manual-capture** path
(`ManualCaptureMode`: `copied_url | pasted_text | saved_html | ...`) instead of
auto-fetching — the correct fallback for contact research too.

### 5.2 Reusing enrichment fetch infrastructure

Public-page fetch reuses the enrichment machinery rather than adding a new HTTP
stack:

- `DetailPageFetcherPort` / `PlaywrightDetailPageFetcher`
  (`workers/automation/src/jobhunter/infrastructure/enrichment/playwright_fetcher.py`)
  for rendered pages, or the lightweight stdlib `default_http_fetcher`
  (`workers/automation/src/jobhunter/infrastructure/discovery/ats_adapters.py`,
  UA `JobHunter/1.0 (+https://github.com/ebarti/JobHunter)`) for static pages.
- `ContentAcquisitionService.acquire(url, source_id, ...)`
  (`workers/automation/src/jobhunter/domain/enrichment/snapshot_services.py`)
  as the reusable fetch+extract entrypoint; the `DetailPage` value object
  (`workers/automation/src/jobhunter/domain/enrichment/value_objects.py`) as the fetch output.
- LLM-assisted extraction via `LlmPort.chat_json(response_schema=...)`
  (`workers/automation/src/jobhunter/domain/ports/llm.py`) — prefer the **schema-driven** path (the enrichment
  Tier-3 extractor currently uses free-text `chat()` + `extract_json`; a new
  capability should use structured `chat_json`).

### 5.3 Politeness substrate (hard dependency, delivered by a separate plan)

Verified: there is **no robots.txt handling, no ToS/politeness logic, and no
per-host rate limiting** anywhere in the repository (only fixed per-site sleeps
in the legacy `workers/automation/src/jobhunter/enrichment/detail.py`
`SITE_DELAYS`). That gap affects every existing fetch surface, not just this
workstream, so it is **not built here**. It is delivered by the crawl
politeness hardening plan (`docs/plans/implemented/2026-07-05-crawl-politeness-plan.md`,
PR #272): a shared politeness gateway — robots.txt respect, per-host rate
limiting and concurrency caps, per-run request budgets, honest user-agent —
that all outbound fetching routes through, enforcing the declarative
`SourcePolicy` knobs (`max_pages_per_run`, `max_run_frequency`,
`locator_max_requests_per_domain`) that are declared but unenforced today.

**Dependency rule:** no contact-research fetch (Phase 2) may be implemented or
enabled before that plan's politeness gateway is merged and the enrichment
fetch path used here routes through it. Because INV-3 requires respecting
platform terms, this dependency is a hard gate, not a recommendation.

### 5.4 Spend discipline (reuse, do not duplicate)

Research runs use the LLM and must go through the **existing** spend preflight:
`check_spend_budget` Temporal activity raising non-retryable `BudgetExceededError`
(`workers/automation/src/jobhunter/llm.py`), config key `dailyBudgetUsd`
(default 25, `0` = unlimited). Do **not** create a second spend table or preflight
(the OSS spec §W2.4 states this explicitly). Reuse `record_llm_spend`.

---

## 6. Provenance model (INV-2)

Every stored contact fact and every research proposal carries a
`ContactFactProvenance` value object modelled on `AchievementEvidence`
(`workers/automation/src/jobhunter/domain/profile/value_objects.py`, fields
`source_text`, `evidence_strength ∈ {verified,supported,inferred,draft}`,
`claim_confidence`, `user_confirmed`):

- `sourceKind` — `user_entered | public_web_page | user_imported_list | derived`.
- `sourceRef` — the URL fetched, the import filename, or the user note id (safe
  reference, not raw dumped content).
- `captureMethod` — e.g. `manual`, `json_ld`, `css_selectors`, `llm_assisted`
  (reuse `ExtractionTier` vocabulary from `workers/automation/src/jobhunter/domain/enrichment/value_objects.py`).
- `capturedAt`, `confidence`, `userConfirmed`.

Provenance is **persisted at the owning layer** (the `Contact` /
`ContactResearchTask` aggregates), **projected** into the read model, and
**rendered** in the UI (contact detail, candidate review). Per the CLAUDE.md
root-cause discipline: a displayed fact with no source of truth is a defect — the
fix is to compute/persist provenance, never to hide the field. Raw fetched page
bodies are treated like raw email bodies in the apply-feedback design: **never**
copied into `job_events.payload_json`, projections, logs, or telemetry — only
safe references and extracted fields are stored
(`docs/architecture/read-model.md`).

---

## 7. Truthfulness discipline for outreach drafts (INV-5)

Outreach drafts are claims-bearing generated documents, so they reuse the
Materials gate stack. The **cover-letter path is the precedent**: it already
reuses the resume gates verbatim over first-person prose
(`scan_cover_letter` in
`workers/automation/src/jobhunter/domain/materials/fabrication_detector.py`
reuses `scan_resume_bullets` + `scan_prose_skill_fabrications`).

Gates to reuse, in order:

1. **Deterministic never-fabricate detector** —
   `workers/automation/src/jobhunter/domain/materials/fabrication_detector.py`
   (`build_evidence_corpus`, `scan_cover_letter` / `scan_prose_skill_fabrications`,
   `FabricationError`): a draft may reference only facts grounded in the
   confirmed contact record, the profile, and the application — no invented
   names, titles, employers, dates, metrics, or claimed relationships.
2. **`ContentValidator`** — `workers/automation/src/jobhunter/domain/materials/services.py` (`ContentValidator`,
   `BANNED_WORDS`, `LLM_LEAK_PHRASES`): banned/stock-phrase and
   model-self-talk rejection; structural checks (salutation, sign-off, length).
3. **LLM-as-judge** — the judge pattern in `workers/automation/src/jobhunter/domain/materials/use_cases.py`
   (`TAILORING_JUDGE_RESPONSE_SCHEMA`, `build_judge_prompt`, criteria including
   `fabrication_safety`, `evidence_support`): an outreach-specific rubric that
   FAILs any unsupported claim or fabricated relationship.
4. **Provenance/coverage record** — model on `BulletProvenance`
   (`workers/automation/src/jobhunter/domain/materials/provenance.py`): each claim in a draft binds to the
   confirmed fact it rests on, computed against the **actual draft text** (never
   inferred from the target), reusing the `coverage_audit.py`
   "computed against rendered text" discipline.
5. **Lifecycle & versioning** — `ArtifactStatus`
   (`candidate | approved | rejected | superseded`) and generation versioning so
   a re-draft supersedes but does not destroy the last approved draft until the
   replacement is approved (INV-5).

The draft generation LLM path should use the SDK-ensemble seam where a
higher-quality synthesis is warranted (`workers/automation/src/jobhunter/infrastructure/analysis/ensemble.py`,
`AnalysisDraftPort`/`AnalysisSynthesizerPort`, per the 2026-06-09 ADR in
`docs/decisions.md`); simple drafts may use `LlmPort` directly.

Drafts are **editable**: the user can edit an approved draft; edits create a new
generation with its own provenance and re-run the gates, exactly as Apply Review
resume edits create a validated replacement generation
(`docs/architecture/read-model.md`).

---

## 8. No-auto-send (INV-1) — the headline invariant

### 8.1 Product model: system drafts and logs; the user sends

There is **no send capability in scope**. Confirmed baseline: the repository has
**zero** send paths today (Gmail is read-only — `GMAIL_READONLY_SCOPE`, client
methods are `search_emails`/`read_email`/`search_feedback_emails` only; repo-wide
search for `gmail.send`/`messages.send`/`smtplib` returns nothing). This plan
**does not add one.**

The outreach flow terminates one step before any send:

```text
generate draft -> gates -> user reviews/edits -> user approves
  -> user copies the approved draft (ClipboardPort) / exports it
  -> USER sends via their own channel (their email client, etc.)
  -> user records "I sent this on <date> via <channel>"  (OutreachSendLogged)
```

Copy/export uses the existing browser `ClipboardPort`
(`apps/web/src/shared/ports/ClipboardPort.ts`) — a user-initiated clipboard
write, not an automated network send. Logging a send is a **user action**
(`LogOutreachSendUseCase`) that writes a `OutreachSendLog` and emits
`OutreachSendLogged`.

### 8.2 Relationship to the adjacent owned-send capability (explicit non-overlap)

The OSS remediation spec §W1.7 plans a *separate* "controlled owned send" for
**email-only job applications** (agent detects → owned template composes → human
approves → owned code sends via a future `gmail.send` scope). **This plan is
deliberately stricter and does not build on, enable, or parallel W1.7:**

- Outreach adds **no** send adapter, **no** `gmail.send` scope, **no** transport
  of any kind.
- It reuses W1.7's *shape up to the send step* — detect/compose an **owned**
  draft (agent prose is gated, never trusted), persist a reviewable candidate,
  bind approval to exactly what was reviewed — but the terminal state is a
  **drafted + previewed + user-logged** message, never an API call.

### 8.3 Enforcement + regression fixtures

Four layers, each with a synthetic regression fixture (patterns lifted from the
apply-safety suite):

1. **Aggregate invariant.** `OutreachThread` cannot represent a "sent" state
   without a user-attested `OutreachSendLog`. Fixture: constructing/transitioning
   a thread into "sent" without an `OutreachSendLog` raises — mirrors
   `workers/automation/tests/test_apply_run_aggregate.py` asserting the
   `ApplyRun` dry-run invariant.
2. **No-send-transport grep test.** A test asserting no send symbol
   (`smtp`, `messages.send`, `gmail.send`, `sendMail`, `nodemailer`, …) exists
   anywhere in the contact/outreach code — mirrors the W1.7 DoD grep guard.
3. **Adapter-never-called test.** If any transport-shaped seam is introduced by
   accident, a test mocks it and asserts it is never invoked on any outreach path
   — mirrors `workers/automation/tests/test_apply_chrome_dry_run_guard.py`
   (`assert posts == []`).
4. **Gate test.** "Approve draft" and "log send" are distinct user actions;
   approving a draft performs no outbound action and does not mark the thread
   sent — mirrors `test_apply_approval_gate_blocks_live_without_approval`
   (approval records a fact; it does not act).

The regression matrix entry (mirroring the existing
"Apply review queue or outcome tracking starts apply automation" row in
`docs/local-reliability-qa.md`) reads: *"Outreach drafting/logging starts an
automated send, exposes a send transport, or marks a thread sent without a
user-attested send log."*

---

## 9. Follow-up scheduling tied to the application lifecycle

- **Owner:** the **Contact & Outreach** context owns the outreach follow-up
  schedule (`FollowUpSchedule` on `OutreachThread`). It does **not** own the
  application lifecycle — it **reacts** to it.
- **Trigger inputs:** apply/outcome lifecycle facts already in the read model —
  `ApplicationSubmitted` and the reviewed outcomes in `application_outcomes`
  (`docs/architecture/read-model.md`). When an application is submitted or an
  outcome changes, the thread computes a suggested next follow-up date.
- **Surfacing:** a **due follow-ups** read model (a projected list of threads
  whose follow-up date has arrived) shown in the UI (a Follow-ups view/panel and
  a badge). `FollowUpDue` is a **derived, read-model** signal (a projected
  computation over the schedule + clock), not an action — consistent with the
  outcome-conversion read model being read-only.
- **Automation posture:** **default-off.** By analogy to discovery scheduling
  (`scheduling_enabled` defaults `false`, `docs/architecture/domain-model` /
  README), any optional recurring reminder is disabled by default and, even when
  enabled, only *surfaces* due items — it never sends.

---

## 10. Read model / projections

Add Contact & Outreach projections following the dual-runtime pattern
(`docs/architecture/read-model.md`; Python `ProjectionBuilder` +
`apps/api/src/projections.ts` both write the same tables and share the
`operations_projections` watermark):

- **New projection dataclasses** in
  `workers/automation/src/jobhunter/domain/operations/projections.py`
  (e.g. `ContactProjection`, `ContactResearchTaskProjection`,
  `OutreachThreadProjection`, `DueFollowUpProjection`).
- **New projection tables** registered in `PROJECTION_TABLES` +
  `ensure_projection_tables` + `upsert_/fetch_` on `SqliteProjectionStore`
  (`workers/automation/src/jobhunter/infrastructure/projections/sqlite_projection_store.py`),
  with a `_rebuild_*` branch in `ProjectionBuilder._refresh_impl`
  (`workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`)
  gated on the new event-type set. Mirror **all** of
  it in `apps/api/src/projections.ts` (`ensureProjectionTables`,
  `refreshProjections`) and add read queries in `apps/api/src/read-model.ts`
  (read-repair then SELECT). A cross-runtime parity fixture + test
  (`test_audit_projection_parity.py` / `apps/api/test/audit-projection-parity.test.ts`
  pattern) guards drift.
- **Canonical tables** (write side) via a new `ensure_contact_tables(conn)` in
  `workers/automation/src/jobhunter/database.py` (in-code `CREATE TABLE IF NOT
  EXISTS` + `PRAGMA table_info` forward-migration; no migrations directory). Bump
  `SCHEMA_VERSION` (database.py) and `SUPPORTED_SCHEMA_VERSION` (`apps/api/src/db.ts`)
  together.

### 10.1 Event-log & SSE wiring (design decision, see §16)

`job_events` is the only durable stream feeding SSE (`GET /v1/events/stream`,
`apps/api/src/event-stream.ts`) and the projection watermark scan, and it is
keyed by `job_url` (nullable). For outreach events to appear via SSE and survive
a cold restart's watermark replay, they must be written to `job_events` through
`record_job_event` (`workers/automation/src/jobhunter/state.py:654`) — a typed
`publisher.publish(...)` alone only triggers in-process live refresh and is
invisible to SSE/replay. Contact/outreach events that concern a specific
application key naturally on that job's `job_url` (and surface in the job's audit
history); contact-only events without an application need an entity key — see the
open decision in §16.

### 10.2 Contracts (DTOs + RPC)

- DTOs + zod query schemas in `packages/contracts/src/schemas.ts`
  (`ContactSummary`, `ContactDetail`, `OutreachThreadSummary`,
  `DueFollowUpSummary`, …), exported through `packages/contracts/src/index.ts`
  and consumed by `apps/api`.
- Branded ids in `packages/domain-types/src/identifiers.ts` following the
  `JobId` idiom (`ContactId`, `ResearchTaskId`, `OutreachThreadId` with
  `create*`/`generate*`).
- Worker write commands (research, draft generation) added to `RpcMethods`
  (`packages/contracts/src/rpc.ts`) with params/result schemas, mirrored in
  Python `register_default_handlers`
  (`workers/automation/src/jobhunter/infrastructure/rpc/handlers.py`).

---

## 11. UI surfaces

A new frontend bounded context `apps/web/src/contexts/outreach/`, modelled on the
richest existing context, `apps/web/src/contexts/profile/` (it owns reads, forms, a Zustand persist
store, mutations, and handlers — the exact surface outreach needs). Follow
`docs/architecture/frontend/` and the `CLAUDE.md` frontend conventions:

- **Query keys:** `outreachKeys` with the full hierarchical shape (copy
  `apps/web/src/contexts/operations/jobsKeys.ts`), re-exported through
  `apps/web/src/contexts/operations/queryKeys.ts`.
- **Read hooks** in `contexts/outreach/hooks/` (`useContactsListQuery`,
  `useContactDetailQuery`, `useResearchTaskQuery`, `useOutreachThreadQuery`,
  `useDueFollowUpsQuery`) — `useTenantId()` + `usePorts()` + `useQuery`.
- **Mutation hooks** via `createOptimisticMutation`
  (`apps/web/src/shared/lib/createOptimisticMutation.ts`) **with real
  patchers + settle sets** (an empty patcher is a review/QA failure per
  `CLAUDE.md`): create/update/import contact, confirm candidate, generate/revise/
  approve draft, **log send**, schedule/complete follow-up.
- **Handlers:** `contexts/outreach/handlers.ts` registered in the invalidation
  router (§4.6).
- **Forms & store:** TanStack Form + Zod `safeParse` in `contexts/outreach/forms/`
  (contact create/edit, draft edit, send-log form); a Zustand `persist` store
  `contexts/outreach/stores/outreach-import-store.ts` (key `jh:outreach-import`)
  for the multi-step contact-list import wizard (mirror
  `apps/web/src/contexts/profile/stores/profile-import-store.ts`).
- **Ports:** new methods on `ApiClientPort`
  (`apps/web/src/shared/ports/ApiClientPort.ts`) + `FetchApiClientAdapter`.
  **Copy-to-send uses `ClipboardPort`** (no direct `navigator.clipboard`).
- **Views** (composers only — never call `useQuery`/`useMutation`/`apiClient`
  directly): `apps/web/src/views/outreach/` (`OutreachView` + table + `columns.tsx`
  + detail drawer), mounted at `apps/web/src/routes/outreach.tsx` (+
  `routes/-outreach.search.ts`). A **Contacts panel** and **due-follow-ups**
  affordance also compose into the job detail drawer
  (`apps/web/src/views/jobs/JobDetailDrawer.tsx`) since contacts attach to
  applications.
- **Audit rendering:** contact detail and candidate-review UI render provenance
  for every fact (INV-2); the draft review surface shows the gate results and the
  claim→fact bindings (INV-5), reusing the audit-panel patterns from Apply
  Review / materials.

---

## 12. Implementation phases (with gates)

Each phase is its own PR (stacked where it builds on a predecessor), in its own
worktree, `main`-clean, Conventional Commits. **A phase is not done until its
acceptance block (§13) is satisfied and the review + QA gates pass.**

### Phase 0 — Contracts, identifiers, events, schema
Branded ids, event modules in both registries + web handlers + fixtures (§4.6),
DTO/RPC schemas, `ensure_contact_tables` + schema-version bump, empty projection
tables wired in both runtimes. No behaviour yet.
**Gate:** parity tests green (`test_domain_event_parity.py`,
`every-event-has-handler.test.ts`, audit-projection-parity), `pnpm check`,
`pytest -q`.

### Phase 1 — Contact records (aggregate + CRUD + import + provenance)
`Contact` aggregate, repository (publisher-injected), CRUD + user-imported list
use cases, provenance on every attribute, projections + read APIs, contacts UI +
job-drawer panel.
**Gate:** provenance-present invariant test; import test; projection parity;
contacts render with sources.

### Phase 2 — Research (supervised enrichment with provenance)
`ContactResearchTask` aggregate + `ContactResearchWorkflow`, source-access policy
(§5) incl. robots/rate-limit/page-budget, allowed-source fetch via enrichment
infra, candidate proposals in `needs_review`, user-confirmation command, spend
preflight reuse.
**Gate:** disallowed-source-rejected test; candidate-requires-confirmation test;
provenance-on-every-candidate test; robots/rate-limit test; spend-preflight test.

### Phase 3 — Outreach drafts (truthful, reviewable, editable)
`OutreachThread` aggregate, draft generation through the materials gate stack
(§7), draft lifecycle + generation versioning, review/edit UI, copy/export via
`ClipboardPort`.
**Gate:** fabrication-rejected fixture; re-draft-preserves-last-approved fixture;
editable-draft-re-runs-gates test.

### Phase 4 — Send logging (no-auto-send) + follow-ups
User-attested `OutreachSendLogged`; the four no-auto-send enforcement layers
(§8.3); `FollowUpSchedule` derived from application lifecycle; due-follow-ups read
model + UI; automation default-off.
**Gate:** all four no-auto-send fixtures; follow-up-derivation test;
default-off test.

### Phase 5 — Product QA, docs, regression matrix
Browser QA of the full path against seeded synthetic data; regression-matrix
entries added; docs updated (§15).
**Gate:** `qa` returns `Gate: PASS`; docs updated; regression rows added.

---

## 13. Per-phase acceptance template

Fill this block for every phase (this is the repo's acceptance shape):

- **Source of truth** — which canonical data backs each displayed value (user
  input, fetched public page + provenance, confirmed contact fact, generated
  draft text, user-attested send log, derived follow-up date). No displayed value
  without one.
- **Owning bounded context** — Contact & Outreach (with the specific aggregate),
  and which existing context supplies consumed facts (Discovery/Apply/Profile/
  Enrichment/Materials/Operations).
- **Projection / read model** — the projection table(s) + the read-model query,
  dual-written in Python and TS with a parity test.
- **UI surface** — the exact view/component/route and the job-drawer panel where
  relevant.
- **Approving user action** — the explicit user action that authorizes any state
  change (confirm candidate; approve draft; **log send**; schedule/complete
  follow-up). No background action authorizes an outbound effect.
- **Synthetic regression fixture proving the invariant** — including, at minimum,
  **(a) a no-auto-send fixture** (a thread cannot become "sent" without a
  user-attested send log; no send transport exists) and **(b) a fact-provenance
  fixture** (every stored/proposed fact carries inspectable provenance and the
  UI renders it). Fixtures use synthetic data only — no real people, emails, or
  page dumps.
- **Local QA path** — the exact seeded-workspace steps to exercise the product
  path (`pnpm qa:seed`, disposable `JOBHUNTER_DIR`, no worker-backed sends, no
  real fetches against real sites).

---

## 14. Verification (CLAUDE.md command matrix)

Run the commands for every surface touched; the full sweep before each PR
(mirrors `docs/local-reliability-qa.md` and OSS spec §0.3):

```bash
# Python worker
uv --project workers/automation run --extra dev pytest -q
uv --project workers/automation run --extra dev ruff check .
uv --project workers/automation run --extra dev python -m build workers/automation

# TypeScript API + QA harness
pnpm api:check && pnpm api:test
pnpm qa:test

# Web
pnpm web:check
pnpm --filter @jobhunter/web test
pnpm --filter @jobhunter/web test-d
pnpm --filter @jobhunter/web e2e   # for frontend-flow changes

# Full sweep + hygiene
pnpm check
pnpm test
git diff --check
```

Targeted tests this work must add/extend (by surface):

- Python: `test_contact_aggregate.py`, `test_contact_provenance.py`,
  `test_contact_research_workflow.py`, `test_contact_research_source_policy.py`,
  `test_outreach_thread_aggregate.py` (no-auto-send invariant),
  `test_outreach_draft_gates.py`, `test_outreach_no_send_transport.py` (grep
  guard), `test_domain_event_parity.py` (extended),
  `test_projection_builder.py` (extended).
- API: `apps/api/test/contacts.test.ts`, `apps/api/test/outreach.test.ts`,
  `apps/api/test/projections.test.ts` (extended),
  `apps/api/test/audit-projection-parity.test.ts` (extended).
- Web: hook success + rollback tests per query/mutation hook;
  `every-event-has-handler.test.ts` (new events); `invalidation-router.test.ts`;
  view tests for the outreach view + job-drawer contacts panel; `*.a11y.test.tsx`
  for forms/drawers; an e2e outreach flow spec.

---

## 15. Definition of Done

- [ ] All six product invariants (§1.1) hold and each has a passing synthetic
      regression fixture, including the no-auto-send fixture(s) and the
      fact-provenance fixture(s).
- [ ] Three aggregates implemented with per-aggregate repositories; new events in
      both registries + web handlers + fixtures; parity tests green.
- [ ] Research runs only against the conservative allowlist, respects
      robots/ToS + rate limits + page budget, is supervised (candidates require
      user confirmation), and reuses the existing spend preflight.
- [ ] Outreach drafts pass the reused materials gate stack, are editable, and a
      re-draft never destroys the last approved draft until a replacement is
      approved.
- [ ] Follow-ups derive from the application lifecycle and surface as due
      follow-ups; automation is default-off; nothing sends.
- [ ] Projections dual-written (Python + TS) with parity tests; read APIs +
      SSE wiring in place; schema version bumped on both sides.
- [ ] Frontend `outreach` context + view follow the conventions (query keys,
      optimistic mutations with real patchers, handlers, ports, forms/store,
      views-as-composers).
- [ ] Full verification matrix (§14) passes; `pr-reviewer` and `qa` gates return
      `Gate: PASS`.
- [ ] Docs updated (§15 table below).

### 15.1 Documentation updates <a id="15-documentation-updates"></a>

| Surface changed | Doc to update |
|---|---|
| New user capability, CLI commands, safety notes, generated local artifacts | `README.md`, `docs/user/data-and-safety.md`, `docs/user/normal-flows.md`, `docs/user/configuration.md` (source opt-in keys) |
| New bounded context, aggregates, events, ports, projections | `docs/architecture/domain-model/` (`strategic.md`, `tactical.md`, `ports.md`, `integration.md`, `persistence.md`) |
| Event → projection → SSE read model | `docs/architecture/read-model.md` |
| Frontend context, state layers, realtime | `docs/architecture/frontend/` (`contexts.md`, `structure.md`, `integration.md`) |
| QA regression rows (no-auto-send, provenance, research source policy) | `docs/local-reliability-qa.md` |
| A new architecture decision (new context; no-auto-send stance) | `docs/decisions.md` (new ADR) |
| Local API routes / web dev commands | `docs/local-ts-api.md` |
| This plan moved to `docs/plans/implemented/` with a status banner on delivery | `docs/plans/README.md` ledger row |

---

## 16. Open owner decisions (STOP and ask)

1. **New context vs. extend Apply.** This plan proposes a **new ninth bounded
   context** (Contact & Outreach). Confirm, or direct that contacts/outreach live
   inside Apply Automation. (Recommendation: new context — distinct vocabulary,
   lifecycle, and data.)

   **Resolved (2026-07-06, dispatch):** Take the plan's recommendation — a **new
   ninth bounded context "Contact & Outreach"** (not an Apply extension).
   Documentation consequence: every doc that currently states "eight bounded
   contexts" (`docs/architecture/index.md`, `docs/architecture/domain-model/`,
   `docs/architecture/frontend/`) MUST be updated to nine in the SAME PR that
   introduces the context, per the CLAUDE.md documentation table.
2. **`job_events` keying for contact-only events (§10.1).** `job_events` is keyed
   by `job_url`. Options: (a) reuse `job_url` to hold a contact entity key for
   contact-only events; (b) add a generic `entity_kind`/`entity_ref` column to
   the event log. Application-linked outreach events key naturally on the job.
   (Recommendation: (b) — a small, generic event-log extension keeps contact
   identity honest and reusable; confirm the schema-version bump.)

   **Resolved (2026-07-06, dispatch):** Take option **(b)** — extend the event log
   with generic `entity_kind` / `entity_ref` columns so contact-only events carry
   honest identity instead of overloading `job_url`. This requires a `job_events`
   schema `user_version` bump with forward-migration guard handling (in-code
   `PRAGMA table_info` add-column, no migrations directory), landed in Phase 0
   with the schema-version bump on both runtimes (`SCHEMA_VERSION` in
   `database.py`, `SUPPORTED_SCHEMA_VERSION` in `apps/api/src/db.ts`).
   Application-linked outreach events still key naturally on the job's `job_url`.
3. **Which public sources are enabled by default (§5).** Recommendation: **none
   auto-fetched**; the user opts in per source (company careers page, a
   user-supplied URL), and protected/login-walled URLs always route to
   manual-capture. Confirm the conservative default.

   **Resolved (2026-07-06, dispatch):** Take the plan's recommendation — **no
   public sources are auto-fetched by default.** Each source (e.g. a company
   careers page, a user-supplied URL) is enabled only by explicit per-source user
   opt-in (mirroring the compensation-source `availability` / `disabledReason` /
   `configured` display idiom). Any login-walled, paywalled, or bot-protected URL
   ALWAYS routes to the manual-capture path (`ManualCaptureMode`) and is never
   auto-fetched. All permitted fetching routes through the merged politeness
   gateway (§5.3), never a new fetch path.
4. **Contact-list import format.** Which local formats to accept for
   user-imported lists (e.g. CSV/vCard). Confirm the minimal set; keep it local
   and provenance-tagged.

   **Resolved (2026-07-06, dispatch):** **CSV only** in this scope — local file
   parse, every imported fact provenance-tagged with `sourceKind =
   user_imported_list`, `sourceRef` = the import filename, `captureMethod =
   manual`. vCard import is deferred and recorded as a backlog note in
   `docs/backlog.md` (not implemented here).
5. **Follow-up cadence defaults.** The default suggested follow-up interval(s)
   after submission / after a recruiter reply. Recommendation: conservative
   defaults, fully user-editable, surfaced-only (never auto-acted).

   **Resolved (2026-07-06, dispatch):** §9 states the posture (conservative,
   user-editable, surfaced-only) but no numeric values, so we choose conservative
   defaults: **7 calendar days after `ApplicationSubmitted`** for the first
   suggested follow-up, and **14 calendar days** for any subsequent nudge if the
   thread has no logged reply. These are suggestions only — surfaced as **due
   follow-ups** (a derived read-model signal over schedule + clock), **never
   auto-acted and never sent** (INV-1). Every value is fully user-editable per
   thread, and any optional recurring reminder is **default-off** (mirroring
   discovery `scheduling_enabled = false`).

---

## 17. Non-goals

- **No sending of any kind.** No email/SMTP/DM/API send; no `gmail.send` scope;
  no scheduled/auto send. (This plan is stricter than OSS spec §W1.7 and does not
  implement, enable, or depend on it.)
- **No third-party account scraping or login-walled harvesting.** No
  authenticated-session data collection; the existing authenticated resolver is
  not a contact-research source.
- **No relationship inference from external network graphs.** Warm intros come
  only from user-provided relationship data.
- **No new LLM spend system.** Reuse `check_spend_budget` / `dailyBudgetUsd`.
- **No changes to apply eligibility, scoring, ranking, or thresholds.** Contact
  and outreach data are advisory read models; they never feed apply dispatch or
  scoring (consistent with the read-only outcome-conversion rule).
- **No hosted/multi-tenant build-out.** Local-first, tenant-scoped like every
  other context; cloud seams named-not-built.

---

## 18. Risks

| Risk | Mitigation |
|---|---|
| A future refactor introduces a send path and quietly breaks INV-1. | Aggregate invariant + no-send-transport grep test + adapter-never-called test + regression-matrix row (§8.3). |
| Politeness gap (no robots/rate-limit today) leads to disrespectful fetching. | Phase 2 is hard-gated on the crawl politeness plan (`docs/plans/implemented/2026-07-05-crawl-politeness-plan.md`, PR #272) being merged and the enrichment fetch path routing through its gateway (§5.3); this plan builds no fetching before that. |
| Provenance omitted under time pressure, reproducing the "displayed value with no source" defect class. | INV-2 aggregate guard (no attribute without provenance) + projection + UI rendering + fixture; CLAUDE.md root-cause discipline. |
| Registry/parity drift (event added on one side only). | Same-PR dual-registry rule (§4.6) + compile-time exhaustiveness + parity tests. |
| Sensitive contact data (names, emails, page bodies) leaking into events/logs/telemetry. | Store only safe references + extracted fields; never raw bodies in `job_events`/projections/logs (mirrors the apply-feedback rule); treat as sensitive per CLAUDE.md. |
| Research produces low-quality/incorrect candidates. | Supervised model (INV-4): candidates are proposals in `needs_review`; the user confirms before anything becomes a stored fact; confidence + provenance shown. |
| Scope creep into an "assistant that sends for you." | Non-goals (§17) + owner decisions (§16) + the no-auto-send invariant as the product's stated stance. |

## Delivery Model: Stacked PRs On This Plan

Implement this plan as a series of stacked PRs that begin on this plan's
branch:

- The first implementation PR uses this plan PR's branch as its base; each
  subsequent PR stacks on the previous one. One reviewable concern per PR;
  Conventional Commit titles.
- As a parent merges, retarget the next PR to `main` before merging it
  (retarget-before-merge; never merge a PR whose base branch is already
  merged and deleted).
- If this plan PR has already merged to `main`, start the stack from `main`
  instead — the instruction is "stack on the plan", not "recreate it".
- Each PR states which plan phase it delivers and runs that phase's
  verification commands from this plan before requesting review.
- Do not begin implementation while this plan's stated gates or
  dependencies are unmet.
