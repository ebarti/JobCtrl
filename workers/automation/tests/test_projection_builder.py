"""ProjectionBuilder — watermark + backfill behaviour."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Iterator

import pytest

from jobctrl.domain.compensation import ReportedCompensationObservation, parse_posted_compensation
from jobctrl.domain.identifiers import JobId, generate_job_id
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.database import close_connection, init_db
from jobctrl.infrastructure.compensation import SqliteMarketCompensationRepository, SqlitePostedCompensationRepository
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.events.watermark import SqliteEventWatermarkRepository
from jobctrl.infrastructure.projections.projection_builder import (
    PROJECTION_NAME,
    ProjectionBuilder,
)
from jobctrl.state import record_job_event, utc_now


_INERT_CONTEXT = {"userContext": "Attack vectors:\nPrompt injection"}
PYTHON_WATERMARK_NAME = f"python:{PROJECTION_NAME}:local"


@pytest.fixture
def conn(tmp_path: Path) -> Iterator[sqlite3.Connection]:
    db_path = tmp_path / "jobs.db"
    conn = init_db(db_path)
    yield conn
    close_connection(db_path)


def _seed_job(
    conn: sqlite3.Connection,
    url: str,
    *,
    title: str = "Engineer",
    company: str = "ExampleCo",
    site: str = "jobspy",
    location: str = "Remote",
    salary: str = "",
    description: str = "x",
) -> JobId:
    job_id = generate_job_id()
    conn.execute(
        """
        INSERT INTO jobs (
            tenant_id, job_id, url, title, company, site, strategy, location,
            salary, discovered_at, application_url, description
        ) VALUES (?, ?, ?, ?, ?, ?, 'jobspy', ?, ?, ?, ?, ?)
        """,
        (
            str(LOCAL_TENANT),
            str(job_id),
            url,
            title,
            company,
            site,
            location,
            salary,
            utc_now(),
            url,
            description,
        ),
    )
    conn.commit()
    return job_id


def test_initial_watermark_is_zero(conn: sqlite3.Connection) -> None:
    repo = SqliteEventWatermarkRepository(conn)
    assert repo.get(PYTHON_WATERMARK_NAME) == 0


def test_refresh_advances_watermark(conn: sqlite3.Connection) -> None:
    job_id = _seed_job(conn, "https://example.com/a")
    record_job_event(conn, job_id, "discover", "JobDiscovered", payload=_INERT_CONTEXT)
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()

    repo = SqliteEventWatermarkRepository(conn)
    last = repo.get(PYTHON_WATERMARK_NAME)
    assert last >= 1


def test_refresh_resumes_from_watermark(conn: sqlite3.Connection) -> None:
    first_job_id = _seed_job(conn, "https://example.com/r1")
    record_job_event(conn, first_job_id, "discover", "JobDiscovered", payload=_INERT_CONTEXT)
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()

    # Add another event for a new job; watermark should advance only by
    # the delta.
    repo = SqliteEventWatermarkRepository(conn)
    pre_watermark = repo.get(PYTHON_WATERMARK_NAME)
    second_job_id = _seed_job(conn, "https://example.com/r2")
    record_job_event(conn, second_job_id, "discover", "JobDiscovered", payload=_INERT_CONTEXT)
    conn.commit()

    builder.refresh()
    post_watermark = repo.get(PYTHON_WATERMARK_NAME)
    assert post_watermark > pre_watermark


@pytest.mark.parametrize("commit", [False, True])
def test_subscriber_preserves_caller_transaction(
    conn: sqlite3.Connection, commit: bool,
) -> None:
    job_id = _seed_job(conn, "https://example.com/caller-transaction")
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    before = _projection_transaction_snapshot(conn)
    db_path = conn.execute("PRAGMA database_list").fetchone()[2]
    with sqlite3.connect(db_path) as observer:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("UPDATE jobs SET title = 'Changed' WHERE job_id = ?", (str(job_id),))
        # Construction and the subscriber's per-refresh adapter binding must
        # both leave the publisher's pending canonical write uncommitted.
        builder = ProjectionBuilder(conn_factory=lambda: conn)
        bus = InProcessEventBus()
        builder.subscribe_to(bus)
        assert conn.in_transaction
        record_job_event(conn, job_id, "discover", "JobDiscovered", publisher=bus)
        assert conn.in_transaction
        assert conn.execute("SELECT title FROM job_list_projections").fetchone()[0] == "Changed"
        assert observer.execute("SELECT title FROM jobs").fetchone()[0] == "Engineer"
        assert observer.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0
        if commit:
            conn.commit()
            assert observer.execute("SELECT title FROM jobs").fetchone()[0] == "Changed"
            assert observer.execute("SELECT title FROM job_list_projections").fetchone()[0] == "Changed"
            assert observer.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 1
            assert SqliteEventWatermarkRepository(observer).get(PYTHON_WATERMARK_NAME) > 0
        else:
            conn.rollback()
            assert observer.execute("SELECT title FROM jobs").fetchone()[0] == "Engineer"
            assert observer.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0
            assert _projection_transaction_snapshot(conn) == before
        assert not conn.in_transaction


def _projection_transaction_snapshot(conn: sqlite3.Connection) -> dict[str, list[tuple]]:
    return {
        table: [tuple(row) for row in conn.execute(f"SELECT * FROM {table} ORDER BY rowid")]
        for table in (
            "job_list_projections", "job_detail_projections", "dashboard_projections",
            "evidence_usage_projections", "event_watermarks", "projection_backfills",
        )
    }


@pytest.mark.parametrize("caller_transaction", [False, True])
@pytest.mark.parametrize("failure_table", ["evidence_usage_projections", "event_watermarks"])
def test_refresh_failure_rolls_back_only_its_projection_pass(
    conn: sqlite3.Connection, caller_transaction: bool, failure_table: str,
) -> None:
    job_id = _seed_job(conn, "https://example.com/failed-projection")
    conn.execute(
        "INSERT INTO candidate_profile_skill_categories "
        "(tenant_id, profile_id, category_id, position_index, label) "
        "VALUES ('local', 'default', 'fixture', 0, 'Fixture')"
    )
    conn.execute(
        "INSERT INTO candidate_profile_skill_items "
        "(tenant_id, profile_id, category_id, item_index, item_text) "
        "VALUES ('local', 'default', 'fixture', 0, 'Python')"
    )
    conn.commit()
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()
    before = _projection_transaction_snapshot(conn)
    assert before["evidence_usage_projections"]
    conn.execute(
        f"CREATE TEMP TRIGGER fail_projection BEFORE INSERT ON {failure_table} "
        "BEGIN SELECT RAISE(ABORT, 'projection fixture failure'); END"
    )
    conn.execute("BEGIN IMMEDIATE")
    conn.execute("UPDATE jobs SET title = 'Changed' WHERE job_id = ?", (str(job_id),))
    if caller_transaction:
        bus = InProcessEventBus()
        builder.subscribe_to(bus)
        # The event subscriber catches the error; its savepoint must still
        # discard every partial projection write before the publisher commits.
        record_job_event(conn, job_id, "discover", "JobDiscovered", publisher=bus)
        assert conn.in_transaction
    else:
        record_job_event(conn, job_id, "discover", "JobDiscovered")
        conn.commit()
        with pytest.raises(sqlite3.IntegrityError, match="projection fixture failure"):
            builder.refresh()
        assert not conn.in_transaction
    assert _projection_transaction_snapshot(conn) == before
    db_path = conn.execute("PRAGMA database_list").fetchone()[2]
    if caller_transaction:
        with sqlite3.connect(db_path) as observer:
            assert observer.execute("SELECT title FROM jobs").fetchone()[0] == "Engineer"
            assert observer.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 0
    conn.commit()
    with sqlite3.connect(db_path) as observer:
        assert observer.execute("SELECT title FROM jobs").fetchone()[0] == "Changed"
        assert observer.execute("SELECT COUNT(*) FROM job_events").fetchone()[0] == 1
        assert _projection_transaction_snapshot(observer) == before
    conn.execute("DROP TRIGGER fail_projection")
    builder.refresh()
    assert not conn.in_transaction
    with sqlite3.connect(db_path) as observer:
        assert observer.execute("SELECT title FROM job_list_projections").fetchone()[0] == "Changed"
        assert SqliteEventWatermarkRepository(observer).get(PYTHON_WATERMARK_NAME) > 0
    after = _projection_transaction_snapshot(conn)
    builder.refresh()
    assert _projection_transaction_snapshot(conn) == after


def test_refresh_has_independent_tenant_and_consumer_cursors(conn: sqlite3.Connection) -> None:
    insert = (
        "INSERT INTO job_events (tenant_id, job_id, identity_version, event_type, occurred_at, payload_json) "
        "VALUES (?, NULL, 1, 'CandidateProfileUpdated', '2026-09-01T00:00:00Z', '{}')"
    )
    foreign_event = conn.execute(insert, ("foreign",)).lastrowid
    local_event = conn.execute(insert, ("local",)).lastrowid
    assert foreign_event is not None and local_event is not None
    repo = SqliteEventWatermarkRepository(conn)
    repo.set(PROJECTION_NAME, local_event)
    repo.set(f"typescript:{PROJECTION_NAME}:local", local_event)
    local_builder = ProjectionBuilder(conn_factory=lambda: conn)
    local_builder.refresh()
    assert repo.get(PYTHON_WATERMARK_NAME) == local_event
    assert repo.get(f"python:{PROJECTION_NAME}:foreign") == 0
    foreign_builder = ProjectionBuilder(conn_factory=lambda: conn, tenant_id=TenantId("foreign"))
    foreign_builder.refresh()
    assert repo.get(f"python:{PROJECTION_NAME}:foreign") == foreign_event
    assert repo.get(PYTHON_WATERMARK_NAME) == local_event
    assert repo.get(PROJECTION_NAME) == local_event
    local_builder.refresh()
    foreign_builder.refresh()
    assert repo.get(f"python:{PROJECTION_NAME}:foreign") == foreign_event


def test_legacy_opaque_tenant_cursors_cannot_acknowledge_local_events(conn: sqlite3.Connection) -> None:
    job_id = _seed_job(conn, "https://example.com/legacy-tenant-cursor")
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    builder.refresh()
    conn.execute("UPDATE jobs SET title = 'Changed' WHERE job_id = ?", (str(job_id),))
    record_job_event(conn, job_id, "discover", "JobDiscovered")
    event_id = conn.execute("SELECT MAX(event_id) FROM job_events").fetchone()[0]
    legacy_rows = [
        (f"{PROJECTION_NAME}:{tenant}", 10_000 + index, "2026-08-31T00:00:00Z")
        for index, tenant in enumerate(("python:local", "typescript:local"))
    ]
    conn.executemany(
        "INSERT OR REPLACE INTO event_watermarks (projection_name, last_event_id, updated_at) VALUES (?, ?, ?)",
        legacy_rows,
    )
    conn.commit()
    builder.refresh()
    assert conn.execute("SELECT title FROM job_list_projections").fetchone()[0] == "Changed"
    assert SqliteEventWatermarkRepository(conn).get(f"python:{PROJECTION_NAME}:local") == event_id
    for legacy_row in legacy_rows:
        assert tuple(conn.execute(
            "SELECT * FROM event_watermarks WHERE projection_name = ?", (legacy_row[0],)
        ).fetchone()) == legacy_row


def test_backfill_from_empty(conn: sqlite3.Connection) -> None:
    """Fresh-v7 canonical jobs backfill even with no event history."""
    first_job_id = _seed_job(conn, "https://example.com/canonical-1")
    second_job_id = _seed_job(conn, "https://example.com/canonical-2")
    # No record_job_event calls.

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    rows = conn.execute("SELECT job_id FROM job_list_projections ORDER BY job_id").fetchall()
    assert [row[0] for row in rows] == sorted([str(first_job_id), str(second_job_id)])


def test_evidence_usage_projection_inverts_profile_provenance_and_requirement_fit(
    conn: sqlite3.Connection,
) -> None:
    job_url = "https://example.com/evidence-map"
    job_id = _seed_job(conn, job_url)
    conn.execute(
        """
        INSERT INTO candidate_profile_experience_entries (
            tenant_id, profile_id, entry_id, position_index, date_range,
            title, company, location
        ) VALUES ('local', 'default', 'exp-platform', 0, '2024-2025',
                  'Senior Engineer', 'Acme', 'Remote')
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profile_achievement_evidence (
            tenant_id, profile_id, entry_id, evidence_index, evidence_id,
            source_text, scope, action, tools_json, metrics_json, outcome,
            seniority_signal, evidence_strength, claim_confidence,
            user_confirmed, tags_json
        ) VALUES (
            'local', 'default', 'exp-platform', 0, 'ev_platform',
            'Led a platform migration that reduced latency by 40%.',
            'Platform migration', 'Led migration', '["Python", "Postgres"]',
            '["40% latency reduction"]', 'Reduced latency', '',
            'verified', 0.95, 1, '["migration"]'
        )
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profile_skill_categories (
            tenant_id, profile_id, category_id, position_index, label
        ) VALUES ('local', 'default', 'backend', 0, 'Backend')
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profile_skill_items (
            tenant_id, profile_id, category_id, item_index, item_text
        ) VALUES ('local', 'default', 'backend', 0, 'Python')
        """
    )
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES ('local', ?, 1, 'complete',
                  '2026-07-05T12:00:00Z', '2026-07-05T12:10:00Z')
        """,
        (str(job_id),),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES ('local', ?, 1, 'tailored_resume', 'artifact-resume-1', 'approved',
                  '/tmp/resume.txt', 'text', 12, '{}', '2026-07-05T12:05:00Z')
        """,
        (str(job_id),),
    )
    conn.execute(
        """
        INSERT INTO job_bullet_provenance (
            tenant_id, job_id, generation, bullet_id, artifact_id, section,
            source_id, evidence_ids_json, requirement_ids_json,
            matched_keywords_json, transform_type, control, rationale,
            generated_text, position, created_at, coverage_json
        ) VALUES (
            'local', ?, 1, 'experience:exp-platform#0', 'artifact-resume-1',
            'experience', 'exp-platform', '["ev_platform"]',
            '["req-platform"]', '["latency"]', 'reframe',
            'rephrase_allowed', 'Used profile evidence.',
            'Led migration and reduced latency 40%.', 0,
            '2026-07-05T12:10:00Z',
            '{"covered":["Python"],"declared":[],"missing":["Kubernetes"]}'
        )
        """,
        (str(job_id),),
    )
    conn.execute(
        """
        INSERT INTO job_scores (
            tenant_id, job_id, version, fit_score, breakdown_json, keywords_json,
            scored_at, correction_json, criteria_json, trace_json
        ) VALUES ('local', ?, 2, 8, '{}', '["Python"]',
                  '2026-07-05T12:20:00Z', NULL, '{}', '{}')
        """,
        (str(job_id),),
    )
    conn.execute(
        """
        INSERT INTO job_requirement_fit_reports (
            tenant_id, job_id, score_version, employer_analysis_generation,
            profile_snapshot_version, scoring_policy_version, formula_version,
            resolved_fit_score, fit_band, confidence, summary_json, created_at
        ) VALUES (
            'local', ?, 2, 1, 1, 1, 'v1', 8, 'strong', 'high',
            '{"weighted_fit":0.8,"must_have_coverage":0.5,"blocker_count":0,"missing_high_weight_count":1}',
            '2026-07-05T12:20:00Z'
        )
        """,
        (str(job_id),),
    )
    conn.execute(
        """
        INSERT INTO job_requirement_fit_items (
            tenant_id, job_id, score_version, requirement_id, requirement_text,
            tier, weight, job_evidence_span, fit_json, contribution_json,
            tailoring_json, artifact_coverage_json, position
        ) VALUES (
            'local', ?, 2, 'req-platform', 'Own platform migrations',
            'must_have', 0.8, 'platform migrations',
            '{"kind":"matched","evidence_ids":["ev_platform"],"strength":"direct"}',
            '{}', '{}',
            '{"state":"covered","source":"tailored_resume_bullet_provenance","bullet_count":1,"examples":["Led migration"]}',
            0
        )
        """,
        (str(job_id),),
    )
    conn.execute(
        """
        INSERT INTO job_requirement_fit_items (
            tenant_id, job_id, score_version, requirement_id, requirement_text,
            tier, weight, job_evidence_span, fit_json, contribution_json,
            tailoring_json, artifact_coverage_json, position
        ) VALUES (
            'local', ?, 2, 'req-kubernetes', 'Run Kubernetes clusters',
            'must_have', 0.7, 'Kubernetes clusters',
            '{"kind":"missing","reason":"No Kubernetes profile evidence."}',
            '{}', '{}',
            '{"state":"missing_from_profile","source":"tailored_resume_bullet_provenance","bullet_count":0,"examples":[]}',
            1
        )
        """,
        (str(job_id),),
    )
    record_job_event(conn, job_id, "score", "JobScored", payload=_INERT_CONTEXT)
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    entry_row = conn.execute(
        """
        SELECT payload_json
          FROM evidence_usage_projections
         WHERE tenant_id = 'local'
           AND projection_kind = 'entry'
           AND evidence_id = 'ev_platform'
        """
    ).fetchone()
    assert entry_row is not None
    entry = json.loads(entry_row["payload_json"])
    assert entry["resumeUsages"][0]["artifactId"] == "artifact-resume-1"
    assert entry["resumeUsages"][0]["bulletId"] == "experience:exp-platform#0"
    assert entry["requirementUsages"][0]["requirementId"] == "req-platform"
    assert entry["freshness"]["evidenceDateRange"] == "2024-2025"
    assert entry["freshness"]["lastUsedAt"] == "2026-07-05T12:10:00Z"

    gap_rows = conn.execute(
        """
        SELECT payload_json
          FROM evidence_usage_projections
         WHERE tenant_id = 'local' AND projection_kind = 'gap'
         ORDER BY projection_id
        """
    ).fetchall()
    gaps = [json.loads(row["payload_json"]) for row in gap_rows]
    assert any(
        gap["kind"] == "missing_requirement"
        and gap["requirementId"] == "req-kubernetes"
        and gap["jobRefs"][0]["jobId"] == str(job_id)
        for gap in gaps
    )
    assert any(
        gap["kind"] == "missing_skill"
        and gap["demandedSkill"] == "Kubernetes"
        and gap["jobRefs"][0]["artifactId"] == "artifact-resume-1"
        for gap in gaps
    )


def test_evidence_map_excludes_soft_deleted_and_hidden_jobs(
    conn: sqlite3.Connection,
) -> None:
    """Regression for the R5 evidence-usage index: soft delete only writes a
    jobctrl_deleted_jobs tombstone (and hide only writes jobctrl_hidden_jobs),
    leaving the job_bullet_provenance / job_requirement_fit_items /
    artifact_list_projections rows in place. Those rows must not re-surface a
    removed job's title, employer, generated-text preview, usages, or gaps.
    """
    active_url = "https://example.com/jobs/active-role"
    deleted_url = "https://example.com/jobs/deleted-role"
    hidden_url = "https://example.com/jobs/hidden-role"

    conn.execute(
        """
        INSERT INTO candidate_profile_experience_entries (
            tenant_id, profile_id, entry_id, position_index, date_range,
            title, company, location
        ) VALUES ('local', 'default', 'exp-platform', 0, '2024-2025',
                  'Senior Engineer', 'Acme', 'Remote')
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profile_achievement_evidence (
            tenant_id, profile_id, entry_id, evidence_index, evidence_id,
            source_text, scope, action, tools_json, metrics_json, outcome,
            seniority_signal, evidence_strength, claim_confidence,
            user_confirmed, tags_json
        ) VALUES (
            'local', 'default', 'exp-platform', 0, 'ev_platform',
            'Led a platform migration that reduced latency by 40%.',
            'Platform migration', 'Led migration', '["Python", "Postgres"]',
            '["40% latency reduction"]', 'Reduced latency', '',
            'verified', 0.95, 1, '["migration"]'
        )
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profile_skill_categories (
            tenant_id, profile_id, category_id, position_index, label
        ) VALUES ('local', 'default', 'backend', 0, 'Backend')
        """
    )
    conn.execute(
        """
        INSERT INTO candidate_profile_skill_items (
            tenant_id, profile_id, category_id, item_index, item_text
        ) VALUES ('local', 'default', 'backend', 0, 'Python')
        """
    )

    def seed_job_evidence(
        job_url: str,
        *,
        title: str,
        site: str,
        artifact_id: str,
        generated_text: str,
        created_at: str,
    ) -> JobId:
        job_id = _seed_job(
            conn,
            job_url,
            title=title,
            company=site,
            site=site,
        )
        conn.execute(
            """
            INSERT INTO job_materials (
                tenant_id, job_id, generation, status, created_at, updated_at
            ) VALUES ('local', ?, 1, 'complete',
                      '2026-07-05T12:00:00Z', '2026-07-05T12:10:00Z')
            """,
            (str(job_id),),
        )
        conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
                render_format, size_bytes, metadata_json, created_at
            ) VALUES ('local', ?, 1, 'tailored_resume', ?, 'approved',
                      '/tmp/resume.txt', 'text', 12, '{}', '2026-07-05T12:05:00Z')
            """,
            (str(job_id), artifact_id),
        )
        conn.execute(
            """
            INSERT INTO job_bullet_provenance (
                tenant_id, job_id, generation, bullet_id, artifact_id, section,
                source_id, evidence_ids_json, requirement_ids_json,
                matched_keywords_json, transform_type, control, rationale,
                generated_text, position, created_at, coverage_json
            ) VALUES (
                'local', ?, 1, 'experience:exp-platform#0', ?,
                'experience', 'exp-platform', '["ev_platform"]',
                '["req-platform"]', '["latency"]', 'reframe',
                'rephrase_allowed', 'Used profile evidence.',
                ?, 0, ?,
                '{"covered":["Python"],"declared":[],"missing":["Kubernetes"]}'
            )
            """,
            (str(job_id), artifact_id, generated_text, created_at),
        )
        conn.execute(
            """
            INSERT INTO job_scores (
                tenant_id, job_id, version, fit_score, breakdown_json, keywords_json,
                scored_at, correction_json, criteria_json, trace_json
            ) VALUES ('local', ?, 2, 8, '{}', '["Python"]',
                      '2026-07-05T12:20:00Z', NULL, '{}', '{}')
            """,
            (str(job_id),),
        )
        conn.execute(
            """
            INSERT INTO job_requirement_fit_reports (
                tenant_id, job_id, score_version, employer_analysis_generation,
                profile_snapshot_version, scoring_policy_version, formula_version,
                resolved_fit_score, fit_band, confidence, summary_json, created_at
            ) VALUES (
                'local', ?, 2, 1, 1, 1, 'v1', 8, 'strong', 'high',
                '{"weighted_fit":0.8,"must_have_coverage":0.5,"blocker_count":0,"missing_high_weight_count":1}',
                '2026-07-05T12:20:00Z'
            )
            """,
            (str(job_id),),
        )
        conn.execute(
            """
            INSERT INTO job_requirement_fit_items (
                tenant_id, job_id, score_version, requirement_id, requirement_text,
                tier, weight, job_evidence_span, fit_json, contribution_json,
                tailoring_json, artifact_coverage_json, position
            ) VALUES (
                'local', ?, 2, 'req-platform', 'Own platform migrations',
                'must_have', 0.8, 'platform migrations',
                '{"kind":"matched","evidence_ids":["ev_platform"],"strength":"direct"}',
                '{}', '{}',
                '{"state":"covered","source":"tailored_resume_bullet_provenance","bullet_count":1,"examples":["Led migration"]}',
                0
            )
            """,
            (str(job_id),),
        )
        conn.execute(
            """
            INSERT INTO job_requirement_fit_items (
                tenant_id, job_id, score_version, requirement_id, requirement_text,
                tier, weight, job_evidence_span, fit_json, contribution_json,
                tailoring_json, artifact_coverage_json, position
            ) VALUES (
                'local', ?, 2, 'req-kubernetes', 'Run Kubernetes clusters',
                'must_have', 0.7, 'Kubernetes clusters',
                '{"kind":"missing","reason":"No Kubernetes profile evidence."}',
                '{}', '{}',
                '{"state":"missing_from_profile","source":"tailored_resume_bullet_provenance","bullet_count":0,"examples":[]}',
                1
            )
            """,
            (str(job_id),),
        )
        record_job_event(conn, job_id, "score", "JobScored", payload=_INERT_CONTEXT)
        return job_id

    active_job_id = seed_job_evidence(
        active_url,
        title="Active Platform Role",
        site="ActiveCorp",
        artifact_id="artifact-active",
        generated_text="ACTIVE-bullet reduced latency 40%.",
        created_at="2026-07-05T12:10:00Z",
    )
    deleted_job_id = seed_job_evidence(
        deleted_url,
        title="Deleted Platform Role",
        site="DeletedCorp",
        artifact_id="artifact-deleted",
        generated_text="DELETED-bullet should never surface.",
        created_at="2026-07-04T12:10:00Z",
    )
    hidden_job_id = seed_job_evidence(
        hidden_url,
        title="Hidden Platform Role",
        site="HiddenCorp",
        artifact_id="artifact-hidden",
        generated_text="HIDDEN-bullet should never surface.",
        created_at="2026-07-03T12:10:00Z",
    )

    conn.execute(
        "INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at, reason, restored_at) "
        "VALUES ('local', ?, '2026-07-05T13:00:00Z', 'user delete', NULL)",
        (str(deleted_job_id),),
    )
    conn.execute(
        "INSERT INTO jobctrl_hidden_jobs (tenant_id, job_id, hidden_at, reason, unhidden_at) "
        "VALUES ('local', ?, '2026-07-05T13:00:00Z', 'user hide', NULL)",
        (str(hidden_job_id),),
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    rows = conn.execute(
        """
        SELECT projection_kind, payload_json
          FROM evidence_usage_projections
         WHERE tenant_id = 'local'
           AND projection_kind IN ('entry', 'gap')
        """
    ).fetchall()
    referenced_job_ids: set[str] = set()
    serialized = ""
    for row in rows:
        payload_json = row["payload_json"]
        serialized += payload_json
        payload = json.loads(payload_json)
        if row["projection_kind"] == "entry":
            for key in ("resumeUsages", "requirementUsages", "coverageUsages"):
                for usage in payload.get(key, []):
                    referenced_job_ids.add(usage["jobId"])
        else:
            for ref in payload.get("jobRefs", []):
                referenced_job_ids.add(ref["jobId"])

    # The live job still populates the map (positive control) ...
    assert str(active_job_id) in referenced_job_ids
    # ... while the soft-deleted and hidden jobs are fully excluded.
    assert str(deleted_job_id) not in referenced_job_ids
    assert str(hidden_job_id) not in referenced_job_ids

    # No removed job's title, employer, or generated-text preview may leak
    # through any evidence field.
    for leaked in (
        "Deleted Platform Role",
        "DeletedCorp",
        "DELETED-bullet",
        "Hidden Platform Role",
        "HiddenCorp",
        "HIDDEN-bullet",
    ):
        assert leaked not in serialized
    assert "ACTIVE-bullet" in serialized


def test_job_projection_uses_explicit_company_before_source(conn: sqlite3.Connection) -> None:
    job_id = _seed_job(
        conn,
        "https://www.linkedin.com/jobs/view/1",
        title="Head of Engineering",
        company="Keyrock",
        site="linkedin",
        location="Barcelona, Spain",
    )

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT employer FROM job_list_projections WHERE job_id = ?",
        (str(job_id),),
    ).fetchone()
    assert row is not None
    assert row[0] == "Keyrock"


