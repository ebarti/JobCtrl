## Reference Index

Use these repository documents before making architectural, workflow, or QA decisions:

- `README.md`: user-facing product behavior, CLI commands, runtime requirements, generated local artifacts, and safety notes.
- `docs/local-reliability-qa.md`: local QA checklist, regression matrix, known high-risk workflows that need test coverage, and the frontend test pyramid + a11y bar.
- `docs/local-ts-api.md`: local TypeScript API, web app development commands, API/web verification, dashboard migration context, and the `GET /v1/events/stream` SSE contract.
- `docs/architecture.md`: current TypeScript app/API plus Python worker architecture, eight bounded contexts, projection-backed read model, JSON-RPC TS↔Python protocol, local-first boundaries, the frontend stack / state layers / ports / SSE realtime, and the OpenTelemetry → Langfuse observability layer for LLM, workflow, and JSON-RPC spans.
- `docs/job-pipeline-architecture.md`: phase-by-phase job pipeline execution, sequence diagrams, component diagrams, call paths, persistence, events, projection visibility, and failure behavior.
- `docs/ddd-target.md`: canonical DDD + hexagonal target architecture, including bounded-context language, aggregates, ports, domain events, projection strategy, and hosted-future seams. The implementation in this codebase realises this target — see `docs/plans/implemented/2026-05-06-ddd-migration.md`.
- `docs/frontend-target.md`: canonical frontend architecture — three-layer state (server / URL / client), eight bounded contexts mirrored 1:1 from the backend, view-vs-context dichotomy, hexagonal frontend ports, SSE realtime + invalidation router, testing pyramid. The implementation in this codebase realises this target — see `docs/plans/implemented/2026-05-06-frontend-tanstack-migration.md`.
- `docs/decisions.md`: architectural decision records — DDD adoption, per-aggregate repositories, in-process EventPublisher + projections, JSON-RPC for TS↔Python, TanStack family adopted for the frontend, frontend hexagonal ports with local + hosted adapters named, SSE realtime via `GET /v1/events/stream` + invalidation router, view-vs-context dichotomy.
- `package.json`: current TypeScript/API/web scripts.
- `workers/automation/pyproject.toml`: Python package metadata, CLI entry point, Python version, optional dev dependencies, and Ruff config.

## How To Run The Project

To be defined as a complete, single source of truth. Until this is finalized, infer the narrowest correct run command from the referenced docs and package metadata, then state the command before running it.

Known local commands:

- Python CLI: `uv --project workers/automation run jobhunter doctor`, `uv --project workers/automation run jobhunter run`, or targeted `uv --project workers/automation run jobhunter <command>` after dependencies are installed.
- Temporal worker: `uv --project workers/automation run jobhunter worker` (long-lived workflow worker; needs `temporal server start-dev` running).
- TypeScript API: `pnpm api:dev`.
- Web app: `pnpm web:dev`.
- Web preview after build: `pnpm web:preview`.

Do not run auto-apply, browser submission, destructive profile/database actions, or commands that submit applications unless the user explicitly asks for that behavior.

## Build, Test, And Lint Commands

The unit-test and QA command set must be made explicit as the project evolves. Until a stronger command matrix exists, use the following defaults and narrow them to the touched surface when appropriate:

- Full TypeScript/API/web verification: `pnpm test`.
- TypeScript API typecheck: `pnpm api:check`.
- TypeScript API tests: `pnpm api:test`.
- Web typecheck: `pnpm web:check`.
- Web build: `pnpm web:build`.
- Web Vitest unit + hook + component tests: `pnpm --filter @jobhunter/web test` (watch: `:watch`; coverage: `:coverage`).
- Web type-level tests: `pnpm --filter @jobhunter/web test-d`.
- Web Playwright end-to-end specs: `pnpm --filter @jobhunter/web e2e` (headed: `e2e:headed`).
- Web Storybook: `pnpm web:storybook` (build: `pnpm web:storybook:build`; test runner with a11y addon: `pnpm web:storybook:test`).
- Python tests: `uv --project workers/automation run --extra dev pytest -q`.
- Python lint: `uv --project workers/automation run --extra dev ruff check .`.
- Python package build: `uv --project workers/automation run --extra dev python -m build workers/automation`.

When changing behavior, add or update unit tests for the changed logic. When changing user-facing behavior, local API behavior, browser flows, or UI/UX, include a QA stage that exercises the product path, not only unit tests.

Any major UI/UX regression found by the human must become a QA regression test or an explicitly documented QA checklist item before the work is considered complete.

## Documentation Requirements

**PRs that add meaningful new capabilities MUST include documentation updates.** Do not add doc bloat: internal refactors, test-only changes, bug fixes that do not change public behavior, and renaming without functional change do NOT need doc updates.

When a doc update is warranted:

