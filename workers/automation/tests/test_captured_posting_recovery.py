import json
from dataclasses import asdict
import sqlite3
import threading

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
    assert result == {"new": 1, "existing": 0, "recovered_captures": 1, "recovered_exclusions": 0,
                      "recovered_capture_failures": 0}
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM semantic_determinations").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM posting_triage WHERE consumed_at IS NULL").fetchone()[0] == 2
    assert recover(conn)["recovered_captures"] == 0


def test_recovery_preserves_new_job_limit_and_literal_exclusions(conn):
    capture(conn, "1", title="Accountant")
    capture(conn, "2", title="Senior Accountant")
    capture(conn, "3")
    result = recover(conn, limit=1, search_cfg={"exact_title_exclusions": ["Accountant"]})
    assert result == {"new": 1, "existing": 0, "recovered_captures": 2, "recovered_exclusions": 1,
                      "recovered_capture_failures": 0}
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
def test_invalid_capture_is_quarantined_without_blocking_valid_rows_or_retrying(conn, invalid):
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
    raw = conn.execute("SELECT posting_json FROM posting_triage WHERE listing_id='1'").fetchone()[0]
    capture(conn, "2")
    result = recover(conn)
    assert result["recovered_capture_failures"] == 1
    assert result["new"] == 1
    assert conn.execute("SELECT consumed_at FROM posting_triage WHERE listing_id='1'").fetchone()[0] is None
    assert conn.execute("SELECT posting_json,failure_code FROM posting_triage WHERE listing_id='1'").fetchone()[:] == (raw, code)
    event = conn.execute("SELECT message,level,payload_json FROM job_events WHERE entity_kind='discovery_capture'").fetchone()
    assert event[1] == "warning"
    assert json.loads(event[2])["errorCode"] == code
    assert "synthetic private text" not in event[0] + event[2]
    assert recover(conn)["recovered_capture_failures"] == 0
    assert conn.execute("SELECT count(*) FROM job_events WHERE entity_kind='discovery_capture'").fetchone()[0] == 1


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


def smart_models(monkeypatch, model, *, page=None):
    from jobctrl.discovery import smartextract
    from jobctrl.infrastructure.discovery.smart_postings import SmartPostingIntake
    from tests.smart_posting_fakes import PageFetcher, allow_url, model_dependencies, posting_page

    def factory(connection, **kwargs):
        kwargs.pop("fetcher", None)
        kwargs.pop("dependencies", None)
        return SmartPostingIntake(
            connection, **kwargs,
            fetcher=PageFetcher(page or posting_page("https://boards.greenhouse.io/acme/jobs/1")),
            dependencies=model_dependencies(connection, model, tenant_id=str(kwargs.get("tenant_id", "local"))),
            url_validator=allow_url,
        )

    monkeypatch.setattr(smartextract, "SmartPostingIntake", factory)


def smart_recover(conn, **kwargs):
    return capture_recovery.recover_captured_postings(
        conn, tenant_id=kwargs.pop("tenant_id", "local"), source_ids=("smart_extract:synthetic",),
        source_family="smartextract", run_id="smart-capture-recovery", search_cfg={}, **kwargs,
    )


@pytest.mark.parametrize("verdict,new,held", [("match", 1, 0), ("mismatch", 0, 0), ("unknown", 0, 1)])
def test_smart_archived_cards_cannot_bypass_full_posting_qualification(conn, monkeypatch, verdict, new, held):
    from tests.smart_posting_fakes import PostingModel

    capture(conn, "1", title="Synthetic is hiring people", source="smart_extract:synthetic")
    model = PostingModel(location=verdict)
    smart_models(monkeypatch, model)
    assert smart_recover(conn)["new"] == new
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == new
    assert conn.execute("SELECT count(*) FROM manual_capture_queue").fetchone()[0] == held
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is not None
    assert [call[0] for call in model.calls] == [
        "PageInterpretation", "PostingSelectionExtraction", "PostingQualification",
    ]
    if new:
        assert tuple(conn.execute("SELECT title,company FROM jobs").fetchone()) == ("Platform Director", "Synthetic Labs")
        assert conn.execute("SELECT source_native_id FROM job_source_observations").fetchone()[0] == "1"
    assert smart_recover(conn)["recovered_captures"] == 0


