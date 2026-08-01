"""PR 4 regressions for ``jobctrl.apply.launcher``.

The bespoke ``apply_runs`` table is gone; the canonical lock now lives
on ``job_stage_states.apply.state`` and the lifecycle is observable via
the ``apply_run_projections`` table (sourced from ``job_events``).
These tests cover the launcher contract that downstream callers
(``cli.py``, ``actions.py``, ``pipeline.py``) still rely on.
"""

from __future__ import annotations

import json
import sqlite3
import threading
from collections import Counter
from hashlib import sha256
from pathlib import Path

import pytest

from jobctrl.apply import launcher as launcher_module
from jobctrl import browser_capabilities
from jobctrl.apply.launcher import (
    _kill_claude_processes_for_interrupt,
    acquire_job,
    mark_result,
    recover_ambiguous_running_apply,
    release_lock,
    worker_loop,
)
from jobctrl.apply.dashboard import get_recent_events
from jobctrl.apply.origins import canonical_http_url
from jobctrl.database import close_connection, get_connection, init_db
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state, utc_now
from jobctrl.workflow_specs import StartedWorkflowResult


@pytest.fixture(autouse=True)
def permit_browser_for_existing_apply_launcher_tests(monkeypatch: pytest.MonkeyPatch) -> None:
    """Launcher regression tests run after the browser capability gate."""

    monkeypatch.setattr(
        browser_capabilities,
        "require_system_browser_capability",
        lambda _capability: Path("/test/Chromium"),
    )


def _insert_ready_job(
    conn,
    *,
    url: str = "https://example.com/job",
    application_url: str | None = "https://example.com/apply",
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, full_description, application_url,
            fit_score, tailored_resume_path, cover_letter_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            "Platform Engineer",
            "ExampleCo",
            "Build distributed systems.",
            application_url,
            9,
            "/tmp/resume.txt",
            "/tmp/cover.txt",
        ),
    )
    conn.commit()


def _insert_single_job_tailor_candidate(conn, *, url: str = "https://example.com/job") -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            url, title, site, full_description, application_url, fit_score
        ) VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            url,
            "Platform Engineer",
            "ExampleCo",
            "Build distributed systems.",
            "https://example.com/apply",
            9,
        ),
    )
    conn.commit()


def _target_job_id(conn, url: str = "https://example.com/job") -> str:
    row = conn.execute(
        "SELECT job_id FROM jobs WHERE tenant_id = ? AND url = ? LIMIT 1",
        (LOCAL_TENANT, url),
    ).fetchone()
    assert row is not None
    return str(row["job_id"])


def _insert_blocked_score(conn, url: str, *, fit_score: int = 9) -> None:
    conn.execute(
        """
        INSERT INTO job_scores (
            job_url, version, tenant_id, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, criteria_json, trace_json
        ) VALUES (?, 1, 'local', ?, ?, '["python"]', ?, NULL, '{}', '{}')
        """,
        (
            url,
            fit_score,
            json.dumps(
                {
                    "reasoning": "Strong match with a hard blocker.",
                    "eligibility": {
                        "status": "blocked",
                        "hard_blockers": ["No sponsorship."],
                        "warnings": [],
                    },
                },
                sort_keys=True,
            ),
            "2026-05-14T00:00:00+00:00",
        ),
    )
    conn.commit()


def test_unsafe_url_failure_is_permanent() -> None:
    assert launcher_module._is_permanent_failure("failed:unsafe_url: URL host is not a public address: 127.0.0.1")


def _mark_closed(conn: sqlite3.Connection, url: str, state: str = "removed") -> None:
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_url, snapshot_set_json, latest_snapshot_version,
            latest_active_state, updated_at
        ) VALUES ('local', ?, '{}', 0, ?, ?)
        ON CONFLICT(tenant_id, job_url) DO UPDATE SET
            latest_active_state = excluded.latest_active_state,
            updated_at = excluded.updated_at
        """,
        (url, state, utc_now()),
    )
    conn.commit()


def _insert_review_decision(
    conn: sqlite3.Connection,
    *,
    job_key: str = "https://example.com/job",
    decision: str = "approve_submit",
    decided_at: str = "2026-01-01T00:00:00+00:00",
    decision_id: str | None = None,
    materials_generation: int | None = None,
    profile_version: int | None = None,
    application_url: str | None = None,
    partial_override_run_id: str | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO application_review_decisions (
            tenant_id, decision_id, job_key, decision, reason, decided_by, decided_at,
            materials_generation, profile_version, application_url, partial_override_run_id
        ) VALUES ('local', ?, ?, ?, 'test', 'pytest', ?, ?, ?, ?, ?)
        """,
        (
            decision_id or f"decision-{decision}-{decided_at}",
            job_key,
            decision,
            decided_at,
            materials_generation,
            profile_version,
            application_url,
            partial_override_run_id,
        ),
    )
    conn.commit()


def _seed_current_apply_binding(
    conn: sqlite3.Connection,
    *,
    job_key: str = "https://example.com/job",
    application_url: str = "https://example.com/apply",
    generation: int = 1,
    profile_version: int = 1,
    coverage: str | None = "full",
    run_id: str = "dry-run-full",
) -> None:
    now = "2026-01-01T00:00:00+00:00"
    conn.execute(
        """
        INSERT OR REPLACE INTO candidate_profiles (
            tenant_id, profile_id, version, updated_at
        ) VALUES ('local', 'default', ?, ?)
        """,
        (profile_version, now),
    )
    conn.execute(
        """
        INSERT OR REPLACE INTO job_materials (
            job_url, generation, tenant_id, status, created_at, updated_at
        ) VALUES (?, ?, 'local', 'approved', ?, ?)
        """,
        (job_key, generation, now, now),
    )
    for artifact_type, artifact_id, path in (
        ("tailored_resume", "resume-text-1", "/tmp/resume.txt"),
        ("resume_pdf", "resume-pdf-1", "/tmp/resume.pdf"),
    ):
        conn.execute(
            """
            INSERT OR REPLACE INTO job_materials_artifacts (
                job_url, generation, artifact_type, artifact_id, status, path,
                render_format, created_at
            ) VALUES (?, ?, ?, ?, 'approved', ?, 'text', ?)
            """,
            (job_key, generation, artifact_type, artifact_id, path, now),
        )
    if coverage is not None:
        record_job_event(
            conn,
            job_key,
            "apply",
            "ApplyRunStarted",
            message="Apply dry-run started",
            payload={
                "run_id": run_id,
                "dry_run": True,
                "materials_generation": generation,
                "profile_version": profile_version,
                "application_url": application_url,
            },
        )
        record_job_event(
            conn,
            job_key,
            "apply",
            "DryRunCompleted",
            message="Dry run completed",
            payload={
                "run_id": run_id,
                "result": "dry_run_complete",
                "dry_run": True,
                "coverage": coverage,
                "allowed_navigations": _run_bound_navigation(application_url),
                "materials_generation": generation,
                "application_url": application_url,
                "profile_version": profile_version,
                "finished_at": now,
            },
        )
    conn.commit()


