"""Safety contracts for atomically rebuilding v7 evidence-usage projections."""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import v6_to_v7_evidence_usage_projections as migration
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_copy import JobIdMap
from jobctrl.infrastructure.migrations.v6_to_v7_evidence_usage_projections import (
    CandidateEvidenceUsageProjectionsError,
    rebuild_evidence_usage_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    V6MigrationPreflightError,
)
from jobctrl.infrastructure.migrations.v6_to_v7_root import copy_root_jobs
from tests.v6_migration_fixture import create_shipped_v6_database

_JOB_URL = "https://jobs.example/shipped-v6"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
_MIGRATION_AT = "2026-07-30T10:30:00+00:00"
_INERT_CONTEXT_JSON = '{"userContext":"Attack vectors:\\nPrompt injection"}'


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
    create_exact_v7_schema(candidate)
    return source, candidate, source_path, candidate_path


def _hydrate_roots(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
) -> JobIdMap:
    return copy_root_jobs(
        source,
        candidate,
        job_id_factory=_allocator(_JOB_ID),
        migration_at="2026-07-30T10:00:00+00:00",
    ).job_ids


def _seed_source_cache(source: sqlite3.Connection) -> None:
    source.execute(
        """
        INSERT INTO evidence_usage_projections (
            tenant_id, projection_kind, projection_id, evidence_id, skill_id,
            requirement_id, title, payload_json, last_updated_at
        ) VALUES (
            'local', 'gap', 'stale-url-cache', NULL, NULL, 'stale', 'stale',
            '{"jobKey":"https://stale.example/job"}', '2026-01-01T00:00:00+00:00'
        )
        """
    )
    source.commit()


