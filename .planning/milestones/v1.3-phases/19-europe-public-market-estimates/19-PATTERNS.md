# Phase 19: Europe Public Market Estimates - Pattern Map

**Mapped:** 2026-06-19
**Files analyzed:** 13 planned new/modified surfaces
**Analogs found:** 13 / 13

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `workers/automation/src/jobhunter/domain/compensation/market.py` | model, utility | transform | `workers/automation/src/jobhunter/domain/compensation/posted.py` | exact |
| `workers/automation/src/jobhunter/domain/compensation/__init__.py` | config | transform | `workers/automation/src/jobhunter/domain/compensation/__init__.py` | exact |
| `workers/automation/src/jobhunter/infrastructure/compensation/market_repository.py` | repository | CRUD | `workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py` | exact |
| `workers/automation/src/jobhunter/infrastructure/compensation/__init__.py` | config | transform | `workers/automation/src/jobhunter/infrastructure/compensation/__init__.py` | exact |
| `workers/automation/src/jobhunter/database.py` | migration, config | CRUD | `ensure_posted_compensation_tables` in `workers/automation/src/jobhunter/database.py` | exact |
| `workers/automation/tests/test_market_compensation_repository.py` | test | CRUD | `workers/automation/tests/test_posted_compensation_repository.py` | exact |
| `workers/automation/tests/test_market_compensation_estimator.py` | test | transform | `workers/automation/tests/test_posted_compensation_parser.py` and repository test patterns | role-match |
| `packages/contracts/src/schemas.ts` | schema, contract | request-response | compensation source and posted compensation sections in `packages/contracts/src/schemas.ts` | exact |
| `apps/api/src/market-compensation-estimates.ts` | service, API mapper | request-response | `apps/api/src/posted-compensation-facts.ts` | exact |
| `apps/api/src/server.ts` | route | request-response | `GET /v1/jobs/:jobKey/compensation/posted` in `apps/api/src/server.ts` | exact |
| `apps/api/test/market-compensation-estimates.test.ts` | test | request-response | `apps/api/test/posted-compensation-facts.test.ts` | exact |
| `docs/local-ts-api.md` | docs | request-response | Phase 17/18 compensation API sections in `docs/local-ts-api.md` | exact |
| `docs/architecture.md`, `docs/local-reliability-qa.md` | docs | transform, request-response | posted compensation architecture and QA entries | role-match |

## Pattern Assignments

### `workers/automation/src/jobhunter/domain/compensation/market.py` (model, transform)

**Analog:** `workers/automation/src/jobhunter/domain/compensation/posted.py`

**Imports and immutable value-object pattern** (lines 3-10, 70-100):
```python
from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Literal

@dataclass(frozen=True)
class PostedCompensationFact:
    """Persistable posted compensation fact derived from bounded source text."""
```

**Discriminated-state constants pattern** (lines 12-18, 35-45):
```python
PARSER_VERSION = "posted-compensation-v1"
SOURCE_TEXT_LIMIT = 280

ParseState = Literal["missing", "unparseable", "ambiguous", "parsed_range"]
CompensationComponent = Literal["base_salary", "ote", "bonus", "commission", "equity", "unknown"]
CompensationPeriod = Literal["hour", "month", "year", "unknown"]
ConfidenceLevel = Literal["none", "low", "medium", "high"]

PARSE_STATES: tuple[ParseState, ...] = ("missing", "unparseable", "ambiguous", "parsed_range")
```

**Core deterministic transform pattern** (lines 103-117, 121-142, 201-223):
```python
def parse_posted_compensation(
    source_text: str | None,
    *,
    tenant_id: str = "local",
    job_url: str = "",
    source_field: str = "jobs.salary",
    parsed_at: str | None = None,
) -> PostedCompensationFact:
    """Parse a bounded salary/source string into a durable compensation fact."""

    now = parsed_at or datetime.now(timezone.utc).isoformat()
    bounded, truncated = _bounded_source_text(source_text)
    raw_fallback = bounded
    source_hash = _source_hash(bounded)
    warnings: list[WarningCode] = []
```

