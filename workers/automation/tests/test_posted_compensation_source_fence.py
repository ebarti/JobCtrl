"""Posted-pay publication must recheck the preferred source after inference."""

from __future__ import annotations

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from jobctrl.database import init_db
from jobctrl.domain.compensation.posted import ModelPostedPayExtractor
from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.identifiers import JobId
from jobctrl.infrastructure.compensation import SqlitePostedCompensationRepository
from tests.compensation_fakes import PayModel, dependencies, pay_extractor


JOB = JobId("11111111-1111-4111-8111-111111111111")
# A matching ID in a different tenant must not influence source selection.
OTHER_JOB = JOB
NEW_PAY = "EUR 90000/year"


def _snapshot(conn: sqlite3.Connection) -> tuple:
    return tuple(
        tuple(tuple(row) for row in conn.execute(sql, (JOB,)).fetchall())
        for sql in (
            "SELECT * FROM job_posted_compensation_facts WHERE tenant_id='local' AND job_id=?",
            "SELECT * FROM semantic_entity_bindings WHERE tenant_id='local' AND entity_id=? ORDER BY entity_version",
            "SELECT * FROM job_events WHERE tenant_id='local' AND job_id=? AND event_type='CompensationFactsUpdated' ORDER BY event_id",
        )
    )


