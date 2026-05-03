## Reference Index

Use these repository documents before making architectural, workflow, or QA decisions:

- `README.md`: user-facing product behavior, CLI commands, runtime requirements, generated local artifacts, and safety notes.
- `docs/local-reliability-qa.md`: local QA checklist, regression matrix, and known high-risk workflows that need test coverage.
- `docs/local-ts-api.md`: local TypeScript API, web app development commands, API/web verification, and dashboard migration context.
- `docs/ts-product-api-python-workers-architecture.md`: target architecture for TypeScript API plus Python workers, local-first boundaries, and phased migration constraints.
- `package.json`: current TypeScript/API/web scripts.
- `pyproject.toml`: Python package metadata, CLI entry point, Python version, optional dev dependencies, and Ruff config.

## How To Run The Project

To be defined as a complete, single source of truth. Until this is finalized, infer the narrowest correct run command from the referenced docs and package metadata, then state the command before running it.

Known local commands:

- Python CLI: `uv run jobhunter doctor`, `uv run jobhunter run`, or targeted `uv run jobhunter <command>` after dependencies are installed.
- TypeScript API: `npm run api:dev`.
- Web app: `npm run web:dev`.
- Web preview after build: `npm run web:preview`.

Do not run auto-apply, browser submission, destructive profile/database actions, or commands that submit applications unless the user explicitly asks for that behavior.

## Build, Test, And Lint Commands

The unit-test and QA command set must be made explicit as the project evolves. Until a stronger command matrix exists, use the following defaults and narrow them to the touched surface when appropriate:

- Full TypeScript/API/web verification: `npm test`.
- TypeScript API typecheck: `npm run api:check`.
- TypeScript API tests: `npm run api:test`.
- Web build: `npm run web:build`.
- Python tests: `uv run pytest -q`.
- Python lint: `uv run ruff check .`.
- Python package build: `uv run python -m build`.

When changing behavior, add or update unit tests for the changed logic. When changing user-facing behavior, local API behavior, browser flows, or UI/UX, include a QA stage that exercises the product path, not only unit tests.

Any major UI/UX regression found by the human must become a QA regression test or an explicitly documented QA checklist item before the work is considered complete.

## Agent Behavior

- Do not resolve material ambiguity by assumption. Ask for clarification when the goal, scope, constraints, or expected validation are unclear.
- If a reasonable assumption is low-risk and needed to make progress, state it explicitly before acting.
- Treat payloads, local generated artifacts, and job/application data as sensitive. Do not expose secrets, profile data, API keys, resumes, cover letters, generated PDFs, browser profiles, SQLite databases, or application logs unless the user explicitly requests them.
- Prefer repo-grounded answers and edits over generic advice. Check the referenced docs and current code before making architectural claims.

## Engineering Conventions And PR Expectations

- PR titles must follow Conventional Commits.
- Commit messages must follow Conventional Commits.
- PR descriptions must clearly and unambiguously explain what changed, why it changed, and how it was validated.
- Keep changes as small as possible while still fully satisfying the goal.
- Use stacked PRs when functionality builds on prior functionality or when a large change should be broken into reviewable steps.
- Every implementation task must be developed in its own worktree on the relevant branch.
- Never edit code on `main` or leave `main` dirty.
- Always ensure `main` is fetched and pulled before creating a worktree.
- Before coding, confirm the current branch/worktree. If you are on `main`, stop and create or switch to the correct worktree first.
- Do not remove existing compatibility behavior unless the assigned goal explicitly authorizes that breaking change.

Recommended worktree setup:

1. From the main checkout, ensure no unrelated dirty changes block setup.
2. Run `git fetch origin main`.
3. Update main with `git switch main` and `git pull --ff-only origin main`.
4. Create a task branch and worktree with `git worktree add <worktree-path> -b <branch-name> main`.
5. Do all coding, testing, commits, and PR work from that task worktree.

## Development Sequencing

Parallelize any work that can be parallelized, but all work must still follow the development workflow and preserve clear ownership boundaries.

