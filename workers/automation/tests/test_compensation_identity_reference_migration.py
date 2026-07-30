"""Schema-v19 compensation JobId reference contracts."""

from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    close_connection,
    ensure_compensation_references_v19,
    ensure_market_compensation_tables,
    ensure_posted_compensation_tables,
    init_db,
    reassign_discovery_identity_references,
)
from jobctrl.domain.discovery import (
    Employer,
    Job,
    JobMetadata,
    PostingUrl,
    SearchStrategy,
    Source,
)
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.compensation import (
    SqliteMarketCompensationRepository,
    SqlitePostedCompensationRepository,
)
from jobctrl.infrastructure.discovery import SqliteJobRepository


PREVIOUS_SCHEMA_VERSION = 18


def _discovered_job(posting_url: str, job_id: JobId) -> Job:
    return Job.discover(
        tenant_id=LOCAL_TENANT,
        job_id=job_id,
        posting_url=PostingUrl(value=posting_url),
        source=Source(board="example"),
        employer=Employer(name="Example"),
        search_strategy=SearchStrategy.JOBSPY,
        metadata=JobMetadata(title="Platform Engineer"),
        discovered_at="2026-07-29T10:00:00+00:00",
    )


def _downgrade_compensation_references_to_v18(
    conn: sqlite3.Connection,
) -> None:
    conn.execute("DROP TABLE job_market_compensation_estimates")
    conn.execute("DROP TABLE job_posted_compensation_facts")
    conn.execute(f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}")
    conn.commit()
    ensure_posted_compensation_tables(conn)
    ensure_market_compensation_tables(conn)


def _insert_posted(
    conn: sqlite3.Connection,
    *,
    reference_column: str,
    reference: str,
    marker: str,
    parsed_at: str,
    tenant_id: str = "local",
) -> None:
    conn.execute(
        f"""
        INSERT INTO job_posted_compensation_facts (
            tenant_id, {reference_column}, parse_state, currency, period,
            component, minimum_amount, maximum_amount, confidence,
            parser_version, source_hash, parsed_at
        ) VALUES (
            ?, ?, 'parsed_range', 'EUR', 'year', 'base_salary',
            ?, ?, 'high', ?, ?, ?
        )
        """,
        (
            tenant_id,
            reference,
            80_000 + len(marker),
            90_000 + len(marker),
            f"parser:{marker}",
            f"hash:{marker}",
            parsed_at,
        ),
    )


def _insert_market(
    conn: sqlite3.Connection,
    *,
    reference_column: str,
    reference: str,
    marker: str,
    estimated_at: str,
    tenant_id: str = "local",
) -> None:
    conn.execute(
        f"""
        INSERT INTO job_market_compensation_estimates (
            tenant_id, {reference_column}, estimate_state, currency,
            period, component, minimum_amount, maximum_amount,
            confidence_band, confidence_score, source_count,
            estimator_version, estimated_at
        ) VALUES (
            ?, ?, 'estimated_range', 'EUR', 'year',
            'total_compensation', ?, ?, 'medium', 0.75, 2, ?, ?
        )
        """,
        (
            tenant_id,
            reference,
            110_000 + len(marker),
            140_000 + len(marker),
            f"company-role-reported-compensation-{marker}",
            estimated_at,
        ),
    )


def _columns(
    conn: sqlite3.Connection,
    table_name: str,
) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table_name}")'
        ).fetchall()
    }