@pytest.mark.parametrize(
    "change",
    [
        "salary_arrives",
        "salary_removed",
        "enrichment_takes_over",
        "enrichment_arrives",
        "enrichment_loses_status",
        "enrichment_removed",
        "full_description_arrives",
        "description_arrives",
        "salary_text_changes",
        "enrichment_text_changes",
        "unrelated_change",
        "unselected_enrichment_changes",
        "unselected_description_changes",
        "short_description_unchanged",
        "empty_source_unchanged",
        "other_tenant_change",
    ],
)
def test_backfill_rechecks_selected_source_while_independent_writer_commits(tmp_path: Path, change: str) -> None:
    db_path = tmp_path / "synthetic.db"
    conn = init_db(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "INSERT INTO jobs (tenant_id,job_id,url,salary,full_description) VALUES ('local',?,?,?,?)",
        (JOB, "https://example.test/local", "EUR 70000/year", "Synthetic original"),
    )
    conn.execute(
        "INSERT INTO jobs (tenant_id,job_id,url,salary) VALUES ('other',?,?,?)",
        (OTHER_JOB, "https://example.test/other", "EUR 80000/year"),
    )
    conn.execute(
        "INSERT INTO job_enrichments (tenant_id,job_id,current_status,full_description,updated_at) "
        "VALUES ('other',?,'enriched','EUR 130000/year','2026-01-01')",
        (OTHER_JOB,),
    )
    conn.commit()
    SqlitePostedCompensationRepository(
        conn,
        extractor=pay_extractor(conn, minimum=70000, maximum=70000),
    ).parse_and_save_job_salary(JOB, "EUR 70000/year", parsed_at="2026-01-01T00:00:00Z")

    has_salary = change in {
        "salary_removed",
        "salary_text_changes",
        "unrelated_change",
        "unselected_enrichment_changes",
        "other_tenant_change",
    }
    enrichment_status = (
        "enriched"
        if change
        in {
            "enrichment_loses_status",
            "enrichment_removed",
            "enrichment_text_changes",
            "unselected_description_changes",
        }
        else "pending"
    )
    empty_source = change in {"description_arrives", "empty_source_unchanged"}
    no_full_description = change in {"full_description_arrives", "short_description_unchanged"} or empty_source
    conn.execute(
        "UPDATE jobs SET salary=?, full_description=?, description=? WHERE tenant_id='local' AND job_id=?",
        (
            NEW_PAY if has_salary else None,
            None if no_full_description else NEW_PAY,
            None if empty_source else NEW_PAY,
            JOB,
        ),
    )
    if change != "enrichment_arrives":
        conn.execute(
            "INSERT INTO job_enrichments (tenant_id,job_id,current_status,full_description,updated_at) VALUES ('local',?,?,?,?)",
            (JOB, enrichment_status, NEW_PAY, "2026-01-01T00:00:00Z"),
        )
    conn.commit()
    accepted = _snapshot(conn)
    entered, release = threading.Event(), threading.Event()

    class BlockingPayModel(PayModel):
        def chat_json(self, messages, **kwargs):
            assert not worker_conn.in_transaction
            entered.set()
            assert release.wait(10), "the synthetic writer did not finish"
            return super().chat_json(messages, **kwargs)

    def refresh() -> int:
        nonlocal worker_conn
        worker_conn = sqlite3.connect(db_path, timeout=5)
        worker_conn.row_factory = sqlite3.Row
        try:
            model = BlockingPayModel() if empty_source else BlockingPayModel(90000, 90000)
            extractor = ModelPostedPayExtractor(**dependencies(worker_conn, model, "compensation"))
            return SqlitePostedCompensationRepository(worker_conn, extractor=extractor).backfill_from_jobs(
                parsed_at="2026-02-01T00:00:00Z",
            )
        finally:
            worker_conn.close()

    worker_conn: sqlite3.Connection
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(refresh)
        try:
            assert entered.wait(10), "the model was not called"
            with sqlite3.connect(db_path, timeout=0) as writer:
                if change == "salary_arrives":
                    writer.execute("UPDATE jobs SET salary=? WHERE tenant_id='local' AND job_id=?", (NEW_PAY, JOB))
                elif change == "salary_removed":
                    writer.execute("UPDATE jobs SET salary=NULL WHERE tenant_id='local' AND job_id=?", (JOB,))
                elif change == "enrichment_takes_over":
                    writer.execute(
                        "UPDATE job_enrichments SET current_status='enriched' WHERE tenant_id='local' AND job_id=?",
                        (JOB,),
                    )
                elif change == "enrichment_arrives":
                    writer.execute(
                        "INSERT INTO job_enrichments (tenant_id,job_id,current_status,full_description,updated_at) "
                        "VALUES ('local',?,'enriched',?,'2026-01-01')",
                        (JOB, NEW_PAY),
                    )
                elif change == "enrichment_loses_status":
                    writer.execute(
                        "UPDATE job_enrichments SET current_status='pending' WHERE tenant_id='local' AND job_id=?",
                        (JOB,),
                    )
                elif change == "enrichment_removed":
                    writer.execute("DELETE FROM job_enrichments WHERE tenant_id='local' AND job_id=?", (JOB,))
                elif change == "full_description_arrives":
                    writer.execute(
                        "UPDATE jobs SET full_description=? WHERE tenant_id='local' AND job_id=?", (NEW_PAY, JOB)
                    )
                elif change == "description_arrives":
                    writer.execute("UPDATE jobs SET description=? WHERE tenant_id='local' AND job_id=?", (NEW_PAY, JOB))
                elif change == "salary_text_changes":
                    writer.execute(
                        "UPDATE jobs SET salary='EUR 100000/year' WHERE tenant_id='local' AND job_id=?", (JOB,)
                    )
                elif change == "enrichment_text_changes":
                    writer.execute(
                        "UPDATE job_enrichments SET full_description='EUR 100000/year' WHERE tenant_id='local' AND job_id=?",
                        (JOB,),
                    )
                elif change in {"unrelated_change", "short_description_unchanged", "empty_source_unchanged"}:
                    writer.execute(
                        "UPDATE jobs SET title='Synthetic updated title' WHERE tenant_id='local' AND job_id=?", (JOB,)
                    )
                elif change == "unselected_enrichment_changes":
                    writer.execute(
                        "UPDATE job_enrichments SET current_status='enriched' WHERE tenant_id='local' AND job_id=?",
                        (JOB,),
                    )
                elif change == "unselected_description_changes":
                    writer.execute(
                        "UPDATE jobs SET full_description='Synthetic newer text' WHERE tenant_id='local' AND job_id=?",
                        (JOB,),
                    )
                else:
                    writer.execute(
                        "UPDATE jobs SET salary='EUR 110000/year' WHERE tenant_id='other' AND job_id=?", (OTHER_JOB,)
                    )
        finally:
            release.set()

        if change in {
            "unrelated_change",
            "unselected_enrichment_changes",
            "unselected_description_changes",
            "short_description_unchanged",
            "empty_source_unchanged",
            "other_tenant_change",
        }:
            assert future.result(timeout=10) == 1
            fact = SqlitePostedCompensationRepository(conn).get_fact("local", JOB)
            assert fact is not None
            expected_field = {
                "unselected_description_changes": "job_enrichments.full_description",
                "short_description_unchanged": "jobs.description",
            }.get(change, "jobs.salary")
            assert (fact.source_field, fact.minimum_amount) == (expected_field, None if empty_source else 90000)
            assert len(_snapshot(conn)[2]) == len(accepted[2]) + 1
        else:
            with pytest.raises(DeterminationFailure, match="posted_compensation_source_changed"):
                future.result(timeout=10)
            assert _snapshot(conn) == accepted
        # Both success and refusal release the short publication reservation.
        with sqlite3.connect(db_path, timeout=0) as writer:
            writer.execute("UPDATE jobs SET title=title WHERE tenant_id='local' AND job_id=?", (JOB,))
    conn.close()


