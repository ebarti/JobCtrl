"""SqliteEventWatermarkRepository — round-trip + initial-zero behavior."""

from pathlib import Path

import pytest

from jobhunter.database import close_connection, init_db
from jobhunter.infrastructure.events.watermark import SqliteEventWatermarkRepository


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