For non-trivial implementation work, the parent agent owns orchestration, loop state, and final gate decisions. Do not delegate the entire loop unless the user explicitly asks for recursive delegation. Specialist agents must not spawn subagents unless the parent explicitly instructs them to.

Start implementation by spawning `pr-feature-implementer` with the exact goal, allowed scope, files or modules owned, verification commands, and PR expectations. The implementer should create the PR and report the PR number.

Run the PR review/fix loop for at most 3 iterations:

1. Spawn `pr-reviewer` on the PR. The reviewer must inspect the target diff/worktree and return the machine-gated final format from its agent definition.
2. If `pr-reviewer` returns `Gate: PASS`, continue to QA.
3. If `pr-reviewer` returns `Gate: FAIL`, spawn `pr-fixer` with only the unresolved Blocker and High findings unless the parent intentionally includes lower severities.
4. After `pr-fixer` finishes, repeat the review step.
5. If Blocker or High findings remain after 3 PR fixer attempts, stop and report `Blocked` with the remaining findings unless the user explicitly authorizes continuing with known unresolved risk.

Run the QA loop after the PR review gate passes:

1. Spawn `qa` with the PR goal, PR number, reviewer summary, changed surfaces, and required product-level checks.
2. If `qa` returns `Gate: PASS`, end the workflow.
3. If `qa` returns `Gate: FAIL`, spawn `qa-fixer` with only the unresolved Blocker and High QA findings unless the parent intentionally includes lower severities.
4. After `qa-fixer` finishes, repeat the QA step.
5. If Blocker or High QA findings remain after 3 QA fixer attempts, stop and report `Blocked` with the remaining findings instead of marking the work complete.

End only when both the PR review gate and QA gate return `PASS`. The final response must include the PR number, review/QA gate results, verification commands and results, and any remaining Medium or Low risks.


## Plan Docs (Superpowers Output)

Save feature plan/spec output under `docs/plans/`, NOT the default
`docs/superpowers/`.

- **Default rule:** keep one document per feature/change.
- Put the plan/spec in `docs/plans/proposed/YYYY-MM-DD-<topic>.md`.
- **If the changeset you are creating implements the feature completely**, move that same file to
  `docs/plans/implemented/`.
- If a proposed document is no longer active and did not ship as written,
  move it to `docs/plans/archived/` instead of rewriting it in place.
  Archived plans are historical context, not backlog.
- If you need plan/checklist content, fold it into the same document under
  its own section instead of creating a separate `*-plan.md` file.

This overrides the superpowers defaults. Do NOT create `docs/superpowers/`
directories. Do NOT create both a plans doc and a separate plan doc for the
same feature by default.

## Constraints And Do-Not Rules

- Never edit code in the main branch.
- Never leave `main` dirty.
- Never create a worktree from stale `main`; fetch and pull first.
- Never mark work complete while Blocker or High PR review findings remain.
- Never mark work complete while Blocker or High QA findings remain.
- Never skip the QA stage for user-facing UI/API/product-flow changes.
- Never broaden scope silently. If the correct fix exceeds the assigned scope, stop and raise the scope issue.
- Never commit local secrets, generated user data, resumes, cover letters, PDFs, browser profiles, worker directories, logs, or SQLite databases.

## What Done Means And How To Verify Work

Done means the user's instruction or goal has been fully achieved, the changeset is as small as practical, and the work has passed the required implementation, review, and QA gates.

Before calling work done:

1. Confirm the work happened in a dedicated worktree and not on `main`.
2. Confirm the goal and acceptance criteria are satisfied.
3. Run the relevant build, lint, unit-test, and QA commands for the touched surfaces.
4. Run the PR review/fix loop until `pr-reviewer` returns `Gate: PASS` or the workflow is explicitly blocked.
5. Run the QA loop until `qa` returns `Gate: PASS` or the workflow is explicitly blocked.
6. Report exact commands, exact results, PR number, unresolved Medium/Low risks, and any skipped verification with a concrete reason.

If any required verification cannot be run, the final status is not done. Report it as blocked or partially verified and explain what remains.
