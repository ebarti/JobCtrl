# Testing Patterns

**Analysis Date:** 2026-06-08

## Test Framework

**TypeScript/API/Web Runner:**
- Vitest `4.1.5` is used by `apps/api`, `apps/web`, and `packages/domain-types`.
- API test command: `pnpm api:test` -> `vitest run test` from `apps/api/package.json`.
- Web unit/hook/component command: `pnpm --filter @jobhunter/web test` -> `vitest run` from `apps/web/package.json`.
- Web type-level command: `pnpm --filter @jobhunter/web test-d` -> `vitest run --config vitest.types.config.ts`.
- Shared package typecheck commands are in `packages/contracts/package.json`, `packages/domain-types/package.json`, and root `package.json`.

**Web Test Config:**
- Unit/component config: `apps/web/vitest.config.ts`.
- Type-level config: `apps/web/vitest.types.config.ts`.
- Test environment is `jsdom` with setup file `apps/web/src/test/setup.ts`.
- Coverage provider is V8 with text and HTML reporters and 50% thresholds for statements, branches, functions, and lines.

**E2E Runner:**
- Playwright is configured in `apps/web/e2e/playwright.config.ts`.
- E2E runs a real API server on `127.0.0.1:8767` and Vite web server on `127.0.0.1:5174` with a seeded temp app directory.

**Python Runner:**
- Pytest runs through `uv --project workers/automation run --extra dev pytest -q`.
- `workers/automation/pyproject.toml` sets `asyncio_mode = "strict"`.
- Ruff lint runs through `uv --project workers/automation run --extra dev ruff check .`.

**Run Commands:**
```bash
pnpm test                                      # Root TS/API/web build + Python test gate
pnpm api:test                                  # Fastify/API Vitest tests
pnpm --filter @jobhunter/web test              # Web Vitest unit/hook/component/a11y suites
pnpm --filter @jobhunter/web test:coverage     # Web V8 coverage
pnpm --filter @jobhunter/web test-d            # Web type-level tests
pnpm --filter @jobhunter/web e2e               # Web Playwright E2E
pnpm qa:test                                   # API destructive-workflow QA fixture test
uv --project workers/automation run --extra dev pytest -q
uv --project workers/automation run --extra dev ruff check .
git diff --check
```

## Test File Organization

**Current Counts:**
- TypeScript/TSX source files under `apps` and `packages`: 636.
- TypeScript `*.test.ts`, `*.test.tsx`, and `*.test-d.ts` files under `apps` and `packages`: 147.
- Playwright specs under `apps/web/e2e/tests`: 9.
- Python source files under `workers/automation/src/jobhunter`: 198.
- Pytest modules under `workers/automation/tests`: 127.
- Storybook stories under `apps/web/src`: 86.
- Web a11y tests under `apps/web/src`: 9.

**TypeScript API:**
- API tests live in `apps/api/test`, not colocated with `apps/api/src`.
- Representative files: `apps/api/test/server.test.ts`, `apps/api/test/json-rpc-adapter.test.ts`, `apps/api/test/qa-workflow.test.ts`.
- Tests construct temp local app state and call Fastify via `app.inject`.

**Web:**
- Unit, hook, component, a11y, and Storybook files are colocated under `apps/web/src`.
- Shared web fixtures and harnesses live under `apps/web/src/test`.
- Type-level tests live under `apps/web/test/types`.
- E2E specs live under `apps/web/e2e/tests`.

**Shared Packages:**
- `packages/domain-types/test` holds Vitest tests for domain event/state alphabets and parity.
- `packages/contracts` currently exposes schemas and typechecks through `pnpm --filter @jobhunter/contracts check`.

**Python Worker:**
- Tests live in the separate `workers/automation/tests` tree.
- Names follow `test_<subject>.py`, for example `workers/automation/tests/test_score_aggregate.py` and `workers/automation/tests/test_apply_use_cases.py`.

## Test Structure

**Vitest API Pattern:**
```typescript
describe("local TypeScript API", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-"));
    options = { dbPath: path.join(tempDir, "jobhunter.db"), ... };
    seedDatabase(options.dbPath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { force: true, recursive: true });
  });

  it("reports local database health", async () => {
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/health" });
    expect(response.statusCode, response.body).toBe(200);
    await app.close();
  });
});
```
- Use `app.inject` for API endpoints instead of opening sockets.
- Use `better-sqlite3` and helper seed functions for projection/read-model state.
- Clean temp directories in `afterEach`.

**Vitest Web Hook Pattern:**
```typescript
describe("useJobsListQuery", () => {
  it("returns the MSW-mocked job list", async () => {
    const { result } = renderHookWithProviders(() => useJobsListQuery({}));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.jobKey).toBe("job-1");
  });
});
```
- Use `renderHookWithProviders` from `apps/web/src/test/render.tsx`.
- Use `waitFor` for async TanStack Query state.
- Keep query retries disabled in `createTestQueryClient()`.