def _run_bound_navigation(application_url: str) -> list[dict[str, str]]:
    canonical_url = canonical_http_url(application_url)
    return [
        {
            "decision": "run_bound_initial_url",
            "grant_id": "initial_application_url",
            "method": "GET",
            "url": canonical_url.split("?", 1)[0],
            "url_fingerprint": sha256(canonical_url.encode("utf-8")).hexdigest(),
        }
    ]


def test_targeted_apply_takes_canonical_stage_lock(tmp_path, monkeypatch):
    """The lock now lives on ``job_stage_states.apply.state == 'running'``.
    Legacy ``jobs.apply_status`` stays NULL."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        job = acquire_job(
            target_job_id=_target_job_id(conn),
            worker_id=1,
            approval_required=False,
        )
        assert job is not None
        assert job["url"] == "https://example.com/job"
        # Legacy column stays NULL on the new path.
        legacy = conn.execute("SELECT apply_status FROM jobs WHERE url = ?", (job["url"],)).fetchone()
        assert legacy["apply_status"] is None
        # Canonical lock: stage row in 'running'.
        stage = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert stage is not None
        assert stage["state"] == "running"
        # ApplyRunStarted event recorded with the same run_id.
        evt = conn.execute(
            "SELECT payload_json FROM job_events "
            "WHERE job_url = ? AND event_type = 'ApplyRunStarted' "
            "ORDER BY event_id DESC LIMIT 1",
            (job["url"],),
        ).fetchone()
        assert evt is not None
        import json

        payload = json.loads(evt["payload_json"])
        assert payload["run_id"] == job["apply_run_id"]
    finally:
        close_connection(db_path)


def test_application_review_decisions_table_exists_on_fresh_db(tmp_path):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    try:
        row = conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'application_review_decisions'"
        ).fetchone()
        assert row is not None
    finally:
        close_connection(db_path)


def test_apply_approval_gate_blocks_live_without_approval(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        prior_event_count = len(get_recent_events())
        assert acquire_job(target_job_id=_target_job_id(conn), worker_id=1) is None
        row = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            ("https://example.com/job",),
        ).fetchone()
        assert row is None or row["state"] == "pending"
        assert any("Awaiting apply approval" in event for event in get_recent_events()[prior_event_count:])
    finally:
        close_connection(db_path)


def test_approval_required_apply_loop_never_runs_browser_for_unapproved_job(
    tmp_path,
    monkeypatch,
):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    def fail_run_job(*_args, **_kwargs):
        raise AssertionError("unapproved live job reached browser automation")

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        monkeypatch.setattr(launcher_module, "run_job", fail_run_job)

        applied, failed = worker_loop(
            worker_id=1,
            limit=1,
            approval_required=True,
            workflow_id="apply-auto-local",
        )

        assert (applied, failed) == (0, 0)
        row = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            ("https://example.com/job",),
        ).fetchone()
        assert row is None or row["state"] == "pending"
    finally:
        close_connection(db_path)


def test_apply_approval_gate_can_be_disabled_or_bypassed_for_dry_run(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        job = acquire_job(
            target_job_id=_target_job_id(conn),
            worker_id=1,
            approval_required=False,
        )
        assert job is not None
        set_stage_state(conn, job["url"], "apply", "pending", validate_transition=False)
        conn.commit()

        dry_job = acquire_job(
            target_job_id=_target_job_id(conn),
            worker_id=1,
            run_ctx={"dry_run": True},
            approval_required=True,
        )
        assert dry_job is not None
    finally:
        close_connection(db_path)


def test_apply_approval_gate_requires_latest_approve_submit(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    _seed_current_apply_binding(conn)
    _insert_review_decision(
        conn,
        decision="approve_submit",
        decided_at="2026-01-01T00:00:00+00:00",
        decision_id="decision-old-approve",
        materials_generation=1,
        profile_version=1,
        application_url="https://example.com/apply",
    )
    _insert_review_decision(
        conn,
        decision="decline",
        decided_at="2026-01-02T00:00:00+00:00",
        decision_id="decision-new-decline",
    )

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        assert acquire_job(target_job_id=_target_job_id(conn), worker_id=1) is None
        _insert_review_decision(
            conn,
            decision="approve_submit",
            decided_at="2026-01-03T00:00:00+00:00",
            decision_id="decision-new-approve",
            materials_generation=1,
            profile_version=1,
            application_url="https://example.com/apply",
        )
        assert acquire_job(target_job_id=_target_job_id(conn), worker_id=1) is not None
    finally:
        close_connection(db_path)


def test_apply_approval_gate_requires_matching_full_dry_run(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    _seed_current_apply_binding(conn, coverage=None)
    _insert_review_decision(
        conn,
        decision="approve_submit",
        materials_generation=1,
        profile_version=1,
        application_url="https://example.com/apply",
    )

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        prior_event_count = len(get_recent_events())
        assert acquire_job(target_job_id=_target_job_id(conn), worker_id=1) is None
        assert any("awaiting_dry_run" in event for event in get_recent_events()[prior_event_count:])
    finally:
        close_connection(db_path)


def test_normal_dry_run_completion_satisfies_approval_gate(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    _seed_current_apply_binding(conn, coverage=None)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        run_ctx: dict = {"dry_run": True}
        dry_run_job = acquire_job(
            target_job_id=_target_job_id(conn),
            worker_id=1,
            run_ctx=run_ctx,
            approval_required=True,
        )
        assert dry_run_job is not None
        record_job_event(
            conn,
            "https://example.com/job",
            "apply",
            "DryRunCompleted",
            message="Saga dry run completed",
            payload={
                "run_id": run_ctx["run_id"],
                "result": "dry_run_complete",
                "dry_run": True,
                "coverage": "full",
                "allowed_navigations": _run_bound_navigation("https://example.com/apply"),
                "materials_generation": 1,
                "application_url": "https://example.com/apply",
                "profile_version": 1,
            },
        )
        mark_result(
            "https://example.com/job",
            "dry_run",
            duration_ms=123,
            task_id=run_ctx["run_id"],
            run_ctx=run_ctx,
        )
        completion = conn.execute(
            "SELECT payload_json FROM job_events "
            "WHERE job_url = ? AND event_type = 'DryRunCompleted' "
            "ORDER BY event_id DESC LIMIT 1",
            ("https://example.com/job",),
        ).fetchone()
        assert completion is not None
        payload = json.loads(completion["payload_json"])
        assert payload["coverage"] == "full"
        assert payload["allowed_navigations"] == _run_bound_navigation("https://example.com/apply")
        assert payload["materials_generation"] == 1
        assert payload["application_url"] == "https://example.com/apply"

        _insert_review_decision(
            conn,
            decision="approve_submit",
            decided_at="2026-01-02T00:00:00+00:00",
            materials_generation=1,
            profile_version=1,
            application_url="https://example.com/apply",
        )

        live_job = acquire_job(
            target_job_id=_target_job_id(conn),
            worker_id=2,
            approval_required=True,
        )
        assert live_job is not None
    finally:
        close_connection(db_path)


def test_full_dry_run_without_navigation_receipt_cannot_satisfy_approval_gate(
    tmp_path,
    monkeypatch,
):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    _seed_current_apply_binding(conn, coverage=None)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        run_ctx: dict = {"dry_run": True}
        assert (
            acquire_job(
                target_job_id=_target_job_id(conn),
                worker_id=1,
                run_ctx=run_ctx,
                approval_required=True,
            )
            is not None
        )
        mark_result(
            "https://example.com/job",
            "dry_run",
            duration_ms=123,
            task_id=run_ctx["run_id"],
            run_ctx=run_ctx,
        )
        completion = conn.execute(
            "SELECT payload_json FROM job_events "
            "WHERE job_url = ? AND event_type = 'DryRunCompleted' "
            "ORDER BY event_id DESC LIMIT 1",
            ("https://example.com/job",),
        ).fetchone()
        assert completion is not None
        assert json.loads(completion["payload_json"])["coverage"] == "partial"

        _insert_review_decision(
            conn,
            decision="approve_submit",
            decided_at="2026-01-02T00:00:00+00:00",
            materials_generation=1,
            profile_version=1,
            application_url="https://example.com/apply",
        )

        assert (
            acquire_job(
                target_job_id=_target_job_id(conn),
                worker_id=2,
                approval_required=True,
            )
            is None
        )
    finally:
        close_connection(db_path)


@pytest.mark.parametrize(
    ("decision_bindings", "expected_reason"),
    [
        (
            {"materials_generation": 0, "profile_version": 1, "application_url": "https://example.com/apply"},
            "approval_stale_materials",
        ),
        (
            {"materials_generation": 1, "profile_version": 0, "application_url": "https://example.com/apply"},
            "approval_stale_profile",
        ),
        (
            {"materials_generation": 1, "profile_version": 1, "application_url": "https://example.com/old-apply"},
            "approval_stale_url",
        ),
    ],
)
def test_apply_approval_gate_rejects_stale_bindings(
    tmp_path,
    monkeypatch,
    decision_bindings,
    expected_reason,
):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    _seed_current_apply_binding(conn)
    _insert_review_decision(conn, decision="approve_submit", **decision_bindings)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        worker_id = {
            "approval_stale_materials": 11,
            "approval_stale_profile": 12,
            "approval_stale_url": 13,
        }[expected_reason]
        assert acquire_job(target_job_id=_target_job_id(conn), worker_id=worker_id) is None
        assert any(f"[W{worker_id}]" in event and expected_reason in event for event in get_recent_events())
    finally:
        close_connection(db_path)


def test_apply_approval_gate_accepts_partial_override_bound_to_run(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    _seed_current_apply_binding(conn, coverage="partial", run_id="dry-run-partial")
    _insert_review_decision(
        conn,
        decision="approve_submit",
        materials_generation=1,
        profile_version=1,
        application_url="https://example.com/apply",
        partial_override_run_id="dry-run-partial",
    )

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        assert acquire_job(target_job_id=_target_job_id(conn), worker_id=1) is not None
    finally:
        close_connection(db_path)


@pytest.mark.parametrize(
    ("coverage", "partial_override_run_id", "expected_reason"),
    [
        ("full", None, "awaiting_dry_run"),
        ("partial", "dry-run-profile-v1", "override_evidence_invalid"),
    ],
)
def test_apply_approval_gate_rejects_dry_run_evidence_for_stale_profile(
    tmp_path,
    monkeypatch,
    coverage,
    partial_override_run_id,
    expected_reason,
):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    _seed_current_apply_binding(
        conn,
        coverage=coverage,
        profile_version=1,
        run_id="dry-run-profile-v1",
    )
    conn.execute(
        """
        UPDATE candidate_profiles
        SET version = 2, updated_at = ?
        WHERE tenant_id = 'local' AND profile_id = 'default'
        """,
        (utc_now(),),
    )
    conn.commit()
    _insert_review_decision(
        conn,
        decision="approve_submit",
        materials_generation=1,
        profile_version=2,
        application_url="https://example.com/apply",
        partial_override_run_id=partial_override_run_id,
    )

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        worker_id = 21 if coverage == "full" else 22
        assert acquire_job(target_job_id=_target_job_id(conn), worker_id=worker_id) is None
        assert any(f"[W{worker_id}]" in event and expected_reason in event for event in get_recent_events())
    finally:
        close_connection(db_path)


@pytest.mark.parametrize("seed_stale_run", [False, True])
def test_apply_approval_gate_rejects_invalid_partial_override(
    tmp_path,
    monkeypatch,
    seed_stale_run,
):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    _seed_current_apply_binding(conn, coverage=None)
    if seed_stale_run:
        record_job_event(
            conn,
            "https://example.com/job",
            "apply",
            "ApplyRunStarted",
            message="stale partial dry-run started",
            payload={
                "run_id": "dry-run-partial",
                "dry_run": True,
                "materials_generation": 0,
                "profile_version": 1,
                "application_url": "https://example.com/apply",
            },
        )
        record_job_event(
            conn,
            "https://example.com/job",
            "apply",
            "DryRunCompleted",
            message="stale partial dry-run completed",
            payload={
                "run_id": "dry-run-partial",
                "dry_run": True,
                "coverage": "partial",
            },
        )
        conn.commit()
    _insert_review_decision(
        conn,
        decision="approve_submit",
        materials_generation=1,
        profile_version=1,
        application_url="https://example.com/apply",
        partial_override_run_id="dry-run-partial",
    )

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        worker_id = 23 if seed_stale_run else 24
        assert acquire_job(target_job_id=_target_job_id(conn), worker_id=worker_id) is None
        assert any(f"[W{worker_id}]" in event and "override_evidence_invalid" in event for event in get_recent_events())
    finally:
        close_connection(db_path)


def test_acquire_job_accepts_posting_url_when_direct_apply_url_missing(tmp_path, monkeypatch):
    """The agent can start from the posting URL and click through to Apply."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(
        conn,
        url="https://example.com/posting-only",
        application_url=None,
    )

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        job = acquire_job(worker_id=1, approval_required=False)
        assert job is not None
        assert job["url"] == "https://example.com/posting-only"
        assert job["application_url"] is None
    finally:
        close_connection(db_path)


