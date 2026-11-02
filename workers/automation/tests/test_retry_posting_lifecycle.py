"""Owned offline probe of overlapping snapshot producers and retry selection."""

import pytest

from jobctrl.domain.enrichment import snapshot_use_case
from jobctrl.domain.enrichment.snapshot_services import ContentAcquisitionResult
from jobctrl.domain.enrichment.snapshot_set import PostingSnapshotSet
from jobctrl.domain.enrichment.snapshot_value_objects import ActiveState, QuarantineReason, SnapshotConfidence
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.enrichment.sqlite_repository import SqlitePostingSnapshotSetRepository
from jobctrl.pipeline.retry import RetrySelectionChanged, reset_retry_stages, retry_selection_fingerprint
from tests.test_stage_retry_consistency import JOB, PEER, URL, _rows
from tests.test_stage_retry_consistency import conn as _conn

conn = _conn


def test_overlapping_capture_recreates_selected_lifecycle_and_snapshot(conn, monkeypatch):
    now = "2026-01-01T00:00:00+00:00"
    monkeypatch.setattr(snapshot_use_case, "_utc_now", lambda: now)
    conn.execute("UPDATE job_stage_states SET retryable=1 WHERE job_id=? AND stage='enrich'", (JOB,))
    repo = SqlitePostingSnapshotSetRepository(conn)
    initial = PostingSnapshotSet.empty(tenant_id=LOCAL_TENANT, job_id=canonical_job_id(JOB), updated_at=now)
    initial, _ = initial.mark_active_state(active_state=ActiveState.ACTIVE, verified_at=now)
    repo.save(initial)
    targets = [(PEER, "score"), (JOB, "enrich")]
    captured = {}

    def result(state):
        return ContentAcquisitionResult(
            ok=False, extraction_tier="synthetic", confidence=SnapshotConfidence.LOW,
            quarantine_reason=QuarantineReason.POSTING_INACTIVE, active_state=state,
            verification_method="synthetic", error_class="SYNTHETIC", error_message="synthetic failure",
        )

    def execute(acquisition):
        return snapshot_use_case.CapturePostingSnapshotUseCase(
            snapshot_repository=repo, acquisition_service=acquisition,
        ).execute(
            tenant_id=LOCAL_TENANT, job_id=canonical_job_id(JOB), url=URL, source_id="synthetic",
            promote_to_job_enrichment=False,
        )

    class Immediate:
        def __init__(self, state):
            self.state = state

        def acquire(self, **_kwargs):
            return result(self.state)

    class Overlapping:
        def acquire(self, **_kwargs):
            # The outer use case has already loaded the initial aggregate.
            # A peer commits a matching active failure before selection.
            assert not execute(Immediate(ActiveState.ACTIVE)).active_state_changed
            captured["row"] = tuple(conn.execute(
                "SELECT snapshot_set_json,latest_active_state,latest_snapshot_version,updated_at "
                "FROM posting_snapshot_sets WHERE tenant_id='local' AND job_id=?", (JOB,),
            ).fetchone())
            captured["fingerprints"] = {
                (job_id, stage): retry_selection_fingerprint(conn, "local", job_id, stage, include_job_lifecycle=True)
                for job_id, stage in targets
            }
            # Another real producer then closes the posting. The outer
            # producer's previously loaded aggregate will overwrite it.
            assert execute(Immediate(ActiveState.CLOSED)).active_state_changed
            return result(ActiveState.ACTIVE)

    outer = execute(Overlapping())
    assert not outer.ok and not outer.active_state_changed
    assert tuple(conn.execute(
        "SELECT snapshot_set_json,latest_active_state,latest_snapshot_version,updated_at "
        "FROM posting_snapshot_sets WHERE tenant_id='local' AND job_id=?", (JOB,),
    ).fetchone()) == captured["row"]
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE job_id=? AND event_type='JobActiveStateChanged'", (JOB,)).fetchone()[0] == 0

    tables = ("job_enrichments", "job_materials", "job_materials_artifacts", "job_stage_states", "job_events", "posting_snapshot_sets")
    before = {table: _rows(conn, table) for table in tables}
    with pytest.raises(RetrySelectionChanged):
        reset_retry_stages(
            conn, targets, only_failed=True, expected_fingerprints=captured["fingerprints"],
            require_selected_failed_stage=True,
        )
    assert {table: _rows(conn, table) for table in tables} == before
    assert not conn.in_transaction
