# Coding Conventions

**Analysis Date:** 2026-06-08

## Scope And Evidence

- This map covers the full repository: TypeScript API in `apps/api`, React/Vite frontend in `apps/web`, shared TypeScript packages in `packages`, and the Python automation worker in `workers/automation/src/jobhunter`.
- Required reference docs and manifests read for this analysis: `README.md`, `docs/local-reliability-qa.md`, `docs/local-ts-api.md`, `docs/frontend-target.md`, `package.json`, and `workers/automation/pyproject.toml`.
- Repo-local agent rules read for conventions: `AGENTS.md` and `CLAUDE.md`.

## Naming Patterns

**Files:**
- Use lowercase kebab-case or descriptive lowercase module names for most TypeScript infrastructure files: `apps/api/src/json-rpc-adapter.ts`, `apps/web/src/contexts/operations/invalidation-router.ts`, `apps/web/src/shared/lib/createOptimisticMutation.ts`.
- Use PascalCase `.tsx` files for React components: `apps/web/src/contexts/pipeline/components/StageBadge.tsx`, `apps/web/src/views/jobs/JobsView.tsx`.
- Use `useXxxQuery.ts` and `useXxxMutation.ts` for frontend hooks: `apps/web/src/contexts/operations/hooks/useJobsListQuery.ts`, `apps/web/src/contexts/discovery/hooks/useDeleteJobMutation.ts`.
- Use `queryKeys.ts`, `handlers.ts`, `selectors/*.ts`, `lib/*.ts`, `stores/*.ts`, and `index.ts` inside frontend bounded contexts such as `apps/web/src/contexts/apply`.
- Use Python snake_case module names under DDD folders: `workers/automation/src/jobhunter/domain/scoring/aggregate.py`, `workers/automation/src/jobhunter/infrastructure/rpc/server.py`.
- Use colocated test names for web source (`*.test.ts`, `*.test.tsx`, `*.a11y.test.tsx`, `*.stories.tsx`) and `test_*.py` for worker tests under `workers/automation/tests`.

**Functions:**
- Use camelCase for TypeScript functions and helpers: `buildApp`, `resolveApiConfig`, `createOptimisticMutation`, `fetchJobsList`.
- Use `handleXxx` or domain event names for event handlers: `profileUpdatedHandler` in `apps/web/src/contexts/profile/handlers.ts`.
- Use `useXxx` for React hooks only, and keep hook files named after the hook they export.
- Use snake_case for Python functions and methods: `_bootstrap`, `_split_model_specs`, `with_correction`, `to_dict`.

**Variables And Constants:**
- Use camelCase for local TypeScript variables and parameters.
- Use `UPPER_SNAKE_CASE` for TypeScript and Python constants: `UNSAFE_METHODS`, `DEFAULT_SCORING_RUBRIC_VERSION`, `TAILORING_PROMPT_VERSION`.
- Use leading underscores only for private module-level Python helpers or private TypeScript singleton internals where the source already does so: `_defaultDispatcher`, `_projection_subscription`.

**Types And Classes:**
- Use PascalCase for TypeScript interfaces, type aliases, React props, and classes: `BuildAppOptions`, `JsonRpcDispatcher`, `DeleteJobVariables`, `ButtonProps`.
- Prefer `readonly` TypeScript properties and `as const` literal arrays for domain alphabets: `STAGES`, `STAGE_STATES`, `STAGE_STATE_KINDS` in `packages/contracts/src/schemas.ts` and `packages/domain-types/src/pipeline.ts`.
- Use Python `@dataclass(frozen=True)` for immutable domain values and aggregate records: `JobScore` in `workers/automation/src/jobhunter/domain/scoring/aggregate.py`.
- Use explicit domain error names when they carry product meaning: `InputError` in `apps/api/src/write-model.ts`, `InvalidProfileError` in `workers/automation/src/jobhunter/domain/profile/aggregate.py`.