def test_worker_loop_delegates_browser_lifecycle_to_apply_saga(monkeypatch):
    """The worker loop should not launch Chrome before ``run_job``.

    ``run_job`` now drives ``SubmitApplicationUseCase`` and ``ApplySaga``,
    whose browser port owns launch/cleanup. Keeping the legacy outer launch
    path would boot Chrome twice on the same CDP port.
    """

    job = {
        "url": "https://example.com/job",
        "title": "Platform Engineer",
        "site": "ExampleCo",
        "application_url": None,
        "tailored_resume_path": "/tmp/resume.txt",
        "fit_score": 9,
    }
    acquired = {"used": False}
    marked = {}

    def fake_acquire_job(**_kwargs):
        if acquired["used"]:
            return None
        acquired["used"] = True
        return job

    def forbidden_outer_launch(*_args, **_kwargs):
        raise AssertionError("worker_loop must not launch Chrome directly")

    def fake_run_job(*_args, **_kwargs):
        return "dry_run", 10

    def fake_mark_result(url, status, **kwargs):
        marked["url"] = url
        marked["status"] = status
        marked["duration_ms"] = kwargs.get("duration_ms")

    monkeypatch.setattr("jobctrl.apply.launcher.acquire_job", fake_acquire_job)
    monkeypatch.setattr(
        "jobctrl.apply.launcher.launch_chrome",
        forbidden_outer_launch,
        raising=False,
    )
    monkeypatch.setattr("jobctrl.apply.launcher.run_job", fake_run_job)
    monkeypatch.setattr("jobctrl.apply.launcher.mark_result", fake_mark_result)

    applied, failed = worker_loop(worker_id=0, limit=1, dry_run=True, snapshot=object())

    assert (applied, failed) == (0, 0)
    assert marked == {
        "url": "https://example.com/job",
        "status": "dry_run",
        "duration_ms": 10,
    }


