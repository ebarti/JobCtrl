---
description: "Understand how JobCtrl tailors a resume from canonical profile evidence, validates rendered claims, rejects fabrication, and preserves an inspectable audit trail."
---

# Resume Tailoring Without Fabrication

Truthful resume tailoring changes emphasis and structure without changing the
facts. JobCtrl treats the job posting as target context and the Candidate
Profile as the only authority for claims about you.

## The Job Description Is Not Candidate Evidence

A posting can tell a tailoring system what the employer values. It cannot prove
that you have a skill, held a title, delivered a result, or achieved a metric.
Copying requirements into a resume may improve keyword overlap while making the
document less trustworthy.

JobCtrl keeps four inputs separate:

| Input | What it is allowed to do |
| --- | --- |
| Candidate Profile snapshot | Prove experience, skills, dates, employers, titles, metrics, and other candidate facts |
| Posting and accepted employer analysis | Describe the target role, requirements, priorities, and employer wording |
| Requirement-fit record | Connect a requirement to direct, strong, transferable, missing, or blocked profile evidence |
| Tailoring policy and preferences | Control selection, structure, style, models, templates, and validation thresholds |

The generated resume is a new presentation of profile evidence. Neither the
posting nor a model response becomes a new candidate fact.

## Tailoring Is A Candidate-selection Pipeline

JobCtrl does not save the first block of prose returned by one prompt. The
current workflow:

1. builds one deterministic plan from the accepted posting, profile snapshot,
   requirement fit, user permissions, pinned evidence, and writing style;
2. retains the strongest grounded achievement for each target requirement and
   asks each ready generator for the smallest sufficient bullet set under the
   same plan;
3. resolves referenced experience and skill identifiers against known profile
   data;
4. assembles and renders each candidate;
5. checks the actual rendered text for grounding, structure, prohibited claims,
   metrics, seniority, and requirement coverage;
6. sends repairable failures through a bounded revision attempt;
7. requires enabled judge and adversarial gates to approve the candidate;
8. selects the best clean candidate and, after any optional buzzword-only voice
   refinement, re-runs claim binding, validation, provenance, fabrication, and
   the structured judge on the exact final text;
9. persists the accepted generation, files, provenance, coverage, and audit
   data together.

This sequence matters because structured JSON can be valid while the assembled
resume is not. Validation therefore follows the content through rendering
instead of stopping at the model boundary.

For the exact modes, thresholds, retry behavior, and failure codes, use the
canonical [Tailoring Contract](../architecture/tailoring.md).

## What The Fabrication Gates Check

There is no single “truth score.” Different checks protect different failure
modes:

- **Reference validation** rejects unknown experience or skill-category
  identifiers.
- **Grounding checks** compare candidate claims with the canonical profile
  evidence they cite.
- **Achievement-scoped metric checks** require a number to occur in the same
  evidence item cited by that bullet; a flat metric list cannot lend it to a
  different accomplishment.
- **Deterministic text checks** inspect preserved employers, education,
  sections, unsupported metrics, seniority changes, and prohibited claims.
- **Rendered coverage checks** count a keyword only when it appears in the
  actual grounded resume text.
- **A structured judge** must pass the configured quality threshold and report
  no unsupported claims, fabrications, or missing required evidence.
- **Adversarial personas** challenge high-fit candidates from several review
  perspectives and produce blockers, warnings, and repair instructions.
- **A final fabrication pass** runs after optional style refinement so improved
  voice cannot quietly weaken grounding.

Models still make mistakes, and deterministic checks have defined limits.
JobCtrl exposes the evidence and gate outputs because a human reviewer remains
the final authority.

## Missing Evidence Stays Missing

Suppose a posting requires Kubernetes production operations but the Candidate
Profile contains only local Docker development. A truthful tailoring system can
surface transferable container experience, leave Kubernetes as a gap, or
decide the job is not eligible for automatic materials. It cannot rewrite
Docker work as Kubernetes ownership.

The same rule applies to metrics and seniority. A number in a posting is an
employer requirement, not your accomplishment. A senior title in the target
role does not upgrade a prior title. If important experience is missing from
the Candidate Profile, correct the profile from your real evidence and create a
new version before generating again.

The master profile is an evidence inventory, not the desired length of every
tailored resume. Unless you explicitly mark a bullet required, JobCtrl may omit
it when it adds no distinct evidence for the target role. A per-role maximum is
an upper bound, not a request to fill the resume to that number.

See [Candidate Profile](../user/candidate-profile.md) for evidence ownership and
[Scoring](../user/scoring-and-employer-analysis.md) for the distinction between
direct, strong, transferable, missing, and blocked requirement fit.

## Inspect The Accepted Resume, Not Just The Prompt

The Artifacts workspace preserves more than a PDF. Its inspector can expose the
tailoring plan, policy version, candidate attempts, validation, provenance,
requirement and keyword coverage, judge result, adversarial review, voice
measures, template, risk metadata, and same-job generations.

Warnings are tied to their lifecycle. A warning may have caused a repair, been
accepted as residual on the selected candidate, or appeared after acceptance
without influencing the artifact. Missing audit data is reported as unrecorded
rather than converted into a reassuring zero.

Apply Review then loads the accepted HTML into an editor. Human edits,
comments, validation, replacement rendering, and the final PDF remain attached
to the material generation being reviewed. Generating, choosing a template,
editing, and approving a submission are separate decisions.

The current user-facing controls and artifact lifecycle are documented in
[Materials & Tailoring](../user/materials-and-tailoring.md).

## Failed Re-tailoring Does Not Destroy Good Work

A retry is an audit event, not permission to hide the current accepted resume.
If a new candidate fails grounding, judge review, rendering, or persistence,
JobCtrl keeps the last accepted generation available for review. A successful
replacement supersedes it while preserving history.

That preservation rule makes comparison possible and prevents a model or
provider failure from erasing the document you already approved.

## Try Truthful Tailoring

Use the [synthetic live demo](https://demo.jobctrl.dev) to inspect requirement
evidence and generated materials without connecting a provider. To tailor your
own profile, follow [Getting Started](../user/getting-started.md), create and
review a versioned Candidate Profile, then run a bounded Discover workflow.
Always read the rendered resume and its evidence before using it.

Related reading:

- [Local-first Job Search Automation](local-first-job-search-automation.md)
- [Open-source Job Application Tracker](open-source-job-application-tracker.md)
- [JobCtrl Guides](index.md)
