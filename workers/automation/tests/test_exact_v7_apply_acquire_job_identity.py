"""Exact-v7 identity regressions for the apply claim boundary.

The apply runtime receives posting URLs only as browser locators. Its durable
claim, approval, profile, event, and repeat-protection reads must stay scoped
to the selected ``(tenant_id, job_id)`` aggregate.
"""

from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl.apply.launcher import (
    _latest_apply_review_decision,
    acquire_job,
    mark_job,
    mark_result,
    recover_ambiguous_running_apply,
    release_lock,
    worker_loop,
)
from jobctrl.apply.origins import canonical_http_url
from jobctrl.database import init_db
from jobctrl.domain.apply.repeat_application import (
    consume_repeat_application_override,
    evaluate_repeat_application,
    repeat_evidence_fingerprint,
)
from jobctrl.domain.identifiers import JobId, canonical_job_id
from jobctrl.domain.tenant import TenantId


LOCAL_TENANT = "local"
OTHER_TENANT = "other"
SHARED_URL = "https://example.test/jobs/shared"
LOCAL_JOB_ID = "90000000-0000-4000-8000-000000000011"
OTHER_JOB_ID = "90000000-0000-4000-8000-000000000012"
TIMESTAMP = "2026-07-31T12:00:00+00:00"


@pytest.fixture()
def conn(tmp_path: Path) -> sqlite3.Connection:
    return init_db(tmp_path / "jobctrl.db")


def _insert_ready_job(
    conn: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
    *,
    url: str = SHARED_URL,
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
        VALUES (?, ?, ?, 'Platform Engineer', 'Example', 'Example', ?)
        """,
        (tenant_id, job_id, url, TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value,
            is_current, first_seen_at, last_seen_at
        ) VALUES (?, ?, 'posting_url', ?, 1, ?, ?)
        """,
        (tenant_id, job_id, url, TIMESTAMP, TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description, application_url, updated_at
        ) VALUES (?, ?, 'enriched', 'Build reliable systems.', ?, ?)
        """,
        (tenant_id, job_id, f"{url}/apply", TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json, keywords_json, scored_at
        ) VALUES (?, ?, 1, 9, '{}', '[]', ?)
        """,
        (tenant_id, job_id, TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES (?, ?, 1, 'approved', ?, ?)
        """,
        (tenant_id, job_id, TIMESTAMP, TIMESTAMP),
    )
    for artifact_type in ("tailored_resume", "resume_pdf"):
        conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id,
                status, path, render_format, created_at
            ) VALUES (?, ?, 1, ?, ?, 'approved', ?, 'text', ?)
            """,
            (
                tenant_id,
                job_id,
                artifact_type,
                f"{job_id}:{artifact_type}",
                f"/tmp/{job_id}-{artifact_type}",
                TIMESTAMP,
            ),
        )
    from .availability_fixture import seed_fresh_availability

    seed_fresh_availability(conn, str(job_id), str(tenant_id))


def _insert_profile(conn: sqlite3.Connection, tenant_id: str, version: int) -> None:
    conn.execute(
        """
        INSERT INTO candidate_profiles (tenant_id, profile_id, version, updated_at)
        VALUES (?, 'default', ?, ?)
        """,
        (tenant_id, version, TIMESTAMP),
    )


@pytest.mark.parametrize("failure_code", ["provider_unavailable", "budget_denied", "repeat_equivalence_uncertain"])
def test_an_unresolved_candidate_does_not_stall_the_next_apply_claim(conn, monkeypatch, failure_code):
    from jobctrl.domain.determinations import DeterminationFailure

    blocked_id = "90000000-0000-4000-8000-000000000091"
    clear_id = "90000000-0000-4000-8000-000000000092"
    _insert_ready_job(conn, LOCAL_TENANT, blocked_id, url="https://example.test/jobs/a")
    _insert_ready_job(conn, LOCAL_TENANT, clear_id, url="https://example.test/jobs/b")
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    monkeypatch.setattr("jobctrl.apply.launcher.add_event", lambda _message: None)
    visited = []

    def prepare(_connection, *, target_job_id, tenant_id):
        visited.append(str(target_job_id))
        if str(target_job_id) == blocked_id:
            raise DeterminationFailure(failure_code)

    monkeypatch.setattr("jobctrl.domain.apply.repeat_application.prepare_repeat_application", prepare)
    # Exercise selection and the durable claim only; no application is submitted.
    claimed = acquire_job(tenant_id=LOCAL_TENANT, approval_required=False)
    assert claimed["job_id"] == clear_id
    assert visited == [blocked_id, clear_id]
    event = conn.execute(
        "SELECT job_id,payload_json FROM job_events WHERE event_type='RepeatApplicationCheckBlocked'"
    ).fetchone()
    assert event["job_id"] == blocked_id
    assert json.loads(event["payload_json"])["failureCode"] == failure_code
    assert (
        conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (clear_id,)).fetchone()[0]
        == "running"
    )
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplicationSubmitted'").fetchone()[0] == 0


def test_repeat_block_events_record_only_a_changed_failure_state(conn, monkeypatch):
    from jobctrl.domain.determinations import DeterminationFailure

    job_id = "90000000-0000-4000-8000-000000000093"
    _insert_ready_job(conn, LOCAL_TENANT, job_id, url="https://example.test/jobs/blocked")
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    failure = ["repeat_equivalence_uncertain"]

    def prepare(_connection, **kwargs):
        raise DeterminationFailure(failure[0])

    monkeypatch.setattr("jobctrl.domain.apply.repeat_application.prepare_repeat_application", prepare)
    for _ in range(4):
        assert acquire_job(tenant_id=LOCAL_TENANT, approval_required=False) is None
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='RepeatApplicationCheckBlocked'").fetchone()[0] == 1
    failure[0] = "budget_denied"
    for _ in range(3):
        assert acquire_job(tenant_id=LOCAL_TENANT, approval_required=False) is None
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='RepeatApplicationCheckBlocked'").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplicationSubmitted'").fetchone()[0] == 0


def _insert_approval_with_dry_run(
    conn: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
    *,
    profile_version: int,
) -> None:
    application_url = f"{SHARED_URL}/apply"
    conn.execute(
        """
        INSERT INTO application_review_decisions (
            tenant_id, decision_id, job_id, decision, decided_at,
            materials_generation, profile_version, application_url
        ) VALUES (?, ?, ?, 'approve_submit', ?, 1, ?, ?)
        """,
        (tenant_id, f"approval-{job_id}", job_id, TIMESTAMP, profile_version, application_url),
    )
    navigation_fingerprint = hashlib.sha256(canonical_http_url(application_url).encode("utf-8")).hexdigest()
    started_payload = {
        "run_id": f"dry-run-{job_id}",
        "materials_generation": 1,
        "profile_version": profile_version,
        "application_url": application_url,
    }
    completed_payload = {
        **started_payload,
        "coverage": "full",
        "allowed_navigations": [
            {
                "decision": "run_bound_initial_url",
                "grant_id": "initial_application_url",
                "method": "GET",
                "url_fingerprint": navigation_fingerprint,
            }
        ],
    }
    for event_type, payload in (
        ("ApplyRunStarted", started_payload),
        ("DryRunCompleted", completed_payload),
    ):
        conn.execute(
            """
            INSERT INTO job_events (
                tenant_id, job_id, identity_version, stage, event_type, occurred_at, payload_json
            ) VALUES (?, ?, 1, 'apply', ?, ?, ?)
            """,
            (tenant_id, job_id, event_type, TIMESTAMP, json.dumps(payload)),
        )


