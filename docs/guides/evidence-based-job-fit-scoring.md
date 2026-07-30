---
description: "Learn how evidence-based job fit scoring connects employer requirements to versioned candidate facts, deterministic policy, confidence, and corrections."
---

# Evidence-based Job Fit Scoring

Evidence-based job fit scoring should answer two questions together: “How
strong is this opportunity for me?” and “What facts support that conclusion?”
JobCtrl keeps the score, requirement assessments, profile evidence, confidence,
blockers, and policy version in one reviewable decision record.

## A Score Is A Triage Tool, Not A Verdict

JobCtrl scores jobs for the person conducting the search. It is not an
employer-side candidate-ranking system, and it should not be used to decide who
gets hired.

The 1–10 score helps a job seeker sort a large set of openings and decide where
to spend attention. It does not prove that an employer will interview you. A
strong result can still contain a hard blocker, uncertain evidence, or a
requirement you interpret differently. A weak result can reflect an incomplete
Candidate Profile rather than a poor real-world fit.

That is why the Job Detail workspace presents the evidence and correction
history beside the score instead of treating the number as self-explanatory.

## Start With Two Separate Sources Of Truth

The scoring boundary deliberately separates employer claims from candidate
claims:

- the captured posting and accepted employer analysis own requirements,
  priorities, and evidence about the role;
- the versioned Candidate Profile owns experience, skills, achievements,
  preferences, and evidence about the job seeker.

The scorer may classify how those sources relate. It may not turn wording from
the posting into a new fact about the candidate. An evidence link for a match
must point back to profile data; if that reference cannot be resolved, JobCtrl
labels it unavailable rather than displaying it as proof.

Read [Candidate Profile](../user/candidate-profile.md) for candidate evidence
ownership and [Discovery](../user/discovery.md) for the canonical employer
analysis.

## Score Requirements Before Resolving The Number

When an accepted employer analysis contains explicit requirements, JobCtrl asks
the scorer for a structured assessment of each one. A row records the
requirement identity, importance, posting evidence, fit classification, and
supporting Candidate Profile evidence.

The useful unit is the row:

| Requirement result | Meaning for review |
| --- | --- |
| Direct or strong match | Profile evidence substantially supports the requirement |
| Transferable evidence | The profile supports adjacent experience, but not the exact claim |
| Missing | The current profile does not contain supporting evidence |
| Blocked | A hard requirement is not met and constrains eligibility |
| Not assessed | The decision record does not contain a usable classification |

Versioned deterministic code then turns those rows into the saved score. More
important requirements contribute more, matched evidence receives more credit
than transferable evidence, and blocked requirements constrain the final
result. The current weights, rounding rules, compatibility path, and worked
example live in the canonical
[Scoring guide](../user/scoring-and-employer-analysis.md#how-the-score-is-calculated).

This division matters: a model classifies structured evidence, while a named
policy resolves the number. The persisted score is not a free-form model
opinion.

## Score, Confidence, And Eligibility Are Different

Collapsing every concern into one number makes a score look simpler than it is.
JobCtrl keeps three concepts distinct:

- **Fit score** summarizes the policy-resolved relationship between the role
  requirements and current profile evidence.
- **Confidence** tells you how much scrutiny the evidence needs. It is a review
  signal, not a hidden points multiplier.
- **Eligibility** decides whether downstream work such as automatic material
  generation may proceed. Hard blockers and the live minimum-fit threshold can
  affect eligibility without rewriting the saved score.

Changing the minimum-fit threshold therefore does not recalculate old scores.
It changes which existing decisions are eligible for later stages. Likewise, a
low-confidence score is not automatically low fit, and a high-confidence score
is not an application guarantee.

## Corrections Create History

If the evidence is wrong or your judgment differs, JobCtrl offers two separate
actions:

1. **Correct the score** to record your reviewed decision and rationale. This
   creates a new version and a calibration anchor.
2. **Re-score the job** to run the current policy against the current canonical
   inputs. This creates a new model-derived version.

Neither action silently edits the old record. A later policy can mark older
scores stale, but adopting it remains deliberate. The history lets you see
whether a change came from profile evidence, employer analysis, a policy
version, model execution, or human judgment.

The Evidence Map provides the reverse view: start from a profile achievement or
skill and inspect where scoring and generated materials used it.

## What The Audit Trail Can And Cannot Prove

The current requirement-led resolver is deterministic over the structured
response it accepts. The parser validates shapes and requires evidence
identifiers for matched rows, but it does not yet prove that every returned
identifier exists in the saved profile or reconcile every returned requirement
field against the accepted analysis before resolving the score.

That limit is visible in the product contract. An unresolved reference is
shown as unavailable, and its storage key remains under technical details. You
should not treat it as supporting evidence merely because the numeric score was
saved.

Evidence-based scoring improves auditability; it does not eliminate model
error, incomplete profiles, ambiguous postings, or human disagreement. Inspect
high-value jobs and correct the record when the evidence is weak.

## Review Fit In JobCtrl

Use the [synthetic live demo](https://demo.jobctrl.dev) to open a Job Detail
workspace and inspect requirement rows without connecting a provider. In a
local installation, start with a reviewed Candidate Profile and a bounded
Discover run, then filter the Jobs workspace by score or fit band.

For exact behavior, read [Scoring](../user/scoring-and-employer-analysis.md)
and the deeper [Scoring Policy](../architecture/scoring.md).

Related reading:

- [Resume Tailoring Without Fabrication](resume-tailoring-without-fabrication.md)
- [Open-source Job Application Tracker](open-source-job-application-tracker.md)
- [JobCtrl Guides](index.md)