def test_interrupt_cleanup_calls_adapter_claude_registry(monkeypatch):
    called: list[str] = []
    monkeypatch.setattr(
        "jobctrl.infrastructure.apply.claude_code_cli.kill_active_claude_processes",
        lambda: called.append("adapter"),
    )
    with launcher_module._claude_lock:
        old_procs = dict(launcher_module._claude_procs)
        launcher_module._claude_procs.clear()
    try:
        _kill_claude_processes_for_interrupt()
    finally:
        with launcher_module._claude_lock:
            launcher_module._claude_procs.clear()
            launcher_module._claude_procs.update(old_procs)

    assert called == ["adapter"]


def test_acquire_job_excludes_high_score_blocked_candidates(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn, url="https://example.com/allowed")
    _insert_ready_job(conn, url="https://example.com/blocked")
    _insert_blocked_score(conn, "https://example.com/blocked", fit_score=10)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        job = acquire_job(min_score=7, worker_id=1, approval_required=False)
        assert job is not None
        assert job["url"] == "https://example.com/allowed"
    finally:
        close_connection(db_path)


def test_acquire_job_excludes_closed_candidates(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn, url="https://example.com/closed")
    _mark_closed(conn, "https://example.com/closed")

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        assert acquire_job(min_score=7, worker_id=1, approval_required=False) is None
        assert (
            acquire_job(
                target_job_id=_target_job_id(conn, "https://example.com/closed"),
                worker_id=1,
                approval_required=False,
            )
            is None
        )
    finally:
        close_connection(db_path)


def test_targeted_apply_rejects_blocked_candidate(tmp_path, monkeypatch):
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn, url="https://example.com/blocked")
    _insert_blocked_score(conn, "https://example.com/blocked", fit_score=10)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        assert (
            acquire_job(
                target_job_id=_target_job_id(conn, "https://example.com/blocked"),
                worker_id=1,
                approval_required=False,
            )
            is None
        )
    finally:
        close_connection(db_path)


def test_single_job_starts_temporal_workflow_spec(tmp_path, monkeypatch):
    import jobctrl.config as config_module
    import jobctrl.pipeline.runner as runner_module

    app_dir = Path(tmp_path) / "app"
    db_path = Path(tmp_path) / "jobs.db"
    app_dir.mkdir()

    monkeypatch.setattr(config_module, "APP_DIR", app_dir)
    monkeypatch.setattr(config_module, "DB_PATH", db_path)
    url = "https://example.com/blocked"
    specs = []

    def fake_start(spec):
        specs.append(spec)
        return StartedWorkflowResult(
            run_id="run-single",
            workflow_id="workflow-single",
            first_execution_run_id="first-single",
            result={"status": "succeeded", "stages_completed": ["enrich", "score", "tailor", "cover"]},
        )

    monkeypatch.setattr("jobctrl.workflow_specs.start_workflow_spec_and_wait_sync", fake_start)

    result = runner_module.run_single_job(url, do_tailor=True, do_apply=False)

    payload = specs[0].args[0]
    assert payload.job_url == url
    assert payload.stages == ["enrich", "score", "tailor", "cover"]
    assert payload.expected_app_dir == str(app_dir)
    assert payload.expected_db_path == str(db_path)
    assert result["workflowId"] == "workflow-single"
    assert result["stages_completed"] == ["enrich", "score", "tailor", "cover"]


