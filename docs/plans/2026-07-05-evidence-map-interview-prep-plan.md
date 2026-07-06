# Career Evidence Map + Interview Preparation Implementation Plan

> **Status:** Proposed — not yet implemented. This document specifies two coupled
> capabilities delivered as gated phases (the evidence map lands first; it feeds
> preparation). It is a design/architecture plan, not a line-by-line script:
> implementers are capable agents at high reasoning effort. Specify objectives,
> invariants, contracts, acceptance criteria, and verification — then build.
>
> **Anchors verified against main @ `a488e4e9853dde292badc74a88c7de24160edc52`.**
> Every path, symbol, and table cited below was confirmed to exist at that ref.
> Line numbers, where given, are hints captured 2026-07-05 and WILL drift —
> locate anchors **by symbol name** (grep/ripgrep). If a named symbol does not
> exist at implementation time, STOP and report; do not invent a lookalike.
>
> **For agentic workers:** implement phase-by-phase in the gate order of
> §"Phase Gates". Do not open a prep phase before its evidence-map gate has
> merged to `main`. Rip-and-replace is the standing rule (single-user product,
> per repo convention) — but this is additive work; do not remove existing
> capability unless a phase explicitly says so.

## Goal

Give the candidate one honest, inspectable inventory of their own evidence, and
turn that same grounded evidence into interview preparation — never fabrication,
never live assistance.

Two coupled capabilities, one plan:

1. **Career Evidence Map** — a user-facing inventory of profile evidence
   (skills, proof points, per-bullet provenance, requirement-fit history across
   jobs, gaps, reusable achievement stories, evidence freshness) that is
   grounded in canonical data and feeds scoring/tailoring **visibly**: from any
   map entry the user can inspect *where that evidence was used* — which resumes,
   which fit reports — as inspectable links, not vibes.

2. **Interview Preparation** — likely interview themes, STAR-story drafts, gap
   drills, and company-specific preparation for one application, generated
   **only** from the system's own grounded data (profile evidence + accepted
   materials + employer analysis + requirement fit), plus post-interview
   reflection notes attached to the application record.

### Product invariants

The evidence-map invariant (every displayed map claim is traceable end to end):

```text
profile evidence (proof point / skill)
  -> where it was used   (which resume artifact + which bullet)
  -> which requirement    (which job fit report + fit kind)
  -> freshness            (evidence date + confirmation + last-used)
  -> gap                  (requirement demanded, evidence missing/weak)
```

The preparation invariant (every generated prep claim is grounded and gated):

```text
job + employer analysis + requirement fit + accepted materials + profile evidence
  -> interview theme / STAR draft / gap drill / company note
  -> provenance (evidence_ids + requirement_ids the claim derives from)
  -> same truthfulness/fabrication gates as other generated material
  -> generation-versioned, inspectable, never destroys the last accepted prep
```

### The hard ethical boundary (encoded as a product invariant)

**Preparation BEFORE and reflection AFTER interviews only.** There is no live,
in-interview, or real-time assistance of any kind anywhere in this feature — no
capability that listens to, transcribes, streams into, or participates in a live
interview.

```text
allowed:  generate prep artifact (one-shot, stored)      [before]
allowed:  record reflection note on an interview outcome [after]
forbidden: any live/streaming/in-session interview input, transcription,
           real-time answer suggestion, or agent participation in an interview
```

