# Phase 18: Posted Compensation Facts - Pattern Map

**Mapped:** 2026-06-19
**Files analyzed:** 12 planned new/modified surfaces
**Analogs found:** 12 / 12

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `packages/contracts/src/schemas.ts` | contract DTO | request-response | `packages/contracts/src/schemas.ts` profile/source/read DTO blocks | exact |
| `workers/automation/src/jobhunter/domain/compensation/posted.py` | model/parser | transform | `workers/automation/src/jobhunter/domain/*` value-object style plus parser tests; no salary parser analog | role-match |
| `workers/automation/src/jobhunter/database.py` | migration/schema helper | CRUD + batch backfill | `ensure_state_tables`, `ensure_employer_analysis_tables`, `ensure_materials_tables` backfill tests | exact |
| `workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py` | persistence helper | CRUD | `SqliteProjectionStore.upsert_job_list`, materials repository tests | role-match |
| `workers/automation/src/jobhunter/discovery/jobspy.py` | discovery integration | batch + CRUD | salary construction and `_refresh_existing_jobspy_job` | exact |
| `apps/api/src/posted-compensation-facts.ts` or read-model helper | service/utility | request-response | `apps/api/src/compensation-source-policy.ts` and `apps/api/src/read-model.ts` safe JSON parsing | exact |
| `apps/api/src/server.ts` | route/controller | request-response | `/v1/compensation/sources`, `/v1/jobs/:jobKey` read routes | exact |
| `apps/api/test/posted-compensation-facts.test.ts` | API test | request-response | `apps/api/test/compensation-source-policy.test.ts`, `discovery-controls.test.ts` | exact |
| `workers/automation/tests/test_posted_compensation_parser.py` | parser test | transform | `workers/automation/tests/test_score_use_cases.py` compensation regression style | role-match |
| `workers/automation/tests/test_posted_compensation_repository.py` | persistence test | CRUD + batch backfill | `workers/automation/tests/test_materials_repository.py` backfill tests | exact |
| `workers/automation/tests/test_posted_compensation_projection.py` | projection/regression test | batch/read-model | `workers/automation/tests/test_projection_builder.py` | role-match |
| `README.md`, `docs/local-ts-api.md`, `docs/architecture.md`, `docs/local-reliability-qa.md` | docs | transform | AGENTS documentation ownership matrix | exact |

## Pattern Assignments

### `packages/contracts/src/schemas.ts` (contract DTO, request-response)

**Analog:** `packages/contracts/src/schemas.ts`

**Imports and constants pattern** (lines 1-8):
```typescript
import { z } from "zod";

export const STAGES = ["discover", "enrich", "score", "tailor", "cover", "apply"] as const;
export type Stage = (typeof STAGES)[number];
```

**Zod request schema pattern** (lines 585-612):
```typescript
export const BulkJobMutationFilterSchema = z
  .object({
    q: optionalText,
    stage: z.enum(STAGES).optional().catch(undefined),
    state: z.enum(STAGE_STATES).optional().catch(undefined),
    deleted: z.enum(JOB_DELETED_FILTERS).default("active").catch("active"),
  })
  .strict();
export type BulkJobMutationFilter = z.infer<typeof BulkJobMutationFilterSchema>;
```

**Interface response pattern** (lines 1249-1261):
```typescript
export interface JobSummary {
  jobKey: string;
  url: string;
  title: string;
  company: string;
  source: string;
  salary: string;
}
```

**Apply to Phase 18:** Add `POSTED_COMPENSATION_PARSE_STATES`, component/period/warning enums, and a discriminated DTO shape where `parsed_range` is the only state allowed to carry normalized min/max/annualized fields. Keep `legacyRawSalary`/`rawFallback` as an explicit string field, not as the normalized source of truth.

### `workers/automation/src/jobhunter/domain/compensation/posted.py` (model/parser, transform)

**Analog:** no existing salary parser module; copy local style from Python domain value-object modules and test directly.

**Discovery source input to parse** (from `workers/automation/src/jobhunter/discovery/jobspy.py` lines 203-215):
```python
# Build salary string from min/max
salary = None
min_amt = row.get("min_amount")
max_amt = row.get("max_amount")
interval = str(row.get("interval", "")) if str(row.get("interval", "")) != "nan" else ""
currency = str(row.get("currency", "")) if str(row.get("currency", "")) != "nan" else ""
if min_amt and str(min_amt) != "nan":
    if max_amt and str(max_amt) != "nan":
        salary = f"{currency}{int(float(min_amt)):,}-{currency}{int(float(max_amt)):,}"
    else:
        salary = f"{currency}{int(float(min_amt)):,}"
    if interval:
        salary += f"/{interval}"
```

