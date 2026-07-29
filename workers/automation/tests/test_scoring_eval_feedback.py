from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from jobctrl.database import get_jobs_by_stage, init_db
from jobctrl.infrastructure.scoring import collect_feedback_signals, rank_jobs_with_feedback
from jobctrl.state import record_job_event


def test_feedback_signals_use_corrections_and_job_actions_transparently() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE job_scores (
          job_url TEXT NOT NULL,
          version INTEGER NOT NULL,
          tenant_id TEXT NOT NULL DEFAULT 'local',
          fit_score INTEGER NOT NULL,
          breakdown_json TEXT NOT NULL,
          keywords_json TEXT NOT NULL,
          scored_at TEXT NOT NULL,
          correction_json TEXT,
          trace_json TEXT NOT NULL DEFAULT '{}',
          PRIMARY KEY (job_url, version)
        );
        CREATE TABLE job_events (
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          job_url TEXT,
          event_type TEXT NOT NULL,
          message TEXT
        );
        """
    )
    conn.execute(
        """INSERT INTO job_scores (
          job_url, version, fit_score, breakdown_json, keywords_json, scored_at,
          correction_json, trace_json
        ) VALUES (?, 2, ?, '{}', '[]', ?, ?, ?)""",
        (
            "job-a",
            9,
            "2026-05-14T10:00:00Z",
            json.dumps({"corrected_fit_score": 9, "rationale": "Better leadership fit."}),
            json.dumps({"correction_history": [{"original_score": 6, "corrected_score": 9}]}),
        ),
    )
    conn.execute(
        "INSERT INTO job_events (job_url, event_type, message) VALUES (?, ?, ?)",
        ("job-b", "StageSkipped", "Skipped after review."),
    )

    signals = collect_feedback_signals(conn)
    ranked = rank_jobs_with_feedback({"job-a": 7.5, "job-b": 8.0}, signals)

    assert [signal.kind for signal in signals] == ["score_correction", "StageSkipped"]
    assert ranked[0].job_id == "job-a"
    assert ranked[0].feedback_adjustment > 0
    assert "Better leadership fit" in ranked[0].evidence[0]
    assert ranked[1].feedback_adjustment < 0
    assert "Skipped after review" in ranked[1].evidence[0]


def test_feedback_adjustments_affect_downstream_selector_order(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobctrl.db")
    corrected = "https://example.com/corrected"
    skipped = "https://example.com/skipped"
    for url in (corrected, skipped):
        conn.execute(
            "INSERT INTO jobs (url, title, site, full_description, discovered_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (url, "Engineer", "Acme", "Need Python.", "2026-05-14T00:00:00+00:00"),
        )
    job_ids = {
        str(row["url"]): str(row["job_id"])
        for row in conn.execute(
            "SELECT url, job_id FROM jobs WHERE tenant_id = 'local'"
        ).fetchall()
    }
    conn.execute(
        """INSERT INTO job_scores (
          job_id, version, tenant_id, fit_score, breakdown_json, keywords_json, scored_at,
          correction_json, criteria_json, trace_json
        ) VALUES (?, 2, 'local', 9, ?, '["python"]', ?, ?, '{}', ?)""",
        (
            job_ids[corrected],
            json.dumps({"reasoning": "Corrected after review.", "eligibility": {"status": "eligible"}}),
            "2026-05-14T10:00:00+00:00",
            json.dumps({"corrected_fit_score": 9, "rationale": "Better leadership fit."}),
            json.dumps({"correction_history": [{"original_score": 6, "corrected_score": 9}]}),
        ),
    )
    conn.execute(
        """INSERT INTO job_scores (
          job_id, version, tenant_id, fit_score, breakdown_json, keywords_json, scored_at,
          correction_json, criteria_json, trace_json
        ) VALUES (?, 1, 'local', 10, ?, '["python"]', ?, NULL, '{}', '{}')""",
        (
            job_ids[skipped],
            json.dumps({"reasoning": "High raw score.", "eligibility": {"status": "eligible"}}),
            "2026-05-14T10:00:00+00:00",
        ),
    )
    record_job_event(
        conn,
        skipped,
        "tailor",
        "StageSkipped",
        message="Skipped after manual review.",
    )
    conn.commit()

    rows = get_jobs_by_stage(conn, "pending_tailor", min_score=7, limit=1)

    assert [row["url"] for row in rows] == [corrected]
