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
import uuid
from collections import Counter
from hashlib import sha256
from pathlib import Path

import pytest

from jobctrl.apply import launcher as launcher_module
from jobctrl import browser_capabilities
from jobctrl.apply.launcher import (
    acquire_job,
    mark_result,
    recover_ambiguous_running_apply,
    release_lock,
    worker_loop,
)
from jobctrl.apply.dashboard import get_recent_events
from jobctrl.apply.origins import canonical_http_url
from jobctrl.database import close_connection, get_connection, init_db
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder
from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state, utc_now
from jobctrl.workflow_specs import StartedWorkflowResult


LOCAL_TENANT = "local"


def _job_id_for(url: str) -> str:
    """Return the deterministic canonical identity for one test locator."""

    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"apply-regression:{url}"))


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
) -> str:
    job_id = _job_id_for(url)
    now = "2026-05-04T13:00:00+00:00"
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, site, discovered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            LOCAL_TENANT,
            job_id,
            url,
            "Platform Engineer",
            "ExampleCo",
            "ExampleCo",
            now,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value,
            is_current, first_seen_at, last_seen_at
        ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?)
        """,
        (LOCAL_TENANT, job_id, url, now, now),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description, application_url, updated_at
        ) VALUES (?, ?, 'enriched', 'Build distributed systems.', ?, ?)
        """,
        (LOCAL_TENANT, job_id, application_url, now),
    )
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json, keywords_json, scored_at
        ) VALUES (?, ?, 1, 9, '{}', '[]', ?)
        """,
        (LOCAL_TENANT, job_id, now),
    )
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES (?, ?, 1, 'approved', ?, ?)
        """,
        (LOCAL_TENANT, job_id, now, now),
    )
    for artifact_type, artifact_id, path in (
        ("tailored_resume", "resume-text-1", "/tmp/resume.txt"),
        ("resume_pdf", "resume-pdf-1", "/tmp/resume.pdf"),
    ):
        conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id,
                status, path, render_format, created_at
            ) VALUES (?, ?, 1, ?, ?, 'approved', ?, 'text', ?)
            """,
            (LOCAL_TENANT, job_id, artifact_type, artifact_id, path, now),
        )
    ensure_job_stage_rows(conn, job_id, tenant_id=LOCAL_TENANT)
    for stage in ("enrich", "score", "tailor"):
        set_stage_state(
            conn,
            job_id,
            stage,
            "succeeded",
            tenant_id=LOCAL_TENANT,
            finished_at=now,
            validate_transition=False,
        )
    from .availability_fixture import seed_fresh_availability

    seed_fresh_availability(conn, str(job_id), str(LOCAL_TENANT))
    conn.commit()
    return job_id


def _target_job_id(conn, url: str = "https://example.com/job") -> str:
    row = conn.execute(
        "SELECT job_id FROM jobs WHERE tenant_id = ? AND url = ? LIMIT 1",
        (LOCAL_TENANT, url),
    ).fetchone()
    assert row is not None
    return str(row["job_id"])


def _insert_blocked_score(conn, url: str, *, fit_score: int = 9) -> None:
    job_id = _job_id_for(url)
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json,
            keywords_json, scored_at, correction_json, criteria_json, trace_json
        ) VALUES (?, ?, 2, ?, ?, '["python"]', ?, NULL, '{}', '{}')
        """,
        (
            LOCAL_TENANT,
            job_id,
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


def _mark_closed(conn: sqlite3.Connection, url: str, state: str = "removed") -> None:
    job_id = _job_id_for(url)
    conn.execute(
        """
        INSERT INTO posting_snapshot_sets (
            tenant_id, job_id, snapshot_set_json, latest_snapshot_version,
            latest_active_state, updated_at
        ) VALUES (?, ?, '{}', 0, ?, ?)
        ON CONFLICT(tenant_id, job_id) DO UPDATE SET
            latest_active_state = excluded.latest_active_state,
            updated_at = excluded.updated_at
        """,
        (LOCAL_TENANT, job_id, state, utc_now()),
    )
    conn.commit()


def _insert_review_decision(
    conn: sqlite3.Connection,
    *,
    job_id: str | None = None,
    decision: str = "approve_submit",
    decided_at: str = "2026-01-01T00:00:00+00:00",
    decision_id: str | None = None,
    materials_generation: int | None = None,
    profile_version: int | None = None,
    application_url: str | None = None,
    partial_override_run_id: str | None = None,
) -> None:
    stable_job_id = job_id or _job_id_for("https://example.com/job")
    conn.execute(
        """
        INSERT INTO application_review_decisions (
            tenant_id, decision_id, job_id, decision, reason, decided_by, decided_at,
            materials_generation, profile_version, application_url, partial_override_run_id
        ) VALUES (?, ?, ?, ?, 'test', 'pytest', ?, ?, ?, ?, ?)
        """,
        (
            LOCAL_TENANT,
            decision_id or f"decision-{decision}-{decided_at}",
            stable_job_id,
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
    job_id: str | None = None,
    application_url: str = "https://example.com/apply",
    generation: int = 1,
    profile_version: int = 1,
    coverage: str | None = "full",
    run_id: str = "dry-run-full",
) -> None:
    stable_job_id = job_id or _job_id_for("https://example.com/job")
    now = "2026-01-01T00:00:00+00:00"
    conn.execute(
        """
        INSERT OR REPLACE INTO candidate_profiles (
            tenant_id, profile_id, version, updated_at
        ) VALUES (?, 'default', ?, ?)
        """,
        (LOCAL_TENANT, profile_version, now),
    )
    conn.execute(
        """
        INSERT OR REPLACE INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'approved', ?, ?)
        """,
        (LOCAL_TENANT, stable_job_id, generation, now, now),
    )
    for artifact_type, artifact_id, path in (
        ("tailored_resume", "resume-text-1", "/tmp/resume.txt"),
        ("resume_pdf", "resume-pdf-1", "/tmp/resume.pdf"),
    ):
        conn.execute(
            """
            INSERT OR REPLACE INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
                render_format, created_at
            ) VALUES (?, ?, ?, ?, ?, 'approved', ?, 'text', ?)
            """,
            (LOCAL_TENANT, stable_job_id, generation, artifact_type, artifact_id, path, now),
        )
    if coverage is not None:
        record_job_event(
            conn,
            stable_job_id,
            "apply",
            "ApplyRunStarted",
            tenant_id=LOCAL_TENANT,
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
            stable_job_id,
            "apply",
            "DryRunCompleted",
            tenant_id=LOCAL_TENANT,
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
    job_id = _insert_ready_job(conn)

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
        legacy = conn.execute(
            "SELECT apply_status FROM jobs WHERE tenant_id = ? AND job_id = ?",
            (LOCAL_TENANT, job_id),
        ).fetchone()
        assert legacy["apply_status"] is None
        # Canonical lock: stage row in 'running'.
        stage = conn.execute(
            "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (LOCAL_TENANT, job_id),
        ).fetchone()
        assert stage is not None
        assert stage["state"] == "running"
        # ApplyRunStarted event recorded with the same run_id.
        evt = conn.execute(
            "SELECT payload_json FROM job_events "
            "WHERE tenant_id = ? AND job_id = ? AND event_type = 'ApplyRunStarted' "
            "ORDER BY event_id DESC LIMIT 1",
            (LOCAL_TENANT, job_id),
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
    job_id = _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        prior_event_count = len(get_recent_events())
        assert acquire_job(target_job_id=_target_job_id(conn), worker_id=1) is None
        row = conn.execute(
            "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (LOCAL_TENANT, job_id),
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
    job_id = _insert_ready_job(conn)

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
            "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (LOCAL_TENANT, job_id),
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
        # A distinct candidate exercises approval bypass without stealing the
        # accepted first run's still-unsettled canonical owner.
        second_job = _insert_ready_job(conn, url="https://example.com/dry-approval")
        dry_job = acquire_job(
            target_job_id=second_job,
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
    job_id = _insert_ready_job(conn)
    _seed_current_apply_binding(conn, job_id=job_id)
    _insert_review_decision(
        conn,
        job_id=job_id,
        decision="approve_submit",
        decided_at="2026-01-01T00:00:00+00:00",
        decision_id="decision-old-approve",
        materials_generation=1,
        profile_version=1,
        application_url="https://example.com/apply",
    )
    _insert_review_decision(
        conn,
        job_id=job_id,
        decision="decline",
        decided_at="2026-01-02T00:00:00+00:00",
        decision_id="decision-new-decline",
    )

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        assert acquire_job(target_job_id=_target_job_id(conn), worker_id=1) is None
        _insert_review_decision(
            conn,
            job_id=job_id,
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
    job_id = _insert_ready_job(conn)
    _seed_current_apply_binding(conn, job_id=job_id, coverage=None)
    _insert_review_decision(
        conn,
        job_id=job_id,
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
    job_id = _insert_ready_job(conn)
    _seed_current_apply_binding(conn, job_id=job_id, coverage=None)

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
            dry_run_job["job_id"],
            "apply",
            "DryRunCompleted",
            tenant_id=LOCAL_TENANT,
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
            dry_run_job["job_id"],
            "dry_run",
            duration_ms=123,
            task_id=run_ctx["run_id"],
            run_ctx=run_ctx,
            tenant_id=LOCAL_TENANT,
        )
        completion = conn.execute(
            "SELECT payload_json FROM job_events "
            "WHERE tenant_id = ? AND job_id = ? AND event_type = 'DryRunCompleted' "
            "ORDER BY event_id DESC LIMIT 1",
            (LOCAL_TENANT, job_id),
        ).fetchone()
        assert completion is not None
        payload = json.loads(completion["payload_json"])
        assert payload["coverage"] == "full"
        assert payload["allowed_navigations"] == _run_bound_navigation("https://example.com/apply")
        assert payload["materials_generation"] == 1
        assert payload["application_url"] == "https://example.com/apply"

        _insert_review_decision(
            conn,
            job_id=job_id,
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
    job_id = _insert_ready_job(conn)
    _seed_current_apply_binding(conn, job_id=job_id, coverage=None)

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
            job_id,
            "dry_run",
            duration_ms=123,
            task_id=run_ctx["run_id"],
            run_ctx=run_ctx,
            tenant_id=LOCAL_TENANT,
        )
        completion = conn.execute(
            "SELECT payload_json FROM job_events "
            "WHERE tenant_id = ? AND job_id = ? AND event_type = 'DryRunCompleted' "
            "ORDER BY event_id DESC LIMIT 1",
            (LOCAL_TENANT, job_id),
        ).fetchone()
        assert completion is not None
        assert json.loads(completion["payload_json"])["coverage"] == "partial"

        _insert_review_decision(
            conn,
            job_id=job_id,
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
    job_id = _insert_ready_job(conn)
    _seed_current_apply_binding(conn, job_id=job_id)
    _insert_review_decision(
        conn,
        job_id=job_id,
        decision="approve_submit",
        **decision_bindings,
    )

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
    job_id = _insert_ready_job(conn)
    _seed_current_apply_binding(
        conn,
        job_id=job_id,
        coverage="partial",
        run_id="dry-run-partial",
    )
    _insert_review_decision(
        conn,
        job_id=job_id,
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
    job_id = _insert_ready_job(conn)
    _seed_current_apply_binding(
        conn,
        job_id=job_id,
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
        job_id=job_id,
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
    job_id = _insert_ready_job(conn)
    _seed_current_apply_binding(conn, job_id=job_id, coverage=None)
    if seed_stale_run:
        record_job_event(
            conn,
            job_id,
            "apply",
            "ApplyRunStarted",
            tenant_id=LOCAL_TENANT,
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
            job_id,
            "apply",
            "DryRunCompleted",
            tenant_id=LOCAL_TENANT,
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
        job_id=job_id,
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
        "tenant_id": LOCAL_TENANT,
        "job_id": _job_id_for("https://example.com/job"),
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
        from jobctrl.domain.apply.value_objects import DryRunComplete

        return DryRunComplete(navigated_to="", coverage="partial"), 10

    def fake_mark_result(job_id, status, **kwargs):
        marked["job_id"] = job_id
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
        "job_id": _job_id_for("https://example.com/job"),
        "status": "dry_run",
        "duration_ms": 10,
    }


def test_interrupt_cleanup_calls_only_owned_adapter_workers(monkeypatch):
    from jobctrl.apply.ownership import ApplyLauncherRun

    called = []
    monkeypatch.setattr(
        "jobctrl.infrastructure.apply.claude_code_cli.kill_active_claude_processes",
        lambda *, worker_ids: called.append(("agent", worker_ids)),
    )
    monkeypatch.setattr(
        "jobctrl.apply.chrome.cleanup_workers",
        lambda worker_ids: called.append(("browser", worker_ids)), raising=False,
    )
    run = ApplyLauncherRun(worker_ids=(31, 32))
    run.request_stop()
    assert run.stop_event.is_set()
    assert called == [("agent", (31,)), ("browser", (31,)), ("agent", (32,)), ("browser", (32,))]


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
    conn = init_db(db_path)

    monkeypatch.setattr(config_module, "APP_DIR", app_dir)
    monkeypatch.setattr(config_module, "DB_PATH", db_path)
    url = "https://example.com/blocked"
    job_id = _insert_ready_job(conn, url=url)
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
    monkeypatch.setattr(runner_module, "get_connection", lambda: conn)

    result = runner_module.run_single_job(url, do_tailor=True, do_apply=True)

    payload = specs[0].args[0]
    assert str(payload.job_id) == job_id
    assert payload.stages == ["enrich", "score", "tailor", "cover", "apply"]
    assert payload.expected_app_dir == str(app_dir)
    assert payload.expected_db_path == str(db_path)
    assert result["url"] == url
    assert result["workflowId"] == "workflow-single"
    assert result["stages_completed"] == ["enrich", "score", "tailor", "cover"]


def test_acquire_job_promotes_prior_apply_run_into_row_dict(tmp_path, monkeypatch):
    """When a prior failed apply run exists in ``apply_run_projections``,
    ``acquire_job`` promotes its status into the legacy
    ``apply_status`` slot."""
    db_path = Path(tmp_path) / "jobs.db"
    conn = init_db(db_path)
    job_id = _insert_ready_job(conn)
    # Seed prior failed apply via the canonical writer + projector.
    ensure_job_stage_rows(conn, job_id, tenant_id=LOCAL_TENANT)
    set_stage_state(
        conn,
        job_id,
        "apply",
        "failed",
        tenant_id=LOCAL_TENANT,
        finished_at="2026-01-01T00:01:00+00:00",
        attempt_count=1,
        validate_transition=False,
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplyRunStarted",
        tenant_id=LOCAL_TENANT,
        payload={
            "run_id": "run-prior",
            "started_at": "2026-01-01T00:00:00+00:00",
        },
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplicationFailed",
        tenant_id=LOCAL_TENANT,
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
    only in canonical ``job_enrichments`` on exact v10."""
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
    job_id = _insert_ready_job(conn, url=url, application_url=None)

    repo = SqliteEnrichmentRepository(conn)
    repo.save(
        JobEnrichment.empty(tenant_id=LOCAL_TENANT, job_id=JobId(job_id), updated_at="t0")
        .start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="t0")
        .succeed_attempt(
            full_description=FullDescription(text="Build distributed systems."),
            application_url=ApplicationUrl(value="https://example.com/apply-new"),
            extraction_tier=ExtractionTier.JSON_LD,
            finished_at="t1",
        )
    )
    assert "application_url" not in {row["name"] for row in conn.execute("PRAGMA table_info(jobs)")}

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
    job_id = _insert_ready_job(conn)

    try:
        monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
        assert acquire_job(target_job_id=job_id, run_ctx={"run_id": "run-test", "dry_run": True},
                           approval_required=False) is not None
        mark_result(
            job_id,
            "dry_run",
            duration_ms=123,
            task_id="run-test",
            tenant_id=LOCAL_TENANT,
        )
        ProjectionBuilder(conn_factory=lambda: get_connection(db_path)).refresh()

        row = conn.execute(
            "SELECT apply_status, applied_at, apply_task_id FROM jobs WHERE tenant_id = ? AND job_id = ?",
            (LOCAL_TENANT, job_id),
        ).fetchone()
        state = conn.execute(
            "SELECT state, error_code FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (LOCAL_TENANT, job_id),
        ).fetchone()
        # Legacy columns stay NULL on the new write path.
        assert row["apply_status"] is None
        assert row["applied_at"] is None
        assert row["apply_task_id"] is None
        assert state["state"] == "skipped"
        assert state["error_code"] == "DRY_RUN"
        # Canonical: an apply_run_projections row in dry_run_complete.
        ar = conn.execute(
            "SELECT run_id, status, dry_run FROM apply_run_projections WHERE tenant_id = ? AND job_id = ?",
            (LOCAL_TENANT, job_id),
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
            "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (LOCAL_TENANT, job["job_id"]),
        ).fetchone()
        assert before["state"] == "running"

        # Production sequence -- this used to raise ValueError.
        mark_result(
            job["job_id"],
            "dry_run",
            duration_ms=42,
            run_ctx=run_ctx,
            tenant_id=LOCAL_TENANT,
        )

        # (a) No exception (we got here).
        # (b) Stage row landed on Skipped.
        after = conn.execute(
            "SELECT state, error_code FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (LOCAL_TENANT, job["job_id"]),
        ).fetchone()
        assert after["state"] == "skipped"
        assert after["error_code"] == "DRY_RUN"

        # (c) apply_run_projections has a row for the run_id with dry_run=1
        # and a sensible terminal status, after refresh.
        ProjectionBuilder(conn_factory=lambda: get_connection(db_path)).refresh()
        ar = conn.execute(
            "SELECT run_id, status, dry_run FROM apply_run_projections WHERE tenant_id = ? AND job_id = ?",
            (LOCAL_TENANT, job["job_id"]),
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
            "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (LOCAL_TENANT, job["job_id"]),
        ).fetchone()
        assert before["state"] == "running"

        release_lock(job["job_id"], run_ctx=run_ctx, tenant_id=LOCAL_TENANT)

        after = conn.execute(
            "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (LOCAL_TENANT, job["job_id"]),
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
            "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (LOCAL_TENANT, job["job_id"]),
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
            job["job_id"],
            "apply",
            "ApplySubmitIntended",
            tenant_id=LOCAL_TENANT,
            message="apply submission intent recorded",
            payload={
                "tenant_id": LOCAL_TENANT,
                "job_id": job["job_id"],
                "run_id": run_ctx["run_id"],
                "material_version": "1",
                "intended_at": utc_now(),
            },
        )
        conn.commit()

        recovered = recover_ambiguous_running_apply()
        assert recovered == 1
        row = conn.execute(
            "SELECT state, error_code FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (LOCAL_TENANT, job["job_id"]),
        ).fetchone()
        assert row["state"] == "needs_verification"
        assert row["error_code"] == "APPLY_NEEDS_VERIFICATION"

        _insert_review_decision(
            conn,
            job_id=job["job_id"],
            decision="approve_submit",
        )
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
            "SELECT state FROM job_stage_states WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (LOCAL_TENANT, job["job_id"]),
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
            job["job_id"],
            "apply",
            "ApplySubmitIntended",
            tenant_id=LOCAL_TENANT,
            message="owned email application intent recorded",
            payload={
                "tenant_id": LOCAL_TENANT,
                "job_id": job["job_id"],
                "run_id": run_ctx["run_id"],
                "material_version": "1",
                "submission_channel": "email",
                "intended_at": utc_now(),
            },
        )
        conn.commit()

        mark_result(
            job["job_id"],
            "failed",
            "email_send_outcome_ambiguous:provider timed out after accepting request",
            run_ctx=run_ctx,
            tenant_id=LOCAL_TENANT,
        )

        row = conn.execute(
            "SELECT state, error_code, retryable, next_action "
            "FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'",
            (LOCAL_TENANT, job["job_id"]),
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
    job_id = _insert_ready_job(conn)
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
            "SELECT COUNT(*) FROM job_stage_states "
            "WHERE tenant_id = ? AND job_id = ? "
            "AND stage = 'apply' AND state = 'running'",
            (LOCAL_TENANT, job_id),
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
    job_id = _insert_ready_job(conn)
    reset_default_publisher()
    publisher = get_default_publisher()

    fired: list = []

    def _capture(event):
        fired.append(event.event_type)

    publisher.subscribe(None, _capture)

    try:
        record_job_event(
            conn,
            job_id,
            "apply",
            "ApplyRunStarted",
            tenant_id=LOCAL_TENANT,
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
            job_id,
            "apply",
            "ApplicationSubmitted",
            tenant_id=LOCAL_TENANT,
            payload={
                "run_id": "run-fresh",
                "result": "applied",
                "finished_at": "2026-05-04T13:01:00+00:00",
            },
        )
        conn.commit()
        ProjectionBuilder(conn_factory=lambda: conn).refresh()

        ar = conn.execute(
            "SELECT run_id, status FROM apply_run_projections WHERE tenant_id = ? AND job_id = ?",
            (LOCAL_TENANT, job_id),
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
    job_id = _insert_ready_job(bootstrap_conn)
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
                job_id,
                "apply",
                "ApplyRunStarted",
                tenant_id=LOCAL_TENANT,
                payload={
                    "run_id": "from-worker",
                    "started_at": "2026-05-04T13:00:00+00:00",
                    "model": "haiku",
                    "worker_id": 7,
                },
            )
            record_job_event(
                worker_conn,
                job_id,
                "apply",
                "ApplicationSubmitted",
                tenant_id=LOCAL_TENANT,
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
                "SELECT run_id, status FROM apply_run_projections WHERE tenant_id = ? AND job_id = ?",
                (LOCAL_TENANT, job_id),
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
            job_id=JobId(job["job_id"]),
            started_at="2026-05-04T13:00:00+00:00",
            worker_id=1,
            model="haiku",
            dry_run=False,
            headless=False,
            attempts=1,
        )
        for event_type, payload in (
            ("SagaStarted", {"job_id": job["job_id"], "model": "haiku"}),
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
            job["job_id"],
            "applied",
            duration_ms=60000,
            run_ctx=run_ctx,
            tenant_id=LOCAL_TENANT,
        )

        # The saga's intermediate timeline lands in job_events keyed by run_id.
        events = conn.execute(
            "SELECT event_type, payload_json FROM job_events "
            "WHERE tenant_id = ? AND job_id = ? AND stage = 'apply' "
            "ORDER BY event_id ASC",
            (LOCAL_TENANT, job["job_id"]),
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
        # Canonical tool input survives; broad projections retain only references.
        tool_use_entry = next(
            (e for e in events_json if e.get("event_type") == "ToolUse"),
            None,
        )
        assert tool_use_entry is not None
        assert recorded["ToolUse"]["name"] == "browser_action"
        assert recorded["ToolUse"]["input"] == {"action": "click"}
        assert "name" not in tool_use_entry["payload"]
        assert "input" not in tool_use_entry["payload"]
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

    try:
        # Two jobs, both with a dry-run apply lifecycle.
        job_ids: dict[str, str] = {}
        for url in (
            "https://example.com/job-live",
            "https://example.com/job-deleted",
        ):
            job_ids[url] = _insert_ready_job(conn, url=url, application_url=url)
            record_job_event(
                conn,
                job_ids[url],
                "apply",
                "ApplyRunStarted",
                tenant_id=LOCAL_TENANT,
                payload={
                    "run_id": f"run-{url[-8:]}",
                    "started_at": "2026-05-04T13:00:00+00:00",
                    "dry_run": True,
                    "worker_id": 0,
                },
            )
            record_job_event(
                conn,
                job_ids[url],
                "apply",
                "DryRunCompleted",
                tenant_id=LOCAL_TENANT,
                payload={
                    "run_id": f"run-{url[-8:]}",
                    "result": "dry_run_complete",
                    "finished_at": "2026-05-04T13:01:00+00:00",
                    "dry_run": True,
                },
            )

        # Soft-delete the second job.
        conn.execute(
            "INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at) VALUES (?, ?, ?)",
            (
                LOCAL_TENANT,
                job_ids["https://example.com/job-deleted"],
                "2026-05-04T13:05:00+00:00",
            ),
        )
        conn.commit()
        ProjectionBuilder(conn_factory=lambda: conn).refresh()

        dash = conn.execute("SELECT dry_runs FROM dashboard_projections LIMIT 1").fetchone()
        assert dash is not None
        # Only the live job's dry run is counted.
        assert dash["dry_runs"] == 1
    finally:
        close_connection(db_path)


# REL-002: exercise the production sender, saga, repository and launcher with
# synthetic storage and fake HTTP only. No external message can be sent.
_INVALID_SEND_RESPONSES = [
    (204, b""), (200, b""), (200, b"{"), (200, b"null"),
    (200, b"[]"), (200, b'"private-provider-canary"'),
    (200, b"{}"), (200, b'{"id":null}'), (200, b'{"id":""}'),
    (200, b'{"id":"   "}'), (200, b'{"id":42}'), (200, b'{"id":true}'),
    (200, b'{"id":[]}'), (200, b'{"id":{}}'),
    (200, b'{"id":"m1","threadId":null}'), (200, b'{"id":"m1","threadId":""}'),
    (200, b'{"id":"m1","threadId":"  "}'), (200, b'{"id":"m1","threadId":12}'),
    (200, b'{"id":"m1","threadId":false}'), (200, b'{"id":"m1","threadId":[]}'),
    (200, b'{"id":"m1","threadId":{}}'),
    (200, b'{"id":"m1","payload":NaN}'),
    (200, b'{"id":"m1","payload":Infinity}'),
    (200, b'{"id":"m1","payload":-Infinity}'),
    (200, b'{"id":"m1","payload":{"parts":[NaN]}}'),
    (400, b'{"error":"private-provider-canary"}'),
    (401, b'{"error":"private-provider-canary"}'),
    (429, b'{"error":"private-provider-canary"}'),
    (500, b'{"error":"private-provider-canary"}'),
]


def _owned_email_probe(tmp_path, monkeypatch, *, status=200, body=b'{"id":"m1"}', sender_factory=None, live_bus=False, agent_factory=None):
    import httpx
    from contextlib import nullcontext
    from jobctrl.domain.apply import ApplyRun, ApplyRunId
    from jobctrl.domain.apply.process_manager import ApplySaga
    from jobctrl.domain.tenant import TenantId
    from jobctrl.infrastructure.apply.email_sender import GmailEmailApplicationSender
    from jobctrl.infrastructure.gmail.client import GmailClient
    from .test_apply_saga import _FakeAgent, _FakeBrowser, _prompt

    db_path = tmp_path / "owned-email.db"
    conn = init_db(db_path)
    job_id = _insert_ready_job(conn)
    monkeypatch.setattr(launcher_module, "get_connection", lambda: get_connection(db_path))
    ctx = {"workflow_id": "owned-email-fixture"}
    assert acquire_job(target_job_id=job_id, worker_id=1, run_ctx=ctx, approval_required=False)
    attachment = tmp_path / "accepted.pdf"
    attachment.write_bytes(b"%PDF synthetic accepted material\n")
    conn.execute("UPDATE job_materials_artifacts SET path=? WHERE tenant_id='local' AND job_id=? AND artifact_id='resume-pdf-1'", (str(attachment), job_id))
    conn.commit()
    _insert_review_decision(conn, job_id=job_id, decision_id="preserved-owned-review", materials_generation=1)
    preserved_materials = [tuple(row) for row in conn.execute("SELECT * FROM job_materials WHERE job_id=?", (job_id,))]
    preserved_artifacts = [tuple(row) for row in conn.execute("SELECT * FROM job_materials_artifacts WHERE job_id=? ORDER BY artifact_id", (job_id,))]
    preserved_reviews = [tuple(row) for row in conn.execute("SELECT * FROM application_review_decisions WHERE job_id=?", (job_id,))]
    calls = []
    def http_send(request):
        calls.append(request.url.path)
        if body == b"lost-ack":
            raise httpx.ReadTimeout("private-provider-canary", request=request)
        return httpx.Response(status, content=body)
    monkeypatch.setattr("jobctrl.infrastructure.gmail.client._ensure_send_scope", lambda: None)
    monkeypatch.setattr("jobctrl.infrastructure.gmail.client.get_access_token", lambda: "synthetic")
    client = GmailClient(http=httpx.Client(transport=httpx.MockTransport(http_send)))
    sender = GmailEmailApplicationSender(client=client)
    if sender_factory:
        sender = sender_factory(sender)
    repo = launcher_module.SqliteApplyRunRepository()
    from dataclasses import replace
    class PrivateEmailAgent(_FakeAgent):
        def submit_application(self, **kwargs):
            result = super().submit_application(**kwargs)
            return replace(result, raw_output=result.raw_output + " private-agent-result-canary")
    agent = PrivateEmailAgent(behaviour="email_only")
    if agent_factory:
        agent = agent_factory(agent)
    saga = ApplySaga(browser_port=_FakeBrowser(), agent_port=agent,
                     repository=repo, email_sender=sender, availability_authorizer=lambda *_: nullcontext())
    run = ApplyRun.start(tenant_id=TenantId("local"), run_id=ApplyRunId(ctx["run_id"]),
                         job_id=job_id, started_at=utc_now(), worker_id=1, model="synthetic")
    from jobctrl.domain.apply.use_cases import SubmitApplicationUseCase
    from jobctrl.domain.apply.services import ApplyEligibilityChecker
    from .test_apply_use_cases import _CapturingPublisher, _FakeSnapshot, _ready_job
    publisher = _CapturingPublisher()
    if live_bus:
        from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
        publisher = InProcessEventBus()
        publisher.events = []
        publisher.durable_success = []
        def observe(event):
            if event.event_type in {"EmailApplicationSent", "ApplicationSubmitted"}:
                with sqlite3.connect(db_path) as observer:
                    counts = _email_counts(observer, job_id)
                    publisher.durable_success.append((event.event_type, counts["EmailApplicationSent"], counts["ApplicationSubmitted"]))
        publisher.subscribe(None, observe)
        publisher.subscribe(None, publisher.events.append)
        ProjectionBuilder(conn_factory=lambda: get_connection(db_path)).subscribe_to(publisher)
    monkeypatch.setattr("jobctrl.infrastructure.events.get_default_publisher", lambda: publisher)
    class Snapshot(_FakeSnapshot):
        def as_dict(self):
            values = super().as_dict()
            values["personal"]["full_name"] = "private-candidate-canary"
            return values
    class PromptBuilder:
        def build(self, **_kwargs):
            return _prompt()
    use_case = SubmitApplicationUseCase(repository=repo, browser_port=saga._browser,
        agent_port=saga._agent, saga=saga, publisher=publisher, prompt_builder=PromptBuilder(),
        eligibility_checker=ApplyEligibilityChecker(max_attempts=3),
        url_safety_checker=lambda _: True)
    job = {**_ready_job(), "job_id": job_id, "materials_generation": 1,
        "full_description": "Send resumes to apply@example.com for consideration.",
        "resume_pdf_path": str(attachment), "resume_pdf_artifact_id": "resume-pdf-1",
        "approved_email_recipient": "apply@example.com", "approved_email_attachment_artifact_id": "resume-pdf-1"}
    def assert_preserved():
        current = get_connection(db_path)
        assert [tuple(row) for row in current.execute("SELECT * FROM job_materials WHERE job_id=?", (job_id,))] == preserved_materials
        assert [tuple(row) for row in current.execute("SELECT * FROM job_materials_artifacts WHERE job_id=? ORDER BY artifact_id", (job_id,))] == preserved_artifacts
        assert [tuple(row) for row in current.execute("SELECT * FROM application_review_decisions WHERE job_id=?", (job_id,))] == preserved_reviews
        assert attachment.read_bytes() == b"%PDF synthetic accepted material\n"
    def execute(*, require_durable_success=True):
        try:
            outcome = use_case.execute(tenant_id=TenantId("local"), job=job, snapshot=Snapshot(),
                                       worker_id=1, cdp_port=9222, run_id=run.run_id, model="synthetic")
        finally:
            assert_preserved()
        assert "private-candidate-canary" not in str(publisher.events)
        assert "private-provider-canary" not in str(publisher.events)
        assert "private-agent-result-canary" not in str(publisher.events)
        assert "apply@example.com" not in str(publisher.events)
        successes = Counter(event.event_type for event in publisher.events)
        if require_durable_success:
            assert successes["EmailApplicationSent"] == successes["ApplicationSubmitted"] == int(outcome.apply_run.is_succeeded)
        current = get_connection(db_path)
        candidate = current.execute("SELECT payload_json FROM job_events WHERE event_type='EmailApplicationCandidateRecorded' AND job_id=?", (job_id,)).fetchone()
        assert candidate and "private-candidate-canary" in candidate[0]
        return outcome
    execute.use_case = use_case
    execute.job = {**job, "tenant_id": "local"}
    execute.snapshot = Snapshot()
    execute.assert_preserved = assert_preserved
    execute.publisher_events = publisher.events
    execute.durable_success = getattr(publisher, "durable_success", [])
    return db_path, conn, job_id, ctx, calls, repo, execute, attachment


def _email_counts(conn, job_id):
    return Counter(row[0] for row in conn.execute(
        "SELECT event_type FROM job_events WHERE tenant_id='local' AND job_id=?", (job_id,)))


@pytest.mark.parametrize("owned_publisher", [False, True])
@pytest.mark.parametrize("finish", ["commit", "rollback"])
def test_email_send_requires_committed_intent_without_committing_caller_transaction(tmp_path, monkeypatch, owned_publisher, finish):
    db_path, conn, job_id, ctx, calls, _, execute, _ = _owned_email_probe(tmp_path, monkeypatch)
    try:
        if owned_publisher:
            execute.use_case._publisher = launcher_module._OwnedApplyPublisher(execute.use_case._publisher)
        conn.execute("BEGIN")
        conn.execute("UPDATE jobs SET title=? WHERE job_id=?", ("caller-uncommitted-title", job_id))
        outcome = execute(require_durable_success=False)  # The injected authorizer does not commit.
        assert calls == []
        assert not outcome.apply_run.is_succeeded
        assert conn.in_transaction
        with sqlite3.connect(db_path) as observer:
            assert _email_counts(observer, job_id)["ApplySubmitIntended"] == 0
            assert observer.execute("SELECT title FROM jobs WHERE job_id=?", (job_id,)).fetchone()[0] != "caller-uncommitted-title"
        if owned_publisher:
            assert not any(event.event_type == "ApplyRunStarted" for event in execute.publisher_events)
        getattr(conn, finish)()
        assert _email_counts(conn, job_id)["ApplySubmitIntended"] == int(finish == "commit")
        assert (conn.execute("SELECT title FROM jobs WHERE job_id=?", (job_id,)).fetchone()[0] == "caller-uncommitted-title") == (finish == "commit")
        assert calls == []
        if owned_publisher:
            assert sum(event.event_type == "ApplyRunStarted" for event in execute.publisher_events) == int(finish == "commit")
    finally:
        close_connection(db_path)


def test_owned_email_wrappers_publish_after_atomic_settlement(tmp_path, monkeypatch):
    db_path, conn, job_id, ctx, calls, _, execute, _ = _owned_email_probe(tmp_path, monkeypatch, live_bus=True)
    try:
        publisher = execute.use_case._publisher
        execute.use_case._publisher = launcher_module._OwnedApplyPublisher(publisher)
        outcome = execute()
        wrappers = [event for event in execute.publisher_events if event.event_type == "ApplyRunEventRecorded"]
        assert [event.payload["event"]["event_id"] for event in wrappers] == [event.event_id for event in outcome.apply_run.events]
        assert all(event.payload["run_id"] == ctx["run_id"] for event in wrappers)
        assert len(calls) == 1
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == "succeeded"
        assert _email_counts(conn, job_id)["ApplicationSubmitted"] == 1
    finally:
        close_connection(db_path)


@pytest.mark.parametrize("authorizer", ["no_op", "production"])
def test_email_sender_observes_committed_owned_intent(tmp_path, monkeypatch, authorizer):
    observed = []
    def wrap(sender):
        class ObservingSender:
            def send_email_application(self, candidate, *, operation):
                with sqlite3.connect(db_path) as observer:
                    row = observer.execute(
                        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND event_type='ApplySubmitIntended'",
                        (operation.tenant_id, operation.job_id),
                    ).fetchone()
                    assert row and json.loads(row[0])["operation"]["intent_id"] == operation.intent_id
                    observed.append(operation.run_id)
                return sender.send_email_application(candidate, operation=operation)
        return ObservingSender()
    db_path, conn, job_id, ctx, calls, _, execute, _ = _owned_email_probe(tmp_path, monkeypatch, sender_factory=wrap)
    try:
        if authorizer == "production":
            monkeypatch.setattr("jobctrl.enrichment.availability.require_fresh_active", lambda *_a, **_kw: None)
            monkeypatch.setattr("jobctrl.enrichment.availability.assert_fresh_candidate", lambda *_a, **_kw: None)
            execute.use_case._saga._availability_authorizer = launcher_module._authorize_posting_before_submit
        outcome = execute()
        assert outcome.apply_run.is_succeeded
        assert observed == [ctx["run_id"]] and len(calls) == 1
    finally:
        close_connection(db_path)


def test_settled_email_wrappers_reject_forgery_and_successor(tmp_path, monkeypatch):
    from dataclasses import replace
    from jobctrl.domain.events.apply import ApplyRunEventRecordedPayload, create_apply_run_event_recorded
    from jobctrl.domain.tenant import TenantId

    db_path, conn, job_id, ctx, calls, _, execute, _ = _owned_email_probe(tmp_path, monkeypatch)
    try:
        publisher = launcher_module._OwnedApplyPublisher(execute.use_case._publisher)
        execute.use_case._publisher = publisher
        execute()
        wrappers = [event for event in execute.publisher_events if event.event_type == "ApplyRunEventRecorded"]
        public = next(event for event in wrappers if event.payload["event"]["event_type"] == "SagaStarted")
        private = next(event for event in wrappers if event.payload["event"]["event_type"] == "AgentResult")
        for original, changes in [
            (public, {"event_id": 99999}),
            (public, {"event_type": "FakeEvent"}),
            (public, {"message": "forged message"}),
            (private, {"message": "private-forged-canary"}),
        ]:
            forged = replace(original, payload={**original.payload, "event": {**original.payload["event"], **changes}})
            with pytest.raises(launcher_module.ApplyOwnershipLost):
                publisher.publish(forged)
        foreign = create_apply_run_event_recorded(TenantId("foreign"),
            ApplyRunEventRecordedPayload(run_id=ctx["run_id"], event=public.payload["event"]))
        with pytest.raises(launcher_module.ApplyOwnershipLost):
            publisher.publish(foreign)
        conn.execute("BEGIN")
        publisher.publish(public)
        assert sum(event is public for event in execute.publisher_events) == 1
        conn.rollback()
        assert sum(event is public for event in execute.publisher_events) == 1
        conn.execute("BEGIN")
        publisher.publish(public)
        conn.commit()
        assert sum(event is public for event in execute.publisher_events) == 2
        set_stage_state(conn, job_id, "apply", "running", validate_transition=False)
        record_job_event(conn, job_id, "apply", "ApplyClaimAcquired",
                         payload={"run_id": "synthetic-successor", "launcher_id": "successor-owner"})
        conn.commit()
        with pytest.raises(launcher_module.ApplyOwnershipLost):
            publisher.publish(public)
        assert len(calls) == 1 and _email_counts(conn, job_id)["ApplicationSubmitted"] == 1
    finally:
        close_connection(db_path)


def test_deferred_wrapper_is_discarded_after_caller_savepoint_rollback(tmp_path, monkeypatch):
    from jobctrl.domain.apply import ApplyRun, ApplyRunId
    from jobctrl.domain.events.apply import ApplyRunEventRecordedPayload, create_apply_run_event_recorded
    from jobctrl.domain.tenant import TenantId

    db_path, conn, job_id, ctx, _, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch)
    try:
        publisher = launcher_module._OwnedApplyPublisher(execute.use_case._publisher)
        run = ApplyRun.start(tenant_id=TenantId("local"), run_id=ApplyRunId(ctx["run_id"]),
                             job_id=job_id, started_at=utc_now(), worker_id=1, model="synthetic")
        run = run.record_event(event_type="SagaStarted", occurred_at=utc_now(), payload={})
        event = create_apply_run_event_recorded(TenantId("local"),
            ApplyRunEventRecordedPayload(run_id=ctx["run_id"], event=run.events[0].to_dict()))
        conn.execute("BEGIN")
        conn.execute("SAVEPOINT discard_event")
        repo.save(run)
        publisher.publish(event)
        conn.execute("ROLLBACK TO discard_event")
        conn.execute("RELEASE discard_event")
        conn.commit()
        assert _email_counts(conn, job_id)[run.events[0].event_type] == 0
        assert not any(item.event_type == "ApplyRunEventRecorded" for item in execute.publisher_events)
    finally:
        close_connection(db_path)


@pytest.mark.parametrize("status,body", _INVALID_SEND_RESPONSES + [(200, b"lost-ack")])
def test_malformed_http_confirmation_never_applies_after_intent(tmp_path, monkeypatch, status, body, record_property):
    from jobctrl.domain.apply import Failed
    db_path, conn, job_id, ctx, calls, repo, execute, attachment = _owned_email_probe(
        tmp_path, monkeypatch, status=status, body=body)
    before = sha256(attachment.read_bytes()).hexdigest()
    try:
        outcome = execute()
        assert isinstance(outcome.apply_run.submission_result, Failed)
        assert outcome.apply_run.submission_result.retryable is False
        # Even an incorrect caller cannot bypass the durable receipt gate.
        mark_result(job_id, "applied", run_ctx=ctx)
        assert _email_counts(conn, job_id)["ApplySubmitIntended"] == 1
        assert _email_counts(conn, job_id)["EmailApplicationSent"] == 0
        assert _email_counts(conn, job_id)["ApplicationSubmitted"] == 0
        assert _email_counts(conn, job_id)["ApplicationFailed"] == 1
        row = conn.execute("SELECT state,retryable FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()
        assert tuple(row) == ("needs_verification", 0)
        ProjectionBuilder(conn_factory=lambda: conn).refresh()
        projection = conn.execute("SELECT status,result,events_json FROM apply_run_projections WHERE run_id=?", (ctx["run_id"],)).fetchone()
        assert projection[0] != "succeeded" and projection[1] != "applied"
        assert "private-candidate-canary" not in projection[2]
        assert "private-provider-canary" not in projection[2]
        close_connection(db_path)
        conn = get_connection(db_path)  # actual connection interruption/restart
        assert recover_ambiguous_running_apply() == 0
        for target in (job_id, None):
            assert acquire_job(target_job_id=target, worker_id=2, run_ctx={}, approval_required=False) is None
        assert len(calls) == 1
        assert sha256(attachment.read_bytes()).hexdigest() == before
        failures = conn.execute("SELECT payload_json FROM job_events WHERE event_type='EmailApplicationSendFailed'").fetchall()
        assert "private-provider-canary" not in str([tuple(row) for row in failures])
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


@pytest.mark.parametrize("body", [b'{"id":"opaque / arbitrary ID"}', b'{"id":"m1","threadId":"t1"}',
    b'{"id":"m1","payload":{"body":"private-provider-canary"},"unknown":null}',
    b'{"id":"m1","payload":"NaN Infinity -Infinity"}',
    b'{"id":"m1","payload":{"number":1e400,"other":true}}'])
def test_valid_confirmation_settles_once_and_recovers_lost_ack(tmp_path, monkeypatch, body, record_property):
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch, body=body)
    try:
        outcome = execute()
        assert outcome.apply_run.is_succeeded
        repo.save(outcome.apply_run)  # repeated persistence acknowledgement
        close_connection(db_path)
        conn = get_connection(db_path)
        # Confirmation, submitted fact and stage survived a lost acknowledgement.
        assert recover_ambiguous_running_apply() == 0
        mark_result(job_id, "applied", run_ctx=ctx)
        counts = _email_counts(conn, job_id)
        assert (len(calls), counts["ApplySubmitIntended"], counts["EmailApplicationSent"], counts["ApplicationSubmitted"]) == (1, 1, 1, 1)
        assert sum(event.event_type == "ApplicationSubmitted" for event in execute.publisher_events) == 1
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == "succeeded"
        assert "private-provider-canary" not in str([tuple(r) for r in conn.execute("SELECT payload_json FROM job_events")])
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


@pytest.mark.parametrize("identity", ["absent", "foreign_context", "foreign_task", "conflicting", "foreign_context_with_owned_task"])
@pytest.mark.parametrize("status", ["applied", "dry_run", "failed"])
def test_email_settlement_resolves_durable_owner_before_legacy_fallback(tmp_path, monkeypatch, identity, status, record_property):
    db_path, conn, job_id, ctx, calls, _, execute, _ = _owned_email_probe(tmp_path, monkeypatch, body=b"{}")
    try:
        execute()
        kwargs = {
            "absent": {},
            "foreign_context": {"run_ctx": {"run_id": "foreign-run"}},
            "foreign_task": {"task_id": "foreign-run"},
            "conflicting": {"task_id": "foreign-run", "run_ctx": ctx},
            "foreign_context_with_owned_task": {"task_id": ctx["run_id"], "run_ctx": {"run_id": "foreign-run"}},
        }[identity]
        mark_result(job_id, status, **kwargs)
        counts = _email_counts(conn, job_id)
        assert (len(calls), counts["ApplySubmitIntended"], counts["EmailApplicationSent"], counts["ApplicationSubmitted"], counts["DryRunCompleted"]) == (1, 1, 0, 0, 0)
        if identity == "absent":
            failure = conn.execute("SELECT payload_json FROM job_events WHERE job_id=? AND event_type='ApplicationFailed'", (job_id,)).fetchone()
            assert json.loads(failure[0])["run_id"] == ctx["run_id"]
        else:
            # A foreign caller cannot settle or abandon the current operation.
            assert counts["ApplicationFailed"] == 0
            assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == "running"
        close_connection(db_path)
        conn = get_connection(db_path)
        assert recover_ambiguous_running_apply() == int(identity != "absent")
        assert tuple(conn.execute("SELECT state,retryable FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()) == ("needs_verification", 0)
        for target in (job_id, None):
            assert acquire_job(target_job_id=target, worker_id=2, run_ctx={}, approval_required=False) is None
        execute.assert_preserved()
        assert len(calls) == 1
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


@pytest.mark.parametrize("identity", [None, "foreign-run"])
@pytest.mark.parametrize("confirmed", [False, True])
def test_email_settlement_locks_owner_resolution_and_preserves_receipt(tmp_path, monkeypatch, identity, confirmed, record_property):
    db_path, conn, job_id, ctx, calls, _, execute, _ = _owned_email_probe(
        tmp_path, monkeypatch, body=b'{"id":"m1"}' if confirmed else b"{}", live_bus=True)
    try:
        execute()
        original_lookup = launcher_module._latest_apply_run_started_run_id
        observed = []
        def locked_lookup(current, **kwargs):
            assert current.in_transaction
            # Another independent writer cannot change ownership after this read.
            with sqlite3.connect(db_path, timeout=0) as competitor:
                with pytest.raises(sqlite3.OperationalError, match="locked"):
                    competitor.execute("BEGIN IMMEDIATE")
            observed.append(True)
            return original_lookup(current, **kwargs)
        monkeypatch.setattr(launcher_module, "_latest_apply_run_started_run_id", locked_lookup)
        for _ in range(2):
            mark_result(job_id, "applied", task_id=identity)
        assert observed
        monkeypatch.setattr(launcher_module, "_latest_apply_run_started_run_id", original_lookup)
        if not confirmed and identity:
            assert recover_ambiguous_running_apply() == 1
        counts = _email_counts(conn, job_id)
        assert (len(calls), counts["ApplySubmitIntended"], counts["EmailApplicationSent"], counts["ApplicationSubmitted"]) == (1, 1, int(confirmed), int(confirmed))
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == ("succeeded" if confirmed else "needs_verification")
        assert sum(event.event_type == "ApplicationSubmitted" for event in execute.publisher_events) == int(confirmed)
        execute.assert_preserved()
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


@pytest.mark.parametrize("finish", ["commit", "rollback"])
def test_identityless_email_settlement_respects_inherited_transaction(tmp_path, monkeypatch, finish, record_property):
    db_path, conn, job_id, ctx, calls, _, execute, _ = _owned_email_probe(tmp_path, monkeypatch, body=b"{}")
    try:
        execute()
        conn.execute("BEGIN")
        mark_result(job_id, "applied")
        assert conn.in_transaction
        with sqlite3.connect(db_path) as observer:
            assert observer.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == "running"
            assert _email_counts(observer, job_id)["ApplicationSubmitted"] == 0
        getattr(conn, finish)()
        assert recover_ambiguous_running_apply() == int(finish == "rollback")
        failure = conn.execute("SELECT payload_json FROM job_events WHERE job_id=? AND event_type='ApplicationFailed'", (job_id,)).fetchone()
        if finish == "commit":
            assert json.loads(failure[0])["run_id"] == ctx["run_id"]
        else:
            # Recovery parks uncertainty without inventing a terminal result.
            assert failure is None
        counts = _email_counts(conn, job_id)
        assert (len(calls), counts["ApplySubmitIntended"], counts["EmailApplicationSent"], counts["ApplicationSubmitted"], counts["ApplicationFailed"]) == (1, 1, 0, 0, int(finish == "commit"))
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == "needs_verification"
        for target in (job_id, None):
            assert acquire_job(target_job_id=target, worker_id=2, run_ctx={}, approval_required=False) is None
        execute.assert_preserved()
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


@pytest.mark.parametrize("field,value", [("provider", "foreign"), ("message_id", ""), ("message_id", 3),
    ("thread_id", 3), ("thread_id", ""), ("operation", None),
    ("tenant_id", "foreign"), ("job_id", "foreign"), ("run_id", "foreign"),
    ("intent_id", "foreign"), ("material_version", "99"), ("candidate_fingerprint", "foreign"),
    ("receipt", None), ("receipt", {})])
def test_foreign_or_malformed_internal_receipt_cannot_confirm(tmp_path, monkeypatch, field, value, record_property):
    from dataclasses import replace
    from jobctrl.domain.apply import Failed
    def wrap(sender):
        class ForgedSender:
            def send_email_application(self, candidate, *, operation):
                receipt = sender.send_email_application(candidate, operation=operation)
                if field == "receipt":
                    return value
                if field in {"provider", "message_id", "thread_id", "operation"}:
                    return replace(receipt, **{field: value})
                return replace(receipt, operation=replace(operation, **{field: value}))
        return ForgedSender()
    db_path, conn, job_id, ctx, calls, _, execute, _ = _owned_email_probe(tmp_path, monkeypatch, sender_factory=wrap)
    try:
        assert isinstance(execute().apply_run.submission_result, Failed)
        mark_result(job_id, "applied", run_ctx=ctx)
        counts = _email_counts(conn, job_id)
        assert (len(calls), counts["ApplySubmitIntended"], counts["EmailApplicationSent"], counts["ApplicationSubmitted"]) == (1, 1, 0, 0)
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


@pytest.mark.parametrize("boundary", ["malformed_before_terminal", "confirmation_write_failure", "submitted_fact_write_failure", "confirmation_ack_lost"])
def test_email_restart_at_persistence_boundaries(tmp_path, monkeypatch, boundary, record_property):
    body = b"{}" if boundary == "malformed_before_terminal" else b'{"id":"m1"}'
    db_path, conn, job_id, ctx, calls, repo, execute, attachment = _owned_email_probe(tmp_path, monkeypatch, body=body, live_bus=True)
    preserved = attachment.read_bytes()
    real_save = repo.save
    def save(run, **kwargs):
        if run.is_terminal:
            if boundary == "confirmation_ack_lost":
                real_save(run, **kwargs)
            raise RuntimeError("synthetic interruption before terminal acknowledgement")
        return real_save(run, **kwargs)
    if boundary in {"confirmation_write_failure", "submitted_fact_write_failure"}:
        real_record = launcher_module.record_job_event
        def record(*args, **kwargs):
            real_record(*args, **kwargs)
            trigger = "EmailApplicationSent" if boundary == "confirmation_write_failure" else "ApplicationSubmitted"
            if args[3] == trigger:
                raise sqlite3.OperationalError("synthetic persistence failure")
        monkeypatch.setattr(launcher_module, "record_job_event", record)
    else:
        monkeypatch.setattr(repo, "save", save)
    try:
        with pytest.raises((RuntimeError, sqlite3.OperationalError)):
            execute()
        close_connection(db_path)
        conn = get_connection(db_path)
        assert recover_ambiguous_running_apply() == (0 if boundary == "confirmation_ack_lost" else 1)
        counts = _email_counts(conn, job_id)
        assert len(calls) == 1 and counts["ApplySubmitIntended"] == 1
        confirmed = boundary == "confirmation_ack_lost"
        published = Counter(event.event_type for event in execute.publisher_events)
        assert published["EmailApplicationSent"] == int(confirmed)
        assert published["ApplicationSubmitted"] == int(confirmed)
        record_property("success_notifications", json.dumps({key: published[key] for key in ("EmailApplicationSent", "ApplicationSubmitted")}))
        assert counts["EmailApplicationSent"] == int(confirmed)
        assert counts["ApplicationSubmitted"] == int(confirmed)
        row = conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()
        assert row[0] == ("succeeded" if confirmed else "needs_verification")
        for target in (job_id, None):
            assert acquire_job(target_job_id=target, worker_id=2, run_ctx={}, approval_required=False) is None
        assert attachment.read_bytes() == preserved
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def test_concurrent_email_confirmation_writers_are_idempotent(tmp_path, monkeypatch, record_property):
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch, live_bus=True)
    try:
        captured = []
        real_save = repo.save
        def pause_before_confirmation(run, **kwargs):
            if run.is_terminal:
                captured.append(run)
                raise RuntimeError("pause before first confirmation persistence")
            return real_save(run, **kwargs)
        monkeypatch.setattr(repo, "save", pause_before_confirmation)
        with pytest.raises(RuntimeError, match="pause before"):
            execute()
        assert len(captured) == 1
        monkeypatch.setattr(repo, "save", real_save)
        close_connection(db_path)
        barrier = threading.Barrier(2)
        errors = []
        def settle():
            try:
                barrier.wait(timeout=5)
                repo.save(captured[0])
                mark_result(job_id, "applied", run_ctx=ctx)
            except BaseException as exc:
                errors.append(exc)
            finally:
                close_connection(db_path)
        threads = [threading.Thread(target=settle) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        assert not any(thread.is_alive() for thread in threads)
        assert errors == []
        conn = get_connection(db_path)
        counts = _email_counts(conn, job_id)
        assert (len(calls), counts["ApplySubmitIntended"], counts["EmailApplicationSent"], counts["ApplicationSubmitted"]) == (1, 1, 1, 1)
        published = Counter(e.event_type for e in execute.publisher_events)
        assert published["EmailApplicationSent"] == published["ApplicationSubmitted"] == 1
        assert execute.durable_success == [("EmailApplicationSent", 1, 1), ("ApplicationSubmitted", 1, 1)]
        record_property("subscriber_durable_observations", json.dumps(execute.durable_success))
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def test_late_email_receipt_cannot_overwrite_successor_or_foreign_tenant(tmp_path, monkeypatch, record_property):
    def wrap(sender):
        class DelayedSender:
            def send_email_application(self, candidate, *, operation):
                receipt = sender.send_email_application(candidate, operation=operation)
                # A separate durable writer supersedes this run during transport.
                other = sqlite3.connect(db_path)
                record_job_event(other, job_id, "apply", "ApplyClaimAcquired", tenant_id=LOCAL_TENANT,
                                 payload={"run_id": "successor", "launcher_id": "synthetic-successor"})
                record_job_event(other, job_id, "apply", "ApplyRunStarted", tenant_id=LOCAL_TENANT,
                                 payload={"run_id": "successor"})
                record_job_event(other, job_id, "apply", "ApplyReviewDecisionRecorded", tenant_id=LOCAL_TENANT,
                                 payload={"decision": "defer", "decisionId": "preserved-review"})
                other.commit()
                other.close()
                return receipt
        return DelayedSender()
    db_path, conn, job_id, ctx, calls, _, execute, attachment = _owned_email_probe(tmp_path, monkeypatch, sender_factory=wrap)
    before = attachment.read_bytes()
    try:
        with pytest.raises(launcher_module.ApplyOwnershipLost, match="no longer owns"):
            execute()
        mark_result(job_id, "applied", run_ctx=ctx)
        assert not launcher_module._has_email_confirmation(conn, "foreign", job_id, ctx["run_id"])
        counts = _email_counts(conn, job_id)
        assert counts["ApplySubmitIntended"] == 1
        assert counts["EmailApplicationSent"] == counts["ApplicationSubmitted"] == 0
        assert len(calls) == 1 and attachment.read_bytes() == before
        assert conn.execute("SELECT state FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == "running"
        assert counts["ApplyReviewDecisionRecorded"] == 1
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def test_duplicate_email_intent_never_admits_a_second_send(tmp_path, monkeypatch, record_property):
    db_path, conn, job_id, ctx, calls, _, execute, _ = _owned_email_probe(tmp_path, monkeypatch, body=b"{}")
    try:
        execute()
        execute()  # retry the exact saga/run before launcher settlement
        assert len(calls) == 1
        assert _email_counts(conn, job_id)["ApplySubmitIntended"] == 1
        mark_result(job_id, "applied", run_ctx=ctx)
        assert _email_counts(conn, job_id)["ApplicationSubmitted"] == 0
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def test_lost_intent_ack_preserves_intent_without_transport_admission(tmp_path, monkeypatch, record_property):
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch)
    real_admit = repo.admit_email_intent
    def lose_ack(run):
        real_admit(run)
        raise RuntimeError("private-provider-canary")
    monkeypatch.setattr(repo, "admit_email_intent", lose_ack)
    try:
        assert execute().submission_result.retryable is False
        mark_result(job_id, "failed", run_ctx=ctx)
        counts = _email_counts(conn, job_id)
        assert counts["ApplySubmitIntended"] == 1
        assert counts["EmailApplicationSent"] == counts["ApplicationSubmitted"] == 0
        assert calls == []
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == "needs_verification"
        assert acquire_job(target_job_id=job_id, worker_id=2, run_ctx={}, approval_required=False) is None
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def _record_email_probe_counts(record_property, db_path, job_id, calls):
    conn = get_connection(db_path)
    counts = _email_counts(conn, job_id)
    state = conn.execute("SELECT state FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='apply'", (job_id,)).fetchone()
    record_property("observed_email_counts", json.dumps({"http_calls": len(calls),
        "intent": counts["ApplySubmitIntended"], "confirmation": counts["EmailApplicationSent"],
        "submitted_fact": counts["ApplicationSubmitted"], "failed_terminal": counts["ApplicationFailed"],
        "apply_state": state[0] if state else None}, sort_keys=True))

    material_rows = [tuple(row) for row in conn.execute("SELECT * FROM job_materials WHERE job_id=?", (job_id,))]
    review_rows = [tuple(row) for row in conn.execute("SELECT * FROM application_review_decisions WHERE job_id=?", (job_id,))]
    record_property("preserved_synthetic_state", json.dumps({
        "materials_rows": len(material_rows), "review_rows": len(review_rows),
        "materials_sha256": sha256(json.dumps(material_rows, sort_keys=True).encode()).hexdigest(),
        "reviews_sha256": sha256(json.dumps(review_rows, sort_keys=True).encode()).hexdigest(),
        "attachment_sha256": sha256((Path(db_path).parent / "accepted.pdf").read_bytes()).hexdigest(),
    }, sort_keys=True))


def test_email_receipt_event_keys_isolate_identical_run_ids_across_tenants(tmp_path, monkeypatch):
    from dataclasses import asdict
    from jobctrl.domain.apply import ApplyRun, ApplyRunId
    from jobctrl.domain.ports.apply import EmailApplicationOperation
    from jobctrl.domain.tenant import TenantId

    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch)
    try:
        execute()
        conn.execute("INSERT INTO jobs (tenant_id,job_id,url,title,company,site,discovered_at) "
                     "SELECT 'other',job_id,url,title,company,site,discovered_at FROM jobs WHERE tenant_id='local' AND job_id=?", (job_id,))
        ensure_job_stage_rows(conn, job_id, tenant_id=TenantId("other"))
        set_stage_state(conn, job_id, "apply", "running", tenant_id=TenantId("other"), validate_transition=False)
        record_job_event(conn, job_id, "apply", "ApplyRunStarted", tenant_id=TenantId("other"), payload={"run_id": ctx["run_id"]})
        conn.commit()
        other_run = ApplyRun.start(tenant_id=TenantId("other"), job_id=job_id,
            run_id=ApplyRunId(ctx["run_id"]), started_at=utc_now(), worker_id=2, model="synthetic")
        operation = EmailApplicationOperation("other", job_id, ctx["run_id"], f"email:{ctx['run_id']}", "1", sha256(b"other-owned-candidate").hexdigest())
        other_run = other_run.record_event(event_type="ApplySubmitIntended", occurred_at=utc_now(),
            payload={"operation": asdict(operation), "submission_channel": "email"})
        repo.admit_email_intent(other_run)
        other_run = other_run.record_event(event_type="EmailApplicationSent", occurred_at=utc_now(),
            payload={"operation": asdict(operation), "provider": "gmail", "message_id": "other-owned-message"})
        repo.save(other_run)
        for tenant in ("local", "other"):
            mark_result(job_id, "applied", run_ctx=ctx, tenant_id=TenantId(tenant))
            for event_type in ("ApplySubmitIntended", "EmailApplicationSent", "ApplicationSubmitted"):
                assert conn.execute("SELECT COUNT(*) FROM job_events WHERE tenant_id=? AND job_id=? AND event_type=?",
                                    (tenant, job_id, event_type)).fetchone()[0] == 1
        assert len(calls) == 1  # Only the local tenant uses the HTTP seam here.
    finally:
        close_connection(db_path)


def test_delayed_email_settlement_preserves_accepted_fact_and_successor(tmp_path, monkeypatch):
    db_path, conn, job_id, ctx, calls, _, execute, attachment = _owned_email_probe(tmp_path, monkeypatch)
    preserved = attachment.read_bytes()
    try:
        execute()
        # Simulate an independently authorized successor after receipt commit.
        set_stage_state(conn, job_id, "apply", "running", validate_transition=False)
        record_job_event(conn, job_id, "apply", "ApplyClaimAcquired",
                         payload={"run_id": "newer-owned-run", "launcher_id": "synthetic-successor"})
        record_job_event(conn, job_id, "apply", "ApplyRunStarted", payload={"run_id": "newer-owned-run"})
        conn.commit()
        close_connection(db_path)
        conn = get_connection(db_path)
        mark_result(job_id, "applied", run_ctx=ctx)
        assert conn.execute("SELECT state FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == "running"
        counts = _email_counts(conn, job_id)
        assert (len(calls), counts["EmailApplicationSent"], counts["ApplicationSubmitted"]) == (1, 1, 1)
        assert attachment.read_bytes() == preserved
    finally:
        close_connection(db_path)


def _capture_owned_terminal(repo, execute, monkeypatch):
    captured = []
    real_save = repo.save
    def capture(run, **kwargs):
        if run.is_terminal:
            captured.append(run)
            raise RuntimeError("hold owned terminal")
        return real_save(run, **kwargs)
    monkeypatch.setattr(repo, "save", capture)
    with pytest.raises(RuntimeError, match="hold owned terminal"):
        execute()
    monkeypatch.setattr(repo, "save", real_save)
    assert len(captured) == 1
    return captured[0]


def test_owned_success_notifications_discarded_on_artifact_failure_and_retry(tmp_path, monkeypatch, record_property):
    db_path, conn, job_id, ctx, calls, repo, execute, attachment = _owned_email_probe(tmp_path, monkeypatch, live_bus=True)
    try:
        terminal = _capture_owned_terminal(repo, execute, monkeypatch)
        real_register = launcher_module._register_apply_log_artifact
        def fail(*args, **kwargs):
            raise sqlite3.OperationalError("synthetic artifact write failure")
        monkeypatch.setattr(launcher_module, "_register_apply_log_artifact", fail)
        with pytest.raises(sqlite3.OperationalError, match="synthetic artifact"):
            repo.save(terminal)
        assert _email_counts(conn, job_id)["EmailApplicationSent"] == 0
        assert _email_counts(conn, job_id)["ApplicationSubmitted"] == 0
        assert not any(e.event_type in {"EmailApplicationSent", "ApplicationSubmitted"} for e in execute.publisher_events)
        monkeypatch.setattr(launcher_module, "_register_apply_log_artifact", real_register)
        repo.save(terminal)
        repo.save(terminal)
        mark_result(job_id, "applied", run_ctx=ctx)
        assert len(calls) == 1
        published = Counter(e.event_type for e in execute.publisher_events)
        assert published["EmailApplicationSent"] == published["ApplicationSubmitted"] == 1
        assert execute.durable_success == [("EmailApplicationSent", 1, 1), ("ApplicationSubmitted", 1, 1)]
        record_property("subscriber_durable_observations", json.dumps(execute.durable_success))
        assert _email_counts(conn, job_id)["ApplicationSubmitted"] == 1
        projection = conn.execute("SELECT status, events_json FROM apply_run_projections WHERE run_id=?", (ctx["run_id"],)).fetchone()
        assert projection[0] == "succeeded"
        assert "private-agent-result-canary" not in projection[1]
        assert "apply@example.com" not in projection[1]
        assert attachment.read_bytes() == b"%PDF synthetic accepted material\n"
        record_property("success_notifications", json.dumps({key: published[key] for key in ("EmailApplicationSent", "ApplicationSubmitted")}))
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


@pytest.mark.parametrize("finish", ["commit", "rollback", "sql_commit", "cursor_commit", "context_commit", "savepoint_rollback", "close", "savepoint_retry", "sql_rollback", "cursor_rollback", "context_rollback", "script_commit"])
def test_owned_settlement_waits_for_inherited_transaction(tmp_path, monkeypatch, finish, record_property):
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch, live_bus=True)
    try:
        terminal = _capture_owned_terminal(repo, execute, monkeypatch)
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("SAVEPOINT caller_scope")
        repo.save(terminal)
        assert conn.in_transaction
        assert not any(e.event_type in {"EmailApplicationSent", "ApplicationSubmitted"} for e in execute.publisher_events)
        with sqlite3.connect(db_path) as observer:
            assert observer.execute("SELECT count(*) FROM job_events WHERE event_type='ApplicationSubmitted'").fetchone()[0] == 0
        accepted = finish in {"commit", "sql_commit", "cursor_commit", "context_commit", "savepoint_retry", "script_commit"}
        if finish == "savepoint_rollback":
            conn.execute("ROLLBACK TO caller_scope")
            conn.execute("RELEASE caller_scope")
            conn.commit()
        elif finish == "savepoint_retry":
            conn.execute("ROLLBACK TO caller_scope")
            repo.save(terminal)
            assert not any(e.event_type in {"EmailApplicationSent", "ApplicationSubmitted"} for e in execute.publisher_events)
            conn.commit()
        elif finish == "sql_rollback":
            conn.execute("ROLLBACK")
        elif finish == "cursor_rollback":
            conn.cursor().execute("ROLLBACK")
        elif finish == "context_rollback":
            with pytest.raises(RuntimeError, match="caller failed"):
                with conn:
                    raise RuntimeError("caller failed")
        elif finish == "script_commit":
            conn.executescript("SELECT 1;")
        elif finish == "sql_commit":
            conn.execute("COMMIT")
        elif finish == "cursor_commit":
            conn.cursor().execute("COMMIT")
        elif finish == "context_commit":
            with conn:
                pass
        elif finish == "close":
            close_connection(db_path)
            conn = get_connection(db_path)
        else:
            getattr(conn, finish)()
        published = Counter(e.event_type for e in execute.publisher_events)
        assert published["EmailApplicationSent"] == published["ApplicationSubmitted"] == int(accepted)
        assert _email_counts(conn, job_id)["ApplicationSubmitted"] == int(accepted)
        if not accepted:
            repo.save(terminal)
            repo.save(terminal)
            published = Counter(e.event_type for e in execute.publisher_events)
            assert published["EmailApplicationSent"] == published["ApplicationSubmitted"] == 1
        assert len(calls) == 1
        record_property("transaction_finish", finish)
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def test_recovery_rechecks_after_independent_confirmation_commit(tmp_path, monkeypatch, record_property):
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch)
    try:
        terminal = _capture_owned_terminal(repo, execute, monkeypatch)
        entered, settled = threading.Event(), threading.Event()
        real_check = launcher_module._workflow_terminal_or_gone
        def pause(*args, **kwargs):
            result = real_check(*args, **kwargs)
            entered.set()
            assert settled.wait(10)
            return result
        monkeypatch.setattr(launcher_module, "_workflow_terminal_or_gone", pause)
        failures = []
        def settle():
            try:
                assert entered.wait(5)
                repo.save(terminal)
            except BaseException as exc:
                failures.append(exc)
            finally:
                settled.set()
                close_connection(db_path)
        writer = threading.Thread(target=settle)
        writer.start()
        assert recover_ambiguous_running_apply() == 0
        writer.join(10)
        assert not writer.is_alive() and not failures
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == "succeeded"
        counts = _email_counts(conn, job_id)
        assert len(calls) == counts["EmailApplicationSent"] == counts["ApplicationSubmitted"] == 1
        assert recover_ambiguous_running_apply() == 0
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def test_recovery_holds_writer_lock_between_receipt_read_and_parking(tmp_path, monkeypatch, record_property):
    from jobctrl.apply.launcher import ApplyOwnershipLost
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch)
    try:
        terminal = _capture_owned_terminal(repo, execute, monkeypatch)
        read_receipt, tried_writer = threading.Event(), threading.Event()
        original = launcher_module._has_email_confirmation
        def pause(*args):
            value = original(*args)
            read_receipt.set()
            assert tried_writer.wait(10)
            return value
        monkeypatch.setattr(launcher_module, "_has_email_confirmation", pause)
        attempts = []
        def competing_writer():
            try:
                assert read_receipt.wait(5)
                with sqlite3.connect(db_path, timeout=0.05) as second:
                    try:
                        second.execute("BEGIN IMMEDIATE")
                    except sqlite3.OperationalError as exc:
                        attempts.append(str(exc))
            finally:
                tried_writer.set()
        writer = threading.Thread(target=competing_writer)
        writer.start()
        assert recover_ambiguous_running_apply() == 1
        writer.join(10)
        assert not writer.is_alive()
        assert attempts == ["database is locked"]
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == "needs_verification"
        with pytest.raises(ApplyOwnershipLost, match="no longer owns"):
            repo.save(terminal)
        assert len(calls) == 1
        assert _email_counts(conn, job_id)["ApplicationSubmitted"] == 0
        assert _email_counts(conn, job_id)["EmailApplicationSent"] == 0
        for target in (job_id, None):
            assert acquire_job(target_job_id=target, worker_id=2, run_ctx={}, approval_required=False) is None
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def test_owned_agent_result_publication_and_projection_keep_private_canary_out(tmp_path, monkeypatch, record_property):
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch, live_bus=True)
    try:
        execute()
        raw = conn.execute("SELECT payload_json FROM job_events WHERE job_id=? AND event_type='AgentResult'", (job_id,)).fetchone()[0]
        assert "private-agent-result-canary" in raw
        assert "private-agent-result-canary" not in str(execute.publisher_events)
        projection = conn.execute("SELECT events_json FROM apply_run_projections WHERE run_id=?", (ctx["run_id"],)).fetchone()[0]
        assert "private-agent-result-canary" not in projection
        assert "apply@example.com" not in projection
        assert execute.durable_success == [("EmailApplicationSent", 1, 1), ("ApplicationSubmitted", 1, 1)]
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def test_recovery_respects_inherited_transaction_rollback(tmp_path, monkeypatch, record_property):
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch, body=b"{}")
    try:
        _capture_owned_terminal(repo, execute, monkeypatch)
        conn.execute("BEGIN")
        assert recover_ambiguous_running_apply() == 1
        assert conn.in_transaction
        with sqlite3.connect(db_path) as observer:
            assert observer.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == "running"
        conn.rollback()
        assert recover_ambiguous_running_apply() == 1
        close_connection(db_path)
        conn = get_connection(db_path)
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()[0] == "needs_verification"
        assert len(calls) == 1
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


@pytest.mark.parametrize("body", [b'{"id":"owned-message"}', b'{}', b'lost-ack'])
def test_duplicate_execution_preserves_original_sender_settlement(tmp_path, monkeypatch, body, record_property):
    receipt_ready, release_receipt = threading.Event(), threading.Event()
    def wrap(sender):
        class PausedSender:
            def send_email_application(self, candidate, *, operation):
                try:
                    receipt = sender.send_email_application(candidate, operation=operation)
                finally:
                    receipt_ready.set()
                    assert release_receipt.wait(10)
                return receipt
        return PausedSender()
    db_path, conn, job_id, ctx, calls, repo, execute, attachment = _owned_email_probe(
        tmp_path, monkeypatch, body=body, sender_factory=wrap, live_bus=True)
    results, errors = [], []
    def first_execution():
        try:
            results.append(execute())
        except BaseException as exc:
            errors.append(exc)
        finally:
            close_connection(db_path)
    first = threading.Thread(target=first_execution)
    first.start()
    try:
        assert receipt_ready.wait(5)
        duplicate = execute()  # independent SQLite connection, same canonical run
        during = _email_counts(conn, job_id)
        release_receipt.set()
        first.join(10)
        assert not first.is_alive()
        record_property("duplicate_skipped", duplicate.skipped)
        assert duplicate.skipped and duplicate.skip_reason == "apply_run_conflict"
        assert during["AgentResult"] == during["ApplicationFailed"] == 0
        assert not errors, errors
        assert len(results) == 1
        confirmed = body == b'{"id":"owned-message"}'
        assert results[0].apply_run.is_succeeded is confirmed
        mark_result(job_id, "applied", run_ctx=ctx)
        counts = _email_counts(conn, job_id)
        assert len(calls) == counts["ApplySubmitIntended"] == counts["AgentResult"] == 1
        assert counts["EmailApplicationSent"] == counts["ApplicationSubmitted"] == int(confirmed)
        assert counts["ApplicationFailed"] == int(not confirmed)
        assert recover_ambiguous_running_apply() == 0
        for target in (job_id, None):
            assert acquire_job(target_job_id=target, worker_id=2, run_ctx={}, approval_required=False) is None
        execute.assert_preserved()
    finally:
        release_receipt.set()
        first.join(10)
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def _private_stream_agent_factory(tmp_path, monkeypatch):
    from jobctrl.infrastructure.apply import claude_code_cli
    from jobctrl.infrastructure.apply.claude_code_cli import ClaudeCodeCliAdapter
    from .test_claude_code_cli_adapter import _StreamPopen, _browser_messages, _terminal_message, _report
    canary = "private-stream-provider-candidate-canary"
    observation = f"Send to apply@example.com. {canary}"
    class Process(_StreamPopen):
        messages = (
            {"type": "assistant", "message": {"content": [{"type": "text", "text": observation}]}},
            *_browser_messages(observation),
            {"type": "assistant", "message": {"content": [
                {"type": "tool_use", "id": "tool-2", "name": "mcp__playwright__browser_snapshot", "input": {"preview": canary}}]}},
            _terminal_message(_report("email_only", reason=canary, recipient_email="apply@example.com", quote=observation)),
        )
    (tmp_path / "logs").mkdir()
    monkeypatch.setattr(claude_code_cli, "_apply_subprocess_env", lambda: {"PATH": "/synthetic"})
    monkeypatch.setattr(claude_code_cli, "is_bundled_runtime", lambda: False)
    monkeypatch.setattr(claude_code_cli, "_claude_supports_budget_flag", lambda *_args, **_kwargs: False)
    preflights, spends = [], []
    monkeypatch.setattr("jobctrl.llm.enforce_spend_budget", preflights.append)
    monkeypatch.setattr("jobctrl.llm.record_llm_spend", lambda **kwargs: spends.append(kwargs))
    monkeypatch.setattr(claude_code_cli, "resolve_claude_apply_binary", lambda: "/synthetic/claude")
    monkeypatch.setattr("subprocess.Popen", Process)
    def finish_fake_process(process, *, launched_pid):
        # The fixture never launches a process or owns an OS session.
        assert isinstance(process, Process) and process.pid == launched_pid
        assert process.wait() == 0
    monkeypatch.setattr("jobctrl.infrastructure.process_ownership.terminate_owned_process", finish_fake_process)
    def agent_factory(_):
        adapter = ClaudeCodeCliAdapter(log_dir=tmp_path / "logs", app_dir=tmp_path, max_budget_usd=0)
        class OwnedAdapter:
            def submit_application(self, **kwargs):
                from dataclasses import replace
                browser = replace(kwargs["browser"], worker_dir=str(tmp_path / "browser"))
                return adapter.submit_application(**{**kwargs, "browser": browser})
        return OwnedAdapter()
    return agent_factory, canary, preflights, spends


@pytest.mark.parametrize("body", [b'{"id":"owned-message"}', b'{}'])
def test_production_stream_events_keep_private_content_canonical(tmp_path, monkeypatch, body, record_property):
    agent_factory, canary, preflights, spends = _private_stream_agent_factory(tmp_path, monkeypatch)
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(
        tmp_path, monkeypatch, body=body, live_bus=True, agent_factory=agent_factory)
    try:
        result = execute()
        assert result.apply_run.is_succeeded is (body != b'{}')
        canonical = [tuple(row) for row in conn.execute("SELECT event_type,message,payload_json FROM job_events WHERE job_id=?", (job_id,))]
        assert {row[0] for row in canonical} >= {"AssistantText", "ToolUse", "ApplyTerminalDetermination"}
        assert canary in str(canonical)
        assert canary not in str(execute.publisher_events)
        projection = conn.execute("SELECT events_json FROM apply_run_projections WHERE run_id=?", (ctx["run_id"],)).fetchone()[0]
        assert canary not in projection
        assert "apply@example.com" not in projection
        candidate = conn.execute("SELECT payload_json FROM job_events WHERE event_type='EmailApplicationCandidateRecorded' AND job_id=?", (job_id,)).fetchone()[0]
        assert "private-candidate-canary" in candidate
        assert preflights == ["apply"] and len(spends) == 1 and spends[0]["lane"] == "apply"
        determination = conn.execute("SELECT envelope_json FROM semantic_determinations WHERE kind='apply_terminal_report'").fetchone()
        assert determination and canary in determination[0]
        record_property("private_stream_carriers", json.dumps(["AssistantText", "ToolUse", "ApplyTerminalDetermination"]))
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("mutation", ["type", "time", "level", "message", "payload"])
def test_event_sequence_collision_is_not_an_idempotent_replay(tmp_path, monkeypatch, legacy, mutation, record_property):
    from dataclasses import replace
    from jobctrl.domain.ports.apply import ApplyRunWriteConflict
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch, live_bus=True)
    try:
        original = execute().apply_run
        if legacy:
            conn.execute("UPDATE job_events SET payload_json=json_remove(payload_json, '$.event_fingerprint') WHERE job_id=?", (job_id,))
            conn.commit()
        # Replaying immutable original children must still work for older rows.
        repo.save(original)
        events = list(original.events)
        index = next(i for i, event in enumerate(events) if event.event_type == "EmailApplicationSent")
        event = events[index]
        changes = {
            "type": {"event_type": "AgentResult"}, "time": {"occurred_at": "2099-01-01T00:00:00Z"},
            "level": {"level": "warn"}, "message": {"message": "another event"},
            "payload": {"payload": {**event.payload, "message_id": "different-message"}},
        }
        events[index] = replace(event, **changes[mutation])
        with pytest.raises(ApplyRunWriteConflict, match="different event"):
            repo.save(replace(original, events=tuple(events)))
        repo.save(original)
        late = original.record_event(event_type="SyntheticLateEvent", occurred_at=utc_now(), payload={})
        with pytest.raises(launcher_module.ApplyOwnershipLost, match="no longer owns"):
            repo.save(late)
        assert _email_counts(conn, job_id)["SyntheticLateEvent"] == 0
        assert len(calls) == 1
        counts = _email_counts(conn, job_id)
        assert counts["EmailApplicationSent"] == counts["ApplicationSubmitted"] == 1
        assert Counter(e.event_type for e in execute.publisher_events)["ApplicationSubmitted"] == 1
        execute.assert_preserved()
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def test_duplicate_intent_refusal_does_not_write_a_competing_terminal(tmp_path, monkeypatch, record_property):
    from jobctrl.domain.ports.apply import ApplyRunWriteConflict
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch, live_bus=True)
    original_admit = repo.admit_email_intent
    def duplicate_admit(run):
        original_admit(run)
        raise ApplyRunWriteConflict("Email intent already admitted")
    monkeypatch.setattr(repo, "admit_email_intent", duplicate_admit)
    try:
        outcome = execute()
        assert outcome.skipped and outcome.skip_reason == "apply_run_conflict"
        assert outcome.submission_result is None
        counts = _email_counts(conn, job_id)
        assert len(calls) == 0 and counts["ApplySubmitIntended"] == 1
        assert counts["AgentResult"] == counts["ApplicationFailed"] == counts["EmailApplicationSent"] == 0
        assert recover_ambiguous_running_apply() == 1
        for target in (job_id, None):
            assert acquire_job(target_job_id=target, worker_id=2, run_ctx={}, approval_required=False) is None
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def test_historical_email_failure_projection_keeps_raw_exception_canonical(tmp_path, monkeypatch, record_property):
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(tmp_path, monkeypatch, body=b"{}", live_bus=True)
    try:
        execute()
        secret = "private-historical-provider-error-canary"
        raw = "email_send_outcome_ambiguous:" + secret
        set_stage_state(conn, job_id, "apply", "needs_verification", error_code="APPLY_NEEDS_VERIFICATION",
                        error_message="Apply reached the submit-intent checkpoint, but the external outcome is ambiguous: " + raw,
                        retryable=False, validate_transition=False)
        record_job_event(conn, job_id, "apply", "ApplicationFailed", message=secret,
                         payload={"run_id": ctx["run_id"], "result": "needs_verification", "reason": raw})
        conn.commit()
        ProjectionBuilder(conn_factory=lambda: conn).refresh()
        assert secret in conn.execute("SELECT error_message FROM job_stage_states WHERE job_id=? AND stage='apply'", (job_id,)).fetchone()[0]
        assert secret not in str(execute.publisher_events)
        assert secret not in conn.execute("SELECT events_json FROM apply_run_projections WHERE run_id=?", (ctx["run_id"],)).fetchone()[0]
        builder = ProjectionBuilder(conn_factory=lambda: conn)
        with builder._bind(conn):
            stage = next(stage for stage in builder._load_stage_projections(job_id) if stage.stage == "apply")
        assert stage.state == "needs_verification"
        assert secret not in stage.error_message
        assert "verify" in stage.error_message.lower()
        assert _email_counts(conn, job_id)["EmailApplicationSent"] == 0
    finally:
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)


def test_worker_entry_duplicate_does_not_release_original_operation(tmp_path, monkeypatch, record_property):
    ready, release = threading.Event(), threading.Event()
    def wrap(sender):
        class PausedSender:
            def send_email_application(self, candidate, *, operation):
                receipt = sender.send_email_application(candidate, operation=operation)
                ready.set()
                assert release.wait(10)
                return receipt
        return PausedSender()
    db_path, conn, job_id, ctx, calls, repo, execute, _ = _owned_email_probe(
        tmp_path, monkeypatch, sender_factory=wrap, live_bus=True)
    outcomes, errors = [], []
    def original():
        try:
            outcomes.append(execute())
        except BaseException as exc:
            errors.append(exc)
        finally:
            close_connection(db_path)
    thread = threading.Thread(target=original)
    thread.start()
    try:
        assert ready.wait(5)
        def duplicate_claim(**kwargs):
            kwargs["run_ctx"].update(ctx)
            return execute.job
        monkeypatch.setattr(launcher_module, "acquire_job", duplicate_claim)
        monkeypatch.setattr(launcher_module, "_build_use_case", lambda: execute.use_case)
        monkeypatch.setattr(launcher_module.config, "APPLY_WORKER_DIR", tmp_path / "duplicate-workers")
        monkeypatch.setattr("jobctrl.browser_capabilities.require_system_browser_capability", lambda *_: None)
        fresh_checks = []
        monkeypatch.setattr("jobctrl.enrichment.availability.require_fresh_active", lambda *args, **kwargs: fresh_checks.append(kwargs))
        launcher_module._stop_event.clear()
        applied, failed = worker_loop(worker_id=2, limit=1, target_job_id=job_id,
                                     snapshot=execute.snapshot, approval_required=False)
        assert (applied, failed) == (0, 0)
        assert len(fresh_checks) == 1  # The entry still checks posting freshness.
        during = _email_counts(conn, job_id)
        assert during["LockReleased"] == during["ApplicationFailed"] == 0
        release.set()
        thread.join(10)
        assert not thread.is_alive() and not errors
        assert outcomes[0].apply_run.is_succeeded
        assert len(calls) == 1
        assert _email_counts(conn, job_id)["ApplicationSubmitted"] == 1
        execute.assert_preserved()
    finally:
        release.set()
        thread.join(10)
        _record_email_probe_counts(record_property, db_path, job_id, calls)
        close_connection(db_path)