@pytest.mark.parametrize("deleted", [False, True])
def test_smart_recovery_keeps_newer_content_enrichment_and_owner_deletion(conn, monkeypatch, deleted):
    from tests.smart_posting_fakes import PostingModel

    capture(conn, "1", source="smart_extract:synthetic")
    model = PostingModel()
    smart_models(monkeypatch, model)
    assert smart_recover(conn)["new"] == 1
    job_id = conn.execute("SELECT job_id FROM jobs").fetchone()[0]
    conn.execute("UPDATE jobs SET description='Newer saved description'")
    conn.execute("UPDATE posting_triage SET consumed_at=NULL")
    conn.commit()
    if deleted:
        capture_recovery.SqliteJobRepository(conn).soft_delete(
            LOCAL_TENANT, job_id, deleted_at="2026-10-21T00:00:00Z", reason="synthetic deletion",
        )
    enrichment_before = tuple(conn.execute("SELECT * FROM job_enrichments").fetchone())
    snapshot_before = tuple(conn.execute("SELECT * FROM posting_snapshot_sets").fetchone())
    assert smart_recover(conn)["existing"] == 1
    assert conn.execute("SELECT description FROM jobs").fetchone()[0] == "Newer saved description"
    assert tuple(conn.execute("SELECT * FROM job_enrichments").fetchone()) == enrichment_before
    assert tuple(conn.execute("SELECT * FROM posting_snapshot_sets").fetchone()) == snapshot_before
    assert capture_recovery.SqliteJobRepository(conn).load(LOCAL_TENANT, job_id).is_deleted is deleted
    assert len(model.calls) == 3


def test_interrupted_smart_recovery_reuses_fixed_observation_and_model_receipts(conn, monkeypatch):
    from jobctrl.discovery import smartextract
    from tests.smart_posting_fakes import PostingModel

    capture(conn, "1", source="smart_extract:synthetic")
    model = PostingModel()
    smart_models(monkeypatch, model)
    original = smartextract._store_jobs

    def interrupted(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("synthetic interruption after verified ingestion")

    monkeypatch.setattr(smartextract, "_store_jobs", interrupted)
    with pytest.raises(RuntimeError, match="synthetic interruption"):
        smart_recover(conn)
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    events = conn.execute("SELECT count(*) FROM job_events").fetchone()[0]
    monkeypatch.setattr(smartextract, "_store_jobs", original)
    assert smart_recover(conn)["existing"] == 1
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM job_source_observations").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM job_events").fetchone()[0] == events
    assert len(model.calls) == 3


def test_smart_recovery_holds_unknown_capture_in_its_own_tenant(conn, monkeypatch):
    from tests.smart_posting_fakes import PostingModel

    capture(conn, "1", source="smart_extract:synthetic", tenant="other")
    smart_models(monkeypatch, PostingModel(location="unknown"))
    assert smart_recover(conn)["recovered_captures"] == 0
    assert smart_recover(conn, tenant_id="other")["new"] == 0
    assert conn.execute("SELECT tenant_id FROM manual_capture_queue").fetchone()[0] == "other"
    assert {row[0] for row in conn.execute("SELECT tenant_id FROM semantic_determinations")} == {"other"}


def interrupt_snapshot(conn, monkeypatch):
    from jobctrl.domain.enrichment.snapshot_use_case import CapturePostingSnapshotUseCase
    from tests.smart_posting_fakes import PostingModel

    capture(conn, "1", source="smart_extract:synthetic")
    model = PostingModel()
    smart_models(monkeypatch, model)
    original = CapturePostingSnapshotUseCase.execute

    def fail(_self, **_kwargs):
        raise RuntimeError("synthetic snapshot persistence failure")

    monkeypatch.setattr(CapturePostingSnapshotUseCase, "execute", fail)
    with pytest.raises(RuntimeError, match="synthetic snapshot persistence failure"):
        smart_recover(conn)
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 0
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    monkeypatch.setattr(CapturePostingSnapshotUseCase, "execute", original)
    return model


def test_smart_snapshot_retry_completes_snapshot_before_capture_ack(conn, monkeypatch):
    from jobctrl.infrastructure.events import get_default_publisher

    published = []
    subscription = get_default_publisher().subscribe(None, lambda event: published.append(event.event_type))
    interrupt_snapshot(conn, monkeypatch)
    subscription.unsubscribe()
    assert "ArchivedSmartPostingPrepared" not in published
    assert smart_recover(conn)["existing"] == 1
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 1
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is not None