Use this shape for a pure `estimate_market_compensation(...)` or similarly named helper: no SQLite, no network, deterministic inputs, explicit `estimated_at`/version, bounded warnings/reasons, and legal state arms for `not_requested`, `unsupported`, `source_unavailable`, `insufficient_evidence`, and `estimated_range`.

**Helper pattern for bounded reasons/warnings** (lines 262-275, 469-470):
```python
def _bounded_source_text(value: str | None) -> tuple[str | None, bool]:
    if value is None:
        return None, False
    normalized = re.sub(r"\s+", " ", str(value).strip())
    if not normalized:
        return None, False
    if len(normalized) <= SOURCE_TEXT_LIMIT:
        return normalized, False
    return normalized[:SOURCE_TEXT_LIMIT].rstrip(), True

def _dedupe_warnings(warnings: list[WarningCode]) -> tuple[WarningCode, ...]:
    return tuple(dict.fromkeys(warnings))
```

### `workers/automation/src/jobhunter/domain/compensation/__init__.py` (config, transform)

**Analog:** current domain compensation barrel.

**Export pattern** (lines 1-12, 14-23):
```python
"""Posted compensation domain model and parser."""

from jobhunter.domain.compensation.posted import (
    CONFIDENCE_LEVELS,
    PARSER_VERSION,
    PARSE_STATES,
    PERIODS,
    SOURCE_TEXT_LIMIT,
    WARNING_CODES,
    PostedCompensationFact,
    parse_posted_compensation,
)

__all__ = [
    "CONFIDENCE_LEVELS",
    "PARSER_VERSION",
    "PARSE_STATES",
    "PERIODS",
    "SOURCE_TEXT_LIMIT",
    "WARNING_CODES",
    "PostedCompensationFact",
    "parse_posted_compensation",
]
```

Add market estimate types/functions to this same explicit import plus `__all__` pattern.

### `workers/automation/src/jobhunter/infrastructure/compensation/market_repository.py` (repository, CRUD)

**Analog:** `workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py`

**Imports and table bootstrap pattern** (lines 3-18):
```python
from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobhunter.database import ensure_posted_compensation_tables
from jobhunter.domain.compensation import PostedCompensationFact, parse_posted_compensation

class SqlitePostedCompensationRepository:
    """SQLite-backed repository for canonical posted compensation facts."""

    def __init__(self, conn: sqlite3.Connection) -> None:
        self._conn = conn
        ensure_posted_compensation_tables(conn)
```

Use a dedicated `ensure_market_compensation_tables(conn)` call in `__init__`; do not import API code or source-policy TS code into Python.

**Upsert pattern** (lines 20-71):
```python
def save_fact(self, fact: PostedCompensationFact) -> None:
    self._conn.execute(
        """
        INSERT INTO job_posted_compensation_facts (
            tenant_id, job_url, source_field, source_text, legacy_raw_salary,
            parse_state, currency, period, component, minimum_amount,
            maximum_amount, annualized_minimum_amount, annualized_maximum_amount,
            annualization_assumption, confidence, warnings_json, parser_version,
            source_hash, parsed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tenant_id, job_url) DO UPDATE SET
            source_field                 = excluded.source_field,
            source_text                  = excluded.source_text,
            legacy_raw_salary            = excluded.legacy_raw_salary,
            parse_state                  = excluded.parse_state,
            currency                     = excluded.currency,
            period                       = excluded.period,
            component                    = excluded.component,
            minimum_amount               = excluded.minimum_amount,
            maximum_amount               = excluded.maximum_amount,
            annualized_minimum_amount    = excluded.annualized_minimum_amount,
            annualized_maximum_amount    = excluded.annualized_maximum_amount,
            annualization_assumption     = excluded.annualization_assumption,
            confidence                   = excluded.confidence,
            warnings_json                = excluded.warnings_json,
            parser_version               = excluded.parser_version,
            source_hash                  = excluded.source_hash,
            parsed_at                    = excluded.parsed_at
        """,
```

