from __future__ import annotations

import json
import sqlite3
import uuid
from pathlib import Path

import pytest
import jobctrl.state as state_module

from jobctrl.database import init_db
from jobctrl.domain.compensation import parse_posted_compensation
from jobctrl.domain.identifiers import JobId
from jobctrl.infrastructure.compensation import (
    SqlitePostedCompensationRepository,
    posted_compensation_source_from_job,
)


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


def _seed_job(
    conn: sqlite3.Connection,
    *,
    url: str = "https://example.com/jobs/1",
    salary: str | None = "€80,000-€95,000/year",
) -> tuple[str, JobId]:
    job_id = JobId(str(uuid.uuid5(uuid.NAMESPACE_URL, f"local:{url}")))
    conn.execute(
        "INSERT INTO jobs (tenant_id, job_id, url, title, site, salary, description, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("local", job_id, url, "Platform Engineer", "Example", salary, "Synthetic job", "2026-06-19T10:00:00Z"),
    )
    conn.commit()
    return url, job_id


def test_schema_is_created_by_init_db(conn: sqlite3.Connection) -> None:
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_posted_compensation_facts'"
    ).fetchone()

    assert row is not None


def test_constructor_does_not_probe_or_mutate_healthy_schema(conn: sqlite3.Connection) -> None:
    statements: list[str] = []
    conn.set_trace_callback(statements.append)

    SqlitePostedCompensationRepository(conn)

    assert statements == []


@pytest.mark.parametrize(
    ("schema_sql", "error"),
    (
        (None, "no such table: job_posted_compensation_facts"),
        (
            "CREATE TABLE job_posted_compensation_facts (tenant_id TEXT, job_id TEXT)",
            "no such column: source_field",
        ),
    ),
)
def test_missing_or_malformed_schema_fails_closed_on_first_operation(
    schema_sql: str | None,
    error: str,
) -> None:
    malformed_conn = sqlite3.connect(":memory:")
    if schema_sql is not None:
        malformed_conn.execute(schema_sql)

    repo = SqlitePostedCompensationRepository(malformed_conn)

    with pytest.raises(sqlite3.OperationalError, match=error):
        repo.get_fact("local", JobId("00000000-0000-0000-0000-000000000001"))


def test_upsert_and_read_round_trip(conn: sqlite3.Connection) -> None:
    _job_url, job_id = _seed_job(conn)
    repo = SqlitePostedCompensationRepository(conn)
    fact = parse_posted_compensation(
        "€80,000-€95,000/year",
        job_id=job_id,
        parsed_at="2026-06-19T10:00:00Z",
    )

    repo.save_fact(fact)
    loaded = repo.get_fact("local", job_id)

    assert loaded is not None
    assert loaded.parse_state == "parsed_range"
    assert loaded.source_text == "€80,000-€95,000/year"
    assert loaded.legacy_raw_salary == "€80,000-€95,000/year"
    assert loaded.currency == "EUR"
    assert loaded.minimum_amount == 80_000
    assert loaded.maximum_amount == 95_000
    assert loaded.annualized_minimum_amount == 80_000
    assert loaded.confidence == "high"
    assert loaded.warnings == ()

    event = conn.execute(
        """
        SELECT payload_json FROM job_events
        WHERE tenant_id = ? AND job_id = ? AND event_type = 'CompensationFactsUpdated'
        ORDER BY event_id DESC LIMIT 1
        """,
        ("local", job_id),
    ).fetchone()
    payload = json.loads(event["payload_json"])
    assert payload == {
        "jobId": str(job_id),
        "changedSections": ["posted"],
        "postedRecordStatus": "recorded",
        "postedParseState": "parsed_range",
        "marketRecordStatus": None,
        "marketEstimateState": None,
        "updatedAt": "2026-06-19T10:00:00Z",
        "stage": "enrich",
        "level": "info",
        "message": "Posted compensation fact updated",
    }
    assert "sourceText" not in payload
    assert "€80,000" not in json.dumps(payload)


def test_backfill_is_idempotent_and_preserves_legacy_salary(conn: sqlite3.Connection) -> None:
    job_url, job_id = _seed_job(conn, salary="$180,000/year")
    repo = SqlitePostedCompensationRepository(conn)

    assert repo.backfill_from_jobs(parsed_at="2026-06-19T10:00:00Z") == 1
    assert repo.backfill_from_jobs(parsed_at="2026-06-19T10:00:00Z") == 1

    rows = conn.execute(
        "SELECT * FROM job_posted_compensation_facts WHERE tenant_id = ? AND job_id = ?", ("local", job_id)
    ).fetchall()
    salary = conn.execute("SELECT salary FROM jobs WHERE tenant_id = ? AND job_id = ?", ("local", job_id)).fetchone()[
        "salary"
    ]
    fact = repo.get_fact("local", job_id)

    assert len(rows) == 1
    assert salary == "$180,000/year"
    assert fact is not None
    assert fact.legacy_raw_salary == "$180,000/year"
    assert fact.minimum_amount == 180_000


