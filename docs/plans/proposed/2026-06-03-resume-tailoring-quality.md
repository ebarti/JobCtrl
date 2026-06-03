# Resume Tailoring Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make resume tailoring produce evidence-grounded, seniority-appropriate,
ATS-readable resumes that sound human, avoid fabricated claims, and receive
extra adversarial review for high-fit jobs before approval.

**Architecture:** Extend the existing Materials bounded context without adding a
new generation pipeline. The flow remains profile snapshot + job -> tailored
JSON -> validator -> judge -> MaterialsSet artifact, but gains explicit profile
evidence, deterministic planning/ATS checks, and a high-fit adversarial review
gate. Profile storage remains the source of user-confirmed evidence and
tailoring controls.

**Tech Stack:** Python domain/application services in
`workers/automation/src/jobhunter/domain/materials`, Python profile aggregate and
SQLite repository, TypeScript domain schemas/contracts, Fastify local API,
React/TanStack profile UI, Vitest/pytest regression coverage, and the existing
LLM port for generation and judging.

---

## Research Conclusions

Resume quality needs to be controlled as a product system, not only as prompt
wording.

1. **Achievement structure should scale with seniority.** Junior bullets can be
   task/action/result. Mid-level bullets should show ownership, technical
   judgment, constraints, and measurable improvement. Senior/staff bullets
   should show scope, cross-team influence, strategic tradeoffs, durable systems,
   risk reduction, and second-order impact. The common pattern is action +
   context + result, but the expected scope changes by level.
2. **Human-sounding resumes are specific and bounded.** AI-sounding resumes
   overuse generic action verbs, symmetrical phrasing, broad claims, inflated
   seniority, vague metrics, and unnatural keyword density. The generator should
   prefer plain verbs, real constraints, concrete nouns, varied bullet rhythm,
   and interview-defensible claims.
3. **ATS quality is partly deterministic.** Standard headings, parseable text,
   conventional sections, keyword coverage, and role-relevant skill alignment can
   be checked before and after generation. Keyword stuffing should be penalized
   because ATS relevance and recruiter trust are separate goals.
4. **Creative tailoring must be typed.** "Creativity" cannot be a single
   boolean. The system needs claim modes: verified facts, evidence reframing,
   adjacent translation from supported expertise, and draft claims requiring user
   confirmation. Only verified and evidence-reframed claims may be auto-approved.
5. **High-fit jobs deserve more scrutiny.** For jobs with fit score >= 8, run
   adversarial review personas after normal judging: ATS parser, skeptical
   recruiter, hiring manager/domain expert, evidence auditor, anti-AI voice
   critic, and interview defensibility critic. Any blocker finding keeps the
   resume unapproved.
6. **Evaluation needs golden failure cases.** Quality must be protected with
   regression examples for unsupported claims, AI voice, weak seniority framing,
   ATS-unfriendly output, keyword stuffing, missing required evidence, and
   high-fit adversarial failures.
7. **The feedback loop should improve the profile, not the artifact only.**
   User corrections such as "sounds fake", "claim is true", "claim is false",
   and "helped in interview" should eventually feed profile evidence and policy
   settings.

## Current Implementation Snapshot

The existing Materials pipeline already has important foundations:

- `TailorResumeUseCase` generates multiple candidates, validates them, judges
  them, persists policy metadata, and approves only judge-passing artifacts.
- `ContentValidator` rejects LLM self-talk, banned phrases, fabricated watchlist
  skills, missing sections, removed companies, missing education, and missing
  required skill categories.
- Profile controls already support required experience entries, required
  bullets, required skill categories, verified metrics, writing style, and a
  coarse tailoring policy.
- The prompt already forbids invented companies, roles, degrees, certifications,
  tools, metrics, and unsupported achievements.

The gaps are:

- Achievement evidence is stored mostly as free-form bullets and global metrics;
  there is no typed evidence object that says what can be safely reframed.
- Tailoring controls are coarse. `allow_minor_inference` and
  `allow_achievement_rewriting` do not distinguish verified claims from adjacent
  expertise translations or user-confirmation drafts.
- ATS and anti-AI checks are mostly prompt/judge based rather than deterministic.
- Judge output has one review perspective and no high-fit escalation.
- Seniority expectations are implicit in writing style, not encoded as reusable
  rules.
- There is no dedicated tailoring evaluation corpus for resume-quality failure
  modes.

## Target Tailoring Flow

```text
Profile evidence + job + fit score
  -> TailoringPlanBuilder
  -> generator prompt with seniority, evidence, and ATS plan
  -> ContentValidator structural/fabrication checks
  -> DeterministicTailoringQualityChecks
  -> normal judge
  -> high-fit adversarial review when fit score >= 8
  -> approved MaterialsSet artifact or repairable failure
```

