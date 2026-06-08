# External Integrations

**Analysis Date:** 2026-06-08

## Integration Summary

JobHunter runs as a local-first system. The web app talks to the local TypeScript API, the API talks to a long-lived Python JSON-RPC subprocess for complex commands, and the Python worker talks to job boards, ATS APIs, LLM providers, Gmail, local Chrome, Claude Code, Temporal, and optional Langfuse export.

The executable data boundary is local SQLite and local files. No hosted Postgres, object storage, hosted auth provider, or external cache is detected in the runnable code.

## Local API And Cross-Process Integrations

**Web to local API:**
- Service: JobHunter TypeScript API on `http://127.0.0.1:8766` by default.
- Client: `packages/api-client/src/client.ts`, wrapped by `apps/web/src/shared/adapters/local/FetchApiClientAdapter.ts`.
- Config: `VITE_JOBHUNTER_API_BASE_URL` and `VITE_DEV_API_PROXY_TARGET`; Vite proxy is in `apps/web/vite.config.ts`.
- Auth: local mode uses no user auth token. Tenant is `LOCAL_TENANT` through `apps/web/src/shared/adapters/local/LocalSessionAdapter.ts`.

**API to Python worker:**
- Protocol: JSON-RPC 2.0 over stdin/stdout.
- Adapter: `apps/api/src/json-rpc-adapter.ts`.
- Worker command: `uv --project workers/automation run jobhunter rpc`.
- Runtime scoping: the adapter injects `JOBHUNTER_DIR` so API and worker write the same local database.

**Realtime events:**
- Endpoint: `GET /v1/events/stream` in `apps/api/src/event-stream.ts`.
- Transport: Server-Sent Events with native browser `EventSource`.
- Client: `apps/web/src/shared/adapters/local/SseEventStreamAdapter.ts`.
- Source table: `job_events` in SQLite.
- Cache integration: `apps/web/src/contexts/operations/invalidation-router.ts`.

## APIs And External Services

**LLM Providers:**
- Google Gemini
  - Purpose: scoring, tailoring, cover letters, role-title adjudication, Smart Extract, and LLM-assisted enrichment.
  - Client: `workers/automation/src/jobhunter/llm.py` through `workers/automation/src/jobhunter/infrastructure/llm/llm_client.py`.
  - Endpoint: Gemini OpenAI-compatible endpoint and native Gemini `generateContent`.
  - Auth/env: `GEMINI_API_KEY`; default model from `workers/automation/src/jobhunter/model_defaults.py` is `gemini-3.5-flash`.
- OpenAI
  - Purpose: same LLM port surface when selected.
  - Client: `workers/automation/src/jobhunter/llm.py`.
  - Endpoint: `https://api.openai.com/v1`.
  - Auth/env: `OPENAI_API_KEY`; default OpenAI model is `gpt-4o-mini`.
- Local OpenAI-compatible HTTP endpoint
  - Purpose: local model provider.
  - Client: `workers/automation/src/jobhunter/llm.py`.
  - Endpoint/env: `LLM_URL`.
  - Optional auth/env: `LLM_API_KEY`.

**Job-board discovery:**
- JobSpy boards
  - Purpose: broad-board scraping for Indeed, LinkedIn, ZipRecruiter, and configured boards.
  - SDK/client: `python-jobspy` in `workers/automation/pyproject.toml`.
  - Adapter: `workers/automation/src/jobhunter/discovery/jobspy.py`.
  - Config: SQLite `discovery_settings` plus defaults in `workers/automation/src/jobhunter/config.py`.
- Smart Extract sites
  - Purpose: arbitrary configured website discovery using DOM/API intelligence and optional LLM strategy selection.
  - Client: Playwright, BeautifulSoup, PyYAML, and the shared LLM client.
  - Adapter: `workers/automation/src/jobhunter/discovery/smartextract.py`.
  - Registry: `workers/automation/src/jobhunter/config/sites.yaml`.
