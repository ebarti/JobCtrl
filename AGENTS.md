## Reference Routing

Start with `docs/README.md`, the canonical documentation map, then read only the
documents that own the behavior being changed. Do not scan the entire reference
tree by default.

- Product behavior, commands, runtime requirements, artifacts, or safety:
  `README.md` and the relevant page under `docs/user/`.
- Contributor workflow and validation: `docs/developer/README.md`,
  `docs/local-development.md`, and `docs/local-reliability-qa.md`.
- API routes, JSON-RPC, or SSE: `docs/local-ts-api.md`.
- Architecture: the relevant page under `docs/architecture/`, plus
  `docs/requirements.md` and `docs/decisions.md` when the contract or decision
  itself changes.
- Plans and status: the relevant active file under `docs/plans/`; use
  `implemented/` only for historical context.
- TypeScript scripts/dependencies: `package.json`; Python package metadata and
  tooling: `workers/automation/pyproject.toml`.

Follow links beyond the owning document only when they are needed to resolve a
specific contract, dependency, or QA risk.

## How To Run The Project

Use `pnpm dev` for the full local development stack. It stops previously tracked JobCtrl process trees for the selected components, then runs the Temporal dev server, TypeScript API, React/Vite web app, and JobCtrl Temporal worker in the foreground so supervised terminals keep the child processes alive. Keep the terminal session open while using the app and stop it with Ctrl-C. Use `pnpm dev:start` only when an explicitly detached background stack is desired in a normal shell.

Known local commands:

- First-run setup: `scripts/install` (guided system checks, including standalone Corepack remediation, plus Node/Python dependencies and Playwright Chromium) or `pnpm dev:setup` (non-interactive dependency sync for already-provisioned machines), then `uv --project workers/automation run jobctrl init` and `uv --project workers/automation run jobctrl doctor`.
- Python CLI: `uv --project workers/automation run jobctrl doctor`, `uv --project workers/automation run jobctrl run`, or targeted `uv --project workers/automation run jobctrl <command>` after dependencies are installed. The full command tree (per-stage runs, `job <url>`, `backup`, `gmail-auth`, `migrate-resume-html`, …) is documented in `README.md` and `docs/user/`. Work-starting commands start Temporal workflows and require the Temporal dev server plus a running JobCtrl worker.
- Full local stack: `pnpm dev` (attached foreground supervisor; preferred for agents and annotation).
- Detached local stack: `pnpm dev:start`, then `pnpm dev:status`, `pnpm dev:logs <name>`, and `pnpm dev:stop`.
- Temporal worker: `uv --project workers/automation run jobctrl worker` (long-lived workflow worker; needs `temporal server start-dev` running).
- TypeScript API: `pnpm api:dev`.
- Web app: `pnpm web:dev`.
- Web preview after build: `pnpm web:preview`.
- Docs site (VitePress over `docs/`): `pnpm docs:dev`, `pnpm docs:build` (fails on dead internal links), `pnpm docs:preview`.

Do not run auto-apply, browser submission, destructive profile/database actions, or commands that submit applications unless the user explicitly asks for that behavior.

## Build, Test, And Lint Commands

Choose the smallest command set from `docs/local-reliability-qa.md` that proves
the touched behavior. Reserve `pnpm check` and `pnpm test` for cross-stack,
release/high-risk, or explicitly plan-required work. Frontend changes must run
their separate web unit/type/E2E/Storybook checks when the touched risk calls
for them; the aggregate does not include those suites.

When changing behavior, add or update unit tests for the changed logic. When changing user-facing behavior, local API behavior, browser flows, or UI/UX, include a QA stage that exercises the product path, not only unit tests.

Any major UI/UX regression found by the human must become a QA regression test or an explicitly documented QA checklist item before the work is considered complete.

## Documentation Requirements

Standalone PRs that add meaningful capabilities must update their owning docs.
For an approved feature stack that is not released between phases, defer
canonical product docs to the final PR; intermediate PRs update only plan or
contract material needed for review. Phases released independently or changing
active high-risk paths document immediately. Internal refactors, tests, and
behavior-neutral fixes do not need doc churn.

When a doc update is warranted:

