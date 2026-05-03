# Job State Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add explicit per-job pipeline state and an operations dashboard that shows stuck, failed, blocked, ready, and applied jobs without requiring SQLite inspection.

**Architecture:** SQLite owns durable state in normalized `job_stage_states`, `job_events`, and `job_artifacts` tables. The dashboard is still a static generated HTML file, but it receives a structured JSON payload derived from explicit state where available and legacy `jobs` columns as fallback.

**Tech Stack:** Python 3.11, Typer, SQLite, Rich, static HTML/CSS/JavaScript generated from `src/jobhunter/view.py`.

---

### Task 1: State Schema And Helpers

- [x] Add migration-safe state tables in `src/jobhunter/database.py`.
- [x] Add `src/jobhunter/state.py` with stage constants, transition helpers, legacy state synthesis, dashboard payload helpers, and event/artifact recording.

### Task 2: Pipeline And Bug Fixes

- [x] Prevent dry-run apply from persisting `applied`.
- [x] Make apply subprocess timeout enforceable while stdout is open.
- [x] Let streaming stages process pending work while upstream is still running.
- [x] Leave failed enrichment retryable instead of marking it scraped.
- [x] Require tailored resumes for cover letters.
- [x] Restrict batch PDF conversion to cover-letter artifacts instead of directory-globbing resumes.
- [x] Fix targeted apply selection for `NULL` apply status.

### Task 3: Ops Dashboard

- [x] Replace the old score-card dashboard with a static operations console following the `handoff_from_design` visual direction.
- [x] Embed a JSON data contract with funnel, triage, ready queue, activity, apply runs, and per-job drawer details.
- [x] Add filters, sorting, deep-link drawer, copyable CLI commands, artifact lists, and legacy fallback notices.

### Task 4: Regression Tests

- [x] Add tests for legacy state synthesis and state-table migration.
- [x] Add tests for targeted apply NULL handling and dry-run result handling.
- [x] Add tests for PDF conversion target selection.
- [x] Add a dashboard rendering smoke test.

### Task 5: Verification

- [x] Run Ruff.
- [x] Run pytest.
- [x] Run release checks or build where practical.
