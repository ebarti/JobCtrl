# Local TypeScript API

The local TypeScript API is the runnable backend app under `apps/api`.

It owns product-facing JSON endpoints, reads the local SQLite database and
local profile/style/template files, and invokes Python automation through the
JSON-RPC 2.0 protocol over a long-lived `jobhunter rpc` subprocess. It is
intentionally local-first and binds to `127.0.0.1` by default.

Read-model endpoints (`/v1/dashboard/summary`, `/v1/jobs`, `/v1/jobs/facets`,
`/v1/jobs/:key`, `/v1/artifacts`) read from the five `*_projections` tables maintained by
`apps/api/src/projections.ts` (TS-side mirror) and the Python
`ProjectionBuilder` (`workers/automation/src/jobhunter/infrastructure/projections/`).
Both processes refresh projections idempotently via the shared
`event_watermarks.operations_projections` watermark.

`/v1/jobs` supports exact multi-value filters through repeated query
parameters for `location`, `companies`, and `title`, plus `discoveredFrom`,
`discoveredTo`, `minFitScore`, and `maxFitScore`. The legacy scalar `company`
query parameter remains a partial company search. `/v1/jobs/facets` returns the
available location, company, and title values for the local dashboard filters.

## Related Packages

- `apps/api`: Fastify API app.
- `apps/web`: React/Vite frontend app.
- `packages/contracts`: shared schemas, DTOs, enums, JSON-RPC envelopes, and
  re-exported `@jobhunter/domain-types`.
- `packages/domain-types`: pure TypeScript mirror of the Python domain model.
- `packages/api-client`: typed API client.

The dependency direction is:

```text
apps/api -> packages/contracts -> packages/domain-types
apps/api -> packages/domain-types
apps/web -> packages/api-client -> packages/contracts
```

The API must not depend on `packages/api-client`.

## Commands

```bash
pnpm api:dev
pnpm api:check
pnpm api:test
pnpm qa:test
pnpm web:dev
pnpm web:build
```

The API defaults to `http://127.0.0.1:8766`. The web app proxies `/v1/*` to
that origin unless `VITE_JOBHUNTER_API_BASE_URL` is set.
