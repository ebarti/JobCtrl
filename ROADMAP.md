# Roadmap

This roadmap is the public, contributor-facing view. The detailed engineering
backlog lives in [docs/backlog.md](docs/backlog.md), and delivered work is
archived in [docs/delivered.md](docs/delivered.md).

## Now

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

- Improve workflow-run parity for non-apply pipeline stages so Discover,
  preparation, and Apply have one consistent run history and cancellation model.
- Reduce broad SSE invalidation with targeted cache patches for jobs, artifacts,
  and dashboard projections.
- Finish data-model cleanup around URL-shaped job identifiers, projection
  fallbacks, source/employer persistence, and searchable scoring keywords.
- Strengthen frontend tooling: linting, dependency-boundary checks, type-level
  tests, Playwright e2e in CI, and visual regression from Storybook or the docs
  screenshot flow.
- Add saved table views and column-visibility preferences for high-density job
  and source-review workflows.

## Later

- Package the local app for easier desktop installation and updates.
- Add export/import flows for local workspaces and generated artifacts.
- Design hosted deployment only after the local product loop is reliable:
  authentication, tenant isolation, Postgres, object storage, managed workflow
  services, secret vaulting, hosted browser isolation, audit logs, retention, and
  billing.
- Revisit cloud frontend adapters such as TanStack Start, authenticated sessions,
  hosted event streams, and CDN-cached projection reads when public deployment
  becomes a concrete goal.
