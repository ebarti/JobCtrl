"""Code equality and generation-safe benchmark projection in native storage."""

import json
import pytest
from jobctrl.database import init_db, close_connection
from jobctrl.infrastructure.compensation.benchmark_materialization import materialize_automatic_compensation_estimates
from jobctrl.infrastructure.compensation.sqlite_market_repository import SqliteMarketCompensationRepository
from tests.compensation_fakes import NOW, JOB, ClassificationModel, put_job, configure_classifier, refresh


@pytest.fixture
def database(tmp_path):
    path = tmp_path / "owned.sqlite"
    conn = init_db(path)
    yield conn
    close_connection(path)


def test_two_jobs_share_a_classified_slice_and_repeated_materialization_is_idempotent(database, monkeypatch):
    second = "22222222-2222-4222-8222-222222222222"
    put_job(database)
    put_job(database, job_id=second)
    configure_classifier(monkeypatch, ClassificationModel())
    refresh(database)
    first = materialize_automatic_compensation_estimates(database, tenant_id="local", materialized_at=NOW)
    assert first.estimates_written == 2 and first.jobs_with_benchmark == 2
    count = database.execute("SELECT count(*) FROM job_events WHERE event_type='CompensationFactsUpdated'").fetchone()[
        0
    ]
    again = materialize_automatic_compensation_estimates(database, tenant_id="local", materialized_at=NOW)
    assert again.estimates_written == 0 and again.estimates_unchanged == 2
    assert (
        database.execute("SELECT count(*) FROM job_events WHERE event_type='CompensationFactsUpdated'").fetchone()[0]
        == count
    )
    for ident in (JOB, second):
        row = database.execute(
            "SELECT compensation_summary_json,compensation_audit_json FROM job_detail_projections WHERE job_id=?",
            (ident,),
        ).fetchone()
        audit = json.loads(row[1])
        summary = json.loads(row[0])
        assert summary["market"]["displayRange"] == "EUR 60000-90000/year"
        assert audit["market"]["estimate"]["benchmarkLineage"]["roleFamilyCode"] == "software_engineering"
        assert audit["market"]["estimate"]["benchmarkLineage"]["seniorityLabel"] == "senior"


@pytest.mark.parametrize(
    "family,seniority,country",
    [("sales", "senior", "ES"), ("software_engineering", "principal", "ES"), ("software_engineering", "senior", "DE")],
)
def test_different_model_codes_do_not_borrow_another_slice(database, monkeypatch, family, seniority, country):
    second = "22222222-2222-4222-8222-222222222222"
    put_job(database)
    put_job(database, job_id=second, family=family, seniority=seniority, country=country)
    configure_classifier(monkeypatch, ClassificationModel())
    refresh(database)
    materialize_automatic_compensation_estimates(database, tenant_id="local", materialized_at=NOW)
    repo = SqliteMarketCompensationRepository(database)
    assert repo.get_estimate("local", JOB).estimate_state == "estimated_range"
    other = repo.get_estimate("local", second)
    assert other is None or other.estimate_state == "insufficient_evidence"


def test_missing_job_interpretation_preserves_existing_estimate(database, monkeypatch):
    put_job(database)
    configure_classifier(monkeypatch, ClassificationModel())
    refresh(database)
    materialize_automatic_compensation_estimates(database, tenant_id="local", materialized_at=NOW)
    repo = SqliteMarketCompensationRepository(database)
    before = repo.get_estimate("local", JOB)
    database.execute("UPDATE jobs SET description='Changed snapshot' WHERE job_id=?", (JOB,))
    database.commit()
    result = materialize_automatic_compensation_estimates(database, tenant_id="local", materialized_at=NOW)
    assert result.estimates_written == 0
    assert repo.get_estimate("local", JOB) == before