def test_smart_snapshot_retry_publishes_original_capture_without_refetch(conn, monkeypatch):
    from jobctrl.discovery import smartextract
    from jobctrl.infrastructure.discovery.smart_postings import SmartPostingIntake

    model = interrupt_snapshot(conn, monkeypatch)
    original_observation = tuple(conn.execute("SELECT * FROM job_source_observations").fetchone())
    receipts = [tuple(row) for row in conn.execute("SELECT * FROM semantic_determinations ORDER BY determination_id")]

    def forbidden(*_args, **_kwargs):
        pytest.fail("Retry must consume its recorded capture, without a new page or model decision")

    monkeypatch.setattr(SmartPostingIntake, "prepare", forbidden)
    monkeypatch.setattr(smartextract, "SmartPostingIntake", SmartPostingIntake)
    monkeypatch.setattr("jobctrl.infrastructure.discovery.smart_postings.determination_dependencies", forbidden)
    monkeypatch.setattr("jobctrl.infrastructure.discovery.live_browser.prefer_live_browser", forbidden)
    assert smart_recover(conn)["existing"] == 1
    snapshot = conn.execute("SELECT snapshot_set_json FROM posting_snapshot_sets").fetchone()[0]
    assert all(row[1] in snapshot for row in conn.execute("SELECT tenant_id,determination_id FROM semantic_determinations"))
    assert conn.execute("SELECT full_description FROM job_enrichments").fetchone()[0] == "Lead the platform team and delivery."
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is not None
    assert tuple(conn.execute("SELECT * FROM job_source_observations").fetchone()) == original_observation
    assert [tuple(row) for row in conn.execute("SELECT * FROM semantic_determinations ORDER BY determination_id")] == receipts
    state = [tuple(row) for row in conn.execute("SELECT * FROM job_events ORDER BY event_id")]
    conn.execute("UPDATE posting_triage SET consumed_at=NULL")
    conn.commit()
    assert smart_recover(conn)["existing"] == 1
    assert [tuple(row) for row in conn.execute("SELECT * FROM job_events ORDER BY event_id")] == state
    assert conn.execute("SELECT snapshot_set_json FROM posting_snapshot_sets").fetchone()[0] == snapshot
    assert len(model.calls) == 3


@pytest.mark.parametrize("fault", ["snapshot", "enrichment", "acceptance", "completion", "event"])
def test_smart_publication_rolls_back_all_partial_writes(conn, monkeypatch, fault):
    from jobctrl.infrastructure.discovery.archived_smart_posting import CapturePublication
    from jobctrl.infrastructure.discovery.smart_postings import SmartPostingIntake
    from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher
    from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository, SqlitePostingSnapshotSetRepository

    interrupt_snapshot(conn, monkeypatch)
    event_count = conn.execute("SELECT count(*) FROM job_events").fetchone()[0]
    owner, method = {
        "snapshot": (SqlitePostingSnapshotSetRepository, "save"),
        "enrichment": (SqliteEnrichmentRepository, "save"),
        "acceptance": (SmartPostingIntake, "record"),
        "completion": (CapturePublication, "finish"),
        "event": (DurableJobEventPublisher, "publish"),
    }[fault]
    original = getattr(owner, method)

    def fail(*args, **kwargs):
        original(*args, **kwargs)
        raise RuntimeError("synthetic publication interruption")

    monkeypatch.setattr(owner, method, fail)
    with pytest.raises(RuntimeError, match="synthetic publication interruption|enrichment was not persisted|events were not persisted"):
        smart_recover(conn)
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM job_enrichments").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM job_events").fetchone()[0] == event_count
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    monkeypatch.setattr(owner, method, original)
    assert smart_recover(conn)["existing"] == 1
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 1


@pytest.mark.parametrize("newer", ["deleted", "removed", "metadata", "observation", "enrichment", "snapshot",
                                  "stage_owner", "pending_enrichment", "pending_snapshot"])
