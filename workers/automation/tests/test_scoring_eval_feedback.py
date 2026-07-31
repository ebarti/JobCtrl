from __future__ import annotations

import json
import sqlite3
from collections.abc import Sequence
from typing import Any

from jobctrl import database as database_module
from jobctrl.apply import launcher as launcher_module
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.infrastructure.scoring import collect_feedback_signals, rank_jobs_with_feedback

_TENANT_A = "tenant-a"
_TENANT_B = "tenant-b"
_JOB_A = canonical_job_id("a0000000-0000-4000-8000-000000000001")
_JOB_B = canonical_job_id("a0000000-0000-4000-8000-000000000002")


def _connection() -> sqlite3.Connection:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE job_scores (
          tenant_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          fit_score INTEGER NOT NULL,
          breakdown_json TEXT NOT NULL,
          keywords_json TEXT NOT NULL,
          scored_at TEXT NOT NULL,
          correction_json TEXT,
          trace_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (tenant_id, job_id, version)
        );
        CREATE TABLE job_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          tenant_id TEXT NOT NULL,
          job_id TEXT,
          event_type TEXT NOT NULL,
          message TEXT
        );
        """
    )
    return conn


def _insert_corrected_score(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    job_id: str,
) -> None:
    conn.execute(
        """INSERT INTO job_scores (
          tenant_id, job_id, version, fit_score, breakdown_json, keywords_json,
          scored_at, correction_json, trace_json
        ) VALUES (?, ?, 2, 9, '{}', '[]', ?, ?, ?)""",
        (
            tenant_id,
            job_id,
            "2026-05-14T10:00:00Z",
            json.dumps(
                {
                    "corrected_fit_score": 9,
                    "rationale": "Better leadership fit.",
                }
            ),
            json.dumps(
                {
                    "correction_history": [
                        {"original_score": 6, "corrected_score": 9}
                    ]
                }
            ),
        ),
    )


def test_feedback_signals_use_canonical_corrections_and_actions_transparently() -> None:
    conn = _connection()
    _insert_corrected_score(
        conn,
        tenant_id=_TENANT_A,
        job_id=str(_JOB_A),
    )
    conn.execute(
        """
        INSERT INTO job_events (tenant_id, job_id, event_type, message)
        VALUES (?, ?, 'StageSkipped', 'Skipped after review.')
        """,
        (_TENANT_A, str(_JOB_B)),
    )

    signals = collect_feedback_signals(conn)
    ranked = rank_jobs_with_feedback(
        {
            (_TENANT_A, str(_JOB_A)): 7.5,
            (_TENANT_A, str(_JOB_B)): 8.0,
        },
        signals,
    )

    assert [signal.kind for signal in signals] == [
        "score_correction",
        "StageSkipped",
    ]
    assert (ranked[0].tenant_id, ranked[0].job_id) == (
        _TENANT_A,
        str(_JOB_A),
    )
    assert ranked[0].feedback_adjustment > 0
    assert "Better leadership fit" in ranked[0].evidence[0]
    assert ranked[1].feedback_adjustment < 0
    assert "Skipped after review" in ranked[1].evidence[0]


def test_feedback_ordering_isolates_same_job_id_across_tenants() -> None:
    conn = _connection()
    shared_job_id = str(_JOB_A)
    shared_url = "https://example.com/shared"
    _insert_corrected_score(
        conn,
        tenant_id=_TENANT_A,
        job_id=shared_job_id,
    )
    conn.execute(
        """
        INSERT INTO job_events (tenant_id, job_id, event_type, message)
        VALUES (?, ?, 'StageSkipped', 'Tenant B skipped this job.')
        """,
        (_TENANT_B, shared_job_id),
    )
    rows = conn.execute(
        """
        SELECT ? AS tenant_id, ? AS job_id, ? AS url,
               7.5 AS js_fit_score, NULL AS fit_score
        UNION ALL
        SELECT ?, ?, ?, 8.0, NULL
        """,
        (
            _TENANT_A,
            shared_job_id,
            shared_url,
            _TENANT_B,
            shared_job_id,
            shared_url,
        ),
    ).fetchall()

    ordered = database_module._order_rows_by_feedback(conn, rows)

    assert [
        (str(row["tenant_id"]), str(row["job_id"]))
        for row in ordered
    ] == [
        (_TENANT_A, shared_job_id),
        (_TENANT_B, shared_job_id),
    ]


class _RowsCursor:
    def __init__(self, rows: Sequence[sqlite3.Row]) -> None:
        self._rows = list(rows)

    def fetchall(self) -> list[sqlite3.Row]:
        return self._rows

    def fetchone(self) -> sqlite3.Row | None:
        return self._rows[0] if self._rows else None


class _AcquireConnection:
    """Delegate feedback reads while supplying the apply candidate projection."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        candidates: Sequence[sqlite3.Row],
    ) -> None:
        self._conn = conn
        self._candidates = candidates
        self.projected_canonical_identity = False

    def execute(
        self,
        sql: str,
        parameters: Sequence[Any] = (),
    ) -> sqlite3.Cursor | _RowsCursor:
        if "FROM jobs" in sql and "ORDER BY" in sql:
            self.projected_canonical_identity = (
                "jobs.tenant_id AS tenant_id" in sql
                and "jobs.job_id AS job_id" in sql
            )
            return _RowsCursor(self._candidates)
        if "FROM job_stage_states" in sql:
            return _RowsCursor([])
        return self._conn.execute(sql, parameters)

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()