**Anti-pattern to avoid:** Do not reuse scoring's posted-compensation heuristic. Phase 18 needs deterministic facts with `missing`, `unparseable`, `ambiguous`, and `parsed_range` states, not a blocker-only check.

**Apply to Phase 18:** Parser should accept bounded `source_text` and optional source metadata, return an immutable value/dataclass with parse state, component, period, currency, min/max, annualized min/max only with `annualization_assumption`, confidence, warnings, and parser version. No network, LLM, profile-floor, ranking, or scoring calls.

### `workers/automation/src/jobhunter/database.py` (migration/schema helper, CRUD + batch)

**Analog:** `ensure_state_tables`, `ensure_employer_analysis_tables`, materials backfill.

**Connection and idempotent init pattern** (lines 25-55, 67-95):
```python
def get_connection(db_path: Path | str | None = None) -> sqlite3.Connection:
    path = str(db_path or DB_PATH)
    conn = sqlite3.connect(path, timeout=30)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    conn.row_factory = sqlite3.Row
    return conn

def init_db(db_path: Path | str | None = None) -> sqlite3.Connection:
    path = db_path or DB_PATH
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = get_connection(path)
```

**Canonical table pattern** (lines 338-370):
```python
def ensure_state_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    if conn is None:
        conn = get_connection()

    conn.execute("""
        CREATE TABLE IF NOT EXISTS job_stage_states (
            job_url             TEXT NOT NULL,
            stage               TEXT NOT NULL,
            state               TEXT NOT NULL DEFAULT 'pending',
            updated_at          TEXT NOT NULL,
            metadata_json       TEXT,
            version             INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (job_url, stage),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
    """)
```

**Forward-migration pattern** (lines 371-375):
```python
existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(job_stage_states)").fetchall()}
if "version" not in existing_cols:
    conn.execute("ALTER TABLE job_stage_states ADD COLUMN version INTEGER NOT NULL DEFAULT 0")
```

**Generation/audit table pattern** (lines 1499-1521, 1526-1548):
```python
def ensure_employer_analysis_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create the canonical employer-analysis tables (Phase 1).

    ... prior generations are retained as audit history (never deleted).
    """
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_employer_analysis (
            job_url               TEXT NOT NULL,
            generation            INTEGER NOT NULL,
            tenant_id             TEXT NOT NULL DEFAULT 'local',
            created_at            TEXT NOT NULL,
            PRIMARY KEY (job_url, generation),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
```

**Apply to Phase 18:** Add `ensure_posted_compensation_tables(conn)` and call it from `init_db`. Use a canonical table such as `job_posted_compensation_facts` keyed by `(tenant_id, job_url)` or `(tenant_id, job_url, source_hash/parser_version)` depending on whether history is required. Store bounded source text, legacy raw fallback, parse state, currency, period, component, min/max, annualized fields, warnings JSON, confidence, parser version, parsed_at. Backfill from `jobs.salary` without changing `jobs.salary`.

### `workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py` (persistence helper, CRUD)

**Analog:** `workers/automation/src/jobhunter/infrastructure/projections/sqlite_projection_store.py`

**Adapter constructor pattern** (lines 329-335):
```python
class SqliteProjectionStore:
    """SQLite-backed adapter for the ``ReadModelStore`` port (§5.8)."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_projection_tables(conn)
```

**Upsert pattern** (lines 338-386):
```python
def upsert_job_list(self, projection: JobListProjection) -> None:
    self._conn.execute(
        """
        INSERT INTO job_list_projections (
            tenant_id, job_id, title, employer, source, strategy, location,
            salary, application_url, discovered_at, description,
            last_updated_at
        ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(tenant_id, job_id) DO UPDATE SET
            title           = excluded.title,
            salary          = excluded.salary,
            last_updated_at = excluded.last_updated_at
        """,
        (...),
    )
```

**Apply to Phase 18:** Repository should call `ensure_posted_compensation_tables`, expose `save_fact(fact)`, `get_fact(tenant_id, job_id)`, and `backfill_from_legacy_jobs()` or a database-level helper. Use `json.dumps(..., sort_keys=True)` for warning arrays/metadata, explicit `1/0` for booleans if any, and never persist full descriptions/provider payloads.

### `workers/automation/src/jobhunter/discovery/jobspy.py` (discovery integration, batch + CRUD)

**Analog:** current salary string capture and metadata refresh.

