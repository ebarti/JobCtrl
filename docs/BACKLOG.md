# Backlog

This is the authoritative roadmap. Keep detailed historical proposals under
`docs/plans/proposed/`; move delivered work to `docs/DELIVERED.md`.

## Local Product Validation

### Frontend/API Parity

- Add profile/style write endpoints to the TypeScript API.
- Move artifact opening from the Python dashboard server to the TypeScript API.
- Move profile PDF import from the Python dashboard server to the TypeScript
  API action surface.
- Replace Python dashboard-only profile/style persistence checks with React
  end-to-end checks once the React write path exists.
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

### UI Quality

- Add React tests for profile field save/discard once persistence exists.
- Add React tests for artifact open once API support exists.
- Add browser smoke coverage for action buttons and action status polling.
- Preserve user filters, sort, page, and selection during live updates.

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
