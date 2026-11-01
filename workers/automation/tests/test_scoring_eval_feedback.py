from __future__ import annotations

import json
import sqlite3
from collections.abc import Sequence
from typing import Any

from jobctrl.apply import launcher as launcher_module
from jobctrl.domain.identifiers import canonical_job_id

_TENANT_A = "tenant-a"
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
          stage TEXT,
          event_type TEXT NOT NULL,
          message TEXT,
          payload_json TEXT
        );
        CREATE TABLE job_materials_artifacts (
          tenant_id TEXT NOT NULL,
          job_id TEXT NOT NULL,
          generation INTEGER NOT NULL,
          artifact_type TEXT NOT NULL,
          artifact_id TEXT NOT NULL,
          path TEXT NOT NULL,
          metadata_json TEXT,
          status TEXT NOT NULL,
          superseded_at TEXT,
          PRIMARY KEY (tenant_id, job_id, generation, artifact_type)
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


class _RowsCursor:
    def __init__(self, rows: Sequence[sqlite3.Row]) -> None:
        self._rows = list(rows)

    def fetchall(self) -> list[sqlite3.Row]:
        return self._rows

    def fetchone(self) -> sqlite3.Row | None:
        return self._rows[0] if self._rows else None


class _AcquireConnection:
    """Supply the Apply candidate projection to the acquisition boundary."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        candidates: Sequence[sqlite3.Row],
    ) -> None:
        self._conn = conn
        self._candidates = candidates
        self.projected_canonical_identity = False

    @property
    def in_transaction(self) -> bool:
        return self._conn.in_transaction

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
        if sql.startswith("SELECT url FROM jobs"):
            return self._conn.execute("SELECT ? AS url", (self._candidates[0]["url"],))
        if "FROM job_stage_states" in sql:
            return _RowsCursor([])
        return self._conn.execute(sql, parameters)

    def commit(self) -> None:
        self._conn.commit()

    def rollback(self) -> None:
        self._conn.rollback()


def test_acquire_job_does_not_apply_unaccepted_feedback_to_candidate_order(
    monkeypatch,
    tmp_path,
    request,
) -> None:
    conn = _connection()
    request.addfinalizer(conn.close)
    _insert_corrected_score(
        conn,
        tenant_id=_TENANT_A,
        job_id=str(_JOB_A),
    )
    # Claim captures canonical material sources even for a dry run. Keep this
    # reader real while the candidate projection/availability ports stay isolated.
    paths = {}
    for name, job_id in (("a", _JOB_A), ("b", _JOB_B)):
        for artifact_type, suffix in (("tailored_resume", "txt"), ("resume_pdf", "pdf")):
            path = tmp_path / f"{name}.{suffix}"
            path.write_bytes(f"Owned synthetic material {name} {artifact_type}".encode())
            paths[name, suffix] = str(path)
            conn.execute(
                """INSERT INTO job_materials_artifacts (
                    tenant_id, job_id, generation, artifact_type, artifact_id, path, status
                ) VALUES (?, ?, 1, ?, ?, ?, 'approved')""",
                (
                    _TENANT_A, str(job_id), artifact_type,
                    f"artifact-{name}" if suffix == "pdf" else f"text-{name}", str(path),
                ),
            )
    candidates = conn.execute(
        """
        SELECT ? AS tenant_id, ? AS job_id, 'https://example.com/b' AS url,
               'B' AS title, 'example' AS site,
               'https://example.com/b/apply' AS application_url,
               ? AS tailored_resume_path,
               ? AS resume_pdf_path,
               'artifact-b' AS resume_pdf_artifact_id,
               1 AS materials_generation, 8.0 AS fit_score,
               8.0 AS js_fit_score, NULL AS location, NULL AS description,
               NULL AS full_description, NULL AS cover_letter_path,
               NULL AS applied_at, NULL AS apply_status, 0 AS apply_attempts
        UNION ALL
        SELECT ?, ?, 'https://example.com/a', 'A', 'example',
               'https://example.com/a/apply', ?, ?,
               'artifact-a', 1, 7.5, 7.5, NULL, NULL, NULL, NULL, NULL, NULL, 0
        """,
        (
            _TENANT_A,
            str(_JOB_B),
            paths["b", "txt"],
            paths["b", "pdf"],
            _TENANT_A,
            str(_JOB_A),
            paths["a", "txt"],
            paths["a", "pdf"],
        ),
    ).fetchall()
    conn.commit()
    acquire_conn = _AcquireConnection(conn, candidates)

    monkeypatch.setattr(launcher_module, "get_connection", lambda: acquire_conn)
    monkeypatch.setattr(launcher_module, "_load_blocked", lambda: ([], []))
    monkeypatch.setattr(
        launcher_module,
        "ensure_job_stage_rows",
        lambda *_args, **_kwargs: None,
    )
    monkeypatch.setattr(launcher_module, "set_stage_state", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(launcher_module, "record_job_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(launcher_module, "_current_profile_version", lambda *_args, **_kwargs: 1)
    monkeypatch.setattr(
        launcher_module,
        "_latest_apply_review_decision",
        lambda *_args, **_kwargs: None,
    )

    # This partial-row fixture tests feedback ordering; availability is a separate port.
    monkeypatch.setattr("jobctrl.enrichment.availability.require_fresh_active", lambda *_a, **_kw: None)
    monkeypatch.setattr("jobctrl.enrichment.availability.assert_fresh_candidate", lambda *_a, **_kw: None)
    monkeypatch.setattr("jobctrl.enrichment.availability.read_availability", lambda *_a, **_kw: {"verdict": "active"})
    selected = launcher_module.acquire_job(
        worker_id=1,
        run_ctx={"dry_run": True},
        approval_required=False,
        tenant_id=_TENANT_A,
    )

    assert acquire_conn.projected_canonical_identity is True
    assert selected is not None
    assert (selected["tenant_id"], selected["job_id"]) == (
        _TENANT_A,
        str(_JOB_B),
    )
    assert {artifact[2] for artifact in selected["email_source_binding"]["artifacts"]} == {
        "artifact-b", "text-b",
    }