def test_v18_compensation_migrates_alias_winners_and_uuid_urls(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    stable_job_id = JobId(str(uuid.uuid4()))
    storage_url = "https://boards.example/jobs/compensation"
    alias_url = "https://careers.example/jobs/compensation"
    jobs.save(_discovered_job(storage_url, stable_job_id))
    jobs.save(_discovered_job(alias_url, stable_job_id))

    uuid_shaped_url = str(uuid.uuid4())
    uuid_url_owner = JobId(str(uuid.uuid4()))
    jobs.save(_discovered_job(uuid_shaped_url, uuid_url_owner))
    jobs.save(
        _discovered_job(
            "https://example.com/jobs/id-text-owner",
            JobId(uuid_shaped_url),
        )
    )
    _downgrade_compensation_references_to_v18(conn)
    _insert_posted(
        conn,
        reference_column="job_url",
        reference=storage_url,
        marker="storage-old",
        parsed_at="2026-07-29T10:00:00+00:00",
    )
    _insert_posted(
        conn,
        reference_column="job_url",
        reference=alias_url,
        marker="alias-new",
        parsed_at="2026-07-29T10:01:00+00:00",
    )
    _insert_posted(
        conn,
        reference_column="job_url",
        reference=uuid_shaped_url,
        marker="uuid-url",
        parsed_at="2026-07-29T10:02:00+00:00",
    )
    _insert_market(
        conn,
        reference_column="job_url",
        reference=storage_url,
        marker="storage-new",
        estimated_at="2026-07-29T10:03:00+00:00",
    )
    _insert_market(
        conn,
        reference_column="job_url",
        reference=alias_url,
        marker="alias-old",
        estimated_at="2026-07-29T10:02:00+00:00",
    )
    _insert_market(
        conn,
        reference_column="job_url",
        reference=uuid_shaped_url,
        marker="uuid-url",
        estimated_at="2026-07-29T10:04:00+00:00",
    )
    conn.commit()
    close_connection(db_path)

    reopened = init_db(db_path)
    assert (
        reopened.execute("PRAGMA user_version").fetchone()[0]
        == SCHEMA_VERSION
        == 29
    )
    for table in database_module._COMPENSATION_REFERENCE_TABLES:
        assert "job_id" in _columns(reopened, table)
        assert "job_url" not in _columns(reopened, table)
        assert reopened.execute(
            f'SELECT COUNT(*) FROM "{table}"'
        ).fetchone()[0] == 2
    posted = reopened.execute(
        """
        SELECT job_id, parser_version
        FROM job_posted_compensation_facts
        ORDER BY parser_version
        """
    ).fetchall()
    assert [tuple(row) for row in posted] == [
        (str(stable_job_id), "parser:alias-new"),
        (str(uuid_url_owner), "parser:uuid-url"),
    ]
    market = reopened.execute(
        """
        SELECT job_id, estimator_version
        FROM job_market_compensation_estimates
        ORDER BY estimator_version
        """
    ).fetchall()
    assert [tuple(row) for row in market] == [
        (
            str(stable_job_id),
            "company-role-reported-compensation-storage-new",
        ),
        (
            str(uuid_url_owner),
            "company-role-reported-compensation-uuid-url",
        ),
    ]
    posted_repo = SqlitePostedCompensationRepository(reopened)
    alias_fact = posted_repo.get_fact("local", alias_url)
    assert alias_fact is not None
    assert alias_fact.job_url == alias_url
    assert alias_fact.parser_version == "parser:alias-new"
    uuid_fact = posted_repo.get_fact("local", uuid_shaped_url)
    assert uuid_fact is not None
    assert uuid_fact.parser_version == "parser:uuid-url"
    market_repo = SqliteMarketCompensationRepository(reopened)
    storage_estimate = market_repo.get_estimate("local", storage_url)
    assert storage_estimate is not None
    assert (
        storage_estimate.estimator_version
        == "company-role-reported-compensation-storage-new"
    )
    assert reopened.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)

    reopened_again = init_db(db_path)
    assert reopened_again.execute(
        "SELECT COUNT(*) FROM job_posted_compensation_facts"
    ).fetchone()[0] == 2
    close_connection(db_path)


