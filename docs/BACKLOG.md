# Backlog

This is the authoritative roadmap. Keep detailed historical proposals under
`docs/plans/proposed/`; move delivered work to `docs/DELIVERED.md`.

## Local Product Validation

### Frontend/API Parity

- Add event streaming or targeted row patching so lists do not reload wholesale.

### Worker Reliability

- Make every stage update `job_stage_states` through shared helpers.
- Normalize run records for all local actions.
- Add cancellation where practical for queued or running local actions.
- Record generated logs and reports as artifacts.
- Keep dry-run apply behavior covered by tests.

### Data Model Cleanup

- Introduce a stable `jobKey`.
- Separate original job URL from final application URL.
- Reduce reliance on legacy nullable `jobs` columns in read paths.
- Ensure artifact records are created before files are shown or opened in the UI.
- Split employer/company from source board in the job model so Greenhouse,
  LinkedIn, Talent.com, and direct employer records do not overload `site`.
- Index normalized scoring keywords per job, expose keyword filters/search, and
  add aggregate views or plots for keyword distribution across the pipeline.

### Scoring Intelligence

- Replace raw score reasoning strings with an explanatory score breakdown that
  shows why a job received its exact fit score.
- Let the user correct a job fit score, store the correction and rationale, and
  use that feedback to personalize scoring for the remaining jobs based on
  relevant signals to be defined.

### UI Quality

- Spike the best long-term resume rendering path. Evaluate whether to keep
  LaTeX as the PDF source of truth, switch to Tectonic, replace LaTeX with a
  different document engine such as Typst, or move to an HTML/CSS paged-media
  renderer. The spike should compare PDF fidelity, browser preview quality,
  editable profile UX, local packaging, performance, generated artifact
  compatibility, and migration cost.
- Add React tests for persisted profile field save/discard behavior.
- Add React tests for artifact open behavior.
- Add browser smoke coverage for action buttons and action status polling.
- Preserve user filters, sort, page, and selection during live updates.
- Add side-by-side artifact comparison in the app, including AI-assisted
  comparison for resume and cover-letter variants.

## SaaS And Commercialization

These items are intentionally deferred until local validation is solid.

### Hosted Product

- Multi-tenant account model.
- Authentication and authorization.
- Subscription billing and entitlement checks.
- SaaS admin and support tooling.
- Hosted deployment architecture.

### Hosted Data

- Postgres migration plan.
- Object storage for generated artifacts.
- Encrypted secret vault.
- Audit log.
- Data retention policy.
- Export and deletion workflows.

### Hosted Automation

- Hosted browser isolation.
- Worker fleet orchestration.
- Queue service.
- Per-tenant concurrency and rate limits.
- Policy controls for auto-apply and CAPTCHA-adjacent behavior.

### Packaging And Distribution

- Signed local desktop package.
- Auto-update channel.
- License/entitlement check in the local app.
- Clear local/cloud boundary in user-facing documentation.
