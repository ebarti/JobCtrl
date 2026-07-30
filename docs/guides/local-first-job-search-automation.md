---
description: "Learn how local-first job search automation keeps your profile, jobs, resumes, and workflow history on your computer while preserving useful integrations."
---

# Local-first Job Search Automation

Local-first job search automation means the application, working database, and
generated files live on your computer, while network access is limited to the
features you choose to run. JobCtrl uses that model so a job search can be
automated without making a vendor-hosted account the owner of your career data.

## What “Local-first” Means In JobCtrl

JobCtrl runs as a small local system: a web app, a local TypeScript API, a
Python worker, Temporal (the workflow engine), SQLite, and a directory of
generated artifacts. The normal workspace is under `~/.jobctrl/`. There is no
JobCtrl account and no hosted JobCtrl backend required to use the product.

That gives the local installation several concrete responsibilities:

| Responsibility | Local source of truth |
| --- | --- |
| Candidate facts, preferences, and application answers | Versioned Candidate Profile rows in SQLite |
| Discovered jobs, source observations, scores, and outcomes | The local `jobctrl.db` database |
| Tailored resumes, cover letters, and previews | Registered files in the local JobCtrl workspace |
| Workflow progress, retries, and cancellation | The local Temporal runtime plus durable JobCtrl projections |
| Non-secret product settings | SQLite or `config.json`, according to the owning setting |
| Provider credentials | The documented environment, CLI, or OS-backed secret boundary—not browser-readable settings |

The exact inventory, retention rules, and credential boundaries live in
[Data, Privacy & Safety](../user/data-and-safety.md) and
[Configuration](../user/configuration.md).

## Local-first Does Not Mean Offline

A useful job-search tool still needs to communicate with the outside world.
Discovery fetches job sources. Enrichment may open a managed browser. Scoring
or writing features call a model provider you configured. A live application
contacts an employer only through the guarded Apply paths you invoke.

The important distinction is control and ownership:

- you start a run, or explicitly enable a local schedule;
- the selected feature makes the network requests it needs;
- accepted jobs, evidence, materials, and workflow state return to local
  storage;
- optional product telemetry is disabled unless you configure it;
- documentation-site analytics have their own consent choice and are not part
  of the installed product.

So “local-first” is not a promise that every operation happens without a
network. It is a promise that the product does not require a hosted JobCtrl
data plane to own and operate your job search.

## Why Automation Needs Durable Local Workflows

Job discovery and preparation are not one request. One run may search several
sources, capture postings, enrich descriptions, analyze requirements, score
fit, create materials, render files, and wait for review. A laptop can sleep,
a provider can fail, or a worker can restart while that sequence is running.

JobCtrl routes long-running work through Temporal instead of hiding it in a
browser tab or an in-process loop. Stable workflow identities, bounded retries,
cancellation, and persisted stage events let the Runs and Pipelines surfaces
show what happened. Broad-board discovery checkpoints each search unit, so an
interrupted execution can resume unfinished work without pretending the entire
run never started.

This does not make every failure disappear. It makes failure a state you can
inspect rather than an invisible partial side effect. The exact runtime,
recovery, and concurrency contracts are documented in
[Runtime & Processes](../architecture/runtime.md) and
[Temporal Workflows](../architecture/pipeline/index.md).

## The Human Still Owns Risky Decisions

Local execution is only one part of responsible automation. JobCtrl also keeps
high-impact actions behind explicit boundaries:

- scores link back to requirement and profile evidence so you can challenge
  them;
- generated candidate claims must come from the Candidate Profile, not from a
  job description;
- a failed re-tailor does not erase the last accepted resume;
- dry runs cannot submit;
- model-driven browser work stops before final browser submission, which
  remains manual;
- the separate Gmail sender rechecks the exact approved recipient and
  attachment and records submit intent before sending;
- ambiguous submit outcomes stop for verification instead of retrying blindly.

Read [Apply](../user/apply.md) for the current browser and email boundaries and
[Security](../user/security.md) for the enforcement points.

## Who This Model Fits

Local-first automation is a good fit when you want a capable workflow but also
want to inspect storage, source code, model decisions, and submission history.
It is especially useful if your profile and application archive should remain
portable rather than trapped in a hosted account.

It also has tradeoffs. Your machine runs the services. You choose and pay for
any external model providers you enable. You are responsible for backups, local
access, and reviewing employer-facing work. A hosted service may require less
local operation; JobCtrl deliberately chooses user control over that
convenience.

## Try The Workflow

The [live demo](https://demo.jobctrl.dev) uses synthetic data and cannot contact
external services. To run the real local product, follow
[Getting Started](../user/getting-started.md). Then use the
[Daily Workflow](../user/normal-flows.md) to move from a versioned profile
through discovery, evidence review, truthful materials, and supervised Apply.

Related reading:

- [Open-source Job Application Tracker](open-source-job-application-tracker.md)
- [Resume Tailoring Without Fabrication](resume-tailoring-without-fabrication.md)
- [JobCtrl Guides](index.md)