def test_targeted_acquire_binds_approval_and_profile_to_exact_v7_identity(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_ready_job(conn, OTHER_TENANT, OTHER_JOB_ID)
    _insert_profile(conn, LOCAL_TENANT, version=1)
    _insert_profile(conn, OTHER_TENANT, version=2)
    _insert_approval_with_dry_run(
        conn,
        OTHER_TENANT,
        OTHER_JOB_ID,
        profile_version=2,
    )
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)

    assert (
        acquire_job(
            target_job_id=JobId(LOCAL_JOB_ID),
            tenant_id=LOCAL_TENANT,
            approval_required=True,
        )
        is None
    )

    _insert_approval_with_dry_run(
        conn,
        LOCAL_TENANT,
        LOCAL_JOB_ID,
        profile_version=1,
    )
    conn.commit()

    run_ctx: dict[str, object] = {}
    job = acquire_job(
        target_job_id=JobId(LOCAL_JOB_ID),
        tenant_id=LOCAL_TENANT,
        approval_required=True,
        run_ctx=run_ctx,
    )

    assert job is not None
    assert (job["tenant_id"], job["job_id"], job["url"]) == (
        LOCAL_TENANT,
        LOCAL_JOB_ID,
        SHARED_URL,
    )
    assert run_ctx["tenant_id"] == LOCAL_TENANT
    assert run_ctx["job_id"] == LOCAL_JOB_ID
    assert run_ctx["profile_version"] == 1
    assert (
        conn.execute(
            """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
            (LOCAL_TENANT, LOCAL_JOB_ID),
        ).fetchone()["state"]
        == "running"
    )
    assert (
        conn.execute(
            """
        SELECT COUNT(*) FROM job_events
        WHERE tenant_id = ? AND job_id = ? AND event_type = 'ApplyRunStarted'
        """,
            (LOCAL_TENANT, LOCAL_JOB_ID),
        ).fetchone()[0]
        == 2
    )
    assert (
        conn.execute(
            """
        SELECT COUNT(*) FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
            (OTHER_TENANT, OTHER_JOB_ID),
        ).fetchone()[0]
        == 0
    )


def test_approval_lookup_preserves_the_apply_claim_transaction(
    conn: sqlite3.Connection,
) -> None:
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_approval_with_dry_run(
        conn,
        LOCAL_TENANT,
        LOCAL_JOB_ID,
        profile_version=1,
    )
    conn.commit()
    conn.execute("BEGIN IMMEDIATE")

    decision = _latest_apply_review_decision(
        conn,
        tenant_id=LOCAL_TENANT,
        job_id=LOCAL_JOB_ID,
    )

    assert decision is not None
    assert decision["decision"] == "approve_submit"
    assert conn.in_transaction is True
    conn.rollback()


def test_batch_acquire_does_not_cross_tenant_stage_or_repeat_evidence(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_ready_job(conn, OTHER_TENANT, OTHER_JOB_ID)
    conn.execute(
        """
        INSERT INTO job_stage_states (
            tenant_id, job_id, stage, state, attempt_count, updated_at
        ) VALUES (?, ?, 'apply', 'running', 1, ?)
        """,
        (OTHER_TENANT, OTHER_JOB_ID, TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type, occurred_at, payload_json
        ) VALUES (?, ?, 1, 'apply', 'ApplicationSubmitted', ?, '{}')
        """,
        (OTHER_TENANT, OTHER_JOB_ID, TIMESTAMP),
    )
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)

    job = acquire_job(tenant_id=LOCAL_TENANT, approval_required=False)

    assert job is not None
    assert (job["tenant_id"], job["job_id"], job["url"]) == (
        LOCAL_TENANT,
        LOCAL_JOB_ID,
        SHARED_URL,
    )
    state = conn.execute(
        """
        SELECT state, attempt_count FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID),
    ).fetchone()
    assert state is not None
    assert (state["state"], state["attempt_count"]) == ("running", 1)
    assert (
        conn.execute(
            """
        SELECT COUNT(*) FROM application_repeat_audit
        WHERE tenant_id = ? AND target_job_id = ?
        """,
            (LOCAL_TENANT, LOCAL_JOB_ID),
        ).fetchone()[0]
        == 0
    )


def test_targeted_acquire_binds_exact_job_id_without_prefix_collision(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wrong_job_id = "90000000-0000-4000-8000-000000000031"
    target_job_id = "90000000-0000-4000-8000-000000000032"
    _insert_ready_job(
        conn,
        LOCAL_TENANT,
        wrong_job_id,
        url="https://example.test/jobs/123-extra",
    )
    _insert_ready_job(
        conn,
        LOCAL_TENANT,
        target_job_id,
        url="https://example.test/jobs/456",
    )
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)

    job = acquire_job(
        target_job_id=JobId(target_job_id),
        tenant_id=LOCAL_TENANT,
        approval_required=False,
    )

    assert job is not None
    assert job["job_id"] == target_job_id
    assert (
        conn.execute(
            """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
            (LOCAL_TENANT, target_job_id),
        ).fetchone()["state"]
        == "running"
    )
    assert (
        conn.execute(
            """
        SELECT COUNT(*) FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
            (LOCAL_TENANT, wrong_job_id),
        ).fetchone()[0]
        == 0
    )


def test_targeted_acquire_rejects_a_url_shaped_job_id(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)

    with pytest.raises(ValueError, match="canonical UUID"):
        acquire_job(
            target_job_id=JobId(SHARED_URL),
            tenant_id=LOCAL_TENANT,
            approval_required=False,
        )


