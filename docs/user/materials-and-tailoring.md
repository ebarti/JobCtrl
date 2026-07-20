# Materials & Tailoring

Materials are the job-specific resumes, cover letters, PDFs, and related review
records JobCtrl creates from canonical profile evidence and the target posting.
Tailoring is the versioned, gated process that selects and renders those claims
without turning the job description into evidence about you.

## How JobCtrl Chooses A Resume

Tailoring is a candidate-selection pipeline, not one unconstrained prompt:

1. **Build one deterministic plan.** JobCtrl combines the accepted posting and
   employer analysis with a versioned Candidate Profile snapshot, requirement
   fit, tailoring permissions, required evidence pins, and writing style. The
   posting may guide emphasis; only profile evidence may support claims about
   you.
2. **Ask each ready generator for structured content.** Configured candidate
   models receive the same plan. Their response must reference known experience
   and skill-category IDs, preserve source titles, respect bullet limits, and
   use skills that already exist in the profile.
3. **Validate the assembled resume, not just model JSON.** Deterministic checks
   run over the actual candidate text for grounding, preserved employers,
   education, section structure, prohibited claims, metrics, seniority, and
   requirement/keyword coverage. A keyword counts as covered only when it is in
   the rendered grounded text.
4. **Repair bounded quality failures.** The current post-generation defaults
   require fit of at least `8/10` and must-have coverage of at least `85%`, with
   one revision attempt. These are artifact-quality gates after generation, not
   the Discovery minimum-fit eligibility threshold.
5. **Require approval from every enabled gate.** In guarded validation, the
   structured judge must return `PASS`, reach the configurable threshold
   (`0.82` by default), and report no unsupported claims, fabrications, or
   missing required evidence. Jobs at or above `8/10` fit also receive a
   six-persona adversarial review. Repair instructions from rejected candidates
   feed the bounded retry.
6. **Select and persist the best clean candidate.** JobCtrl chooses the approved
   candidate with the best judge result. An optional voice pass is kept only if
   deterministic voice measures improve and grounding still passes; the final
   fabrication gate runs again afterward. Rendering and generation persistence
   complete together, so a PDF failure or rejected replacement leaves the last
   accepted generation intact.

The artifact inspector exposes the plan, gates, coverage, provenance, judge,
adversarial result, and lifecycle of warnings so you can inspect why the chosen
resume was accepted.

## What You Can See And Control

Eligible jobs receive materials during Discover preparation. You can also
generate first-time materials for one job, re-tailor a job with the current
policy, or run bounded re-tailoring from the Jobs toolbar.

The user-visible surfaces divide the work:

- `/jobs/:jobId` shows material readiness, accepted artifacts, employer and
  requirement evidence, stage failures, and the per-job generation/re-tailor
  controls.
- `/artifacts` lists registered generations; `/artifacts/:artifactId` opens a
  route-level inspector with stored validation, provenance, coverage, voice,
  template, risk metadata, and same-job comparison followed by the full-width
  real preview when supported.
  Canonical evidence foreign keys resolve to human-readable Evidence-map titles
  and excerpts with links back to the owning entry. An unresolved legacy key is
  labeled unavailable and stays accessible under **Technical details** rather
  than being presented as user-facing evidence.
