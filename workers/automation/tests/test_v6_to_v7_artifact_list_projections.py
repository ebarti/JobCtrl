"""Focused contracts for rebuilding v7 artifact projections from canonical rows."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_v7 import (
    create_unstamped_exact_v7_candidate,
)
from jobctrl.infrastructure.migrations.v6_to_v7_artifact_list_projections import (
    CandidateArtifactListProjectionsError,
    rebuild_artifact_list_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_copy import (
    JobIdMap,
    copy_direct_and_scalar_tables,
)
from jobctrl.infrastructure.migrations.v6_to_v7_root import copy_root_jobs
from tests.v6_migration_fixture import create_shipped_v6_database

_JOB_URL = "https://jobs.example/shipped-v6"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
_INERT_CONTEXT_JSON = '{"userContext":"Attack vectors:\\nPrompt injection"}'
_PROJECTION_COLUMNS = (
    "artifact_id",
    "tenant_id",
    "job_id",
    "job_title",
    "job_employer",
    "artifact_type",
    "status",
    "local_path",
    "size_bytes",
    "created_at",
    "generation",
    "metadata_json",
    "layout_boxes_json",
    "bullet_provenance_json",
    "coverage_audit_json",
    "voice_pass_json",
)


def _allocator(*values: str):
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


def _databases(
    tmp_path: Path,
) -> tuple[sqlite3.Connection, sqlite3.Connection, Path, Path]:
    source_path = tmp_path / "source.db"
    create_shipped_v6_database(source_path)
    source = sqlite3.connect(source_path)
    source.execute("PRAGMA foreign_keys = ON")

    candidate_path = tmp_path / "candidate.db"
    candidate = sqlite3.connect(candidate_path)
    candidate.execute("PRAGMA foreign_keys = ON")
    create_unstamped_exact_v7_candidate(candidate)
    return source, candidate, source_path, candidate_path


def _hydrate_candidate(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
) -> JobIdMap:
    roots = copy_root_jobs(
        source,
        candidate,
        job_id_factory=_allocator(_JOB_ID),
        migration_at="2026-07-30T10:00:00+00:00",
    )
    copy_direct_and_scalar_tables(source, candidate)
    return roots.job_ids


def _seed_material(
    source: sqlite3.Connection,
    *,
    artifact_type: str,
    artifact_id: str,
    path: str,
    generation: int = 1,
    metadata_json: str | None = None,
) -> None:
    source.execute(
        """
        INSERT OR IGNORE INTO job_materials (
            job_url, generation, tenant_id, status, created_at, updated_at,
            last_validation_json, last_verdict_json, metadata_json
        ) VALUES (?, ?, 'local', 'approved', ?, ?, NULL, NULL, NULL)
        """,
        (
            _JOB_URL,
            generation,
            "2026-07-30T10:00:00+00:00",
            "2026-07-30T10:00:00+00:00",
        ),
    )
    source.execute(
        """
        INSERT INTO job_materials_artifacts (
            job_url, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at, superseded_at
        ) VALUES (?, ?, ?, ?, 'approved', ?, 'text', 321, ?, ?, NULL)
        """,
        (
            _JOB_URL,
            generation,
            artifact_type,
            artifact_id,
            path,
            metadata_json,
            "2026-07-30T10:01:00+00:00",
        ),
    )


def _seed_generic(
    source: sqlite3.Connection,
    *,
    artifact_type: str,
    path: str,
    artifact_id: int | None = None,
) -> None:
    columns = (
        "artifact_id, " if artifact_id is not None else ""
    ) + "job_url, stage, artifact_type, status, path, created_at, size_bytes, metadata_json"
    placeholders = ", ".join("?" for _ in columns.split(", "))
    values: tuple[object, ...] = (
        *((artifact_id,) if artifact_id is not None else ()),
        _JOB_URL,
        "tailor",
        artifact_type,
        "candidate",
        path,
        "2026-07-30T10:02:00+00:00",
        99,
        '{"generic":"must-not-project"}',
    )
    source.execute(
        f"INSERT INTO job_artifacts ({columns}) VALUES ({placeholders})", values
    )


def _seed_stale_v6_projection(source: sqlite3.Connection) -> None:
    source.execute(
        """
        INSERT INTO artifact_list_projections (
            artifact_id, tenant_id, job_id, job_title, job_employer,
            artifact_type, status, local_path, size_bytes, created_at, generation,
            metadata_json, layout_boxes_json, bullet_provenance_json,
            coverage_audit_json, voice_pass_json
        ) VALUES (
            'phantom-v6-cache-pdf', 'local', ?, 'Cache title', 'Cache employer',
            'resume_pdf', 'approved', '/tmp/phantom-cache.pdf', 1, ?, 99,
            '{"cache":true}', '[]', '[]', NULL, NULL
        )
        """,
        (_JOB_URL, "2026-07-30T10:03:00+00:00"),
    )


def _seed_layout(source: sqlite3.Connection, *, artifact_id: str) -> None:
    source.execute(
        """
        INSERT INTO job_material_layout_boxes (
            job_url, generation, artifact_id, box_index, tenant_id, semantic_id,
            page_number, line_number, text_excerpt, left_pct, top_pct, width_pct,
            height_pct, audit_target_json, created_at
        ) VALUES (?, 1, ?, 0, 'local', 'experience:one#0', 1, 6, 'Built systems.',
                  12.5, 24.0, 62.0, 2.4, '{}', ?)
        """,
        (_JOB_URL, artifact_id, "2026-07-30T10:04:00+00:00"),
    )


def _seed_provenance(source: sqlite3.Connection, *, artifact_id: str) -> None:
    source.execute(
        """
        INSERT INTO job_bullet_provenance (
            job_url, generation, bullet_id, tenant_id, artifact_id, section,
            source_id, evidence_ids_json, requirement_ids_json,
            matched_keywords_json, transform_type, control, rationale,
            generated_text, position, created_at, coverage_json, voice_json
        ) VALUES (?, 1, 'experience:one#0', 'local', ?, 'experience', 'experience:one',
                  '["ev-1"]', '["req-1"]', '["systems"]', 'reframe',
                  'rephrase_allowed', '', 'Built systems.', 0, ?,
                  '{"computed_against":"rendered_text","planned":["systems"],"covered":["systems"],"declared":[],"missing":[],"covered_by":{"systems":"experience:one#0"},"declared_by":{},"counts":{"planned":1,"covered":1,"declared":0,"missing":0}}',
                  '{"ran":true,"accepted":true,"model":"test-model","prompt_version":"voice-pass-v1","proxy_delta":{},"reason":""}')
        """,
        (_JOB_URL, artifact_id, "2026-07-30T10:04:00+00:00"),
    )


def _projection_rows(candidate: sqlite3.Connection) -> tuple[tuple[object, ...], ...]:
    return tuple(
        tuple(row)
        for row in candidate.execute(
            f"SELECT {', '.join(_PROJECTION_COLUMNS)} "
            "FROM artifact_list_projections ORDER BY rowid"
        ).fetchall()
    )


def test_rebuild_uses_candidate_canonical_artifacts_not_v6_cache(
    tmp_path: Path,
) -> None:
    source, candidate, source_path, _candidate_path = _databases(tmp_path)
    try:
        source.execute(
            "UPDATE jobs SET title = ?, company = NULL, site = ? WHERE url = ?",
            ("Canonical role", "untrusted-site", _JOB_URL),
        )
        _seed_material(
            source,
            artifact_type="tailored_resume",
            artifact_id="material-resume",
            path="/tmp/resume.txt",
            metadata_json=_INERT_CONTEXT_JSON,
        )
        _seed_material(
            source,
            artifact_type="resume_pdf",
            artifact_id="material-resume-pdf",
            path="/tmp/resume.pdf",
        )
        _seed_material(
            source,
            artifact_type="cover_letter_pdf",
            artifact_id="blank-material",
            path="  ",
        )
        _seed_generic(source, artifact_type="tailored_resume", path="/tmp/resume.txt")
        _seed_generic(source, artifact_type="cover_letter", path="/tmp/cover.txt")
        _seed_layout(source, artifact_id="material-resume-pdf")
        _seed_provenance(source, artifact_id="material-resume")
        _seed_stale_v6_projection(source)
        source.commit()
        source_bytes = source_path.read_bytes()
        source_cache = tuple(source.execute("SELECT * FROM artifact_list_projections").fetchall())
        job_ids = _hydrate_candidate(source, candidate)

        result = rebuild_artifact_list_projections(source, candidate, job_ids=job_ids)

        assert result.rebuilt_artifact_list_projections == 3
        rows = {str(row[0]): row for row in _projection_rows(candidate)}
        assert set(rows) == {"material-resume", "material-resume-pdf", "2"}
        assert "phantom-v6-cache-pdf" not in rows
        assert rows["material-resume"][1:12] == (
            "local",
            _JOB_ID,
            "Canonical role",
            "Unknown company",
            "tailored_resume",
            "approved",
            "/tmp/resume.txt",
            321,
            "2026-07-30T10:01:00+00:00",
            1,
            _INERT_CONTEXT_JSON,
        )
        assert rows["2"][5:16] == (
            "cover_letter",
            "candidate",
            "/tmp/cover.txt",
            99,
            "2026-07-30T10:02:00+00:00",
            None,
            None,
            None,
            None,
            None,
            None,
        )
        assert json.loads(str(rows["material-resume-pdf"][12])) == [
            {
                "semanticId": "experience:one#0",
                "pageNumber": 1,
                "lineNumber": 6,
                "textExcerpt": "Built systems.",
                "leftPct": 12.5,
                "topPct": 24.0,
                "widthPct": 62.0,
                "heightPct": 2.4,
            }
        ]
        assert json.loads(str(rows["material-resume"][13])) == [
            {
                "bullet_id": "experience:one#0",
                "section": "experience",
                "source_id": "experience:one",
                "evidence_ids": ["ev-1"],
                "requirement_ids": ["req-1"],
                "matched_keywords": ["systems"],
                "transform_type": "reframe",
                "control": "rephrase_allowed",
                "rationale": "",
                "generated_text": "Built systems.",
            }
        ]
        assert json.loads(str(rows["material-resume"][14]))["counts"] == {
            "planned": 1,
            "covered": 1,
            "declared": 0,
            "missing": 0,
        }
        assert json.loads(str(rows["material-resume"][15]))["model"] == "test-model"
        assert tuple(source.execute("SELECT * FROM artifact_list_projections").fetchall()) == source_cache
        assert source_path.read_bytes() == source_bytes
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []

        with pytest.raises(CandidateArtifactListProjectionsError, match="must be empty"):
            rebuild_artifact_list_projections(source, candidate, job_ids=job_ids)
    finally:
        source.close()
        candidate.close()


def test_rebuild_rejects_duplicate_emitted_artifact_ids_without_writes(
    tmp_path: Path,
) -> None:
    source, candidate, source_path, _candidate_path = _databases(tmp_path)
    try:
        _seed_material(
            source,
            artifact_type="tailored_resume",
            artifact_id="7",
            path="/tmp/resume.txt",
        )
        _seed_generic(
            source,
            artifact_type="cover_letter",
            path="/tmp/cover.txt",
            artifact_id=7,
        )
        source.commit()
        source_bytes = source_path.read_bytes()
        job_ids = _hydrate_candidate(source, candidate)

        with pytest.raises(
            CandidateArtifactListProjectionsError,
            match="globally unique",
        ):
            rebuild_artifact_list_projections(source, candidate, job_ids=job_ids)

        assert _projection_rows(candidate) == ()
        assert source_path.read_bytes() == source_bytes
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize(
    "audit_artifact_id, repair, expected_count",
    (
        ("missing-artifact", "DELETE FROM job_material_layout_boxes", 0),
        (
            "blank-material",
            "UPDATE job_materials_artifacts SET path = '/tmp/repaired.txt'",
            1,
        ),
    ),
)
def test_rebuild_rejects_missing_or_orphan_audit_then_retries_and_reopens(
    tmp_path: Path,
    audit_artifact_id: str,
    repair: str,
    expected_count: int,
) -> None:
    source, candidate, _source_path, candidate_path = _databases(tmp_path)
    try:
        _seed_material(
            source,
            artifact_type="tailored_resume",
            artifact_id="blank-material",
            path="  ",
        )
        _seed_layout(source, artifact_id=audit_artifact_id)
        source.commit()
        job_ids = _hydrate_candidate(source, candidate)

        with pytest.raises(
            CandidateArtifactListProjectionsError,
            match="audit rows must reference an emitted artifact root",
        ):
            rebuild_artifact_list_projections(source, candidate, job_ids=job_ids)
        assert _projection_rows(candidate) == ()

        candidate.execute(repair)
        result = rebuild_artifact_list_projections(source, candidate, job_ids=job_ids)
        assert result.rebuilt_artifact_list_projections == expected_count
        candidate.commit()
        candidate.close()
        candidate = sqlite3.connect(candidate_path)
        candidate.execute("PRAGMA foreign_keys = ON")
        assert [row[0] for row in _projection_rows(candidate)] == (
            ["blank-material"] if expected_count else []
        )
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()