- Workday CXS
  - Purpose: direct Workday employer portal scraping over undocumented JSON endpoints.
  - Client: `urllib.request`.
  - Adapters: `workers/automation/src/jobhunter/discovery/workday.py` and `workers/automation/src/jobhunter/infrastructure/discovery/ats_adapters.py`.
  - Registry: `workers/automation/src/jobhunter/config/employers.yaml`.
- Greenhouse, Lever, Ashby public APIs
  - Purpose: canonical ATS discovery from public job-board APIs.
  - Client: `urllib.request`.
  - Adapter: `workers/automation/src/jobhunter/infrastructure/discovery/ats_adapters.py`.
  - Endpoints: Greenhouse boards API, Lever postings API, and Ashby public job-board API.

**Detail enrichment and browser scraping:**
- Playwright detail fetcher
  - Purpose: load posting pages, capture JSON-LD, HTTP status, and cleaned main-content HTML.
  - Adapter: `workers/automation/src/jobhunter/infrastructure/enrichment/playwright_fetcher.py`.
  - Proxy support: `workers/automation/src/jobhunter/infrastructure/network/proxy.py`.
- LinkedIn apply URL resolver
  - Purpose: authenticated LinkedIn page inspection to capture outbound apply target only.
  - Adapter: `workers/automation/src/jobhunter/infrastructure/enrichment/linkedin_apply_resolver.py`.
  - Auth/session: local Chrome profile, configured with `JOBHUNTER_LINKEDIN_APPLY_PROFILE_DIR` and related env vars.

**Apply automation:**
- Local Chrome / Chromium
  - Purpose: browser sessions for apply workers and Chrome DevTools Protocol.
  - Adapter: `workers/automation/src/jobhunter/infrastructure/apply/local_chrome.py`.
  - Lifecycle helpers: `workers/automation/src/jobhunter/apply/chrome.py`.
  - Config/env: `CHROME_PATH`, `JOBHUNTER_APPLY_TIMEOUT_SECONDS`.
- Claude Code CLI
  - Purpose: autonomous form filling through MCP tools.
  - Adapter: `workers/automation/src/jobhunter/infrastructure/apply/claude_code_cli.py`.
  - Command: `claude -p --mcp-config ... --output-format stream-json`.
  - Auth: local Claude Code configuration outside this repo.
- CapSolver
  - Purpose: optional CAPTCHA solving instructions for apply prompts.
  - Usage: prompt construction in `workers/automation/src/jobhunter/apply/prompt.py`.
  - Auth/env: `CAPSOLVER_API_KEY`.

**Gmail and Google OAuth:**
- Gmail API
  - Purpose: read-only verification-code lookup and application outcome feedback scanning.
  - Client: `workers/automation/src/jobhunter/infrastructure/gmail/client.py`.
  - Endpoint: `https://gmail.googleapis.com/gmail/v1/users/me`.
  - Auth: OAuth bearer token from `workers/automation/src/jobhunter/infrastructure/gmail/auth.py`.
- Google OAuth
  - Purpose: local Gmail readonly token acquisition and refresh.
  - Client: `httpx` plus a local callback server in `workers/automation/src/jobhunter/infrastructure/gmail/auth.py`.
  - Scope: `https://www.googleapis.com/auth/gmail.readonly`.
  - Auth files/env: `JOBHUNTER_GMAIL_DIR`, `JOBHUNTER_GMAIL_OAUTH_CLIENT_PATH`, `JOBHUNTER_GMAIL_TOKEN_PATH`; legacy `GMAIL_MCP_*` aliases are also accepted in `workers/automation/src/jobhunter/config.py`.
- Gmail scan API route
  - Purpose: local API trigger for bounded worker scan.
  - Route: `POST /v1/outcomes/gmail/scan` in `apps/api/src/server.ts`.
  - Worker bridge: `apps/api/src/gmail-feedback-worker.ts`.

**Workflow engine:**
- Temporal dev server
  - Purpose: local workflow orchestration for pipeline and apply workflows.
  - Client: `workers/automation/src/jobhunter/infrastructure/temporal/client.py`.
  - Worker: `workers/automation/src/jobhunter/infrastructure/temporal/worker.py`.
  - Registry: `workers/automation/src/jobhunter/infrastructure/temporal/registry.py`.
  - Config/env: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `JOBHUNTER_TASK_QUEUE`, `JOBHUNTER_TEMPORAL_DB`.
  - Web UI: links point to `http://127.0.0.1:8233` in `apps/web/src/views/runs/temporal-web-ui.ts`.