def test_acquire_job_orders_multiple_candidates_by_canonical_feedback(
    monkeypatch,
) -> None:
    conn = _connection()
    _insert_corrected_score(
        conn,
        tenant_id=_TENANT_A,
        job_id=str(_JOB_A),
    )
    candidates = conn.execute(
        """
        SELECT ? AS tenant_id, ? AS job_id, 'https://example.com/a' AS url,
               'A' AS title, 'example' AS site,
               'https://example.com/a/apply' AS application_url,
               '/tmp/a.txt' AS tailored_resume_path,
               '/tmp/a.pdf' AS resume_pdf_path,
               'artifact-a' AS resume_pdf_artifact_id,
               1 AS materials_generation, 7.5 AS fit_score,
               7.5 AS js_fit_score, NULL AS location, NULL AS description,
               NULL AS full_description, NULL AS cover_letter_path,
               NULL AS applied_at, NULL AS apply_status, 0 AS apply_attempts
        UNION ALL
        SELECT ?, ?, 'https://example.com/b', 'B', 'example',
               'https://example.com/b/apply', '/tmp/b.txt', '/tmp/b.pdf',
               'artifact-b', 1, 8.0, 8.0, NULL, NULL, NULL, NULL, NULL, NULL, 0
        """,
        (
            _TENANT_A,
            str(_JOB_A),
            _TENANT_A,
            str(_JOB_B),
        ),
    ).fetchall()
    conn.commit()
    acquire_conn = _AcquireConnection(conn, candidates)

    monkeypatch.setattr(launcher_module, "get_connection", lambda: acquire_conn)
    monkeypatch.setattr(launcher_module, "_load_blocked", lambda: ([], []))
    monkeypatch.setattr(launcher_module, "ensure_job_stage_rows", lambda *_args: None)
    monkeypatch.setattr(launcher_module, "set_stage_state", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(launcher_module, "record_job_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(launcher_module, "_current_profile_version", lambda *_args, **_kwargs: 1)
    monkeypatch.setattr(
        launcher_module,
        "_latest_apply_review_decision",
        lambda *_args, **_kwargs: None,
    )

    selected = launcher_module.acquire_job(
        worker_id=1,
        run_ctx={"dry_run": True},
        approval_required=False,
    )

    assert acquire_conn.projected_canonical_identity is True
    assert selected is not None
    assert (selected["tenant_id"], selected["job_id"]) == (
        _TENANT_A,
        str(_JOB_A),
    )