def test_acquire_job_promotes_prior_apply_run_into_row_dict(tmp_path, monkeypatch):
    """When a prior failed apply run exists in ``apply_run_projections``,
    ``acquire_job`` promotes its status into the legacy
    ``apply_status`` slot."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    # Seed prior failed apply via the canonical writer + projector.
    ensure_job_stage_rows(conn, "https://example.com/job")
    set_stage_state(
        conn,
        "https://example.com/job",
        "apply",
        "failed",
        finished_at="2026-01-01T00:01:00+00:00",
        attempt_count=1,
        validate_transition=False,
    )
    record_job_event(
        conn,
        "https://example.com/job",
        "apply",
        "ApplyRunStarted",
        payload={
            "run_id": "run-prior",
            "started_at": "2026-01-01T00:00:00+00:00",
        },
    )
    record_job_event(
        conn,
        "https://example.com/job",
        "apply",
        "ApplicationFailed",
        payload={
            "run_id": "run-prior",
            "finished_at": "2026-01-01T00:01:00+00:00",
            "result": "failed",
        },
    )
    conn.commit()
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        job = acquire_job(
            target_job_id=_target_job_id(conn),
            worker_id=1,
            approval_required=False,
        )
        assert job is not None
        assert job["apply_status"] == "failed"
        assert job["apply_attempts"] == 1
        assert job["applied_at"] is None
    finally:
        close_connection(db_path)


def test_acquire_job_finds_new_path_enriched_job(tmp_path, monkeypatch):
    """``acquire_job`` must find jobs whose ``application_url`` lives
    only in ``job_enrichments`` (the new write path leaves
    ``jobs.application_url`` NULL)."""
    from jobctrl.domain.enrichment import (
        ApplicationUrl,
        ExtractionTier,
        FullDescription,
        JobEnrichment,
    )
    from jobctrl.domain.identifiers import JobId
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository

    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    url = "https://example.com/new-path-job"
    conn.execute(
        "INSERT INTO jobs (url, title, site, fit_score, tailored_resume_path) VALUES (?, ?, ?, ?, ?)",
        (url, "New Path Engineer", "ExampleCo", 9, "/tmp/resume.txt"),
    )
    conn.commit()

    repo = SqliteEnrichmentRepository(conn)
    repo.save(
        JobEnrichment.empty(tenant_id=LOCAL_TENANT, job_id=JobId(url), updated_at="t0")
        .start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
        .succeed_attempt(
            full_description=FullDescription(text="Build distributed systems."),
            application_url=ApplicationUrl(value="https://example.com/apply-new"),
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at="t1",
        )
    )
    legacy = conn.execute("SELECT application_url FROM jobs WHERE url = ?", (url,)).fetchone()
    assert legacy["application_url"] is None

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        job = acquire_job(target_job_id=_target_job_id(conn, url), worker_id=1, approval_required=False)
        assert job is not None
        assert job["url"] == url
        assert job["application_url"] == "https://example.com/apply-new"
        assert job["full_description"] == "Build distributed systems."
    finally:
        close_connection(db_path)


def test_dry_run_result_does_not_mark_job_applied(tmp_path, monkeypatch):
    """A dry-run result writes a ``DryRunCompleted`` event whose
    projection has ``status='dry_run_complete'`` and ``dry_run=1``.
    The legacy ``jobs.apply_*`` columns stay NULL.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        mark_result(
            "https://example.com/job",
            "dry_run",
            duration_ms=123,
            task_id="run-test",
        )
        ProjectionBuilder(conn_factory=lambda: get_connection(db_path)).refresh()

        row = conn.execute(
            "SELECT apply_status, applied_at, apply_task_id FROM jobs WHERE url = ?",
            ("https://example.com/job",),
        ).fetchone()
        state = conn.execute(
            "SELECT state, error_code FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            ("https://example.com/job",),
        ).fetchone()
        # Legacy columns stay NULL on the new write path.
        assert row["apply_status"] is None
        assert row["applied_at"] is None
        assert row["apply_task_id"] is None
        assert state["state"] == "skipped"
        assert state["error_code"] == "DRY_RUN"
        # Canonical: an apply_run_projections row in dry_run_complete.
        ar = conn.execute(
            "SELECT run_id, status, dry_run FROM apply_run_projections WHERE job_id = ?",
            ("https://example.com/job",),
        ).fetchone()
        assert ar is not None
        assert ar["status"] == "dry_run_complete"
        assert ar["dry_run"] == 1
        assert ar["run_id"] == "run-test"
    finally:
        close_connection(db_path)


def test_acquire_job_then_mark_result_dry_run_completes_end_to_end(tmp_path, monkeypatch):
    """Reviewer-reported regression (PR 37 High #1): the production
    sequence ``acquire_job`` (Pending -> Running) then
    ``mark_result("dry_run", ...)`` (Running -> Skipped) used to raise
    ``ValueError`` because Running -> Skipped is not in the §8.5
    state-machine table.  The launcher now bypasses validation for the
    dry-run convention.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        run_ctx: dict = {}
        job = acquire_job(
            target_job_id=_target_job_id(conn),
            worker_id=2,
            run_ctx=run_ctx,
            approval_required=False,
        )
        assert job is not None
        # Sanity: the lock acquired -> Running.
        before = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert before["state"] == "running"

        # Production sequence -- this used to raise ValueError.
        mark_result(
            job["url"],
            "dry_run",
            duration_ms=42,
            run_ctx=run_ctx,
        )

        # (a) No exception (we got here).
        # (b) Stage row landed on Skipped.
        after = conn.execute(
            "SELECT state, error_code FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert after["state"] == "skipped"
        assert after["error_code"] == "DRY_RUN"

        # (c) apply_run_projections has a row for the run_id with dry_run=1
        # and a sensible terminal status, after refresh.
        ProjectionBuilder(conn_factory=lambda: get_connection(db_path)).refresh()
        ar = conn.execute(
            "SELECT run_id, status, dry_run FROM apply_run_projections WHERE job_id = ?",
            (job["url"],),
        ).fetchone()
        assert ar is not None
        assert ar["run_id"] == run_ctx["run_id"]
        assert ar["dry_run"] == 1
        assert ar["status"] == "dry_run_complete"
    finally:
        close_connection(db_path)


def test_release_lock_does_not_rewind_running_row(tmp_path, monkeypatch):
    """P2: cleanup logging must not blindly requeue an ambiguous live apply."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        run_ctx: dict = {}
        job = acquire_job(
            target_job_id=_target_job_id(conn),
            worker_id=3,
            run_ctx=run_ctx,
            approval_required=False,
        )
        assert job is not None
        before = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert before["state"] == "running"

        release_lock(job["url"], run_ctx=run_ctx)

        after = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert after["state"] == "running"
    finally:
        close_connection(db_path)


