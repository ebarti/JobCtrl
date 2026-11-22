# Web Frontend Instructions

Follow the root `AGENTS.md`. The frontend architecture contract is in
`docs/architecture/frontend/`; do not duplicate its detailed rationale here.

- Features own their reads, mutations, query keys, data validation, public panels
  and event invalidations. Dashboard, Activity, Settings, Evidence Map and job
  workspaces compose public feature interfaces. Core must build and work when
  an optional feature and its explicit shell registration are removed.
- Views and routes do not call the HTTP or query client directly. Route loaders
  validate/map URL state and delegate to feature-owned read helpers with narrow
  structural dependencies. Independent reads start in parallel. Feature code
  does not import routes, generated route trees, views, or sibling private state.
- Use tenant-first query keys and feature-owned mutations. Invalidate the
  relevant reads after writes and committed events. Optimistic changes need
  real rollback and must not overwrite newer publications or accepted work.
  The shell owns one event connection and explicitly composes feature handlers.
- Use the shared HTTP port against the Python application's `/v1` routes;
  features own and validate the DTOs for their public endpoints. Browser and OS
  capabilities, including storage, clipboard, downloads and event streams, go
  through ports. Preserve uncertain-write handling and visible failure states.
- Use TanStack Form with Zod `safeParse`; persist only navigation-surviving
  multi-step state in Zustand. Preserve accessible controls and navigation.
- The accepted transformation uses a fresh E2E-only behavior suite. Exercise
  real UI, Python application, database, worker and renderer through controlled
  external boundaries; do not add component, unit, snapshot or internal-mock
  tests. Static checks and builds remain required. See `docs/local-reliability-qa.md`.
- Run `corepack pnpm web:lint` before opening a PR. Boundary lint checks
  dependency direction, capability provenance and use of browser ports; scoped
  exemptions in `apps/web/boundary-exemptions.json` must be justified and live.