def _mark_fact_as_legacy(
    conn: sqlite3.Connection,
    job_id: JobId,
    *,
    parser_version: str = "posted-compensation-v1",
    component: str = "equity",
) -> None:
    conn.execute(
        """
        UPDATE job_posted_compensation_facts
        SET parser_version = ?,
            component = ?,
            confidence = 'medium'
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (parser_version, component, job_id),
    )
    conn.execute(
        "DELETE FROM job_events WHERE tenant_id = 'local' AND job_id = ?",
        (job_id,),
    )
    conn.commit()


def test_reparse_outdated_facts_is_bounded_idempotent_and_preserves_future_rows(
    conn: sqlite3.Connection,
) -> None:
    _job_url, first_id = _seed_job(
        conn,
        url="https://example.com/jobs/reparse-first",
        salary="Compensation: USD 243,800 annually and stock options.",
    )
    _job_url, second_id = _seed_job(
        conn,
        url="https://example.com/jobs/reparse-second",
        salary="EUR 100,000 yrs",
    )
    _job_url, future_id = _seed_job(
        conn,
        url="https://example.com/jobs/reparse-future",
        salary="EUR 120,000/year",
    )
    repo = SqlitePostedCompensationRepository(conn)
    for job_id, salary in (
        (first_id, "Compensation: USD 243,800 annually and stock options."),
        (second_id, "EUR 100,000 yrs"),
        (future_id, "EUR 120,000/year"),
    ):
        repo.parse_and_save_job_salary(job_id, salary)
    _mark_fact_as_legacy(conn, first_id)
    _mark_fact_as_legacy(
        conn,
        second_id,
        parser_version="posted-compensation-v2",
        component="unknown",
    )
    conn.execute(
        "UPDATE job_posted_compensation_facts SET parser_version = ? WHERE job_id = ?",
        ("posted-compensation-v5", future_id),
    )
    conn.commit()

    assert (
        repo.reparse_outdated_facts(
            parsed_at="2026-08-12T12:00:00Z",
            batch_size=1,
        )
        == 2
    )
    assert (
        repo.reparse_outdated_facts(
            parsed_at="2026-08-12T12:01:00Z",
            batch_size=1,
        )
        == 0
    )

    first = repo.get_fact("local", first_id)
    assert first is not None
    assert first.parser_version == "posted-compensation-v4"
    assert first.component == "unknown"
    assert first.confidence == "high"
    second = repo.get_fact("local", second_id)
    assert second is not None
    assert second.parser_version == "posted-compensation-v4"
    assert second.period == "year"
    assert second.annualized_minimum_amount == 100_000
    assert repo.get_fact("local", future_id).parser_version == "posted-compensation-v5"  # type: ignore[union-attr]
    events = conn.execute(
        """
        SELECT job_id, idempotency_key
        FROM job_events
        WHERE event_type = 'CompensationFactsUpdated'
          AND idempotency_key LIKE 'posted-parser-upgrade:%'
        ORDER BY job_id
        """
    ).fetchall()
    assert len(events) == 2
    assert {":".join(str(row["idempotency_key"]).rsplit(":", 2)[-2:]) for row in events} == {"v1:v4", "v2:v4"}


@pytest.mark.parametrize(
    "failure",
    (sqlite3.OperationalError("event table unavailable"), KeyboardInterrupt()),
)
def test_reparse_outdated_facts_rolls_back_fact_when_event_write_fails(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
    failure: BaseException,
) -> None:
    _job_url, job_id = _seed_job(
        conn,
        url=f"https://example.com/jobs/reparse-failure-{type(failure).__name__}",
        salary="Compensation: USD 243,800 annually and stock options.",
    )
    repo = SqlitePostedCompensationRepository(conn)
    repo.parse_and_save_job_salary(job_id, "Compensation: USD 243,800 annually and stock options.")
    _mark_fact_as_legacy(conn, job_id)
    original = state_module.record_job_event

    def fail_event(*_args: object, **_kwargs: object) -> None:
        raise failure

    monkeypatch.setattr(state_module, "record_job_event", fail_event)
    with pytest.raises(type(failure)):
        repo.reparse_outdated_facts(parsed_at="2026-08-12T12:00:00Z")

    failed = repo.get_fact("local", job_id)
    assert failed is not None
    assert failed.parser_version == "posted-compensation-v1"
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE tenant_id = 'local' AND job_id = ?",
            (job_id,),
        ).fetchone()[0]
        == 0
    )

    monkeypatch.setattr(state_module, "record_job_event", original)
    assert repo.reparse_outdated_facts(parsed_at="2026-08-12T12:01:00Z") == 1
    assert repo.get_fact("local", job_id).parser_version == "posted-compensation-v4"  # type: ignore[union-attr]
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE tenant_id = 'local' AND job_id = ?",
            (job_id,),
        ).fetchone()[0]
        == 1
    )


def test_reparse_corrects_v2_hourly_false_positive_from_following_hr_prose(
    conn: sqlite3.Connection,
) -> None:
    source = "Compensation budget approved: $100,000\n\nHR managers will administer this program."
    _job_url, job_id = _seed_job(
        conn,
        url="https://example.com/jobs/reparse-following-hr-prose",
        salary=source,
    )
    repo = SqlitePostedCompensationRepository(conn)
    repo.parse_and_save_job_salary(job_id, source)
    conn.execute(
        """
        UPDATE job_posted_compensation_facts
        SET parser_version = 'posted-compensation-v2',
            period = 'hour',
            annualized_minimum_amount = 208000000,
            annualized_maximum_amount = 208000000,
            annualization_assumption = 'Hourly amounts annualized by multiplying by 2,080 work hours.',
            confidence = 'low',
            warnings_json = '["hourly_period"]'
        WHERE tenant_id = 'local' AND job_id = ?
        """,
        (job_id,),
    )
    conn.execute("DELETE FROM job_events WHERE tenant_id = 'local' AND job_id = ?", (job_id,))
    conn.commit()

    assert repo.reparse_outdated_facts(parsed_at="2026-08-12T12:00:00Z") == 1

    fact = repo.get_fact("local", job_id)
    assert fact is not None
    assert fact.parser_version == "posted-compensation-v4"
    assert fact.period == "unknown"
    assert fact.annualized_minimum_amount is None
    assert fact.annualized_maximum_amount is None
    assert "missing_period" in fact.warnings
    assert "hourly_period" not in fact.warnings
    event_key = conn.execute(
        "SELECT idempotency_key FROM job_events WHERE tenant_id = 'local' AND job_id = ?",
        (job_id,),
    ).fetchone()["idempotency_key"]
    assert str(event_key).endswith(":v2:v4")


def test_reparse_uses_accepted_enrichment_description_and_supports_tuple_rows(
    conn: sqlite3.Connection,
) -> None:
    _job_url, job_id = _seed_job(
        conn,
        url="https://example.com/jobs/enriched-reparse",
        salary=None,
    )
    conn.execute(
        "UPDATE jobs SET full_description = ? WHERE job_id = ?",
        ("Base salary EUR 70,000/year", job_id),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description, updated_at
        ) VALUES ('local', ?, 'enriched', ?, '2026-08-12T11:00:00Z')
        """,
        (job_id, "Compensation: USD 243,800 annually and stock options."),
    )
    repo = SqlitePostedCompensationRepository(conn)
    repo.parse_and_save_job_salary(job_id, "Base salary EUR 70,000/year")
    _mark_fact_as_legacy(conn, job_id)
    conn.row_factory = None

    assert repo.reparse_outdated_facts(parsed_at="2026-08-12T12:00:00Z") == 1

    conn.row_factory = sqlite3.Row
    fact = repo.get_fact("local", job_id)
    assert fact is not None
    assert fact.source_field == "job_enrichments.full_description"
    assert fact.currency == "USD"
    assert fact.minimum_amount == 243_800
    assert fact.component == "unknown"