## Code Style

**TypeScript Formatting:**
- Use ES modules with `.js` suffixes on relative TypeScript imports: `import { jobsKeys } from "../jobsKeys.js"`.
- Use double quotes, semicolons, trailing commas in multiline literals/calls, and two-space indentation, matching `apps/api/src/server.ts` and `apps/web/src/shared/ui/button.tsx`.
- Keep TypeScript strict: shared compiler options live in `packages/tsconfig/base.json` with `strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`.
- There is no root ESLint config or root Prettier config in the checkout. `apps/web/package.json` includes `prettier`, but no repository script enforces TypeScript formatting.

**Python Formatting:**
- Use Python 3.11+ syntax, type annotations, `from __future__ import annotations`, and dataclasses in domain modules.
- Ruff configuration lives in `workers/automation/pyproject.toml` with `target-version = "py311"` and `line-length = 120`.
- Pytest uses strict asyncio mode via `workers/automation/pyproject.toml`.

**Frontend Styling:**
- Use Tailwind utility composition and shared UI primitives under `apps/web/src/shared/ui`.
- Use `cn()` from `apps/web/src/shared/lib/cn.ts` when merging class variants with `clsx` and `tailwind-merge`.
- Use CSS variables surfaced through `apps/web/tailwind.config.ts`; base styles live in `apps/web/src/styles/globals.css` and `apps/web/src/styles/tokens.css`.

## Import Organization

**TypeScript Order:**
1. External packages and workspace packages: `@fastify/cors`, `@tanstack/react-query`, `@jobhunter/contracts`.
2. Node built-ins when needed: `node:fs`, `node:path`, `node:url`.
3. Local modules with relative `.js` suffixes: `./contracts.js`, `../jobsKeys.js`.
4. Type-only imports are usually inline with their source using `type` specifiers: `import Fastify, { type FastifyInstance } from "fastify"`.

**Python Order:**
1. Module docstring and `from __future__ import annotations`.
2. Standard library imports.
3. Third-party imports.
4. `jobhunter.*` imports grouped by domain/infrastructure dependency.

**Path Boundaries:**
- Frontend views import context hooks/components; contexts do not import views. Follow examples in `apps/web/src/views/jobs`.
- Frontend feature code consumes ports through `usePorts()` from `apps/web/src/shared/providers/PortsProvider.tsx`; do not call browser/platform APIs directly from feature code.
- The API imports shared schemas through local `apps/api/src/contracts.ts`, which re-exports `packages/contracts`.

## Type And Data Patterns

- Validate local API request bodies and query strings with Zod schemas from `packages/contracts/src/schemas.ts`; route handlers call `.parse()` at the edge, as in `apps/api/src/server.ts`.
- Keep API DTOs additive and compatibility-minded by importing contract types rather than redeclaring shapes in route files.
- Model frontend server state with TanStack Query hooks under `apps/web/src/contexts/operations/hooks`; example: `useJobsListQuery` reads tenant and API ports, then returns `useQuery`.
- Model frontend writes as context-owned mutation hooks; example: `useDeleteJobMutation` in `apps/web/src/contexts/discovery/hooks/useDeleteJobMutation.ts`.
- Use `createOptimisticMutation` from `apps/web/src/shared/lib/createOptimisticMutation.ts` only with a real patch and rollback path.
- Use per-context query-key factories and re-export them through `apps/web/src/contexts/operations/queryKeys.ts`.
- Keep frontend domain drift guarded with discriminated unions and parity tests: `apps/web/src/contexts/operations/every-event-has-handler.test.ts` and `apps/web/src/contexts/pipeline/components/every-stage-state-has-badge.test.tsx`.
- In Python, keep domain objects immutable where practical and enforce invariants in `__post_init__`, as in `workers/automation/src/jobhunter/domain/scoring/aggregate.py`.
- Inject ports/repositories into Python use cases instead of importing infrastructure directly; `TailorResumeUseCase` dependencies are constructor arguments in `workers/automation/src/jobhunter/domain/materials/use_cases.py`.