| What changed | Update |
| --- | --- |
| User-facing product behavior, CLI commands, runtime requirements, generated local artifacts, or safety notes | `README.md` |
| End-user setup, the product tour, configuration/env-var reference, normal flows, data/safety boundaries, or the user-facing security model | `docs/user/*.md` |
| Install, run, verify, or frontend development commands | `docs/local-development.md` |
| Local QA expectations, regression matrix entries, high-risk workflows, or manually verified product paths | `docs/local-reliability-qa.md` |
| Local TypeScript API routes, JSON-RPC dispatch, or the SSE contract | `docs/local-ts-api.md` |
| TypeScript API plus Python worker architecture, Temporal orchestration, or local-first boundaries | `docs/architecture/` (`runtime.md`, `index.md`) |
| Pipeline workflow execution, activities, stages, spend ceiling, or persistence/events | `docs/architecture/pipeline/` |
| Resume tailoring contract, validation/judge/fabrication gates, provenance, or tailoring audit metadata | `docs/architecture/tailoring.md` |
| Observability / OpenTelemetry / Langfuse export of LLM, workflow, or JSON-RPC spans | `docs/architecture/observability.md` |
| Frontend architecture (state layers, bounded contexts, ports, realtime, testing pyramid) | `docs/architecture/frontend/` |
| TypeScript/API/web scripts, package metadata, dependencies, or tooling commands | `package.json` |
| Python package metadata, CLI entry point, Python version, optional dev dependencies, or Ruff config | `workers/automation/pyproject.toml` |
| Agent workflow rules, PR expectations, repo-specific constraints, or automation guidance | `AGENTS.md` |

If multiple surfaces changed, update every owning document. Keep edits narrow
and explain any intentional stacked deferral in the PR body.

## Agent Behavior

- Do not resolve material ambiguity by assumption. Ask for clarification when the goal, scope, constraints, or expected validation are unclear.
- If a reasonable assumption is low-risk and needed to make progress, state it explicitly before acting.
- Treat payloads, local generated artifacts, and job/application data as sensitive. Do not expose secrets, profile data, API keys, resumes, cover letters, generated PDFs, browser profiles, SQLite databases, or application logs unless the user explicitly requests them.
- Treat owner-only launch/growth strategy, campaign sequencing, targeting,
  unpublished messaging, and private traffic or conversion analysis as private.
  Never commit those materials to this public repository; commit only
  owner-approved public copy/assets and factual product documentation.
- Prefer repo-grounded answers and edits over generic advice. Check the referenced docs and current code before making architectural claims.
- **Subagent spawning:** Use subagents only for genuinely independent work or
  for the review/QA gates required by the validation tiers below. Do not add
  coordination overhead to work that is faster to complete directly.

### Root-Cause And Auditability Discipline

When the human flags a visible defect, especially in review, rationale, audit, evidence, scoring, tailoring, or apply-approval surfaces, treat the screenshot as a symptom, not the bug. Do not start by hiding, filtering, renaming, or moving the displayed value. First state the product invariant the surface is supposed to prove, then trace the value end to end: source input, extraction, profile evidence, selected controls, prompt or deterministic transform, generated artifact, validator/judge output, persistence, projection/API read model, and UI rendering.

For auditability features, every displayed claim must have an explicit source of truth. Before editing code, identify whether the source is canonical user profile data, the job post, score evidence, tailoring policy, generated artifact text/PDF, validator output, judge/adversarial response, event log, projection row, or derived read-model computation. If the correct source is missing, compute or persist the missing audit data at the owning layer; do not remove the UI field just because the current data is embarrassing.

Any fix to evidence, rationale, keywords, persona judgments, or generated-material status must preserve user value:

- Missing/covered keyword lists are useful only when computed against the actual generated resume text or explicitly recorded generation-time coverage. Never infer misses from job keywords alone, and never suppress the missing list as a substitute for computing it correctly.
- Persona/judge summaries are not enough. If a persona score or pass/fail is shown, the audit trail must make the prompt, rubric, model response, score basis, blockers, warnings, and repair instructions inspectable when the data exists.
- Post-generation warnings must be labeled by lifecycle: whether they were used to repair a candidate, accepted as residual warnings on the selected candidate, or produced after acceptance and therefore did not influence the artifact.
- Re-tailor/retry actions must not hide or suppress the last accepted artifact until a replacement is approved. Failed refreshes remain audit history; they must not destroy the current reviewable material.

Before claiming "fixed" on these surfaces, add or update a regression fixture that proves the exact invariant the human complained about. Prefer a fixture that reproduces the bad state from canonical data rather than a shallow component snapshot. State what was verified and what was not; do not use "fixed" for cosmetic masking.

## Engineering Conventions And PR Expectations

- PR titles must follow Conventional Commits.
- Commit messages must follow Conventional Commits.
- PR descriptions must clearly and unambiguously explain what changed, why it changed, and how it was validated.
- Keep changes as small as possible while still fully satisfying the goal.
- Use stacked PRs when functionality builds on prior functionality or when a large change should be broken into reviewable steps.
- Every implementation task must run off `main` in a dedicated worktree or
  task branch. If the current task already has a dedicated worktree, use it;
  do not create a nested/replacement worktree or refresh `main` solely for
  compliance.
