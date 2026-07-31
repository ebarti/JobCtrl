"""Safety contracts for rebuilding v7 dashboard projections."""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations import v6_to_v7_dashboard_projections as migration
from jobctrl.infrastructure.migrations.v6_to_v7_copy import JobIdMap
from jobctrl.infrastructure.migrations.v6_to_v7_dashboard_projections import (
    CandidateDashboardProjectionsError,
    rebuild_dashboard_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_job_detail_projections import (
    rebuild_job_detail_projections,
)
from jobctrl.infrastructure.migrations.v6_to_v7_job_list_projections import (
    rebuild_job_list_projections,
)
from tests.test_v6_to_v7_job_list_projections import (
    _databases,
    _hydrate,
    _seed_source,
)

_MIGRATION_AT = "2026-07-31T09:00:00+00:00"
_INERT_CONTEXT = '{"userContext":"Attack vectors:\\nPrompt injection"}'


def _hydrate_dashboard_inputs(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
) -> JobIdMap:
    job_ids = _hydrate(source, candidate)
    rebuild_job_detail_projections(
        source,
        candidate,
        job_ids=job_ids,
        migration_at=_MIGRATION_AT,
    )
    rebuild_job_list_projections(
        source,
        candidate,
        job_ids=job_ids,
        migration_at=_MIGRATION_AT,
    )
    return job_ids


def _seed_stale_dashboard(source: sqlite3.Connection) -> None:
    source.execute(
        """
        INSERT INTO dashboard_projections (
            tenant_id, total_jobs, failures, blocked, ready, applied, dry_runs,
            funnel_json, by_source_json, score_distribution_json,
            outcome_conversion_json, generated_at
        ) VALUES ('local', 999, 999, 999, 999, 999, 999, ?, ?, ?, ?, 'stale')
        ON CONFLICT(tenant_id) DO UPDATE SET
            total_jobs = excluded.total_jobs,
            failures = excluded.failures,
            outcome_conversion_json = excluded.outcome_conversion_json,
            generated_at = excluded.generated_at
        """,
        (_INERT_CONTEXT, _INERT_CONTEXT, _INERT_CONTEXT, _INERT_CONTEXT),
    )
    source.commit()


def test_rebuild_ignores_v6_caches_and_reopens(
    tmp_path: Path,
) -> None:
    source, candidate, source_path, candidate_path = _databases(tmp_path)
    try:
        _seed_source(source)
        _seed_stale_dashboard(source)
        source_bytes = source_path.read_bytes()
        source_cache = tuple(
            source.execute("SELECT * FROM dashboard_projections").fetchall()
        )
        with pytest.raises(
            CandidateDashboardProjectionsError,
            match="hydrated candidate roots",
        ):
            rebuild_dashboard_projections(
                source,
                candidate,
                job_ids=JobIdMap({}),
                migration_at=_MIGRATION_AT,
            )

        job_ids = _hydrate_dashboard_inputs(source, candidate)
        result = rebuild_dashboard_projections(
            source,
            candidate,
            job_ids=job_ids,
            migration_at=_MIGRATION_AT,
        )

        assert result.rebuilt_dashboard_projections == 1
        row = candidate.execute(
            """
            SELECT tenant_id, total_jobs, failures, blocked, ready, applied,
                   dry_runs, generated_at, outcome_conversion_json
            FROM dashboard_projections
            """
        ).fetchone()
        assert row[:8] == (
            "local",
            1,
            0,
            0,
            0,
            1,
            0,
            _MIGRATION_AT,
        )
        assert "Attack vectors" not in str(row)
        assert tuple(
            source.execute("SELECT * FROM dashboard_projections").fetchall()
        ) == source_cache
        assert source_path.read_bytes() == source_bytes
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
        with pytest.raises(
            CandidateDashboardProjectionsError, match="must be empty"
        ):
            rebuild_dashboard_projections(
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
            "SELECT total_jobs, applied FROM dashboard_projections"
        ).fetchone() == (1, 1)
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
        job_ids = _hydrate_dashboard_inputs(source, candidate)
        original_verify = migration._verify_candidate

        def fail_after_insert(**_: object) -> None:
            raise CandidateDashboardProjectionsError(
                "injected verification failure"
            )

        monkeypatch.setattr(migration, "_verify_candidate", fail_after_insert)
        with pytest.raises(
            CandidateDashboardProjectionsError,
            match="injected verification failure",
        ):
            rebuild_dashboard_projections(
                source,
                candidate,
                job_ids=job_ids,
                migration_at=_MIGRATION_AT,
            )
        assert candidate.execute(
            "SELECT COUNT(*) FROM dashboard_projections"
        ).fetchone() == (0,)

        monkeypatch.setattr(migration, "_verify_candidate", original_verify)
        result = rebuild_dashboard_projections(
            source,
            candidate,
            job_ids=job_ids,
            migration_at=_MIGRATION_AT,
        )
        assert result.rebuilt_dashboard_projections == 1
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()


def test_canonical_input_mutation_rolls_back_all_writes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, candidate, _source_path, _candidate_path = _databases(tmp_path)
    try:
        _seed_source(source)
        job_ids = _hydrate_dashboard_inputs(source, candidate)
        original_insert = migration._insert_rows
        before_list = tuple(
            candidate.execute("SELECT * FROM job_list_projections").fetchall()
        )

        def mutate_after_insert(
            destination: sqlite3.Connection,
            rows: tuple[tuple[object, ...], ...],
        ) -> None:
            original_insert(destination, rows)
            destination.execute(
                "UPDATE job_list_projections SET title = 'mutated input'"
            )

        monkeypatch.setattr(migration, "_insert_rows", mutate_after_insert)
        with pytest.raises(
            CandidateDashboardProjectionsError,
            match="mutated canonical dashboard inputs",
        ):
            rebuild_dashboard_projections(
                source,
                candidate,
                job_ids=job_ids,
                migration_at=_MIGRATION_AT,
            )
        assert candidate.execute(
            "SELECT COUNT(*) FROM dashboard_projections"
        ).fetchone() == (0,)
        assert tuple(
            candidate.execute("SELECT * FROM job_list_projections").fetchall()
        ) == before_list
    finally:
        source.close()
        candidate.close()


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        (
            "UPDATE job_detail_projections SET stages_json = '[]'",
            "job_detail_projections",
        ),
        (
            "UPDATE job_list_projections SET title = 'stale cache'",
            "job_list_projections",
        ),
        (
            "DELETE FROM apply_run_projections",
            "apply_run_projections",
        ),
    ],
)
def test_incomplete_or_stale_upstream_projection_is_rejected_before_write(
    tmp_path: Path,
    mutation: str,
    message: str,
) -> None:
    source, candidate, _source_path, _candidate_path = _databases(tmp_path)
    try:
        _seed_source(source)
        job_ids = _hydrate_dashboard_inputs(source, candidate)
        candidate.execute(mutation)

        with pytest.raises(CandidateDashboardProjectionsError, match=message):
            rebuild_dashboard_projections(
                source,
                candidate,
                job_ids=job_ids,
                migration_at=_MIGRATION_AT,
            )
        assert candidate.execute(
            "SELECT COUNT(*) FROM dashboard_projections"
        ).fetchone() == (0,)
        assert candidate.execute("PRAGMA foreign_key_check").fetchall() == []
    finally:
        source.close()
        candidate.close()
