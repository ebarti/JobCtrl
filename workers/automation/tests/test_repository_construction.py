"""Constructing an adapter must not change its caller's transaction."""

from __future__ import annotations

import sqlite3
from collections.abc import Callable
from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.infrastructure.discovery.sqlite_run_repository import SqliteDiscoveryRunRepository
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.materials.sqlite_repository import (
    SqliteLearningRecommendationReviewRepository,
    SqliteTailoringPolicyRepository,
)
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.infrastructure.projections.sqlite_projection_store import SqliteProjectionStore
from jobctrl.infrastructure.scoring.sqlite_repository import SqliteScoringPolicyRepository


@pytest.mark.parametrize(
    "construct",
    [
        pytest.param(SqliteDiscoveryRunRepository, id="discovery-run"),
        pytest.param(SqliteLearningRecommendationReviewRepository, id="learning-review"),
        pytest.param(SqliteTailoringPolicyRepository, id="tailoring-policy"),
        pytest.param(SqliteScoringPolicyRepository, id="scoring-policy"),
        pytest.param(SqliteProjectionStore, id="projection-store"),
        pytest.param(
            lambda conn: SqliteProfileRepository(conn, publisher=InProcessEventBus()),
            id="profile",
        ),
        pytest.param(
            lambda conn: ProjectionBuilder(conn_factory=lambda: conn),
            id="projection-builder",
        ),
    ],
)
def test_constructor_preserves_caller_rollback(
    tmp_path: Path,
    construct: Callable[[sqlite3.Connection], object],
) -> None:
    db_path = tmp_path / "jobctrl.db"
    conn = init_db(db_path)
    try:
        conn.execute("CREATE TEMP TABLE caller_work (value INTEGER)")
        conn.commit()
        conn.execute("INSERT INTO caller_work VALUES (1)")
        statements: list[str] = []
        conn.set_trace_callback(statements.append)

        construct(conn)

        conn.set_trace_callback(None)
        assert statements == [], "Schema initialization belongs to explicit database setup"
        assert conn.in_transaction, "Construction must not commit the caller's work"
        conn.rollback()
        assert conn.execute("SELECT COUNT(*) FROM caller_work").fetchone()[0] == 0
    finally:
        close_connection(db_path)