Market estimate persistence should mirror this canonical-row upsert, but the Phase 19 context says facts are persisted immutable facts. If planner chooses immutability strictly, use `INSERT ... ON CONFLICT DO NOTHING` or versioned primary key; otherwise document why the Phase 18 upsert pattern is reused for idempotent backfill.

**Read mapper pattern** (lines 73-86, 113-137, 167-172):
```python
def get_fact(self, tenant_id: str, job_url: str) -> PostedCompensationFact | None:
    row = self._conn.execute(
        """
        SELECT tenant_id, job_url, source_field, source_text, legacy_raw_salary,
               parse_state, currency, period, component, minimum_amount,
               maximum_amount, annualized_minimum_amount, annualized_maximum_amount,
               annualization_assumption, confidence, warnings_json, parser_version,
               source_hash, parsed_at
        FROM job_posted_compensation_facts
        WHERE tenant_id = ? AND job_url = ?
        """,
        (tenant_id, job_url),
    ).fetchone()
    return _row_to_fact(row) if row is not None else None
```

```python
def _nullable_str(value: Any) -> str | None:
    return None if value is None else str(value)

def _nullable_int(value: Any) -> int | None:
    return None if value is None else int(value)
```

### `workers/automation/src/jobhunter/infrastructure/compensation/__init__.py` (config, transform)

**Analog:** current infrastructure compensation barrel.

**Export pattern** (lines 1-5):
```python
"""SQLite compensation fact persistence adapters."""

from jobhunter.infrastructure.compensation.sqlite_repository import SqlitePostedCompensationRepository

__all__ = ["SqlitePostedCompensationRepository"]
```

Export the market repository beside `SqlitePostedCompensationRepository`.

### `workers/automation/src/jobhunter/database.py` (migration, CRUD)

**Analog:** `ensure_posted_compensation_tables`.

**Startup registration pattern** (lines 143-146):
```python
# Run migrations for any columns added after initial schema
ensure_columns(conn)
ensure_posted_compensation_tables(conn)
ensure_state_tables(conn)
```

Add `ensure_market_compensation_tables(conn)` immediately after or near posted compensation so canonical compensation tables stay grouped.

**Canonical compensation table pattern** (lines 322-366):
```python
def ensure_posted_compensation_tables(conn: sqlite3.Connection | None = None) -> list[str]:
    """Create canonical posted compensation fact storage.

    The legacy ``jobs.salary`` column remains the raw compatibility fallback.
    This table stores deterministic parser output separately so downstream
    read models can distinguish raw posting text from normalized facts.
    """
    if conn is None:
        conn = get_connection()

    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS job_posted_compensation_facts (
            tenant_id                    TEXT NOT NULL DEFAULT 'local',
            job_url                      TEXT NOT NULL,
            source_field                 TEXT NOT NULL DEFAULT 'jobs.salary',
            source_text                  TEXT,
            legacy_raw_salary            TEXT,
            parse_state                  TEXT NOT NULL,
            currency                     TEXT,
            period                       TEXT NOT NULL DEFAULT 'unknown',
            component                    TEXT NOT NULL DEFAULT 'unknown',
            minimum_amount               INTEGER,
            maximum_amount               INTEGER,
            annualized_minimum_amount    INTEGER,
            annualized_maximum_amount    INTEGER,
            annualization_assumption     TEXT,
            confidence                   TEXT NOT NULL DEFAULT 'none',
            warnings_json                TEXT NOT NULL DEFAULT '[]',
            parser_version               TEXT NOT NULL,
            source_hash                  TEXT NOT NULL,
            parsed_at                    TEXT NOT NULL,
            PRIMARY KEY (tenant_id, job_url),
            FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE
        )
        """
    )
    conn.execute(
        """
        CREATE INDEX IF NOT EXISTS idx_job_posted_compensation_parse_state
        ON job_posted_compensation_facts (tenant_id, parse_state)
        """
    )
    conn.commit()
    return []
```