**Existing salary assembly** (lines 203-215):
```python
salary = None
min_amt = row.get("min_amount")
max_amt = row.get("max_amount")
interval = str(row.get("interval", "")) if str(row.get("interval", "")) != "nan" else ""
currency = str(row.get("currency", "")) if str(row.get("currency", "")) != "nan" else ""
if min_amt and str(min_amt) != "nan":
    if max_amt and str(max_amt) != "nan":
        salary = f"{currency}{int(float(min_amt)):,}-{currency}{int(float(max_amt)):,}"
    else:
        salary = f"{currency}{int(float(min_amt)):,}"
    if interval:
        salary += f"/{interval}"
```

**Refresh without destructive legacy overwrite** (lines 462-478):
```python
UPDATE jobs SET
    title = COALESCE(NULLIF(?, ''), title),
    company = CASE
        WHEN COALESCE(company, '') = '' THEN COALESCE(NULLIF(?, ''), company)
        ELSE company
    END,
    salary = COALESCE(NULLIF(?, ''), salary),
    description = COALESCE(NULLIF(?, ''), description),
    detail_scraped_at = COALESCE(?, detail_scraped_at)
WHERE url = ?
```

**Event/audit pattern** (lines 581-600):
```python
record_job_event(
    conn,
    job_url,
    "discover",
    "JobSourceObserved",
    message="Job source observed.",
    payload={
        "tenantId": "local",
        "job_id": job_url,
        "jobId": job_url,
        "source_id": source_id,
        "sourceId": source_id,
    },
)
```

**Apply to Phase 18:** After accepting/inserting/refreshing a JobSpy job, parse the bounded salary string and persist a posted compensation fact. Do not alter the existing `salary = COALESCE(...)` compatibility behavior. If emitting an event, use a new event name such as `PostedCompensationFactParsed` with safe bounded fields only; Phase 20 owns read-model/SSE propagation.

### `apps/api/src/posted-compensation-facts.ts` or `apps/api/src/read-model.ts` helper (service, request-response)

**Analog:** `apps/api/src/compensation-source-policy.ts` and safe parsing helpers in `read-model.ts`.

**Read-only service response pattern** (from `compensation-source-policy.ts` lines 21-34):
```typescript
export function listCompensationSources(
  env: EnvLike = process.env,
): CompensationSourceRegistryResponse {
  return {
    ok: true,
    sources: [
      postedSalarySource(),
      eurostatSource(),
      escoSource(),
      spainIneSource(),
      levelsSource(env),
      glassdoorSource(env),
    ],
  };
}
```

**Safe JSON parse pattern** (from `read-model.ts` lines 2733-2741):
```typescript
function parseCoverageAudit(value: string | null): BulletCoverageAudit | null {
  if (!value || !value.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  const record = metadataRecord(parsed);
```

**Projection read constraint** (from `read-model.ts` lines 1-12):
```typescript
 * Every endpoint now reads from one of the five ``*_projections`` tables maintained
 * by ``projections.ts`` (TS mirror) and the Python ``ProjectionBuilder``.
 * The refresh runs at the start of every read so the projections always
 * reflect the latest worker writes.
```

**Apply to Phase 18:** For a narrow inspection API, prefer a dedicated helper that reads `job_posted_compensation_facts` directly and maps rows to contract DTOs. If using `read-model.ts`, keep the helper isolated and do not thread facts into `JobSummary`/`JobDetail` yet; that is Phase 20.

### `apps/api/src/server.ts` (route/controller, request-response)

**Analog:** read-only compensation sources endpoint and job detail route.

**Imports pattern** (lines 10-64, 73):
```typescript
import {
  JobListQuerySchema,
  type Stage,
  WorkflowRunsListQuerySchema,
} from "./contracts.js";
import { listCompensationSources } from "./compensation-source-policy.js";
```

**Read-only compensation endpoint** (line 266):
```typescript
app.get("/v1/compensation/sources", async () => listCompensationSources());
```

**Read endpoint with DB wrapper and decoded route param** (lines 489-493, 698):
```typescript
app.get("/v1/jobs", async (request, reply) =>
  withDb(reply, options.dbPath, (db) => listJobs(db, JobListQuerySchema.parse(request.query ?? {}))),
);

const detail = getJobDetail(db, decodeRouteParam(request.params.jobKey));
```

**DB error wrapper pattern** (lines 1990-2015):
```typescript
let db: ReturnType<typeof openDatabase> | null = null;
try {
  db = openDatabase(dbPath);
  return read(db);
} catch (error) {
  const opened = db !== null;
  void reply.code(opened ? 500 : 503);
  return {
    ok: false,
    error: opened ? "db_read_failed" : "db_open_failed",
    message: error instanceof Error ? error.message : "Unable to read the JobHunter database.",
  };
} finally {
  db?.close();
}
```