def test_backfill_records_missing_fact_without_erasing_blank_salary(conn: sqlite3.Connection) -> None:
    _job_url, job_id = _seed_job(conn, salary=None)
    repo = SqlitePostedCompensationRepository(conn)

    repo.backfill_from_jobs(parsed_at="2026-06-19T10:00:00Z")
    fact = repo.get_fact("local", job_id)
    salary = conn.execute("SELECT salary FROM jobs WHERE tenant_id = ? AND job_id = ?", ("local", job_id)).fetchone()[
        "salary"
    ]

    assert fact is not None
    assert fact.parse_state == "missing"
    assert fact.legacy_raw_salary is None
    assert salary is None


def test_backfill_prefers_numeric_compensation_excerpt_over_earlier_generic_cue(
    conn: sqlite3.Connection,
) -> None:
    _job_url, job_id = _seed_job(conn, salary=None)
    full_description = (
        "Competitive compensation and benefits. "
        "In addition to base salary, the annual learning stipend is €2,000 per year. "
        + ("Lead platform engineering and delivery teams. " * 16)
        + "Base pay range per year:\n**€80,000 - €95,000**"
    )
    conn.execute(
        "UPDATE jobs SET full_description = ? WHERE tenant_id = ? AND job_id = ?",
        (full_description, "local", job_id),
    )
    conn.commit()

    SqlitePostedCompensationRepository(conn).backfill_from_jobs(parsed_at="2026-06-19T10:00:00Z")

    fact = SqlitePostedCompensationRepository(conn).get_fact("local", job_id)
    assert fact is not None
    assert fact.source_field == "jobs.full_description"
    assert fact.parse_state == "parsed_range"
    assert fact.currency == "EUR"
    assert fact.period == "year"
    assert fact.annualized_minimum_amount == 80_000
    assert fact.annualized_maximum_amount == 95_000


