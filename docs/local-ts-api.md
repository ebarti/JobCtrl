# Local TypeScript API

The local TypeScript API is the runnable backend app under `apps/api`.

It owns product-facing JSON endpoints, reads the local SQLite database and
local profile/style/template files, and invokes Python automation through
structured local actions. It is intentionally local-first and binds to
`127.0.0.1` by default.

## Related Packages

- `apps/api`: Fastify API app.
- `apps/web`: React/Vite frontend app.
- `packages/contracts`: shared schemas, DTOs, enums, and domain types.
- `packages/api-client`: typed API client.

The dependency direction is:

```text
apps/api -> packages/contracts
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
