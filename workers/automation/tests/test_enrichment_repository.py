"""Phase 7 / S-26: SqliteEnrichmentRepository round-trip + backfill + queue.

Pin the repository's contract: round-trip JobEnrichment aggregates,
list_pending sees jobs without an enrichment row, list_failed surfaces
the failed aggregates, and the legacy backfill produces the right shape.
"""

from __future__ import annotations

import json
import sqlite3

import pytest

from jobctrl.database import init_db
from jobctrl.domain.enrichment import (
    ApplicationUrl,
    ExtractionTier,
    FullDescription,
    JobEnrichment,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    db_path = tmp_path / "jobctrl.db"
    return init_db(db_path)


def _insert_job(conn: sqlite3.Connection, url: str, **legacy_cols) -> None:
    """Insert a discovery row with optional legacy enrichment columns."""
    base_cols = ["url", "title", "site", "discovered_at"]
    base_vals = [url, legacy_cols.pop("title", "Some title"), "greenhouse", "2026-05-01T00:00:00+00:00"]
    cols = list(base_cols)
    vals: list = list(base_vals)
    for k, v in legacy_cols.items():
        cols.append(k)
        vals.append(v)
    placeholders = ", ".join(["?"] * len(cols))
    conn.execute(
        f"INSERT INTO jobs ({', '.join(cols)}) VALUES ({placeholders})",
        vals,
    )
    conn.commit()


def _make_enriched(url: str = "https://example.com/jobs/1") -> JobEnrichment:
    agg = JobEnrichment.empty(
        tenant_id=LOCAL_TENANT,
        job_id=JobId(url),
        updated_at="t0",
    )
    agg = agg.start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
    return agg.succeed_attempt(
        full_description=FullDescription(text="The full description"),
        application_url=ApplicationUrl(value="https://example.com/apply"),
        extraction_tier=ExtractionTier.JSON_LD,
        finished_at="t1",
    )


def test_save_then_load_round_trips(conn: sqlite3.Connection) -> None:
    _insert_job(conn, "https://example.com/jobs/1")
    repo = SqliteEnrichmentRepository(conn)
    original = _make_enriched()
    repo.save(original)

    loaded = repo.load(LOCAL_TENANT, original.job_id)
    assert loaded is not None
    assert loaded.is_enriched
    assert loaded.full_description is not None
    assert loaded.full_description.text == "The full description"
    assert loaded.application_url is not None
    assert loaded.application_url.value == "https://example.com/apply"
    assert loaded.extraction_tier is ExtractionTier.JSON_LD
    assert loaded.attempt_count == 1


def test_save_upserts_on_repeated_save(conn: sqlite3.Connection) -> None:
    _insert_job(conn, "https://example.com/jobs/1")
    repo = SqliteEnrichmentRepository(conn)
    repo.save(_make_enriched())

    # Reset + new attempt cycle ⇒ failed
    from jobctrl.domain.enrichment import EnrichmentError

    failed = (
        _make_enriched()
        .reset(reset_at="t2")
        .start_attempt(extraction_tier=ExtractionTier.CSS_SELECTORS, started_at="t3")
        .fail_attempt(
            error=EnrichmentError(code="HTTP_404", message="gone", retryable=False),
            finished_at="t4",
        )
    )
    repo.save(failed)

    loaded = repo.load(LOCAL_TENANT, failed.job_id)
    assert loaded is not None
    assert loaded.is_failed
    assert loaded.attempt_count == 2  # the prior succeeded + the new failed


def test_load_returns_none_for_unknown_job(conn: sqlite3.Connection) -> None:
    repo = SqliteEnrichmentRepository(conn)
    assert repo.load(LOCAL_TENANT, JobId("https://nope/")) is None


def test_list_pending_includes_jobs_with_no_enrichment(conn: sqlite3.Connection) -> None:
    _insert_job(conn, "https://example.com/jobs/A")
    _insert_job(conn, "https://example.com/jobs/B")
    repo = SqliteEnrichmentRepository(conn)
    # Save an enrichment for A only
    repo.save(_make_enriched("https://example.com/jobs/A"))
    pending = repo.list_pending(LOCAL_TENANT)
    assert pending == [JobId("https://example.com/jobs/B")]


def test_list_pending_includes_jobs_with_pending_status(conn: sqlite3.Connection) -> None:
    _insert_job(conn, "https://example.com/jobs/A")
    repo = SqliteEnrichmentRepository(conn)
    pending_agg = JobEnrichment.empty(
        tenant_id=LOCAL_TENANT,
        job_id=JobId("https://example.com/jobs/A"),
        updated_at="t0",
    )
    repo.save(pending_agg)
    pending = repo.list_pending(LOCAL_TENANT)
    assert pending == [JobId("https://example.com/jobs/A")]


def test_list_pending_excludes_running_and_failed(conn: sqlite3.Connection) -> None:
    """Running attempts are in flight; failed aggregates wait for explicit retry."""
    _insert_job(conn, "https://example.com/jobs/R")
    _insert_job(conn, "https://example.com/jobs/F")
    repo = SqliteEnrichmentRepository(conn)
    running = JobEnrichment.empty(
        tenant_id=LOCAL_TENANT, job_id=JobId("https://example.com/jobs/R"), updated_at="t0"
    ).start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
    repo.save(running)

    from jobctrl.domain.enrichment import EnrichmentError

    failed = (
        JobEnrichment.empty(
            tenant_id=LOCAL_TENANT, job_id=JobId("https://example.com/jobs/F"), updated_at="t0"
        )
        .start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
        .fail_attempt(
            error=EnrichmentError(code="x", message="x", retryable=True),
            finished_at="t1",
        )
    )
    repo.save(failed)

    assert repo.list_pending(LOCAL_TENANT) == []


def test_list_failed_returns_full_aggregates(conn: sqlite3.Connection) -> None:
    _insert_job(conn, "https://example.com/jobs/F")
    repo = SqliteEnrichmentRepository(conn)
    from jobctrl.domain.enrichment import EnrichmentError

    failed = (
        JobEnrichment.empty(
            tenant_id=LOCAL_TENANT, job_id=JobId("https://example.com/jobs/F"), updated_at="t0"
        )
        .start_attempt(extraction_tier=ExtractionTier.LLM_ASSISTED, started_at="t0")
        .fail_attempt(
            error=EnrichmentError(code="LLM_500", message="bad", retryable=True),
            finished_at="t1",
        )
    )
    repo.save(failed)

    failures = repo.list_failed(LOCAL_TENANT)
    assert len(failures) == 1
    assert failures[0].is_failed
    assert failures[0].last_attempt is not None
    assert failures[0].last_attempt.error is not None
    assert failures[0].last_attempt.error.code == "LLM_500"


# ---------------------------------------------------------------------------
# Backfill — verifies ensure_enrichment_tables's idempotent migration
# ---------------------------------------------------------------------------


def test_backfill_idempotent_when_table_already_populated(tmp_path) -> None:
    """Re-running the migration on an existing DB must not duplicate rows."""
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    _insert_job(conn, "https://example.com/jobs/1", full_description="Legacy desc")
    repo = SqliteEnrichmentRepository(conn)
    repo.save(_make_enriched("https://example.com/jobs/1"))

    # The table now has at least one row, so subsequent calls are no-ops.
    rows_before = conn.execute("SELECT COUNT(*) FROM job_enrichments").fetchone()[0]
    from jobctrl.database import ensure_enrichment_tables

    # Insert a NEW legacy row that WOULD be backfilled if the migration
    # fired — and confirm it doesn't, because the table is already
    # populated.
    _insert_job(
        conn,
        "https://example.com/jobs/2",
        full_description="Another legacy desc",
    )
    ensure_enrichment_tables(conn)
    rows_after = conn.execute("SELECT COUNT(*) FROM job_enrichments").fetchone()[0]
    assert rows_before == rows_after


def test_backfill_creates_enriched_rows_from_legacy_columns(tmp_path) -> None:
    """A legacy job with full_description should backfill as ``enriched``."""
    db_path = tmp_path / "jobctrl.db"
    # Insert legacy data BEFORE init_db runs the backfill
    conn = sqlite3.connect(str(db_path))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            title TEXT,
            site TEXT,
            discovered_at TEXT,
            full_description TEXT,
            application_url TEXT,
            detail_scraped_at TEXT,
            detail_error TEXT
        )
        """
    )
    conn.execute(
        "INSERT INTO jobs (url, title, site, discovered_at, full_description, "
        "application_url, detail_scraped_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            "https://example.com/jobs/1",
            "Senior Engineer",
            "greenhouse",
            "2026-04-01T00:00:00+00:00",
            "The legacy full description",
            "https://example.com/apply",
            "2026-04-02T00:00:00+00:00",
        ),
    )
    conn.commit()
    conn.close()

    # Now run init_db — it should backfill the existing legacy row
    conn = init_db(db_path)
    repo = SqliteEnrichmentRepository(conn)
    loaded = repo.load(LOCAL_TENANT, JobId("https://example.com/jobs/1"))
    assert loaded is not None
    assert loaded.is_enriched
    assert loaded.full_description is not None
    assert loaded.full_description.text == "The legacy full description"
    assert loaded.application_url is not None
    assert loaded.application_url.value == "https://example.com/apply"
    # Backfilled attempt is recorded as a succeeded css_selectors attempt
    assert loaded.attempt_count == 1
    assert loaded.last_attempt is not None
    assert loaded.last_attempt.succeeded
    # The attempts_json carries the "backfilled": true flag
    raw = conn.execute(
        "SELECT attempts_json FROM job_enrichments WHERE job_url = ?",
        ("https://example.com/jobs/1",),
    ).fetchone()
    payload = json.loads(raw[0])
    assert payload[0]["backfilled"] is True


def test_backfill_creates_failed_row_for_legacy_error(tmp_path) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            title TEXT,
            site TEXT,
            discovered_at TEXT,
            full_description TEXT,
            application_url TEXT,
            detail_scraped_at TEXT,
            detail_error TEXT
        )
        """
    )
    conn.execute(
        "INSERT INTO jobs (url, title, site, discovered_at, detail_error) "
        "VALUES (?, ?, ?, ?, ?)",
        (
            "https://example.com/jobs/2",
            "Foo",
            "greenhouse",
            "2026-04-01T00:00:00+00:00",
            "HTTP 404",
        ),
    )
    conn.commit()
    conn.close()

    conn = init_db(db_path)
    repo = SqliteEnrichmentRepository(conn)
    loaded = repo.load(LOCAL_TENANT, JobId("https://example.com/jobs/2"))
    assert loaded is not None
    assert loaded.is_failed
    assert loaded.last_attempt is not None
    assert loaded.last_attempt.failed
    assert loaded.last_attempt.error is not None
    assert "HTTP 404" in loaded.last_attempt.error.message


def test_backfill_does_not_fire_when_table_has_rows(tmp_path) -> None:
    """Idempotent backfill: subsequent runs against new legacy data are no-ops."""
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    _insert_job(conn, "https://example.com/jobs/A")
    repo = SqliteEnrichmentRepository(conn)
    repo.save(_make_enriched("https://example.com/jobs/A"))

    # Now insert a NEW legacy-only row and re-run ensure_enrichment_tables
    _insert_job(
        conn,
        "https://example.com/jobs/B",
        full_description="Legacy desc",
        detail_scraped_at="2026-04-01T00:00:00+00:00",
    )
    from jobctrl.database import ensure_enrichment_tables

    ensure_enrichment_tables(conn)

    # B was NOT backfilled because the table already had A
    assert repo.load(LOCAL_TENANT, JobId("https://example.com/jobs/B")) is None
