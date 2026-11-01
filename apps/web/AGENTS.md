# Web Frontend Instructions

Also follow the root `AGENTS.md`. The canonical frontend contract lives in
`docs/architecture/frontend/` and `docs/decisions.md`; do not duplicate it here.

Non-negotiable implementation rules:

- Preserve the documented context/view dependency direction. Views may compose
  public context components and call public context-owned hooks, including the
  Operations read hooks, but never call the API client or query client directly.
  Route loaders validate/map search and delegate to the owning context's
  `readQueries.ts` helpers with narrow structural dependencies. Contexts must
  not import routes, the generated tree or views. Keep Jobs without a loader;
  its effective-query handoff remains view-owned. Preserve prefetch best-effort
  behavior and Activity ensure-read error propagation.
  Aggregate contexts may consume the Operations read kernel; they do not import
  another aggregate context's hooks or stores.
- Import unchanged DTOs, schemas and constants from `@jobctrl/contracts`, and
  domain vocabulary/events from `@jobctrl/domain-types`. Keep genuine frontend
  input refinements in Operations; do not add transparent DTO routing facades.
  Preserve existing string identifier compatibility.
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
  production deferral must be recorded in a linked [GitHub issue](https://github.com/ebarti/JobCtrl/issues).
- Run `corepack pnpm web:lint` before opening a PR. It enforces the dependency
  direction, Operations read-kernel access, browser-port, and context-owned
  API/query/store rules above from TypeScript syntax, resolved symbols and
  capability provenance (any, missing generated declarations, casts and aliases
  cannot grant access). Context helpers may receive dependencies but must not
  return raw API/query authority to routes or views, including through `any`.
  Capability-bearing method receivers and constructor parameter properties
  remain subject to the same handoff boundary, and
  the TypeScript CI web job blocks on it. Scoped exemptions live in
  `apps/web/boundary-exemptions.json` and fail when stale. Run the whole
  `corepack pnpm web:lint:test` suite, including real generated-route controls;
  require boundary diagnostics independently of compiler diagnostics.

Use `docs/local-reliability-qa.md` for verification.
