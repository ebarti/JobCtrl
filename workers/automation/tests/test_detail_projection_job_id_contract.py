"""Job-detail root identities use the current canonical JobId."""

from __future__ import annotations

import json
import sqlite3
from typing import Any

from jobctrl.infrastructure.interview import SqliteInterviewPrepRepository
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.infrastructure.scoring import SqliteRequirementFitReportRepository


class _ReadModel:
    def __init__(self, payload: dict[str, Any]) -> None:
        self._payload = payload

    def to_read_model(self) -> dict[str, Any]:
        return dict(self._payload)


def test_detail_projection_roots_use_the_passed_job_id_without_job_key(
    monkeypatch,
) -> None:
    conn = sqlite3.connect(":memory:")
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    job_id = "00000000-0000-4000-8000-000000000001"

    requirement_fit = _ReadModel(
        {"jobId": "stale-requirement-fit-job", "jobKey": "obsolete", "scoreVersion": 2}
    )
    interview_prep = _ReadModel(
        {"jobId": "stale-interview-prep-job", "jobKey": "obsolete", "generation": 3}
    )
    monkeypatch.setattr(
        SqliteRequirementFitReportRepository,
        "load",
        lambda *_: requirement_fit,
    )
    monkeypatch.setattr(
        SqliteInterviewPrepRepository,
        "load_latest",
        lambda *_args, **_kwargs: interview_prep,
    )

    with builder._bind(conn):
        requirement_payload = json.loads(builder._load_requirement_fit_report(job_id) or "{}")
        interview_payload = json.loads(builder._load_interview_prep(job_id) or "{}")

    assert requirement_payload == {"jobId": job_id, "scoreVersion": 2}
    assert interview_payload == {"jobId": job_id, "generation": 3}
