"""Focused contracts for the stopped-runtime score-keyword migration owner."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import schema_dump
from jobctrl.infrastructure.migrations.v6_to_v7_candidate import (
    candidate_logical_digest,
    populate_v7_candidate,
)
from jobctrl.infrastructure.migrations.v6_to_v7_score_keywords import (
    CandidateScoreKeywordError,
)
from jobctrl.infrastructure.migrations.v6_to_v7_verify import (
    verify_and_stamp_v7_candidate,
    verify_v7_candidate,
)
from tests.v6_migration_fixture import create_shipped_v6_database


_MIGRATION_AT = "2026-08-01T12:00:00+00:00"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
_SOURCE_URL = "https://jobs.example/shipped-v6"


def _allocator(*values: str) -> Callable[[], str]:
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


def _connections(
    tmp_path: Path,
    *,
    name: str,
) -> tuple[sqlite3.Connection, sqlite3.Connection, Path]:
    source_path = tmp_path / f"{name}-source.db"
    candidate_path = tmp_path / f"{name}-candidate.db"
    create_shipped_v6_database(source_path)
    source = sqlite3.connect(source_path)
    candidate = sqlite3.connect(candidate_path)
    source.execute("PRAGMA foreign_keys = ON")
    candidate.execute("PRAGMA foreign_keys = ON")
    return source, candidate, candidate_path


def _insert_scores(source: sqlite3.Connection) -> None:
    source.executemany(
        """
        INSERT INTO job_scores (
            job_url, version, tenant_id, fit_score, breakdown_json,
            keywords_json, scored_at
        ) VALUES (?, ?, 'local', 8, '{}', ?, ?)
        """,
        (
            (
                _SOURCE_URL,
                1,
                json.dumps(
                    [
                        "  Python  ",
                        "\u3000Ｐｙｔｈｏｎ\t",
                        "Data   Science",
                        " data science ",
                        "\u00a0",
                        "\t",
                        "Straße",
                        "STRASSE",
                    ]
                ),
                _MIGRATION_AT,
            ),
            (
                _SOURCE_URL,
                2,
                json.dumps(["Cloud\tInfrastructure", "   "]),
                _MIGRATION_AT,
            ),
        ),
    )
    source.commit()


def _keyword_rows(candidate: sqlite3.Connection) -> list[tuple[object, ...]]:
    return [
        tuple(row)
        for row in candidate.execute(
            """
            SELECT tenant_id, job_id, score_version, normalized_keyword,
                   display_keyword, position
            FROM job_score_keywords
            ORDER BY tenant_id, job_id, score_version, position
            """
        ).fetchall()
    ]


def _raw_candidate_dump(candidate: sqlite3.Connection) -> tuple[object, ...]:
    return (
        schema_dump(candidate),
        tuple(candidate.iterdump()),
        candidate.execute("PRAGMA user_version").fetchone(),
    )


def test_score_keyword_population_normalizes_each_version_and_reopens(
    tmp_path: Path,
) -> None:
    source, candidate, candidate_path = _connections(tmp_path, name="normalize")
    try:
        _insert_scores(source)

        population = populate_v7_candidate(
            source,
            candidate,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(_JOB_ID),
        )

        assert _keyword_rows(candidate) == [
            ("local", _JOB_ID, 1, "python", "Python", 0),
            ("local", _JOB_ID, 1, "data science", "Data Science", 1),
            ("local", _JOB_ID, 1, "strasse", "Straße", 2),
            (
                "local",
                _JOB_ID,
                2,
                "cloud infrastructure",
                "Cloud Infrastructure",
                0,
            ),
        ]
        assert dict(population.table_row_counts)["job_score_keywords"] == 4
        assert verify_v7_candidate(source, candidate, population).table_row_counts == (
            population.table_row_counts
        )
        assert verify_and_stamp_v7_candidate(
            source,
            candidate,
            population,
        ).user_version == 7
        candidate.commit()
        candidate.close()
        candidate = sqlite3.connect(candidate_path)

        assert candidate.execute("PRAGMA user_version").fetchone() == (7,)
        assert _keyword_rows(candidate)[-1] == (
            "local",
            _JOB_ID,
            2,
            "cloud infrastructure",
            "Cloud Infrastructure",
            0,
        )
    finally:
        source.close()
        candidate.close()


def test_score_keyword_step_rolls_back_and_retries_with_the_same_digest(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path, name="retry")
    reference_source, reference, _ = _connections(tmp_path, name="reference")
    try:
        _insert_scores(source)
        _insert_scores(reference_source)
        before = _raw_candidate_dump(candidate)

        def fail_after_score_keywords(step_id: str) -> None:
            if step_id == "score_keywords":
                raise RuntimeError("forced score keyword failure")

        with pytest.raises(RuntimeError, match="forced score keyword failure"):
            populate_v7_candidate(
                source,
                candidate,
                migration_at=_MIGRATION_AT,
                job_id_factory=_allocator(_JOB_ID),
                _after_step=fail_after_score_keywords,
            )
        assert _raw_candidate_dump(candidate) == before

        retried = populate_v7_candidate(
            source,
            candidate,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(_JOB_ID),
        )
        expected = populate_v7_candidate(
            reference_source,
            reference,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(_JOB_ID),
        )

        assert retried == expected
        assert candidate_logical_digest(candidate) == expected.candidate_digest
        assert _keyword_rows(candidate) == _keyword_rows(reference)
    finally:
        source.close()
        candidate.close()
        reference_source.close()
        reference.close()


def test_score_keyword_population_rejects_malformed_json_without_leaving_rows(
    tmp_path: Path,
) -> None:
    source, candidate, _ = _connections(tmp_path, name="malformed")
    try:
        source.execute(
            """
            INSERT INTO job_scores (
                job_url, version, tenant_id, fit_score, breakdown_json,
                keywords_json, scored_at
            ) VALUES (?, 1, 'local', 8, '{}', '{', ?)
            """,
            (_SOURCE_URL, _MIGRATION_AT),
        )
        source.commit()
        before = _raw_candidate_dump(candidate)

        with pytest.raises(CandidateScoreKeywordError):
            populate_v7_candidate(
                source,
                candidate,
                migration_at=_MIGRATION_AT,
                job_id_factory=_allocator(_JOB_ID),
            )
        assert _raw_candidate_dump(candidate) == before
    finally:
        source.close()
        candidate.close()