**Apply to Phase 18:** Add only `GET` routes, e.g. `/v1/compensation/posted-facts/:jobKey` and optionally batch `GET /v1/compensation/posted-facts?jobKeys=...`. Use `withDb`, `decodeRouteParam`, and response schemas/types from contracts. Do not add POST/PATCH mutation routes.

### API tests (request-response)

**Analog:** `apps/api/test/compensation-source-policy.test.ts`

**Temp app fixture pattern** (lines 10-19):
```typescript
function withTempApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-compensation-sources-"));
  const app = buildApp({
    dbPath: path.join(dir, "jobs.db"),
    settingsPath: path.join(dir, "dashboard.json"),
  });
  return {
    app,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
```

**Read-only endpoint assertion pattern** (lines 48-57):
```typescript
it("serves a read-only registry of safe compensation source policy fields", async () => {
  const { app, cleanup } = withTempApp();
  try {
    const response = await app.inject({ method: "GET", url: "/v1/compensation/sources" });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as CompensationSourceRegistryResponse;
    expect(body.ok).toBe(true);
```

**Sensitive-data negative assertion pattern** (lines 161-186):
```typescript
expect(JSON.stringify(response)).not.toContain("levels-secret");
const keys = collectKeys(response);
for (const forbiddenKey of [
  "apiKey",
  "credential",
  "rawPayload",
  "scrapedContent",
  "token",
]) {
  expect(keys).not.toContain(forbiddenKey);
}
```

**Apply to Phase 18:** Seed a temp SQLite database with `jobs` plus `job_posted_compensation_facts`. Assert 200 for parsed, missing/unparseable/ambiguous, raw fallback, 404 or null shape for unknown job per chosen contract, and that no full description/provider payload/credentials leak.

### Python parser and persistence tests (transform + CRUD)

**Analog:** `workers/automation/tests/test_materials_repository.py`

**Fixture pattern** (lines 53-66):
```python
@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    db_path = tmp_path / "jobhunter.db"
    return init_db(db_path)

def _seed_job(conn: sqlite3.Connection, url: str = "https://example.com/job/1") -> str:
    conn.execute(
        "INSERT INTO jobs (url, title, site, full_description, fit_score, discovered_at) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (url, "Engineer", "Acme", "Description", 9, "2024-01-01T00:00:00+00:00"),
    )
    conn.commit()
    return url
```

**Backfill/idempotency pattern** (lines 580-630):
```python
def test_backfill_copies_legacy_columns_into_job_materials(tmp_path: Path) -> None:
    db_path = tmp_path / "legacy.db"
    conn = init_db(db_path)
    conn.execute(
        "INSERT INTO jobs (url, title, fit_score, tailored_resume_path, tailored_at, "
        "cover_letter_path, cover_letter_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (...),
    )
    conn.execute("DROP TABLE job_materials_artifacts")
    conn.execute("DROP TABLE job_materials")
    conn.commit()
    ensure_materials_tables(conn)

def test_backfill_is_idempotent(tmp_path: Path) -> None:
    ensure_materials_tables(conn)
    ensure_materials_tables(conn)  # second call is a no-op
```

**Apply to Phase 18:** Parser tests should cover `missing`, `unparseable`, `ambiguous`, annual/month/hour, OTE, bonus, commission, equity, broad range, one-sided range, missing currency, missing period, confidence, warning codes, and annualization assumptions. Repository tests should prove `jobs.salary` remains unchanged, facts are stored separately, backfill is idempotent, source text is bounded, and no full descriptions are copied.

### Projection/regression tests (batch/read-model)

**Analog:** `workers/automation/tests/test_projection_builder.py`

**Watermark/backfill style** (lines 21-39, 80-96):
```python
@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)

def test_backfill_from_empty(conn: sqlite3.Connection) -> None:
    _seed_job(conn, "https://example.com/legacy-1")
    _seed_job(conn, "https://example.com/legacy-2")
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    rows = conn.execute(
        "SELECT job_id FROM job_list_projections ORDER BY job_id"
    ).fetchall()
```

**Apply to Phase 18:** If facts are not added to list/detail projections until Phase 20, write explicit regression tests that Phase 18 does not change `job_list_projections.salary`, `JobSummary.salary`, fit score, apply readiness, ranking, filtering, or mutation paths. If any inspection API reads a direct table, test it without requiring projection refresh.

### Docs (documentation, transform)

**Analog:** `AGENTS.md` documentation ownership matrix.

