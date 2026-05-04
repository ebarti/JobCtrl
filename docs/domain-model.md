# Domain Model

This document defines JobHunter's core domain language and ownership
boundaries.

## Bounded Contexts

### Job Acquisition

Owns finding job postings and creating canonical job records.

Primary concepts:

- `Job`
- `Source`
- `SearchStrategy`
- `JobUrl`
- `ApplicationUrl`

### Pipeline State

Owns operational truth for where a job is in the workflow.

Primary concepts:

- `Stage`
- `StageState`
- `Attempt`
- `BlockedReason`
- `NextAction`
- `RetryPolicy`

Canonical stages:

```text
discover -> enrich -> score -> tailor -> cover -> pdf -> apply
```

Canonical states:

```text
pending
queued
running
succeeded
failed
blocked
skipped
exhausted
canceled
stale
```

### Candidate Profile

Owns the user's reusable career data and resume styling inputs.

Primary concepts:

- `Profile`
- `ApplicationDefaults`
- `ResumeBaseline`
- `ExperienceEntry`
- `EducationEntry`
- `SkillCategory`
- `TailoringPolicy`
- `WritingStyle`
- `ResumeTemplate`

Profile data is stored locally in `profile.json`; style and LaTeX template data
are stored in local style/template files.

### Materials Generation

Owns generated application artifacts.

Primary concepts:

- `TailoredResume`
- `CoverLetter`
- `ResumePdf`
- `CoverLetterPdf`
- `Template`
- `Artifact`

Artifacts should be recorded in `job_artifacts` before the UI can show or open
them.

### Apply Automation

Owns local browser automation for application submission.

Primary concepts:

- `ApplyRun`
- `DryRun`
- `SubmissionResult`
- `ScreeningAnswer`
- `BrowserWorker`
- `ApplyLog`

Dry runs must never mark jobs as applied.

### Operations UI

Owns the user's live control surface.

Primary concepts:

- `DashboardSummary`
- `JobList`
- `JobDrawer`
- `ActionButton`
- `ActionStatus`
- `EventLog`

The UI should show actionable stage state and should not require direct SQLite
inspection.

## Aggregates

### Job Aggregate

Root: `Job`

Owns:

- source identity
- title/company/location metadata
- discovered and enriched job description data
- stage states
- events
- artifacts
- apply status

The job URL remains the current compatibility key. The target model should add
a stable `jobKey` so original job URL and application URL can differ safely.

### Profile Aggregate

Root: `Profile`

Owns:

- personal information
- application defaults
- resume baseline
- experience entries
- education entries
- skill categories
- tailoring controls
- writing style controls

The profile editor should present structured form fields, not raw JSON, even
though local persistence remains JSON.

### Action/Run Aggregate

Root: `LocalAction` or `Run`

Owns:

- requested action
- target job or stage
- status
- timing
- stdout/stderr or structured output
- error information
- resulting events and artifacts

## Ownership Rules

- The UI owns interaction state, not workflow truth.
- `job_stage_states` owns pipeline truth once a stage has explicit state.
- Legacy nullable `jobs` fields are compatibility inputs, not the long-term
  operational model.
- Python workers own external automation and LLM calls.
- The TypeScript API owns product-facing JSON contracts.
- Local file paths are sensitive and should only be exposed where needed for
  local operation.
