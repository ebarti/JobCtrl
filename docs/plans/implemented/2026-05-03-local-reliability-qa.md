# Local Reliability QA

This checklist is the Phase 7 gate for the local-first architecture stack. It
keeps the validation focused on local automation reliability before SaaS
hardening.

## Required Commands

Run these before merging the Phase 7 stack branch:

```bash
npm test
npm run qa:test
uv run pytest -q
git diff --check
```

For browser smoke, run the local TypeScript API and React app, then verify the
dashboard, jobs, artifacts, and profile views load against the local SQLite
database:

```bash
npm run api:dev
npm run web:dev -- --port 5173
```

Open the URL printed by Vite. It is usually `http://127.0.0.1:5173`, but Vite
can choose a different port when 5173 is already in use because the web dev
server does not run with `strictPort`.

For destructive browser QA, seed a disposable workspace and point both servers
at it:

```bash
npm run qa:seed -- /tmp/jobhunter-qa
JOBHUNTER_DIR=/tmp/jobhunter-qa npm run api:dev
VITE_JOBHUNTER_API_BASE_URL=http://127.0.0.1:8766 npm run web:dev -- --port 5173
```

The seed includes active and failed jobs, deleted-job workflows, artifacts,
missing files, apply runs, dashboard events, profile files, settings, and a
safe local artifact directory.

## Reliability Matrix

| Risk | Validation | Coverage |
| --- | --- | --- |
| Dry run marks a job applied | `mark_result(..., "dry_run")` leaves `applied_at` empty and records apply as skipped. | `tests/test_apply_regressions.py::test_dry_run_result_does_not_mark_job_applied` |
| Apply agent hangs while stdout stays open | `run_job` times out while a child process is silent but still alive, then kills the process. | `tests/test_apply_regressions.py::test_run_job_timeout_stops_silent_stdout_hang` |
| Targeted apply skips fresh jobs | Targeted apply can claim jobs where `apply_status` is `NULL`. | `tests/test_apply_regressions.py::test_targeted_apply_acquires_job_with_null_apply_status` |
| Stages cannot be retried individually | Retry clears legacy fields and resets only the requested stage state. | `tests/test_state_dashboard.py::test_retry_command_resets_stage_state` |
| Enrichment failures become terminal | Legacy enrichment failures are retryable and block downstream stages instead of being treated as done. | `tests/test_state_dashboard.py::test_legacy_state_marks_enrichment_failure_retryable` |
| Legacy fields override explicit state | Explicit `job_stage_states` rows drive UI/API truth over legacy success columns. | `tests/test_state_dashboard.py::test_explicit_stage_state_overrides_legacy_success` |
| Placeholder stage rows hide actual progress | Old placeholder state rows are upgraded from legacy columns. | `tests/test_state_dashboard.py::test_placeholder_stage_rows_are_upgraded_from_legacy_columns` |
| PDF conversion publishes stray files | PDF conversion uses DB-backed cover-letter targets, not directory scans. | `tests/test_pdf_targets.py::test_pending_pdf_targets_only_include_db_cover_letters` |
| Cover letters use the wrong resume | Cover generation requires a tailored resume instead of falling back silently. | `tests/test_cover_requirements.py::test_cover_generation_requires_tailored_resume` |
| Profile PDF import corrupts defaults | Resume PDF import builds structured profile data while preserving application defaults and tailoring controls. | `tests/test_profile_import.py::test_profile_from_resume_text_builds_structured_profile_and_preserves_application_defaults` |
| Style PDF import is opaque | Resume PDF import maps PDF metadata into editable style controls. | `tests/test_profile_import.py::test_style_from_pdf_metadata_infers_editable_style_controls` |
| Jobs list overloads the UI | List APIs paginate after applying global filters and sorting. | `services/api/test/server.test.ts` |
| Filters reset while editing | The React frontend has no automatic list polling; list refresh is explicit through the refresh button or filter changes. | Browser smoke |
| Generated artifacts cannot be opened safely | The TypeScript API only opens known local artifact paths, and the React UI routes artifact buttons through that API. | `services/api/test/server.test.ts` and browser smoke |
| Profile/style save and discard flows regress | The TypeScript API persists profile/style/template changes, and the React UI exposes save, discard, and resume-import draft controls. | `services/api/test/server.test.ts` and browser smoke |
| Destructive UI workflows need safe data | A disposable seeded QA workspace exercises soft delete/restore, artifact open/missing handling, profile/settings saves, credentials, and dashboard filtering without touching the user's real local database. | `services/api/test/qa-workflow.test.ts` and browser smoke against `npm run qa:seed` |

## React Browser Smoke

Use the in-app browser or Playwright against the Vite URL printed by
`npm run web:dev`:

1. Confirm the API indicator shows live.
2. Open dashboard, jobs, artifacts, and profile views.
3. Filter jobs by text, stage, and state. Change pages, then use refresh and
   confirm the selected filters remain in place.
4. Sort jobs by fit score and title. Confirm results come from the API and are
   not just sorting the visible page.
5. Open a job drawer from jobs and artifacts.
6. Open the profile view and edit a field. Confirm field-level draft controls
   appear, save persists through the API, and discard restores the previous
   value before saving.

Do not move this stack into SaaS hardening until the automated commands pass
and the manual browser smoke is clean.