def test_targeted_apply_lifecycle_preserves_other_tenant_job_id(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _insert_ready_job(conn, OTHER_TENANT, OTHER_JOB_ID)
    conn.commit()
    captured: dict[str, object] = {}

    class _UseCase:
        def execute(self, **kwargs):
            captured.update(kwargs)
            return SimpleNamespace(skipped=True)

    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    monkeypatch.setattr("jobctrl.apply.launcher._build_use_case", _UseCase)
    monkeypatch.setattr("jobctrl.apply.launcher.reset_worker_dir", lambda _worker_id: tmp_path)
    monkeypatch.setattr("jobctrl.apply.launcher.add_event", lambda _message: None)
    monkeypatch.setattr("jobctrl.apply.launcher.update_state", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        "jobctrl.browser_capabilities.require_system_browser_capability",
        lambda _capability: None,
    )

    assert worker_loop(
        target_job_id=JobId(OTHER_JOB_ID),
        tenant_id=OTHER_TENANT,
        approval_required=False,
        dry_run=True,
        snapshot=object(),
    ) == (0, 0)
    assert captured["tenant_id"] == TenantId(OTHER_TENANT)
    assert captured["job"]["tenant_id"] == OTHER_TENANT
    assert captured["job"]["job_id"] == OTHER_JOB_ID

    rows = conn.execute(
        """
        SELECT tenant_id, job_id, event_type
        FROM job_events
        WHERE stage = 'apply'
        ORDER BY event_id
        """
    ).fetchall()
    assert [tuple(row) for row in rows] == [
        (OTHER_TENANT, OTHER_JOB_ID, "ApplyRunStarted"),
        (OTHER_TENANT, OTHER_JOB_ID, "LockReleased"),
    ]


def test_apply_result_release_and_manual_mark_write_exact_v7_identity(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_ready_job(conn, OTHER_TENANT, OTHER_JOB_ID)
    for tenant_id, job_id in (
        (LOCAL_TENANT, LOCAL_JOB_ID),
        (OTHER_TENANT, OTHER_JOB_ID),
    ):
        conn.execute(
            """
            INSERT INTO job_stage_states (
                tenant_id, job_id, stage, state, attempt_count, updated_at
            ) VALUES (?, ?, 'apply', 'running', 1, ?)
            """,
            (tenant_id, job_id, TIMESTAMP),
        )
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    monkeypatch.setattr("jobctrl.apply.launcher.config.LOG_DIR", tmp_path)

    run_ctx = {
        "run_id": "local-result-run",
        "tenant_id": LOCAL_TENANT,
        "worker_id": 7,
    }
    mark_result(
        JobId(LOCAL_JOB_ID),
        "applied",
        run_ctx=run_ctx,
        tenant_id=TenantId(LOCAL_TENANT),
    )
    release_lock(
        JobId(LOCAL_JOB_ID),
        run_ctx=run_ctx,
        tenant_id=TenantId(LOCAL_TENANT),
    )
    mark_job(
        JobId(LOCAL_JOB_ID),
        "applied",
        reason="Confirmed outside JobCtrl.",
        tenant_id=TenantId(LOCAL_TENANT),
    )

    states = conn.execute(
        """
        SELECT tenant_id, state
        FROM job_stage_states
        WHERE job_id IN (?, ?) AND stage = 'apply'
        ORDER BY tenant_id
        """,
        (LOCAL_JOB_ID, OTHER_JOB_ID),
    ).fetchall()
    assert [(row["tenant_id"], row["state"]) for row in states] == [
        (LOCAL_TENANT, "succeeded"),
        (OTHER_TENANT, "running"),
    ]
    assert (
        conn.execute(
            """
        SELECT COUNT(*) FROM job_events
        WHERE tenant_id = ? AND job_id = ?
          AND event_type IN (
            'ApplicationSubmitted', 'LockReleased', 'ApplicationManuallyMarked'
          )
        """,
            (LOCAL_TENANT, LOCAL_JOB_ID),
        ).fetchone()[0]
        == 3
    )
    assert (
        conn.execute(
            """
        SELECT COUNT(*) FROM job_events
        WHERE tenant_id = ? AND job_id = ?
          AND event_type IN (
            'ApplicationSubmitted', 'LockReleased', 'ApplicationManuallyMarked'
          )
        """,
            (OTHER_TENANT, OTHER_JOB_ID),
        ).fetchone()[0]
        == 0
    )
    artifact = conn.execute(
        """
        SELECT tenant_id, job_id, artifact_type
        FROM job_artifacts
        WHERE tenant_id = ? AND job_id = ?
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID),
    ).fetchone()
    assert tuple(artifact) == (LOCAL_TENANT, LOCAL_JOB_ID, "apply_log")


def test_apply_recovery_uses_exact_v7_identity_and_preserves_terminal_peer(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_ready_job(conn, OTHER_TENANT, OTHER_JOB_ID)
    for tenant_id, job_id, run_id in (
        (LOCAL_TENANT, LOCAL_JOB_ID, "local-run"),
        (OTHER_TENANT, OTHER_JOB_ID, "other-run"),
    ):
        conn.execute(
            """
            INSERT INTO job_stage_states (
                tenant_id, job_id, stage, state, attempt_count, updated_at
            ) VALUES (?, ?, 'apply', 'running', 1, ?)
            """,
            (tenant_id, job_id, TIMESTAMP),
        )
        conn.execute(
            """
            INSERT INTO job_events (
                tenant_id, job_id, identity_version, stage, event_type,
                occurred_at, payload_json
            ) VALUES (?, ?, 1, 'apply', 'ApplyRunStarted', ?, ?)
            """,
            (tenant_id, job_id, TIMESTAMP, json.dumps({"run_id": run_id})),
        )
    conn.execute(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type,
            occurred_at, payload_json
        ) VALUES (?, ?, 1, 'apply', 'ApplySubmitIntended', ?, ?)
        """,
        (
            LOCAL_TENANT,
            LOCAL_JOB_ID,
            TIMESTAMP,
            json.dumps({"run_id": "local-run"}),
        ),
    )
    conn.execute(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type,
            occurred_at, payload_json
        ) VALUES (?, ?, 1, 'apply', 'ApplicationSubmitted', ?, ?)
        """,
        (
            OTHER_TENANT,
            OTHER_JOB_ID,
            TIMESTAMP,
            json.dumps({"run_id": "other-run"}),
        ),
    )
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)

    assert recover_ambiguous_running_apply() == 1
    states = conn.execute(
        """
        SELECT tenant_id, state
        FROM job_stage_states
        WHERE job_id IN (?, ?) AND stage = 'apply'
        ORDER BY tenant_id
        """,
        (LOCAL_JOB_ID, OTHER_JOB_ID),
    ).fetchall()
    assert [(row["tenant_id"], row["state"]) for row in states] == [
        (LOCAL_TENANT, "needs_verification"),
        (OTHER_TENANT, "running"),
    ]


def test_dry_run_completion_binds_to_exact_v7_job(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    conn.execute(
        """
        INSERT INTO job_stage_states (
            tenant_id, job_id, stage, state, attempt_count, updated_at
        ) VALUES (?, ?, 'apply', 'running', 1, ?)
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID, TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type,
            occurred_at, payload_json
        ) VALUES (?, ?, 1, 'apply', 'ApplyRunStarted', ?, ?)
        """,
        (
            LOCAL_TENANT,
            LOCAL_JOB_ID,
            TIMESTAMP,
            json.dumps(
                {
                    "run_id": "dry-run-1",
                    "materials_generation": 1,
                    "profile_version": 3,
                    "application_url": f"{SHARED_URL}/apply",
                }
            ),
        ),
    )
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)

    mark_result(
        JobId(LOCAL_JOB_ID),
        "dry_run",
        run_ctx={
            "run_id": "dry-run-1",
            "tenant_id": LOCAL_TENANT,
            "materials_generation": 1,
            "profile_version": 3,
            "application_url": f"{SHARED_URL}/apply",
        },
        tenant_id=TenantId(LOCAL_TENANT),
    )
    mark_result(
        JobId(LOCAL_JOB_ID),
        "dry_run",
        run_ctx={
            "run_id": "dry-run-1",
            "tenant_id": LOCAL_TENANT,
            "materials_generation": 1,
            "profile_version": 3,
            "application_url": f"{SHARED_URL}/apply",
        },
        tenant_id=TenantId(LOCAL_TENANT),
    )

    state = conn.execute(
        """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID),
    ).fetchone()
    assert state["state"] == "skipped"
    event = conn.execute(
        """
        SELECT payload_json FROM job_events
        WHERE tenant_id = ? AND job_id = ? AND event_type = 'DryRunCompleted'
        ORDER BY event_id DESC LIMIT 1
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID),
    ).fetchone()
    payload = json.loads(event["payload_json"])
    assert (
        conn.execute(
            """
        SELECT COUNT(*) FROM job_events
        WHERE tenant_id = ? AND job_id = ?
          AND event_type = 'DryRunCompleted'
        """,
            (LOCAL_TENANT, LOCAL_JOB_ID),
        ).fetchone()[0]
        == 1
    )
    assert payload["jobId"] == LOCAL_JOB_ID
    assert payload["materials_generation"] == 1
    assert payload["profile_version"] == 3
    assert payload["application_url"] == f"{SHARED_URL}/apply"


def test_late_apply_completion_does_not_overwrite_cancellation(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    conn.execute(
        """
        INSERT INTO job_stage_states (
            tenant_id, job_id, stage, state, attempt_count, updated_at
        ) VALUES (?, ?, 'apply', 'canceled', 1, ?)
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID, TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type,
            occurred_at, payload_json
        ) VALUES (?, ?, 1, 'apply', 'StageCanceled', ?, ?)
        """,
        (
            LOCAL_TENANT,
            LOCAL_JOB_ID,
            TIMESTAMP,
            json.dumps({"run_id": "apply-run-canceled"}),
        ),
    )
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)

    mark_result(
        JobId(LOCAL_JOB_ID),
        "applied",
        run_ctx={"run_id": "apply-run-canceled", "tenant_id": LOCAL_TENANT},
        tenant_id=TenantId(LOCAL_TENANT),
    )

    state = conn.execute(
        """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID),
    ).fetchone()
    assert state is not None
    assert state["state"] == "canceled"
    assert (
        conn.execute(
            """
        SELECT COUNT(*) FROM job_events
        WHERE tenant_id = ? AND job_id = ?
          AND event_type = 'ApplicationSubmitted'
        """,
            (LOCAL_TENANT, LOCAL_JOB_ID),
        ).fetchone()[0]
        == 0
    )