def test_backfill_selects_cash_compensation_with_additive_stock_after_distant_generic_cue(
    conn: sqlite3.Connection,
) -> None:
    _job_url, job_id = _seed_job(conn, salary=None)
    full_description = (
        "Our compensation philosophy rewards impact across the company. "
        + ("Lead privacy engineering strategy across global product teams. " * 8)
        + "Compensation: USD 243,800 annually and stock options."
    )
    conn.execute(
        "UPDATE jobs SET full_description = ? WHERE tenant_id = ? AND job_id = ?",
        (full_description, "local", job_id),
    )
    conn.commit()

    SqlitePostedCompensationRepository(conn).backfill_from_jobs(parsed_at="2026-08-12T10:00:00Z")

    fact = SqlitePostedCompensationRepository(conn).get_fact("local", job_id)
    assert fact is not None
    assert fact.source_field == "jobs.full_description"
    assert fact.parse_state == "parsed_range"
    assert fact.currency == "USD"
    assert fact.period == "year"
    assert fact.component == "unknown"
    assert fact.annualized_minimum_amount == 243_800
    assert fact.annualized_maximum_amount == 243_800
    assert fact.confidence == "high"
    assert "equity_component" in fact.warnings


def test_backfill_selects_explicit_equity_amount_over_earlier_salary_sentence(
    conn: sqlite3.Connection,
) -> None:
    _job_url, job_id = _seed_job(conn, salary=None)
    full_description = (
        "The position offers a competitive base salary. "
        + ("Lead privacy engineering strategy across global product teams. " * 8)
        + "Equity compensation: USD 100,000/year in stock options."
    )
    conn.execute(
        "UPDATE jobs SET full_description = ? WHERE tenant_id = ? AND job_id = ?",
        (full_description, "local", job_id),
    )
    conn.commit()

    SqlitePostedCompensationRepository(conn).backfill_from_jobs(parsed_at="2026-08-12T10:00:00Z")

    fact = SqlitePostedCompensationRepository(conn).get_fact("local", job_id)
    assert fact is not None
    assert fact.source_field == "jobs.full_description"
    assert fact.parse_state == "parsed_range"
    assert fact.currency == "USD"
    assert fact.period == "year"
    assert fact.component == "equity"
    assert fact.annualized_minimum_amount == 100_000
    assert fact.annualized_maximum_amount == 100_000


def test_description_source_selection_supports_tuple_job_rows() -> None:
    full_description = "Base salary €80,000 - €95,000 per year"

    source_text, source_field = posted_compensation_source_from_job(("job-id", None, full_description, ""))

    assert source_field == "jobs.full_description"
    assert source_text == full_description


def test_backfill_does_not_annualize_hr_prose_after_an_amount(conn: sqlite3.Connection) -> None:
    _job_url, job_id = _seed_job(conn, salary=None)
    full_description = "Compensation budget approved: $100,000\n\nHR managers will administer this program."
    conn.execute(
        "UPDATE jobs SET full_description = ? WHERE tenant_id = ? AND job_id = ?",
        (full_description, "local", job_id),
    )
    conn.commit()

    SqlitePostedCompensationRepository(conn).backfill_from_jobs(parsed_at="2026-08-12T10:00:00Z")

    fact = SqlitePostedCompensationRepository(conn).get_fact("local", job_id)
    assert fact is not None
    assert fact.source_field == "jobs.full_description"
    assert fact.parse_state == "parsed_range"
    assert fact.period == "unknown"
    assert fact.annualized_minimum_amount is None
    assert fact.annualized_maximum_amount is None
    assert "missing_period" in fact.warnings
    assert "hourly_period" not in fact.warnings


