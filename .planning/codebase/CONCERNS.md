# Codebase Concerns

**Analysis Date:** 2026-06-08

## Tech Debt

### Projection ownership is duplicated across TypeScript and Python

The read model is projection-backed, but both the TypeScript API and Python worker can materialize the same Operations projection tables and advance the shared `operations_projections` watermark. The TS side refreshes projections at the start of read-model queries, while the Python `ProjectionBuilder` also subscribes to events and writes projection rows.

- Evidence: `apps/api/src/read-model.ts`, `apps/api/src/projections.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `apps/api/src/db.ts`
- Risk: projection drift or SQLite write contention can make jobs, dashboard counts, artifact lists, source-quality stats, and apply-run state look current while canonical tables disagree.
- Current mitigation: both implementations derive from canonical aggregate tables, the Python builder logs projection refresh failures, and SQLite `busy_timeout` is set in the API.
- Planning signal: add stronger parity/freshness checks, make projection lag visible in health, or converge the projection builder logic behind one generated/shared contract.

### URL-shaped job identity remains the durable storage key

The domain model has a stable `JobId`, but local persistence still stores jobs in the wide `jobs` table with `url TEXT PRIMARY KEY`, and repositories treat `job_id` as the legacy URL. The backlog explicitly tracks cutting the table over from URL primary key to a system-generated job id.

- Evidence: `workers/automation/src/jobhunter/database.py`, `workers/automation/src/jobhunter/infrastructure/discovery/sqlite_repository.py`, `workers/automation/src/jobhunter/infrastructure/materials/sqlite_repository.py`, `docs/backlog.md`
- Risk: canonical job identity, dedupe, duplicate collapse, re-posted jobs, and URL changes remain tied to mutable posting URLs in storage.
- Current mitigation: projections expose `jobKey`, domain types define `JobId`, and repository ports isolate some persistence details.
- Planning signal: finish the storage cutover before relying on URL-independent identity for hosted mode, richer dedupe, or durable cross-source job histories.

### Legacy wide-table fallbacks remain active

Several current code paths still backfill from or fall back to legacy nullable `jobs.*` columns such as `application_url`, `fit_score`, `tailored_resume_path`, `cover_letter_path`, and stage status fields. The repo backlog calls out stopping projection builders from sourcing those columns.

- Evidence: `workers/automation/src/jobhunter/database.py`, `apps/api/src/projections.ts`, `docs/backlog.md`
- Risk: each feature touching scoring, enrichment, materials, apply state, or stage state must reason about both normalized aggregate tables and compatibility columns.
- Current mitigation: backfills are idempotent, new writes generally target normalized tables, and tests cover several explicit-state-over-legacy cases.
- Planning signal: remove one legacy fallback family at a time with fixtures proving normalized tables are the only source of truth.

### Feedback schema is duplicated across API and worker

Application feedback tables are created independently in TypeScript and Python with matching SQL. That includes `application_review_decisions`, `application_outcomes`, `application_email_evidence`, and `application_outcome_suggestions`.

- Evidence: `apps/api/src/application-feedback.ts`, `workers/automation/src/jobhunter/infrastructure/gmail/feedback.py`
- Risk: schema drift can break Gmail feedback scans, apply-review queue rendering, outcome suggestions, or event emission depending on which component initializes the local database.
- Current mitigation: the Python docstring names the TypeScript API table shape as the target.
- Planning signal: add a schema-contract test or central migration source for cross-runtime tables.

### Generated route tree is tracked despite docs saying it is gitignored

`routeTree.gen.ts` is tracked in the repository and imported by the router and tests, but the architecture docs describe it as generated and gitignored.

- Evidence: `apps/web/src/routeTree.gen.ts`, `apps/web/src/router.ts`, `docs/decisions.md`, `docs/frontend-target.md`
- Risk: generated-file churn can enter PRs, and a developer may trust the docs and not notice the tracked runtime artifact needs to be updated.
- Current mitigation: the file header warns it is generated and tests/build import it directly.
- Planning signal: decide whether the generated route tree is intentionally tracked or genuinely ignored, then align docs, ignore rules, and CI checks.

### Source and employer data are still conflated in persistence

The discovery SQLite adapter records board/source data in `jobs.site` and documents that `Job.employer` is not persisted natively in the local table. The backlog tracks persisting `Source.board` and `Employer.name` directly.

- Evidence: `workers/automation/src/jobhunter/infrastructure/discovery/sqlite_repository.py`, `docs/backlog.md`
- Risk: board filters, employer filters, source-quality reporting, and source-learning decisions can be ambiguous when the storage layer lacks separate fields.
- Current mitigation: projections expose both concepts where possible, and source-learning/source-quality code records additional source metadata elsewhere.
- Planning signal: persist employer and source board as distinct canonical fields before adding more source-quality automation.

### Material artifact records can be synthesized from sibling files

The backlog records that `apps/api/src/projections.ts` can synthesize `*_pdf` artifact rows from sibling `.txt` files with no database record, making them indistinguishable from real DB-backed artifacts in the UI.

- Evidence: `apps/api/src/projections.ts`, `docs/backlog.md`
- Risk: artifact inventory can overstate provenance, status, or review history because a file-neighbor heuristic looks like a canonical artifact.
- Current mitigation: the backlog already names this as data-model cleanup.
- Planning signal: expose only DB-backed artifact records or mark synthesized entries with explicit provenance.

## Known Bugs

### Per-job generate-materials is intentionally unsupported

The API route for `/v1/jobs/:jobKey/actions/generate-materials` returns a 400 unsupported response, the web mutation throws `NotImplementedError`, the button is disabled, and the Playwright materials spec is `test.fixme`.

- Evidence: `apps/api/src/server.ts`, `apps/api/src/local-actions.ts`, `apps/web/src/contexts/materials/hooks/useGenerateMaterialsMutation.ts`, `apps/web/src/contexts/materials/components/GenerateMaterialsButton.tsx`, `apps/web/e2e/tests/materials.spec.ts`
- User impact: users cannot start per-job materials generation from the web product surface even though the UI exposes artifacts, previews, and a disabled button.
- Planning signal: wire backend use-case exposure, API dispatch, web mutation, and the existing disabled/e2e flow in one slice.

### Workflow cancellation can report success without stopping the worker

Canceling a job writes local SQLite state and only forwards a worker cancellation if a `runId` is present. Current code comments state that without a run id the Temporal workflow keeps polling and can drift the stage back to running. Worker dispatch failure is logged but the API still returns `cancel_requested`.

- Evidence: `apps/api/src/server.ts`, `apps/api/src/local-actions.ts`, `apps/web/src/contexts/apply/components/CancelApplyButton.tsx`, `workers/automation/src/jobhunter/apply/activities.py`
- User impact: a user can see cancellation requested while browser automation or a Temporal workflow continues.
- Planning signal: make active run id mandatory for workflow-backed cancellation, expose worker-dispatch failure in the response/state, and add an end-to-end cancel regression.

### Workflow Runs list lacks in-row cancellation

The Runs view has a TODO noting the JSON-RPC `cancel_run` handler and schema exist, but the in-row "Cancel running workflow" button is not wired.

- Evidence: `apps/web/src/views/runs/RunsView.tsx`, `apps/api/src/local-actions.ts`
- User impact: operators must cancel from other surfaces or use lower-level tooling for active workflow runs.
- Planning signal: add a run-scoped cancel action from the Runs table/detail surface and verify it through the same action-status path as job cancellation.

### Browser action-status polling has no full browser smoke

The backlog says no browser flow starts a stage and observes the action-status loop from queued/running to terminal. The materials E2E remains disabled pending generate-materials backend enablement.

- Evidence: `docs/backlog.md`, `apps/web/e2e/tests/materials.spec.ts`
- User impact: regressions in long-running action progress may pass unit/API tests while the browser experience is broken.
- Planning signal: add a seeded browser flow that starts a safe non-apply stage and watches the UI reach a terminal action state.

## Security Considerations

### API security depends on local-loopback deployment assumptions

The API defaults to `127.0.0.1` and refuses non-loopback hosts unless `JOBHUNTER_API_ALLOW_REMOTE_BIND` is enabled. Mutation requests require loopback `Origin` or `Referer`, but requests with neither header are trusted for CLI/non-browser usage. There is no general authentication layer on API routes.

- Evidence: `apps/api/src/config.ts`, `apps/api/src/local-origin.ts`, `apps/api/src/server.ts`
- Risk: remote bind opt-in exposes a local API designed for a trusted machine. Local no-origin clients can mutate state.
- Current mitigation: loopback default, explicit remote-bind opt-in, CORS restricted to loopback origins, and mutation-origin checks.
- Planning signal: add auth/session controls before any non-loopback, hosted, or shared-machine deployment becomes supported.

### Artifact preview/open trusts local paths from the database/projection layer

Artifact preview streams the artifact `localPath` when it is a PDF-like artifact and exists as a file. Artifact open spawns the platform opener for the recorded path and returns the path. Apply-review material previews also read text previews from paths found in material/artifact tables and legacy columns.

- Evidence: `apps/api/src/server.ts`, `apps/api/src/local-actions.ts`, `apps/api/src/application-feedback.ts`, `apps/api/src/read-model.ts`
- Risk: if a local database/projection row is poisoned, the API can preview, read, open, or return arbitrary local file paths that satisfy file/existence checks.
- Current mitigation: artifact routes require an artifact id from the local database, preview is PDF-gated, existence and `isFile()` are checked, and binary-looking material preview paths are skipped.
- Planning signal: add realpath containment under known artifact roots, record artifact storage provenance, and avoid returning local paths unless the caller explicitly needs them.

### Gmail feedback stores bounded raw email body text locally

The Gmail feedback worker reads full email bodies only after metadata passes link-confidence checks, but it stores up to 12,000 characters of body text plus a hash in `application_email_evidence`. API scan responses and events are sanitized, but the local database still holds body content.

- Evidence: `README.md`, `docs/architecture.md`, `apps/api/src/application-feedback.ts`, `workers/automation/src/jobhunter/infrastructure/gmail/feedback.py`
- Risk: local database backups, exports, or accidental commits can expose sensitive email content.
- Current mitigation: scan responses and domain events avoid raw email body text, and QA docs require fake Gmail clients or seeded fixtures.
- Planning signal: consider body-text retention controls, encrypted-at-rest storage, or hash/snippet-only modes.

### Langfuse export includes every LLM prompt and completion when enabled

The README and OpenTelemetry bootstrap warn that enabling Langfuse exports every LLM prompt and completion. `llm_generation_span` sets `langfuse.observation.input` and `langfuse.observation.output` directly from messages and generated text.

- Evidence: `README.md`, `workers/automation/src/jobhunter/infrastructure/observability/otel.py`, `workers/automation/src/jobhunter/infrastructure/observability/llm_spans.py`, `workers/automation/src/jobhunter/llm.py`
- Risk: prompts and completions can include profile, resume, job text, generated materials, and rationale content and are sent to the configured Langfuse instance.
- Current mitigation: export is disabled unless all Langfuse credentials/base URL are set, and `LANGFUSE_DISABLE=1` opts out.
- Planning signal: add redaction or a metadata-only observability mode before broader telemetry usage.

### Debug prompt generation writes sensitive prompts to local files

The apply launcher `gen_prompt` debug helper reads tailored resume text when present and writes the apply prompt and MCP config to local generated files.

- Evidence: `workers/automation/src/jobhunter/apply/launcher.py`, `README.md`
- Risk: generated debug prompts can contain resume, profile, job, and application instructions and should be treated like sensitive generated artifacts.
- Current mitigation: repository rules and README warn not to commit logs, generated materials, resumes, browser profiles, databases, or PDFs.
- Planning signal: make debug prompt generation opt-in, add clear retention/cleanup guidance, and keep generated paths ignored.

### Credential storage is macOS Keychain-only in the API implementation

The API credential store uses the macOS `security` CLI for listing, setting, and deleting OpenAI/Gemini/LLM endpoint credentials.

- Evidence: `apps/api/src/credentials.ts`, `apps/api/src/server.ts`
- Risk: Linux/Windows local users can hit missing-command failures or bypass the intended credential store via environment variables.
- Current mitigation: the store avoids committing secrets to project files and exposes only configured/not-configured status.
- Planning signal: add platform-specific adapters or a documented unsupported-state response for non-macOS environments.

## Performance Bottlenecks

### Projection refresh runs at the start of read-model queries

Read APIs call `refreshProjections` before serving many list/detail/activity/artifact reads. Refresh can scan new `job_events`, detect missing projection rows, sweep jobs after schema change, rebuild dirty job projections, rebuild dashboard projection, and rebuild source-quality projections.

- Evidence: `apps/api/src/read-model.ts`, `apps/api/src/projections.ts`
- Risk: read latency includes write-side maintenance work, and a schema change or missing projection state can trigger broader sweeps on user-facing reads.
- Current mitigation: incremental watermarking short-circuits when there are no dirty jobs or source-quality changes.
- Planning signal: separate projection maintenance from request reads or add request-visible projection-refresh timing/lag metrics.

### SSE is implemented as frequent SQLite polling

The event stream polls every 250 ms by default, tails up to 1,000 `job_events` rows, and fans rows out to active subscribers.

- Evidence: `apps/api/src/event-stream.ts`, `docs/architecture.md`
- Risk: multiple browser tabs wake the API and SQLite database several times per second; bursts above the batch limit rely on repeated polling.
- Current mitigation: polling only runs while subscribers exist, an index is created when possible, and subscriber cursors are tracked.
- Planning signal: keep this local-only, or move hosted/large-load realtime to a push-oriented event bus or separate projection/event service.

### Free-text job search filters in memory

For `listJobs` with `q`, the read model loads all SQL-filtered projection rows, maps them to summaries, filters in memory, sorts in memory, and paginates after filtering.

- Evidence: `apps/api/src/read-model.ts`
- Risk: large local databases pay per-request CPU and memory cost for broad text search.
- Current mitigation: the source table is denormalized and non-search queries use SQL count/order/limit.
- Planning signal: add SQLite FTS or indexed search fields if job volume grows.

### Artifact list filters and sorts in memory

`listArtifacts` loads all artifact projections for the tenant, filters status/type/query in TypeScript, sorts, and paginates in memory. Query matching includes `localPath`.

- Evidence: `apps/api/src/read-model.ts`
- Risk: artifact-heavy databases pay increasing API memory/CPU cost and expose local path strings as searchable values.
- Current mitigation: projections are denormalized and suppressed artifacts are filtered by default.
- Planning signal: move artifact filters, sort, and pagination into SQL and reconsider path-based search.

### Apply-review queue can perform file-preview reads per row

Apply-review queue items call material preview helpers that query artifact/material tables and read bounded text previews from local files.

- Evidence: `apps/api/src/application-feedback.ts`
- Risk: queue rendering can become an N+1 mix of SQL and filesystem reads, and stale/missing files create silent fallbacks.
- Current mitigation: previews are byte-limited, binary-looking files are skipped, missing files are ignored, and PDF artifact ids are checked before use.
- Planning signal: precompute material preview metadata or cache bounded previews with artifact provenance.

### Long-running discovery and apply workflows can occupy workers for hours

Discovery has a six-hour activity timeout and no workflow-level retry; apply has a two-hour timeout and two attempts. Discovery crawls query/location/site combinations and apply can run browser automation.

- Evidence: `workers/automation/src/jobhunter/pipeline/workflow.py`, `workers/automation/src/jobhunter/apply/workflow.py`, `workers/automation/src/jobhunter/discovery/jobspy.py`
- Risk: local worker capacity can be pinned by slow external crawls, browser automation, or provider stalls.
- Current mitigation: heartbeats, cancellation signals, source-level progress, and retry limits exist.
- Planning signal: add per-source budgets, queue visibility, and smaller cancellable units before increasing concurrency.

### LLM calls have large token/time budgets

The LLM client timeout is 180 seconds, retries are configured, and tailoring policy defaults allow large candidate and judge token budgets.

- Evidence: `workers/automation/src/jobhunter/llm.py`, `workers/automation/src/jobhunter/domain/materials/use_cases.py`
- Risk: scoring/tailoring phases can create long latency and high cost under provider slowness, retries, or large prompts.
- Current mitigation: provider selection is explicit through environment/model specs, and telemetry records token counts when Langfuse export is enabled.
- Planning signal: add local cost/latency budgets and expose per-stage LLM spend in the Operations view.

## Fragile Areas

### JSON-RPC subprocess calls have no per-request timeout

`SubprocessJsonRpcAdapter.call()` writes a line to a long-lived `jobhunter rpc` subprocess and waits for a matching response. Pending requests are rejected only when the child closes/errors or the adapter is closed. Worker stderr is dropped in the API process.

- Evidence: `apps/api/src/json-rpc-adapter.ts`, `workers/automation/src/jobhunter/infrastructure/rpc/server.py`
- Risk: if the subprocess stays alive but a handler never responds, an API action can hang, and later stdin requests share the same single-line processing loop.
- Current mitigation: crashed workers are detected by process close/error and respawn on next call.
- Planning signal: add per-call timeout, health ping/reset, structured stderr tailing, and cancellation-aware pending request cleanup.

### Cancellation relies on cooperative thread/process behavior

Non-apply activities run blocking functions in a thread with heartbeat polling. Cancellation calls an optional `on_cancel` and waits up to 30 seconds, but Python cannot force-kill the running thread. Apply cancellation sets a launcher stop event.

- Evidence: `workers/automation/src/jobhunter/infrastructure/temporal/run_in_activity.py`, `workers/automation/src/jobhunter/discovery/activities.py`, `workers/automation/src/jobhunter/apply/activities.py`
- Risk: external crawls, LLM calls, browser automation, or blocking adapters can continue after workflow cancellation if the underlying code does not check its stop signal promptly.
- Current mitigation: heartbeat timeouts, cancel events, and apply stop-event plumbing exist.
- Planning signal: make long adapters chunked and cancellation-aware at their own I/O boundaries.

### Worker/runtime identity is a central correctness gate

The API reads worker heartbeats and marks workers missing, stale, mismatched, or healthy. Activities assert expected app dir and database path and fail non-retryably on mismatch. Heartbeats are written at startup and every 15 seconds.

- Evidence: `apps/api/src/worker-health.ts`, `workers/automation/src/jobhunter/infrastructure/runtime_identity.py`, `workers/automation/src/jobhunter/infrastructure/temporal/runtime_guard.py`, `workers/automation/src/jobhunter/cli.py`
- Risk: action safety depends on every payload carrying expected runtime identity and on heartbeat freshness. Stale or mismatched workers can block or misroute work.
- Current mitigation: health response exposes status, the API can require healthy workers for actions, and activities guard runtime mismatch.
- Planning signal: keep runtime identity in every cross-process action contract and test stale/mismatch paths in product-level QA.

### Event taxonomy spans API, Python, contracts, and frontend invalidation

The architecture uses `job_events` plus a frontend invalidation router keyed by domain event type. Backend event additions require contract/schema, projection, and frontend handler coverage.

- Evidence: `docs/architecture.md`, `docs/frontend-target.md`, `apps/web/src/contexts/operations/invalidation-router.ts`, `apps/web/src/contexts/operations/every-event-has-handler.test.ts`
- Risk: a new event can fail to invalidate the right query, leave stale UI state, or update projections without updating frontend cache behavior.
- Current mitigation: `Record<DomainEvent["eventType"], InvalidationHandler>` typing and parity tests.
- Planning signal: keep event additions small and require API/projection/frontend invalidation tests in the same PR.

### Discovery depends on external boards and locator heuristics

JobSpy discovery builds all query/location combinations, defaults to multiple boards, resolves source settings, filters locations, records progress, and depends on external board/ATS behavior.

- Evidence: `workers/automation/src/jobhunter/discovery/jobspy.py`, `workers/automation/pyproject.toml`, `docs/job-pipeline-architecture.md`
- Risk: board markup changes, rate limits, regional behavior, and ATS redirects can break recall or create noisy duplicates without local code changes.
- Current mitigation: source-quality projections, source registry, progress events, duplicate handling, and board configuration exist.
- Planning signal: keep discovery changes behind fixtures and live-smoke QA that does not depend on reading real private data.

### Generated local artifacts are central to product behavior

The product stores and previews generated resumes, cover letters, PDFs, material provenance, prompt outputs, and local browser/profile state. Many features intentionally read/write local files.

- Evidence: `README.md`, `docs/job-pipeline-architecture.md`, `apps/api/src/server.ts`, `apps/api/src/application-feedback.ts`, `workers/automation/src/jobhunter/apply/launcher.py`
- Risk: file moves, stale metadata, manual edits, and cleanup can make the UI show missing artifacts, incorrect preview availability, or stale audit evidence.
- Current mitigation: missing files are handled gracefully in several paths, artifact projections include status/provenance, and README safety notes warn not to commit generated data.
- Planning signal: centralize artifact root/path validation and add lifecycle tests for missing, moved, suppressed, and superseded artifacts.

### Frontend architecture rules rely mostly on discipline and tests

The repo documents strict frontend boundaries, but the backlog says ESLint/dependency-boundary setup and CI grep guards for cut-over invariants are not present.

- Evidence: `docs/frontend-target.md`, `AGENTS.md`, `docs/backlog.md`, `apps/web/package.json`
- Risk: direct API calls, cross-context imports, server data in client state, or custom event coordination can re-enter feature code without a blocking lint rule.
- Current mitigation: architecture docs, colocated tests, parity tests, and code review expectations.
- Planning signal: add `web:lint`, dependency-boundary rules, and grep guards for the named anti-patterns.

## Scaling Limits

### The runtime is local-first SQLite and single-tenant

The API and worker share local SQLite state and the API resolves SSE tenant to `LOCAL_TENANT`. Hosted seams are named in docs, but the current runtime is local-first.

- Evidence: `apps/api/src/event-stream.ts`, `apps/api/src/config.ts`, `docs/architecture.md`, `docs/frontend-target.md`
- Limit: multiple users, remote access, authorization, tenant isolation, and centralized operations are not current capabilities.
- Planning signal: do not treat the current API as hosted-ready without auth, tenant identity, database migration, object storage, and event transport changes.

### SQLite write contention already has explicit mitigation

The API writes projection refreshes during reads, and the worker writes canonical tables/projections/watermarks. The API sets `busy_timeout` specifically because contention is more likely.

- Evidence: `apps/api/src/db.ts`, `apps/api/src/projections.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`
- Limit: higher concurrency can hit database lock waits, especially with projection rebuilds, long-running worker writes, or multiple browser tabs.
- Planning signal: measure write-lock time and projection refresh duration before increasing worker/API concurrency.

### SSE and projection design are not high-fanout primitives

SSE subscribers poll the same local DB and projections are refreshed synchronously by read requests. This fits a local UI but not many concurrent clients.

- Evidence: `apps/api/src/event-stream.ts`, `apps/api/src/read-model.ts`, `docs/architecture.md`
- Limit: increasing clients multiplies read polling and cache invalidation load.
- Planning signal: keep local and hosted realtime architectures separate.

### Apply/browser automation is resource constrained

Auto-apply requires prepared materials, Chrome/Chromium, Claude Code CLI, optional CAPTCHA solving, and live browser state. Apply workflows can run for up to two hours.

- Evidence: `README.md`, `workers/automation/src/jobhunter/apply/workflow.py`, `workers/automation/src/jobhunter/apply/activities.py`
- Limit: browser sessions, profile state, CAPTCHAs, provider limits, and user supervision constrain throughput.
- Planning signal: keep apply concurrency conservative and make every auto-apply path explicit opt-in.

### Large local histories can stress in-memory read paths

Job free-text search, artifact listing, and apply-review previews all include in-memory or filesystem-heavy behavior.

- Evidence: `apps/api/src/read-model.ts`, `apps/api/src/application-feedback.ts`
- Limit: local history size increases CPU, memory, and filesystem work per request.
- Planning signal: introduce SQL pagination/filtering and preview caching when fixture sizes start reflecting real long-term use.

## Dependencies at Risk

### Public job-board scraping is inherently brittle

Discovery depends on `python-jobspy` and external boards/ATS behavior. Board markup, anti-bot controls, regional availability, and rate limits can change outside the repo.

- Evidence: `workers/automation/pyproject.toml`, `workers/automation/src/jobhunter/discovery/jobspy.py`, `docs/job-pipeline-architecture.md`
- Planning signal: isolate board-specific failures, track source-quality degradation, and keep live-smoke tests bounded.

### Browser automation depends on external CLIs and local browser state

Apply and LinkedIn resolver flows depend on Chrome/Chromium, browser profiles, Claude Code CLI, optional CAPTCHA solving, and authenticated sessions.

- Evidence: `README.md`, `workers/automation/src/jobhunter/apply/launcher.py`
- Planning signal: verify browser dependencies through `jobhunter doctor`/local QA and keep generated browser profiles out of repo artifacts.

### PDF generation depends on local LaTeX tooling

The runtime supports `PDFLATEX_PATH` override and generated PDFs are product artifacts.

- Evidence: `README.md`, `workers/automation/pyproject.toml`
- Planning signal: keep PDF generation failure modes explicit in QA and expose missing-tool guidance in product surfaces.

### Temporal dev server and worker stack are required for main workflows

The development stack starts a Temporal server and a JobHunter Temporal worker; worker heartbeats and runtime identity are part of API health and action safety.

- Evidence: `README.md`, `docs/job-pipeline-architecture.md`, `workers/automation/src/jobhunter/cli.py`, `apps/api/src/worker-health.ts`
- Planning signal: treat Temporal availability, worker heartbeat, and runtime mismatch as first-class operational checks.

### Frontend uses a broad TanStack/Radix/Storybook stack

The web app depends on TanStack Router/Query/Form/Table, Radix primitives, Storybook, Playwright, pdf.js, and Vitest. Some generated/tooling state is already inconsistent.

- Evidence: `apps/web/package.json`, `docs/decisions.md`, `docs/frontend-target.md`, `apps/web/src/routeTree.gen.ts`
- Planning signal: keep dependency upgrades small, route-tree generation deterministic, and Storybook/a11y gates active.

### Credentials and telemetry depend on platform and external services

Credentials use macOS Keychain through `security`, while telemetry uses Langfuse OTLP export when configured.

- Evidence: `apps/api/src/credentials.ts`, `workers/automation/src/jobhunter/infrastructure/observability/otel.py`
- Planning signal: document unsupported platforms and make external telemetry/storage modes explicit in the UI/doctor output.

## Missing Critical Features

### Web materials generation is not wired

The materials generation button is disabled, the mutation throws, the API route returns unsupported, and the E2E test is skipped.

- Evidence: `apps/web/src/contexts/materials/components/GenerateMaterialsButton.tsx`, `apps/web/src/contexts/materials/hooks/useGenerateMaterialsMutation.ts`, `apps/api/src/server.ts`, `apps/web/e2e/tests/materials.spec.ts`
- Planning signal: finish this as a vertical UI/API/worker/test slice.

### Hosted/authenticated mode is named but not implemented

Docs name hosted seams, tenant identity, hosted adapters, and future database/object-storage evolution, but the current implementation resolves tenant locally and relies on loopback API assumptions.

- Evidence: `docs/architecture.md`, `docs/frontend-target.md`, `apps/api/src/event-stream.ts`, `apps/api/src/config.ts`
- Planning signal: block any hosted deployment work on auth, tenant isolation, non-local artifact storage, and event bus decisions.

### Run-level cancellation UI is incomplete

Workflow run cancellation exists below the UI, but the Runs view has no in-row cancel action.

- Evidence: `apps/web/src/views/runs/RunsView.tsx`, `apps/api/src/local-actions.ts`
- Planning signal: implement run-level cancel with worker dispatch result visibility and QA coverage.

### Non-macOS credential storage is not implemented

The current API credential store is Keychain-only.

- Evidence: `apps/api/src/credentials.ts`
- Planning signal: add Linux/Windows credential adapters or display platform-specific unsupported state before presenting credential settings as portable.

### Frontend boundary linting is missing

The frontend architecture forbids several anti-patterns, but the backlog says there is no ESLint config, no `web:lint` script, no dependency-cruiser config, and no CI grep guards for cut-over invariants.

- Evidence: `docs/frontend-target.md`, `docs/backlog.md`, `apps/web/package.json`, `package.json`
- Planning signal: add blocking lint/CI rules before broad frontend feature expansion.

## Test Coverage Gaps

### Root test command is narrower than the documented QA surface

The root `pnpm test` runs API tests, web build, and Python tests. It does not run web Vitest, web type-level tests, web Playwright E2E, Storybook/a11y test runner, `qa:test`, Python lint, or package build.

- Evidence: `package.json`, `apps/web/package.json`, `docs/local-reliability-qa.md`
- Risk: a contributor can run the root test command and miss UI unit tests, type-level tests, E2E flows, Storybook a11y, and local QA smoke paths.
- Planning signal: clarify quick vs full verification commands and consider a root `qa` command that matches the documented bar.

### CI does not run several web suites

The backlog states CI does not run `web:test`, `web:test-d`, or `web:e2e`. The TypeScript workflow runs package checks, API tests, web build, Storybook build, and Storybook tests.

- Evidence: `docs/backlog.md`, `.github/workflows/typescript.yml`, `apps/web/package.json`
- Risk: component/hook unit regressions, type-level regressions, and standalone Playwright E2E regressions can remain local-only.
- Planning signal: wire web Vitest, type-level tests, and Playwright E2E into CI with deterministic fixtures.

### Materials E2E coverage is skipped

`apps/web/e2e/tests/materials.spec.ts` is `test.fixme` because generate-materials backend exposure is not wired.

- Evidence: `apps/web/e2e/tests/materials.spec.ts`, `docs/local-reliability-qa.md`, `docs/backlog.md`
- Risk: artifact/materials user flows depend on unit/component tests and manual QA until the backend slice exists.
- Planning signal: unskip the spec as part of the generate-materials vertical slice.

### Accessibility defects are intentionally deferred

The QA docs and backlog track 13 Storybook stories with `a11y: { test: "off" }` because they exercise current production a11y defects.

- Evidence: `docs/local-reliability-qa.md`, `docs/backlog.md`
- Risk: affected production components can keep serious/critical axe issues outside the Storybook a11y gate.
- Planning signal: burn down production-file deferrals first, then reassess wrapper/library deferrals.

### Browser action-status polling lacks product-level regression coverage

The backlog explicitly says no browser flow starts a stage and observes the action-status loop from queued/running to terminal.

- Evidence: `docs/backlog.md`
- Risk: progress UI regressions can pass lower-level tests.
- Planning signal: add a safe seeded flow that starts a non-apply stage and proves action-status terminal behavior.

### Projection parity remains a high-risk test surface

Projection logic is duplicated between TypeScript and Python and covers jobs, dashboard, artifacts, source quality, and apply-run lifecycle projections.

- Evidence: `apps/api/src/projections.ts`, `workers/automation/src/jobhunter/infrastructure/projections/projection_builder.py`, `docs/local-reliability-qa.md`
- Risk: one runtime can project a different read model than the other after schema or event changes.
- Planning signal: add cross-runtime projection fixtures whenever projection tables, legacy fallbacks, source quality, or apply-run events change.

*Concerns audit: 2026-06-08*