- Never edit code on `main` or leave `main` dirty.
- Resolve the base before creating a worktree: use updated `main` for standalone
  work, or the explicit parent branch/commit for an approved stacked change.
  Fetch the relevant remote ref and verify that chosen base is current.
- Before coding, confirm the current branch/worktree. If you are on `main`, stop
  and create or switch to the correct worktree first.
- Do not remove existing compatibility behavior unless the assigned goal explicitly authorizes that breaking change.

When a new worktree is actually needed:

1. Ensure no unrelated dirty changes block setup.
2. Choose `<base-ref>`: updated `main` for standalone work, or the explicit
   parent branch/commit for an approved stack.
3. Fetch the relevant remote ref. If `<base-ref>` is `main`, fast-forward the
   main checkout with `git pull --ff-only origin main`.
4. Create the task worktree with
   `git worktree add <worktree-path> -b <branch-name> <base-ref>`.
5. Do all coding, testing, commits, and PR work from that task worktree.

## Constraints And Do-Not Rules

- Never edit code in the main branch.
- Never leave `main` dirty.
- Never create a worktree from stale `main` or a stale stack parent; fetch and
  verify the selected base first.
- Never mark work complete while Blocker or High PR review findings remain.
- Never mark work complete while Blocker or High QA findings remain.
- Never skip required QA. For an approved unreleased stack, run it once on the
  cumulative final branch after canonical docs are complete.
- Never broaden scope silently. If the correct fix exceeds the assigned scope, stop and raise the scope issue.
- Never commit local secrets, generated user data, resumes, cover letters, PDFs, browser profiles, worker directories, logs, or SQLite databases.

## What Done Means And How To Verify Work

Done means the user's instruction or goal has been fully achieved, the changeset
is as small as practical, and verification is proportional to its actual risk.
Use the lowest tier that fully covers the change; an active plan or explicit user
instruction may raise the tier. Never lower the tier for security, privacy, data
integrity, destructive actions, migrations, releases, or application submission.

| Tier | Applies to | Minimum verification | Independent gates |
| --- | --- | --- | --- |
| 0 — Editorial | Prose/typo/comment/format-only changes with no workflow, contract, test, or runtime effect | `git diff --check`; build docs only when site content, links, navigation, or rendering changed | None unless explicitly requested |
| 1 — Scoped | Internal refactors, tests, developer workflow/tooling, or contained behavior with no user-facing/high-risk boundary | Touched-surface lint/typecheck/unit tests plus `git diff --check` | One final `reviewer` pass; use `pr-reviewer` when a PR already exists |
| 2 — Product | User-facing UI, CLI, API, browser flow, integration, or workflow behavior | Tier 1 plus the smallest product-path QA that proves the change | `reviewer`/`pr-reviewer` and `qa` must return `Gate: PASS` |
| 3 — High risk | Security/privacy controls, credentials, user data, apply/submission, destructive actions, migrations, release/distribution, or cross-stack critical invariants | Relevant full matrix, regression fixture, and product/operational proof | `reviewer`/`pr-reviewer` and `qa` must return `Gate: PASS`; fix and rerun until no Blocker/High remains |

If Tier 3 groundwork changes only contracts or fixtures and no executable
product/operational path exists yet, do not fabricate product QA. Require one
independent review plus the focused safety checks, record why QA is deferred,
and make QA mandatory in the first phase that exposes the executable path.

For an approved stack whose intermediate phases are not released independently,
each intermediate PR runs focused checks and one review. The final PR updates
canonical docs first, then runs cumulative product QA and any final high-risk
gate across the whole stack. A phase that changes an active high-risk path or is
released independently follows its normal tier immediately.

Run independent gates once after implementation and focused verification. Rerun
a failed gate after addressing its Blocker/High findings; do not repeat passing
gates for cosmetic edits or unresolved Medium/Low observations unless the edit
could affect the verified behavior.

Before calling work done:

1. Confirm the work happened in a dedicated worktree and not on `main`.
2. Confirm the goal and acceptance criteria are satisfied.
3. Classify the validation tier and run its focused commands.
4. Run only the independent gates required by that tier.
5. Report exact commands and results, the tier, unresolved Medium/Low risks, any
   skipped verification with a concrete reason, and the PR number when a PR
   exists or was requested.

If any required verification cannot be run, the final status is not done. Report it as blocked or partially verified and explain what remains.

## Scoped Instructions

Changes under `apps/web/` must also follow `apps/web/AGENTS.md`. Read those
frontend-specific rules only for work that touches the web application.