def test_source_read_and_publication_share_the_writer_reservation(tmp_path: Path) -> None:
    db_path = tmp_path / "synthetic.db"
    conn = init_db(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "INSERT INTO jobs (tenant_id,job_id,url,salary) VALUES ('local',?,?,?)",
        (JOB, "https://example.test/write-fence", NEW_PAY),
    )
    conn.commit()

    class WriterProbeRepository(SqlitePostedCompensationRepository):
        def _save_fact_row(self, fact):
            # This point is after the source read but before fact publication.
            with sqlite3.connect(db_path, timeout=0) as writer:
                with pytest.raises(sqlite3.OperationalError, match="locked"):
                    writer.execute(
                        "UPDATE jobs SET salary='EUR 100000/year' WHERE tenant_id='local' AND job_id=?", (JOB,)
                    )
            super()._save_fact_row(fact)

    repo = WriterProbeRepository(conn, extractor=pay_extractor(conn, minimum=90000, maximum=90000))
    repo.parse_and_save_job_salary(JOB, NEW_PAY)
    assert len(_snapshot(conn)[2]) == 1
    with sqlite3.connect(db_path, timeout=0) as writer:
        writer.execute("UPDATE jobs SET salary='EUR 100000/year' WHERE tenant_id='local' AND job_id=?", (JOB,))
    conn.close()


def test_per_job_refresh_preserves_accepted_fact_when_salary_arrives(tmp_path: Path, monkeypatch) -> None:
    from jobctrl.infrastructure.compensation import refresh as refresh_module

    db_path = tmp_path / "synthetic.db"
    conn = init_db(db_path)
    conn.row_factory = sqlite3.Row
    conn.execute(
        "INSERT INTO jobs (tenant_id,job_id,url,salary) VALUES ('local',?,?,?)",
        (JOB, "https://example.test/refresh", "EUR 70000/year"),
    )
    conn.commit()
    SqlitePostedCompensationRepository(
        conn,
        extractor=pay_extractor(conn, minimum=70000, maximum=70000),
    ).parse_and_save_job_salary(JOB, "EUR 70000/year")
    conn.execute("UPDATE jobs SET salary=NULL,full_description=? WHERE tenant_id='local' AND job_id=?", (NEW_PAY, JOB))
    conn.commit()
    accepted = _snapshot(conn)

    class ConcurrentPayModel(PayModel):
        def chat_json(self, messages, **kwargs):
            assert not conn.in_transaction
            with sqlite3.connect(db_path, timeout=0) as writer:
                writer.execute("UPDATE jobs SET salary=? WHERE tenant_id='local' AND job_id=?", (NEW_PAY, JOB))
            return super().chat_json(messages, **kwargs)

    extractor = ModelPostedPayExtractor(**dependencies(conn, ConcurrentPayModel(90000, 90000), "compensation"))
    monkeypatch.setattr(refresh_module, "get_connection", lambda: conn)
    monkeypatch.setattr(
        refresh_module,
        "SqlitePostedCompensationRepository",
        lambda connection: SqlitePostedCompensationRepository(connection, extractor=extractor),
    )

    with pytest.raises(DeterminationFailure, match="posted_compensation_source_changed"):
        refresh_module.refresh_compensation_facts(tenant_id="local", job_id=JOB, include_euro_top_tech=False)
    assert _snapshot(conn) == accepted
    conn.close()


def test_unknown_source_field_cannot_bypass_the_preferred_source_fence(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "synthetic.db")
    conn.row_factory = sqlite3.Row
    conn.execute(
        "INSERT INTO jobs (tenant_id,job_id,url,salary) VALUES ('local',?,?,?)",
        (JOB, "https://example.test/unknown-source", NEW_PAY),
    )
    conn.commit()
    repo = SqlitePostedCompensationRepository(conn, extractor=pay_extractor(conn, minimum=90000, maximum=90000))
    repo.parse_and_save_job_salary(JOB, NEW_PAY)
    accepted = _snapshot(conn)

    with pytest.raises(DeterminationFailure, match="posted_compensation_source_changed"):
        repo.parse_and_save_job_salary(JOB, NEW_PAY, source_field="unknown")
    assert _snapshot(conn) == accepted
    conn.close()
