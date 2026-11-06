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

## Prepare And Review Source-Bound Material

Preparation binds the resume to saved Profile and job sources. Code checks
identifiers, verbatim quotations, exact values, schemas and versions. Semantic
judgments use recorded source-bound model determinations; words in a line do not
create evidence. Failed refreshes preserve the last accepted material.

The [accepted transformation target](../user/materials-and-tailoring.md#how-jobctrl-chooses-a-resume)
retains the full approved baseline and separates factual fit from document
coverage. It is an implementation target pending integration verification.

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

See [Candidate Profile](../user/candidate-profile.md) for evidence ownership and
[Scoring](../user/scoring-and-employer-analysis.md) for the distinction between
direct, strong, transferable, missing, and blocked requirement fit.

## Inspect The Accepted Resume, Not Just The Prompt

The Artifacts workspace preserves more than a PDF. Inspect the recorded source
references, requirement coverage and review findings for the accepted material.

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
If a replacement fails validation, rendering, or persistence,
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


## Semantic Determination Authority

Support, seniority alignment, voice and requirement demonstration are source-bound model verdicts. Code validates exact evidence IDs, verbatim quotes, values and structural output. Each displayed line joins a recorded source anchor; missing provenance is stated openly. A failed refresh preserves the last accepted artifact.

See [the decision](../decisions.md#_2026-10-07-semantic-judgments-are-llm-determinations) for caching, provenance and failure contracts.