def test_incomplete_capture_cannot_replace_newer_owner_state(conn, monkeypatch, newer):
    from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository, SqlitePostingSnapshotSetRepository
    from jobctrl.domain.enrichment import FullDescription, JobEnrichment, ExtractionTier
    from jobctrl.domain.identifiers import JobId

    interrupt_snapshot(conn, monkeypatch)
    job_id = conn.execute("SELECT job_id FROM jobs").fetchone()[0]
    # A separately committed writer owns the change before recovery acquires
    # its publication lock. Identical text with a new observation is newer too.
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    with sqlite3.connect(path) as writer:
        writer.execute("PRAGMA foreign_keys=ON")
        if newer == "deleted":
            writer.execute("INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at) VALUES ('local',?,'2026-10-27')", (job_id,))
        elif newer == "removed":
            writer.execute("DELETE FROM jobs WHERE job_id=?", (job_id,))
        elif newer == "metadata":
            writer.execute("UPDATE jobs SET description='Newer owner description' WHERE job_id=?", (job_id,))
        elif newer == "observation":
            writer.execute("UPDATE job_source_observations SET source_observation_id='newer-capture' WHERE job_id=?", (job_id,))
        elif newer == "stage_owner":
            from jobctrl.state import ensure_job_stage_rows, set_stage_state
            ensure_job_stage_rows(writer, job_id, tenant_id=LOCAL_TENANT, discovered_at="2026-10-27")
            set_stage_state(writer, job_id, "enrich", "running", tenant_id=LOCAL_TENANT, started_at="2026-10-27")
        elif newer in {"enrichment", "pending_enrichment"}:
            enrichment = JobEnrichment.empty(tenant_id=LOCAL_TENANT, job_id=JobId(job_id), updated_at="2026-10-27")
            if newer == "enrichment":
                enrichment = enrichment.start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="2026-10-27")
                enrichment = enrichment.succeed_attempt(full_description=FullDescription("Newer accepted enrichment"),
                    application_url=None, extraction_tier=ExtractionTier.JSON_LD, finished_at="2026-10-27")
            SqliteEnrichmentRepository(writer).save(enrichment)
        else:
            from jobctrl.domain.enrichment.snapshot_set import PostingSnapshotSet
            from jobctrl.domain.enrichment.snapshot_value_objects import (
                ActiveState, QuarantineReason, SnapshotConfidence, SnapshotDescriptionHash,
            )
            snapshots = PostingSnapshotSet.empty(tenant_id=LOCAL_TENANT, job_id=JobId(job_id), updated_at="2026-10-27")
            if newer == "snapshot":
                snapshots, _ = snapshots.record_snapshot(
                    source_id="newer-source", extraction_tier="json_ld",
                    description_hash=SnapshotDescriptionHash.from_text("Newer captured posting"), apply_url=None,
                    active_state=ActiveState.ACTIVE, confidence=SnapshotConfidence.HIGH,
                    quarantine_reason=QuarantineReason.NONE, captured_at="2026-10-27",
                )
            SqlitePostingSnapshotSetRepository(writer).save(snapshots)
    tables = ("jobs", "job_source_observations", "job_enrichments", "posting_snapshot_sets", "jobctrl_deleted_jobs", "job_stage_states")
    before = {table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table}")] for table in tables}
    unfinished = newer in {"stage_owner", "pending_enrichment", "pending_snapshot"}
    if unfinished:
        from jobctrl.domain.errors import TransientNetworkError
        with pytest.raises(TransientNetworkError, match="newer enrichment attempt"):
            smart_recover(conn)
    else:
        assert smart_recover(conn)["existing"] == 1
    assert {table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table}")] for table in tables} == before
    assert (conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None) == unfinished
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == (0 if newer == "removed" else 1)


def test_smart_snapshot_retry_retains_capture_on_cancellation_and_new_activity_owner(conn, monkeypatch):
    from jobctrl.domain.errors import TransientNetworkError
    from jobctrl.infrastructure.discovery.archived_smart_posting import claim_recovery_owner

    interrupt_snapshot(conn, monkeypatch)
    execution = DiscoveryExecutionRef("local", "owned-recovery", "owned-run")
    claim_recovery_owner(conn, execution=execution, family="smartextract", attempt=2, owner_token="new-owner")
    with pytest.raises(TransientNetworkError, match="superseded"):
        smart_recover(conn, discovery_execution=execution, activity_attempt=1, activity_owner_token="old-owner")
    event = threading.Event()
    event.set()
    with pytest.raises(TransientNetworkError, match="canceled"):
        smart_recover(conn, discovery_execution=execution, activity_attempt=2,
                      activity_owner_token="new-owner", cancel_event=event)
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 0
    assert smart_recover(conn, discovery_execution=execution, activity_attempt=2,
                         activity_owner_token="new-owner")["existing"] == 1


