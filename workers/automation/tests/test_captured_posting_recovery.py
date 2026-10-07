import json
from dataclasses import asdict

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.domain.discovery.execution import DiscoveryExecutionRef
from jobctrl.domain.discovery.value_objects import Employer, JobMetadata, PostingUrl, SearchStrategy, Source
from jobctrl.domain.ports.discovery import ScrapedJobPosting
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.discovery import capture_recovery


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "jobctrl.db"
    connection = init_db(path)
    yield connection
    close_connection(path)


def capture(conn, key, *, title="Platform Engineer", source="greenhouse:acme", tenant="local", status="superseded"):
    url = f"https://boards.greenhouse.io/acme/jobs/{key}"
    posting = ScrapedJobPosting(
        posting_url=PostingUrl(url),
        source=Source("greenhouse"),
        employer=Employer("Acme"),
        metadata=JobMetadata(title=title),
        strategy=SearchStrategy.WORKDAY_API,
        source_id=source,
        source_native_id=key,
        canonical_url=url,
    )
    conn.execute(
        "INSERT INTO posting_triage (tenant_id,listing_id,snapshot_fingerprint,target_fingerprint,source_id,"
        "listing_json,posting_json,status,created_at) VALUES (?,?,?,?,?,'{}',?,?,?)",
        (tenant, key, key, key, source, json.dumps(asdict(posting)), status, "2026-01-01T00:00:00Z"),
    )
    conn.commit()


def recover(conn, **kwargs):
    return capture_recovery.recover_captured_postings(
        conn, tenant_id="local", source_ids=("greenhouse:acme",), source_family="ats_api",
        run_id="capture-recovery-test", search_cfg=kwargs.pop("search_cfg", {}), **kwargs,
    )


@pytest.mark.parametrize("status", ["pending_triage", "superseded"])
def test_archived_payload_ingests_without_a_model_or_old_preferences(conn, status):
    capture(conn, "1", status=status)
    capture(conn, "2", source="greenhouse:another")
    capture(conn, "3", tenant="another")
    result = recover(conn)
    assert result == {"new": 1, "existing": 0, "recovered_captures": 1, "recovered_exclusions": 0}
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM semantic_determinations").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM posting_triage WHERE consumed_at IS NULL").fetchone()[0] == 2
    assert recover(conn)["recovered_captures"] == 0


def test_recovery_preserves_new_job_limit_and_literal_exclusions(conn):
    capture(conn, "1", title="Accountant")
    capture(conn, "2", title="Senior Accountant")
    capture(conn, "3")
    result = recover(conn, limit=1, search_cfg={"exact_title_exclusions": ["Accountant"]})
    assert result == {"new": 1, "existing": 0, "recovered_captures": 2, "recovered_exclusions": 1}
    assert [row["title"] for row in conn.execute("SELECT title FROM jobs")] == ["Senior Accountant"]
    assert conn.execute("SELECT consumed_at FROM posting_triage WHERE listing_id='3'").fetchone()[0] is None


def test_interruption_after_ingestion_keeps_capture_and_retries_idempotently(conn, monkeypatch):
    capture(conn, "1")
    original = capture_recovery.DiscoverJobsUseCase

    class Interrupted(original):
        def execute(self, **kwargs):
            super().execute(**kwargs)
            raise RuntimeError("synthetic interruption before consumption")

    monkeypatch.setattr(capture_recovery, "DiscoverJobsUseCase", Interrupted)
    with pytest.raises(RuntimeError, match="synthetic interruption"):
        recover(conn)
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    events = conn.execute("SELECT count(*) FROM job_events").fetchone()[0]
    monkeypatch.setattr(capture_recovery, "DiscoverJobsUseCase", original)
    assert recover(conn)["new"] == 0
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM job_source_observations").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM job_events").fetchone()[0] == events
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is not None


@pytest.mark.parametrize("invalid", ["payload", "source"])
def test_invalid_capture_fails_safely_without_consumption(conn, invalid):
    capture(conn, "1")
    if invalid == "payload":
        conn.execute("UPDATE posting_triage SET posting_json=?", (json.dumps({"private": "synthetic private text"}),))
        code = "captured_posting_invalid"
    else:
        payload = json.loads(conn.execute("SELECT posting_json FROM posting_triage").fetchone()[0])
        payload["source_id"] = "greenhouse:foreign"
        conn.execute("UPDATE posting_triage SET posting_json=?", (json.dumps(payload),))
        code = "captured_posting_source_mismatch"
    conn.commit()
    with pytest.raises(ValueError) as error:
        recover(conn)
    assert str(error.value) == code
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 0


@pytest.mark.parametrize("deleted", [False, True])
def test_archived_recovery_preserves_newer_metadata_and_tombstones(conn, deleted):
    capture(conn, "1")
    recover(conn)
    job_id = conn.execute("SELECT job_id FROM jobs").fetchone()[0]
    conn.execute("UPDATE jobs SET description='Newer saved description'")
    conn.execute("UPDATE posting_triage SET consumed_at=NULL")
    conn.commit()
    repository = capture_recovery.SqliteJobRepository(conn)
    if deleted:
        repository.soft_delete(LOCAL_TENANT, job_id, deleted_at="2026-10-07T00:00:00Z", reason="synthetic owner deletion")
    assert recover(conn, limit=1)["existing"] == 1
    job = repository.load(LOCAL_TENANT, job_id)
    assert job.metadata.description == "Newer saved description"
    assert job.is_deleted is deleted


def test_existing_capture_does_not_consume_the_new_job_limit(conn):
    capture(conn, "1")
    recover(conn)
    conn.execute("UPDATE posting_triage SET consumed_at=NULL")
    conn.commit()
    capture(conn, "2")
    result = recover(conn, limit=1)
    assert (result["existing"], result["new"], result["recovered_captures"]) == (1, 1, 2)


def test_recovered_posting_belongs_to_the_selected_execution(conn):
    capture(conn, "1")
    execution = DiscoveryExecutionRef("local", "owned-discovery", "owned-run")
    assert recover(conn, discovery_execution=execution)["new"] == 1
    row = conn.execute("SELECT * FROM discovery_execution_jobs").fetchone()
    assert (row["discover_workflow_id"], row["discover_run_id"], row["source_family"], row["source_run_id"]) == (
        "owned-discovery", "owned-run", "ats_api", "capture-recovery-test",
    )
    assert row["cohort_kind"] == "observed_this_run"
