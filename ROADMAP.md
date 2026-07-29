# Roadmap

This roadmap is the public, contributor-facing view. The detailed engineering
backlog lives in [docs/backlog.md](docs/backlog.md); delivered work is
recorded in the git log and in [docs/plans/implemented/](docs/plans/implemented/).

## Now

- Operate and harden the native Apple-silicon distribution: keep the signed
  curl and Homebrew channels aligned to one immutable release, preserve
  update/rollback safety, and monitor clean-machine installation evidence.
- Tighten public documentation for local-first setup, configuration, normal
  flows, safety boundaries, and architecture onboarding.
- Keep the local stack reliable: Temporal dev server, TypeScript API, Vite web
  app, Python worker, SSE updates, and projection-backed read models.
- Continue hardening high-risk workflows: discovery preparation, resume
  tailoring evidence, Apply Review draft promotion, dry-run apply, retries,
  cancellation, and generated artifact inspection.
- Keep screenshot and QA fixtures synthetic so public docs can be refreshed
  without exposing real job-search data.

## Next

- **Planned — native cross-platform secret stores.** Add Windows Credential
  Manager and Linux Secret Service/keyring adapters with parity to the shipped
  macOS Keychain path: the same allowlisted provider settings, explicit
  environment precedence, presence-only API responses, restart-to-activate
  lifecycle, bounded failure behavior, and no secret values in logs or HTTP.
  Completion requires mocked adapter contract tests plus read/write/delete host
  validation on supported Windows and Linux runners.
- Improve workflow-run parity for non-apply pipeline stages so Discover,
  preparation, and Apply have one consistent run history and cancellation model.
- Reduce broad SSE invalidation with targeted cache patches for jobs, artifacts,
  and dashboard projections.
- Finish data-model cleanup around URL-shaped job identifiers, projection
  fallbacks, source/employer persistence, and searchable scoring keywords.
- Complete the auditable user-feedback learning loop: unify shipped score
  calibration and approved role-match exclusions with structured
  tailoring-review feedback, preserve provenance-backed signals, and require an
  explicit user action before a versioned policy or preference changes.
  Outcome associations remain sample-gated and non-causal.
- Strengthen frontend tooling: linting, dependency-boundary checks, type-level
  tests, Playwright e2e in CI, and visual regression from Storybook or the docs
  screenshot flow.
- Add saved table views and column-visibility preferences for high-density job
  and source-review workflows.

## Later

- Extend the bundled distribution to additional platforms after the
  Apple-silicon release has enough field evidence to carry the same signing,
  update/rollback, and clean-machine guarantees forward.
- Add export/import flows for local workspaces and generated artifacts.
- Design hosted deployment only after the local product loop is reliable:
  authentication, tenant isolation, Postgres, object storage, managed workflow
  services, secret vaulting, hosted browser isolation, audit logs, retention, and
  billing.
- Revisit cloud frontend adapters such as TanStack Start, authenticated sessions,
  hosted event streams, and CDN-cached projection reads when public deployment
  becomes a concrete goal.