**Observability:**
- Langfuse over OTLP/HTTP
  - Purpose: export LLM, workflow, JSON-RPC, pipeline, and source spans.
  - Client: OpenTelemetry SDK and OTLP HTTP exporter in `workers/automation/src/jobhunter/infrastructure/observability/otel.py`.
  - Endpoint: `${LANGFUSE_BASE_URL}/api/public/otel/v1/traces`.
  - Auth/env: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_BASE_URL`.
  - Opt-out/env: `LANGFUSE_DISABLE`.
  - Timeout/env: `LANGFUSE_OTEL_TIMEOUT_SECONDS`.

## Data Storage

**Databases:**
- Application SQLite
  - Default path: `~/.jobhunter/jobhunter.db`.
  - Python connection/migrations: `workers/automation/src/jobhunter/database.py`.
  - API connection: `apps/api/src/db.ts`.
  - Projection tables: `apps/api/src/projections.ts` and `workers/automation/src/jobhunter/infrastructure/projections/sqlite_projection_store.py`.
- Temporal dev SQLite
  - Default path: `.dev/temporal/temporal.db`.
  - Configured by `scripts/dev`.

**File storage:**
- Local filesystem only for generated resumes, cover letters, PDFs, logs, browser profiles, OAuth files, and worker state.
- Paths are defined in `workers/automation/src/jobhunter/config.py`.
- API artifact opening is local OS integration through `apps/api/src/local-actions.ts` and `apps/web/src/shared/adapters/local/OpenArtifactAdapter.ts`.

**Secret storage:**
- macOS Keychain is used by the TypeScript API credentials UI through `apps/api/src/credentials.ts`.
- Gmail OAuth files live under the configured Gmail directory, resolved in `workers/automation/src/jobhunter/config.py`.
- `.env` files are local secret sources; contents must remain unread and uncommitted.

**Caching:**
- No external cache service detected.
- Browser `localStorage` is wrapped by `apps/web/src/shared/adapters/local/LocalStorageAdapter.ts`.
- TanStack Query provides in-memory browser server-state caching.

## Authentication And Identity

**Product auth:**
- No product login provider is implemented in local mode.
- Tenant identity is local-only via `LOCAL_TENANT` and `apps/web/src/shared/adapters/local/LocalSessionAdapter.ts`.

**Local API protection:**
- API binds to loopback by default in `apps/api/src/config.ts`.
- Non-loopback binding requires `JOBHUNTER_API_ALLOW_REMOTE_BIND=1`.
- Unsafe mutations require loopback `Origin` or `Referer` in `apps/api/src/server.ts` and `apps/api/src/local-origin.ts`.

**Third-party auth:**
- Google OAuth is used only for Gmail readonly access.
- Claude Code auth/configuration is external to this repo and consumed by spawning the local `claude` CLI.
- macOS Keychain stores configured LLM credential values through the API credentials surface.

## Environment Configuration

**Local app/runtime:**
- `JOBHUNTER_DIR`
- `JOBHUNTER_DB_PATH`
- `JOBHUNTER_PROFILE_PATH`
- `JOBHUNTER_RESUME_STYLE_PATH`
- `JOBHUNTER_RESUME_TEMPLATE_PATH`
- `JOBHUNTER_DASHBOARD_CONFIG_PATH`
- `JOBHUNTER_API_HOST`
- `JOBHUNTER_API_PORT`
- `JOBHUNTER_API_ALLOW_REMOTE_BIND`
- `JOBHUNTER_API_SSE_POLL_MS`
- `VITE_JOBHUNTER_API_BASE_URL`
- `VITE_DEV_API_PROXY_TARGET`
- `JOBHUNTER_WEB_PORT`

**LLM and generation:**
- `GEMINI_API_KEY`
- `OPENAI_API_KEY`
- `LLM_URL`
- `LLM_API_KEY`
- `LLM_MODEL`
- `JOBHUNTER_DISCOVERY_LLM_ROLE_FILTER`
- `JOBHUNTER_DISCOVERY_ROLE_FILTER_MODEL`
- `TAILORING_GENERATOR_MODELS`
- `TAILORING_GENERATOR_MODEL`
- `TAILOR_LLM_MODELS`
- `TAILORING_JUDGE_MODEL`
- `TAILOR_JUDGE_MODEL`
- `TAILORING_JUDGE_MIN_SCORE`
- `TAILOR_JUDGE_MIN_SCORE`

**Browser/apply/PDF:**
- `CHROME_PATH`
- `JOBHUNTER_APPLY_TIMEOUT_SECONDS`
- `CAPSOLVER_API_KEY`
- `PDFLATEX_PATH`
- `JOBHUNTER_LINKEDIN_APPLY_RESOLVER`
- `JOBHUNTER_LINKEDIN_APPLY_PROFILE_DIR`
- `JOBHUNTER_LINKEDIN_APPLY_SOURCE_PROFILE_DIR`
- `JOBHUNTER_LINKEDIN_APPLY_CHROME_PROFILE`
- `JOBHUNTER_LINKEDIN_APPLY_HEADLESS`
- `JOBHUNTER_LINKEDIN_APPLY_TIMEOUT_SECONDS`

**Gmail:**
- `JOBHUNTER_GMAIL_DIR`
- `JOBHUNTER_GMAIL_OAUTH_CLIENT_PATH`
- `JOBHUNTER_GMAIL_TOKEN_PATH`
- `GMAIL_MCP_DIR`
- `GMAIL_MCP_OAUTH_KEYS_PATH`
- `GMAIL_MCP_CREDENTIALS_PATH`

**Temporal and observability:**
- `TEMPORAL_ADDRESS`
- `TEMPORAL_NAMESPACE`
- `JOBHUNTER_TEMPORAL_DB`
- `LANGFUSE_PUBLIC_KEY`
- `LANGFUSE_SECRET_KEY`
- `LANGFUSE_BASE_URL`
- `LANGFUSE_DISABLE`
- `LANGFUSE_OTEL_TIMEOUT_SECONDS`
- `JOBHUNTER_ENV`

## Webhooks And Callbacks

**Incoming callbacks:**
- Gmail OAuth uses a temporary local callback server in `workers/automation/src/jobhunter/infrastructure/gmail/auth.py`.
- Local API routes are ordinary loopback HTTP endpoints; no third-party webhook receiver is detected.

**Outgoing webhooks:**
- Not detected.

**Streaming callbacks:**
- SSE is local browser realtime from `apps/api/src/event-stream.ts` to `apps/web/src/shared/adapters/local/SseEventStreamAdapter.ts`; it is not an external webhook.

## CI/CD And Publishing Integrations

**GitHub Actions:**
- TypeScript CI: `.github/workflows/typescript.yml`.
- Python CI: `.github/workflows/python.yml`.
- PyPI publish: `.github/workflows/publish.yml`.

**Package publishing:**
- Python package publish uses `pypa/gh-action-pypi-publish@release/v1` with PyPI trusted publishing on tags matching `v*`.
- No npm publishing workflow is detected for the TypeScript workspace packages.

## Planner Notes

- Integration changes should update the owning adapter first, then the matching contract or docs if behavior changes.
- External API changes usually touch `workers/automation/src/jobhunter/infrastructure/*`, `workers/automation/src/jobhunter/discovery/*`, or `workers/automation/src/jobhunter/llm.py`.
- API/web contract changes should start in `packages/contracts/src`, then `apps/api/src/server.ts`, then `packages/api-client/src/client.ts`, then web context hooks under `apps/web/src/contexts`.
- New secrets must be represented as env var names or credential-store keys only; never commit generated user data, tokens, `.env` values, local DBs, browser profiles, logs, resumes, cover letters, or PDFs.

---

*Integration audit: 2026-06-08*
