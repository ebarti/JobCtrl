# JobCtrl Agent Instructions

## Workflow

Before responding or taking task action, read the installed `using-devflow`
entry skill and its applicable stage. Reapply routing when intent changes.
Design discussion uses its method without starting work. A direct work request,
concrete bug report, named issue or bounded batch authorizes its scope without
another approval step.

For configured maintainer work, use the immutable pin in
`.devflow/workflow.lock` and `scripts/devflow` for workflow commands. Run
`doctor --json`; resolve the selected stage with `skill resolve`, including the
existing work ID for continuation. Definition, planning, coordination,
implementation, review, verification and delivery are separate skills. `next`
names the skill owning each action. Read only that stage and its needed resources.

The original conversation coordinates bounded implementation/repair and
independent review/QA subagents. Verify identity and resolved settings before
activation. Persist implementation completion before registered verification and
every independent PASS/FAIL/BLOCKED before repair or rerun. Reuse the same work,
attempt and available roles; reconcile uncertain actions before retrying.
Devflow owns the lifecycle. Missing capability is a diagnostic, never a passing
gate. Setup, version and recovery boundaries: `docs/developer/workflow.md`.

Public contributors and clients without the workflow host use `CONTRIBUTING.md`
and the same product/check requirements. `CLAUDE.md` remains linked here; the
host-specific subagent bridge does not become a requirement to use JobCtrl.

Use a dedicated task branch/worktree, preserve unrelated dirty work, and use
Conventional Commits. Merge, release, deployment and external communication
still require the user's scoped authorization. Preserve the user's model
settings and explicit role overrides. For checks and required independent gates,
use `docs/local-reliability-qa.md`.

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

Standalone capabilities update every owning document. Approved unreleased stacks
may defer canonical docs and cumulative product QA to the final PR; active
high-risk paths retain their immediate documentation and verification gates.

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
