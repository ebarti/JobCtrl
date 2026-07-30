"""Schema-v23 repeat-application stable JobId reference contracts."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

import pytest

import jobctrl.database as database_module
from jobctrl.database import (
    SCHEMA_VERSION,
    close_connection,
    ensure_repeat_application_references_v23,
    init_db,
    reassign_discovery_identity_references,
)
from jobctrl.domain.apply.repeat_application import (
    ensure_repeat_application_tables,
    evaluate_repeat_application,
)
from jobctrl.state import record_job_event


PREVIOUS_SCHEMA_VERSION = 22
NOW = "2026-07-30T10:00:00+00:00"
UUID_SHAPED_URL = "11111111-1111-4111-8111-111111111111"
TARGET_JOB_ID = "22222222-2222-4222-8222-222222222222"
COLLIDING_JOB_ID = UUID_SHAPED_URL
PRIOR_JOB_ID = "33333333-3333-4333-8333-333333333333"
SURVIVOR_JOB_ID = "44444444-4444-4444-8444-444444444444"
OTHER_JOB_ID = "55555555-5555-4555-8555-555555555555"
OTHER_PRIOR_JOB_ID = "66666666-6666-4666-8666-666666666666"


def _columns(
    conn: sqlite3.Connection,
    table_name: str,
) -> set[str]:
    return {
        str(row[1])
        for row in conn.execute(
            f'PRAGMA table_info("{table_name}")'
        ).fetchall()
    }


def _insert_job(
    conn: sqlite3.Connection,
    *,
    url: str,
    job_id: str,
    tenant_id: str = "local",
    title: str = "Senior Platform Engineer",
    company: str = "ExampleCo",
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (
            url, tenant_id, job_id, title, company, site, description,
            discovered_at
        ) VALUES (?, ?, ?, ?, ?, 'test', 'Build reliable systems.', ?)
        """,
        (url, tenant_id, job_id, title, company, NOW),
    )


def _downgrade_repeat_tables_to_v22(
    conn: sqlite3.Connection,
) -> None:
    conn.commit()
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.executescript(
        """
        DROP TABLE application_repeat_audit;
        DROP TABLE application_repeat_override_consumptions;
        DROP TABLE application_repeat_overrides;
        """
    )
    database_module._create_repeat_application_overrides_table_v23(
        conn,
        table="application_repeat_overrides",
        stable_references=False,
    )
    database_module._create_repeat_application_consumptions_table_v23(
        conn,
        table="application_repeat_override_consumptions",
    )
    database_module._create_repeat_application_audit_table_v23(
        conn,
        table="application_repeat_audit",
        stable_reference=False,
    )
    database_module._create_repeat_application_indexes_v23(
        conn,
        target_reference="target_job_key",
        prior_reference="prior_job_key",
        audit_reference="target_job_key",
    )
    conn.execute(
        f"PRAGMA user_version = {PREVIOUS_SCHEMA_VERSION}"
    )
    conn.commit()
    conn.execute("PRAGMA foreign_keys = ON")


def _insert_legacy_override(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    override_id: str,
    target_job_key: str,
    prior_job_key: str,
    fingerprint: str,
    evidence_json: str,
) -> None:
    conn.execute(
        """
        INSERT INTO application_repeat_overrides (
            tenant_id, override_id, target_job_key, prior_job_key,
            relationship, evidence_fingerprint, evidence_json, reason,
            confirmed_by, confirmed_at
        ) VALUES (?, ?, ?, ?, 'canonical_identity', ?, ?, ?, ?, ?)
        """,
        (
            tenant_id,
            override_id,
            target_job_key,
            prior_job_key,
            fingerprint,
            evidence_json,
            f"reason:{override_id}",
            f"actor:{override_id}",
            NOW,
        ),
    )


def _insert_legacy_audit(
    conn: sqlite3.Connection,
    *,
    tenant_id: str,
    audit_id: str,
    target_job_key: str,
    fingerprint: str,
    evidence_json: str,
    override_id: str | None,
) -> None:
    conn.execute(
        """
        INSERT INTO application_repeat_audit (
            tenant_id, audit_id, audit_key, target_job_key, action,
            evidence_fingerprint, evidence_json, override_id, actor,
            reason, occurred_at
        ) VALUES (?, ?, ?, ?, 'override_recorded', ?, ?, ?, ?, ?, ?)
        """,
        (
            tenant_id,
            audit_id,
            f"audit-key:{audit_id}",
            target_job_key,
            fingerprint,
            evidence_json,
            override_id,
            f"actor:{audit_id}",
            f"reason:{audit_id}",
            NOW,
        ),
    )


