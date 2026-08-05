"""Owner-scoped recovery for tailor and cover activity exhaustion."""

from __future__ import annotations

import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl.database import init_db
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials.value_objects import ArtifactStatus
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.preparation_recovery import (
    RecoverPreparationStateInput,
    recover_preparation_state_rows,
)
from jobctrl.state import ensure_job_stage_rows, set_stage_state


_STARTED_AT = "2026-08-04T19:00:00+00:00"


def _seed_owned_stage(
    conn: sqlite3.Connection,
    suffix: int,
    *,
    stage: str,
    workflow_id: str,
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
        metadata={"retailor": True, "priorApprovedGeneration": 2},
    )
    failed_job = _seed_owned_stage(
        conn,
        2,
        stage="tailor",
        workflow_id="workflow-owned",
        metadata={"retailor": True, "priorApprovedGeneration": 3},
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
    states = dict(conn.execute(
        "SELECT job_id, state FROM job_stage_states WHERE stage = 'tailor'"
    ).fetchall())
    assert states[restored_job] == "succeeded"
    assert states[failed_job] == "failed"


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