@pytest.mark.parametrize("boundary", ["acceptance", "acknowledgement"])
def test_cancellation_during_publication_retains_actionable_capture(conn, monkeypatch, boundary):
    from jobctrl.domain.errors import TransientNetworkError
    from jobctrl.infrastructure.discovery.archived_smart_posting import CapturePublication
    from jobctrl.infrastructure.discovery.smart_postings import SmartPostingIntake

    interrupt_snapshot(conn, monkeypatch)
    event = threading.Event()
    target, method = ((SmartPostingIntake, "record") if boundary == "acceptance" else (CapturePublication, "finish"))
    original = getattr(target, method)

    def canceled(*args, **kwargs):
        result = original(*args, **kwargs)
        event.set()
        return result

    monkeypatch.setattr(target, method, canceled)
    with pytest.raises(TransientNetworkError, match="canceled"):
        smart_recover(conn, cancel_event=event)
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == (0 if boundary == "acceptance" else 1)
    monkeypatch.setattr(target, method, original)
    event.clear()
    assert smart_recover(conn, cancel_event=event)["existing"] == 1
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM job_events WHERE event_type='PostingContentSnapshotCaptured'").fetchone()[0] == 1


@pytest.mark.parametrize("damaged", ["body", "determination"])
def test_damaged_publication_evidence_is_not_acknowledged_or_replaced(conn, monkeypatch, damaged):
    interrupt_snapshot(conn, monkeypatch)
    if damaged == "body":
        conn.execute("UPDATE job_events SET payload_json=json_set(payload_json,"
                     "'$.qualified.fields.description','Changed capture body') "
                     "WHERE event_type='ArchivedSmartPostingPrepared'")
    else:
        conn.execute("UPDATE semantic_determinations SET envelope_json=json_set(envelope_json,'$.provider','foreign')")
    conn.commit()
    with pytest.raises(RuntimeError, match="unavailable or changed|differs from its recorded determinations"):
        smart_recover(conn)
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 0
    assert conn.execute("SELECT description FROM jobs").fetchone()[0] == "Lead the platform team and delivery."


def test_preupgrade_partial_insert_without_original_capture_receipt_stays_actionable(conn, monkeypatch):
    from jobctrl.infrastructure.discovery.smart_postings import SmartPostingIntake
    from jobctrl.infrastructure.discovery.archived_smart_posting import OriginalCaptureUnavailable
    from jobctrl.domain.errors import to_application_error

    interrupt_snapshot(conn, monkeypatch)
    conn.execute("DELETE FROM job_events WHERE event_type='ArchivedSmartPostingPrepared'")
    conn.commit()

    def forbidden(*_args, **_kwargs):
        pytest.fail("Unavailable original capture must not be replaced by a current-page fetch")

    monkeypatch.setattr(SmartPostingIntake, "prepare", forbidden)
    monkeypatch.setattr("jobctrl.infrastructure.discovery.live_browser.prefer_live_browser", forbidden)
    with pytest.raises(OriginalCaptureUnavailable, match="original archived posting publication receipt is missing") as error:
        smart_recover(conn)
    classified = to_application_error(error.value)
    assert classified.type == "archived_posting_original_capture_unavailable" and classified.non_retryable
    assert "Enrich action" in str(classified)
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 0


DISCOVERY_EVENTS = ("JobDiscovered", "CanonicalJobIdentityResolved", "JobSourceObserved")


@pytest.mark.parametrize("failure_event", DISCOVERY_EVENTS)
def test_smart_retry_restores_original_discovery_events_without_new_observation(conn, monkeypatch, failure_event):
    from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher
    from jobctrl.infrastructure.discovery.smart_postings import SmartPostingIntake
    from tests.smart_posting_fakes import PostingModel

    capture(conn, "1", source="smart_extract:synthetic")
    model = PostingModel()
    smart_models(monkeypatch, model)
    original = DurableJobEventPublisher.publish

    def interrupted(self, event):
        if event.event_type == failure_event:
            raise RuntimeError("synthetic original discovery publication interruption")
        return original(self, event)

    monkeypatch.setattr(DurableJobEventPublisher, "publish", interrupted)
    with pytest.raises(RuntimeError, match="original discovery publication"):
        smart_recover(conn)
    observation = tuple(conn.execute("SELECT * FROM job_source_observations").fetchone())
    prepared = json.loads(conn.execute(
        "SELECT payload_json FROM job_events WHERE event_type='ArchivedSmartPostingPrepared'",
    ).fetchone()[0])
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    monkeypatch.setattr(DurableJobEventPublisher, "publish", original)

    def forbidden(*_args, **_kwargs):
        pytest.fail("Original discovery publication recovery must not reacquire the posting")

    monkeypatch.setattr(SmartPostingIntake, "prepare", forbidden)
    assert smart_recover(conn)["existing"] == 1
    for event in prepared["discoveryEvents"]:
        rows = conn.execute("SELECT payload_json FROM job_events WHERE event_type=?", (event["event_type"],)).fetchall()
        assert len(rows) == 1
        expected = {key: value for key, value in event["payload"].items() if key != "job_id"}
        assert json.loads(rows[0][0]).items() >= expected.items()
    assert tuple(conn.execute("SELECT * FROM job_source_observations").fetchone()) == observation
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 1
    before = [tuple(row) for row in conn.execute("SELECT * FROM job_events ORDER BY event_id")]
    conn.execute("UPDATE posting_triage SET consumed_at=NULL")
    conn.commit()
    assert smart_recover(conn)["existing"] == 1
    assert [tuple(row) for row in conn.execute("SELECT * FROM job_events ORDER BY event_id")] == before
    assert len(model.calls) == 3