| What changed | Update |
| --- | --- |
| User-facing product behavior, CLI commands, runtime requirements, generated local artifacts, or safety notes | `README.md` |
| Local QA expectations, regression matrix entries, high-risk workflows, or manually verified product paths | `docs/local-reliability-qa.md` |
| Local TypeScript API behavior, web app development commands, API/web verification, or dashboard migration details | `docs/local-ts-api.md` |
| TypeScript API plus Python worker architecture, local-first boundaries, orchestration, or phased migration constraints | `docs/architecture.md` |
| Observability / OpenTelemetry / Langfuse export of LLM, workflow, or JSON-RPC spans | `docs/architecture.md` |
| Frontend architecture (state layers, bounded contexts, ports, realtime, testing pyramid) | `docs/frontend-target.md` |
| TypeScript/API/web scripts, package metadata, dependencies, or tooling commands | `package.json` |
| Python package metadata, CLI entry point, Python version, optional dev dependencies, or Ruff config | `workers/automation/pyproject.toml` |
| Agent workflow rules, PR expectations, repo-specific constraints, or automation guidance | `AGENTS.md` |

If multiple surfaces changed, update every relevant document. If no documentation update is warranted for a meaningful-looking change, explain why in the PR description. Keep documentation edits narrow: update the existing owning document, remove stale instructions, and avoid creating new docs unless no listed document owns the behavior.

## Agent Behavior

- Do not resolve material ambiguity by assumption. Ask for clarification when the goal, scope, constraints, or expected validation are unclear.
- If a reasonable assumption is low-risk and needed to make progress, state it explicitly before acting.
- Treat payloads, local generated artifacts, and job/application data as sensitive. Do not expose secrets, profile data, API keys, resumes, cover letters, generated PDFs, browser profiles, SQLite databases, or application logs unless the user explicitly requests them.
- Prefer repo-grounded answers and edits over generic advice. Check the referenced docs and current code before making architectural claims.
- **Subagent spawning:** You may spawn as many subagents as you need for parallel or complex work. Do not artificially limit concurrency — if a task naturally decomposes into independent subtasks, run them in parallel.

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

## Frontend Conventions

The `apps/web` frontend follows the architecture documented in `docs/frontend-target.md` and the four ADRs landed on 2026-05-06 in `docs/decisions.md` (TanStack family adopted, frontend hexagonal ports, SSE realtime + invalidation router, view-vs-context dichotomy). Follow these conventions on every frontend change; they exist so the architecture stays the architecture.

### Folder structure

