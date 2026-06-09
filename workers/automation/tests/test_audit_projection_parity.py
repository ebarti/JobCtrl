"""Cross-runtime projection parity for the Phase 4 audit tables (AUDIT-02).

The Python half of the genuine TS<->Python drift guard. The TS half lives at
``apps/api/test/audit-projection-parity.test.ts``. Both load the SAME shared
fixture (``packages/domain-types/test/fixtures/audit_projection_parity.json``),
seed the SAME canonical rows, run their OWN projection builder, and assert the
resulting projection-column JSON equals the fixture's ``expected`` block.

Because both builders are checked against ONE expectation derived from the
canonical rows, a schema or serialisation drift in EITHER runtime fails its test
— unlike the earlier Phase-3 parity test, which hand-seeded the projection JSON
on the TS side only and so could not catch the Python builder drifting.

This test exercises the REAL ``ProjectionBuilder`` end to end:
``job_employer_analysis`` -> ``job_detail_projections.employer_analysis_json`` and
``job_bullet_provenance`` -> ``artifact_list_projections.{bullet_provenance_json,
coverage_audit_json,voice_pass_json}``.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from jobhunter.database import (
    close_connection,
    ensure_bullet_provenance_tables,
    ensure_employer_analysis_tables,
    ensure_materials_tables,
    init_db,
)
from jobhunter.infrastructure.projections.projection_builder import ProjectionBuilder

REPO = Path(__file__).resolve().parents[3]
FIXTURE_PATH = (
    REPO / "packages" / "domain-types" / "test" / "fixtures" / "audit_projection_parity.json"
)


@pytest.fixture(scope="module")
def fixture() -> dict[str, Any]:
    return json.loads(FIXTURE_PATH.read_text())


@pytest.fixture()
def conn(fixture: dict[str, Any]) -> Iterator[sqlite3.Connection]:
    connection = init_db(":memory:")
    ensure_employer_analysis_tables(connection)
    ensure_materials_tables(connection)
    ensure_bullet_provenance_tables(connection)
    job = fixture["job"]
    connection.execute(
        "INSERT INTO jobs (url, title, site) VALUES (?, ?, ?)",
        (job["url"], job["title"], job["site"]),
    )
    connection.commit()
    yield connection
    close_connection()


def _seed_rows(conn: sqlite3.Connection, fixture: dict[str, Any]) -> None:
    """Seed the canonical rows exactly as the Python repositories write them."""
    job_url = fixture["job"]["url"]
    rows = fixture["rows"]

    for row in rows["jobEmployerAnalysis"]:
        conn.execute(
            """
            INSERT INTO job_employer_analysis (
                job_url, generation, tenant_id, snapshot_hash, prompt_version,
                sdk_set_version, cache_key, role_framing, inferred_seniority,
                ideal_candidate_narrative, requirements_json, keywords_json,
                agreement_json, legs_attempted, legs_succeeded, created_at
            ) VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_url,
                row["generation"],
                row["snapshot_hash"],
                row["prompt_version"],
                row["sdk_set_version"],
                row["cache_key"],
                row["role_framing"],
                row["inferred_seniority"],
                row["ideal_candidate_narrative"],
                row["requirements_json"],
                row["keywords_json"],
                row["agreement_json"],
                row["legs_attempted"],
                row["legs_succeeded"],
                row["created_at"],
            ),
        )
    for sub in rows["jobEmployerAnalysisSubAnalyses"]:
        conn.execute(
            """
            INSERT INTO job_employer_analysis_sub_analyses (
                job_url, generation, model_id, tenant_id, analysis_json
            ) VALUES (?, ?, ?, 'local', ?)
            """,
            (job_url, sub["generation"], sub["model_id"], sub["analysis_json"]),
        )
    for failure in rows["jobEmployerAnalysisFailures"]:
        conn.execute(
            """
            INSERT INTO job_employer_analysis_failures (
                job_url, generation, model_id, tenant_id, error, raw_output
            ) VALUES (?, ?, ?, 'local', ?, ?)
            """,
            (
                job_url,
                failure["generation"],
                failure["model_id"],
                failure["error"],
                failure["raw_output"],
            ),
        )

    generation = fixture["job"]["generation"]
    created_at = fixture["job"]["createdAt"]
    conn.execute(
        """
        INSERT INTO job_materials (job_url, generation, tenant_id, status, created_at, updated_at)
        VALUES (?, ?, 'local', 'complete', ?, ?)
        """,
        (job_url, generation, created_at, created_at),
    )
    for artifact in rows["artifacts"]:
        conn.execute(
            """
            INSERT INTO job_materials_artifacts (
                job_url, generation, artifact_type, artifact_id, status, path,
                render_format, size_bytes, metadata_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
            """,
            (
                job_url,
                generation,
                artifact["artifact_type"],
                artifact["artifact_id"],
                artifact["status"],
                artifact["path"],
                artifact["render_format"],
                artifact["size_bytes"],
                created_at,
            ),
        )
    for bullet in rows["bulletProvenance"]:
        conn.execute(
            """
            INSERT INTO job_bullet_provenance (
                job_url, generation, bullet_id, tenant_id, artifact_id, section,
                source_id, evidence_ids_json, requirement_ids_json,
                matched_keywords_json, transform_type, control, rationale,
                generated_text, position, created_at, coverage_json, voice_json
            ) VALUES (?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_url,
                bullet["generation"],
                bullet["bullet_id"],
                bullet["artifact_id"],
                bullet["section"],
                bullet["source_id"],
                bullet["evidence_ids_json"],
                bullet["requirement_ids_json"],
                bullet["matched_keywords_json"],
                bullet["transform_type"],
                bullet["control"],
                bullet["rationale"],
                bullet["generated_text"],
                bullet["position"],
                bullet["created_at"],
                bullet["coverage_json"],
                bullet["voice_json"],
            ),
        )
    # A job_events row marks the job dirty so the builder rebuilds its projection.
    conn.execute(
        """
        INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
        VALUES (?, 'tailor', 'ResumeApproved', 'info', 'approved', ?, '{}')
        """,
        (job_url, created_at),
    )
    conn.commit()


def test_python_builder_projects_audit_rows_matching_shared_fixture(
    conn: sqlite3.Connection, fixture: dict[str, Any]
) -> None:
    _seed_rows(conn, fixture)
    ProjectionBuilder(conn_factory=lambda: conn).refresh()

    job_url = fixture["job"]["url"]
    expected = fixture["expected"]

    detail = conn.execute(
        "SELECT employer_analysis_json FROM job_detail_projections WHERE job_id = ?",
        (job_url,),
    ).fetchone()
    assert detail is not None
    assert json.loads(detail["employer_analysis_json"]) == expected["employerAnalysisJson"]

    # The text resume row carries the per-bullet provenance + coverage + voice.
    text_row = conn.execute(
        """
        SELECT bullet_provenance_json, coverage_audit_json, voice_pass_json
        FROM artifact_list_projections
        WHERE artifact_id = 'resume-1'
        """,
    ).fetchone()
    assert text_row is not None
    assert json.loads(text_row["bullet_provenance_json"]) == expected["bulletProvenanceJson"]
    assert json.loads(text_row["coverage_audit_json"]) == expected["coverageAuditJson"]
    assert json.loads(text_row["voice_pass_json"]) == expected["voicePassJson"]