def test_projects_compensation_summary_and_audit_json(conn: sqlite3.Connection) -> None:
    job_url = "https://example.com/compensation"
    job_id = _seed_job(conn, job_url)
    conn.execute(
        "UPDATE jobs SET salary = ? WHERE tenant_id = ? AND job_id = ?",
        ("USD 70000-90000/year", str(LOCAL_TENANT), str(job_id)),
    )
    SqlitePostedCompensationRepository(conn).save_fact(
        parse_posted_compensation(
            "USD 70000-90000/year",
            job_id=job_id,
            parsed_at="2026-06-19T10:00:00Z",
        )
    )
    SqliteMarketCompensationRepository(conn).estimate_and_save_job(
        job_id=job_id,
        title="Senior Software Developer",
        company="ExampleCo",
        location="Madrid, Spain",
        observations=(
            ReportedCompensationObservation(
                source_id="levels_fyi",
                source_provenance="licensed",
                company_name="ExampleCo",
                role_title="Senior Software Developer",
                level_label="Senior",
                company_tier="tier_2_ambitious",
                location="Remote Europe",
                minimum_amount=118_000,
                maximum_amount=142_000,
                release_year=2026,
                sample_count=4,
                attribution="Levels.fyi reported compensation data",
            ),
            ReportedCompensationObservation(
                source_id="glassdoor",
                source_provenance="licensed",
                company_name="ExampleCo",
                role_title="Senior Software Developer",
                level_label="Senior",
                company_tier="tier_2_ambitious",
                location="Madrid, Spain",
                minimum_amount=112_000,
                maximum_amount=136_000,
                release_year=2026,
                sample_count=3,
                attribution="Glassdoor reported compensation data",
            ),
        ),
        estimated_at="2026-06-19T10:01:00Z",
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        """
        SELECT salary, compensation_summary_json
        FROM job_list_projections
        WHERE job_id = ?
        """,
        (str(job_id),),
    ).fetchone()
    assert row is not None
    assert row["salary"] == "USD 70000-90000/year"
    summary = json.loads(row["compensation_summary_json"])
    assert summary["posted"]["recordStatus"] == "recorded"
    assert summary["posted"]["displayRange"] == "USD 70000-90000/year"
    assert summary["posted"]["range"]["annualizedMinimumEur"] == 64_400
    assert summary["posted"]["range"]["annualizedMaximumEur"] == 82_800
    assert summary["market"]["recordStatus"] == "recorded"
    assert summary["market"]["sourceKind"] == "reported_company_role_market"
    assert summary["market"]["displayRange"] == "EUR 112000-142000/year"
    assert summary["market"]["range"]["annualizedMinimumEur"] == 112_000
    assert summary["market"]["range"]["annualizedMaximumEur"] == 142_000
    assert summary["market"]["confidenceScore"] == 0.78
    assert summary["market"]["sourceCount"] == 2
    assert summary["market"]["sampleCount"] == 7

    detail = conn.execute(
        """
        SELECT compensation_audit_json
        FROM job_detail_projections
        WHERE job_id = ?
        """,
        (str(job_id),),
    ).fetchone()
    assert detail is not None
    audit = json.loads(detail["compensation_audit_json"])
    assert audit["posted"]["fact"]["sourceText"] == "USD 70000-90000/year"
    assert {source["sourceId"] for source in audit["market"]["estimate"]["sources"]} == {"levels_fyi", "glassdoor"}
    assert audit["market"]["estimate"]["companyName"] == "ExampleCo"
    assert audit["market"]["estimate"]["matchScope"] == "exact_company_role"
    assert "Glassdoor" in json.dumps(audit)
    assert "/Users/" not in json.dumps(audit)


