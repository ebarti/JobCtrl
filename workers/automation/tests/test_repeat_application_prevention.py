from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl import config
from jobctrl.apply import launcher
from jobctrl.apply.launcher import (
    acquire_job,
    gen_prompt,
    mark_job,
    release_lock,
    worker_loop,
)
from jobctrl.database import SCHEMA_VERSION, close_connection, get_connection, init_db
from jobctrl.domain.apply.repeat_application import (
    consume_repeat_application_override,
    evaluate_repeat_application,
    repeat_evidence_fingerprint,
)
from jobctrl.domain.apply.value_objects import ApplyPrompt
from jobctrl.state import ensure_job_stage_rows, get_stage_state_row, record_job_event

PRIOR = "https://jobs.example.test/prior"
TARGET = "https://careers.example.test/target"
NOW = "2026-07-20T08:00:00+00:00"


def _insert_job(
    conn: sqlite3.Connection,
    *,
    url: str,
    title: str,
    company: str,
    ready: bool = False,
    fit_score: int = 9,
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
          url, title, company, site, description, full_description,
          application_url, fit_score, tailored_resume_path, discovered_at
        ) VALUES (?, ?, ?, 'test', 'Build reliable systems.', 'Build reliable systems.',
                  ?, ?, ?, ?)
        """,
        (
            url,
            title,
            company,
            f"{url}/apply",
            fit_score,
            "/tmp/repeat-resume.txt" if ready else None,
            NOW,
        ),
    )
    if ready:
        job_id = str(
            conn.execute(
                "SELECT job_id FROM jobs WHERE url = ?",
                (url,),
            ).fetchone()[0]
        )
        conn.execute(
            """
            INSERT OR REPLACE INTO candidate_profiles (
              tenant_id, profile_id, version, updated_at
            ) VALUES ('local', 'default', 1, ?)
            """,
            (NOW,),
        )
        conn.execute(
            """
            INSERT INTO job_materials (
              tenant_id, job_id, generation, status, created_at, updated_at
            ) VALUES ('local', ?, 1, 'approved', ?, ?)
            """,
            (job_id, NOW, NOW),
        )
        for artifact_type, artifact_id, path in (
            ("tailored_resume", f"resume-{url}", "/tmp/repeat-resume.txt"),
            ("resume_pdf", f"pdf-{url}", "/tmp/repeat-resume.pdf"),
        ):
            conn.execute(
                """
                INSERT INTO job_materials_artifacts (
                  tenant_id, job_id, generation, artifact_type, artifact_id,
                  status, path, render_format, created_at
                ) VALUES ('local', ?, 1, ?, ?, 'approved', ?, 'text', ?)
                """,
                (job_id, artifact_type, artifact_id, path, NOW),
            )
        ensure_job_stage_rows(conn, url)
    conn.commit()


def _confirm_application(
    conn: sqlite3.Connection,
    job_key: str = PRIOR,
    event_type: str = "ApplicationSubmitted",
) -> None:
    record_job_event(
        conn,
        job_key,
        "apply",
        event_type,
        occurred_at=NOW,
        payload={"run_id": "prior-run"},
    )
    conn.commit()


def _insert_override(
    conn: sqlite3.Connection,
    assessment: dict,
    *,
    override_id: str = "repeat-override-1",
    target_job_key: str = TARGET,
) -> None:
    primary = assessment["matches"][0]
    conn.execute(
        """
        INSERT INTO application_repeat_overrides (
          tenant_id, override_id, target_job_id, prior_job_id, relationship,
          evidence_fingerprint, evidence_json, reason, confirmed_by, confirmed_at
        ) VALUES (
          'local',
          ?,
          (
            SELECT job_id FROM jobs
            WHERE tenant_id = 'local' AND url = ?
          ),
          (
            SELECT job_id FROM jobs
            WHERE tenant_id = 'local' AND url = ?
          ),
          ?, ?, ?, ?, 'qa-user', ?
        )
        """,
        (
            override_id,
            target_job_key,
            primary["priorApplication"]["jobKey"],
            primary["relationship"],
            assessment["evidenceFingerprint"],
            json.dumps(assessment["matches"], separators=(",", ":")),
            "The prior application was withdrawn before review.",
            NOW,
        ),
    )
    conn.commit()


def _seed_equivalent_repeat(db_path: Path) -> sqlite3.Connection:
    conn = init_db(db_path)
    _insert_job(
        conn,
        url=PRIOR,
        title="Senior Backend Engineer",
        company="Acme Inc",
    )
    _insert_job(
        conn,
        url=TARGET,
        title="Backend Senior Eng",
        company="ACME, INC.",
        ready=True,
    )
    _confirm_application(conn)
    return conn


def test_worker_fingerprint_matches_shared_portable_multi_match_fixture() -> None:
    fixture_path = (
        Path(__file__).resolve().parents[3]
        / "packages/domain-types/test/fixtures/repeat_application_fingerprint_parity.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))

    assert repeat_evidence_fingerprint(fixture["targetJobKey"], fixture["matches"]) == fixture["expectedFingerprint"]
    assert (
        repeat_evidence_fingerprint(fixture["targetJobKey"], list(reversed(fixture["matches"])))
        == fixture["expectedFingerprint"]
    )


def test_exact_canonical_and_accepted_duplicate_identities_block(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobs.db")
    _insert_job(conn, url=PRIOR, title="Platform Engineer", company="Acme")
    _insert_job(conn, url=TARGET, title="Different label", company="Different employer")
    _confirm_application(conn)
    for job_key in (PRIOR, TARGET):
        conn.execute(
            """
            INSERT INTO job_canonical_identities (
              tenant_id, job_id, canonical_url, ats_kind, source_native_id,
              confidence, resolved_at
            ) VALUES (
              'local',
              (SELECT job_id FROM jobs WHERE url = ?),
              'https://boards.example.test/jobs/123',
              'greenhouse',
              'gh-123',
              1,
              ?
            )
            """,
            (job_key, NOW),
        )
    conn.commit()

    exact = evaluate_repeat_application(conn, TARGET)
    assert exact["status"] == "blocked"
    assert exact["matches"][0]["relationship"] == "canonical_identity"

    conn.execute("DELETE FROM job_canonical_identities")
    conn.execute(
        """
        INSERT INTO job_duplicate_links (
          tenant_id, duplicate_link_id, surviving_job_id,
          superseded_job_or_observation_id, reason, confidence, linked_at
        ) VALUES (
          'local',
          'accepted-link',
          (SELECT job_id FROM jobs WHERE url = ?),
          ?,
          'accepted_content_identity',
          0.99,
          ?
        )
        """,
        (TARGET, PRIOR, NOW),
    )
    conn.commit()

    linked = evaluate_repeat_application(conn, TARGET)
    assert linked["status"] == "blocked"
    assert linked["matches"][0]["relationship"] == "accepted_duplicate"


def test_projected_employer_preserves_repeat_evidence_when_job_company_is_missing(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobs.db")
    _insert_job(conn, url=PRIOR, title="Senior Backend Engineer", company="")
    _insert_job(conn, url=TARGET, title="Backend Senior Eng", company="", ready=True)
    conn.execute("UPDATE jobs SET company = NULL")
    conn.execute("DELETE FROM job_list_projections")
    conn.executemany(
        """
        INSERT INTO job_list_projections (tenant_id, job_id, employer)
        VALUES ('local', ?, 'Acme Inc')
        """,
        [(PRIOR,), (TARGET,)],
    )
    _confirm_application(conn)

    assessment = evaluate_repeat_application(conn, TARGET)

    assert assessment["status"] == "confirmation_required"
    match = assessment["matches"][0]
    assert match["relationship"] == "same_employer_equivalent_role"
    assert match["priorApplication"]["company"] == "Acme Inc"
    assert match["identityEvidence"][0] == "employer:acme"


def test_equivalent_role_requires_confirmation_but_distinct_and_similar_employers_clear(
    tmp_path: Path,
) -> None:
    conn = _seed_equivalent_repeat(tmp_path / "jobs.db")
    assert evaluate_repeat_application(conn, TARGET)["status"] == "confirmation_required"

    conn.execute("UPDATE jobs SET title = 'Engineering Manager' WHERE url = ?", (TARGET,))
    conn.commit()
    assert evaluate_repeat_application(conn, TARGET)["status"] == "clear"

    conn.execute(
        "UPDATE jobs SET title = 'Senior Backend Engineer', company = 'Acme Health' WHERE url = ?",
        (TARGET,),
    )
    conn.commit()
    assert evaluate_repeat_application(conn, TARGET)["status"] == "clear"


def test_audit_trail_orders_equal_timestamps_by_sqlite_insertion_order(tmp_path: Path) -> None:
    conn = _seed_equivalent_repeat(tmp_path / "jobs.db")
    initial = evaluate_repeat_application(conn, TARGET, evaluated_at=NOW)
    _insert_override(conn, initial)
    ready = evaluate_repeat_application(conn, TARGET, record_audit=False, evaluated_at=NOW)
    assert ready["status"] == "override_ready"
    consume_repeat_application_override(
        conn,
        ready,
        target_job_key=TARGET,
        run_id="equal-timestamp-run",
        consumed_at=NOW,
    )

    # UUIDs do not encode insertion order.  Force the tied timestamps into
    # the inverse lexical UUID order to reproduce the production race.
    conn.execute(
        "UPDATE application_repeat_audit SET audit_id = ? WHERE action = 'confirmation_required'",
        ("ffffffff-ffff-ffff-ffff-ffffffffffff",),
    )
    conn.execute(
        "UPDATE application_repeat_audit SET audit_id = ? WHERE action = 'override_consumed'",
        ("00000000-0000-0000-0000-000000000000",),
    )
    ordered = evaluate_repeat_application(conn, TARGET, record_audit=False, evaluated_at=NOW)

    assert ordered["auditTrail"][0]["action"] == "override_consumed"
    assert ordered["auditTrail"][0]["priorJobKey"] == PRIOR


def test_unconfirmed_sources_do_not_establish_application_history(tmp_path: Path) -> None:
    conn = init_db(tmp_path / "jobs.db")
    _insert_job(conn, url=PRIOR, title="Senior Backend Engineer", company="Acme")
    _insert_job(conn, url=TARGET, title="Senior Backend Engineer", company="Acme")
    for event_type in ("DryRunCompleted", "ApplicationFailed", "ApplySubmitIntended"):
        record_job_event(
            conn,
            PRIOR,
            "apply",
            event_type,
            occurred_at=NOW,
            payload={"run_id": event_type},
        )
    conn.execute(
        """
        INSERT INTO application_outcome_suggestions
          (tenant_id, suggestion_id, job_id, suggested_kind, status, created_at)
        VALUES (
          'local',
          'pending-suggestion',
          (
            SELECT job_id FROM jobs
            WHERE tenant_id = 'local' AND url = ?
          ),
          'applied_confirmation',
          'pending',
          ?
        )
        """,
        (PRIOR, NOW),
    )
    conn.commit()

    assert evaluate_repeat_application(conn, TARGET)["status"] == "clear"


def test_manual_mark_is_a_user_attested_confirmed_fact_not_a_submission(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    _insert_job(conn, url=PRIOR, title="Senior Backend Engineer", company="Acme")
    _insert_job(conn, url=TARGET, title="Senior Backend Engineer", company="Acme")
    monkeypatch.setattr(
        "jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path)
    )

    mark_job(PRIOR, "applied", reason="Applied outside JobCtrl.")

    events = conn.execute(
        "SELECT event_type, payload_json FROM job_events WHERE job_url = ? ORDER BY event_id",
        (PRIOR,),
    ).fetchall()
    assert [row["event_type"] for row in events] == ["ApplicationManuallyMarked"]
    assert json.loads(events[0]["payload_json"])["source"] == "user_attestation"
    assert get_stage_state_row(conn, PRIOR, "apply")["state"] == "succeeded"
    assessment = evaluate_repeat_application(conn, TARGET)
    assert assessment["status"] == "confirmation_required"
    assert assessment["matches"][0]["priorApplication"]["factKind"] == (
        "application_manually_marked"
    )


def test_authoritative_claim_blocks_direct_dispatch_and_repeated_standing_polls(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = _seed_equivalent_repeat(db_path)
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))

    assert (
        acquire_job(
            target_url=TARGET,
            worker_id=1,
            approval_required=False,
            run_ctx={"dry_run": False, "run_id": "direct-bypass"},
        )
        is None
    )
    assert acquire_job(worker_id=2, approval_required=False) is None
    assert acquire_job(worker_id=2, approval_required=False) is None

    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE job_url = ? AND event_type = 'ApplyRunStarted'",
            (TARGET,),
        ).fetchone()[0]
        == 0
    )
    assert (
        conn.execute(
            """
            SELECT COUNT(*)
            FROM application_repeat_audit
            WHERE tenant_id = 'local'
              AND target_job_id = (
                SELECT job_id FROM jobs
                WHERE tenant_id = 'local' AND url = ?
              )
              AND action = 'confirmation_required'
            """,
            (TARGET,),
        ).fetchone()[0]
        == 1
    )

    dry_run = acquire_job(
        target_url=TARGET,
        worker_id=3,
        approval_required=False,
        run_ctx={"dry_run": True, "run_id": "safe-dry-run"},
    )
    assert dry_run is not None
    release_lock(TARGET, run_ctx={"run_id": "safe-dry-run"})


def test_non_targeted_claim_skips_protected_high_ranked_job_for_distinct_role(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = _seed_equivalent_repeat(db_path)
    clear_job = "https://careers.example.test/distinct-role"
    _insert_job(
        conn,
        url=clear_job,
        title="Engineering Manager",
        company="Acme Inc",
        ready=True,
        fit_score=8,
    )
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))

    claimed = acquire_job(worker_id=5, approval_required=False)

    assert claimed is not None
    assert claimed["url"] == clear_job
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE job_url = ? AND event_type = 'ApplyRunStarted'",
            (TARGET,),
        ).fetchone()[0]
        == 0
    )
    assert (
        conn.execute(
            """
            SELECT COUNT(*)
            FROM application_repeat_audit
            WHERE tenant_id = 'local'
              AND target_job_id = (
                SELECT job_id FROM jobs
                WHERE tenant_id = 'local' AND url = ?
              )
              AND action = 'confirmation_required'
            """,
            (TARGET,),
        ).fetchone()[0]
        == 1
    )
    release_lock(clear_job, run_ctx={"run_id": str(claimed["apply_run_id"])})


def test_protected_queue_audit_survives_lower_candidate_approval_refusal(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = _seed_equivalent_repeat(db_path)
    _insert_job(
        conn,
        url="https://careers.example.test/awaiting-approval",
        title="Engineering Manager",
        company="Acme Inc",
        ready=True,
        fit_score=8,
    )
    monkeypatch.setattr(
        "jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path)
    )

    assert acquire_job(worker_id=51, approval_required=True) is None
    assert conn.execute(
        """
        SELECT COUNT(*)
        FROM application_repeat_audit
        WHERE tenant_id = 'local'
          AND target_job_id = (
            SELECT job_id FROM jobs
            WHERE tenant_id = 'local' AND url = ?
          )
          AND action = 'confirmation_required'
        """,
        (TARGET,),
    ).fetchone()[0] == 1


def test_standing_loop_skips_protected_candidate_and_processes_distinct_role(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = _seed_equivalent_repeat(db_path)
    clear_job = "https://careers.example.test/standing-distinct-role"
    _insert_job(
        conn,
        url=clear_job,
        title="Engineering Manager",
        company="Acme Inc",
        ready=True,
        fit_score=8,
    )
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(
        "jobctrl.browser_capabilities.require_system_browser_capability",
        lambda _capability: None,
    )

    def simulated_failure(job: dict, **_kwargs) -> tuple[str, int]:
        assert job["url"] == clear_job
        launcher._stop_event.set()
        return "failed:simulated_boundary", 1

    monkeypatch.setattr("jobctrl.apply.launcher.run_job", simulated_failure)
    launcher._stop_event.clear()
    try:
        applied, failed = worker_loop(
            worker_id=6,
            limit=0,
            approval_required=False,
            workflow_id="standing-repeat-qa",
            snapshot=object(),
        )
    finally:
        launcher._stop_event.clear()

    assert (applied, failed) == (0, 1)
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE job_url = ? AND event_type = 'ApplyRunStarted'",
            (TARGET,),
        ).fetchone()[0]
        == 0
    )
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE job_url = ? AND event_type = 'ApplicationFailed'",
            (clear_job,),
        ).fetchone()[0]
        == 1
    )


def test_worker_batch_uses_unique_attempt_ids_for_two_repeat_overrides(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    targets = (
        (PRIOR, TARGET, "Senior Backend Engineer", "Acme", 10),
        (
            "https://jobs.example.test/prior-data",
            "https://careers.example.test/target-data",
            "Senior Data Engineer",
            "Globex",
            9,
        ),
    )
    for index, (prior, target, title, company, fit_score) in enumerate(targets, start=1):
        _insert_job(conn, url=prior, title=title, company=company)
        _insert_job(
            conn,
            url=target,
            title=title,
            company=company,
            ready=True,
            fit_score=fit_score,
        )
        _confirm_application(conn, prior)
        assessment = evaluate_repeat_application(conn, target)
        _insert_override(
            conn,
            assessment,
            override_id=f"repeat-batch-override-{index}",
            target_job_key=target,
        )

    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(
        "jobctrl.browser_capabilities.require_system_browser_capability",
        lambda _capability: None,
    )
    monkeypatch.setattr(
        "jobctrl.apply.launcher.run_job",
        lambda _job, **_kwargs: ("failed:simulated_boundary", 1),
    )
    launcher._stop_event.clear()

    applied, failed = worker_loop(
        worker_id=7,
        limit=2,
        approval_required=False,
        workflow_id="repeat-batch-workflow",
        snapshot=object(),
    )

    assert (applied, failed) == (0, 2)
    consumptions = conn.execute(
        "SELECT override_id, run_id FROM application_repeat_override_consumptions ORDER BY override_id"
    ).fetchall()
    assert len(consumptions) == 2
    assert len({str(row["run_id"]) for row in consumptions}) == 2
    starts = conn.execute(
        "SELECT payload_json FROM job_events WHERE event_type = 'ApplyRunStarted' ORDER BY event_id"
    ).fetchall()
    start_payloads = [json.loads(row["payload_json"]) for row in starts]
    assert len({payload["run_id"] for payload in start_payloads}) == 2
    assert {payload["workflow_id"] for payload in start_payloads} == {"repeat-batch-workflow"}


def test_gen_prompt_is_read_only_and_cannot_consume_repeat_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = _seed_equivalent_repeat(db_path)
    _insert_override(conn, evaluate_repeat_application(conn, TARGET))
    app_dir = tmp_path / "app"
    log_dir = tmp_path / "logs"
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))
    monkeypatch.setattr(config, "APP_DIR", app_dir)
    monkeypatch.setattr(config, "LOG_DIR", log_dir)

    def ensure_test_dirs() -> None:
        app_dir.mkdir(parents=True, exist_ok=True)
        log_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setattr(config, "ensure_dirs", ensure_test_dirs)
    monkeypatch.setattr(
        "jobctrl.infrastructure.network.validate_public_http_url",
        lambda _url: SimpleNamespace(allowed=True, reason=None),
    )

    class InspectionBuilder:
        def build(self, **kwargs) -> ApplyPrompt:
            assert kwargs["dry_run"] is True
            return ApplyPrompt(
                "Inspection-only repeat-application prompt",
                {"mcpServers": {"playwright": {"command": "must-not-survive"}}},
            )

    monkeypatch.setattr("jobctrl.apply.launcher.ApplyPromptBuilder", InspectionBuilder)

    prompt_path = gen_prompt(TARGET, snapshot=object())

    assert prompt_path is not None
    assert prompt_path.read_text(encoding="utf-8") == ("Inspection-only repeat-application prompt")
    assert json.loads((app_dir / ".mcp-apply-0.json").read_text(encoding="utf-8")) == {"mcpServers": {}}
    assert conn.execute("SELECT COUNT(*) FROM application_repeat_override_consumptions").fetchone()[0] == 0
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE job_url = ? AND event_type = 'ApplyRunStarted'",
            (TARGET,),
        ).fetchone()[0]
        == 0
    )
    assert (
        get_stage_state_row(conn, TARGET, "apply")["state"]
        == "pending"
    )


def test_override_is_consumed_once_under_concurrent_claims(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = _seed_equivalent_repeat(db_path)
    assessment = evaluate_repeat_application(conn, TARGET)
    _insert_override(conn, assessment)
    close_connection(db_path)
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))

    results: list[dict | None] = []
    lock = threading.Lock()
    ready = threading.Event()

    def claim(worker_id: int) -> None:
        ready.wait()
        try:
            result = acquire_job(
                target_url=TARGET,
                worker_id=worker_id,
                approval_required=False,
                run_ctx={"dry_run": False, "run_id": f"concurrent-{worker_id}"},
            )
        except sqlite3.OperationalError:
            result = None
        finally:
            close_connection(db_path)
        with lock:
            results.append(result)

    threads = [threading.Thread(target=claim, args=(worker_id,)) for worker_id in (1, 2)]
    for thread in threads:
        thread.start()
    ready.set()
    for thread in threads:
        thread.join(timeout=10)

    assert all(not thread.is_alive() for thread in threads)
    assert sum(result is not None for result in results) == 1
    check = get_connection(db_path)
    assert check.execute("SELECT COUNT(*) FROM application_repeat_override_consumptions").fetchone()[0] == 1
    consumed = check.execute("SELECT run_id FROM application_repeat_override_consumptions").fetchone()[0]
    assert consumed in {"concurrent-1", "concurrent-2"}
    assert (
        check.execute("SELECT COUNT(*) FROM application_repeat_audit WHERE action = 'override_consumed'").fetchone()[0]
        == 1
    )


def test_stale_apply_approval_does_not_consume_repeat_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = _seed_equivalent_repeat(db_path)
    _insert_override(conn, evaluate_repeat_application(conn, TARGET))
    target_job_id = conn.execute(
        """
        SELECT job_id
        FROM jobs
        WHERE tenant_id = 'local' AND url = ?
        """,
        (TARGET,),
    ).fetchone()[0]
    conn.execute(
        """
        INSERT INTO application_review_decisions (
          tenant_id, decision_id, job_id, decision, reason, decided_by, decided_at,
          materials_generation, profile_version, application_url
        ) VALUES ('local', 'stale-approval', ?, 'approve_submit', 'test', 'qa', ?,
                  0, 1, ?)
        """,
        (target_job_id, NOW, f"{TARGET}/apply"),
    )
    conn.commit()
    monkeypatch.setattr("jobctrl.apply.launcher.get_connection", lambda: get_connection(db_path))

    assert acquire_job(target_url=TARGET, worker_id=4, approval_required=True) is None
    assert conn.execute("SELECT COUNT(*) FROM application_repeat_override_consumptions").fetchone()[0] == 0


def test_schema_v5_migrates_additively_without_changing_application_facts(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    _insert_job(conn, url=PRIOR, title="Platform Engineer", company="Acme")
    _confirm_application(conn)
    conn.executescript(
        """
        DROP TABLE application_repeat_audit;
        DROP TABLE application_repeat_override_consumptions;
        DROP TABLE application_repeat_overrides;
        ALTER TABLE job_stage_states DROP COLUMN metadata_json;
        PRAGMA user_version = 5;
        """
    )
    before = conn.execute(
        "SELECT event_type, occurred_at, payload_json FROM job_events WHERE job_url = ?",
        (PRIOR,),
    ).fetchall()
    conn.close()

    migrated = init_db(db_path)
    after = migrated.execute(
        "SELECT event_type, occurred_at, payload_json FROM job_events WHERE job_url = ?",
        (PRIOR,),
    ).fetchall()

    assert int(migrated.execute("PRAGMA user_version").fetchone()[0]) == SCHEMA_VERSION == 23
    assert [tuple(row) for row in after] == [tuple(row) for row in before]
    assert "metadata_json" in {
        str(row[1]) for row in migrated.execute("PRAGMA table_info(job_stage_states)").fetchall()
    }
    for table_name in (
        "application_repeat_overrides",
        "application_repeat_override_consumptions",
        "application_repeat_audit",
    ):
        assert migrated.execute(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
            (table_name,),
        ).fetchone()