@pytest.mark.parametrize("failure_event", DISCOVERY_EVENTS)
def test_replayed_discovery_events_rollback_together_on_interruption(conn, monkeypatch, failure_event):
    from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher

    interrupt_snapshot(conn, monkeypatch)
    conn.execute("DELETE FROM job_events WHERE event_type IN (?,?,?)", DISCOVERY_EVENTS)
    conn.commit()
    original = DurableJobEventPublisher.publish

    def interrupted(self, event):
        original(self, event)
        if event.event_type == failure_event:
            raise RuntimeError("synthetic recovered discovery publication interruption")

    monkeypatch.setattr(DurableJobEventPublisher, "publish", interrupted)
    with pytest.raises(RuntimeError, match="recovered discovery publication"):
        smart_recover(conn)
    assert conn.execute("SELECT count(*) FROM job_events WHERE event_type IN (?,?,?)", DISCOVERY_EVENTS).fetchone()[0] == 0
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    monkeypatch.setattr(DurableJobEventPublisher, "publish", original)
    assert smart_recover(conn)["existing"] == 1
    assert conn.execute("SELECT count(*) FROM job_events WHERE event_type IN (?,?,?)", DISCOVERY_EVENTS).fetchone()[0] == 3


def test_legacy_capture_observation_detects_missing_original_before_first_event(conn, monkeypatch):
    from jobctrl.infrastructure.discovery.archived_smart_posting import CapturePublication, OriginalCaptureUnavailable
    from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher
    from jobctrl.infrastructure.discovery.smart_postings import SmartPostingIntake
    from tests.smart_posting_fakes import PostingModel

    capture(conn, "1", source="smart_extract:synthetic")
    model = PostingModel()
    smart_models(monkeypatch, model)
    original_prepare, original_publish = CapturePublication.prepare_insert, DurableJobEventPublisher.publish
    monkeypatch.setattr(CapturePublication, "prepare_insert", lambda *_args, **_kwargs: None)

    def interrupted(self, event):
        if event.event_type == "JobDiscovered":
            raise RuntimeError("synthetic predecessor first-event interruption")
        return original_publish(self, event)

    monkeypatch.setattr(DurableJobEventPublisher, "publish", interrupted)
    with pytest.raises(RuntimeError, match="predecessor first-event"):
        smart_recover(conn)
    monkeypatch.setattr(CapturePublication, "prepare_insert", original_prepare)
    monkeypatch.setattr(DurableJobEventPublisher, "publish", original_publish)
    assert conn.execute("SELECT count(*) FROM job_events").fetchone()[0] == 0

    def forbidden(*_args, **_kwargs):
        pytest.fail("A capture-bound original owner must be detected before provider setup")

    monkeypatch.setattr(SmartPostingIntake, "prepare", forbidden)
    monkeypatch.setattr("jobctrl.infrastructure.discovery.live_browser.prefer_live_browser", forbidden)
    with pytest.raises(OriginalCaptureUnavailable):
        smart_recover(conn)
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 0
    assert len(model.calls) == 3


def test_archived_observation_of_preexisting_bare_owner_is_not_a_partial_insert(conn, monkeypatch):
    from tests.smart_posting_fakes import PostingModel
    from tests.test_discovery_identity import _job

    owner = _job("https://boards.greenhouse.io/acme/jobs/1")
    capture_recovery.SqliteJobRepository(conn).save(owner)
    before = tuple(conn.execute("SELECT * FROM jobs").fetchone())
    capture(conn, "1", source="smart_extract:synthetic")
    smart_models(monkeypatch, PostingModel())
    assert smart_recover(conn)["existing"] == 1
    assert tuple(conn.execute("SELECT * FROM jobs").fetchone()) == before
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is not None
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 0


