---
description: "See how an open-source job application tracker can connect job discovery, evidence, tailored materials, approvals, and outcomes in one local audit trail."
---

# Open-source Job Application Tracker

An open-source job application tracker should do more than store a company,
role, URL, and status. JobCtrl connects each application record to the posting
snapshot, fit evidence, reviewed materials, workflow history, submission
boundary, and confirmed outcome that produced it.

## From Status List To Evidence Trail

A spreadsheet is effective when the main question is “Where did I apply?” It
becomes harder to maintain when you also need to answer:

- Which source produced this job, and is another URL the same opening?
- Which requirements did my profile actually support?
- Which resume generation did I review for this application?
- Did a run fail before submission, reach submit intent, or receive
  confirmation?
- Did an outcome come from me, a reviewed Gmail suggestion, or an inference?
- Can interrupted automation resume without duplicating employer-facing work?

JobCtrl treats those questions as linked records instead of free-form notes.
The Jobs, Job Detail, Evidence Map, Artifacts, Apply Review, Runs, and Outcomes
surfaces are different views over the same local workflow.

## What The Tracker Records

The record grows as the job moves through the lifecycle:

| Stage | Inspectable record |
| --- | --- |
| Discover | Source, source-native identity, captured URL, canonical identity evidence, and run membership |
| Enrich | Posting snapshot, extracted fields, content provenance, and quality state |
| Score | Versioned fit score, confidence, blockers, requirement rows, and Candidate Profile evidence links |
| Tailor | Plan, policy, candidate attempts, accepted generation, rendered files, validation, and provenance |
| Review | Human edits, comments, replacement render, defer/decline/approval decision, and approval binding |
| Apply | Dry-run receipt, submit intent, guarded transport result, confirmation evidence, or verification state |
| Outcome | Confirmed application facts, reviewed suggestions, timeline entries, and bounded analytics |

Not every job must pass through every stage. A manually captured lead can still
be useful, a weak fit can stop before materials, and a browser application may
end with manual final submission. The tracker preserves the state that actually
exists rather than inventing a clean funnel.

The precise lifecycle and owning UI surfaces are in
[Daily Workflow](../user/normal-flows.md).

## Open Source Changes What You Can Verify

JobCtrl is licensed under
[AGPL-3.0-only](https://github.com/ebarti/JobCtrl/blob/main/LICENSE), and its
source, tests, architecture decisions, and issue history are public. That means
you can inspect how a score is calculated, where an approval is checked, which
process can read a credential, and how a workflow handles retries.

Open source is not proof that every result is correct. It makes the mechanism
reviewable and changeable. JobCtrl complements that with product-level audit
surfaces so ordinary review does not require reading source code. For example,
a requirement-fit row exposes its evidence, and an accepted resume generation
keeps its provenance and validation record.

Contributors can start with the
[repository and ownership map](../developer/repository-and-ownership-map.md).
Job seekers can stay in the product and use the
[Product Tour](../user/product-tour.md).

## Canonical Identity Prevents A Common Tracking Error

The same opening may appear on a company site, a job board, and an applicant
tracking system. Treating each URL as a new row creates duplicate preparation
and can create repeat-application risk.

JobCtrl preserves source observations and reviewed duplicate relationships
around one canonical job identity. Before a live Apply claim, it combines that
identity with confirmed application facts. The same canonical opening is
blocked by default; a conservative same-employer, equivalent-role relationship
requires an explicit reasoned confirmation bound to the current evidence.

Similarity alone does not rewrite history. Pending email suggestions, notes,
dry runs, failed pre-submit attempts, and submit intent alone are not treated as
confirmed applications. The detailed decision states and override lifecycle
are owned by
[Apply → Repeat-Application Protection](../user/apply.md#repeat-application-protection).

## Outcomes Stay Factual

A useful tracker should help you learn from outcomes without silently turning
an email guess into a fact. JobCtrl separates confirmed events, reviewed Gmail
suggestions, free-form notes, and analytics projections.

The timeline can show applications, replies, interviews, offers, rejections,
withdrawals, and manual corrections, but each source keeps its identity.
Outcome analytics remain read-only and sample-gated so a small number of
applications does not become a confident recommendation. See
[Outcomes & Feedback](../user/outcomes-and-feedback.md) for the current
confirmation and projection boundaries.

## Application Tracking Without Autonomous Submission

Tracking and submission are intentionally separate authorities. You can
discover, score, tailor, and review a job without granting a model permission
to submit it.

JobCtrl supports inspection-only browser rehearsals, manual final browser
submission, and a separate exact-approved Gmail sender. Approval binds to the
current job, profile, URL, materials, and qualifying evidence. At-most-once
submit intent protects retries, while an ambiguous post-intent result becomes
`needs_verification` instead of an automatic second attempt.

This lets the tracker record automation without letting the record itself grant
submission authority. Read [Apply](../user/apply.md) before enabling any
employer-facing capability.

## Use JobCtrl As Your Local Tracker

Explore the complete interface with synthetic data in the
[live demo](https://demo.jobctrl.dev). For a real workspace, install the local
product through [Getting Started](../user/getting-started.md), build your
[Candidate Profile](../user/candidate-profile.md), and start with a bounded
Discover run.

Related reading:

- [Local-first Job Search Automation](local-first-job-search-automation.md)
- [Resume Tailoring Without Fabrication](resume-tailoring-without-fabrication.md)
- [JobCtrl Guides](index.md)
