# Daily Workflow

This is your daily loop with JobHunter: set up once, then repeat Discover →
review → Apply. The web app is the main way you work; the command line stays
available for maintenance and diagnostics. For a screen-by-screen walkthrough of
each page below, see the [Product Tour](screenshots.md).

```mermaid
flowchart TD
  subgraph Setup["One-time setup"]
    Profile["Create your profile"] --> Configure["Configure discovery targets"]
  end
  subgraph Loop["The daily loop"]
    Discover["Discover finds, scores, and<br/>prepares materials for jobs"]
    Review["You review jobs and scores"]
    ApplyReview["You edit and approve<br/>materials in Apply Review"]
    DryRun["A dry run rehearses<br/>the application"]
    Submit["You approve the<br/>live submission"]
    Discover --> Review --> ApplyReview --> DryRun --> Submit
    Submit -. "next batch" .-> Discover
  end
  Configure --> Discover

  classDef you fill:#dbeafe,stroke:#2563eb,color:#0f172a
  classDef auto fill:#d1fae5,stroke:#059669,color:#064e3b
  class Profile,Configure,Review,ApplyReview,Submit you
  class Discover,DryRun auto
```

*Blue steps are yours; green steps are JobHunter's. Setup happens once, the
loop repeats. Under the hood, Discover runs Enrich, Score, and Materials for
each eligible job — and the dry run is the recommended rehearsal, not an
enforced prerequisite.*

## 1. Build The Candidate Profile

Use the Profile page or the resume import flow to create structured profile data.
The profile includes personal details, work authorization, experience,
education, skills, target search preferences, writing style, resume rendering
settings, and tailoring controls. It is the source of truth every later stage
scores and tailors against.

Profile and settings forms autosave after a short delay. The explicit Save
buttons use the same save path.

![JobHunter Profile page with personal information, resume baseline, experience, and skills](../assets/screenshots/profile.png)
*The Profile page collects personal information, resume baseline, experience, skills, and voluntary equal-opportunity (EEO) fields alongside the baseline resume editor.*

## 2. Configure Discovery

Use the Discovery page to set:

- target roles and role tracks;
- target locations and work models;
- source registry controls;
- minimum fit score and automation preferences;
- manual capture and quarantined source decisions.

Target locations are validated before they can drive discovery. Discovery uses
exact and broader recall role queries, then filters and scores the results
downstream.

![JobHunter Discovery page with target search, seniority floors, job boards, and source registry](../assets/screenshots/discovery.png)
*The Discovery page configures target search, seniority floors, locations and work models, minimum fit score, job boards, and the source registry.*

## 3. Run Discover

From the web app, open the Pipelines page and start `Discover`. From the command
line:

```bash
uv --project workers/automation run jobhunter run discover
```

Starts a Discover run from the terminal — the same workflow the Pipelines page
starts.

![JobHunter Pipelines page configuring a Discover run with dry-run enabled](../assets/screenshots/pipelines.png)
*The Pipelines page starts a Discover run with limit, worker count, and a dry-run toggle.*

Per-stage commands (`jobhunter enrich`, `score`, `tailor`, `cover`) and the
single-job path (`jobhunter job <url> --dry-run`) start the same underlying
workflows when you want a narrower run.

Discover owns the preparation path:

- source crawling or ATS/API fetches;
- detail enrichment;
- scoring;
- tailoring eligibility;
- material generation, or suppression, for eligible jobs.

Internal stages such as Enrich and Score, and material generation (the `tailor`
and `cover` commands), stay visible in job detail and diagnostics, but the
user-facing preparation stage is Discover.

## 4. Review Jobs

The Jobs view supports filters, sorting, pagination, deep links, deleted and
hidden views, fit-score ranges, stage state, source provenance, compensation
evidence, and job detail drawers.

![JobHunter Jobs table with fit scores, companies, and triage actions](../assets/screenshots/jobs.png)
*The Jobs table ranks discovered jobs by fit score with filters, compensation columns, and bulk triage actions.*

Use the job detail drawer to inspect:

- score, confidence, blockers, gaps, and score policy metadata;
- the requirement-fit report when present;
- audit history;
- source and enrichment evidence;
- generated artifacts;
- apply readiness and blockers.

![JobHunter job detail drawer showing score, requirement fit, keywords, and compensation](../assets/screenshots/job-detail.png)
*The job detail drawer shows the audit triage: ranking, requirement fit, matched and transferable requirements, keywords, and compensation evidence.*

Failed preparation work can be retried per job or in bulk without automatically
starting apply automation.

## 5. Generate And Inspect Materials

Eligible jobs receive tailored resumes and cover letters during Discover. You can
also generate materials for a single job from the job detail drawer.

Generated material records are kept as audit history. Re-generation does not
destroy the accepted material already in use; a replacement becomes active only
after it validates and you approve it.

## 6. Review And Edit The Resume

Apply Review opens the generated resume in an in-browser editor. The editor keeps
the final PDF link, the source behind each line, risk flags, JobHunter's line
comments, and your draft together.

![JobHunter Apply Review with tailored resume preview, requirement evidence, and approval controls](../assets/screenshots/apply-review.png)
*Apply Review pairs requirement evidence and the verbatim job post with the tailored resume preview, JobHunter line comments, and approve or dry-run controls.*

Typical review actions:

- edit the generated resume text or formatting;
- reply to JobHunter line comments;
- save or autosave a draft revision;
- validate and render an edited draft into replacement artifacts;
- approve only after the edited draft is saved, valid, and rendered.

Failed validation stays as audit history and does not hide the last accepted
artifact.

## 7. Rehearse With A Dry Run

Apply automation can submit real applications, so start with dry runs:

```bash
uv --project workers/automation run jobhunter apply --dry-run --limit 1
uv --project workers/automation run jobhunter apply --url https://example.com/job/123 --dry-run
```

The first dry-runs Apply for one eligible job; the second dry-runs a specific job
by URL. A dry run never submits — it shows what would happen without sending
anything.

Only approve real submission after inspecting the dry run, final materials,
field mapping, blockers, and apply-run history. The full approval model is on the
[Security](security.md) page.

## 8. Inspect Progress

Useful command-line checks:

```bash
uv --project workers/automation run jobhunter status
uv --project workers/automation run jobhunter runs
uv --project workers/automation run jobhunter runs --failed-only
```

These print your pipeline status, list all workflow runs, and list only failed
runs, respectively.

Useful web app views:

- Dashboard for high-level counts and source health.
- Jobs for triage and per-job actions.
- Runs for workflow history.
- Artifacts for generated files.
- Apply Review for approval and resume edits.
- Debug for event-level inspection.

![JobHunter Runs page listing workflow runs with status and mode](../assets/screenshots/runs.png)
*The Runs page lists workflow runs with status, mode, timing, and a link into the web interface of Temporal, the workflow engine.*
