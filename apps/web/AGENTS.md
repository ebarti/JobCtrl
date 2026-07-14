# Web Frontend Instructions

Also follow the root `AGENTS.md`. The canonical frontend contract lives in
`docs/architecture/frontend/` and `docs/decisions.md`; do not duplicate it here.

Non-negotiable implementation rules:

- Preserve the documented context/view dependency direction. Views compose
  context components and never call query, mutation, API-client, or query-client
  APIs directly.
- Keep tenant-first hierarchical query keys, context-owned mutations with
  targeted invalidation, real optimistic patch/rollback behavior, and exhaustive
  SSE invalidation handlers.
- Access browser and local capabilities through ports; do not call clipboard,
  storage, `EventSource`, or other adapters directly from feature code.
- Use TanStack Form with Zod `safeParse`; persist only navigation-surviving
  multi-step state in Zustand.
- Colocate focused tests/stories, reuse the shared MSW handlers, cover changed
  query/mutation success and rollback, and preserve the event/stage parity tests.
- Keep Storybook free of critical/serious axe violations. Any pre-existing
  production deferral must be recorded in `docs/backlog.md`.

Choose verification through the root risk tiers and
`docs/local-reliability-qa.md`.