**Vitest Web Mutation Pattern:**
```typescript
it("rolls back the optimistic patch when the request fails", async () => {
  server.use(http.delete("*/v1/jobs/:jobKey", () => new HttpResponse("{}", { status: 500 })));
  const { result, queryClient } = renderHookWithProviders(() => useDeleteJobMutation());
  queryClient.setQueryData(jobsKeys.list(LOCAL_TENANT, {}), original);
  await act(async () => result.current.mutate({ jobId: "job-1" }));
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(queryClient.getQueryData(jobsKeys.list(LOCAL_TENANT, {}))).toEqual(original);
});
```
- Mutation hooks with optimistic behavior need success and rollback coverage.
- Use `server.use(...)` from `apps/web/src/test/msw/server.ts` for per-test HTTP failure overrides.

**Pytest Pattern:**
```python
@pytest.mark.parametrize("value", [1, 5, 10])
def test_fit_score_accepts_in_range(value: int) -> None:
    assert FitScore.create(value).value == value

def test_job_score_rejects_zero_version() -> None:
    with pytest.raises(ValueError):
        JobScore(...)
```
- Use plain assert style, `pytest.mark.parametrize`, and `pytest.raises(..., match=...)`.
- Keep pure domain tests free of I/O; see `workers/automation/tests/test_score_aggregate.py`.
- Use in-memory fakes for ports/repositories in use-case tests; see `_InMemoryApplyRunRepository` and `_FakeAgent` in `workers/automation/tests/test_apply_use_cases.py`.

## Mocking

**Web MSW:**
- `apps/web/src/test/setup.ts` starts MSW with `onUnhandledRequest: "error"`.
- Default REST handlers live in `apps/web/src/test/msw/handlers.ts`.
- SSE handlers live in `apps/web/src/test/msw/sse-handlers.ts`.
- Add new REST handlers to `apps/web/src/test/msw/handlers.ts`; do not create a second MSW server.

**Web Provider Fakes:**
- `apps/web/src/test/testPorts.ts` defines fake ports: `FakeEventStreamPort`, `InMemoryStoragePort`, `FakeSessionPort`, `FakeClipboardPort`, `FakeOpenInOsPort`, `FakeTelemetryPort`, and `FakeFeatureFlagPort`.
- `buildTestPorts()` wraps the real `FetchApiClientAdapter` and lets tests override individual API methods.
- Use fake ports for direct component behavior and MSW for network-level query/mutation behavior.

**API Fakes:**
- API tests inject fake dispatchers and stores through `BuildAppOptions` in `apps/api/src/server.ts`.
- JSON-RPC adapter behavior is tested with an in-memory `FakeDispatcher` in `apps/api/test/json-rpc-adapter.test.ts`; do not spawn the Python worker for those tests.

**Python Fakes:**
- Use small in-test fake classes for repositories, browsers, agents, publishers, and snapshots.
- Use `monkeypatch` for environment/path/function seams, especially legacy adapter seams and local filesystem paths.
- Use `tmp_path` for generated files and SQLite databases.

**What To Mock:**
- External network, browser automation, Gmail, LLMs, OS opener, clipboard, subprocess/RPC dispatch, and filesystem paths outside a temp directory.
- Time-sensitive or async UI state only at the boundary needed to make assertions deterministic.

**What Not To Mock:**
- Pure domain value objects, aggregate invariants, state-machine serialization, frontend selectors, query-key factories, and DDD parity alphabets.

## Fixtures And Factories

**Web Fixtures:**
- Shared projection fixtures live in `apps/web/src/test/fixtures/projections.ts`.
- Domain event fixtures live in `apps/web/src/test/fixtures/events.ts`.
- Use fixture factories such as `makeJobsPage`, `makeJobDetail`, and `makeWorkflowRunsPage` rather than duplicating projection shapes in each test.

**API Fixtures:**
- API tests keep local helper factories inside test files, such as `validProfileFixture`, `profileWithTargetSearch`, and `deferred` in `apps/api/test/server.test.ts`.
- Seed helper functions in API tests create only the DB rows required by the behavior under test.

**Python Fixtures:**
- `workers/automation/tests/conftest.py` sets a session-scoped `JOBHUNTER_DIR` sandbox and disables Langfuse network export by default.
- Many Python tests define small local fixtures or fake classes in the same module, keeping test data close to the use case under test.

## Coverage And QA Gates