For Phase 19, use a separate table from `job_posted_compensation_facts`; include safe source identifiers, release/snapshot, aggregate bucket, attribution, optional sample count, state, confidence factors JSON, warnings JSON, reasons JSON, estimate version, and timestamp. Keep `FOREIGN KEY (job_url) REFERENCES jobs(url) ON DELETE CASCADE`.

### `workers/automation/tests/test_market_compensation_repository.py` (test, CRUD)

**Analog:** `workers/automation/tests/test_posted_compensation_repository.py`

**Temporary DB fixture and seed pattern** (lines 13-29):
```python
@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobhunter.db")

def _seed_job(
    conn: sqlite3.Connection,
    *,
    url: str = "https://example.com/jobs/1",
    salary: str | None = "€80,000-€95,000/year",
) -> str:
    conn.execute(
        "INSERT INTO jobs (url, title, site, salary, description, discovered_at) VALUES (?, ?, ?, ?, ?, ?)",
        (url, "Platform Engineer", "Example", salary, "Synthetic job", "2026-06-19T10:00:00Z"),
    )
    conn.commit()
    return url
```

**Schema/idempotence/no legacy mutation pattern** (lines 32-39, 65-80, 83-95):
```python
def test_schema_is_created_by_init_db(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_posted_compensation_facts'"
    ).fetchone()

    assert row is not None
    assert ensure_posted_compensation_tables(conn) == []
```

```python
assert repo.backfill_from_legacy_jobs(parsed_at="2026-06-19T10:00:00Z") == 1
assert repo.backfill_from_legacy_jobs(parsed_at="2026-06-19T10:00:00Z") == 1

rows = conn.execute("SELECT * FROM job_posted_compensation_facts WHERE job_url = ?", (job_url,)).fetchall()
salary = conn.execute("SELECT salary FROM jobs WHERE url = ?", (job_url,)).fetchone()["salary"]
fact = repo.get_fact("local", job_url)

assert len(rows) == 1
assert salary == "$180,000/year"
assert fact is not None
```

Add Phase 19 tests for table creation, round trip for `estimated_range`, unsupported/non-Europe state, source unavailable, insufficient evidence, no raw payload/local path persistence, deterministic fixture rows, and no mutation of `jobs.salary` or posted compensation facts.

### `workers/automation/tests/test_market_compensation_estimator.py` (test, transform)

**Analog:** posted compensation parser/repository assertions.

**State-specific assertions pattern** (repository test lines 97-113, 135-149):
```python
repo.backfill_from_legacy_jobs(parsed_at="2026-06-19T10:00:00Z")
fact = repo.get_fact("local", job_url)
salary = conn.execute("SELECT salary FROM jobs WHERE url = ?", (job_url,)).fetchone()["salary"]

assert salary == "Base €90k/year plus bonus €10k/year"
assert fact is not None
assert fact.parse_state == "ambiguous"
assert fact.minimum_amount is None
assert fact.maximum_amount is None
assert fact.annualized_minimum_amount is None
assert "ambiguous_multiple_amounts" in fact.warnings
```

For market estimates, assert weak support produces `insufficient_evidence` with no min/max fields; ESCO-only evidence never produces salary observations; Spain rows prefer INE; EU/Europe fallbacks include aggregate warnings; out-of-scope geography/component emits `unsupported`.

### `packages/contracts/src/schemas.ts` (schema, request-response)

**Analog:** compensation source and posted compensation sections.