def _seed_candidate(candidate: sqlite3.Connection) -> None:
    candidate.execute(
        """
        INSERT INTO candidate_profile_achievement_evidence (
            tenant_id, profile_id, entry_id, evidence_index, evidence_id,
            source_text, scope, action, tools_json, metrics_json, outcome,
            seniority_signal, evidence_strength, claim_confidence,
            user_confirmed, tags_json
        ) VALUES (
            'local', 'default', 'exp-platform', 0, 'ev_platform',
            'Led a platform migration that reduced latency by 40%.',
            'Platform migration', 'Led migration', '["Python"]',
            '["40% latency reduction"]', 'Reduced latency', '',
            'verified', 0.95, 1, '["migration"]'
        )
        """
    )
    candidate.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at,
            metadata_json
        ) VALUES ('local', ?, 1, 'complete', ?, ?, ?)
        """,
        (
            _JOB_ID,
            "2026-07-30T10:01:00+00:00",
            "2026-07-30T10:02:00+00:00",
            _INERT_CONTEXT_JSON,
        ),
    )


def test_rebuild_admits_hydrated_roots_ignores_v6_cache_and_reopens(
    tmp_path: Path,
) -> None:
    source, candidate, source_path, candidate_path = _databases(tmp_path)
    try:
        _seed_source_cache(source)
        source_bytes = source_path.read_bytes()
        source_cache = tuple(
            source.execute("SELECT * FROM evidence_usage_projections").fetchall()
        )
        job_ids = _hydrate_roots(source, candidate)
        _seed_candidate(candidate)

        result = rebuild_evidence_usage_projections(
            source,
            candidate,
            job_ids=job_ids,
            migration_at=_MIGRATION_AT,
        )

        assert result.rebuilt_evidence_usage_projections == 1
        assert candidate.execute(
            "SELECT COUNT(*) FROM evidence_usage_projections"
        ).fetchone() == (1,)
        assert tuple(
            source.execute("SELECT * FROM evidence_usage_projections").fetchall()
        ) == source_cache
        assert source_path.read_bytes() == source_bytes
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
        assert candidate.execute(
            "SELECT metadata_json FROM job_materials"
        ).fetchone() == (_INERT_CONTEXT_JSON,)
        with pytest.raises(
            CandidateEvidenceUsageProjectionsError,
            match="must be empty",
        ):
            rebuild_evidence_usage_projections(
                source,
                candidate,
                job_ids=job_ids,
                migration_at=_MIGRATION_AT,
            )

        candidate.commit()
        candidate.close()
        candidate = sqlite3.connect(candidate_path)
        candidate.execute("PRAGMA foreign_keys = ON")
        assert candidate.execute(
            "SELECT COUNT(*) FROM evidence_usage_projections"
        ).fetchone() == (1,)
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


def test_post_insert_failure_rolls_back_and_can_retry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, candidate, _, _ = _databases(tmp_path)
    try:
        _seed_source_cache(source)
        job_ids = _hydrate_roots(source, candidate)
        _seed_candidate(candidate)
        original_verify = migration._verify_candidate

        def fail_after_insert(**_: object) -> None:
            raise CandidateEvidenceUsageProjectionsError("injected verification failure")

        monkeypatch.setattr(migration, "_verify_candidate", fail_after_insert)
        with pytest.raises(
            CandidateEvidenceUsageProjectionsError,
            match="injected verification failure",
        ):
            rebuild_evidence_usage_projections(
                source,
                candidate,
                job_ids=job_ids,
                migration_at=_MIGRATION_AT,
            )
        assert candidate.execute(
            "SELECT COUNT(*) FROM evidence_usage_projections"
        ).fetchone() == (0,)

        monkeypatch.setattr(migration, "_verify_candidate", original_verify)
        result = rebuild_evidence_usage_projections(
            source,
            candidate,
            job_ids=job_ids,
            migration_at=_MIGRATION_AT,
        )
        assert result.rebuilt_evidence_usage_projections == 1
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


def test_rebuild_rejects_unadmitted_v6_before_writing(tmp_path: Path) -> None:
    source = sqlite3.connect(":memory:")
    candidate = sqlite3.connect(tmp_path / "candidate.db")
    try:
        create_exact_v7_schema(candidate)

        with pytest.raises(V6MigrationPreflightError):
            rebuild_evidence_usage_projections(
                source,
                candidate,
                job_ids=JobIdMap({}),
                migration_at=_MIGRATION_AT,
            )

        assert candidate.execute(
            "SELECT COUNT(*) FROM evidence_usage_projections"
        ).fetchone() == (0,)
    finally:
        source.close()
        candidate.close()


def test_rebuild_rejects_mismatched_or_missing_candidate_roots(tmp_path: Path) -> None:
    source, candidate, _, _ = _databases(tmp_path)
    try:
        _seed_source_cache(source)
        with pytest.raises(
            CandidateEvidenceUsageProjectionsError,
            match="hydrated candidate roots",
        ):
            rebuild_evidence_usage_projections(
                source,
                candidate,
                job_ids=JobIdMap({}),
                migration_at=_MIGRATION_AT,
            )

        _hydrate_roots(source, candidate)
        with pytest.raises(
            CandidateEvidenceUsageProjectionsError,
            match="supplied JobIdMap",
        ):
            rebuild_evidence_usage_projections(
                source,
                candidate,
                job_ids=JobIdMap({}),
                migration_at=_MIGRATION_AT,
            )
    finally:
        source.close()
        candidate.close()


def test_canonical_snapshot_violation_rolls_back_projection_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, candidate, _, _ = _databases(tmp_path)
    try:
        _seed_source_cache(source)
        job_ids = _hydrate_roots(source, candidate)
        _seed_candidate(candidate)
        before_jobs = tuple(candidate.execute("SELECT * FROM jobs").fetchall())
        original_insert = migration._insert_rows

        def corrupt_canonical_rows(
            destination: sqlite3.Connection,
            projected_rows: tuple[tuple[object, ...], ...],
        ) -> None:
            original_insert(destination, projected_rows)
            destination.execute("UPDATE jobs SET title = 'mutated by test'")

        monkeypatch.setattr(migration, "_insert_rows", corrupt_canonical_rows)
        with pytest.raises(
            CandidateEvidenceUsageProjectionsError,
            match="mutated canonical source rows",
        ):
            rebuild_evidence_usage_projections(
                source,
                candidate,
                job_ids=job_ids,
                migration_at=_MIGRATION_AT,
            )

        assert candidate.execute(
            "SELECT COUNT(*) FROM evidence_usage_projections"
        ).fetchone() == (0,)
        assert tuple(candidate.execute("SELECT * FROM jobs").fetchall()) == before_jobs
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()