@pytest.mark.parametrize(
    "hr_prose",
    (
        "HR, benefits, and finance teams will administer this program.",
        "HR: Managers will administer this program.",
    ),
)
def test_backfill_does_not_annualize_punctuated_hr_prose_after_an_amount(
    conn: sqlite3.Connection,
    hr_prose: str,
) -> None:
    url_suffix = "comma" if "," in hr_prose else "colon"
    _job_url, job_id = _seed_job(
        conn,
        url=f"https://example.com/jobs/following-hr-{url_suffix}",
        salary=None,
    )
    conn.execute(
        "UPDATE jobs SET full_description = ? WHERE tenant_id = ? AND job_id = ?",
        (f"Compensation budget approved: $100,000\n\n{hr_prose}", "local", job_id),
    )
    conn.commit()

    SqlitePostedCompensationRepository(conn).backfill_from_jobs(parsed_at="2026-08-12T10:00:00Z")

    fact = SqlitePostedCompensationRepository(conn).get_fact("local", job_id)
    assert fact is not None
    assert fact.period == "unknown"
    assert fact.annualized_minimum_amount is None
    assert "missing_period" in fact.warnings
    assert "hourly_period" not in fact.warnings


def test_backfill_persists_mixed_component_two_amount_text_as_ambiguous(
    conn: sqlite3.Connection,
) -> None:
    _job_url, job_id = _seed_job(conn, salary="Base €90k/year plus bonus €10k/year")
    repo = SqlitePostedCompensationRepository(conn)

    repo.backfill_from_jobs(parsed_at="2026-06-19T10:00:00Z")
    fact = repo.get_fact("local", job_id)
    salary = conn.execute("SELECT salary FROM jobs WHERE tenant_id = ? AND job_id = ?", ("local", job_id)).fetchone()[
        "salary"
    ]

    assert salary == "Base €90k/year plus bonus €10k/year"
    assert fact is not None
    assert fact.parse_state == "ambiguous"
    assert fact.minimum_amount is None
    assert fact.maximum_amount is None
    assert fact.annualized_minimum_amount is None
    assert "ambiguous_multiple_amounts" in fact.warnings


def test_parse_and_save_job_salary_updates_fact_after_rediscovery_preserves_raw_fallback(
    conn: sqlite3.Connection,
) -> None:
    _job_url, job_id = _seed_job(conn, salary="€80,000/year")
    repo = SqlitePostedCompensationRepository(conn)

    repo.parse_and_save_job_salary(job_id, "€80,000/year", parsed_at="2026-06-19T10:00:00Z")
    conn.execute(
        "UPDATE jobs SET salary = COALESCE(NULLIF(?, ''), salary) WHERE tenant_id = ? AND job_id = ?",
        ("", "local", job_id),
    )
    repo.parse_and_save_job_salary(
        job_id,
        conn.execute("SELECT salary FROM jobs WHERE tenant_id = ? AND job_id = ?", ("local", job_id)).fetchone()[
            "salary"
        ],
    )

    salary = conn.execute("SELECT salary FROM jobs WHERE tenant_id = ? AND job_id = ?", ("local", job_id)).fetchone()[
        "salary"
    ]
    fact = repo.get_fact("local", job_id)

    assert salary == "€80,000/year"
    assert fact is not None
    assert fact.legacy_raw_salary == "€80,000/year"
    assert fact.minimum_amount == 80_000


def test_source_text_is_bounded_in_persistence(conn: sqlite3.Connection) -> None:
    _job_url, job_id = _seed_job(conn, salary="€80,000/year " + ("with benefits " * 80))
    repo = SqlitePostedCompensationRepository(conn)

    repo.backfill_from_jobs()
    fact = repo.get_fact("local", job_id)
    row = conn.execute(
        "SELECT warnings_json, source_text FROM job_posted_compensation_facts WHERE tenant_id = ? AND job_id = ?",
        ("local", job_id),
    ).fetchone()

    assert fact is not None
    assert len(fact.source_text or "") <= 280
    assert row["warnings_json"] == '["source_text_truncated"]'
    assert len(row["source_text"]) <= 280