**String-union DTO pattern** (lines 1976-2022):
```typescript
export const COMPENSATION_SOURCE_TYPES = [
  "posted_salary",
  "public_wage_baseline",
  "occupation_taxonomy",
  "licensed_market_benchmark",
] as const;
export type CompensationSourceType = (typeof COMPENSATION_SOURCE_TYPES)[number];

export const COMPENSATION_SUPPORTED_FIELDS = [
  "posted_range",
  "base_salary",
  "gross_annual_salary",
  "gross_monthly_salary",
  "wage_percentiles",
  "occupation_mapping",
  "market_range",
  "total_compensation",
  "sample_count",
  "freshness",
  "attribution",
] as const;
export type CompensationSupportedField = (typeof COMPENSATION_SUPPORTED_FIELDS)[number];
```

**Discriminated response pattern** (lines 2384-2494):
```typescript
export const POSTED_COMPENSATION_PARSE_STATES = [
  "missing",
  "unparseable",
  "ambiguous",
  "parsed_range",
] as const;
export type PostedCompensationParseState = (typeof POSTED_COMPENSATION_PARSE_STATES)[number];

export interface PostedCompensationParsedRangeFact extends PostedCompensationFactBase {
  parseState: "parsed_range";
  sourceText: string;
  currency: string | null;
  period: PostedCompensationPeriod;
  component: PostedCompensationComponent;
  minimumAmount: number | null;
  maximumAmount: number | null;
  annualizedMinimumAmount: number | null;
  annualizedMaximumAmount: number | null;
  annualizationAssumption: string | null;
  confidence: "low" | "medium" | "high";
}

export type PostedCompensationFact =
  | PostedCompensationMissingFact
  | PostedCompensationUnparseableFact
  | PostedCompensationAmbiguousFact
  | PostedCompensationParsedRangeFact;
```

Create market estimate DTOs with explicit state arms. Only `estimated_range` should carry range fields. `not_requested`, `unsupported`, `source_unavailable`, and `insufficient_evidence` should carry bounded reasons/warnings/confidence/source support without nullable precise ranges.

### `apps/api/src/market-compensation-estimates.ts` (service/API mapper, request-response)

**Analog:** `apps/api/src/posted-compensation-facts.ts`

**Imports, row typing, read-only lookup pattern** (lines 1-7, 54-86):
```typescript
import type {
  PostedCompensationFact,
  PostedCompensationFactResponse,
  PostedCompensationWarning,
  PostedCompensationWarningCode,
} from "./contracts.js";
import { getRow, tableExists, type SqliteDatabase } from "./db.js";

export function getPostedCompensationFact(
  db: SqliteDatabase,
  jobKey: string,
): PostedCompensationFactResponse | null {
  const job = getRow<JobSalaryRow>(db, "SELECT url, salary FROM jobs WHERE url = ?", [jobKey]);
  if (!job) {
    return null;
  }
  if (!tableExists(db, "job_posted_compensation_facts")) {
    return notRecorded(job);
  }
```

For Phase 19, use the same read-only shape: verify the job exists, return `null` for unknown job so the route maps 404, return a `not_requested` response for existing jobs with no market estimate table/row, and never compute/backfill/persist during GET.

**State mapper pattern** (lines 97-147):
```typescript
function mapFactRow(row: PostedCompensationFactRow): PostedCompensationFact {
  const base = {
    tenantId: row.tenant_id,
    jobKey: row.job_url,
    sourceField: row.source_field,
    legacyRawSalary: nullableText(row.legacy_raw_salary),
    parserVersion: row.parser_version,
    sourceHash: row.source_hash,
    parsedAt: row.parsed_at,
    warnings: parseWarnings(row.warnings_json),
  };

  if (row.parse_state === "missing") {
    return {
      ...base,
      parseState: "missing",
      sourceText: null,
      confidence: "none",
    };
  }
```

Implement `mapMarketEstimateRow` as a discriminated mapper. Do not include `minimumAmount`/`maximumAmount` on non-`estimated_range` arms.

**Safe JSON warning parsing pattern** (lines 149-166):
```typescript
function parseWarnings(value: string): PostedCompensationWarning[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "[]");
  } catch {
    parsed = [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed
    .filter((entry): entry is PostedCompensationWarningCode => isWarningCode(entry))
    .map((code) => ({ code, message: WARNING_MESSAGES[code] }));
}
```

