"""Owner-scoped recovery for tailor and cover activity exhaustion."""

from __future__ import annotations

import sqlite3
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl.database import init_db
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials.value_objects import ArtifactStatus
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.preparation_recovery import (
    CancelPreparationStateInput,
    RecoverPreparationStateInput,
    assert_material_activity_commit_allowed,
    cancel_preparation_state_rows,
    recover_preparation_state_rows,
)
from jobctrl.materials.activities import _run_selected_material_jobs
from jobctrl.state import ensure_job_stage_rows, set_stage_state


_STARTED_AT = "2026-08-04T19:00:00+00:00"


def _seed_owned_stage(
    conn: sqlite3.Connection,
    suffix: int,
    *,
    stage: str,
    workflow_id: str,
    attempt_count: int = 0,
    metadata: dict[str, object] | None = None,
) -> str:
    job_id = str(canonical_job_id(f"00000000-0000-4000-8000-{suffix:012d}"))
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, site, strategy, discovered_at
        ) VALUES ('local', ?, ?, 'Synthetic role', 'Synthetic company',
                  'synthetic', 'chaos', ?)
        """,
        (job_id, f"https://example.test/materials/{suffix}", _STARTED_AT),
    )
    ensure_job_stage_rows(
        conn,
        canonical_job_id(job_id),
        tenant_id=LOCAL_TENANT,
        discovered_at=_STARTED_AT,
    )
    set_stage_state(
        conn,
        canonical_job_id(job_id),
        stage,
        "running",
        tenant_id=LOCAL_TENANT,
        attempt_count=attempt_count,
        started_at=_STARTED_AT,
        metadata={"activityOwner": workflow_id, **(metadata or {})},
        validate_transition=False,
    )
    conn.commit()
    return job_id


def test_tailor_recovery_accepts_only_a_newly_committed_retailor_generation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = init_db(tmp_path / "tailor-owner-recovery.db")
    restored_job = _seed_owned_stage(
        conn,
        1,
        stage="tailor",
        workflow_id="workflow-owned",
        attempt_count=1,
        metadata={
            "attemptCountBasis": "completed",
            "retailor": True,
            "priorApprovedGeneration": 2,
        },
    )
    failed_job = _seed_owned_stage(
        conn,
        2,
        stage="tailor",
        workflow_id="workflow-owned",
        metadata={
            "attemptCountBasis": "completed",
            "retailor": True,
            "priorApprovedGeneration": 3,
        },
    )
    generations = {restored_job: 3, failed_job: 3}
    repository = SimpleNamespace(
        load_current_approved=lambda _tenant, job_id: SimpleNamespace(
            is_resume_approved=True,
            generation=generations[str(job_id)],
        )
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.materials.SqliteMaterialsRepository",
        lambda _conn: repository,
    )

    result = recover_preparation_state_rows(
        conn,
        RecoverPreparationStateInput(
            tenant_id="local",
            workflow_id="workflow-owned",
            stage="tailor",
        ),
    )

    assert (result.restored, result.failed) == (1, 1)
    states = {
        row["job_id"]: (row["state"], row["attempt_count"])
        for row in conn.execute(
            "SELECT job_id, state, attempt_count FROM job_stage_states "
            "WHERE stage = 'tailor'"
        ).fetchall()
    }
    assert states[restored_job] == ("succeeded", 2)
    assert states[failed_job] == ("failed", 1)


@pytest.mark.parametrize("stage", ("tailor", "cover"))
def test_material_recovery_marks_fifth_interrupted_execution_exhausted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    stage: str,
) -> None:
    conn = init_db(tmp_path / f"{stage}-owner-exhausted.db")
    job_id = _seed_owned_stage(
        conn,
        20 if stage == "tailor" else 21,
        stage=stage,
        workflow_id="workflow-owned",
        attempt_count=4,
        metadata={"attemptCountBasis": "completed"},
    )
    repository = SimpleNamespace(load_current_approved=lambda *_args: None)
    monkeypatch.setattr(
        "jobctrl.infrastructure.materials.SqliteMaterialsRepository",
        lambda _conn: repository,
    )

    result = recover_preparation_state_rows(
        conn,
        RecoverPreparationStateInput(
            tenant_id="local",
            workflow_id="workflow-owned",
            stage=stage,
        ),
    )

    assert (result.restored, result.failed) == (0, 1)
    row = conn.execute(
        "SELECT state, attempt_count, retryable, next_action "
        "FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = ?",
        (job_id, stage),
    ).fetchone()
    assert tuple(row) == (
        "exhausted",
        5,
        0,
        f"retry {stage} --reset-attempts",
    )
    event = conn.execute(
        "SELECT event_type FROM job_events WHERE tenant_id = 'local' "
        "AND job_id = ? AND stage = ? ORDER BY event_id DESC LIMIT 1",
        (job_id, stage),
    ).fetchone()
    assert event["event_type"] == "StageExhausted"


def test_cover_recovery_reuses_committed_cover_and_ignores_another_owner(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = init_db(tmp_path / "cover-owner-recovery.db")
    owned = _seed_owned_stage(
        conn,
        3,
        stage="cover",
        workflow_id="workflow-owned",
    )
    other = _seed_owned_stage(
        conn,
        4,
        stage="cover",
        workflow_id="workflow-other",
    )
    approved = SimpleNamespace(status=ArtifactStatus.APPROVED)
    repository = SimpleNamespace(
        load_current_approved=lambda _tenant, _job_id: SimpleNamespace(
            cover_letter=approved,
        )
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.materials.SqliteMaterialsRepository",
        lambda _conn: repository,
    )

    result = recover_preparation_state_rows(
        conn,
        RecoverPreparationStateInput(
            tenant_id="local",
            workflow_id="workflow-owned",
            stage="cover",
        ),
    )

    assert (result.restored, result.failed) == (1, 0)
    states = dict(conn.execute(
        "SELECT job_id, state FROM job_stage_states WHERE stage = 'cover'"
    ).fetchall())
    assert states[owned] == "succeeded"
    assert states[other] == "running"


def test_selected_material_fanout_stops_scheduling_after_cancellation() -> None:
    job_ids = tuple(
        canonical_job_id(f"10000000-0000-4000-8000-{index:012d}")
        for index in range(4)
    )
    cancel_event = threading.Event()
    first_wave_started = threading.Event()
    release_first_wave = threading.Event()
    lock = threading.Lock()
    started: list[str] = []

    def run_one(job_id) -> dict:
        with lock:
            started.append(str(job_id))
            if len(started) == 2:
                first_wave_started.set()
        assert release_first_wave.wait(timeout=5)
        if cancel_event.is_set():
            raise RuntimeError("in-flight material write fenced after cancellation")
        return {"status": "ok"}

    def run_batch() -> Exception | None:
        try:
            _run_selected_material_jobs(
                job_ids,
                workers=2,
                cancel_event=cancel_event,
                stage="tailor",
                run_one=run_one,
            )
        except Exception as exc:  # noqa: BLE001 - asserting cancellation boundary
            return exc
        return None

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(run_batch)
        assert first_wave_started.wait(timeout=5)
        cancel_event.set()
        release_first_wave.set()
        error = future.result(timeout=10)

    assert error is not None
    assert "cancel" in str(error)
    assert started == [str(job_ids[0]), str(job_ids[1])]


def test_material_cancellation_preserves_successor_owner_and_cancels_pending(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "material-cancel-owner.db")
    owned = _seed_owned_stage(
        conn,
        11,
        stage="cover",
        workflow_id="workflow-old",
    )
    successor = _seed_owned_stage(
        conn,
        12,
        stage="cover",
        workflow_id="workflow-successor",
    )
    pending = _seed_owned_stage(
        conn,
        13,
        stage="cover",
        workflow_id="workflow-old",
    )
    set_stage_state(
        conn,
        canonical_job_id(pending),
        "cover",
        "pending",
        tenant_id=LOCAL_TENANT,
        metadata={},
        validate_transition=False,
    )
    conn.commit()

    result = cancel_preparation_state_rows(
        conn,
        CancelPreparationStateInput(
            tenant_id="local",
            workflow_id="workflow-old",
            stage="cover",
            job_ids=(owned, successor, pending),
        ),
    )

    states = dict(
        conn.execute(
            "SELECT job_id, state FROM job_stage_states WHERE stage = 'cover'"
        ).fetchall()
    )
    assert result.canceled == 2
    assert result.restored == 0
    assert states[owned] == "canceled"
    assert states[pending] == "canceled"
    assert states[successor] == "running"
    with pytest.raises(RuntimeError, match="no longer owns"):
        assert_material_activity_commit_allowed(
            conn,
            tenant_id="local",
            job_id=successor,
            stage="cover",
            workflow_id="workflow-old",
        )


def test_material_cancellation_preserves_result_committed_before_cancel(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    conn = init_db(tmp_path / "material-cancel-committed.db")
    committed = _seed_owned_stage(
        conn,
        14,
        stage="cover",
        workflow_id="workflow-owned",
    )
    approved = SimpleNamespace(status=ArtifactStatus.APPROVED)
    repository = SimpleNamespace(
        load_current_approved=lambda _tenant, _job_id: SimpleNamespace(
            cover_letter=approved,
        )
    )
    monkeypatch.setattr(
        "jobctrl.infrastructure.materials.SqliteMaterialsRepository",
        lambda _conn: repository,
    )

    result = cancel_preparation_state_rows(
        conn,
        CancelPreparationStateInput(
            tenant_id="local",
            workflow_id="workflow-owned",
            stage="cover",
            job_ids=(committed,),
        ),
    )

    row = conn.execute(
        "SELECT state, metadata_json FROM job_stage_states "
        "WHERE tenant_id = 'local' AND job_id = ? AND stage = 'cover'",
        (committed,),
    ).fetchone()
    assert (result.canceled, result.restored) == (0, 1)
    assert row["state"] == "succeeded"
    assert "canceled_activity_preserved_committed_cover" in row["metadata_json"]