## Stacked PRs

### PR 0: Plan PR

- [ ] Add this plan under `docs/plans/proposed/`.
- [ ] Open a draft PR titled `docs: plan resume tailoring quality work`.
- [ ] Validate with `git diff --check`.

### PR 1: Profile Evidence And Tailoring Controls

Scope:

- [ ] Add typed achievement evidence to the Python profile domain:
  `workers/automation/src/jobhunter/domain/profile/value_objects.py`,
  `aggregate.py`, `snapshot.py`, and repository serialization.
- [ ] Add schema helpers in `workers/automation/src/jobhunter/resume_profile.py`
  for:
  - `get_achievement_evidence(profile)`
  - `get_claim_mode(profile)`
  - `get_auto_approvable_claim_modes(profile)`
  - `get_tailoring_quality_controls(profile)`
- [ ] Extend TypeScript schemas in `packages/domain-types/src/profile/profile.ts`
  and `packages/contracts/src/schemas.ts`.
- [ ] Extend API profile persistence in `apps/api/src/profile-store.ts` so the
  controls and evidence survive round trips.
- [ ] Add or update profile import defaults in
  `workers/automation/src/jobhunter/profile_import.py` and
  `workers/automation/src/jobhunter/wizard/init.py`.
- [ ] Update focused tests:
  `workers/automation/tests/test_profile_aggregate.py`,
  `workers/automation/tests/test_profile_import.py`,
  `workers/automation/tests/test_sqlite_profile_repository.py`,
  `packages/domain-types/test/profile.test.ts`, and API profile-store tests if
  touched.

Data shape:

```json
{
  "resume": {
    "experience_entries": [
      {
        "id": "role_1",
        "achievement_evidence": [
          {
            "id": "ev_role_1_latency",
            "source_text": "Reduced API latency 35% by replacing synchronous enrichment calls.",
            "scope": "owned service",
            "action": "replaced synchronous enrichment calls",
            "tools": ["Python", "PostgreSQL"],
            "metrics": ["35% latency reduction"],
            "outcome": "faster API responses",
            "seniority_signal": "technical ownership",
            "evidence_strength": "verified",
            "claim_confidence": 0.95,
            "user_confirmed": true,
            "tags": ["latency", "backend", "performance"]
          }
        ]
      }
    ],
    "tailoring_rules": {
      "tailoring_policy": {
        "claim_mode": "evidence_reframing",
        "auto_approvable_claim_modes": ["verified_only", "evidence_reframing"],
        "allow_adjacent_achievement_drafts": false
      }
    }
  }
}
```

Acceptance criteria:

- [ ] Existing profiles with no `achievement_evidence` remain valid.
- [ ] Strict mode disables adjacent drafts and only auto-approves verified
  claims.
- [ ] Aggressive mode may allow adjacent drafts, but those drafts are not
  auto-approvable without explicit user confirmation.
- [ ] Profile round trips preserve evidence, controls, and existing required
  bullets/metrics.

### PR 2: Tailoring Plan, ATS Checks, And Seniority Rules

Scope:

- [ ] Add a pure planning service in
  `workers/automation/src/jobhunter/domain/materials/quality.py`.
- [ ] Build `TailoringPlan` from profile evidence, job description, scoring/fit
  context when available, claim mode, writing style, and seniority signals.
- [ ] Add deterministic checks for:
  - standard section headings
  - required evidence IDs present
  - metrics sourced from profile evidence or verified metrics
  - keyword coverage from job title, skills, responsibilities, and scoring
    signals
  - keyword stuffing / unnatural repetition
  - seniority mismatch between job level and bullet scope
  - banned AI voice markers beyond the existing phrase list
- [ ] Inject the tailoring plan into `_build_tailored_resume_prompt` and judge
  prompt context in `workers/automation/src/jobhunter/domain/materials/use_cases.py`.
- [ ] Persist plan/check metadata on the tailored resume artifact so failures
  are inspectable without storing sensitive logs.
- [ ] Update `ContentValidator` only for deterministic validation that does not
  require an LLM.
- [ ] Add tests in `workers/automation/tests/test_materials_quality.py`,
  `test_content_validator.py`, and `test_materials_use_cases.py`.

Acceptance criteria:

- [ ] A generated claim using an unknown metric fails deterministic checks before
  approval.
- [ ] A resume that repeats a keyword unnaturally receives a warning or failure
  depending on severity.
- [ ] Senior/staff jobs require at least one ownership/scope/influence signal
  when such evidence exists.
- [ ] Junior/mid-level jobs are not forced into executive-style bullets.
- [ ] Validator failures feed repair instructions into the existing retry loop.

### PR 3: High-Fit Adversarial Review Gate

Scope:

- [ ] Add adversarial review schemas and prompt builders in
  `workers/automation/src/jobhunter/domain/materials/adversarial.py`.
- [ ] Run this gate only when the job fit score is >= 8.0 or an equivalent 0-1
  fit score normalizes to >= 0.8.
- [ ] Use the existing `LlmPort` and separate structured response schema for:
  ATS parser, skeptical recruiter, hiring manager/domain expert, evidence
  auditor, anti-AI voice critic, and interview defensibility critic.
- [ ] Add retry feedback into the current avoid-notes loop.
- [ ] Persist a compact adversarial summary in artifact metadata:
  `ran`, `threshold`, `personas`, `blockers`, `warnings`, `score`.
- [ ] Add tests in `workers/automation/tests/test_materials_adversarial.py` and
  `test_materials_use_cases.py`.

Acceptance criteria:

- [ ] Fit < 8 jobs do not call the adversarial reviewer.
- [ ] Fit >= 8 jobs call the reviewer after normal judge pass.
- [ ] Any blocker from evidence, fabrication, ATS parseability, or AI voice
  keeps the resume unapproved.
- [ ] Warnings without blockers are persisted and do not block approval.
- [ ] Failed adversarial findings are included in retry/repair instructions.

### PR 4: Profile UI Controls And Documentation

Scope:

- [ ] Use the existing profile context UI, not a new view, to expose claim mode,
  adjacent draft permission, auto-approvable claim modes, and achievement
  evidence editing.
- [ ] Update `apps/web/src/contexts/profile/components/StructuredProfileEditor.tsx`
  and focused profile form tests/stories.
- [ ] Preserve existing required bullets and verified metrics controls.
- [ ] Update `README.md` for user-facing tailoring controls.
- [ ] Update `docs/local-reliability-qa.md` with resume-tailoring regression
  checks and high-fit adversarial review QA.
- [ ] Update `docs/ddd-target.md` only if the bounded-context contract changes
  after implementation.

Acceptance criteria:

- [ ] Users can add, edit, and remove achievement evidence without touching raw
  JSON.
- [ ] Users can see which claim modes are safe for auto-approval.
- [ ] The UI does not imply JobHunter can invent unverifiable achievements.
- [ ] API round-trip tests and web component tests cover the controls.

### PR 5: Tailoring Evaluation Harness

Scope:

- [ ] Add a small deterministic evaluation corpus under a non-sensitive fixture
  path such as `workers/automation/tests/fixtures/tailoring_quality/`.
- [ ] Include golden cases for unsupported metric, keyword stuffing,
  AI-sounding bullet, seniority mismatch, missing required evidence, adjacent
  draft requiring confirmation, and high-fit adversarial blocker.
- [ ] Add a pytest entry point that runs without live LLM credentials using fake
  ports and structured fixture outputs.
- [ ] Document the eval command in `docs/local-reliability-qa.md`.

Acceptance criteria:

- [ ] The eval catches all listed golden failure modes.
- [ ] The eval can be run locally with:
  `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_materials_quality.py workers/automation/tests/test_materials_adversarial.py`.
- [ ] No fixture contains a real user's resume, profile, job application, or
  generated artifact.

## Verification Matrix

Run the smallest relevant command set per PR, and the broader set before the
final stack is marked done:

- Python profile/materials unit tests:
  `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_profile_aggregate.py workers/automation/tests/test_profile_import.py workers/automation/tests/test_sqlite_profile_repository.py workers/automation/tests/test_content_validator.py workers/automation/tests/test_materials_use_cases.py`
- New quality/adversarial tests:
  `uv --project workers/automation run --extra dev pytest -q workers/automation/tests/test_materials_quality.py workers/automation/tests/test_materials_adversarial.py`
- Python lint:
  `uv --project workers/automation run --extra dev ruff check workers/automation/src/jobhunter/domain/materials workers/automation/src/jobhunter/domain/profile workers/automation/src/jobhunter/resume_profile.py workers/automation/tests/test_materials_quality.py workers/automation/tests/test_materials_adversarial.py`
- TypeScript domain/API tests:
  `pnpm --filter @jobhunter/domain-types test`
  `pnpm api:test`
- Web profile tests when UI changes:
  `pnpm --filter @jobhunter/web test -- StructuredProfileEditor ProfileEditor`
  `pnpm web:check`
- Diff hygiene:
  `git diff --check`

## Non-Goals

- Do not submit applications or run browser auto-apply flows.
- Do not ingest or expose real generated resumes, cover letters, PDFs, browser
  profiles, local databases, or job application data.
- Do not replace the existing Materials aggregate or LLM port.
- Do not make high-fit adversarial review mandatory for every job; the cost and
  latency are reserved for high-fit opportunities.
- Do not allow automatic approval of unverifiable invented achievements.