- **Bounded-context folders mirror the backend 1:1.** Eight folders under `apps/web/src/contexts/`: `discovery/`, `enrichment/`, `profile/`, `scoring/`, `materials/`, `apply/`, `pipeline/`, `operations/`. A context may own any of `components/`, `hooks/`, `handlers.ts` (invalidation handlers registered with `operations/`), `queryKeys.ts` (re-exported through `contexts/operations/queryKeys.ts`), `selectors/`, `lib/`, `forms/`, `stores/`, and `index.ts` — only as needed; thin contexts (Discovery, Enrichment) keep their folder so future hooks land without restructure. **`operations/` is the special case:** it has no `handlers.ts` of its own (it hosts `invalidation-router.ts` which loads the seven aggregate contexts' handlers) and it owns the read-side hooks the other contexts do not.
- **Views are composers, not contexts.** `apps/web/src/views/dashboard/`, `views/jobs/`, `views/artifacts/` import components and hooks from contexts and assemble them into a layout. Views never own query keys, mutations, or persistent state stores; they only own layout and view-local ephemeral UI (e.g., bulk-selection sets).
- **Dependency direction.** Views depend on contexts; contexts never depend on views. A view never depends on another view (cross-view navigation goes through the URL). A context never imports another context's hooks or stores; cross-context coordination happens in (a) the view that composes them or (b) the invalidation router for cache fan-out. The only exception is `operations/` — every other context depends on it for read access and for the query-key registry.

### View composer rules

- View files (`views/<view>/<View>.tsx`, `<View>Table.tsx`, `<View>FilterBar.tsx`, `<View>DetailDrawer.tsx`, …) compose context components.
- Views never call `useQuery` / `useMutation` / `apiClient.*` / `queryClient.*` directly. Read data comes through Operations hooks (`useJobsListQuery`, `useJobDetailQuery`, …). Writes come through context-owned mutation hooks composed inside context-owned button components.

### Query keys

- Per-context factory living in `contexts/<context>/queryKeys.ts` (or for read keys, `contexts/operations/queryKeys.ts`); re-exported through `contexts/operations/queryKeys.ts` so the invalidation router has a single import surface.
- Shape: `["tenant", tenantId, <context>, <subset>, ...args] as const`. `tenantId` is the first segment for every key, today resolving to `LOCAL_TENANT` and tomorrow to the JWT-derived tenant — the hook signature does not change.
- Hierarchical scopes: `<context>Keys.all(tenantId)`, `.lists(tenantId)`, `.list(tenantId, filters)`, `.details(tenantId)`, `.detail(tenantId, id)` so invalidation can target the right scope.

### Mutation invalidation

- Per-aggregate `useMutation` hook in the owning context (e.g., `useApplyJobMutation` in `contexts/apply/hooks/`).
- Each mutation declares its own `onSettled` `invalidateQueries` set per `docs/frontend-target.md` §8.2. Default mutation options do **not** invalidate broadly.
- Synchronous mutations: optimistic update + invalidate on settle. Async (202) mutations: small immediate "queued" invalidation; the real result arrives via the SSE invalidation router.

### Optimistic mutations

- Use `createOptimisticMutation` from `apps/web/src/shared/lib/createOptimisticMutation.ts` for any mutation that needs an optimistic patch.
- **Always supply a real patcher.** The helper is dead code without one — calling it with an empty / no-op patcher is a Phase 3 reviewer Major; the QA gate fails any PR that wires `createOptimisticMutation` without a patch + rollback.

### SSE + invalidation router

- The real SSE adapter lives in `apps/web/src/shared/adapters/local/SseEventStreamAdapter.ts` and reads `EventStreamPort` from `apps/web/src/shared/ports/`. Feature code consumes events through the invalidation router, never by reading `EventSource` directly.
- The invalidation router is `apps/web/src/contexts/operations/invalidation-router.ts`. It maps `DomainEvent.eventType` to the right query-key set via the per-context handlers (`contexts/<context>/handlers.ts`).
- `Record<DomainEvent["eventType"], InvalidationHandler>` typing makes a missing handler a TypeScript compile error; the `every-event-has-handler.test.ts` parity test catches obvious empty-stub bodies at runtime.

### Forms

- TanStack Form + Zod `safeParse`. Do **not** use the deprecated `zod-form-adapter`; call `safeParse` in the field validators directly.
- Multi-step or wizard state that needs to survive navigation lives in a Zustand store with `persist` middleware (e.g., `contexts/profile/stores/profile-import-store.ts`). Single-step transient form state stays inside TanStack Form.

### Tables

- TanStack Table v8 with column models in `views/<view>/columns.tsx`.
- Cell renderers compose context-owned components (`<ScoreBadge>` from `contexts/scoring/`, `<StageBadge>` from `contexts/pipeline/`, `<ApplyRunBadge>` from `contexts/apply/`, …) — never inline JSX duplicating what a context already exports.

### Anti-patterns (forbidden in feature code)

- `useState<DataShape>` for server data — server data lives in TanStack Query.
- `useEffect(() => fetch(...))` for data loading — use a `useQuery` hook from `contexts/operations/`.
- `useRef(0)` for stale-response dedup — TanStack Query handles this via the cache key.
- `window.dispatchEvent` / `addEventListener` for cross-component coordination — use the URL (`navigate`), Zustand stores, or the query cache + invalidation router.
- Direct `apiClient.*`, `navigator.clipboard.*`, `localStorage.*`, `new EventSource(...)` calls — go through the corresponding port (`usePorts()`).

### Tests

- Colocated `*.test.ts(x)` next to source. Type-level tests live under `apps/web/test/types/<name>.test-d.ts` (separate config: `vitest.types.config.ts`, runs Vitest's `typecheck` mode — invoked via `pnpm --filter @jobhunter/web test-d`). Accessibility tests are colocated `*.a11y.test.tsx`. Storybook stories are colocated `*.stories.tsx`.
- MSW handlers live in `apps/web/src/test/msw/handlers.ts` (REST) and `apps/web/src/test/msw/sse-handlers.ts` (SSE). Add to the existing handler file rather than creating new MSW setups.
- One test per query hook and per mutation hook covering the success path AND the rollback path.
- The two parity tests are non-negotiable: `every-event-has-handler.test.ts` (`apps/web/src/contexts/operations/`) for `DomainEventUnion`, `every-stage-state-has-badge.test.tsx` (`apps/web/src/contexts/pipeline/components/`) for `STAGE_STATE_KINDS`.
- E2E specs live under `apps/web/e2e/tests/<flow>.spec.ts`.

### Stories

- Colocated `*.stories.tsx`. Per-state stories (loading / populated / empty / error) for view composers and forms via the MSW addon. Per-variant stories for primitives. Per-discriminant-arm stories for components rendering discriminated unions (`<StageBadge>` per `STAGE_STATE_KINDS`).
- The a11y addon enforces zero **critical** and **serious** axe violations. If a story exercises a pre-existing production a11y defect, set `parameters.a11y.test = "off"` AND record the deferral in `docs/backlog.md` "Frontend Accessibility Backlog" with the production file and defect type. Never silence the bar without filing the backlog entry.