def test_archive_snapshot_preserves_each_duplicate_candidate_event_idempotently(conn, monkeypatch):
    from jobctrl.domain.enrichment.snapshot_set import PostingSnapshotSet
    from jobctrl.domain.enrichment.snapshot_value_objects import (
        ActiveState, QuarantineReason, SnapshotConfidence, SnapshotDescriptionHash,
    )
    from jobctrl.domain.identifiers import JobId
    from jobctrl.infrastructure.enrichment import SqlitePostingSnapshotSetRepository
    from tests.smart_posting_fakes import PostingModel

    for key in ("other-a", "other-b"):
        capture(conn, key, title=f"Distinct role {key}")
    assert recover(conn)["new"] == 2
    candidate_ids = {row[0] for row in conn.execute("SELECT job_id FROM jobs")}
    for job_id in candidate_ids:
        snapshots = PostingSnapshotSet.empty(tenant_id=LOCAL_TENANT, job_id=JobId(job_id), updated_at="2026-10-27")
        snapshots, _ = snapshots.record_snapshot(
            source_id="synthetic-other", extraction_tier="json_ld",
            description_hash=SnapshotDescriptionHash.from_text("Lead the platform team and delivery."), apply_url=None,
            active_state=ActiveState.ACTIVE, confidence=SnapshotConfidence.HIGH,
            quarantine_reason=QuarantineReason.NONE, captured_at="2026-10-27",
        )
        SqlitePostingSnapshotSetRepository(conn).save(snapshots)
    capture(conn, "1", source="smart_extract:synthetic")
    smart_models(monkeypatch, PostingModel())
    assert smart_recover(conn)["new"] == 1
    rows = conn.execute("SELECT payload_json,idempotency_key FROM job_events WHERE event_type='ContentDuplicateCandidateDetected'").fetchall()
    assert len(rows) == 2 and len({row[1] for row in rows}) == 2
    assert {json.loads(row[0])["candidate_job_id"] for row in rows} == candidate_ids
    before = [tuple(row) for row in conn.execute("SELECT * FROM job_events ORDER BY event_id")]
    conn.execute("UPDATE posting_triage SET consumed_at=NULL WHERE source_id='smart_extract:synthetic'")
    conn.commit()
    assert smart_recover(conn)["existing"] == 1
    assert [tuple(row) for row in conn.execute("SELECT * FROM job_events ORDER BY event_id")] == before


@pytest.mark.parametrize("event_index,field,value", [
    (0, "source", "foreign-board"), (0, "discovered_at", "2000-01-01T00:00:00Z"),
    (1, "canonical_url", "https://example.test/foreign"), (1, "source_native_id", "foreign-native"),
    (1, "ats_kind", "greenhouse"), (1, "confidence", 0.1),
    (2, "source_id", "foreign-source"), (2, "source_native_id", "foreign-native"),
    (2, "observed_url", "https://example.test/foreign"), (2, "run_id", "foreign-run"),
    (2, "observed_at", "2000-01-01T00:00:00Z"), (2, "extra", "forbidden"),
    (0, "occurred_at", "2000-01-01T00:00:00Z"),
])
def test_discovery_event_fields_and_times_bind_exact_original_context(conn, monkeypatch, event_index, field, value):
    from jobctrl.infrastructure.discovery.production_wiring import DurableJobEventPublisher
    from jobctrl.infrastructure.discovery.smart_postings import SmartPostingIntake
    from tests.smart_posting_fakes import PostingModel

    capture(conn, "1", source="smart_extract:synthetic")
    model = PostingModel()
    smart_models(monkeypatch, model)
    original = DurableJobEventPublisher.publish

    def fail(self, event):
        if event.event_type == "JobDiscovered":
            raise RuntimeError("synthetic first-event interruption")
        return original(self, event)

    monkeypatch.setattr(DurableJobEventPublisher, "publish", fail)
    with pytest.raises(RuntimeError, match="first-event"):
        smart_recover(conn)
    monkeypatch.setattr(DurableJobEventPublisher, "publish", original)
    raw = conn.execute("SELECT payload_json FROM job_events WHERE event_type='ArchivedSmartPostingPrepared'").fetchone()[0]
    payload = json.loads(raw)
    event = payload["discoveryEvents"][event_index]
    (event if field == "occurred_at" else event["payload"])[field] = value
    conn.execute("UPDATE job_events SET payload_json=? WHERE event_type='ArchivedSmartPostingPrepared'", (json.dumps(payload),))
    conn.commit()

    def forbidden(*_args, **_kwargs):
        pytest.fail("Damaged original event facts must not trigger another posting acquisition")

    monkeypatch.setattr(SmartPostingIntake, "prepare", forbidden)
    with pytest.raises(RuntimeError, match="recorded identity or observation"):
        smart_recover(conn)
    assert conn.execute("SELECT count(*) FROM job_events WHERE event_type IN (?,?,?)", DISCOVERY_EVENTS).fetchone()[0] == 0
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 0
    conn.execute("UPDATE job_events SET payload_json=? WHERE event_type='ArchivedSmartPostingPrepared'", (raw,))
    conn.commit()
    assert smart_recover(conn)["existing"] == 1
    assert len(model.calls) == 3


