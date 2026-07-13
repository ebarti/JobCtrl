from __future__ import annotations

import asyncio
import sqlite3
from datetime import UTC, datetime

import pytest

from jobctrl import cli


def test_worker_heartbeat_loop_retries_after_iteration_failure(monkeypatch):
    calls: list[tuple[str, str, datetime | None, int | None]] = []

    class StopLoop(BaseException):
        pass

    def iteration(
        task_queue: str,
        worker_id: str,
        *,
        worker_started_at: datetime | None = None,
        max_concurrent_activities: int | None = None,
    ) -> tuple[int, int]:
        calls.append((task_queue, worker_id, worker_started_at, max_concurrent_activities))
        if len(calls) == 1:
            raise sqlite3.OperationalError("database is locked")
        if len(calls) == 3:
            raise StopLoop
        return (0, 0)

    async def no_sleep(_seconds: float) -> None:
        return None

    started_at = datetime(2026, 6, 6, 13, 40, tzinfo=UTC)
    monkeypatch.setattr(cli, "_worker_heartbeat_iteration", iteration)
    monkeypatch.setattr(cli.asyncio, "sleep", no_sleep)

    with pytest.raises(StopLoop):
        asyncio.run(
            cli._worker_heartbeat_loop(
                "jobctrl-default",
                "worker-test",
                worker_started_at=started_at,
                max_concurrent_activities=7,
                interval_seconds=0,
            )
        )

    assert calls == [
        ("jobctrl-default", "worker-test", started_at, 7),
        ("jobctrl-default", "worker-test", started_at, 7),
        ("jobctrl-default", "worker-test", started_at, 7),
    ]
