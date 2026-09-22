# JobCtrl Agent Instructions

## Workflow

Use a dedicated task branch/worktree, preserve unrelated dirty work, and use
Conventional Commits. Merge, release, deployment and external communication
still require the user's scoped authorization. For project verification
requirements, use `docs/local-reliability-qa.md`.

## Reference Routing

Start with `docs/README.md`, then read only the owning reference:

- Product/setup/safety: `README.md`, relevant `docs/user/` page.
- Contributor commands: `docs/local-development.md`.
- API/JSON-RPC/SSE: `docs/local-ts-api.md`.
- Architecture: relevant `docs/architecture/` page; amend `docs/requirements.md`
  or `docs/decisions.md` only when its contract changes.
- Plans: relevant active `docs/plans/` file; implemented plans are history.
- Dependencies/scripts: `package.json`, `workers/automation/pyproject.toml`.
- Web changes: also read `apps/web/AGENTS.md`.

Standalone capabilities update every owning document.

## Local Runtime And Data

Always invoke pnpm through `corepack pnpm`. Prefer attached `corepack pnpm dev`
and keep its terminal alive. Use `dev:start` only for an explicitly detached
stack. A blocked probe does not prove a service is down: corroborate supervisor
status with an independent listener/process check before changing runtime.

Never submit applications, run auto-apply, or perform destructive profile/database
operations without explicit authorization. Use owned synthetic QA workspaces.
Never commit or disclose credentials, profile facts, resumes, generated materials,
PDFs, browser profiles, logs, SQLite databases, or private campaign/strategy data.

For evidence, rationale, scoring, tailoring or approval defects, read and enforce
`docs/developer/qa/regression-catalog.md#Auditability-Checks` before editing.
Trace the claim to its canonical source, fix the owning layer, and reproduce the
reported invariant. Preserve the last accepted artifact during failed refreshes;
cosmetic masking never proves a fix.