def test_v19_compensation_migration_rolls_back_and_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    job_id = JobId(str(uuid.uuid4()))
    job_url = "https://example.com/jobs/compensation-retry"
    SqliteJobRepository(conn).save(_discovered_job(job_url, job_id))
    _downgrade_compensation_references_to_v18(conn)
    _insert_posted(
        conn,
        reference_column="job_url",
        reference=job_url,
        marker="retry",
        parsed_at="2026-07-29T10:00:00+00:00",
    )
    _insert_market(
        conn,
        reference_column="job_url",
        reference=job_url,
        marker="retry",
        estimated_at="2026-07-29T10:00:00+00:00",
    )
    conn.commit()
    original_verify = (
        database_module._verify_compensation_references_v19
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_counts: dict[str, int],
    ) -> None:
        del expected_counts
        raise RuntimeError("injected compensation verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_compensation_references_v19",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected compensation verification failure",
    ):
        ensure_compensation_references_v19(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 18
    assert "job_url" in _columns(
        conn,
        "job_posted_compensation_facts",
    )
    assert conn.execute(
        "SELECT parser_version FROM job_posted_compensation_facts"
    ).fetchone()[0] == "parser:retry"

    monkeypatch.setattr(
        database_module,
        "_verify_compensation_references_v19",
        original_verify,
    )
    assert ensure_compensation_references_v19(conn) == list(
        database_module._COMPENSATION_REFERENCE_TABLES
    )
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 19
    assert "job_id" in _columns(
        conn,
        "job_posted_compensation_facts",
    )
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_runtime_compensation_merge_preserves_newest_and_tenant(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    losing_id = JobId(str(uuid.uuid4()))
    surviving_id = JobId(str(uuid.uuid4()))
    other_tenant_job_id = JobId(str(uuid.uuid4()))
    losing_url = "https://example.com/jobs/compensation-losing"
    surviving_url = "https://example.com/jobs/compensation-surviving"
    other_tenant_url = "https://tenant-b.example/jobs/compensation"
    jobs.save(_discovered_job(losing_url, losing_id))
    jobs.save(_discovered_job(surviving_url, surviving_id))
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, discovered_at
        ) VALUES (?, 'tenant-b', ?, 'Platform Engineer', 'Example', ?)
        """,
        (
            other_tenant_url,
            str(other_tenant_job_id),
            "2026-07-29T10:00:00+00:00",
        ),
    )
    _insert_posted(
        conn,
        reference_column="job_id",
        reference=str(surviving_id),
        marker="surviving-old",
        parsed_at="2026-07-29T10:00:00+00:00",
    )
    _insert_posted(
        conn,
        reference_column="job_id",
        reference=str(losing_id),
        marker="losing-new",
        parsed_at="2026-07-29T10:01:00+00:00",
    )
    _insert_market(
        conn,
        reference_column="job_id",
        reference=str(surviving_id),
        marker="surviving-new",
        estimated_at="2026-07-29T10:02:00+00:00",
    )
    _insert_market(
        conn,
        reference_column="job_id",
        reference=str(losing_id),
        marker="losing-old",
        estimated_at="2026-07-29T10:01:00+00:00",
    )
    _insert_posted(
        conn,
        reference_column="job_id",
        reference=str(other_tenant_job_id),
        marker="other-tenant",
        parsed_at="2026-07-29T10:03:00+00:00",
        tenant_id="tenant-b",
    )
    _insert_market(
        conn,
        reference_column="job_id",
        reference=str(other_tenant_job_id),
        marker="other-tenant",
        estimated_at="2026-07-29T10:03:00+00:00",
        tenant_id="tenant-b",
    )
    conn.commit()

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=surviving_url,
    )
    conn.execute(
        "DELETE FROM jobs WHERE tenant_id = 'local' AND url = ?",
        (losing_url,),
    )

    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, job_id, parser_version
            FROM job_posted_compensation_facts
            ORDER BY tenant_id
            """
        ).fetchall()
    ] == [
        ("local", str(surviving_id), "parser:losing-new"),
        (
            "tenant-b",
            str(other_tenant_job_id),
            "parser:other-tenant",
        ),
    ]
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, job_id, estimator_version
            FROM job_market_compensation_estimates
            ORDER BY tenant_id
            """
        ).fetchall()
    ] == [
        (
            "local",
            str(surviving_id),
            "company-role-reported-compensation-surviving-new",
        ),
        (
            "tenant-b",
            str(other_tenant_job_id),
            "company-role-reported-compensation-other-tenant",
        ),
    ]
    posted = SqlitePostedCompensationRepository(conn).get_fact(
        "local",
        surviving_url,
    )
    assert posted is not None
    assert posted.parser_version == "parser:losing-new"
    market = SqliteMarketCompensationRepository(conn).get_estimate(
        "local",
        surviving_url,
    )
    assert market is not None
    assert (
        market.estimator_version
        == "company-role-reported-compensation-surviving-new"
    )
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)


def test_alias_and_job_id_writes_record_events_for_storage_url(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    jobs = SqliteJobRepository(conn)
    stable_job_id = JobId(str(uuid.uuid4()))
    storage_url = "https://storage.example/jobs/compensation"
    alias_url = "https://alias.example/jobs/compensation"
    jobs.save(_discovered_job(storage_url, stable_job_id))
    jobs.save(_discovered_job(alias_url, stable_job_id))
    conn.execute("PRAGMA foreign_keys = ON")

    SqlitePostedCompensationRepository(
        conn
    ).parse_and_save_job_salary(
        alias_url,
        "EUR 100000-120000/year",
        parsed_at="2026-07-29T10:00:00+00:00",
    )
    SqliteMarketCompensationRepository(
        conn
    ).estimate_and_save_job(
        job_url=str(stable_job_id),
        title="Platform Engineer",
        company="Example",
        location="Europe",
        observations=(),
        estimated_at="2026-07-29T10:01:00+00:00",
    )

    events = conn.execute(
        """
        SELECT job_url, payload_json
        FROM job_events
        WHERE event_type = 'CompensationFactsUpdated'
        ORDER BY event_id
        """
    ).fetchall()
    assert len(events) == 2
    assert {str(row["job_url"]) for row in events} == {storage_url}
    assert {
        str(json.loads(row["payload_json"])["jobId"])
        for row in events
    } == {storage_url}
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    close_connection(db_path)