**Docs ownership pattern:**
```markdown
| User-facing product behavior, CLI commands, runtime requirements, generated local artifacts, or safety notes | README.md |
| Local QA expectations, regression matrix entries, high-risk workflows, or manually verified product paths | docs/local-reliability-qa.md |
| Local TypeScript API behavior, web app development commands, API/web verification, or dashboard migration details | docs/local-ts-api.md |
| TypeScript API plus Python worker architecture, local-first boundaries, orchestration, or phased migration constraints | docs/architecture.md |
```

**Apply to Phase 18:** Update `docs/local-ts-api.md` for the narrow inspection endpoint, `docs/architecture.md` for canonical posted compensation fact persistence separate from `jobs.salary`, `docs/local-reliability-qa.md` for parser/API regression coverage, and `README.md` only if user-facing behavior or local artifacts are exposed.

## Shared Patterns

### Canonical Persistence Separate From Legacy Fallback

**Source:** `workers/automation/src/jobhunter/database.py` lines 338-345 and `workers/automation/src/jobhunter/discovery/jobspy.py` lines 462-478.

```python
"""The legacy ``jobs`` columns remain in place for compatibility, but these
tables give the pipeline a durable source of truth..."""

salary = COALESCE(NULLIF(?, ''), salary),
```

**Apply to:** parser persistence, backfill, API DTOs, docs.

### Idempotent SQLite Schema and Forward Migration

**Source:** `database.py` lines 349-375 and `sqlite_projection_store.py` lines 308-321.

```python
conn.execute("""
    CREATE TABLE IF NOT EXISTS job_stage_states (...)
""")
existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(job_stage_states)").fetchall()}
if "version" not in existing_cols:
    conn.execute("ALTER TABLE job_stage_states ADD COLUMN version INTEGER NOT NULL DEFAULT 0")
```

**Apply to:** `ensure_posted_compensation_tables`, any future additive columns.

### Read-Only API Shape

**Source:** `server.ts` line 266 and `compensation-source-policy.ts` lines 21-34.

```typescript
app.get("/v1/compensation/sources", async () => listCompensationSources());
```

**Apply to:** `GET /v1/compensation/posted-facts...`; no mutation endpoint in Phase 18.

### Sensitive Data Boundaries

**Source:** `compensation-source-policy.test.ts` lines 161-186.

```typescript
for (const forbiddenKey of [
  "apiKey",
  "credential",
  "rawPayload",
  "scrapedContent",
  "token",
]) {
  expect(keys).not.toContain(forbiddenKey);
}
```

**Apply to:** API tests and persistence tests; store bounded source text only.

### Projection Boundary

**Source:** `read-model.ts` lines 1-12 and Phase 18 context.

**Apply to:** Do not add compensation summaries to canonical job list/detail read models or SSE invalidation in Phase 18. That is Phase 20.

## Anti-Patterns To Flag

| Anti-pattern | Why It Is Wrong For Phase 18 | Correct Pattern |
|--------------|------------------------------|-----------------|
| Writing parsed facts into `jobs.salary` | `jobs.salary` is legacy raw fallback and compatibility field | Add canonical `job_posted_compensation_facts` table |
| Computing facts in React or at read-time list rendering | Phase requires canonical local persistence before UI exposure | Parse in worker/domain layer and persist |
| Reusing scoring salary blockers as parser output | Scoring heuristic is not an inspectable fact model | Deterministic parser with explicit parse states and warnings |
| Storing full job descriptions/provider raw payloads | Phase allows only bounded source text | Persist exact bounded salary/source excerpt |
| Populating annualized fields without assumptions | Illegal normalized state; user must see assumptions | Require `annualization_assumption` for annualized values |
| Adding ranking/filtering/apply-readiness changes | Explicitly out of scope and risky | Add regression tests proving unchanged behavior |
| Adding list/detail compensation summaries or SSE invalidation | Owned by Phase 20 | Keep Phase 18 to parser, table, backfill, narrow inspection API |
| Calling LLMs, salary APIs, or scraping providers | Deterministic local parser only | No network, no LLM, synthetic tests |

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `workers/automation/src/jobhunter/domain/compensation/posted.py` | model/parser | transform | No existing deterministic salary parser module; use domain dataclass/value-object style and direct tests |

## Metadata

**Analog search scope:** `packages/contracts/src`, `apps/api/src`, `apps/api/test`, `workers/automation/src/jobhunter`, `workers/automation/tests`, docs ownership from `AGENTS.md`
**Files scanned:** required Phase 18 context plus contracts, API server/read-model/projections, Python database/projection/discovery files, API tests, Python projection/materials tests
**Pattern extraction date:** 2026-06-19