**Coverage:**
- Web coverage is configured in `apps/web/vitest.config.ts` with V8 and 50% thresholds.
- No repository-wide Python coverage threshold is configured in `workers/automation/pyproject.toml`.
- Root `pnpm test` runs API tests, web build, and Python tests; it does not run web Vitest, web E2E, Storybook, or Python Ruff.

**Required QA Matrix:**
- `docs/local-reliability-qa.md` is the canonical high-risk regression matrix.
- For UI/API/product-flow changes, include a product-path QA stage in addition to unit tests.
- For scoring policy changes, run the focused scoring eval gate listed in `docs/local-reliability-qa.md`.
- For resume tailoring quality changes, run the focused materials quality eval gate listed in `docs/local-reliability-qa.md`.

## Test Types

**Unit Tests:**
- Use for pure domain/value-object behavior in `packages/domain-types/test` and `workers/automation/tests/test_*_aggregate.py`.
- Use for frontend selectors and small components, for example `apps/web/src/contexts/apply/selectors/applyRunSelectors.test.ts`.

**Hook And Component Tests:**
- Use React Testing Library with the provider harness in `apps/web/src/test/render.tsx`.
- Cover one query hook per Operations read hook and one mutation hook per context mutation.
- For form tests, use `userEvent.setup()` and assert emitted mutation payloads, as in `apps/web/src/contexts/profile/forms/profile-form.test.tsx`.

**Accessibility Tests:**
- Use `jest-axe` in colocated `*.a11y.test.tsx` files.
- The matcher is registered in `apps/web/src/test/setup.ts` via `toHaveNoViolations`.
- Storybook's addon-a11y is configured separately in `.storybook` and described in `docs/local-reliability-qa.md`.

**Parity Tests:**
- Do not skip `apps/web/src/contexts/operations/every-event-has-handler.test.ts`; it asserts every `DOMAIN_EVENT_TYPES` variant has a working invalidation handler and non-empty invalidation output.
- Do not skip `apps/web/src/contexts/pipeline/components/every-stage-state-has-badge.test.tsx`; it asserts every `STAGE_STATE_KINDS` variant renders with a non-default badge tone.
- Worker/domain parity checks also exist in files such as `workers/automation/tests/test_domain_event_parity.py` and `workers/automation/tests/test_state_machine_parity.py`.

**Integration Tests:**
- API integration tests run Fastify through `app.inject` against seeded temp SQLite.
- Python use-case tests combine aggregates with fake repositories and ports.
- Projection tests exercise actual read-model/projection construction from DB/event state.

**End-To-End Tests:**
- Playwright specs live in `apps/web/e2e/tests`.
- E2E config seeds temp app state in `apps/web/e2e/fixtures/global-setup.ts` and tears it down with `global-teardown.ts`.
- Specs assert user-visible behavior and layout regressions, for example the Dashboard KPI navigation and funnel-bar overlap checks in `apps/web/e2e/tests/dashboard.spec.ts`.

**Storybook Tests:**
- Stories are colocated as `*.stories.tsx`.
- Use per-state MSW-backed stories for view composers/forms and per-variant stories for primitives.
- Run `pnpm web:storybook:build` and `pnpm web:storybook:test` when the changed UI surface depends on story coverage or a11y addon enforcement.

## Common Patterns

**Async Query Testing:**
```typescript
const { result } = renderHookWithProviders(() => useWorkflowRunsListQuery({}));
await waitFor(() => expect(result.current.isSuccess).toBe(true));
```

**API Error Testing:**
```typescript
const response = await app.inject({ method: "POST", url: "/v1/...", payload });
expect(response.statusCode, response.body).toBe(400);
expect(response.json()).toMatchObject({ ok: false });
```

**Python Error Testing:**
```python
with pytest.raises(ValueError, match="at least one keyword"):
    MatchedKeywords(values=())
```

**E2E Polling:**
```typescript
await expect.poll(async () => rows.count(), { timeout: 30_000 }).toBe(totalJobs);
```

## Adding Tests

- Put web tests next to the source they cover unless they are type-level or Playwright specs.
- Add MSW handlers to `apps/web/src/test/msw/handlers.ts` or `apps/web/src/test/msw/sse-handlers.ts`.
- Use `renderWithProviders` or `renderHookWithProviders` for frontend code that depends on ports, tenant, QueryClient, router, theme, density, tooltips, toasts, or event streams.
- Inject API dependencies through `BuildAppOptions` instead of monkeypatching API internals.
- Keep Python tests hermetic with `tmp_path`, local fake ports/repositories, and `monkeypatch`; never touch real `~/.jobhunter` data.
- Add or update a regression fixture for visible defects in auditability, evidence, scoring, tailoring, generated materials, or apply approval surfaces.

---

*Testing analysis: 2026-06-08*
*Update when test patterns change*