## Error Handling

**TypeScript API:**
- Use `InputError` for expected write-model failures in `apps/api/src/write-model.ts`.
- Map read/write DB failures through `withDb` and `withWritableDb` in `apps/api/src/server.ts`; return `{ ok: false, error, message }` envelopes with HTTP status codes.
- Keep local safety checks explicit: `resolveApiConfig` rejects non-loopback hosts unless `JOBHUNTER_API_ALLOW_REMOTE_BIND` opts in.
- Catch infrastructure failures at boundaries and include bounded messages, not raw sensitive payloads.

**Frontend:**
- Let TanStack Query carry request errors; UI surfaces read `result.current.error` or mutation `.error`.
- Throw provider misuse errors early, as `usePorts()` does in `apps/web/src/shared/providers/PortsProvider.tsx`.
- Parse user-edited JSON with small helpers returning `{ ok: true } | { ok: false }`, then validate with Zod `safeParse`, as in `apps/web/src/contexts/profile/forms/profile-form.tsx`.

**Python Worker:**
- Domain invariants raise `ValueError` or a domain-specific exception near construction/use-case boundaries.
- JSON-RPC translates handler parameter failures and unexpected exceptions into JSON-RPC error envelopes in `workers/automation/src/jobhunter/infrastructure/rpc/server.py`.
- CLI bootstrap catches projection backfill failures with `log.exception` so read-model refresh issues do not prevent command startup.

## Logging And Observability

- TypeScript API logging is Fastify-based and disabled by default through `buildApp({ logger })`; use `request.log.warn/error` at route boundaries when logging is needed.
- Python modules use `logging.getLogger(__name__)`; CLI configures basic logging in `workers/automation/src/jobhunter/cli.py`.
- OpenTelemetry spans are part of worker infrastructure for JSON-RPC and LLM/workflow behavior, for example `workers/automation/src/jobhunter/infrastructure/rpc/server.py` and `workers/automation/src/jobhunter/infrastructure/observability/`.
- Do not log raw profile data, resumes, generated materials, local paths, Gmail bodies, or secrets; docs and code consistently treat those as local sensitive data.

## Comments And Documentation

- Use comments for invariants, boundary rationale, lifecycle behavior, and non-obvious compatibility constraints. Examples appear in `apps/api/src/write-model.ts` and `apps/api/src/json-rpc-adapter.ts`.
- Avoid comments that restate obvious assignments. Prefer module docstrings in Python for domain purpose and orchestration responsibilities.
- Keep public behavior docs narrow and in the owning document listed by `AGENTS.md`; do not create new docs when `README.md`, `docs/local-reliability-qa.md`, `docs/local-ts-api.md`, `docs/architecture.md`, or `docs/frontend-target.md` already owns the behavior.

## Function And Module Design

- Keep TS API route construction centralized in `buildApp` in `apps/api/src/server.ts`; extract persistence/read/write logic into modules such as `apps/api/src/read-model.ts`, `apps/api/src/write-model.ts`, and `apps/api/src/discovery-controls.ts`.
- Keep frontend views as composers under `apps/web/src/views`; put reusable domain UI and mutations in bounded contexts under `apps/web/src/contexts`.
- Keep shared frontend platform adapters and UI primitives under `apps/web/src/shared`.
- Keep cross-package domain alphabets and DTO schemas in `packages/domain-types` and `packages/contracts`; do not duplicate them in app code.
- Keep Python domain code under `workers/automation/src/jobhunter/domain`, adapters under `workers/automation/src/jobhunter/infrastructure`, and CLI/activity/workflow entry points at the package edge.
- Prefer named exports in TypeScript; use `index.ts` files as public context/package surfaces.

---

*Convention analysis: 2026-06-08*
*Update when patterns change*
