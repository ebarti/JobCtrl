"""Exercise real TypeScript/Python fold ordering on a disposable exact-v9 DB.

Run explicitly with both repository toolchains installed:
uv --project workers/automation run --no-sync --locked python \
    workers/automation/tests/projection_cross_runtime_fixture.py

Ordinary per-language suites remain independent of the other toolchain.
"""

from __future__ import annotations

import sqlite3
import os
import subprocess
import tempfile
from pathlib import Path

# Bind the application sandbox before importing modules that cache paths.
_APP_SANDBOX = tempfile.TemporaryDirectory(prefix="jobctrl-projection-fixture-app-")
os.environ["JOBCTRL_DIR"] = _APP_SANDBOX.name
os.environ["JOBCTRL_ENV_FILE"] = str(Path(_APP_SANDBOX.name) / ".env")
os.environ["JOBCTRL_RUNTIME_MODE"] = "source"
os.environ["LANGFUSE_DISABLE"] = "1"

from jobctrl.database import close_connection, init_db  # noqa: E402
from jobctrl.domain.identifiers import JobId  # noqa: E402
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder  # noqa: E402
from jobctrl.state import record_job_event  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[3]
JOB_ID = JobId("00000000-0000-4000-8000-000000000101")


def _typescript_refresh(db_path: Path) -> None:
    subprocess.run(
        [
            "corepack", "pnpm", "--filter", "@jobctrl/api", "exec", "tsx",
            "test/support/refresh-projections.ts", str(db_path),
        ],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )


def _statuses(conn: sqlite3.Connection) -> tuple[str, str]:
    return (
        conn.execute("SELECT status FROM workflow_run_projections").fetchone()[0],
        conn.execute("SELECT status FROM apply_run_projections").fetchone()[0],
    )


def _snapshot(conn: sqlite3.Connection) -> dict[str, list[tuple]]:
    return {
        table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]
        for table in (
            "workflow_run_projections", "apply_run_projections",
            "job_list_projections", "job_detail_projections", "event_watermarks",
        )
    }


def run_scenario(*, typescript_first: bool, legacy_cursor: bool) -> None:
    with tempfile.TemporaryDirectory(prefix="jobctrl-projection-cross-runtime-") as directory:
        db_path = Path(directory) / "jobctrl.db"
        conn = init_db(db_path)
        try:
            conn.execute(
                "INSERT INTO jobs (tenant_id, job_id, url, title, description) "
                "VALUES ('local', ?, 'https://example.com/fixture', 'Fixture', 'Fixture')",
                (str(JOB_ID),),
            )
            record_job_event(conn, None, "workflow", "WorkflowStarted", payload={
                "workflowId": "fixture-workflow", "workflowType": "DiscoverWorkflow",
                "inputSummary": {}, "startedAt": "2026-09-01T00:00:00Z",
                "temporalRunId": "fixture-run",
            })
            record_job_event(conn, JOB_ID, "apply", "ApplyRunStarted", payload={
                "run_id": "fixture-apply", "started_at": "2026-09-01T00:00:00Z",
                "dry_run": False,
            })
            conn.commit()
            builder = ProjectionBuilder(conn_factory=lambda: conn)
            builder.refresh()
            _typescript_refresh(db_path)
            assert _statuses(conn) == ("in_progress", "starting")

            record_job_event(conn, None, "workflow", "WorkflowCompleted", payload={
                "workflowId": "fixture-workflow", "workflowType": "DiscoverWorkflow",
                "status": "succeeded", "finishedAt": "2026-09-01T00:01:00Z",
                "durationMs": 60_000,
            })
            record_job_event(conn, JOB_ID, "apply", "ApplicationSubmitted", payload={
                "run_id": "fixture-apply", "finished_at": "2026-09-01T00:01:00Z",
                "duration_ms": 60_000,
            })
            # Reproduce an existing installation whose shared cursor consumed
            # terminal events but whose already-present run rows stayed open.
            if legacy_cursor:
                conn.execute("DELETE FROM event_watermarks")
            conn.execute(
                "INSERT INTO event_watermarks (projection_name, last_event_id, updated_at) "
                "VALUES ('operations_projections', 4, '2026-09-01T00:01:00Z')"
            )
            # Legacy tenant IDs are opaque: these are legitimate older keys
            # for tenants named python:local and typescript:local.
            legacy_rows = [
                ("operations_projections", 4, "2026-09-01T00:01:00Z"),
                ("operations_projections:python:local", 10_000, "2026-08-31T00:00:00Z"),
                ("operations_projections:typescript:local", 20_000, "2026-08-31T00:00:00Z"),
            ]
            conn.executemany(
                "INSERT OR REPLACE INTO event_watermarks (projection_name, last_event_id, updated_at) "
                "VALUES (?, ?, ?)",
                legacy_rows[1:],
            )
            conn.commit()
            if typescript_first:
                _typescript_refresh(db_path)
                assert _statuses(conn) == ("in_progress", "starting")
                python_cursor = conn.execute(
                    "SELECT last_event_id FROM event_watermarks "
                    "WHERE projection_name = 'python:operations_projections:local'"
                ).fetchone()
                assert (None if python_cursor is None else python_cursor[0]) == (None if legacy_cursor else 2)
                builder.refresh()
            else:
                builder.refresh()
                assert _statuses(conn) == ("succeeded", "succeeded")
                _typescript_refresh(db_path)
            assert _statuses(conn) == ("succeeded", "succeeded")
            assert [tuple(row) for row in conn.execute(
                "SELECT projection_name, last_event_id FROM event_watermarks ORDER BY projection_name"
            )] == [
                ("operations_projections", 4),
                ("operations_projections:python:local", 10_000),
                ("operations_projections:typescript:local", 20_000),
                ("python:operations_projections:local", 4),
                ("typescript:operations_projections:local", 4),
            ]
            for legacy_row in legacy_rows:
                assert tuple(conn.execute(
                    "SELECT * FROM event_watermarks WHERE projection_name = ?", (legacy_row[0],)
                ).fetchone()) == legacy_row
            settled = _snapshot(conn)
            _typescript_refresh(db_path)
            builder.refresh()
            assert _snapshot(conn) == settled
            assert not conn.in_transaction
        finally:
            close_connection(db_path)


if __name__ == "__main__":
    for legacy_cursor in (True, False):
        for typescript_first in (True, False):
            run_scenario(typescript_first=typescript_first, legacy_cursor=legacy_cursor)
    print("PASS: opaque legacy-tenant cursor isolation, terminal replay, both runtime orders, repeated refreshes")