def test_matching_terminal_event_reconciles_running_state_without_duplication(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    conn.execute(
        """
        INSERT INTO job_stage_states (
            tenant_id, job_id, stage, state, attempt_count, updated_at
        ) VALUES (?, ?, 'apply', 'running', 1, ?)
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID, TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type,
            occurred_at, payload_json
        ) VALUES (?, ?, 1, 'apply', 'DryRunCompleted', ?, ?)
        """,
        (
            LOCAL_TENANT,
            LOCAL_JOB_ID,
            TIMESTAMP,
            json.dumps(
                {
                    "run_id": "dry-run-reconcile",
                    "result": "dry_run_complete",
                    "dry_run": True,
                    "materials_generation": 1,
                    "profile_version": 3,
                    "application_url": f"{SHARED_URL}/apply",
                }
            ),
        ),
    )
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)

    mark_result(
        JobId(LOCAL_JOB_ID),
        "dry_run",
        run_ctx={
            "run_id": "dry-run-reconcile",
            "tenant_id": LOCAL_TENANT,
            "materials_generation": 1,
            "profile_version": 3,
            "application_url": f"{SHARED_URL}/apply",
        },
        tenant_id=TenantId(LOCAL_TENANT),
    )

    state = conn.execute(
        """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID),
    ).fetchone()
    assert state["state"] == "skipped"
    assert (
        conn.execute(
            """
        SELECT COUNT(*) FROM job_events
        WHERE tenant_id = ? AND job_id = ?
          AND event_type = 'DryRunCompleted'
        """,
            (LOCAL_TENANT, LOCAL_JOB_ID),
        ).fetchone()[0]
        == 1
    )


def _record_submitted_application(
    conn: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
) -> None:
    conn.execute(
        """
        INSERT INTO job_events (
            tenant_id, job_id, identity_version, stage, event_type, occurred_at, payload_json
        ) VALUES (?, ?, 1, 'apply', 'ApplicationSubmitted', ?, '{}')
        """,
        (tenant_id, job_id, TIMESTAMP),
    )


def test_repeat_protection_never_overrides_canonical_identity(
    conn: sqlite3.Connection,
) -> None:
    prior_job_id = "90000000-0000-4000-8000-000000000021"
    target_job_id = "90000000-0000-4000-8000-000000000022"
    _insert_ready_job(
        conn,
        LOCAL_TENANT,
        prior_job_id,
        url="https://example.test/jobs/prior",
    )
    _insert_ready_job(
        conn,
        LOCAL_TENANT,
        target_job_id,
        url="https://example.test/jobs/target",
    )
    for job_id in (prior_job_id, target_job_id):
        conn.execute(
            """
            INSERT INTO job_canonical_identities (
                tenant_id, job_id, canonical_url, ats_kind, source_native_id,
                confidence, resolved_at
            ) VALUES (?, ?, 'https://boards.example.test/jobs/123', 'greenhouse',
                      'gh-123', 1.0, ?)
            """,
            (LOCAL_TENANT, job_id, TIMESTAMP),
        )
    _record_submitted_application(conn, LOCAL_TENANT, prior_job_id)
    conn.commit()

    tenant_id = TenantId(LOCAL_TENANT)
    stable_target_id = canonical_job_id(target_job_id)
    assessment = evaluate_repeat_application(
        conn,
        tenant_id=tenant_id,
        target_job_id=stable_target_id,
    )

    assert assessment["status"] == "blocked"
    assert assessment["matches"][0]["relationship"] == "canonical_identity"
    assert assessment["matches"][0]["priorApplication"]["jobId"] == prior_job_id
    assert assessment["evidenceFingerprint"] == repeat_evidence_fingerprint(
        target_job_id,
        assessment["matches"],
    )

    override_id = "repeat-override-v7"
    conn.execute(
        """
        INSERT INTO application_repeat_overrides (
            tenant_id, override_id, target_job_id, prior_job_id, relationship,
            evidence_fingerprint, evidence_json, reason, confirmed_by, confirmed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'Prior application was withdrawn.', 'qa-user', ?)
        """,
        (
            LOCAL_TENANT,
            override_id,
            target_job_id,
            prior_job_id,
            assessment["matches"][0]["relationship"],
            assessment["evidenceFingerprint"],
            json.dumps(assessment["matches"], separators=(",", ":")),
            TIMESTAMP,
        ),
    )
    conn.commit()

    still_blocked = evaluate_repeat_application(
        conn,
        tenant_id=tenant_id,
        target_job_id=stable_target_id,
        record_audit=False,
    )
    assert still_blocked["status"] == "blocked"
    assert still_blocked["override"]["targetJobId"] == target_job_id
    assert still_blocked["override"]["priorJobId"] == prior_job_id

    with pytest.raises(ValueError, match="repeat application protection refused: blocked"):
        consume_repeat_application_override(
            conn,
            still_blocked,
            tenant_id=tenant_id,
            target_job_id=stable_target_id,
            run_id="apply-run-v7",
            consumed_at=TIMESTAMP,
        )

    assert (
        conn.execute(
            """
        SELECT COUNT(*) FROM application_repeat_override_consumptions
        WHERE tenant_id = ? AND override_id = ?
        """,
            (LOCAL_TENANT, override_id),
        ).fetchone()[0]
        == 0
    )


def test_repeat_protection_does_not_cross_tenants_with_shared_job_id_and_url(
    conn: sqlite3.Connection,
) -> None:
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_ready_job(conn, OTHER_TENANT, LOCAL_JOB_ID)
    _record_submitted_application(conn, OTHER_TENANT, LOCAL_JOB_ID)
    conn.commit()

    assessment = evaluate_repeat_application(
        conn,
        tenant_id=TenantId(LOCAL_TENANT),
        target_job_id=canonical_job_id(LOCAL_JOB_ID),
    )

    assert assessment["status"] == "clear"
    assert (
        conn.execute(
            """
        SELECT COUNT(*) FROM application_repeat_audit
        WHERE tenant_id = ? AND target_job_id = ?
        """,
            (LOCAL_TENANT, LOCAL_JOB_ID),
        ).fetchone()[0]
        == 0
    )


@pytest.mark.parametrize("prior", ["pending", "failed", "needs_verification"])
@pytest.mark.parametrize("targeted", [True, False])
@pytest.mark.parametrize("approval_required", [True, False])
@pytest.mark.parametrize("dry_run", [True, False])
def test_manual_skip_is_durable_before_any_claim_work(conn, monkeypatch, prior, targeted, approval_required, dry_run):
    from jobctrl.state import ensure_job_stage_rows, set_stage_state
    from jobctrl.database import count_ready_to_apply, get_jobs_by_stage

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    conn.execute("UPDATE job_stage_states SET state='succeeded' WHERE stage='score'")
    set_stage_state(conn, LOCAL_JOB_ID, "apply", prior, validate_transition=False, attempt_count=1)
    # Canonical shape written by the HTTP manual Skip, including NULL error_code.
    set_stage_state(conn, LOCAL_JOB_ID, "apply", "skipped", retryable=False, validate_transition=False, attempt_count=1)
    conn.commit()
    before = [tuple(r) for r in conn.execute("SELECT * FROM job_materials_artifacts")]
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    monkeypatch.setattr("jobctrl.domain.apply.repeat_application.prepare_repeat_application", lambda *a, **k: pytest.fail("stopped job reached model preflight"))
    monkeypatch.setattr("jobctrl.enrichment.availability.require_fresh_active", lambda *a, **k: pytest.fail("stopped job acquired posting"))
    for _ in range(3):
        assert acquire_job(target_job_id=JobId(LOCAL_JOB_ID) if targeted else None,
                           approval_required=approval_required, run_ctx={"dry_run": dry_run}) is None
    assert count_ready_to_apply(conn) == 0
    assert get_jobs_by_stage(conn, "pending_apply") == []
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type IN ('ApplyRunStarted','ApplySubmitIntended')").fetchone()[0] == 0
    assert conn.execute("SELECT attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()[0] == 1
    assert [tuple(r) for r in conn.execute("SELECT * FROM job_materials_artifacts")] == before


@pytest.mark.parametrize("stage", ["skipped", "pending", "failed", "canceled"])
def test_durable_intent_blocks_after_connection_restart_and_unrelated_stage(conn, monkeypatch, tmp_path, stage):
    from jobctrl.state import ensure_job_stage_rows, set_stage_state, record_job_event, reset_job_stage
    from jobctrl.database import count_ready_to_apply

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    conn.execute("UPDATE job_stage_states SET state='succeeded' WHERE stage='score'")
    record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "ApplySubmitIntended", payload={"run_id": "original-intent"})
    # Lost acknowledgement / failed settlement and a newer unrelated run are not no-send evidence.
    record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "ApplicationFailed", payload={"run_id": "original-intent"})
    record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "DryRunCompleted", payload={"run_id": "later-unrelated"})
    set_stage_state(conn, LOCAL_JOB_ID, "apply", stage, retryable=False, validate_transition=False)
    conn.commit()
    restarted = sqlite3.connect(tmp_path / "jobctrl.db")
    restarted.row_factory = sqlite3.Row
    from jobctrl.scoring.eligibility_sql import register_score_eligibility_sql
    register_score_eligibility_sql(restarted)
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: restarted)
    try:
        for target in [JobId(LOCAL_JOB_ID), None]:
            assert acquire_job(target_job_id=target, approval_required=False) is None
        assert count_ready_to_apply(restarted) == 0
        before = [tuple(r) for r in restarted.execute("SELECT * FROM job_stage_states")]
        with pytest.raises(ValueError, match="intent"):
            reset_job_stage(restarted, LOCAL_JOB_ID, "apply", reset_attempts=True)
        assert [tuple(r) for r in restarted.execute("SELECT * FROM job_stage_states")] == before
        assert restarted.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplySubmitIntended'").fetchone()[0] == 1
    finally:
        restarted.close()


def test_skip_committed_by_independent_writer_during_availability_refresh_cannot_claim(conn, monkeypatch, tmp_path):
    from jobctrl.state import ensure_job_stage_rows

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    conn.execute("UPDATE job_stage_states SET state='succeeded' WHERE stage='score'")
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    monkeypatch.setattr("jobctrl.enrichment.availability.fresh_active", lambda *a, **k: False)
    visited = []

    def skip(*args, **kwargs):
        with sqlite3.connect(tmp_path / "jobctrl.db") as writer:
            writer.execute("UPDATE job_stage_states SET state='skipped',retryable=0,error_code=NULL,version=version+1 WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,))
        visited.append("skip committed")

    monkeypatch.setattr("jobctrl.enrichment.availability.require_fresh_active", skip)
    assert acquire_job(target_job_id=JobId(LOCAL_JOB_ID), approval_required=False, run_ctx={"dry_run": True}) is None
    assert visited == ["skip committed"]
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplyRunStarted'").fetchone()[0] == 0


def test_skipped_peer_does_not_starve_safe_dry_run_and_reset_preserves_artifacts(conn, monkeypatch):
    from jobctrl.state import ensure_job_stage_rows, set_stage_state, reset_job_stage

    for job, url in [(LOCAL_JOB_ID, SHARED_URL), (OTHER_JOB_ID, SHARED_URL + '-peer')]:
        _insert_ready_job(conn, LOCAL_TENANT, job, url=url)
        ensure_job_stage_rows(conn, job)
        conn.execute("UPDATE job_stage_states SET state='succeeded' WHERE stage='score'")
    set_stage_state(conn, LOCAL_JOB_ID, "apply", "skipped", retryable=False, validate_transition=False)
    set_stage_state(conn, OTHER_JOB_ID, "apply", "skipped", error_code="DRY_RUN", retryable=True, validate_transition=False)
    conn.commit()
    before = [tuple(r) for r in conn.execute("SELECT * FROM job_materials_artifacts")]
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    monkeypatch.setattr("jobctrl.apply.launcher.add_event", lambda *a: None)
    claim = acquire_job(approval_required=False, run_ctx={"dry_run": True})
    assert claim["job_id"] == OTHER_JOB_ID
    assert reset_job_stage(conn, LOCAL_JOB_ID, "apply") == SHARED_URL
    assert [tuple(r) for r in conn.execute("SELECT * FROM job_materials_artifacts")] == before


def test_late_result_cannot_replace_local_stop_or_reset_or_successor(conn, monkeypatch):
    from jobctrl.state import ensure_job_stage_rows, set_stage_state, record_job_event, reset_job_stage

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    conn.execute("UPDATE job_stage_states SET state='succeeded' WHERE stage='score'")
    record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "ApplyRunStarted", payload={"run_id": "original"})
    set_stage_state(conn, LOCAL_JOB_ID, "apply", "skipped", retryable=False, validate_transition=False)
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    with pytest.raises(ValueError, match="prior admitted run"):
        reset_job_stage(conn, LOCAL_JOB_ID, "apply")
    for state in ["skipped", "pending", "running"]:
        if state == "pending":
            reset_job_stage(conn, LOCAL_JOB_ID, "apply")
        if state == "running":
            set_stage_state(conn, LOCAL_JOB_ID, "apply", "running")
            record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "ApplyRunStarted", payload={"run_id": "successor"})
            conn.commit()
        before = [tuple(r) for r in conn.execute("SELECT * FROM job_stage_states")]
        mark_result(JobId(LOCAL_JOB_ID), "applied", run_ctx={"run_id": "original"})
        assert [tuple(r) for r in conn.execute("SELECT * FROM job_stage_states")] == before
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplicationSubmitted'").fetchone()[0] == 0


@pytest.mark.parametrize("overlap", ["before_intent", "after_intent", "lost_ack"])
def test_owned_email_skip_overlap_retains_durable_authority(conn, monkeypatch, tmp_path, overlap):
    """Real claim, final-intent writer, saga and SQLite event writer; fake transports only."""
    from jobctrl.apply.launcher import SqliteApplyRunRepository, _authorize_posting_before_submit
    from jobctrl.domain.apply import ApplyRun, new_apply_run_id
    from jobctrl.domain.apply.process_manager import ApplySaga
    from jobctrl.state import reset_job_stage
    from tests.test_apply_saga import _FakeBrowser, _FakeAgent, _FakeEmailSender, _config, _prompt, _email_context

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    monkeypatch.setattr("jobctrl.apply.launcher.add_event", lambda *a: None)
    accepted = tmp_path / "accepted"
    accepted.mkdir()
    files = [accepted / "resume.md", accepted / "resume.pdf"]
    for file in files:
        file.write_bytes(b"Owned synthetic accepted artifact: " + file.suffix.encode())
    for artifact_type, file in zip(("tailored_resume", "resume_pdf"), files):
        conn.execute("UPDATE job_materials_artifacts SET path=? WHERE job_id=? AND artifact_type=?", (str(file), LOCAL_JOB_ID, artifact_type))
    conn.commit()

    def fingerprint():
        return hashlib.sha256(repr([tuple(r) for r in conn.execute("SELECT * FROM job_materials_artifacts")]).encode() + b"".join(file.read_bytes() for file in files)).hexdigest()

    before = fingerprint()
    context = {"run_id": str(new_apply_run_id())}
    assert acquire_job(target_job_id=JobId(LOCAL_JOB_ID), approval_required=False, run_ctx=context)
    claimed_stage = dict(conn.execute("SELECT state,version,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone())

    def skip():
        with sqlite3.connect(tmp_path / "jobctrl.db") as writer:
            writer.execute("UPDATE job_stage_states SET state='skipped',error_code=NULL,retryable=0,version=version+1 WHERE tenant_id=? AND job_id=? AND stage='apply'", (LOCAL_TENANT, LOCAL_JOB_ID))
            from jobctrl.state import record_job_event
            record_job_event(writer, JobId(LOCAL_JOB_ID), 'apply', 'StageSkipped', payload={'manualDisposition': 'skip', 'previousState': 'running'})

    class Agent(_FakeAgent):
        def submit_application(self, **kwargs):
            result = super().submit_application(**kwargs)
            if overlap == "before_intent":
                skip()
            return result

    class Sender(_FakeEmailSender):
        def send_email_application(self, candidate):
            # Intent must already be committed and visible to a second connection.
            with sqlite3.connect(tmp_path / "jobctrl.db") as observer:
                assert observer.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplySubmitIntended'").fetchone()[0] == 1
            result = super().send_email_application(candidate)
            skip()
            if overlap == "lost_ack":
                raise TimeoutError("synthetic acceptance with lost acknowledgement")
            return result

    sender = Sender()
    saga = ApplySaga(browser_port=_FakeBrowser(), agent_port=Agent(behaviour="email_only"),
                     repository=SqliteApplyRunRepository(), email_sender=sender,
                     availability_authorizer=_authorize_posting_before_submit)
    run = ApplyRun.start(tenant_id=TenantId(LOCAL_TENANT), job_id=JobId(LOCAL_JOB_ID),
                         run_id=context["run_id"], started_at=TIMESTAMP, worker_id=1, model="synthetic")
    outcome = saga.run(apply_run=run, browser_config=_config(), prompt=_prompt(), model="synthetic",
                       posting_url=SHARED_URL, email_application_context=_email_context(
                           approved_recipient_email="apply@example.com", approved_attachment_artifact_id="resume-pdf-1",
                           attachment_path=str(files[1])))
    mark_result(JobId(LOCAL_JOB_ID), "applied" if outcome.apply_run.is_succeeded else "failed", run_ctx=context)
    assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()[0] == "skipped"
    settled_stage = dict(conn.execute("SELECT state,version,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone())
    intended = conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplySubmitIntended'").fetchone()[0]
    assert intended == (0 if overlap == "before_intent" else 1)
    assert len(sender.sent) == intended
    for _ in range(3):
        assert acquire_job(target_job_id=JobId(LOCAL_JOB_ID), approval_required=False) is None
    if intended:
        with pytest.raises(ValueError, match="intent"):
            reset_job_stage(conn, LOCAL_JOB_ID, "apply")
        import subprocess
        import sys
        (tmp_path / "owned_skip_probe").write_text("synthetic #1173")
        restarted = subprocess.run([sys.executable, str(Path(__file__).with_name("apply_skip_restart_probe.py")),
                                    str(tmp_path / "jobctrl.db"), LOCAL_JOB_ID], capture_output=True, text=True, timeout=30)
        assert restarted.returncode == 0, restarted.stdout + restarted.stderr
        print(restarted.stdout)
    else:
        # The exact local execution returned pre-intent; explicit reset is safe.
        reset_job_stage(conn, LOCAL_JOB_ID, "apply")
    after = fingerprint()
    assert after == before
    events = dict(conn.execute("SELECT event_type,COUNT(*) FROM job_events GROUP BY event_type").fetchall())
    # Retain exact synthetic identities/counts in pytest output for independent inspection.
    print(json.dumps({"overlap": overlap, "tenant": LOCAL_TENANT, "job": LOCAL_JOB_ID,
                      "run": context["run_id"], "sender_calls": len(sender.sent), "events": events,
                      "artifact_before": before, "artifact_after": after, "claimed_stage": claimed_stage, "settled_stage": settled_stage,
                      "final_stage": dict(conn.execute("SELECT state,version,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone())}))


def test_failed_batch_reset_cannot_release_a_skip_committed_after_selection(conn, monkeypatch, tmp_path):
    from jobctrl.apply.launcher import reset_failed
    from jobctrl.pipeline import retry
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, "apply", "failed", attempt_count=2, validate_transition=False)
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    reset = retry.reset_retry_stages

    def skip_then_reset(*args, **kwargs):
        with sqlite3.connect(tmp_path / "jobctrl.db") as writer:
            writer.execute("UPDATE job_stage_states SET state='skipped',retryable=0,error_code=NULL WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,))
        return reset(*args, **kwargs)

    monkeypatch.setattr(retry, "reset_retry_stages", skip_then_reset)
    assert reset_failed() == 0
    assert tuple(conn.execute("SELECT state,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()) == ("skipped", 2)
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='StageReset'").fetchone()[0] == 0


@pytest.mark.parametrize("state", ["skipped", "pending", "failed"])
def test_retained_needs_verification_stop_blocks_without_intent_receipt(conn, monkeypatch, state):
    from jobctrl.state import ensure_job_stage_rows, set_stage_state, record_job_event, reset_job_stage

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, "score", "succeeded", validate_transition=False)
    set_stage_state(conn, LOCAL_JOB_ID, "apply", state, validate_transition=False)
    record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "StageSkipped", payload={"previousState": "needs_verification"})
    # Repeated Skip must not erase the retained reason either.
    record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "StageSkipped", payload={"previousState": "skipped"})
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    for target in [JobId(LOCAL_JOB_ID), None]:
        assert acquire_job(target_job_id=target, approval_required=False, run_ctx={"dry_run": True}) is None
    with pytest.raises(ValueError, match="verification"):
        reset_job_stage(conn, LOCAL_JOB_ID, "apply", reset_attempts=True)
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type IN ('ApplyRunStarted','ApplySubmitIntended')").fetchone()[0] == 0


@pytest.mark.parametrize("state", ["pending", "failed", "canceled"])
def test_reset_cannot_use_stage_relabel_as_skipped_run_settlement(conn, monkeypatch, state):
    from jobctrl.state import ensure_job_stage_rows, record_job_event, reset_job_stage, set_stage_state

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, "score", "succeeded", validate_transition=False)
    record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "ApplyRunStarted", payload={"run_id": "original"})
    record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "StageSkipped", payload={"previousState": "running", "manualDisposition": "skip"})
    set_stage_state(conn, LOCAL_JOB_ID, "apply", state, validate_transition=False, attempt_count=1)
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    before = [tuple(row) for row in conn.execute("SELECT * FROM job_stage_states")]
    for target in [JobId(LOCAL_JOB_ID), None]:
        assert acquire_job(target_job_id=target, approval_required=False, run_ctx={"dry_run": True}) is None
    with pytest.raises(ValueError, match="prior admitted run"):
        reset_job_stage(conn, LOCAL_JOB_ID, "apply", reset_attempts=True)
    assert [tuple(row) for row in conn.execute("SELECT * FROM job_stage_states")] == before
    # Exact local cleanup acknowledges settlement, but cannot itself release Skip.
    release_lock(JobId(LOCAL_JOB_ID), {"run_id": "original"})
    assert acquire_job(target_job_id=JobId(LOCAL_JOB_ID), approval_required=False, run_ctx={"dry_run": True}) is None
    reset_job_stage(conn, LOCAL_JOB_ID, "apply")
    assert acquire_job(target_job_id=JobId(LOCAL_JOB_ID), approval_required=False, run_ctx={"dry_run": True})


def test_manual_skip_history_fences_final_intent_and_late_settlement_after_stage_relabel(conn, monkeypatch):
    from jobctrl.apply.launcher import _authorize_posting_before_submit
    from jobctrl.domain.errors import MissingInputError
    from jobctrl.state import record_job_event, set_stage_state

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    context = {"run_id": "original", "dry_run": True}
    assert acquire_job(target_job_id=JobId(LOCAL_JOB_ID), approval_required=False, run_ctx=context)
    record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "StageSkipped",
                     payload={"previousState": "running", "manualDisposition": "skip"})
    # A later label cannot restore the revoked run's permission to send or settle.
    set_stage_state(conn, LOCAL_JOB_ID, "apply", "running", validate_transition=False)
    conn.commit()
    before = [tuple(row) for row in conn.execute("SELECT * FROM job_stage_states")]
    with pytest.raises(MissingInputError, match="no longer owns"):
        with _authorize_posting_before_submit(LOCAL_TENANT, LOCAL_JOB_ID, SHARED_URL, "original"):
            pytest.fail("revoked execution entered final intent")
    mark_result(JobId(LOCAL_JOB_ID), "applied", run_ctx=context)
    assert [tuple(row) for row in conn.execute("SELECT * FROM job_stage_states")] == before
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type IN ('ApplySubmitIntended','ApplicationSubmitted')").fetchone()[0] == 0


@pytest.mark.parametrize("intent_scope", ["earlier_run", "same_run", "during_agent", "other_tenant", "other_job", "none"])
def test_final_intent_rechecks_all_durable_job_intents_for_inherited_attempt(conn, monkeypatch, tmp_path, intent_scope):
    """An already-admitted activity must obey the same stop as a fresh claim."""
    from jobctrl.apply.launcher import SqliteApplyRunRepository, _authorize_posting_before_submit
    from jobctrl.domain.apply import ApplyRun
    from jobctrl.domain.apply.process_manager import ApplySaga
    from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state
    from tests.test_apply_saga import _FakeBrowser, _FakeAgent, _FakeEmailSender, _config, _prompt, _email_context

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    _insert_ready_job(conn, OTHER_TENANT, LOCAL_JOB_ID)
    _insert_ready_job(conn, LOCAL_TENANT, OTHER_JOB_ID, url=SHARED_URL + '-peer')
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, "score", "succeeded", validate_transition=False)
    set_stage_state(conn, LOCAL_JOB_ID, "apply", "running", attempt_count=2, validate_transition=False)
    current_run = "inherited-current"
    prior_run = current_run if intent_scope == "same_run" else "original-uncertain"
    intent_tenant = OTHER_TENANT if intent_scope == "other_tenant" else LOCAL_TENANT
    intent_job = OTHER_JOB_ID if intent_scope == "other_job" else LOCAL_JOB_ID
    if intent_scope not in {"none", "during_agent"}:
        record_job_event(conn, JobId(intent_job), "apply", "ApplySubmitIntended", tenant_id=TenantId(intent_tenant),
                         payload={"run_id": prior_run})
    record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "ApplyRunStarted", payload={"run_id": current_run})
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    before = [tuple(r) for r in conn.execute("SELECT * FROM job_materials_artifacts")]
    before_stage = tuple(conn.execute("SELECT state,version,attempt_count FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'", (LOCAL_TENANT, LOCAL_JOB_ID)).fetchone())

    class Agent(_FakeAgent):
        def submit_application(self, **kwargs):
            if intent_scope == "during_agent":
                with sqlite3.connect(tmp_path / "jobctrl.db") as writer:
                    record_job_event(writer, JobId(LOCAL_JOB_ID), "apply", "ApplySubmitIntended", payload={"run_id": prior_run})
            return super().submit_application(**kwargs)

    sender = _FakeEmailSender()
    saga = ApplySaga(browser_port=_FakeBrowser(), agent_port=Agent(behaviour="email_only"),
                     repository=SqliteApplyRunRepository(), email_sender=sender,
                     availability_authorizer=_authorize_posting_before_submit)
    run = ApplyRun.start(tenant_id=TenantId(LOCAL_TENANT), job_id=JobId(LOCAL_JOB_ID), run_id=current_run,
                         started_at=TIMESTAMP, worker_id=1, model="synthetic")
    saga.run(apply_run=run, browser_config=_config(), prompt=_prompt(), model="synthetic", posting_url=SHARED_URL,
             email_application_context=_email_context(approved_recipient_email="apply@example.com",
                                                       approved_attachment_artifact_id="resume-pdf-1"))
    blocked = intent_scope in {"earlier_run", "same_run", "during_agent"}
    intended = [json.loads(r[0])["run_id"] for r in conn.execute(
        "SELECT payload_json FROM job_events WHERE tenant_id=? AND job_id=? AND event_type='ApplySubmitIntended' ORDER BY event_id",
        (LOCAL_TENANT, LOCAL_JOB_ID))]
    print(json.dumps({"intent_scope": intent_scope, "tenant": LOCAL_TENANT, "job": LOCAL_JOB_ID,
                      "run": current_run, "intent_runs": intended, "sender_calls": len(sender.sent),
                      "events": dict(conn.execute("SELECT event_type,COUNT(*) FROM job_events WHERE tenant_id=? AND job_id=? GROUP BY event_type", (LOCAL_TENANT, LOCAL_JOB_ID)).fetchall()),
                      "stage_before": before_stage,
                      "stage_after": tuple(conn.execute("SELECT state,version,attempt_count FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'", (LOCAL_TENANT, LOCAL_JOB_ID)).fetchone()),
                      "artifact_rows_before": hashlib.sha256(repr(before).encode()).hexdigest(),
                      "artifact_rows_after": hashlib.sha256(repr([tuple(r) for r in conn.execute("SELECT * FROM job_materials_artifacts")]).encode()).hexdigest()}))
    assert len(sender.sent) == (0 if blocked else 1)
    assert intended == ([prior_run] if blocked else [current_run])
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplySubmissionBlocked'").fetchone()[0] == int(blocked)
    assert [tuple(r) for r in conn.execute("SELECT * FROM job_materials_artifacts")] == before
    assert tuple(conn.execute("SELECT state,version,attempt_count FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'", (LOCAL_TENANT, LOCAL_JOB_ID)).fetchone()) == before_stage


@pytest.mark.parametrize("state,history,allowed", [
    ("pending", "settled", True), ("pending", "none", True),
    ("running", "active", False), ("skipped", "skip", False),
    ("needs_verification", "intent", False), ("pending", "intent", False),
    ("pending", "active", False), ("succeeded", "settled", False),
])
def test_cli_manual_failure_reports_only_committed_safe_changes(conn, monkeypatch, state, history, allowed):
    from typer.testing import CliRunner
    from jobctrl import cli, database
    from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, "apply", state, attempt_count=2, validate_transition=False)
    if history != "none":
        record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "ApplyRunStarted", payload={"run_id": "original"})
    if history == "settled":
        record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "LockReleased", payload={"run_id": "original"})
    if history == "skip":
        record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "StageSkipped", payload={"manualDisposition": "skip", "previousState": "running"})
    if history == "intent":
        record_job_event(conn, JobId(LOCAL_JOB_ID), "apply", "ApplySubmitIntended", payload={"run_id": "original"})
    conn.commit()
    monkeypatch.setattr(cli, "_bootstrap", lambda: None)
    monkeypatch.setattr(database, "get_connection", lambda: conn)
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)
    before = {table: [tuple(r) for r in conn.execute(f"SELECT * FROM {table}")] for table in
              ["job_stage_states", "job_events", "job_materials_artifacts"]}
    result = CliRunner().invoke(cli.app, ["apply", "--mark-failed", SHARED_URL, "--fail-reason", "Synthetic local failure"])
    print(json.dumps({"state": state, "history": history, "exit_code": result.exit_code, "output": result.output}))
    if allowed:
        assert result.exit_code == 0, result.output
        assert "Marked as failed" in result.output
        assert tuple(conn.execute("SELECT state,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()) == ("failed", 2)
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplicationFailed'").fetchone()[0] == 1
        assert [tuple(r) for r in conn.execute("SELECT * FROM job_materials_artifacts")] == before["job_materials_artifacts"]
    else:
        assert result.exit_code != 0
        assert "Marked as failed" not in result.output
        assert "refused" in result.output.lower()
        assert {table: [tuple(r) for r in conn.execute(f"SELECT * FROM {table}")] for table in before} == before


@pytest.mark.parametrize("fail_event", [False, True])
def test_manual_failure_retains_caller_transaction_and_rolls_back_partial_event_write(conn, monkeypatch, fail_event):
    from jobctrl.apply import launcher
    from jobctrl.state import ensure_job_stage_rows, set_stage_state

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, "apply", "pending", attempt_count=2, validate_transition=False)
    conn.commit()
    monkeypatch.setattr(launcher, "get_connection", lambda: conn)
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("UPDATE jobs SET title='Caller-owned edit' WHERE job_id=?", (LOCAL_JOB_ID,))
    if fail_event:
        monkeypatch.setattr(launcher, "record_job_event", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("synthetic event failure")))
        with pytest.raises(RuntimeError, match="synthetic event failure"):
            mark_job(JobId(LOCAL_JOB_ID), "failed")
    else:
        mark_job(JobId(LOCAL_JOB_ID), "failed")
    assert conn.in_transaction
    assert conn.execute("SELECT title FROM jobs WHERE job_id=?", (LOCAL_JOB_ID,)).fetchone()[0] == 'Caller-owned edit'
    assert tuple(conn.execute("SELECT state,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()) == ("pending" if fail_event else "failed", 2)
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplicationFailed'").fetchone()[0] == (0 if fail_event else 1)
    conn.rollback()
    assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()[0] == "pending"


def test_automatic_score_recovery_after_relabel_cannot_release_manual_skip(conn, monkeypatch):
    from jobctrl.state import ensure_job_stage_rows, record_job_event, reset_job_stage, set_stage_state, reconcile_score_threshold_skips
    from jobctrl.infrastructure.apply_controls import APPLY_MANUAL_STOP_SQL

    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, 'score', 'succeeded', validate_transition=False)
    record_job_event(conn, JobId(LOCAL_JOB_ID), 'apply', 'StageSkipped', payload={'manualDisposition': 'skip', 'previousState': 'pending'})
    set_stage_state(conn, LOCAL_JOB_ID, 'apply', 'pending', validate_transition=False)
    before = [tuple(r) for r in conn.execute('SELECT * FROM job_materials_artifacts')]
    reconcile_score_threshold_skips(conn, tenant_id=TenantId(LOCAL_TENANT), job_id=JobId(LOCAL_JOB_ID), fit_score=3, min_score=7)
    reconcile_score_threshold_skips(conn, tenant_id=TenantId(LOCAL_TENANT), job_id=JobId(LOCAL_JOB_ID), fit_score=9, min_score=7)
    conn.commit()
    monkeypatch.setattr('jobctrl.apply.launcher.get_connection', lambda: conn)
    assert conn.execute(f'SELECT 1 FROM jobs WHERE {APPLY_MANUAL_STOP_SQL}').fetchone()
    for dry_run in [False, True]:
        for target in [JobId(LOCAL_JOB_ID), None]:
            assert acquire_job(target_job_id=target, approval_required=False, run_ctx={'dry_run': dry_run}) is None
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type IN ('ApplyRunStarted','ApplySubmitIntended')").fetchone()[0] == 0
    reset_job_stage(conn, LOCAL_JOB_ID, 'apply')
    assert acquire_job(target_job_id=JobId(LOCAL_JOB_ID), approval_required=False, run_ctx={'dry_run': True})
    assert [tuple(r) for r in conn.execute('SELECT * FROM job_materials_artifacts')] == before
    print({'job': LOCAL_JOB_ID, 'automatic_reset_claims': 0, 'explicit_reset_claims': 1})


@pytest.mark.parametrize('result,uncertain,expected', [
    ('applied', False, 'succeeded'), ('dry_run', False, 'skipped'),
    ('failed', False, 'failed'), ('failed', True, 'needs_verification'),
])
def test_apply_settlement_preserves_claimed_attempt_budget(conn, monkeypatch, result, uncertain, expected):
    from jobctrl.state import ensure_job_stage_rows, record_job_event, set_stage_state
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, 'apply', 'running', attempt_count=2, validate_transition=False)
    record_job_event(conn, JobId(LOCAL_JOB_ID), 'apply', 'ApplyRunStarted', payload={'run_id': 'settling'})
    if uncertain:
        record_job_event(conn, JobId(LOCAL_JOB_ID), 'apply', 'ApplySubmitIntended', payload={'run_id': 'settling'})
    conn.commit()
    monkeypatch.setattr('jobctrl.apply.launcher.get_connection', lambda: conn)
    before = [tuple(r) for r in conn.execute('SELECT * FROM job_materials_artifacts')]
    mark_result(JobId(LOCAL_JOB_ID), result, run_ctx={'run_id': 'settling'})
    assert tuple(conn.execute("SELECT state,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()) == (expected, 2)
    assert [tuple(r) for r in conn.execute('SELECT * FROM job_materials_artifacts')] == before


@pytest.mark.parametrize('intended', [False, True])
def test_apply_restart_recovery_retains_budget(conn, monkeypatch, intended):
    from jobctrl.state import ensure_job_stage_rows, set_stage_state, record_job_event
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, 'score', 'succeeded', validate_transition=False)
    set_stage_state(conn, LOCAL_JOB_ID, 'apply', 'running', attempt_count=2, validate_transition=False)
    record_job_event(conn, JobId(LOCAL_JOB_ID), 'apply', 'ApplyRunStarted', payload={'run_id': 'dead-owner'})
    if intended:
        record_job_event(conn, JobId(LOCAL_JOB_ID), 'apply', 'ApplySubmitIntended', payload={'run_id': 'dead-owner'})
    conn.commit()
    monkeypatch.setattr('jobctrl.apply.launcher.get_connection', lambda: conn)
    before = [tuple(r) for r in conn.execute('SELECT * FROM job_materials_artifacts')]
    assert recover_ambiguous_running_apply() == 1
    expected = 'needs_verification' if intended else 'pending'
    assert tuple(conn.execute("SELECT state,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()) == (expected, 2)
    assert recover_ambiguous_running_apply() == 0
    if intended:
        assert acquire_job(target_job_id=JobId(LOCAL_JOB_ID), approval_required=False) is None
    else:
        assert acquire_job(target_job_id=JobId(LOCAL_JOB_ID), approval_required=False)
        assert conn.execute("SELECT attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()[0] == 3
    assert [tuple(r) for r in conn.execute('SELECT * FROM job_materials_artifacts')] == before


@pytest.mark.parametrize('prior', ['needs_verification', 'skipped'])
def test_cli_mark_applied_retains_budget_and_intent(conn, monkeypatch, prior):
    from jobctrl import cli, database
    from jobctrl.state import ensure_job_stage_rows, set_stage_state, record_job_event
    from typer.testing import CliRunner
    _insert_ready_job(conn, LOCAL_TENANT, LOCAL_JOB_ID)
    ensure_job_stage_rows(conn, LOCAL_JOB_ID)
    set_stage_state(conn, LOCAL_JOB_ID, 'apply', prior, attempt_count=2, validate_transition=False)
    record_job_event(conn, JobId(LOCAL_JOB_ID), 'apply', 'ApplySubmitIntended', payload={'run_id': 'uncertain'})
    conn.commit()
    monkeypatch.setattr(cli, '_bootstrap', lambda: None)
    monkeypatch.setattr(database, 'get_connection', lambda: conn)
    monkeypatch.setattr('jobctrl.apply.launcher.get_connection', lambda: conn)
    before = [tuple(r) for r in conn.execute('SELECT * FROM job_materials_artifacts')]
    result = CliRunner().invoke(cli.app, ['apply', '--mark-applied', SHARED_URL])
    assert result.exit_code == 0, result.output
    assert 'Marked as applied' in result.output
    assert tuple(conn.execute("SELECT state,attempt_count FROM job_stage_states WHERE job_id=? AND stage='apply'", (LOCAL_JOB_ID,)).fetchone()) == ('succeeded', 2)
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplySubmitIntended'").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type='ApplicationManuallyMarked'").fetchone()[0] == 1
    assert acquire_job(target_job_id=JobId(LOCAL_JOB_ID), approval_required=False) is None
    assert [tuple(r) for r in conn.execute('SELECT * FROM job_materials_artifacts')] == before
