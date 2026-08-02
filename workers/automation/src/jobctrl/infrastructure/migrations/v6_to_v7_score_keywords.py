"""Populate the exact-v7 normalized keyword relation from migrated scores."""

from __future__ import annotations

import json
import sqlite3
import unicodedata
from dataclasses import dataclass
from typing import Final

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.v6_to_v7_copy import (
    CandidateCopyError,
    JobIdMap,
    build_job_id_map,
)
from jobctrl.infrastructure.migrations.v6_to_v7_preflight import (
    assert_v6_migration_preflight,
)


_SAVEPOINT: Final = "v6_score_keyword_copy"


class CandidateScoreKeywordError(RuntimeError):
    """Raised when score keyword migration cannot preserve the score contract."""


@dataclass(frozen=True)
class ScoreKeywordPopulationResult:
    """Metadata-only receipt for the one score-keyword population owner."""

    migrated_score_versions: int
    copied_keywords: int


def copy_score_keywords(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: JobIdMap,
) -> ScoreKeywordPopulationResult:
    """Populate normalized keywords after ``job_scores`` receives stable JobIds.

    Each v6 JSON string array is normalized with NFKC, whitespace collapse,
    and casefold lookup. Blank values are dropped; duplicate lookup keys retain
    the first normalized display text and receive contiguous positions.
    """
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_empty(candidate)
    _assert_job_id_map(source, candidate, job_ids)

    source_rows = source.execute(
        """
        SELECT job_url, tenant_id, version, keywords_json
        FROM job_scores
        ORDER BY tenant_id, job_url, version
        """
    ).fetchall()
    target_score_ids = _target_score_ids(candidate)
    keyword_rows: list[tuple[str, str, int, str, str, int]] = []
    migrated_score_ids: set[tuple[str, str, int]] = set()

    candidate.execute(f"SAVEPOINT {_SAVEPOINT}")
    try:
        for source_row in source_rows:
            tenant_id, job_id, score_version, keywords_json = _source_score_row(
                source_row,
                job_ids,
            )
            score_id = (tenant_id, job_id, score_version)
            if score_id in migrated_score_ids:
                raise CandidateScoreKeywordError(
                    "source score identities are not unique"
                )
            migrated_score_ids.add(score_id)
            for normalized, display, position in _normalized_keywords(keywords_json):
                keyword_rows.append(
                    (
                        tenant_id,
                        job_id,
                        score_version,
                        normalized,
                        display,
                        position,
                    )
                )

        if migrated_score_ids != target_score_ids:
            raise CandidateScoreKeywordError(
                "migrated score identities do not match the candidate"
            )
        if keyword_rows:
            candidate.executemany(
                """
                INSERT INTO job_score_keywords (
                    tenant_id, job_id, score_version, normalized_keyword,
                    display_keyword, position
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                keyword_rows,
            )
        _assert_populated(candidate, keyword_rows)
        candidate.execute(f"RELEASE SAVEPOINT {_SAVEPOINT}")
    except BaseException:
        candidate.execute(f"ROLLBACK TO SAVEPOINT {_SAVEPOINT}")
        candidate.execute(f"RELEASE SAVEPOINT {_SAVEPOINT}")
        raise

    return ScoreKeywordPopulationResult(
        migrated_score_versions=len(migrated_score_ids),
        copied_keywords=len(keyword_rows),
    )


def _assert_empty(candidate: sqlite3.Connection) -> None:
    if _table_count(candidate, "job_score_keywords"):
        raise CandidateScoreKeywordError(
            "candidate score keyword table must be empty"
        )


def _assert_job_id_map(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    job_ids: JobIdMap,
) -> None:
    try:
        expected = build_job_id_map(source, candidate)
    except CandidateCopyError:
        raise CandidateScoreKeywordError(
            "candidate JobId mapping is invalid for score keywords"
        ) from None
    if job_ids != expected:
        raise CandidateScoreKeywordError(
            "score keyword population received a mismatched JobId map"
        )


def _source_score_row(
    row: tuple[object, ...],
    job_ids: JobIdMap,
) -> tuple[str, str, int, object]:
    locator, tenant, version, keywords_json = row
    tenant_id = str(tenant or "").strip()
    if not tenant_id:
        raise CandidateScoreKeywordError("source score has an empty tenant")
    if isinstance(version, bool) or not isinstance(version, int) or version <= 0:
        raise CandidateScoreKeywordError("source score has an invalid version")
    try:
        job_id = job_ids.resolve(tenant_id=tenant_id, locator=locator)
    except CandidateCopyError:
        raise CandidateScoreKeywordError(
            "source score cannot resolve to a canonical JobId"
        ) from None
    if job_id is None:
        raise CandidateScoreKeywordError(
            "source score cannot resolve to a canonical JobId"
        )
    return tenant_id, job_id, version, keywords_json


def _normalized_keywords(keywords_json: object) -> tuple[tuple[str, str, int], ...]:
    if not isinstance(keywords_json, str):
        raise CandidateScoreKeywordError("source score keywords must be JSON text")
    try:
        values = json.loads(keywords_json)
    except json.JSONDecodeError:
        raise CandidateScoreKeywordError(
            "source score keywords are not valid JSON"
        ) from None
    if not isinstance(values, list) or any(
        not isinstance(value, str) for value in values
    ):
        raise CandidateScoreKeywordError(
            "source score keywords must be a JSON string array"
        )

    normalized: list[tuple[str, str, int]] = []
    seen: set[str] = set()
    for value in values:
        display = " ".join(unicodedata.normalize("NFKC", value).split())
        if not display:
            continue
        lookup = display.casefold()
        if lookup in seen:
            continue
        seen.add(lookup)
        normalized.append((lookup, display, len(normalized)))
    return tuple(normalized)


def _target_score_ids(candidate: sqlite3.Connection) -> set[tuple[str, str, int]]:
    return {
        (str(tenant), str(job_id), int(version))
        for tenant, job_id, version in candidate.execute(
            """
            SELECT tenant_id, job_id, version
            FROM job_scores
            ORDER BY tenant_id, job_id, version
            """
        ).fetchall()
    }


def _assert_populated(
    candidate: sqlite3.Connection,
    expected_rows: list[tuple[str, str, int, str, str, int]],
) -> None:
    rows = [
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
    expected = sorted(
        expected_rows,
        key=lambda row: (row[0], row[1], row[2], row[5]),
    )
    if rows != expected:
        raise CandidateScoreKeywordError(
            "candidate score keywords differ from normalized source values"
        )
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateScoreKeywordError(
            "candidate score keywords have foreign-key violations"
        )


def _table_count(candidate: sqlite3.Connection, table: str) -> int:
    return int(candidate.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])


__all__ = [
    "CandidateScoreKeywordError",
    "ScoreKeywordPopulationResult",
    "copy_score_keywords",
]
