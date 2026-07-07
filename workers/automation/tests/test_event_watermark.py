"""SqliteEventWatermarkRepository — round-trip + initial-zero behavior."""

from pathlib import Path

import pytest

from jobctrl.database import close_connection, init_db
from jobctrl.infrastructure.events.watermark import SqliteEventWatermarkRepository


def test_initial_watermark_is_zero(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        repo = SqliteEventWatermarkRepository(conn)
        assert repo.get("scoring_projection") == 0
    finally:
        close_connection(db_path)


def test_set_then_get_roundtrip(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        repo = SqliteEventWatermarkRepository(conn)
        repo.set("scoring_projection", 42)
        assert repo.get("scoring_projection") == 42
    finally:
        close_connection(db_path)


def test_set_overwrites_existing_watermark(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        repo = SqliteEventWatermarkRepository(conn)
        repo.set("apply_projection", 7)
        repo.set("apply_projection", 11)
        assert repo.get("apply_projection") == 11
    finally:
        close_connection(db_path)


def test_per_projection_isolation(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        repo = SqliteEventWatermarkRepository(conn)
        repo.set("a", 5)
        repo.set("b", 9)
        assert repo.get("a") == 5
        assert repo.get("b") == 9
        assert repo.get("c") == 0
    finally:
        close_connection(db_path)


def test_negative_event_id_rejected(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        repo = SqliteEventWatermarkRepository(conn)
        with pytest.raises(ValueError):
            repo.set("bad", -1)
    finally:
        close_connection(db_path)


def test_set_is_monotonic_never_regresses(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        repo = SqliteEventWatermarkRepository(conn)
        repo.set("scoring_projection", 10)
        # A backwards write must be ignored — the watermark never regresses.
        repo.set("scoring_projection", 5)
        assert repo.get("scoring_projection") == 10
        # Equal is a no-op; a forward write advances.
        repo.set("scoring_projection", 10)
        assert repo.get("scoring_projection") == 10
        repo.set("scoring_projection", 15)
        assert repo.get("scoring_projection") == 15
    finally:
        close_connection(db_path)


def test_deferred_set_does_not_autocommit(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        repo = SqliteEventWatermarkRepository(conn)
        repo.set("scoring_projection", 5)
        # A deferred write leaves the transaction open for the outer owner
        # to flush; rolling back reverts it so the watermark is unchanged.
        repo.set("scoring_projection", 9, commit=False)
        assert conn.in_transaction
        conn.rollback()
        assert repo.get("scoring_projection") == 5
    finally:
        close_connection(db_path)


def test_default_set_commits_immediately(tmp_path: Path) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    try:
        repo = SqliteEventWatermarkRepository(conn)
        repo.set("scoring_projection", 7)
        # Default set() commits, so there is nothing pending to roll back.
        conn.rollback()
        assert repo.get("scoring_projection") == 7
    finally:
        close_connection(db_path)
