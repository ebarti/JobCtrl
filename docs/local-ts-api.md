# Local TypeScript API

JobHunter now has an initial local TypeScript API scaffold under
`services/api`, with shared DTOs and a small typed client under
`packages/contracts`.

This API is intentionally local-first. It reads the existing local SQLite
database and profile/style/template files, then exposes typed JSON endpoints for
the future React dashboard. It does not replace the Python automation pipeline
or the current Python dashboard server yet.

Browser CORS access is limited to localhost origins because the API exposes
local job and profile data.

## Run

```bash
npm install
npm run api:dev
```

The API defaults to:

```text
http://127.0.0.1:8766
```

Environment variables:

- `JOBHUNTER_DIR`: local app directory, default `~/.jobhunter`
- `JOBHUNTER_DB_PATH`: explicit SQLite database path
- `JOBHUNTER_PROFILE_PATH`: explicit `profile.json` path
- `JOBHUNTER_RESUME_STYLE_PATH`: explicit `resume_style.json` path
- `JOBHUNTER_RESUME_TEMPLATE_PATH`: explicit `resume_template.tex` path
- `JOBHUNTER_DASHBOARD_CONFIG_PATH`: explicit editable dashboard settings path
- `JOBHUNTER_API_HOST`: bind host, default `127.0.0.1`
- `JOBHUNTER_API_PORT`: bind port, default `8766`

## Endpoints

```http
GET /v1/health
GET /v1/dashboard/summary
GET /v1/jobs
GET /v1/jobs/:jobKey
GET /v1/artifacts
GET /v1/artifacts/:artifactId
GET /v1/profile
GET /v1/settings
```

The jobs and artifacts list endpoints support pagination, filtering, and global
sorting over the matching local dataset.

The shared `@jobhunter/contracts` package exports the request schemas, response
types, and `createJobHunterApiClient()` for the future React frontend.

## Verify

```bash
npm test
uv run pytest tests/test_dashboard_server.py -q
```

The Python dashboard tests remain in place because the current dashboard server
is still the production local UI until the React frontend is built.
