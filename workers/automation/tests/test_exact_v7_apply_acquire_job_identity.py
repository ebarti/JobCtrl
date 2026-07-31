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

import pytest

from jobctrl.apply.launcher import _latest_apply_review_decision, acquire_job
from jobctrl.apply.origins import canonical_http_url
from jobctrl.database import init_db
from jobctrl.domain.apply.repeat_application import (
    consume_repeat_application_override,
    evaluate_repeat_application,
    repeat_evidence_fingerprint,
)
from jobctrl.domain.identifiers import canonical_job_id
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


def _insert_profile(conn: sqlite3.Connection, tenant_id: str, version: int) -> None:
    conn.execute(
        """
        INSERT INTO candidate_profiles (tenant_id, profile_id, version, updated_at)
        VALUES (?, 'default', ?, ?)
        """,
        (tenant_id, version, TIMESTAMP),
    )


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
    navigation_fingerprint = hashlib.sha256(
        canonical_http_url(application_url).encode("utf-8")
    ).hexdigest()
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

    assert acquire_job(
        target_url=SHARED_URL,
        tenant_id=LOCAL_TENANT,
        approval_required=True,
    ) is None

    _insert_approval_with_dry_run(
        conn,
        LOCAL_TENANT,
        LOCAL_JOB_ID,
        profile_version=1,
    )
    conn.commit()

    run_ctx: dict[str, object] = {}
    job = acquire_job(
        target_url=SHARED_URL,
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
    assert conn.execute(
        """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID),
    ).fetchone()["state"] == "running"
    assert conn.execute(
        """
        SELECT COUNT(*) FROM job_events
        WHERE tenant_id = ? AND job_id = ? AND event_type = 'ApplyRunStarted'
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID),
    ).fetchone()[0] == 2
    assert conn.execute(
        """
        SELECT COUNT(*) FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
        (OTHER_TENANT, OTHER_JOB_ID),
    ).fetchone()[0] == 0


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
    assert conn.execute(
        """
        SELECT COUNT(*) FROM application_repeat_audit
        WHERE tenant_id = ? AND target_job_id = ?
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID),
    ).fetchone()[0] == 0


def test_targeted_acquire_resolves_retired_alias_without_prefix_collision(
    conn: sqlite3.Connection,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    alias = "https://example.test/jobs/123"
    wrong_job_id = "90000000-0000-4000-8000-000000000031"
    target_job_id = "90000000-0000-4000-8000-000000000032"
    _insert_ready_job(
        conn,
        LOCAL_TENANT,
        wrong_job_id,
        url=f"{alias}-extra",
    )
    _insert_ready_job(
        conn,
        LOCAL_TENANT,
        target_job_id,
        url="https://example.test/jobs/456",
    )
    conn.execute(
        """
        INSERT INTO job_locators (
            tenant_id, job_id, locator_kind, locator_value,
            is_current, first_seen_at, last_seen_at, retired_at
        ) VALUES (?, ?, 'posting_url', ?, 0, ?, ?, ?)
        """,
        (LOCAL_TENANT, target_job_id, alias, TIMESTAMP, TIMESTAMP, TIMESTAMP),
    )
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: conn)

    job = acquire_job(
        target_url=alias,
        tenant_id=LOCAL_TENANT,
        approval_required=False,
    )

    assert job is not None
    assert job["job_id"] == target_job_id
    assert conn.execute(
        """
        SELECT state FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
        (LOCAL_TENANT, target_job_id),
    ).fetchone()["state"] == "running"
    assert conn.execute(
        """
        SELECT COUNT(*) FROM job_stage_states
        WHERE tenant_id = ? AND job_id = ? AND stage = 'apply'
        """,
        (LOCAL_TENANT, wrong_job_id),
    ).fetchone()[0] == 0


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

    assert conn.execute(
        """
        SELECT COUNT(*) FROM application_repeat_override_consumptions
        WHERE tenant_id = ? AND override_id = ?
        """,
        (LOCAL_TENANT, override_id),
    ).fetchone()[0] == 0


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
    assert conn.execute(
        """
        SELECT COUNT(*) FROM application_repeat_audit
        WHERE tenant_id = ? AND target_job_id = ?
        """,
        (LOCAL_TENANT, LOCAL_JOB_ID),
    ).fetchone()[0] == 0