- `/apply-review` consumes the accepted generation. The editor, revision,
  replacement-render, and submission-approval lifecycle is owned by
  [Apply](apply.md#materials-and-resume-rendering).
- `/preferences` owns tailoring permissions, writing style, resume templates,
  and template selection. Template payloads hold style/layout only, not
  candidate or job facts.
- `/settings/models` owns the generator/judge execution policy used by newly
  started work. The current fields and fallback rules belong to
  [Configuration](configuration.md), not this page.

Generating materials, choosing a default template, revising a resume in Apply
Review, and approving a live submission are separate decisions. Materials
hands accepted generations to Apply; it does not own submission approval.

Interview prep is an explicit, job-scoped generation from the Job Detail
workspace. It is not an automatic pipeline stage or live interview assistant.
Review its linked profile and requirement evidence before relying on it; the
current maturity boundary is described in
[Daily Workflow → Generate Interview Prep](normal-flows.md).

## Source Of Truth And Ownership

The inputs have intentionally different authority:

| Input | Owner | What it may prove |
| --- | --- | --- |
| Candidate facts and achievements | Candidate Profile snapshot | Experience, skills, metrics, dates, titles, employers, and other claims about you. |
| Job requirements and employer wording | Enrichment snapshot plus canonical employer analysis | What the employer asks for and which language appears in the posting. It is target context, never candidate evidence. |
| Requirement fit | Scoring | Which requirements are matched, transferable, missing, or blocked, with allowed evidence links. |
| Tailoring and model policy | Preferences, Settings, and versioned Materials policy | What transformations and gates may run. Policy cannot create a fact. |
| Accepted output | Materials generation and registered artifacts | The exact text/HTML/PDF selected for review or Apply, plus its audit data. |

Every rendered resume line that makes a candidate claim should trace to
canonical profile evidence. Keyword coverage is computed from the actual
rendered, grounded text and persisted with the generation. The artifact read
model does not infer a missing list from the job description later, and it
reports absent audit data as unrecorded rather than as zero coverage.

Generated files stay under the local JobCtrl workspace and are served only
through registered artifact rows. An artifact route cannot open an arbitrary
filesystem path. See [Data, Privacy & Safety](data-and-safety.md#local-data) for
the local-file boundary.

## Lifecycle

1. **Check eligibility.** The latest score, blockers, active state, enrichment
   quality, and live threshold decide whether automatic tailoring may start. A
   deliberate first-time per-job action can request tailoring without changing
   the batch threshold.
2. **Plan evidence coverage.** The deterministic planner connects employer
   requirements to existing profile achievements, identifies uncovered needs,
   and preserves pinned or required evidence.
3. **Generate candidates.** Configured ready models produce structured resume
   candidates from the same profile and analysis contract.
4. **Validate and select.** Independent schema, grounding, rendering, quality,
   judge/adversarial, and fabrication controls reject unsupported content and
   feed bounded repair attempts. The detailed order and mode-dependent behavior
   are owned by the [Tailoring Contract](../architecture/tailoring.md), rather
   than duplicated here.
5. **Render and persist.** An accepted generation writes resume and cover
   records, HTML/PDF artifacts, layout boxes, provenance, coverage, policy
   version, and audit metadata. Operations projects that stored result into
   Jobs, Artifacts, and Apply Review.
6. **Preserve accepted history.** A failed generation or re-tailor remains audit
   history and never hides the last accepted artifact. Apply owns how a reviewed
   edit is validated and promoted into a replacement generation.
7. **Supersede or suppress deliberately.** A newly accepted replacement
   supersedes the prior active generation while preserving history. If a live
   threshold or blocker makes materials ineligible, JobCtrl soft-suppresses
   them from active/Apply surfaces rather than deleting the audit record.

The same preservation rule applies to stored interview prep and outreach draft
generations: a failed replacement does not destroy the last accepted record.

## Implementation And API Pointers

| Layer | Pointer |
| --- | --- |
| User workflow | [Daily Workflow → Generate And Inspect Materials](normal-flows.md) and [Apply → Materials And Resume Rendering](apply.md#materials-and-resume-rendering). |
| HTTP contract | Artifact list/detail/preview routes, `/v1/resume-templates`, and per-job generate/re-tailor actions; see [Jobs & Materials API](../api/jobs-and-materials.md) and the [complete artifacts contract](../api/complete-contract.md#artifacts-and-tailoring-audit). Apply Review routes are owned by [Apply](apply.md). |
| Worker implementation | `workers/automation/src/jobctrl/domain/materials/`, the `tailor.py` and `cover_letter.py` paths in `workers/automation/src/jobctrl/scoring/`, and `workers/automation/src/jobctrl/infrastructure/materials/`. |
| API and web implementation | In `apps/api/src/`: `resume-review-drafts.ts`, `resume-templates.ts`, and `read-model.ts`; in the web app: `apps/web/src/contexts/materials/`, `apps/web/src/views/artifacts/`, and `apps/web/src/views/apply-review/`. |
| Deep architecture | [Employer Analysis & Materials Audit](../architecture/materials.md), [Tailoring Contract](../architecture/tailoring.md), and [Stage Walkthrough → Tailor](../architecture/pipeline/stages.md#tailor). |