Use the same defensive parse for `warnings_json`, `reasons_json`, `confidence_factors_json`, and `sources_json`.

### `apps/api/src/server.ts` (route, request-response)

**Analog:** existing compensation source and posted fact routes.

**Import pattern** (lines 73-75):
```typescript
import { listCompensationSources } from "./compensation-source-policy.js";
import { databaseExists, openDatabase } from "./db.js";
import { getPostedCompensationFact } from "./posted-compensation-facts.js";
```

**Read-only source registry route** (line 267):
```typescript
app.get("/v1/compensation/sources", async () => listCompensationSources());
```

**Read-only job compensation route** (lines 494-505):
```typescript
app.get<{ Params: { jobKey: string } }>(
  "/v1/jobs/:jobKey/compensation/posted",
  async (request, reply) =>
    withDb(reply, options.dbPath, (db) => {
      const response = getPostedCompensationFact(db, decodeRouteParam(request.params.jobKey));
      if (!response) {
        void reply.code(404);
        return { ok: false, error: "job_not_found" };
      }
      return response;
    }),
);
```

Add the market route beside posted compensation, likely `GET /v1/jobs/:jobKey/compensation/market-estimate`. It must use `withDb`, not `withWritableDb`.

### `apps/api/test/market-compensation-estimates.test.ts` (test, request-response)

**Analog:** `apps/api/test/posted-compensation-facts.test.ts`

**Temp app and seed pattern** (lines 10-23, 25-53):
```typescript
function withTempApp(options: { factTable?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-posted-compensation-"));
  const dbPath = path.join(dir, "jobs.db");
  seedDatabase(dbPath, options);
  const app = buildApp({
    dbPath,
    settingsPath: path.join(dir, "dashboard.json"),
  });
  return {
    app,
    dbPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
```

