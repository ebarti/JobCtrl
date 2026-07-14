# Web Frontend Instructions

These instructions apply to changes under `apps/web/` in addition to the
repository-wide `AGENTS.md`.

The frontend follows the architecture documented in
`docs/architecture/frontend/` and the four ADRs landed on 2026-05-06 in
`docs/decisions.md` (TanStack family adopted, frontend hexagonal ports, SSE
realtime + invalidation router, and view-vs-context dichotomy).

## Folder structure

- **Bounded-context folders mirror the backend 1:1.** Eight folders under
  `src/contexts/`: `discovery/`, `enrichment/`, `profile/`, `scoring/`,
  `materials/`, `apply/`, `pipeline/`, and `operations/`. A context may own any
  of `components/`, `hooks/`, `handlers.ts`, `queryKeys.ts`, `selectors/`,
  `lib/`, `forms/`, `stores/`, and `index.ts` only as needed. `operations/` is
  the special case: it hosts the invalidation router and owns read-side hooks.
- **Views are composers, not contexts.** `src/views/` imports components and
  hooks from contexts and owns only layout plus view-local ephemeral UI.
- **Dependency direction.** Views depend on contexts; contexts never depend on
  views. Views do not depend on other views. Contexts do not import other
  contexts' hooks or stores. Cross-context coordination happens in the composing
  view or the invalidation router. `operations/` is the exception every other
  context may use for read access and the query-key registry.

## View composer rules

- View files compose context components.
- Views never call `useQuery`, `useMutation`, `apiClient.*`, or
  `queryClient.*` directly. Reads come through Operations hooks; writes come
  through context-owned mutation hooks composed inside context-owned controls.

## Query keys

- Keep per-context factories in `contexts/<context>/queryKeys.ts` (or
  `contexts/operations/queryKeys.ts` for read keys) and re-export them through
  `contexts/operations/queryKeys.ts`.
- Shape every key as
  `["tenant", tenantId, <context>, <subset>, ...args] as const`.
- Keep hierarchical scopes: `.all`, `.lists`, `.list`, `.details`, `.detail`.

## Mutation invalidation

- Put each `useMutation` hook in the owning aggregate context.
- Each mutation declares its own `onSettled` invalidation set per
  `docs/architecture/frontend/integration.md` §8.2. Default mutation options do
  not invalidate broadly.
- Synchronous mutations use optimistic update plus settle invalidation. Async
  (202) mutations use a small immediate queued invalidation; the final result
  arrives through the SSE invalidation router.

## Optimistic mutations

- Use `createOptimisticMutation` from
  `src/shared/lib/createOptimisticMutation.ts` when an optimistic patch is
  needed.
- Always supply a real patcher and rollback. A no-op patcher fails review and
  QA.

## SSE and invalidation router

- The real SSE adapter is
  `src/shared/adapters/local/SseEventStreamAdapter.ts`. Feature code consumes
  events through the invalidation router, never through `EventSource` directly.
- The router is `src/contexts/operations/invalidation-router.ts`; per-context
  handlers map domain events to query-key sets.
- Preserve exhaustive `DomainEvent["eventType"]` typing and the
  `every-event-has-handler.test.ts` parity test.

## Forms

- Use TanStack Form with Zod `safeParse`; do not use `zod-form-adapter`.
- Persist multi-step state that must survive navigation in a Zustand store.
  Keep single-step transient state inside TanStack Form.

## Tables

- Keep `DataGridColumn<T>[]` column models in `views/<view>/columns.tsx` for the
  shared grid. Use `@tanstack/react-table` only for row-selection/sorting types.
- Cell renderers compose context-owned components instead of duplicating them
  inline.

## Forbidden feature-code patterns

- `useState<DataShape>` for server data.
- `useEffect(() => fetch(...))` for data loading.
- `useRef(0)` for stale-response deduplication.
- `window.dispatchEvent` / `addEventListener` for cross-component coordination.
- Direct `apiClient.*`, `navigator.clipboard.*`, `localStorage.*`, or
  `new EventSource(...)` calls; use the corresponding port from `usePorts()`.

## Tests

- Colocate `*.test.ts(x)`, `*.a11y.test.tsx`, and `*.stories.tsx`. Keep
  type-level tests under `test/types/` and E2E specs under `e2e/tests/`.
- Add REST handlers to `src/test/msw/handlers.ts` and SSE handlers to
  `src/test/msw/sse-handlers.ts`; do not create separate MSW setups.
- Cover success and rollback for every query or mutation hook whose behavior
  changes.
- Preserve the non-negotiable event-handler and stage-badge parity tests.

## Stories and accessibility

- Add per-state stories for view composers/forms, per-variant stories for
  primitives, and per-discriminant stories for discriminated unions.
- The a11y addon allows zero critical or serious axe violations. If a story
  exposes a pre-existing production defect, disable that story's a11y test only
  after recording the production file and defect in the Frontend Accessibility
  Backlog in `docs/backlog.md`.
