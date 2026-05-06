"""Tests for CancelStageUseCase and RetryStageUseCase.

Exercises load -> transition -> save composition, error handling,
and StageNotFoundError.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.domain.pipeline.use_cases import (
    CancelStageUseCase,
    RetryStageUseCase,
    StageNotFoundError,
)
from jobhunter.domain.pipeline_types import (
    Canceled,
    Exhausted,
    Failed,
    Pending,
    Queued,
    Running,
    Stage,
)
from jobhunter.domain.tenant import LOCAL_TENANT
from jobhunter.infrastructure.pipeline.sqlite_repository import SqlitePipelineStateRepository
from jobhunter.state import ensure_job_stage_rows


def _insert_job(conn, url: str = "https://example.com/job") -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO jobs (url, title, site, strategy, discovered_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (url, "Platform Engineer", "ExampleCo", "test", "2026-04-29T10:00:00+00:00"),
    )
    conn.commit()


@pytest.fixture()
def db(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_job(conn)
    ensure_job_stage_rows(conn, "https://example.com/job", discovered_at="2026-04-29T10:00:00+00:00")
    conn.commit()
    yield conn
    close_connection(db_path)


JOB_URL = "https://example.com/job"


# ---------------------------------------------------------------------------
# CancelStageUseCase
# ---------------------------------------------------------------------------


class TestCancelStageUseCase:
    def test_cancel_from_queued(self, db):
        """Happy path: Queued -> Canceled."""
        repo = SqlitePipelineStateRepository(db)
        agg = repo.load(LOCAL_TENANT, JOB_URL)
        assert agg is not None
        agg.set_stage_state(Stage.Enrich, Queued(queued_at="2026-05-01T00:00:00Z"))
        repo.save(agg)

        uc = CancelStageUseCase(repo)
        result = uc.execute(
            LOCAL_TENANT, JOB_URL, "enrich",
            canceled_at="2026-05-01T00:01:00Z",
            reason="user requested",
        )
        assert result == "canceled"

        reloaded = repo.load(LOCAL_TENANT, JOB_URL)
        assert reloaded is not None
        state = reloaded.get_stage_state(Stage.Enrich)
        assert isinstance(state, Canceled)
        assert state.canceled_at == "2026-05-01T00:01:00Z"
        assert state.reason == "user requested"

    def test_cancel_from_running(self, db):
        """Happy path: Running -> Canceled."""
        repo = SqlitePipelineStateRepository(db)
        agg = repo.load(LOCAL_TENANT, JOB_URL)
        assert agg is not None
        agg.set_stage_state(Stage.Enrich, Running(attempt_count=1, started_at="2026-05-01T00:00:00Z"))
        repo.save(agg)

        uc = CancelStageUseCase(repo)
        result = uc.execute(LOCAL_TENANT, JOB_URL, "enrich", canceled_at="2026-05-01T00:05:00Z")
        assert result == "canceled"

        reloaded = repo.load(LOCAL_TENANT, JOB_URL)
        assert reloaded is not None
        assert isinstance(reloaded.get_stage_state(Stage.Enrich), Canceled)

    def test_cancel_from_pending_rejected(self, db):
        """Pending -> Canceled is not a valid transition."""
        repo = SqlitePipelineStateRepository(db)
        uc = CancelStageUseCase(repo)

        with pytest.raises(ValueError, match="not allowed"):
            uc.execute(LOCAL_TENANT, JOB_URL, "enrich")

    def test_cancel_nonexistent_job_raises(self, db):
        """StageNotFoundError when job doesn't exist."""
        repo = SqlitePipelineStateRepository(db)
        uc = CancelStageUseCase(repo)

        with pytest.raises(StageNotFoundError):
            uc.execute(LOCAL_TENANT, "https://nonexistent.example.com/job", "enrich")


# ---------------------------------------------------------------------------
# RetryStageUseCase
# ---------------------------------------------------------------------------


class TestRetryStageUseCase:
    def test_retry_from_failed(self, db):
        """Happy path: Failed -> Pending."""
        repo = SqlitePipelineStateRepository(db)
        agg = repo.load(LOCAL_TENANT, JOB_URL)
        assert agg is not None
        agg.set_stage_state(
            Stage.Enrich,
            Failed(attempt_count=2, max_attempts=5, error_code="TIMEOUT", error_message="timed out"),
        )
        repo.save(agg)

        uc = RetryStageUseCase(repo)
        result = uc.execute(LOCAL_TENANT, JOB_URL, "enrich")
        assert result == "pending"

        reloaded = repo.load(LOCAL_TENANT, JOB_URL)
        assert reloaded is not None
        state = reloaded.get_stage_state(Stage.Enrich)
        assert isinstance(state, Pending)
        assert state.attempt_count == 2  # preserved

    def test_retry_from_exhausted_with_reset_attempts(self, db):
        """Exhausted -> Pending with reset_attempts=True zeroes the count."""
        repo = SqlitePipelineStateRepository(db)
        agg = repo.load(LOCAL_TENANT, JOB_URL)
        assert agg is not None
        agg.set_stage_state(
            Stage.Tailor,
            Exhausted(attempt_count=5, max_attempts=5, error_code="MAX", error_message="max reached"),
        )
        repo.save(agg)

        uc = RetryStageUseCase(repo)
        result = uc.execute(LOCAL_TENANT, JOB_URL, "tailor", reset_attempts=True)
        assert result == "pending"

        reloaded = repo.load(LOCAL_TENANT, JOB_URL)
        assert reloaded is not None
        state = reloaded.get_stage_state(Stage.Tailor)
        assert isinstance(state, Pending)
        assert state.attempt_count == 0

    def test_retry_from_canceled(self, db):
        """Canceled -> Pending."""
        repo = SqlitePipelineStateRepository(db)
        agg = repo.load(LOCAL_TENANT, JOB_URL)
        assert agg is not None
        agg.set_stage_state(
            Stage.Enrich,
            Canceled(canceled_at="2026-05-01T00:01:00Z", reason="user canceled"),
        )
        repo.save(agg)

        uc = RetryStageUseCase(repo)
        result = uc.execute(LOCAL_TENANT, JOB_URL, "enrich")
        assert result == "pending"

        reloaded = repo.load(LOCAL_TENANT, JOB_URL)
        assert reloaded is not None
        assert isinstance(reloaded.get_stage_state(Stage.Enrich), Pending)

    def test_retry_from_succeeded_rejected(self, db):
        """Succeeded -> Pending via Reset is not allowed (must go through Stale first)."""
        repo = SqlitePipelineStateRepository(db)
        uc = RetryStageUseCase(repo)

        # discover is already in succeeded from ensure_job_stage_rows
        with pytest.raises(ValueError, match="not allowed"):
            uc.execute(LOCAL_TENANT, JOB_URL, "discover")

    def test_retry_nonexistent_job_raises(self, db):
        """StageNotFoundError when job doesn't exist."""
        repo = SqlitePipelineStateRepository(db)
        uc = RetryStageUseCase(repo)

        with pytest.raises(StageNotFoundError):
            uc.execute(LOCAL_TENANT, "https://nonexistent.example.com/job", "enrich")