**Manual table fixture pattern** (lines 56-81, 83-131):
```typescript
function createFactTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE job_posted_compensation_facts (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      source_field TEXT NOT NULL DEFAULT 'jobs.salary',
      source_text TEXT,
      legacy_raw_salary TEXT,
      parse_state TEXT NOT NULL,
      currency TEXT,
      period TEXT NOT NULL DEFAULT 'unknown',
      component TEXT NOT NULL DEFAULT 'unknown',
      minimum_amount INTEGER,
      maximum_amount INTEGER,
      annualized_minimum_amount INTEGER,
      annualized_maximum_amount INTEGER,
      annualization_assumption TEXT,
      confidence TEXT NOT NULL DEFAULT 'none',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      parser_version TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      parsed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_url)
    );
  `);
}
```

**No-write-on-read and leak assertions** (lines 259-280, 302-323):
```typescript
it("returns an explicit not-recorded response without writing on read", async () => {
  const { app, dbPath, cleanup } = withTempApp();
  try {
    expect(factCount(dbPath)).toBe(0);
    const response = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/not-recorded")}/compensation/posted`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      recordStatus: "not_recorded",
      jobKey: "https://example.com/jobs/not-recorded",
      legacyRawSalary: "€77,000/year",
    });
    expect(factCount(dbPath)).toBe(0);
  } finally {
    await app.close();
    cleanup();
  }
});
```

```typescript
const serialized = JSON.stringify(response.json());
expect(serialized).not.toContain("Full private description");
expect(serialized).not.toContain("rawProviderPayload");
expect(serialized).not.toContain("/Users/");
expect(serialized).not.toContain("secret");
expect(serialized).not.toContain("glassdoor");
expect(serialized).not.toContain("levels");
```

Replicate for market estimates: `not_requested` for existing job with no row, older DB without table, 404 for unknown job, no writes during GET, no raw/private/licensed-provider leakage, and no job list/detail shape changes.

### `apps/api/src/compensation-source-policy.ts` (source policy input, transform)

**Analog:** same file, Europe public source entries and licensed disabled seams.

**Europe public source entries** (lines 61-147):
```typescript
function eurostatSource(): CompensationSourcePolicySummary {
  return {
    sourceId: "eurostat_structure_of_earnings",
    displayName: "Eurostat Structure of Earnings Survey",
    sourceType: "public_wage_baseline",
    accessMode: "public_dataset",
    availability: "available",
    licenseStatus: "not_required",
```

```typescript
function escoSource(): CompensationSourcePolicySummary {
  return {
    sourceId: "esco_occupation_taxonomy",
    displayName: "ESCO occupation taxonomy",
    sourceType: "occupation_taxonomy",
    accessMode: "public_taxonomy",
    availability: "available",
```

```typescript
function spainIneSource(): CompensationSourcePolicySummary {
  return {
    sourceId: "spain_ine_salary_structure",
    displayName: "Spain INE salary structure survey",
    sourceType: "public_wage_baseline",
    accessMode: "public_dataset",
    availability: "available",
```

Market estimate fixtures and DTO source IDs should use these exact IDs. ESCO is occupation taxonomy only; Eurostat and INE are public wage baselines.

**Licensed source do-not-use seam** (lines 149-186, 189-224):
```typescript
notes: [
  "Policy seam only; no Levels.fyi fetch, scrape, cache, credential, or salary import path is registered here.",
],
```

```typescript
notes: [
  "Policy seam only; no Glassdoor fetch, scrape, cache, credential, or salary import path is registered here.",
],
```

Tests for Phase 19 should assert market estimates do not mention/use `levels_fyi` or `glassdoor`.

### `docs/local-ts-api.md` (docs, request-response)

**Analog:** existing compensation API docs.

**Source registry docs pattern** (lines 211-228):
```markdown
`GET /v1/compensation/sources` returns the read-only compensation source policy
registry used by the Settings compensation-source panel. The response contains
safe policy metadata only: source id, display name, source type, access mode,
availability, license status, terms/source URLs, freshness policy, attribution
requirement, supported field names, disabled reason, configured flag, Europe
coverage notes, and safe operator notes. It does not return credentials, raw
provider payloads, private-account state, local paths, scraped salary data, or
salary observations.
```

**Read-only compensation endpoint docs pattern** (lines 230-248):
```markdown
`GET /v1/jobs/:jobKey/compensation/posted` returns the Phase 18 read-only
inspection contract for canonical posted-compensation facts. The endpoint reads
`job_posted_compensation_facts` only; it does not parse, backfill, update,
persist, refresh projections, call external providers, or run React-side
normalization during a GET.
```

Add a parallel Phase 19 paragraph for `GET /v1/jobs/:jobKey/compensation/market-estimate`: reads only canonical market estimate rows, returns `not_requested` for no row, never estimates or writes on GET, and defers job list/detail/SSE to Phase 20.

### `docs/architecture.md` and `docs/local-reliability-qa.md` (docs, transform/request-response)

**Architecture analog:** posted compensation persistence boundary.

**Read-model deferral pattern** (`docs/architecture.md` lines 421-425):
```markdown
Posted-compensation facts are persisted in `job_posted_compensation_facts`
before inspection. Phase 18 exposes them through a narrow read-only API only;
the projection-backed Jobs list/detail compensation summary and SSE invalidation
are deferred to the Phase 20 read-model contract so Python and TypeScript
projection builders can be updated in parity.
```

**Sensitive storage boundary pattern** (`docs/architecture.md` lines 785-790):
```markdown
Posted compensation facts live in the canonical
`job_posted_compensation_facts` table. The parser consumes only bounded salary
source text such as `jobs.salary`, records explicit parse states and warnings,
and keeps `jobs.salary` unchanged as a compatibility/raw fallback. It does not
store full descriptions, provider raw payloads, credentials, local paths, or
licensed-source salary data.
```

Add market estimates as a separate canonical table with public aggregate source metadata only; no raw benchmark pages, credentials, private account payloads, local paths, user compensation preferences, or licensed-source salary data.

**QA matrix analog** (`docs/local-reliability-qa.md` line 69):
```markdown
| Posted compensation parsing loses explicit states, over-captures source text, annualizes without assumptions, mutates `jobs.salary`, writes facts from API GET reads, leaks private data, or changes fit score, sorting, filtering, apply readiness, or apply dispatch behavior | `workers/automation/tests/test_posted_compensation_parser.py`; `workers/automation/tests/test_posted_compensation_repository.py`; `workers/automation/tests/test_discovery_identity.py`; `workers/automation/tests/test_discovery_limits.py`; `apps/api/test/posted-compensation-facts.test.ts`; `apps/api/test/server.test.ts` (`compensation boundary`) |
```

Add a Phase 19 row for market estimates losing explicit states/confidence factors, producing ranges for weak evidence, using non-Europe/licensed sources, writing on API GET, leaking source/private data, or changing score/ranking/filtering/apply behavior.

## Shared Patterns

### Explicit Discriminated States

**Source:** `workers/automation/src/jobhunter/domain/compensation/posted.py` lines 15-18 and `packages/contracts/src/schemas.ts` lines 2384-2494.

Apply to domain model, persistence mapper, TS contracts, and API response mapper. Illegal states should be structurally hard to represent: non-range states do not carry range fields.

### Canonical Table Separate From Legacy/Projection Data

**Source:** `workers/automation/src/jobhunter/database.py` lines 322-366 and `docs/architecture.md` lines 421-425.

Apply to market estimates. Use a new canonical SQLite table separate from `jobs.salary`, `job_posted_compensation_facts`, and Phase 20 projection tables.

### No Write On Read

**Source:** `apps/api/src/server.ts` lines 494-505, `apps/api/src/posted-compensation-facts.ts` lines 54-86, and `apps/api/test/posted-compensation-facts.test.ts` lines 259-280.

Apply to the Phase 19 GET endpoint. Route must use `withDb`; mapper must only read `jobs` and market estimate table; missing row returns `not_requested`; tests must count rows before/after GET.

### Safe Source Policy

**Source:** `apps/api/src/compensation-source-policy.ts` lines 61-147 and 149-224.

Apply to estimator fixtures and API DTO source metadata. Allowed IDs: `eurostat_structure_of_earnings`, `esco_occupation_taxonomy`, `spain_ine_salary_structure`. Do not fetch/scrape/import/cache/display Glassdoor or Levels.fyi data.

### Defensive JSON Columns

**Source:** `workers/automation/src/jobhunter/infrastructure/compensation/sqlite_repository.py` lines 5, 65, 113-117 and `apps/api/src/posted-compensation-facts.ts` lines 149-166.

Use JSON text columns for bounded arrays/objects such as warnings, reasons, confidence factors, source evidence, and aggregate buckets. Parse defensively in API mappers.

### Sensitive Data Boundary

**Source:** `apps/api/test/posted-compensation-facts.test.ts` lines 302-323 and `docs/local-ts-api.md` lines 211-218.

API responses and persisted market estimate rows must not include private descriptions, raw provider payloads, credentials, local paths, user compensation preferences, Glassdoor/Levels salary data, or raw benchmark pages.

## No Analog Found

None. Every planned Phase 19 surface has a close Phase 18 or source-policy analog. The new estimation algorithm itself has no salary-market predecessor, but it should copy the deterministic pure-transform pattern from `posted.py` and the source-safety constraints from `compensation-source-policy.ts`.

## Metadata

**Analog search scope:** `workers/automation/src/jobhunter/domain/compensation`, `workers/automation/src/jobhunter/infrastructure/compensation`, `workers/automation/tests`, `apps/api/src`, `apps/api/test`, `packages/contracts/src`, `docs`
**Files scanned:** 16
**Pattern extraction date:** 2026-06-19

## PATTERNS COMPLETE