def test_original_discovery_context_also_joins_unchanged_canonical_observation(conn, monkeypatch):
    interrupt_snapshot(conn, monkeypatch)
    raw = conn.execute("SELECT payload_json FROM job_events WHERE event_type='ArchivedSmartPostingPrepared'").fetchone()[0]
    payload = json.loads(raw)
    # Alter both self-declared event and context consistently; the canonical
    # source observation is still independent authority for this generation.
    payload["discoveryContext"]["observation"]["run_id"] = "foreign-run"
    payload["discoveryEvents"][2]["payload"]["run_id"] = "foreign-run"
    conn.execute("UPDATE job_events SET payload_json=? WHERE event_type='ArchivedSmartPostingPrepared'", (json.dumps(payload),))
    conn.commit()
    with pytest.raises(RuntimeError, match="canonical source records"):
        smart_recover(conn)
    assert conn.execute("SELECT consumed_at FROM posting_triage").fetchone()[0] is None
    assert conn.execute("SELECT count(*) FROM posting_snapshot_sets").fetchone()[0] == 0


def test_smart_snapshot_same_capture_resumes_after_last_admission_slot(conn, monkeypatch):
    from jobctrl.domain.enrichment.snapshot_use_case import CapturePostingSnapshotUseCase
    from jobctrl.infrastructure.discovery.execution_result_plan import freeze_result_plan
    from jobctrl.infrastructure.discovery.result_budget import DiscoveryResultBudget
    from tests.smart_posting_fakes import PostingModel

    capture(conn, "1", source="smart_extract:synthetic")
    model = PostingModel()
    smart_models(monkeypatch, model)
    execution = DiscoveryExecutionRef("local", "owned-limited-recovery", "owned-run")
    freeze_result_plan(conn, execution, limit=1, source_limits={"smart_extract:synthetic": 1}, bounded=True)
    budget = DiscoveryResultBudget(conn, execution, limit=1, start_count=0, source_limits={"smart_extract:synthetic": 1})
    original = CapturePostingSnapshotUseCase.execute

    def fail(*_args, **_kwargs):
        raise RuntimeError("synthetic last-slot snapshot failure")

    monkeypatch.setattr(CapturePostingSnapshotUseCase, "execute", fail)
    with pytest.raises(RuntimeError, match="last-slot"):
        smart_recover(conn, discovery_execution=execution, result_budget=budget, limit=1)
    assert budget.run_exhausted() and budget.source_exhausted("smart_extract:synthetic")
    monkeypatch.setattr(CapturePostingSnapshotUseCase, "execute", original)
    capture(conn, "2", source="smart_extract:synthetic")
    from jobctrl.infrastructure.discovery.smart_postings import SmartPostingIntake

    def unexpected_prepare(*_args, **_kwargs):
        raise AssertionError("exhausted unprepared capture must not fetch or qualify another posting")

    monkeypatch.setattr(SmartPostingIntake, "prepare", unexpected_prepare)
    monkeypatch.setattr("jobctrl.infrastructure.discovery.live_browser.prefer_live_browser", unexpected_prepare)
    assert smart_recover(conn, discovery_execution=execution, result_budget=budget, limit=0)["existing"] == 1
    assert len(model.calls) == 3
    assert conn.execute("SELECT count(*) FROM jobs").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM job_events WHERE event_type='DiscoveryNewJobAdmitted'").fetchone()[0] == 1
    assert conn.execute("SELECT consumed_at FROM posting_triage WHERE listing_id='1'").fetchone()[0] is not None
    assert conn.execute("SELECT consumed_at FROM posting_triage WHERE listing_id='2'").fetchone()[0] is None
