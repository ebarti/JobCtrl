# Delivered

This is the per-PR delivery archive. It records what changed and where to find
the detailed implementation plan or QA notes.

## 2026-04-29: Job State Dashboard

Plan: `docs/plans/implemented/2026-04-29-job-state-dashboard.md`

Delivered:

- normalized job stage state tables
- event and artifact recording helpers
- operations dashboard data contract
- retryable stage model
- regression coverage for dry-run apply, apply timeout, targeted apply, PDF
  target selection, cover-letter requirements, and dashboard rendering

## PR #8: Local TypeScript API Scaffold

Plan: `docs/plans/implemented/2026-05-02-local-ts-api.md`

Delivered:

- `services/api` Fastify API scaffold
- `packages/contracts` shared schemas and typed client
- local SQLite read endpoints for health, dashboard, jobs, artifacts, profile,
  and settings
- API host loopback validation
- pagination, filtering, and global sorting for list endpoints

## PR #9: React Frontend Shell

Delivered:

- `apps/web` React/Vite app
- dashboard, jobs, artifacts, and profile views
- typed client usage through `@jobhunter/contracts`
- web typecheck/build included in `npm test`
- request staleness guards and visible load errors
- filter/page reset behavior for list views

## PR #10: Canonical Stage State

Delivered:

- `job_stage_states` preferred as dashboard truth
- legacy state materialization and placeholder hydration
- targeted backfill instead of broad state-table scans
- discover placeholder correction for old rows

## PR #11: Local Action Entrypoints

Delivered:

- `jobhunter action ...` command surface
- structured local action result model
- JSON-safe failure handling around runtime bootstrap and event writes
- profile PDF import action support
- effective apply limit handling

## PR #12: Structured Dashboard Actions

Delivered:

- local UI retry/stage/apply buttons routed through structured actions
- copyable CLI commands retained
- long-running local actions queued in background threads
- action status polling for long-running local commands

## PR #13: Local Reliability QA Gate

Plan: `docs/plans/implemented/2026-05-03-local-reliability-qa.md`

Delivered:

- repeatable local reliability command checklist
- regression matrix for high-risk local workflows
- React browser smoke checklist
- React/API product checks for artifact opening, profile/style save, discard,
  and resume PDF import drafts

## 2026-05-03: Local TS Product API + Python Workers Architecture

Plan: `docs/plans/implemented/2026-05-01-ts-product-api-python-workers-architecture.md`

Delivered:

- TypeScript API structured job action endpoints for retry, material
  generation, dry-run apply, cancel, mark-applied, and mark-skipped
- safe artifact-open action for known local artifacts only
- profile/style/template writes and resume-import draft endpoint through the
  typed API
- React job drawer action buttons, artifact open controls, and persistent
  profile save/discard/import controls