This invariant is enforced by construction (no streaming-input surface is
built), asserted by a dedicated regression test (§"Cross-Cutting Regression
Fixtures"), and stated in user-facing docs.

## Current State (grounded)

### What already exists and is reused

**Canonical evidence (source of truth for the map).**
- Profile achievement evidence — the reusable "proof point" / STAR raw material.
  Domain: `AchievementEvidence` (`workers/automation/src/jobhunter/domain/profile/value_objects.py`),
  carrying `id, source_text, scope, action, tools, metrics, outcome,
  seniority_signal, evidence_strength, claim_confidence, user_confirmed, tags`.
  Persisted in `candidate_profile_achievement_evidence`
  (`workers/automation/src/jobhunter/database.py`, `ensure_profile_tables`).
  `evidence_strength` enum: `verified | supported | inferred | draft`.
- Skills — `candidate_profile_skill_categories` / `candidate_profile_skill_items`.
- Experience (with dates for freshness) — `candidate_profile_experience_entries`
  / `_bullets`.
- Published, immutable copy for consumers — `ProfileSnapshot`
  (`workers/automation/src/jobhunter/domain/profile/snapshot.py`).
- Profile is served **live** from `candidate_profiles` (+ children) by
  `apps/api/src/profile-store.ts` (`readProfileConfig`), route `GET /v1/profile`
  (`apps/api/src/server.ts`). It is the **one read surface not on the projection
  pipeline** and has no cross-runtime parity test.

**Per-bullet provenance (where evidence was used).**
- Domain: `BulletProvenance` / `BulletProvenanceSet`
  (`workers/automation/src/jobhunter/domain/materials/provenance.py`), built by
  `provenance_builder.py`. Each row binds a rendered line to `evidence_ids`
  (FK into profile evidence), `requirement_ids` (FK into `EmployerAnalysis`),
  `matched_keywords`, `transform_type`, `control`, `generated_text`.
- Persisted in `job_bullet_provenance` (`database.py`,
  `ensure_bullet_provenance_tables`), generation-versioned, `artifact_id`-bound.
- Read: `artifact_list_projections.bullet_provenance_json`; DTO
  `BulletProvenanceEntry` (`packages/contracts/src/schemas.ts`); served by
  `apps/api/src/read-model.ts` (`bulletProvenanceForArtifact`), with profile
  source text joined in (`attachProfileSourceTextToBulletProvenance`).

**Requirement-fit history (which requirement, across jobs).**
- Domain: `RequirementFitReport`, `RequirementFitAssessment`,
  `RequirementFitStatus` (with `evidence_ids`), `RequirementArtifactCoverage`
  (states `covered | missing_from_resume | missing_from_profile | not_covered |
  not_recorded`) — `workers/automation/src/jobhunter/domain/scoring/value_objects.py`;
  resolver `requirement_fit.py`.
- Persisted in `job_requirement_fit_reports` + `job_requirement_fit_items`
  (`fit_json`, `contribution_json`, `tailoring_json`, `artifact_coverage_json`)
  — `database.py`, `ensure_requirement_fit_tables`.
- Read: `job_detail_projections.requirement_fit_report_json`; DTO
  `RequirementFitReport` (`schemas.ts`); `JobDetail.requirementFitReport`.

**Employer analysis + coverage (per posting).**
- `job_employer_analysis` (+ `_sub_analyses`, `_failures`) — `database.py`,
  `ensure_employer_analysis_tables`; domain `EmployerAnalysis` / `JobAnalysis`
  (`domain/materials/analysis.py`). Read via
  `job_detail_projections.employer_analysis_json`, DTO `EmployerAnalysis`.
- Coverage/voice audit: `coverage_audit.py`, `voice.py` →
  `artifact_list_projections.coverage_audit_json` / `voice_pass_json`; DTOs
  `BulletCoverageAudit`, `VoicePassAudit`.
- There is **no company-level analysis** — employer analysis is strictly
  per-posting (`job_employer_analysis` PK `(job_url, generation)`). A
  cross-posting company profile is greenfield (see Non-Goals).

**Truthfulness / fabrication gates (reused verbatim for prep).**
- `workers/automation/src/jobhunter/domain/materials/fabrication_detector.py`:
  `scan_resume_bullets` (never-fabricate numeric/date/title/employer),
  `scan_prose_skill_fabrications` (named-technology allowlist, word-form
  tolerant), `scan_cover_letter`, `build_skill_vocabulary`,
  `build_skill_evidence_corpus`.
- `claim_grounding.py` (binds coverage-bearing claims to shipped text).
- Structured judge + adversarial personas — note one persona is already
  `interview_defensibility_critic` (`domain/materials/adversarial.py`), i.e. the
  resume is already challenged for interview defensibility.
- Focused tests: `workers/automation/tests/test_materials_use_cases.py`,
  `test_materials_quality.py`.

**Application lifecycle (interview outcomes already exist).**
- `APPLICATION_OUTCOME_KINDS` includes `"interview"`
  (`packages/contracts/src/schemas.ts`); `ManualApplicationOutcomeRequestSchema`
  and `ApplicationOutcome` already carry a `note` (max 4000).
- Persisted in API-owned SQLite: `application_outcomes`, `application_review_decisions`,
  `application_email_evidence`, `application_outcome_suggestions`
  (`apps/api/src/application-feedback.ts`); routes `GET/POST
  /v1/jobs/:jobKey/outcomes` (`apps/api/src/server.ts`); UI
  `apps/web/src/contexts/apply/components/ApplicationOutcomes.tsx`
  (`ManualOutcomeForm`, `OutcomeTimeline`).
- The Python `ApplyRun` aggregate terminates at submission and holds **no**
  outcome/interview/notes state; outcomes are append-only facts read back by the
  launcher — the established pattern for feeding the lifecycle.

**Orchestration + read/realtime substrate.**
- Temporal workflows: `JobPipelineWorkflow`, `JobPreparationWorkflow`,
  `ApplyWorkflow`, `ProfileImportWorkflow`, `DiscoverWorkflow`,
  `CompensationRefreshWorkflow`.
- JSON-RPC handlers registered in
  `workers/automation/src/jobhunter/infrastructure/rpc/handlers.py`
  (`register_default_handlers`): `analyze_job` (sync), `tailor_job`,
  `retailor_job`, `rescore_job`, `run_stage`, `apply` (workflow). TS→Python
  bridge: `apps/api/src/json-rpc-adapter.ts` (`SubprocessJsonRpcAdapter`);
  contract `packages/contracts/src/rpc.ts` (`RpcMethods`).
- Preparation work-item kinds: `PreparationWorkItemKind`
  (`score_job | tailor_resume | suppress_tailored_artifacts`) —
  `domain/preparation/work_items.py`; execution runs via `JobPreparationWorkflow`.
- Projections (dual-builder, parity-tested): Python `ProjectionBuilder`
  (`infrastructure/projections/projection_builder.py`) + TS `refreshProjections`
  (`apps/api/src/projections.ts`), schema in
  `infrastructure/projections/sqlite_projection_store.py` (`PROJECTION_TABLES`).
  Watermark `event_watermarks.operations_projections`.
- Events: `DOMAIN_EVENT_TYPES`
  (`workers/automation/src/jobhunter/domain/events/__init__.py`) mirrored by
  `packages/domain-types/src/events/index.ts`; SSE `GET /v1/events/stream`
  (`apps/api/src/event-stream.ts`); frontend invalidation router
  (`apps/web/src/contexts/operations/invalidation-router.ts`). Every event type
  must have a handler (`apps/web/src/contexts/operations/every-event-has-handler.test.ts`).

### What is missing (the work)

- **No cross-job evidence index.** Provenance and requirement-fit are stored
  per-artifact / per-job. Nothing inverts them into "for evidence X, here is
  everywhere it was used and every requirement it covered." The map needs this
  inverted read model.
- **No evidence-map read surface or UI.** Profile UI edits evidence; nothing
  shows usage, freshness, gaps, or reusable stories with inspectable links.
- **No interview-preparation capability at all.** Greenfield: verified that no
  `interview_prep`, `star_story`, `gap_drill`, or live-assist symbol exists in
  the worker, apps, or packages.
- **No post-interview reflection surface** beyond the generic `interview`
  outcome note; reflections are not connected to the prep artifact they follow.

## Ubiquitous Language

**Evidence Proof Point** (Value Object)
- Definition: One reusable achievement (situation/scope, action, outcome,
  metrics, tools) from the candidate's own history.
- Source of truth: `AchievementEvidence` in the Profile aggregate
  (`candidate_profile_achievement_evidence`).
- Invariants: Has a stable `evidence_id`; carries an `evidence_strength` and
  `user_confirmed` flag; is the only permitted basis for a STAR draft.

**Evidence Usage** (Read-Model Value Object)
- Definition: One recorded use of a proof point (or skill) in a generated
  artifact or a requirement assessment.
- Source of truth: `job_bullet_provenance.evidence_ids` (resume use) and
  `job_requirement_fit_items.fit_json.evidence_ids` /
  `artifact_coverage_json` (requirement use).
- Invariants: Every usage resolves to a real job + artifact/score version; a
  usage is never inferred from the job description (it is a recorded fact).

**Career Evidence Map** (Aggregate Read Model)
- Definition: The complete per-evidence (and per-skill) inventory with usage
  back-references, requirement-fit history, freshness, and gap membership.
- Source of truth: Operations read side, computed from Profile evidence +
  provenance + requirement-fit facts. Owned as a read model; it defines no new
  canonical facts.
- Invariants: Every displayed usage link is navigable to the exact artifact or
  fit report; gaps are computed from recorded misses, never asserted blind.

**Evidence Gap** (Read-Model Value Object)
- Definition: A requirement demanded across the candidate's target jobs that no
  profile evidence covers, or covers only weakly/transferably.
- Source of truth: `RequirementFitStatus.kind ∈ {missing, blocked}` and
  transferable/low-contribution assessments across `job_requirement_fit_items`,
  plus `declared`/`missing` coverage buckets.
- Invariants: A gap is labelled as a gap, never rendered as a claim; it links to
  the jobs that demanded it.

**Interview Prep Item** (Entity)
- Definition: One generated preparation unit for one application —
  `kind ∈ {theme, star_draft, gap_drill, company_note}`.
- Source of truth: a new Interview Preparation aggregate, generation-versioned.
- Invariants: Carries `evidence_ids` / `requirement_ids` provenance FKs; passes
  the same fabrication/grounding gates as generated resume/cover material; a
  `gap_drill` never fabricates experience (it names the gap and truthful adjacent
  framing).

**Interview Prep Set** (Aggregate)
- Definition: All prep items for one `(tenant, job, generation)`, plus the gate
  audit that produced them.
- Source of truth: new canonical rows (never a `metadata_json` blob for audit
  data), mirroring `BulletProvenanceSet` / `EmployerAnalysis` versioning.
- Invariants: A failed/forced re-generate writes a higher generation and never
  destroys the last accepted prep. Has only *before* lifecycle states — no
  "live"/"in_session" state exists.

**Interview Reflection** (Value Object)
- Definition: A post-interview note the user records against an application.
- Source of truth: `application_outcomes` (`kind = "interview"`, `note`), the
  existing append-only outcome mechanism.
- Invariants: Append-only; raw note text stays in the outcome table and never
  enters `job_events.payload_json`, projections, logs, or telemetry (existing
  outcome sensitivity rule).

## Architecture Principles

- **Reuse, do not re-derive.** The map is a read model over existing canonical
  facts. Prep reuses the existing fabrication/grounding/judge gates verbatim
  (pure domain modules with no I/O) rather than re-implementing truthfulness.
- **One source of truth per displayed claim** (auditability discipline,
  `CLAUDE.md`). Before rendering any map/prep value, its source is one of:
  profile evidence, provenance row, requirement-fit item, employer analysis,
  coverage audit, generated prep item, or application outcome — cited explicitly.
- **Cross-runtime parity for anything projected.** Any new projection column or
  table is built identically by the Python builder and `apps/api/src/projections.ts`
  and covered by the parity fixture family (`apps/api/test/projections.test.ts`,
  `test_projection_builder.py`, `audit-projection-parity.test.ts` +
  `test_audit_projection_parity.py`, fixture
  `packages/domain-types/test/fixtures/audit_projection_parity.json`).
- **Safe exposure.** Follow the `apps/api/src/apply-audit.ts` pattern
  (presence/status facts, redaction helpers, never raw content) and the
  tailoring-audit rule (`docs/architecture/materials.md`): never expose raw
  prompts, full profile payloads, full job descriptions, local paths, PDFs,
  logs, browser data, or SQLite contents.
- **Frontend conventions** (`docs/architecture/frontend/*`): bounded-context
  folders mirror the backend; views compose context components and read only via
  Operations hooks; new events get handlers; parity tests are non-negotiable.
- **No spend during the pipeline.** Prep generation is user-initiated only; it
  never runs automatically inside discovery/enrichment/scoring/tailoring.

## Phase Gates

Evidence map first; it feeds preparation.

```text
Phase 0  Shared contracts + language + ADR        (gate: none)
Phase E1 Evidence usage index (read model)         (gate: Phase 0)
Phase E2 Career Evidence Map UI                    (gate: E1)
Phase P1 Interview prep generation (backend)       (gate: E1)   <- consumes the map's evidence read model
Phase P2 Interview prep read model + UI + boundary (gate: P1)
Phase P3 Post-interview reflection -> lifecycle    (gate: P2)
```

- E2 and P1 may proceed in parallel once E1 has merged; both depend only on E1.
- Each phase is one reviewable PR (stack when a phase builds on an unmerged
  predecessor). Do not combine phases.

Each phase below answers the repo acceptance template:
**Source of truth · Owning bounded context · Projection/read model · UI surface ·
Approving user action · Regression fixture (invariant) · Local QA path.**

---

## Phase 0 — Shared Contracts, Language, and ADR

**Objective.** Land the shared vocabulary and typed contracts both capabilities
depend on, with zero behavior change, so later phases add wiring, not re-design.

**Scope.**
- Add TypeScript contract types in `packages/contracts/src/schemas.ts` (and, if
  domain-typed events are needed, `packages/domain-types/src/`) for:
  `EvidenceMapEntry`, `EvidenceUsageRef`, `EvidenceGap`, `InterviewPrep`,
  `InterviewPrepItem`, `InterviewPrepItemKind`. Decide camelCase vs the
  employer-analysis snake_case pass-through convention and record the choice
  (recommend camelCase mapped in loaders, matching `RequirementFitReport`).
- Add matching Python value objects in the owning contexts (see later phases) as
  pure dataclasses with `to_read_model()`.
- Record two ADRs in `docs/decisions.md`: (1) Career Evidence Map as an
  Operations read model over existing facts; (2) Interview Preparation as a
  grounded, gated, generation-versioned material with a hard no-live-assistance
  boundary.

**Acceptance.**
- **Source of truth:** existing canonical tables (no new facts in this phase).
- **Owning bounded context:** Operations (read contracts) + docs.
- **Projection/read model:** contract types only; no projection yet.
- **UI surface:** none.
- **Approving user action:** none.
- **Regression fixture:** a type-level test (`apps/web/test/types/*.test-d.ts`)
  asserting the new contract types are exported and shaped as specified; a Python
  round-trip test for each new value object (`from_dict`/`to_read_model`).
- **Local QA path:** `pnpm api:check` + `pnpm web:check` + `pnpm --filter
  @jobhunter/web test-d` + `uv --project workers/automation run --extra dev
  pytest -q` all green with no runtime change.

---

## Phase E1 — Evidence Usage Index (Career Evidence Map read model)

**Objective.** Invert per-artifact provenance and per-job requirement-fit facts
into a per-evidence (and per-skill) usage index, join it with live profile
evidence, and serve a `GET /v1/evidence-map` read model whose every entry links
to where the evidence was used.

**Scope.**
- Build an evidence-usage read model that, for each `evidence_id`, aggregates:
  - resume usages: `(job_url, artifact_id, bullet_id, generation, generated_text
    preview)` from `job_bullet_provenance` (latest accepted generation per job).
  - requirement usages: `(job_url, score_version, requirement_id, fit.kind,
    artifact_coverage.state)` from `job_requirement_fit_items`.
  - freshness: experience `date_range` of the owning entry + `evidence_strength`
    + `user_confirmed` + `claim_confidence` + `last_used_at` (max provenance
    `created_at`).
  - reusable-story view: the `AchievementEvidence` scope/action/outcome/metrics.
- Skills index: for each skill item, its coverage history (`covered` / `declared`
  / `missing` buckets from `coverage_audit_json`) and the requirements it served.
- Gaps: requirements across the candidate's jobs with `fit.kind ∈
  {missing, blocked}` or transferable/low contribution, plus demanded skills that
  ground nowhere (the `missing` coverage bucket), each linking to demanding jobs.
- Persist the inverted index as a new Operations projection
  `evidence_usage_projections` rebuilt incrementally off
  `BulletProvenanceRecorded`, `JobScored`, `ResumeApproved`, `ProfileUpdated`,
  `ProfileImported` via the existing watermark. Add the table to
  `PROJECTION_TABLES`, build it in BOTH `projection_builder.py` and
  `apps/api/src/projections.ts`, and extend the parity fixture.
- Serve `GET /v1/evidence-map` (list) and, if needed,
  `GET /v1/evidence-map/:evidenceId` (detail) from `apps/api/src/read-model.ts`,
  joining the index with live profile evidence (`profile-store.ts`).

**Acceptance.**
- **Source of truth:** `candidate_profile_achievement_evidence` /
  `candidate_profile_skill_items` (identity + story text); `job_bullet_provenance`
  and `job_requirement_fit_items` (usage); `coverage_audit_json` (skill coverage
  buckets). No new facts are minted.
- **Owning bounded context:** Operations (read side), reading Profile + Materials
  + Scoring facts. Contexts are not coupled beyond the read model.
- **Projection/read model:** `evidence_usage_projections` (new, dual-builder,
  parity-tested) + `GET /v1/evidence-map` DTO `EvidenceMapEntry[]`.
- **UI surface:** none in this phase (API + projection only).
- **Approving user action:** none (read-only surface).
- **Regression fixture:** a synthetic fixture seeding one profile evidence used
  in two jobs (one resume bullet, one requirement fit) proving the map entry
  reports **both** usages with resolvable `(job_url, artifact_id, bullet_id)` and
  `(job_url, score_version, requirement_id)` links; a second fixture proving a
  demanded-but-uncovered requirement surfaces as a gap linked to its job; a
  cross-runtime parity assertion (Python builder output == TS builder output) if
  projected. Add to `test_projection_builder.py` + `apps/api/test/projections.test.ts`.
- **Local QA path:** `pnpm api:test` (evidence-map endpoint + parity),
  `uv --project workers/automation run --extra dev pytest -q` (index builder +
  parity), then a manual `GET /v1/evidence-map` against a seeded local DB
  confirming links resolve to existing artifact/job detail endpoints.

---

## Phase E2 — Career Evidence Map UI

**Objective.** Render the evidence map as an inspectable inventory where each
entry's usages and gaps are navigable links into the existing artifact/job/fit
surfaces — "inspect where used," not vibes.

**Scope.**
- Add a `views/evidence-map/` composer (view, table/list, detail drawer) that
  reads exclusively through new Operations hooks (`useEvidenceMapQuery`,
  `useEvidenceMapEntryQuery`) — never `useQuery`/`apiClient` directly.
- Render, per entry: the proof-point story (scope/action/outcome/metrics),
  freshness (date, `evidence_strength`, confirmed), skills, and two link groups:
  **Used in resumes** (deep links to `views/artifacts` `ArtifactDetailPanel` /
  the specific bullet in `BulletProvenanceList`) and **Requirement fit history**
  (deep links to `views/jobs` `JobDetailDrawer` requirement rows /
  `EmployerAnalysisPanel`). Cross-surface navigation goes through the URL
  (`navigate`), per frontend rules.
- Render **Gaps** and **Reusable stories** sections. Reuse context-owned badges
  (`ScoreBadge`, `StageBadge`, coverage tags) rather than inlining JSX.
- Query keys: add an `evidence-map` key factory re-exported through
  `apps/web/src/contexts/operations/queryKeys.ts` following the
  `["tenant", tenantId, ...]` convention.
- If E1 is projected + event-driven, register invalidation handlers so the map
  refreshes on `BulletProvenanceRecorded` / `JobScored` / `ProfileUpdated`
  (extend the relevant context `handlers.ts`; keep `every-event-has-handler`
  green — no new event types are required for E1/E2).

**Acceptance.**
- **Source of truth:** the `GET /v1/evidence-map` read model from E1.
- **Owning bounded context:** view composer over Operations read hooks; profile
  context supplies evidence components if reused.
- **Projection/read model:** consumes E1 (no new read model).
- **UI surface:** new `views/evidence-map` route/drawer; entry points from the
  profile view and the jobs drawer.
- **Approving user action:** none (read-only). Any "regenerate materials to
  refresh usage" action must reuse the existing materials mutation, not a new
  write.
- **Regression fixture:** a component/MSW test proving a map entry renders a
  resume-usage link whose href resolves to the artifact detail route and a
  requirement-usage link resolving to the job detail route; an `*.a11y.test.tsx`
  meeting the zero critical/serious axe bar; a Storybook story per state
  (loading/populated/empty/error) via the MSW addon.
- **Local QA path:** `pnpm --filter @jobhunter/web test`, `pnpm web:check`,
  `pnpm web:storybook:test`, and an e2e spec
  (`apps/web/e2e/tests/evidence-map.spec.ts`) that opens the map, clicks a
  usage link, and lands on the correct artifact/job detail — plus a
  `docs/local-reliability-qa.md` "Evidence Map Smoke" entry.

---

## Phase P1 — Interview Preparation Generation (backend)

**Objective.** Generate, on explicit user request, grounded interview prep for
one application from existing canonical data, passing the same truthfulness gates
as generated resume/cover material, persisting it as canonical
generation-versioned rows with provenance.

**Scope.**
- New bounded context **Interview Preparation** (`domain/interview/`) owning
  `InterviewPrep` aggregate, `InterviewPrepItem` entity, and a generation use
  case `GenerateInterviewPrepUseCase`.
- Inputs (all existing): `ProfileSnapshot` evidence, the accepted `MaterialsSet`
  + `BulletProvenanceSet` + coverage audit, `EmployerAnalysis`,
  `RequirementFitReport`, the job record. The use case selects the strongest,
  freshest, most-used proof points from the E1 read model.
- Generated item kinds:
  - `theme` — likely interview themes from must-have / high-weight requirements
    and role framing.
  - `star_draft` — a STAR narrative built **strictly** from one or more
    `AchievementEvidence` proof points (scope→situation/task, action→action,
    outcome/metrics→result), carrying `evidence_ids`.
  - `gap_drill` — for requirements scored weak/missing/transferable: an honest
    prompt to prepare a truthful answer about the gap and adjacent experience.
    A gap drill MUST NOT assert unearned experience.
  - `company_note` — per-posting preparation from the employer-analysis narrative
    and job record only (no external company research in this plan).
- Gates (reused): run the never-fabricate detector (`scan_resume_bullets`) and
  prose skill/tool gate (`scan_prose_skill_fabrications` over
  `build_skill_vocabulary`) on every generated prep item's prose; ground each
  STAR claim to profile evidence (`claim_grounding.py` pattern); run a structured
  judge. A hard fabrication finding is rejected with repair feedback exactly like
  a resume candidate; the run **fails closed** (no approved prep) and never
  destroys the last accepted generation.
- Persistence: new canonical rows — `job_interview_prep` (aggregate: job,
  generation, tenant, status, gate/judge audit) + `job_interview_prep_items`
  (one row per item: kind, `evidence_ids_json`, `requirement_ids_json`,
  `generated_text`, transform/control, grounding audit, position) — created via a
  new `ensure_interview_prep_tables` in `database.py`, FK to `jobs(url)`,
  generation-versioned. Audit data lives in canonical rows, never a blob.
- Domain events: add `InterviewPrepGenerated` and `InterviewPrepFailed` to
  `DOMAIN_EVENT_TYPES` (worker) AND `packages/domain-types/src/events/index.ts`
  (frontend union). Publish on accept/fail so a `job_events` row drives the
  projection + SSE.
- Trigger: a new JSON-RPC method `generate_interview_prep` registered in
  `register_default_handlers` (workflow mode preferred, mirroring `tailor_job`)
  with a matching schema in `packages/contracts/src/rpc.ts`. It runs only on
  demand; it is never wired into the pipeline/preparation auto-path.

**Acceptance.**
- **Source of truth:** profile evidence + accepted materials/provenance +
  employer analysis + requirement fit (all existing). Prep items add generated
  text bound to those sources via FK provenance.
- **Owning bounded context:** the new Interview Preparation context; it imports
  the pure Materials fabrication/grounding modules and consumes Scoring/Profile
  snapshots (no write coupling).
- **Projection/read model:** canonical `job_interview_prep` /
  `_items` (delivered here); the read projection lands in P2.
- **UI surface:** none in this phase.
- **Approving user action:** user invokes `generate_interview_prep` for one job
  (button lands in P2). No auto-generation.
- **Regression fixture (three mandated invariants):**
  1. **Prep carries provenance / truthfulness:** a fixture that generates prep
     from a profile with known evidence and asserts every `star_draft` item
     carries `evidence_ids` resolving to real profile evidence, and that a
     candidate injecting a fabricated metric/skill/employer is **hard-rejected**
     (reuse the fabrication detector) — mirroring `test_materials_use_cases.py`.
     A metrics-hungry job + numberless profile yields zero unsourced numerics.
  2. **Gap-drill honesty:** a fixture proving a `gap_drill` for a missing
     requirement never emits an experience claim (it names the gap), asserted by
     the same never-fabricate scan over its text.
  3. **No-live-assistance boundary:** this guard test ships in P1 (the first
     prep PR), even though the read/UI surface lands in P2. It asserts the
     worker/RPC/API surface contains only one-shot generation plumbing for prep
     and no streaming, transcript, websocket, microphone, live, in-session, or
     browser/agent participation path.
- **Local QA path:** `uv --project workers/automation run --extra dev pytest -q`
  (generation + gates + persistence + versioning), `ruff check .`, and a manual
  `generate_interview_prep` RPC against a seeded local DB confirming canonical
  rows + `InterviewPrepGenerated` event, with **no** spend triggered elsewhere.

---

## Phase P2 — Interview Preparation Read Model, UI, and the No-Live-Assistance Boundary

**Objective.** Serve accepted prep as an inspectable read model, render it on the
application surface with provenance links, and enforce/prove the
no-live-assistance boundary.

**Scope.**
- Read model: project the latest accepted prep into
  `job_detail_projections.interview_prep_json` (parity with
  `requirement_fit_report_json`) built by BOTH builders. DTO `InterviewPrep` on
  `JobDetail`, with each prep item exposing its provenance (`evidenceIds`,
  `requirementIds`) and joined profile source text (reuse
  `attachProfileSourceTextToBulletProvenance` pattern).
- Safe exposure: expose prep item text + provenance + gate/judge verdict +
  lifecycle-labelled warnings (used-to-repair / accepted-residual /
  post-acceptance) — never raw prompts, full profile, or full job description.
- UI: a `views/jobs` (or `views/apply-review`) prep panel that renders themes,
  STAR drafts (with "grounded in" evidence links into the evidence map / artifact
  detail), gap drills (clearly labelled as gaps), and company notes; a
  materials-context `GenerateInterviewPrepButton` composing a new
  `useGenerateInterviewPrepMutation` (async 202 → queued invalidation → SSE
  refresh). Re-generate keeps the last accepted prep visible until the
  replacement is accepted.
- Events + realtime: add invalidation handlers for `InterviewPrepGenerated` /
  `InterviewPrepFailed` in the owning context `handlers.ts`, keeping
  `every-event-has-handler.test.ts` green; add event fixtures.
- **No-live-assistance boundary (enforced by construction):** the only prep
  surfaces are (a) one-shot generation producing a stored artifact and (b) the
  read view. No streaming input, transcript upload, websocket, microphone, or
  real-time answer endpoint is created. The `InterviewPrep` aggregate has no
  live/in-session state.

**Acceptance.**
- **Source of truth:** the canonical `job_interview_prep` rows from P1.
- **Owning bounded context:** Interview Preparation (read model + context
  components); a view composes it.
- **Projection/read model:** `job_detail_projections.interview_prep_json` +
  `InterviewPrep` DTO.
- **UI surface:** prep panel on the job/apply-review detail;
  `GenerateInterviewPrepButton`.
- **Approving user action:** the user clicks "Generate interview prep"
  (and later "Regenerate"); generation is always explicit.
- **Regression fixture (two mandated invariants):**
  1. **Prep-carries-provenance (read path):** a projection/read-model fixture
     proving every rendered prep item exposes resolvable provenance and that the
     read model omits raw prompt/profile/job text (safe-exposure assertion),
     cross-runtime parity checked.
  2. **No-live-assistance boundary:** the dedicated guard test was introduced in
     P1. P2 keeps it green while adding only the sanctioned read UI and one-shot
     generate action; any streaming/transcript/websocket/live interview endpoint,
     live/in-session aggregate state, or browser/agent participation path still
     fails the guard.
- **Local QA path:** `pnpm api:test` + `pnpm --filter @jobhunter/web test` +
  `pnpm web:storybook:test` + `uv ... pytest -q`; an e2e spec
  (`apps/web/e2e/tests/interview-prep.spec.ts`) generating prep and inspecting a
  STAR draft's provenance link; a `docs/local-reliability-qa.md` "Interview Prep
  Smoke" entry including an explicit boundary check.

---

## Phase P3 — Post-Interview Reflection → Application Lifecycle

**Objective.** Let the user record post-interview reflection notes tied to the
application, feeding the existing outcome lifecycle without inventing a new store.

**Scope.**
- Reuse the existing `application_outcomes` mechanism: reflections are recorded
  as an `interview`-kind `ApplicationOutcome` with a `note` (already supported by
  `ManualApplicationOutcomeRequestSchema`). Add a nullable
  `interview_prep_generation` column to `application_outcomes` (additive) so a
  reflection can reference the prep it followed. Owner decision 6 is resolved in
  favor of this nullable-link option.
- Surface reflections in the prep panel and the existing `OutcomeTimeline`
  (`apps/web/src/contexts/apply/components/ApplicationOutcomes.tsx`), and offer a
  "Record reflection" affordance from the prep view that reuses
  `useRecordManualApplicationOutcomeMutation`.
- Preserve the outcome sensitivity rule: raw note text stays in the outcome
  table and never enters `job_events.payload_json`, projections, logs, or
  telemetry.

**Acceptance.**
- **Source of truth:** `application_outcomes` (`kind = "interview"`, `note`).
- **Owning bounded context:** Apply (outcome feedback), consumed by the prep view.
- **Projection/read model:** existing outcomes read path
  (`useJobApplicationOutcomesQuery`); no new projection unless the prep link
  column is added.
- **UI surface:** "Record reflection" in the prep panel; reflections in
  `OutcomeTimeline`.
- **Approving user action:** the user submits a reflection note (post-interview).
- **Regression fixture:** an API test proving a reflection persists as an
  `interview` outcome with its note, is returned by the job outcomes endpoint,
  and that no raw note text appears in any emitted event payload/projection
  (sensitivity assertion); a component test for the reflection form.
- **Local QA path:** `pnpm api:test` + `pnpm --filter @jobhunter/web test`; a
  manual pass recording a reflection and confirming it appears in the timeline
  and not in the SSE payload; extend the Apply Review smoke in
  `docs/local-reliability-qa.md`.

---

## Cross-Cutting Regression Fixtures (non-negotiable)

These prove the two invariants the whole feature exists to guarantee and must
exist before any prep phase is called done:

1. **Prep content carries provenance and passes truthfulness gates.** A synthetic
   fixture reproduces prep generation from canonical data and asserts: every
   STAR/company claim binds to real `evidence_ids`; an injected fabricated
   metric/skill/title/employer is hard-rejected by the reused
   `fabrication_detector`; a failed generation preserves the prior accepted prep.
   (Backend in `workers/automation/tests/`; read-path parity in
   `apps/api/test/` + the audit-projection fixture.)
2. **No live or in-interview assistance exists.** A guard test (worker + API +
   web) asserts the feature ships only one-shot generate + read + post-hoc
   reflection surfaces and no streaming/transcript/websocket/microphone/live
   endpoint or aggregate state; adding one fails the test. This is the machine
   encoding of the ethical boundary and is treated like the
   `every-event-has-handler` parity test: when it fails, fix the surface, not the
   test.

Also uphold the standing parity/exhaustiveness tests unchanged:
`apps/web/src/contexts/operations/every-event-has-handler.test.ts`,
`apps/web/src/contexts/pipeline/components/every-stage-state-has-badge.test.tsx`,
and the projection parity family.

## Verification (exact commands, per `CLAUDE.md`)

Run the smallest relevant set per phase; run the full set before a stack is
marked done.

| Surface | Command | Required result |
| --- | --- | --- |
| Python worker | `uv --project workers/automation run --extra dev pytest -q` | 100% pass |
| Python lint | `uv --project workers/automation run --extra dev ruff check .` | clean |
| API typecheck | `pnpm api:check` | clean |
| API tests | `pnpm api:test` | pass |
| Web typecheck | `pnpm web:check` | clean |
| Web unit/hook/component | `pnpm --filter @jobhunter/web test` | pass |
| Web type-level | `pnpm --filter @jobhunter/web test-d` | pass |
| Web e2e | `pnpm --filter @jobhunter/web e2e` | pass |
| Web Storybook (a11y) | `pnpm web:storybook:test` | pass |
| Full sweep | `pnpm test` | pass |
| Diff hygiene | `git diff --check` | clean |

Focused parity (run when touching projections):
`uv --project workers/automation run --extra dev pytest -q
workers/automation/tests/test_projection_builder.py
workers/automation/tests/test_audit_projection_parity.py` and
`pnpm api:test` (projections + audit-projection-parity).

## Definition of Done

- [ ] Phase 0 contracts + ADRs merged; no behavior change.
- [ ] E1 evidence-map read model returns per-evidence usage with resolvable
      resume + requirement links; gaps computed from recorded misses; parity
      green if projected.
- [ ] E2 map UI renders usages/gaps/stories/freshness with navigable links; a11y
      + Storybook + e2e green.
- [ ] P1 prep generation is user-initiated only, grounded, gated, and
      generation-versioned; backend fixtures pass, including the first-prep-PR
      no-live-assistance guard; no pipeline spend.
- [ ] P2 prep read model + UI expose provenance safely; the no-live-assistance
      guard remains green; SSE/invalidation handlers added with parity green.
- [x] P3 reflections persist as `interview` outcomes with notes and never leak
      raw note text into events/projections/logs; owner decision 6 resolved as
      the nullable `interview_prep_generation` link.
- [ ] Every displayed map/prep claim has an explicit, cited source of truth.
- [ ] Docs updated (below). Full verification matrix green. `git diff --check`
      clean.

## Documentation Updates Required

Per `CLAUDE.md` documentation table, when each phase lands:
- `README.md` — new user-facing capabilities (evidence map, interview prep,
  reflections) and the explicit no-live-assistance safety note.
- `docs/architecture/read-model.md` — the evidence-usage index and interview-prep
  projection/read model.
- `docs/architecture/materials.md` — interview prep as grounded, gated generated
  material reusing the fabrication/grounding/judge gates.
- `docs/architecture/domain-model/*` — the new Interview Preparation context and
  the Career Evidence Map read model in the context inventory.
- `docs/architecture/frontend/*` — the new `evidence-map` view and prep surfaces.
- `docs/local-ts-api.md` — new endpoints (`/v1/evidence-map`, interview-prep,
  reflection) and RPC method.
- `docs/local-reliability-qa.md` — Evidence Map, Interview Prep, and boundary
  smokes + regression-matrix entries.
- `docs/decisions.md` — the two ADRs from Phase 0.
- `packages/*` / `package.json` — only if scripts/deps change.

## Non-Goals

- **No live or in-interview assistance of any kind** (the hard boundary). No
  transcription, real-time answer suggestion, mock-interview chatbot, or agent
  participation in an interview.
- **No external company research / company-level analysis.** Company notes derive
  only from the existing per-posting `EmployerAnalysis` + job record. A
  cross-posting company profile is greenfield and out of scope.
- **No new fabrication engine.** Prep reuses the existing gates; it does not fork
  or weaken them.
- **No auto-generation in the pipeline.** Prep is user-initiated; discovery/
  enrichment/scoring/tailoring behavior is unchanged.
- **No changes to apply submission** or the autonomous browser agent. Reflections
  are notes, not actions.
- **No new profile facts.** The evidence map reads and inverts existing evidence;
  it does not author evidence.

## Risks

- **Read-model cost.** Inverting provenance/fit across many jobs can be heavy at
  read time; prefer the incremental projection so the cost is paid on write and
  the map is SSE-fresh. (Owner decision below.)
- **Grounding false-positives in prep.** STAR drafts synthesised from multiple
  proof points could trip the never-fabricate scan on legitimate combined
  metrics; mitigate by grounding each numeric to a specific `evidence_id` (the
  provenance discipline) and by fixtures covering combined-evidence stories.
- **Boundary drift over time.** A future contributor could add a "live" surface;
  the guard test + ADR + doc note are the durable defense.
- **Profile parity gap.** Profile is served live with no parity test; if the map
  denormalises profile fields into a projection, keep the denormalisation thin
  and parity-checked to avoid a new drift class.
- **Sensitive data exposure.** Prep and reflections touch profile + outcome data;
  the safe-exposure pattern and the outcome sensitivity rule must be enforced by
  tests, not conventions.

## Owner Decisions

Resolved 2026-07-05 during implementation. Per owner instruction, proceed on
the plan recommendations for decisions 1-5. Decision 6 was later resolved as
the nullable-link option, so the P3 boundary is no longer blocked:

1. **Evidence-map read model: projection vs live read.** Decision:
   `evidence_usage_projections` (dual-builder, parity-tested, SSE-fresh). The
   live-read alternative is rejected for this plan because it would make map
   reads heavier and skip the existing parity/invalidation discipline.
2. **Interview-prep read storage: `job_detail_projections.interview_prep_json`
   vs a dedicated `interview_prep_projections` table.** Decision:
   `job_detail_projections.interview_prep_json` for the latest accepted
   generation, keeping canonical versioned prep rows as the history source.
3. **Prep orchestration: sync RPC vs Temporal workflow vs a new
   `PreparationWorkItemKind` + `JobPreparationWorkflow` step.** Decision:
   workflow-mode `generate_interview_prep` RPC, explicit user-trigger only. Do
   not add prep to the automatic discovery/enrichment/scoring/tailoring
   pipeline; do not create a parallel truthfulness pipeline.
4. **New Interview Preparation context name and location of shared gates.**
   Decision: `domain/interview/` owns the prep aggregate/use case and imports
   the existing pure Materials fabrication, claim-grounding, and judge gates
   directly. Do not promote the gates to a shared kernel unless another concrete
   consumer appears.
5. **STAR/theme generation model + spend posture.** Decision: use the existing
   default LLM lane with the existing spend-budget controls. Generation is
   explicit, user-triggered, and never unattended.

6. **Reflection ↔ prep link.** Whether to add a nullable
   `interview_prep_generation` column to `application_outcomes` (P3) or keep
   reflections as plain `interview` outcome notes. Decision: add the nullable
   `interview_prep_generation` link so a post-interview reflection can identify
   the stored prep generation it followed when one exists.

## References (in-repo)

- `docs/architecture/materials.md`, `docs/architecture/tailoring.md` — the
  generation + audit contract prep must reuse.
- `docs/architecture/read-model.md` — projections, SSE, and outcome feedback.
- `docs/architecture/scoring.md` — requirement-fit facts feeding the map.
- `docs/architecture/domain-model/index.md`, `.../strategic.md`, `.../tactical.md`
  — bounded-context language and aggregate/read-model conventions.
- `docs/architecture/frontend/contexts.md`, `.../structure.md`, `.../testing.md`
  — frontend context/view/test conventions.
- `docs/decisions.md` — where the two ADRs land.
- `docs/plans/implemented/2026-06-15-requirement-fit-ledger.md`,
  `docs/plans/implemented/2026-06-03-resume-tailoring-quality.md`,
  `docs/plans/implemented/2026-06-01-apply-review-outcome-feedback-design.md`
  — precedents for grounded audit read models, generated-material gates, and the
  append-only outcome lifecycle.

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