def test_apply_recovery_rewinds_before_submit_intent(tmp_path, monkeypatch):
    """P2: if the agent never reached submit intent, recovery may requeue."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        # 1. Acquire (writes ApplyRunStarted with the canonical run_id +
        #    flips stage to running).
        run_ctx: dict = {}
        job = acquire_job(
            target_job_id=_target_job_id(conn),
            worker_id=5,
            run_ctx=run_ctx,
            approval_required=False,
        )
        assert job is not None
        recovered = recover_ambiguous_running_apply()
        assert recovered == 1
        row = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert row["state"] == "pending"
    finally:
        close_connection(db_path)


def test_apply_recovery_after_submit_intent_needs_verification(tmp_path, monkeypatch):
    """P2: after submit intent, recovery must never auto-requeue."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        run_ctx: dict = {"workflow_id": "apply-local-https://example.com/job"}
        job = acquire_job(
            target_job_id=_target_job_id(conn),
            worker_id=5,
            run_ctx=run_ctx,
            approval_required=False,
        )
        assert job is not None
        record_job_event(
            conn,
            job["url"],
            "apply",
            "ApplySubmitIntended",
            message="apply submission intent recorded",
            payload={
                "tenant_id": "local",
                "job_key": job["url"],
                "run_id": run_ctx["run_id"],
                "material_version": "1",
                "intended_at": utc_now(),
            },
        )
        conn.commit()

        recovered = recover_ambiguous_running_apply()
        assert recovered == 1
        row = conn.execute(
            "SELECT state, error_code FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert row["state"] == "needs_verification"
        assert row["error_code"] == "APPLY_NEEDS_VERIFICATION"

        _insert_review_decision(conn, job_key=job["url"], decision="approve_submit")
        assert (
            acquire_job(
                target_job_id=_target_job_id(conn, job["url"]),
                worker_id=6,
                run_ctx={"workflow_id": "apply-targeted-reclaim"},
                approval_required=True,
            )
            is None
        )
        assert (
            acquire_job(
                worker_id=7,
                run_ctx={"workflow_id": "apply-batch-reclaim"},
                approval_required=True,
            )
            is None
        )
        parked = conn.execute(
            "SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert parked["state"] == "needs_verification"
    finally:
        close_connection(db_path)


def test_failed_result_after_submit_intent_parks_without_reclaim(
    tmp_path,
    monkeypatch,
):
    """An ambiguous owned send must never become a retryable failed job."""

    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr(
            "jobctrl.apply.launcher.get_connection",
            lambda: get_connection(db_path),
        )
        run_ctx: dict = {"workflow_id": "apply-email-send"}
        job = acquire_job(
            target_job_id=_target_job_id(conn),
            worker_id=5,
            run_ctx=run_ctx,
            approval_required=False,
        )
        assert job is not None
        record_job_event(
            conn,
            job["url"],
            "apply",
            "ApplySubmitIntended",
            message="owned email application intent recorded",
            payload={
                "tenant_id": "local",
                "job_key": job["url"],
                "run_id": run_ctx["run_id"],
                "material_version": "1",
                "submission_channel": "email",
                "intended_at": utc_now(),
            },
        )
        conn.commit()

        mark_result(
            job["url"],
            "failed",
            "email_send_outcome_ambiguous:provider timed out after accepting request",
            run_ctx=run_ctx,
        )

        row = conn.execute(
            "SELECT state, error_code, retryable, next_action "
            "FROM job_stage_states WHERE job_url = ? AND stage = 'apply'",
            (job["url"],),
        ).fetchone()
        assert row["state"] == "needs_verification"
        assert row["error_code"] == "APPLY_NEEDS_VERIFICATION"
        assert row["retryable"] == 0
        assert "confirmation email" in row["next_action"]

        assert (
            acquire_job(
                target_job_id=_target_job_id(conn, job["url"]),
                worker_id=6,
                run_ctx={"workflow_id": "apply-targeted-reclaim"},
                approval_required=False,
            )
            is None
        )
        assert (
            acquire_job(
                worker_id=7,
                run_ctx={"workflow_id": "apply-batch-reclaim"},
                approval_required=False,
            )
            is None
        )
    finally:
        close_connection(db_path)


def test_acquire_job_concurrent_workers_only_one_succeeds(tmp_path, monkeypatch):
    """Reviewer-reported brief item (PR 37 Medium #2): the lock moved
    from per-run ``apply_runs`` rows to per-job-stage
    ``job_stage_states.apply.state == 'running'`` UPSERTed inside
    ``BEGIN IMMEDIATE``.  Two concurrent workers MUST NOT both succeed.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    job_id = _target_job_id(conn)
    close_connection(db_path)  # workers create thread-local connections

    try:
        # Each worker thread MUST hold its own thread-local SQLite
        # connection (SQLite forbids sharing across threads).  The
        # ``get_connection`` helper is already thread-local, so the
        # monkeypatch points each thread to the same DB path.
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))

        results: list[dict | None] = []
        results_lock = threading.Lock()
        ready = threading.Event()

        def _worker(worker_id: int) -> None:
            ready.wait()
            try:
                outcome = acquire_job(
                    target_job_id=job_id,
                    worker_id=worker_id,
                    approval_required=False,
                )
            except sqlite3.OperationalError:
                outcome = None
            finally:
                # Don't hold a connection in the worker thread we're
                # about to exit; the cache is per-thread anyway but
                # close keeps state clean for the asserts below.
                close_connection(db_path)
            with results_lock:
                results.append(outcome)

        t1 = threading.Thread(target=_worker, args=(1,))
        t2 = threading.Thread(target=_worker, args=(2,))
        t1.start()
        t2.start()
        ready.set()
        t1.join(timeout=10)
        t2.join(timeout=10)
        assert not t1.is_alive() and not t2.is_alive(), "worker thread hung"

        successes = [r for r in results if r is not None]
        assert len(successes) == 1, (
            f"expected exactly one acquire to succeed, got {len(successes)} (results={results!r})"
        )

        # Exactly one ``running`` row in ``job_stage_states.apply``.
        check_conn = get_connection(db_path)
        running_count = check_conn.execute(
            "SELECT COUNT(*) FROM job_stage_states WHERE job_url = ? AND stage = 'apply' AND state = 'running'",
            ("https://example.com/job",),
        ).fetchone()[0]
        assert running_count == 1
    finally:
        close_connection(db_path)


def test_record_job_event_default_publisher_refreshes_apply_run_projections(tmp_path, monkeypatch):
    """Reviewer-reported regression (PR 37 High #4): ``record_job_event``
    used to require the caller to thread a publisher through to fan out
    via the ``InProcessEventBus``; the projection's wildcard subscriber
    therefore never fired in the launcher's apply path.

    Now ``record_job_event`` defaults to the process-wide publisher,
    so a wildcard subscriber (the projection builder, in production)
    fires on every event.  After ``record_job_event`` returns + the
    projection refresh fires once, the ``apply_run_projections`` row is
    fresh.
    """
    from jobctrl.infrastructure.events import (
        get_default_publisher,
        reset_default_publisher,
    )

    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)
    reset_default_publisher()
    publisher = get_default_publisher()

    fired: list = []

    def _capture(event):
        fired.append(event.event_type)

    publisher.subscribe(None, _capture)

    try:
        record_job_event(
            conn,
            "https://example.com/job",
            "apply",
            "ApplyRunStarted",
            payload={
                "run_id": "run-fresh",
                "started_at": "2026-05-04T13:00:00+00:00",
                "model": "haiku",
                "worker_id": 0,
            },
        )
        conn.commit()
        # The wildcard subscriber fired (default publisher was used).
        assert "ApplyRunStarted" in fired

        record_job_event(
            conn,
            "https://example.com/job",
            "apply",
            "ApplicationSubmitted",
            payload={
                "run_id": "run-fresh",
                "result": "applied",
                "finished_at": "2026-05-04T13:01:00+00:00",
            },
        )
        conn.commit()
        ProjectionBuilder(conn_factory=lambda: conn).refresh()

        ar = conn.execute(
            "SELECT run_id, status FROM apply_run_projections WHERE job_id = ?",
            ("https://example.com/job",),
        ).fetchone()
        assert ar is not None
        assert ar["run_id"] == "run-fresh"
        assert ar["status"] == "succeeded"
    finally:
        reset_default_publisher()
        close_connection(db_path)


def test_record_job_event_from_worker_thread_refreshes_projection(
    tmp_path,
):
    """Reviewer-reported regression (PR 37 High, second iteration):
    when a worker thread calls ``record_job_event`` (now defaulted to
    publish through the bus), the wildcard subscriber
    ``ProjectionBuilder._on_event`` must refresh the projection — even
    though the bootstrap thread that wired the subscriber owns a
    different SQLite connection.

    Without the thread-local connection-factory fix, the subscriber
    blows up with ``sqlite3.ProgrammingError`` (SQLite objects can only
    be used in the thread that created them) and the broad ``except``
    in ``_on_event`` swallows it — the projection never updates.
    """
    import time as _time

    from jobctrl.infrastructure.events import (
        get_default_publisher,
        reset_default_publisher,
    )

    db_path = Path(tmp_path) / "jobs.db"
    bootstrap_conn = init_db(db_path)
    _insert_ready_job(bootstrap_conn)
    reset_default_publisher()

    # Wire the projection builder on the bootstrap thread the same way
    # ``cli._bootstrap`` does in production: pass a thread-local
    # connection factory so the wildcard subscriber can refresh from
    # any worker thread.
    builder = ProjectionBuilder(conn_factory=lambda: get_connection(db_path))
    subscription = builder.subscribe_to(get_default_publisher())

    worker_errors: list[BaseException] = []

    def _worker() -> None:
        try:
            worker_conn = get_connection(db_path)
            # Two events keyed by the same run_id so the projection
            # builder has a complete starting + terminal pair to fold.
            record_job_event(
                worker_conn,
                "https://example.com/job",
                "apply",
                "ApplyRunStarted",
                payload={
                    "run_id": "from-worker",
                    "started_at": "2026-05-04T13:00:00+00:00",
                    "model": "haiku",
                    "worker_id": 7,
                },
            )
            record_job_event(
                worker_conn,
                "https://example.com/job",
                "apply",
                "ApplicationSubmitted",
                payload={
                    "run_id": "from-worker",
                    "result": "applied",
                    "finished_at": "2026-05-04T13:01:00+00:00",
                    "duration_ms": 60000,
                },
            )
            worker_conn.commit()
        except BaseException as exc:  # noqa: BLE001 — propagate to assertions
            worker_errors.append(exc)

    t = threading.Thread(target=_worker, name="apply-worker-1")
    t.start()
    t.join(timeout=5.0)
    assert not t.is_alive(), "worker thread did not finish"
    assert not worker_errors, worker_errors

    try:
        # Poll briefly — the wildcard subscriber commits inline on the
        # worker thread so the projection should land within a tick or
        # two.  1s is plenty.
        deadline = _time.monotonic() + 1.0
        ar = None
        while _time.monotonic() < deadline:
            ar = bootstrap_conn.execute(
                "SELECT run_id, status FROM apply_run_projections WHERE job_id = ?",
                ("https://example.com/job",),
            ).fetchone()
            if ar is not None:
                break
            _time.sleep(0.05)

        assert ar is not None, (
            "apply_run_projections row never appeared — the wildcard subscriber did not refresh on the worker thread"
        )
        assert ar["run_id"] == "from-worker"
        assert ar["status"] == "succeeded"
    finally:
        try:
            subscription.unsubscribe()
        except Exception:  # noqa: BLE001
            pass
        reset_default_publisher()
        close_connection(db_path)


def test_apply_saga_writes_full_event_timeline_to_job_events(tmp_path, monkeypatch):
    """Reviewer-reported regression (PR 37 High #3): saga events
    (``SagaStarted`` / ``BrowserLaunched`` / ``AgentStarted`` /
    ``AgentResult`` / per-``AgentEvent``) used to be lost because
    saga checkpoints were not written until run end. The repository now persists
    the saga's intermediate timeline into ``job_events`` as checkpoints occur, so
    ``apply_run_projections.events_json`` reflects the complete
    timeline.
    """
    from jobctrl.apply.launcher import SqliteApplyRunRepository
    from jobctrl.domain.apply.aggregate import ApplyRun
    from jobctrl.domain.apply.value_objects import (
        Applied,
        ApplyRunId,
        TokenUsage,
    )
    from jobctrl.domain.identifiers import JobId
    from jobctrl.domain.tenant import LOCAL_TENANT

    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))

        # Seed the launcher-emitted ApplyRunStarted (acquire_job's job).
        run_ctx: dict = {}
        job = acquire_job(
            target_job_id=_target_job_id(conn),
            worker_id=1,
            run_ctx=run_ctx,
            approval_required=False,
        )
        assert job is not None
        run_id = run_ctx["run_id"]

        # Build an ApplyRun aggregate that records the saga's
        # intermediate event timeline (mimicking what the saga would
        # produce in production, without the heavyweight Chrome /
        # Claude Code adapters).
        run = ApplyRun.start(
            tenant_id=LOCAL_TENANT,
            run_id=ApplyRunId(run_id),
            job_id=JobId(job["url"]),
            started_at="2026-05-04T13:00:00+00:00",
            worker_id=1,
            model="haiku",
            dry_run=False,
            headless=False,
            attempts=1,
        )
        for event_type, payload in (
            ("SagaStarted", {"job_id": job["url"], "model": "haiku"}),
            ("BrowserLaunched", {"cdp_port": 9222, "pid": 1234}),
            ("AgentStarted", {"model": "haiku"}),
            # Agent-stream events forwarded by the Claude CLI adapter
            # (claude_code_cli.py emits ClaudeLaunched / AssistantText /
            # ToolUse).  Round-2 review (Medium): these used to be
            # dropped by the safelist; now they must land in
            # job_events too.
            ("ClaudeLaunched", {"pid": 4567}),
            ("AssistantText", {"text": "Filling in form"}),
            ("ToolUse", {"name": "browser_action", "input": {"action": "click"}}),
            ("AgentResult", {"kind": "applied", "duration_ms": 1500}),
        ):
            run = run.record_event(
                event_type=event_type,
                occurred_at="2026-05-04T13:00:01+00:00",
                level="info",
                payload=payload,
            )
        run = run.complete(
            result=Applied(applied_at="2026-05-04T13:01:00+00:00", verification_confidence=1.0),
            finished_at="2026-05-04T13:01:00+00:00",
            token_usage=TokenUsage(input=1, output=2, cost_usd=0.01),
            duration_ms=60000,
        )

        # The repository persists saga events once as the saga checkpoints progress.
        SqliteApplyRunRepository().save(run)

        # Mark the terminal applied result via the launcher.
        mark_result(
            job["url"],
            "applied",
            duration_ms=60000,
            run_ctx=run_ctx,
        )

        # The saga's intermediate timeline lands in job_events keyed by run_id.
        events = conn.execute(
            "SELECT event_type, payload_json FROM job_events "
            "WHERE job_url = ? AND stage = 'apply' ORDER BY event_id ASC",
            (job["url"],),
        ).fetchall()
        counts = Counter(evt["event_type"] for evt in events)
        recorded: dict[str, dict] = {}
        for evt in events:
            payload = json.loads(evt["payload_json"]) if evt["payload_json"] else {}
            recorded.setdefault(evt["event_type"], payload)

        assert "SagaStarted" in recorded, recorded
        assert "BrowserLaunched" in recorded, recorded
        assert "AgentStarted" in recorded, recorded
        assert "AgentResult" in recorded, recorded
        assert "ApplicationSubmitted" in recorded, recorded
        # Round-2 review (Medium): agent-stream events from the CLI
        # adapter must land too.
        assert "ClaudeLaunched" in recorded, recorded
        assert "AssistantText" in recorded, recorded
        assert "ToolUse" in recorded, recorded
        # Each saga event is keyed by the same run_id as the lifecycle.
        for evt_type in (
            "SagaStarted",
            "BrowserLaunched",
            "AgentStarted",
            "AgentResult",
            "ClaudeLaunched",
            "AssistantText",
            "ToolUse",
        ):
            assert recorded[evt_type].get("run_id") == run_id, (evt_type, recorded[evt_type])
            assert counts[evt_type] == 1, (evt_type, counts)

        # apply_run_projections.events_json carries the full timeline.
        ProjectionBuilder(conn_factory=lambda: get_connection(db_path)).refresh()
        ar = conn.execute(
            "SELECT events_json, status FROM apply_run_projections WHERE run_id = ?",
            (run_id,),
        ).fetchone()
        assert ar is not None
        assert ar["status"] == "succeeded"
        events_json = json.loads(ar["events_json"]) if ar["events_json"] else []
        event_types = [e.get("event_type") for e in events_json]
        for required in (
            "SagaStarted",
            "BrowserLaunched",
            "AgentStarted",
            "AgentResult",
            "ClaudeLaunched",
            "AssistantText",
            "ToolUse",
        ):
            assert required in event_types, (required, event_types)
            assert event_types.count(required) == 1, (required, event_types)
        # The ToolUse payload survives the round-trip into events_json.
        tool_use_entry = next(
            (e for e in events_json if e.get("event_type") == "ToolUse"),
            None,
        )
        assert tool_use_entry is not None
        assert tool_use_entry["payload"]["name"] == "browser_action"
        assert tool_use_entry["payload"]["input"] == {"action": "click"}
    finally:
        close_connection(db_path)


def test_dashboard_dry_runs_excludes_soft_deleted_jobs(tmp_path):
    """Reviewer-reported regression (PR 37 Low): the Python dashboard
    counter used to count soft-deleted jobs' dry-run rows; the TS
    counter excludes them.  Both writers update the same row so the
    user-visible value depended on which ran last.  Aligned now.
    """
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)

    # ``jobctrl_deleted_jobs`` is created on demand by the discovery
    # repository.  Create it here so the test seeds a tombstone.
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS jobctrl_deleted_jobs (
            job_url TEXT PRIMARY KEY,
            deleted_at TEXT NOT NULL,
            reason TEXT,
            restored_at TEXT,
            FOREIGN KEY(job_url) REFERENCES jobs(url)
        )
        """
    )
    conn.commit()

    try:
        # Two jobs, both with a dry-run apply lifecycle.
        for url in (
            "https://example.com/job-live",
            "https://example.com/job-deleted",
        ):
            conn.execute(
                "INSERT INTO jobs (url, title, site, fit_score, "
                "tailored_resume_path, application_url) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (url, "Eng", "ExampleCo", 9, "/tmp/r.txt", url),
            )
            record_job_event(
                conn,
                url,
                "apply",
                "ApplyRunStarted",
                payload={
                    "run_id": f"run-{url[-8:]}",
                    "started_at": "2026-05-04T13:00:00+00:00",
                    "dry_run": True,
                    "worker_id": 0,
                },
            )
            record_job_event(
                conn,
                url,
                "apply",
                "DryRunCompleted",
                payload={
                    "run_id": f"run-{url[-8:]}",
                    "result": "dry_run_complete",
                    "finished_at": "2026-05-04T13:01:00+00:00",
                    "dry_run": True,
                },
            )

        # Soft-delete the second job.
        conn.execute(
            "INSERT INTO jobctrl_deleted_jobs (job_url, deleted_at) VALUES (?, ?)",
            ("https://example.com/job-deleted", "2026-05-04T13:05:00+00:00"),
        )
        conn.commit()
        ProjectionBuilder(conn_factory=lambda: conn).refresh()

        dash = conn.execute("SELECT dry_runs FROM dashboard_projections LIMIT 1").fetchone()
        assert dash is not None
        # Only the live job's dry run is counted.
        assert dash["dry_runs"] == 1
    finally:
        close_connection(db_path)
