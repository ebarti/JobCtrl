"""Safety contracts for rebuilding v7 job-list projections."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import v6_to_v7_job_list_projections as migration
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.migrations.v6_to_v7_apply_run_projections import (
    rebuild_apply_run_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_artifact_list_projections import (
    rebuild_artifact_list_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_copy import (
    JobIdMap,
    copy_direct_and_scalar_tables,
)
from jobctrl.infrastructure.migrations.v6_to_v7_job_list_projections import (
    CandidateJobListProjectionsError,
    rebuild_job_list_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_events import copy_job_events
from jobctrl.infrastructure.migrations.v6_to_v7_root import copy_root_jobs
from tests.v6_migration_fixture import create_shipped_v6_database

_JOB_URL = "https://jobs.example/shipped-v6"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
_MIGRATION_AT = "2026-07-31T09:00:00+00:00"
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


def _seed_source(source: sqlite3.Connection) -> None:
    source.execute(
        """
        UPDATE jobs
        SET title = 'Canonical v6 role', company = 'Canonical company',
            description = 'Canonical description', full_description = 'Canonical full description',
            salary = '€90k'
        WHERE url = ?
        """,
        (_JOB_URL,),
    )
    source.execute(
        """
        INSERT INTO job_materials (
            job_url, generation, tenant_id, status, created_at, updated_at,
            last_validation_json, last_verdict_json, metadata_json
        ) VALUES (?, 1, 'local', 'resume_in_progress', ?, ?, NULL, NULL, ?)
        """,
        (_JOB_URL, _MIGRATION_AT, _MIGRATION_AT, _INERT_CONTEXT_JSON),
    )
    source.execute(
        """
        INSERT INTO job_materials_artifacts (
            job_url, generation, artifact_type, artifact_id, status, path,
            render_format, size_bytes, metadata_json, created_at
        ) VALUES (?, 1, 'tailored_resume', 'rebuilt-artifact', 'approved',
                  '/tmp/resume.txt', 'text', 100, ?, ?)
        """,
        (_JOB_URL, _INERT_CONTEXT_JSON, _MIGRATION_AT),
    )
    source.executemany(
        """
        INSERT INTO job_events (
            event_id, job_url, stage, event_type, level, message, occurred_at,
            payload_json, entity_kind, entity_ref, idempotency_key
        ) VALUES (?, ?, 'apply', ?, 'info', NULL, ?, ?, 'job', ?, ?)
        """,
        (
            (
                1001,
                _JOB_URL,
                "ApplyRunStarted",
                "2026-07-30T10:00:00+00:00",
                json.dumps(
                    {
                        "run_id": "rebuilt-run",
                        "job_id": _JOB_URL,
                        "started_at": "2026-07-30T10:00:00+00:00",
                        "dry_run": False,
                    }
                ),
                _JOB_URL,
                "job-list-apply-started",
            ),
            (
                1002,
                _JOB_URL,
                "ApplicationSubmitted",
                "2026-07-30T10:01:00+00:00",
                json.dumps(
                    {
                        "run_id": "rebuilt-run",
                        "job_id": _JOB_URL,
                        "result": "applied",
                        "finished_at": "2026-07-30T10:01:00+00:00",
                    }
                ),
                _JOB_URL,
                "job-list-apply-submitted",
            ),
        ),
    )
    # This URL-keyed v6 cache is deliberately stale and must never be read.
    source.execute(
        """
        INSERT INTO job_list_projections (
            tenant_id, job_id, title, source, score_keywords_json, score_reasoning,
            current_stage, current_substage, current_state, last_updated_at
        ) VALUES ('local', ?, 'STALE URL CACHE', 'stale', '[]', 'stale',
                  'apply', 'apply', 'succeeded', ?)
        """,
        (_JOB_URL, _MIGRATION_AT),
    )
    source.commit()


def _hydrate(source: sqlite3.Connection, candidate: sqlite3.Connection) -> JobIdMap:
    roots = copy_root_jobs(
        source,
        candidate,
        job_id_factory=_allocator(_JOB_ID),
        migration_at=_MIGRATION_AT,
    )
    copy_direct_and_scalar_tables(source, candidate)
    copy_job_events(source, candidate, job_ids=roots.job_ids)
    rebuild_apply_run_projections(source, candidate, job_ids=roots.job_ids)
    rebuild_artifact_list_projections(source, candidate, job_ids=roots.job_ids)
    return roots.job_ids


def test_rebuild_uses_canonical_candidate_rows_ignores_v6_cache_and_reopens(
    tmp_path: Path,
) -> None:
    source, candidate, source_path, candidate_path = _databases(tmp_path)
    try:
        _seed_source(source)
        source_bytes = source_path.read_bytes()
        source_cache = tuple(
            source.execute("SELECT * FROM job_list_projections").fetchall()
        )
        with pytest.raises(
            CandidateJobListProjectionsError,
            match="hydrated candidate roots",
        ):
            rebuild_job_list_projections(
                source,
                candidate,
                job_ids=JobIdMap({}),
                migration_at=_MIGRATION_AT,
            )

        job_ids = _hydrate(source, candidate)
        result = rebuild_job_list_projections(
            source,
            candidate,
            job_ids=job_ids,
            migration_at=_MIGRATION_AT,
        )

        assert result.rebuilt_job_list_projections == 1
        row = candidate.execute(
            """
            SELECT job_id, title, artifact_count, apply_status, applied_at,
                   apply_mode, last_updated_at
            FROM job_list_projections
            """
        ).fetchone()
        assert row == (
            _JOB_ID,
            "Canonical v6 role",
            1,
            "applied",
            "2026-07-30T10:01:00+00:00",
            "automated_live",
            _MIGRATION_AT,
        )
        assert "STALE URL CACHE" not in str(row)
        assert tuple(source.execute("SELECT * FROM job_list_projections").fetchall()) == source_cache
        assert source_path.read_bytes() == source_bytes
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
        assert candidate.execute(
            "SELECT metadata_json FROM job_materials"
        ).fetchone() == (_INERT_CONTEXT_JSON,)
        with pytest.raises(CandidateJobListProjectionsError, match="must be empty"):
            rebuild_job_list_projections(
                source,
                candidate,
                job_ids=job_ids,
                migration_at=_MIGRATION_AT,
            )

        candidate.commit()
        candidate.close()
        candidate = sqlite3.connect(candidate_path)
        candidate.execute("PRAGMA foreign_keys = ON")
        assert candidate.execute("SELECT job_id FROM job_list_projections").fetchone() == (
            _JOB_ID,
        )
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


def test_post_insert_failure_rolls_back_then_retries(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, candidate, _source_path, _candidate_path = _databases(tmp_path)
    try:
        _seed_source(source)
        job_ids = _hydrate(source, candidate)
        original_verify = migration._verify_candidate

        def fail_after_insert(**_: object) -> None:
            raise CandidateJobListProjectionsError("injected verification failure")

        monkeypatch.setattr(migration, "_verify_candidate", fail_after_insert)
        with pytest.raises(
            CandidateJobListProjectionsError,
            match="injected verification failure",
        ):
            rebuild_job_list_projections(
                source,
                candidate,
                job_ids=job_ids,
                migration_at=_MIGRATION_AT,
            )
        assert candidate.execute("SELECT COUNT(*) FROM job_list_projections").fetchone() == (0,)

        monkeypatch.setattr(migration, "_verify_candidate", original_verify)
        result = rebuild_job_list_projections(
            source,
            candidate,
            job_ids=job_ids,
            migration_at=_MIGRATION_AT,
        )
        assert result.rebuilt_job_list_projections == 1
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


def test_canonical_input_mutation_rolls_back_the_projection_write(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, candidate, _source_path, _candidate_path = _databases(tmp_path)
    try:
        _seed_source(source)
        job_ids = _hydrate(source, candidate)
        original_insert = migration._insert_rows
        before_jobs = tuple(candidate.execute("SELECT * FROM jobs").fetchall())

        def mutate_after_insert(
            destination: sqlite3.Connection,
            rows: tuple[tuple[object, ...], ...],
        ) -> None:
            original_insert(destination, rows)
            destination.execute("UPDATE jobs SET title = 'mutated candidate input'")

        monkeypatch.setattr(migration, "_insert_rows", mutate_after_insert)
        with pytest.raises(
            CandidateJobListProjectionsError,
            match="mutated canonical job-list inputs",
        ):
            rebuild_job_list_projections(
                source,
                candidate,
                job_ids=job_ids,
                migration_at=_MIGRATION_AT,
            )
        assert candidate.execute("SELECT COUNT(*) FROM job_list_projections").fetchone() == (0,)
        assert tuple(candidate.execute("SELECT * FROM jobs").fetchall()) == before_jobs
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize(
    ("table", "mutation"),
    (
        ("apply_run_projections", "DELETE FROM apply_run_projections"),
        (
            "apply_run_projections",
            "UPDATE apply_run_projections SET status = 'failed'",
        ),
        ("artifact_list_projections", "DELETE FROM artifact_list_projections"),
        (
            "artifact_list_projections",
            "UPDATE artifact_list_projections SET job_title = 'stale title'",
        ),
    ),
)
def test_rebuild_rejects_incomplete_or_stale_upstream_projections(
    tmp_path: Path,
    table: str,
    mutation: str,
) -> None:
    source, candidate, _, _ = _databases(tmp_path)
    try:
        _seed_source(source)
        job_ids = _hydrate(source, candidate)
        candidate.execute(mutation)

        with pytest.raises(
            CandidateJobListProjectionsError,
            match=f"candidate {table} must match the canonical",
        ):
            rebuild_job_list_projections(
                source,
                candidate,
                job_ids=job_ids,
                migration_at=_MIGRATION_AT,
            )

        assert candidate.execute(
            "SELECT COUNT(*) FROM job_list_projections"
        ).fetchone() == (0,)
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()