def _legacy_snapshot(
    conn: sqlite3.Connection,
) -> dict[str, list[tuple[Any, ...]]]:
    return {
        table: [
            tuple(row)
            for row in conn.execute(
                f'SELECT * FROM "{table}" ORDER BY tenant_id, rowid'
            ).fetchall()
        ]
        for table in database_module._REPEAT_APPLICATION_REFERENCE_TABLES
    }


def _seed_v22_database(db_path: Path) -> sqlite3.Connection:
    conn = init_db(db_path)
    _downgrade_repeat_tables_to_v22(conn)
    return conn


def test_v22_history_migrates_exactly_with_url_first_resolution(
    tmp_path: Path,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = _seed_v22_database(db_path)
    prior_url = "https://careers.example.test/prior-current"
    prior_alias = "https://legacy.example.test/prior"
    colliding_owner_url = "https://careers.example.test/uuid-id-owner"
    blue_target_url = "https://blue.example.test/target"
    blue_prior_url = "https://blue.example.test/prior"
    _insert_job(
        conn,
        url=UUID_SHAPED_URL,
        job_id=TARGET_JOB_ID,
    )
    _insert_job(
        conn,
        url=colliding_owner_url,
        job_id=COLLIDING_JOB_ID,
    )
    _insert_job(
        conn,
        url=prior_url,
        job_id=PRIOR_JOB_ID,
    )
    _insert_job(
        conn,
        url=blue_target_url,
        job_id=TARGET_JOB_ID,
        tenant_id="blue",
    )
    _insert_job(
        conn,
        url=blue_prior_url,
        job_id=PRIOR_JOB_ID,
        tenant_id="blue",
    )
    conn.execute(
        """
        INSERT INTO job_identity_aliases (
            tenant_id, alias_kind, alias_value, job_id, created_at
        ) VALUES ('local', 'posting_url', ?, ?, ?)
        """,
        (prior_alias, PRIOR_JOB_ID, NOW),
    )
    local_evidence = (
        '[ { "priorApplication": { "jobKey": '
        f'"{prior_alias}" }}, "private:verbatim" ]'
    )
    blue_evidence = (
        '[{"priorApplication":{"jobKey":'
        f'"{blue_prior_url}"}}}}]'
    )
    _insert_legacy_override(
        conn,
        tenant_id="local",
        override_id="override:local",
        target_job_key=UUID_SHAPED_URL,
        prior_job_key=prior_alias,
        fingerprint="fingerprint:local",
        evidence_json=local_evidence,
    )
    _insert_legacy_override(
        conn,
        tenant_id="blue",
        override_id="override:blue",
        target_job_key=blue_target_url,
        prior_job_key=blue_prior_url,
        fingerprint="fingerprint:blue",
        evidence_json=blue_evidence,
    )
    conn.executemany(
        """
        INSERT INTO application_repeat_override_consumptions (
            tenant_id, override_id, run_id, consumed_at
        ) VALUES (?, ?, ?, ?)
        """,
        (
            ("local", "override:local", "run:local", NOW),
            ("blue", "override:blue", "run:blue", NOW),
            (
                "local",
                "override:historical-orphan",
                "run:historical-orphan",
                NOW,
            ),
        ),
    )
    _insert_legacy_audit(
        conn,
        tenant_id="local",
        audit_id="audit:local",
        target_job_key=UUID_SHAPED_URL,
        fingerprint="fingerprint:local",
        evidence_json=local_evidence,
        override_id="override:local",
    )
    _insert_legacy_audit(
        conn,
        tenant_id="blue",
        audit_id="audit:blue",
        target_job_key=blue_target_url,
        fingerprint="fingerprint:blue",
        evidence_json=blue_evidence,
        override_id="override:blue",
    )
    conn.commit()
    before_consumptions = [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, override_id, run_id, consumed_at
            FROM application_repeat_override_consumptions
            ORDER BY tenant_id
            """
        ).fetchall()
    ]

    assert ensure_repeat_application_references_v23(conn) == list(
        database_module._REPEAT_APPLICATION_REFERENCE_TABLES
    )

    assert conn.execute("PRAGMA user_version").fetchone()[0] == 23
    assert database_module._has_repeat_application_reference_schema_v23(
        conn
    )
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    assert conn.execute(
        """
        PRAGMA foreign_key_list(
            "application_repeat_override_consumptions"
        )
        """
    ).fetchall() == []
    assert {
        str(row[2])
        for row in conn.execute(
            'PRAGMA foreign_key_list("application_repeat_audit")'
        ).fetchall()
    } == {"jobs"}
    migrated = [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, override_id, target_job_id, prior_job_id,
                   evidence_fingerprint, evidence_json
            FROM application_repeat_overrides
            ORDER BY tenant_id
            """
        ).fetchall()
    ]
    assert migrated == [
        (
            "blue",
            "override:blue",
            TARGET_JOB_ID,
            PRIOR_JOB_ID,
            "fingerprint:blue",
            blue_evidence,
        ),
        (
            "local",
            "override:local",
            TARGET_JOB_ID,
            PRIOR_JOB_ID,
            "fingerprint:local",
            local_evidence,
        ),
    ]
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, override_id, run_id, consumed_at
            FROM application_repeat_override_consumptions
            ORDER BY tenant_id
            """
        ).fetchall()
    ] == before_consumptions
    assert [
        tuple(row)
        for row in conn.execute(
            """
            SELECT tenant_id, audit_id, target_job_id,
                   evidence_fingerprint, evidence_json, override_id
            FROM application_repeat_audit
            ORDER BY tenant_id
            """
        ).fetchall()
    ] == [
        (
            "blue",
            "audit:blue",
            TARGET_JOB_ID,
            "fingerprint:blue",
            blue_evidence,
            "override:blue",
        ),
        (
            "local",
            "audit:local",
            TARGET_JOB_ID,
            "fingerprint:local",
            local_evidence,
            "override:local",
        ),
    ]
    close_connection(db_path)
    reopened = init_db(db_path)
    assert reopened.execute("PRAGMA user_version").fetchone()[0] == (
        SCHEMA_VERSION
    ) == 23
    assert database_module._has_repeat_application_reference_schema_v23(
        reopened
    )


def test_verification_failure_rolls_back_and_retry_succeeds_with_fks_on(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    db_path = tmp_path / "jobs.db"
    conn = _seed_v22_database(db_path)
    target_url = "https://careers.example.test/target"
    prior_url = "https://careers.example.test/prior"
    _insert_job(conn, url=target_url, job_id=TARGET_JOB_ID)
    _insert_job(conn, url=prior_url, job_id=PRIOR_JOB_ID)
    evidence_json = '[{"private":"exact"}]'
    _insert_legacy_override(
        conn,
        tenant_id="local",
        override_id="override:retry",
        target_job_key=target_url,
        prior_job_key=prior_url,
        fingerprint="fingerprint:retry",
        evidence_json=evidence_json,
    )
    _insert_legacy_audit(
        conn,
        tenant_id="local",
        audit_id="audit:retry",
        target_job_key=target_url,
        fingerprint="fingerprint:retry",
        evidence_json=evidence_json,
        override_id="override:retry",
    )
    conn.execute(
        """
        INSERT INTO application_repeat_override_consumptions
        VALUES ('local', 'override:retry', 'run:retry', ?)
        """,
        (NOW,),
    )
    conn.commit()
    before = _legacy_snapshot(conn)
    original_verify = (
        database_module._verify_repeat_application_references_v23
    )

    def _fail_verification(
        _conn: sqlite3.Connection,
        *,
        expected_counts: dict[str, int],
    ) -> None:
        del expected_counts
        raise RuntimeError("injected repeat verification failure")

    monkeypatch.setattr(
        database_module,
        "_verify_repeat_application_references_v23",
        _fail_verification,
    )
    with pytest.raises(
        RuntimeError,
        match="injected repeat verification failure",
    ):
        ensure_repeat_application_references_v23(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 22
    assert _legacy_snapshot(conn) == before
    assert "target_job_key" in _columns(
        conn,
        "application_repeat_overrides",
    )
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1

    monkeypatch.setattr(
        database_module,
        "_verify_repeat_application_references_v23",
        original_verify,
    )
    assert ensure_repeat_application_references_v23(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 23
    assert conn.execute("PRAGMA foreign_key_check").fetchone() is None
    assert tuple(
        conn.execute(
            """
            SELECT evidence_fingerprint, evidence_json
            FROM application_repeat_overrides
            """
        ).fetchone()
    ) == ("fingerprint:retry", evidence_json)


@pytest.mark.parametrize(
    ("schema_version", "expected_reference"),
    ((0, "target_job_key"), (22, "target_job_key"), (23, "target_job_id")),
)
def test_missing_table_recovery_is_schema_version_aware(
    schema_version: int,
    expected_reference: str,
) -> None:
    conn = sqlite3.connect(":memory:")
    conn.executescript(
        f"""
        CREATE TABLE jobs (
            url TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL DEFAULT 'local',
            job_id TEXT NOT NULL,
            UNIQUE (tenant_id, job_id)
        );
        PRAGMA user_version = {schema_version};
        """
    )

    assert ensure_repeat_application_tables(conn) == list(
        database_module._REPEAT_APPLICATION_REFERENCE_TABLES
    )

    override_columns = _columns(
        conn,
        "application_repeat_overrides",
    )
    audit_columns = _columns(conn, "application_repeat_audit")
    assert expected_reference in override_columns
    assert expected_reference in audit_columns
    if schema_version == 23:
        assert "prior_job_id" in override_columns
        assert database_module._has_repeat_application_reference_schema_v23(
            conn
        )
    else:
        assert "prior_job_key" in override_columns
        assert "target_job_id" not in override_columns


def test_runtime_identity_collision_rehomes_refs_without_reauthorizing(
    tmp_path: Path,
) -> None:
    conn = init_db(tmp_path / "jobs.db")
    losing_url = "https://careers.example.test/losing"
    survivor_url = "https://careers.example.test/survivor"
    prior_url = "https://careers.example.test/prior"
    other_url = "https://careers.example.test/other"
    _insert_job(conn, url=losing_url, job_id=TARGET_JOB_ID)
    _insert_job(conn, url=survivor_url, job_id=SURVIVOR_JOB_ID)
    _insert_job(conn, url=prior_url, job_id=PRIOR_JOB_ID)
    _insert_job(conn, url=other_url, job_id=OTHER_JOB_ID)
    _insert_job(
        conn,
        url="https://blue.example.test/losing-id-owner",
        job_id=TARGET_JOB_ID,
        tenant_id="blue",
    )
    _insert_job(
        conn,
        url="https://blue.example.test/prior",
        job_id=OTHER_PRIOR_JOB_ID,
        tenant_id="blue",
    )
    record_job_event(
        conn,
        prior_url,
        "apply",
        "ApplicationSubmitted",
        occurred_at=NOW,
        payload={"run_id": "prior-run"},
    )
    assessment = evaluate_repeat_application(conn, losing_url)
    assert assessment["status"] == "confirmation_required"
    evidence_json = json.dumps(
        assessment["matches"],
        separators=(",", ":"),
    )
    fingerprint = str(assessment["evidenceFingerprint"])
    conn.executemany(
        """
        INSERT INTO application_repeat_overrides (
            tenant_id, override_id, target_job_id, prior_job_id,
            relationship, evidence_fingerprint, evidence_json, reason,
            confirmed_by, confirmed_at
        ) VALUES (?, ?, ?, ?, 'same_employer_equivalent_role', ?, ?, ?, ?, ?)
        """,
        (
            (
                "local",
                "override:target",
                TARGET_JOB_ID,
                PRIOR_JOB_ID,
                fingerprint,
                evidence_json,
                "old target confirmation",
                "qa-user",
                NOW,
            ),
            (
                "local",
                "override:prior",
                OTHER_JOB_ID,
                TARGET_JOB_ID,
                "fingerprint:prior",
                '[{"immutable":"prior"}]',
                "old prior evidence",
                "qa-user",
                NOW,
            ),
            (
                "blue",
                "override:blue",
                TARGET_JOB_ID,
                OTHER_PRIOR_JOB_ID,
                "fingerprint:blue",
                '[{"immutable":"blue"}]',
                "tenant isolation",
                "qa-user",
                NOW,
            ),
        ),
    )
    conn.execute(
        """
        INSERT INTO application_repeat_audit (
            tenant_id, audit_id, audit_key, target_job_id, action,
            evidence_fingerprint, evidence_json, override_id, actor,
            reason, occurred_at
        ) VALUES (
            'local', 'audit:collision', 'audit-key:collision', ?,
            'override_recorded', ?, ?, 'override:target', 'qa-user',
            'old target confirmation', ?
        )
        """,
        (TARGET_JOB_ID, fingerprint, evidence_json, NOW),
    )
    conn.commit()
    before_counts = {
        table: conn.execute(
            f'SELECT COUNT(*) FROM "{table}"'
        ).fetchone()[0]
        for table in database_module._REPEAT_APPLICATION_REFERENCE_TABLES
    }

    reassign_discovery_identity_references(
        conn,
        losing_job_url=losing_url,
        surviving_job_url=survivor_url,
    )

    assert {
        table: conn.execute(
            f'SELECT COUNT(*) FROM "{table}"'
        ).fetchone()[0]
        for table in database_module._REPEAT_APPLICATION_REFERENCE_TABLES
    } == before_counts
    rows = {
        str(row["override_id"]): (
            str(row["tenant_id"]),
            str(row["target_job_id"]),
            str(row["prior_job_id"]),
            str(row["evidence_fingerprint"]),
            str(row["evidence_json"]),
        )
        for row in conn.execute(
            """
            SELECT tenant_id, override_id, target_job_id, prior_job_id,
                   evidence_fingerprint, evidence_json
            FROM application_repeat_overrides
            """
        ).fetchall()
    }
    assert rows["override:target"] == (
        "local",
        SURVIVOR_JOB_ID,
        PRIOR_JOB_ID,
        fingerprint,
        evidence_json,
    )
    assert rows["override:prior"] == (
        "local",
        OTHER_JOB_ID,
        SURVIVOR_JOB_ID,
        "fingerprint:prior",
        '[{"immutable":"prior"}]',
    )
    assert rows["override:blue"] == (
        "blue",
        TARGET_JOB_ID,
        OTHER_PRIOR_JOB_ID,
        "fingerprint:blue",
        '[{"immutable":"blue"}]',
    )
    assert tuple(
        conn.execute(
            """
            SELECT target_job_id, evidence_fingerprint, evidence_json
            FROM application_repeat_audit
            WHERE audit_id = 'audit:collision'
            """
        ).fetchone()
    ) == (
        SURVIVOR_JOB_ID,
        fingerprint,
        evidence_json,
    )
    reassessed = evaluate_repeat_application(
        conn,
        survivor_url,
        record_audit=False,
    )
    assert reassessed["status"] == "confirmation_required"
    assert reassessed["override"] is None
    assert reassessed["evidenceFingerprint"] != fingerprint


@pytest.mark.parametrize(
    "unresolved",
    ("target", "prior", "audit"),
)
def test_unresolved_legacy_reference_rolls_back_all_history(
    tmp_path: Path,
    unresolved: str,
) -> None:
    conn = _seed_v22_database(
        tmp_path / f"{unresolved}.db"
    )
    target_url = "https://careers.example.test/target"
    prior_url = "https://careers.example.test/prior"
    missing_url = f"https://missing.example.test/{unresolved}"
    _insert_job(conn, url=target_url, job_id=TARGET_JOB_ID)
    _insert_job(conn, url=prior_url, job_id=PRIOR_JOB_ID)
    evidence_json = '[{"private":"must-survive"}]'
    _insert_legacy_override(
        conn,
        tenant_id="local",
        override_id=f"override:{unresolved}",
        target_job_key=(
            missing_url if unresolved == "target" else target_url
        ),
        prior_job_key=(
            missing_url if unresolved == "prior" else prior_url
        ),
        fingerprint=f"fingerprint:{unresolved}",
        evidence_json=evidence_json,
    )
    conn.execute(
        """
        INSERT INTO application_repeat_override_consumptions
        VALUES ('local', ?, ?, ?)
        """,
        (
            f"override:{unresolved}",
            f"run:{unresolved}",
            NOW,
        ),
    )
    _insert_legacy_audit(
        conn,
        tenant_id="local",
        audit_id=f"audit:{unresolved}",
        target_job_key=(
            missing_url if unresolved == "audit" else target_url
        ),
        fingerprint=f"fingerprint:{unresolved}",
        evidence_json=evidence_json,
        override_id=f"override:{unresolved}",
    )
    conn.commit()
    before = _legacy_snapshot(conn)

    with pytest.raises(
        RuntimeError,
        match="could not resolve",
    ):
        ensure_repeat_application_references_v23(conn)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == 22
    assert _legacy_snapshot(conn) == before
    assert {
        str(row[0])
        for row in conn.execute(
            """
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name LIKE '%_v23'
            """
        ).fetchall()
    } == set()