def test_posted_parser_reconciliation_rebuilds_settled_list_and_detail_projections(
    conn: sqlite3.Connection,
) -> None:
    job_id = _seed_job(
        conn,
        "https://example.com/posted-parser-upgrade",
        salary="Compensation: USD 243,800 annually and stock options.",
    )
    posted_repo = SqlitePostedCompensationRepository(conn)
    posted_repo.parse_and_save_job_salary(
        job_id,
        "Compensation: USD 243,800 annually and stock options.",
        parsed_at="2026-08-12T10:00:00Z",
    )
    conn.execute(
        """
        UPDATE job_posted_compensation_facts
        SET parser_version = 'posted-compensation-v1',
            component = 'equity',
            confidence = 'medium'
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    )
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    assert builder.refresh() == 1
    settled_watermark = SqliteEventWatermarkRepository(conn).get(PYTHON_WATERMARK_NAME)
    initial = conn.execute(
        """
        SELECT list.compensation_summary_json,
               detail.compensation_summary_json AS detail_summary_json,
               detail.compensation_audit_json
        FROM job_list_projections AS list
        JOIN job_detail_projections AS detail
          ON detail.tenant_id = list.tenant_id
         AND detail.job_id = list.job_id
        WHERE list.tenant_id = ? AND list.job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert initial is not None
    initial_list = json.loads(initial["compensation_summary_json"])
    initial_detail = json.loads(initial["detail_summary_json"])
    initial_audit = json.loads(initial["compensation_audit_json"])
    assert initial_list["projectionVersion"] == 3
    assert initial_detail["projectionVersion"] == 3
    assert initial_list["posted"]["range"]["component"] == "equity"
    assert initial_audit["posted"]["fact"]["parserVersion"] == "posted-compensation-v1"

    assert (
        posted_repo.reparse_outdated_facts(
            parsed_at="2026-08-12T11:00:00Z",
        )
        == 1
    )
    assert builder.refresh() == 1
    assert SqliteEventWatermarkRepository(conn).get(PYTHON_WATERMARK_NAME) > settled_watermark

    rebuilt = conn.execute(
        """
        SELECT list.compensation_summary_json,
               detail.compensation_summary_json AS detail_summary_json,
               detail.compensation_audit_json
        FROM job_list_projections AS list
        JOIN job_detail_projections AS detail
          ON detail.tenant_id = list.tenant_id
         AND detail.job_id = list.job_id
        WHERE list.tenant_id = ? AND list.job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert rebuilt is not None
    list_summary = json.loads(rebuilt["compensation_summary_json"])
    detail_summary = json.loads(rebuilt["detail_summary_json"])
    audit = json.loads(rebuilt["compensation_audit_json"])
    assert list_summary["posted"]["range"]["component"] == "unknown"
    assert detail_summary["posted"]["range"]["component"] == "unknown"
    assert audit["posted"]["fact"]["parserVersion"] == "posted-compensation-v4"
    assert audit["posted"]["fact"]["component"] == "unknown"


def test_posted_parser_reconciliation_corrects_hr_prose_period_in_settled_projections(
    conn: sqlite3.Connection,
) -> None:
    source_text = (
        "anybody (even HR managers) is able to create new integrations. Base pay range: €94,300.00/yr - €106,950.00/yr"
    )
    job_id = _seed_job(
        conn,
        "https://example.com/posted-parser-hr-period-upgrade",
        salary=source_text,
    )
    posted_repo = SqlitePostedCompensationRepository(conn)
    posted_repo.parse_and_save_job_salary(
        job_id,
        source_text,
        parsed_at="2026-08-12T10:00:00Z",
    )
    conn.execute(
        """
        UPDATE job_posted_compensation_facts
        SET parser_version = 'posted-compensation-v2',
            period = 'hour',
            annualized_minimum_amount = 196144000,
            annualized_maximum_amount = 222456000,
            annualization_assumption = 'Hourly amounts annualized by multiplying by 2,080 work hours.',
            confidence = 'low',
            warnings_json = '["hourly_period"]'
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    )
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    assert builder.refresh() == 1
    settled_watermark = SqliteEventWatermarkRepository(conn).get(PYTHON_WATERMARK_NAME)
    initial = conn.execute(
        """
        SELECT list.compensation_summary_json,
               detail.compensation_summary_json AS detail_summary_json,
               detail.compensation_audit_json
        FROM job_list_projections AS list
        JOIN job_detail_projections AS detail
          ON detail.tenant_id = list.tenant_id
         AND detail.job_id = list.job_id
        WHERE list.tenant_id = ? AND list.job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert initial is not None
    assert json.loads(initial["compensation_summary_json"])["posted"]["displayRange"] == ("EUR 94300-106950/hour")
    assert json.loads(initial["detail_summary_json"])["posted"]["displayRange"] == ("EUR 94300-106950/hour")
    assert json.loads(initial["compensation_audit_json"])["posted"]["fact"]["parserVersion"] == (
        "posted-compensation-v2"
    )

    assert (
        posted_repo.reparse_outdated_facts(
            parsed_at="2026-08-12T11:00:00Z",
        )
        == 1
    )
    assert builder.refresh() == 1
    assert SqliteEventWatermarkRepository(conn).get(PYTHON_WATERMARK_NAME) > settled_watermark

    rebuilt = conn.execute(
        """
        SELECT list.compensation_summary_json,
               detail.compensation_summary_json AS detail_summary_json,
               detail.compensation_audit_json
        FROM job_list_projections AS list
        JOIN job_detail_projections AS detail
          ON detail.tenant_id = list.tenant_id
         AND detail.job_id = list.job_id
        WHERE list.tenant_id = ? AND list.job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert rebuilt is not None
    list_summary = json.loads(rebuilt["compensation_summary_json"])
    detail_summary = json.loads(rebuilt["detail_summary_json"])
    audit = json.loads(rebuilt["compensation_audit_json"])
    assert list_summary["posted"]["displayRange"] == "EUR 94300-106950/year"
    assert detail_summary["posted"]["displayRange"] == "EUR 94300-106950/year"
    assert audit["posted"]["fact"]["period"] == "year"
    assert audit["posted"]["fact"]["annualizedMinimumAmount"] == 94_300
    assert audit["posted"]["fact"]["annualizedMaximumAmount"] == 106_950
    assert audit["posted"]["fact"]["parserVersion"] == "posted-compensation-v4"
    assert "hourly_period" not in {warning["code"] for warning in audit["posted"]["fact"]["warnings"]}


def test_posted_parser_reconciliation_infers_wave_salary_as_annual_in_settled_projections(
    conn: sqlite3.Connection,
) -> None:
    source_text = (
        "Wave covers all costs. Compensation: Our salaries are competitive and "
        "are calculated using a transparent formula. For this role, depending "
        "on your level and location, we offer a salary of up to $356,500 USD, "
        "plus a generous equity package."
    )
    job_id = _seed_job(
        conn,
        "https://www.wave.com/en/careers/job/6129464004/",
        salary=source_text,
    )
    posted_repo = SqlitePostedCompensationRepository(conn)
    posted_repo.parse_and_save_job_salary(
        job_id,
        source_text,
        parsed_at="2026-08-14T08:40:15Z",
    )
    conn.execute(
        """
        UPDATE job_posted_compensation_facts
        SET parser_version = 'posted-compensation-v3',
            period = 'unknown',
            annualized_minimum_amount = NULL,
            annualized_maximum_amount = NULL,
            annualization_assumption = NULL,
            confidence = 'medium',
            warnings_json = '["source_text_truncated", "missing_period", "one_sided_range"]'
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    )
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    assert builder.refresh() == 1
    initial = conn.execute(
        """
        SELECT list.compensation_summary_json,
               detail.compensation_summary_json AS detail_summary_json
        FROM job_list_projections AS list
        JOIN job_detail_projections AS detail
          ON detail.tenant_id = list.tenant_id
         AND detail.job_id = list.job_id
        WHERE list.tenant_id = ? AND list.job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert initial is not None
    assert json.loads(initial["compensation_summary_json"])["posted"]["displayRange"] == ("USD up to 356500/unknown")
    assert json.loads(initial["detail_summary_json"])["posted"]["displayRange"] == ("USD up to 356500/unknown")

    assert posted_repo.reparse_outdated_facts(parsed_at="2026-08-14T10:00:00Z") == 1
    assert builder.refresh() == 1

    rebuilt = conn.execute(
        """
        SELECT list.compensation_summary_json,
               detail.compensation_summary_json AS detail_summary_json,
               detail.compensation_audit_json
        FROM job_list_projections AS list
        JOIN job_detail_projections AS detail
          ON detail.tenant_id = list.tenant_id
         AND detail.job_id = list.job_id
        WHERE list.tenant_id = ? AND list.job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert rebuilt is not None
    list_summary = json.loads(rebuilt["compensation_summary_json"])
    detail_summary = json.loads(rebuilt["detail_summary_json"])
    audit = json.loads(rebuilt["compensation_audit_json"])
    assert list_summary["posted"]["displayRange"] == "USD up to 356500/year"
    assert detail_summary["posted"]["displayRange"] == "USD up to 356500/year"
    assert audit["posted"]["fact"]["period"] == "year"
    assert audit["posted"]["fact"]["annualizedMaximumAmount"] == 356_500
    assert audit["posted"]["fact"]["parserVersion"] == "posted-compensation-v4"
    assert "annual_period_inferred" in {warning["code"] for warning in audit["posted"]["fact"]["warnings"]}
    assert "missing_period" not in {warning["code"] for warning in audit["posted"]["fact"]["warnings"]}


def test_posted_parser_reconciliation_preserves_biweekly_as_unannualized(
    conn: sqlite3.Connection,
) -> None:
    source_text = "Salary up to $15,000 biweekly"
    job_id = _seed_job(
        conn,
        "https://example.com/jobs/weekly-salary",
        salary=source_text,
    )
    posted_repo = SqlitePostedCompensationRepository(conn)
    posted_repo.parse_and_save_job_salary(
        job_id,
        source_text,
        parsed_at="2026-08-14T08:40:15Z",
    )
    conn.execute(
        """
        UPDATE job_posted_compensation_facts
        SET parser_version = 'posted-compensation-v3'
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    )
    conn.commit()

    builder = ProjectionBuilder(conn_factory=lambda: conn)
    assert builder.refresh() == 1
    assert posted_repo.reparse_outdated_facts(parsed_at="2026-08-14T10:00:00Z") == 1
    assert builder.refresh() == 1

    rebuilt = conn.execute(
        """
        SELECT list.compensation_summary_json,
               detail.compensation_summary_json AS detail_summary_json,
               detail.compensation_audit_json
        FROM job_list_projections AS list
        JOIN job_detail_projections AS detail
          ON detail.tenant_id = list.tenant_id
         AND detail.job_id = list.job_id
        WHERE list.tenant_id = ? AND list.job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert rebuilt is not None
    list_summary = json.loads(rebuilt["compensation_summary_json"])
    detail_summary = json.loads(rebuilt["detail_summary_json"])
    audit = json.loads(rebuilt["compensation_audit_json"])
    assert list_summary["posted"]["displayRange"] == "USD up to 15000/unknown"
    assert detail_summary["posted"]["displayRange"] == "USD up to 15000/unknown"
    assert audit["posted"]["fact"]["period"] == "unknown"
    assert audit["posted"]["fact"]["annualizedMaximumAmount"] is None
    assert audit["posted"]["fact"]["parserVersion"] == "posted-compensation-v4"
    warning_codes = {warning["code"] for warning in audit["posted"]["fact"]["warnings"]}
    assert "annual_period_inferred" not in warning_codes
    assert "missing_period" in warning_codes


def test_projection_suppresses_historical_posted_as_market_rows(
    conn: sqlite3.Connection,
) -> None:
    job_id = _seed_job(conn, "https://example.com/historical-posted-market")
    SqliteMarketCompensationRepository(conn).estimate_and_save_job(
        job_id=job_id,
        title="Senior Software Developer",
        company="ExampleCo",
        location="Madrid, Spain",
        observations=(
            ReportedCompensationObservation(
                source_id="levels_fyi",
                source_provenance="licensed",
                company_name="ExampleCo",
                role_title="Senior Software Developer",
                level_label="Senior",
                company_tier="tier_2_ambitious",
                location="Madrid, Spain",
                minimum_amount=118_000,
                maximum_amount=142_000,
                release_year=2026,
                sample_count=4,
                attribution="Levels.fyi reported compensation data",
            ),
        ),
        estimated_at="2026-06-19T10:01:00Z",
    )

    first_builder = ProjectionBuilder(conn_factory=lambda: conn)
    assert first_builder.refresh() == 1
    initial = conn.execute(
        """
        SELECT list.compensation_summary_json,
               detail.compensation_summary_json AS detail_summary_json,
               detail.compensation_audit_json
        FROM job_list_projections AS list
        JOIN job_detail_projections AS detail
          ON detail.tenant_id = list.tenant_id
         AND detail.job_id = list.job_id
        WHERE list.tenant_id = ? AND list.job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert initial is not None
    assert json.loads(initial["compensation_summary_json"])["market"]["recordStatus"] == "recorded"

    # Model a fully folded v1 database: its event watermark is settled and all
    # existing list/detail compensation payloads still carry projection v1.
    for table, column in (
        ("job_list_projections", "compensation_summary_json"),
        ("job_detail_projections", "compensation_summary_json"),
        ("job_detail_projections", "compensation_audit_json"),
    ):
        payload = json.loads(
            conn.execute(
                f"SELECT {column} FROM {table} WHERE tenant_id = ? AND job_id = ?",
                (str(LOCAL_TENANT), str(job_id)),
            ).fetchone()[0]
        )
        payload["projectionVersion"] = 1
        conn.execute(
            f"UPDATE {table} SET {column} = ? WHERE tenant_id = ? AND job_id = ?",
            (json.dumps(payload), str(LOCAL_TENANT), str(job_id)),
        )
    conn.execute(
        """
        UPDATE job_market_compensation_estimates
        SET source_snapshot_json = ?,
            warnings_json = ?
        WHERE tenant_id = ? AND job_id = ?
        """,
        (
            json.dumps(
                [
                    {
                        "source_id": "posted_salary_text",
                        "source_provenance": "employer_posted",
                        "source_type": "posted_salary",
                    }
                ]
            ),
            json.dumps(["posted_salary_sample"]),
            str(LOCAL_TENANT),
            str(job_id),
        ),
    )
    conn.commit()

    # No new event accompanies this pre-upgrade authority mutation. The v2
    # version marker must still invalidate and rebuild the settled projection.
    assert ProjectionBuilder(conn_factory=lambda: conn).refresh() == 1

    row = conn.execute(
        """
        SELECT list.compensation_summary_json,
               detail.compensation_summary_json AS detail_summary_json,
               detail.compensation_audit_json
        FROM job_list_projections AS list
        JOIN job_detail_projections AS detail
          ON detail.tenant_id = list.tenant_id
         AND detail.job_id = list.job_id
        WHERE list.tenant_id = ? AND list.job_id = ?
        """,
        (str(LOCAL_TENANT), str(job_id)),
    ).fetchone()
    assert row is not None
    summary = json.loads(row["compensation_summary_json"])
    detail_summary = json.loads(row["detail_summary_json"])
    audit = json.loads(row["compensation_audit_json"])
    assert summary["projectionVersion"] == 3
    assert detail_summary["projectionVersion"] == 3
    assert audit["projectionVersion"] == 3
    assert summary["market"]["recordStatus"] == "not_requested"
    assert audit["market"] == {
        "ok": True,
        "recordStatus": "not_requested",
        "jobId": str(job_id),
    }


def _insert_score(
    conn: sqlite3.Connection,
    job_id: JobId,
    *,
    fit_score: int,
    scored_at: str,
    criteria_json: str,
    trace_json: str,
    correction_json: str | None,
) -> None:
    conn.execute(
        """
        INSERT INTO job_scores (tenant_id, job_id, version, fit_score,
                                breakdown_json, keywords_json, scored_at,
                                correction_json, criteria_json, trace_json)
        VALUES ('local', ?, 1, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            str(job_id),
            fit_score,
            json.dumps(
                {
                    "technical_fit": 9,
                    "experience_fit": 7,
                    "role_fit": 8,
                    "reasoning": "Strong fit",
                }
            ),
            json.dumps(["python"]),
            scored_at,
            correction_json,
            criteria_json,
            trace_json,
        ),
    )


def test_projects_score_audit_columns_from_job_scores(conn: sqlite3.Connection) -> None:
    """Score audit columns (rubric criteria + prompt/model trace) are projected
    verbatim from ``job_scores`` into both the list and detail projections.

    Regression guard for the read-model NULL bug: the Python builder must write
    the same three audit columns the TS builder does, sourced byte-for-byte from
    the latest ``job_scores`` row, so the score-audit surface is never NULL for a
    normally-scored job even when the Python event handler owns the refresh.
    """
    url = "https://example.com/jobs/score-audit"
    job_id = _seed_job(conn, url)
    criteria_json = json.dumps(
        {
            "formula_version": "score-v3",
            "rubric": {"technical_fit": "Depth of required stack"},
            "weights": {"experience_fit": 0.3, "role_fit": 0.2, "technical_fit": 0.5},
        },
        sort_keys=True,
    )
    trace_json = json.dumps(
        {
            "correction_history": [],
            "model": "claude-opus",
            "parser_warnings": [],
            "prompt_version": "score-prompt-v7",
            "schema_version": "score-schema-v2",
            "scoring_policy_version": 3,
        },
        sort_keys=True,
    )
    _insert_score(
        conn,
        job_id,
        fit_score=8,
        scored_at="2026-06-20T10:00:00+00:00",
        criteria_json=criteria_json,
        trace_json=trace_json,
        correction_json=None,
    )
    record_job_event(conn, job_id, "score", "JobScored", payload=_INERT_CONTEXT)
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    list_row = conn.execute(
        """
        SELECT score_criteria_json, score_trace_json, score_correction_json
        FROM job_list_projections WHERE job_id = ?
        """,
        (str(job_id),),
    ).fetchone()
    assert list_row is not None
    assert list_row["score_criteria_json"] == criteria_json
    assert list_row["score_trace_json"] == trace_json
    assert list_row["score_correction_json"] is None
    assert json.loads(list_row["score_criteria_json"])["formula_version"] == "score-v3"
    assert json.loads(list_row["score_trace_json"])["scoring_policy_version"] == 3

    detail_row = conn.execute(
        """
        SELECT score_criteria_json, score_trace_json, score_correction_json
        FROM job_detail_projections WHERE job_id = ?
        """,
        (str(job_id),),
    ).fetchone()
    assert detail_row is not None
    assert detail_row["score_criteria_json"] == criteria_json
    assert detail_row["score_trace_json"] == trace_json
    assert detail_row["score_correction_json"] is None


def test_projects_score_correction_json_when_correction_exists(
    conn: sqlite3.Connection,
) -> None:
    """A self-correction on the latest score row is projected verbatim into
    ``score_correction_json`` for both projections, preserving the correction
    history the score-audit surface renders.
    """
    url = "https://example.com/jobs/score-correction"
    job_id = _seed_job(conn, url)
    correction_json = json.dumps(
        {
            "adjustments": [{"dimension": "experience_fit", "from": 9, "note": "overstated tenure", "to": 6}],
            "corrected_fit_score": 7,
            "original_fit_score": 9,
            "reason": "adversarial_self_correction",
        },
        sort_keys=True,
    )
    _insert_score(
        conn,
        job_id,
        fit_score=7,
        scored_at="2026-06-20T11:00:00+00:00",
        criteria_json=json.dumps({"formula_version": "score-v3"}, sort_keys=True),
        trace_json=json.dumps({"prompt_version": "score-prompt-v7"}, sort_keys=True),
        correction_json=correction_json,
    )
    record_job_event(conn, job_id, "score", "JobScored", payload=_INERT_CONTEXT)
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    list_row = conn.execute(
        "SELECT score_correction_json FROM job_list_projections WHERE job_id = ?",
        (str(job_id),),
    ).fetchone()
    assert list_row is not None
    assert list_row["score_correction_json"] == correction_json

    detail_row = conn.execute(
        "SELECT score_correction_json FROM job_detail_projections WHERE job_id = ?",
        (str(job_id),),
    ).fetchone()
    assert detail_row is not None
    assert detail_row["score_correction_json"] == correction_json
    assert json.loads(detail_row["score_correction_json"])["corrected_fit_score"] == 7


def test_score_audit_backfill_repopulates_existing_null_rows(conn: sqlite3.Connection) -> None:
    """One-time backfill repopulates audit columns for jobs scored before the
    Python builder learned to project them.

    Reproduces the production state on an existing DB: a projection row written
    by the old Python builder (audit columns NULL), a canonical ``job_scores``
    row, and a watermark already advanced past the ``JobScored`` event (the
    Python-first consumption that blocks the TS refresher). ``refresh()`` must
    rebuild the row and populate the three audit columns from ``job_scores``
    with no new score event. Without the backfill the row stays NULL because the
    columns already exist, so the schema-migration reset never fires.
    """
    url = "https://example.com/jobs/backfill-existing-null"
    job_id = _seed_job(conn, url)
    criteria_json = json.dumps({"formula_version": "score-v3"}, sort_keys=True)
    trace_json = json.dumps({"prompt_version": "score-prompt-v7"}, sort_keys=True)
    correction_json = json.dumps({"reason": "adversarial_self_correction"}, sort_keys=True)
    _insert_score(
        conn,
        job_id,
        fit_score=8,
        scored_at="2026-06-20T10:00:00+00:00",
        criteria_json=criteria_json,
        trace_json=trace_json,
        correction_json=correction_json,
    )
    record_job_event(conn, job_id, "score", "JobScored", payload=_INERT_CONTEXT)
    conn.commit()

    # Pre-fix projection rows: the old Python upsert never wrote the audit
    # columns, so they default to NULL.
    conn.execute(
        "INSERT INTO job_list_projections (tenant_id, job_id, title, fit_score) VALUES ('local', ?, 'Engineer', 8)",
        (str(job_id),),
    )
    conn.execute(
        "INSERT INTO job_detail_projections (tenant_id, job_id, description_preview) "
        "VALUES ('local', ?, 'Short job description')",
        (str(job_id),),
    )
    # Watermark already advanced past the score event: no event-driven rebuild.
    latest_event_id = conn.execute("SELECT MAX(event_id) FROM job_events").fetchone()[0]
    SqliteEventWatermarkRepository(conn).set(PYTHON_WATERMARK_NAME, int(latest_event_id))
    conn.commit()

    pre = conn.execute(
        "SELECT score_criteria_json FROM job_list_projections WHERE job_id = ?",
        (str(job_id),),
    ).fetchone()
    assert pre["score_criteria_json"] is None

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    list_row = conn.execute(
        """
        SELECT score_criteria_json, score_trace_json, score_correction_json
        FROM job_list_projections WHERE job_id = ?
        """,
        (str(job_id),),
    ).fetchone()
    assert list_row is not None
    assert list_row["score_criteria_json"] == criteria_json
    assert list_row["score_trace_json"] == trace_json
    assert list_row["score_correction_json"] == correction_json

    detail_row = conn.execute(
        """
        SELECT score_criteria_json, score_trace_json, score_correction_json
        FROM job_detail_projections WHERE job_id = ?
        """,
        (str(job_id),),
    ).fetchone()
    assert detail_row is not None
    assert detail_row["score_criteria_json"] == criteria_json
    assert detail_row["score_trace_json"] == trace_json
    assert detail_row["score_correction_json"] == correction_json


def test_score_audit_backfill_runs_at_most_once(conn: sqlite3.Connection) -> None:
    """The backfill marker gates the scan so it runs once per DB. A NULL-audit
    row that appears after the marker is set is not re-backfilled, keeping steady
    state cheap (no per-refresh O(jobs) resync).
    """
    first = "https://example.com/jobs/backfill-marker-first"
    _seed_job(conn, first)
    conn.commit()

    # First refresh materialises the projection and sets the backfill marker.
    ProjectionBuilder(conn_factory=lambda: conn).refresh()
    marker = conn.execute(
        "SELECT COUNT(*) FROM projection_backfills WHERE name LIKE 'score_audit_columns_v1%'"
    ).fetchone()[0]
    assert marker == 1

    # A stray NULL-audit projection row with a canonical score appears AFTER the
    # marker is set. With the watermark advanced, the next refresh must leave it
    # untouched — the one-time scan does not run again.
    later = "https://example.com/jobs/backfill-marker-later"
    later_job_id = _seed_job(conn, later)
    _insert_score(
        conn,
        later_job_id,
        fit_score=6,
        scored_at="2026-06-20T12:00:00+00:00",
        criteria_json=json.dumps({"formula_version": "score-v3"}, sort_keys=True),
        trace_json=json.dumps({"prompt_version": "score-prompt-v7"}, sort_keys=True),
        correction_json=None,
    )
    conn.execute(
        "INSERT INTO job_list_projections (tenant_id, job_id, title, fit_score) VALUES ('local', ?, 'Engineer', 6)",
        (str(later_job_id),),
    )
    record_job_event(conn, later_job_id, "score", "JobScored", payload=_INERT_CONTEXT)
    latest_event_id = conn.execute("SELECT MAX(event_id) FROM job_events").fetchone()[0]
    SqliteEventWatermarkRepository(conn).set(PYTHON_WATERMARK_NAME, int(latest_event_id))
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        "SELECT score_criteria_json FROM job_list_projections WHERE job_id = ?",
        (str(later_job_id),),
    ).fetchone()
    assert row is not None
    assert row["score_criteria_json"] is None


def test_feedback_only_history_rebuilds_source_quality(conn: sqlite3.Connection) -> None:
    record_job_event(
        conn,
        None,
        "discover",
        "DiscoveryFeedbackRecorded",
        payload={
            "feedback_id": "feedback-1",
            "source_id": "greenhouse:acme",
            "kind": "bad_source",
            "recorded_at": utc_now(),
            **_INERT_CONTEXT,
        },
    )
    conn.commit()

    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    row = conn.execute(
        """
        SELECT observed_jobs, detail_failure_count, last_error_class
        FROM source_quality_stats
        WHERE source_id = ?
        """,
        ("greenhouse:acme",),
    ).fetchone()
    assert row is not None
    assert row[0] == 1
    assert row[1] == 1
    assert row[2] == "user_bad_source"


def test_subscribes_to_event_bus(conn: sqlite3.Connection) -> None:
    """Wiring the builder to the bus refreshes projections on publish."""
    job_id = _seed_job(conn, "https://example.com/bus")
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    bus = InProcessEventBus()
    builder.subscribe_to(bus)

    # Publish via the bus AFTER recording the event in the table.
    record_job_event(conn, job_id, "discover", "JobDiscovered", payload=_INERT_CONTEXT)
    conn.commit()
    from jobctrl.domain.events.base import create_domain_event

    bus.publish(
        create_domain_event(
            "JobDiscovered",
            LOCAL_TENANT,
            {"jobId": str(job_id), **_INERT_CONTEXT},
        )
    )

    row = conn.execute(
        "SELECT job_id FROM job_list_projections WHERE job_id = ?",
        (str(job_id),),
    ).fetchone()
    assert row is not None


def test_unsubscribe_stops_refreshes(conn: sqlite3.Connection) -> None:
    job_id = _seed_job(conn, "https://example.com/sub")
    builder = ProjectionBuilder(conn_factory=lambda: conn)
    bus = InProcessEventBus()
    sub = builder.subscribe_to(bus)
    sub.unsubscribe()

    from jobctrl.domain.events.base import create_domain_event

    bus.publish(
        create_domain_event(
            "JobDiscovered",
            LOCAL_TENANT,
            {"jobId": str(job_id), **_INERT_CONTEXT},
        )
    )

    rows = conn.execute("SELECT COUNT(*) FROM job_list_projections").fetchone()
    # Builder has not been called manually; nothing in projections yet.
    assert rows[0] == 0
