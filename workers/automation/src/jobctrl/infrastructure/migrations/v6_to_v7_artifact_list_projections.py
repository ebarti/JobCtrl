"""Rebuild v7 artifact-list projections from copied canonical artifacts."""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Mapping
from dataclasses import dataclass

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

_TABLE = "artifact_list_projections"
_COLUMNS = (
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
_CANONICAL_TABLES = (
    "jobs",
    "job_locators",
    "job_materials",
    "job_materials_artifacts",
    "job_artifacts",
    "job_material_layout_boxes",
    "job_bullet_provenance",
)


class CandidateArtifactListProjectionsError(RuntimeError):
    """Raised when v7 artifact projections cannot be rebuilt safely."""


@dataclass(frozen=True)
class CandidateArtifactListProjectionsResult:
    """Verified candidate artifact-projection rebuild result."""

    rebuilt_artifact_list_projections: int


@dataclass(frozen=True)
class _JobMetadata:
    title: str
    employer: str


@dataclass(frozen=True)
class _Artifact:
    artifact_id: str
    tenant_id: str
    job_id: str
    artifact_type: str
    status: str
    path: str
    size_bytes: int | None
    created_at: str
    generation: int | None
    metadata_json: str | None


def rebuild_artifact_list_projections(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    *,
    job_ids: JobIdMap,
) -> CandidateArtifactListProjectionsResult:
    """Rebuild artifact projections from already-copied candidate rows.

    The v6 ``artifact_list_projections`` table is a stale URL-keyed cache and is
    intentionally never read. Material artifacts win a per-job
    ``(artifact_type, path)`` collision over generic ``job_artifacts`` rows; no
    PDF siblings or other artifact rows are invented during this rebuild.
    """
    assert_v6_migration_preflight(source)
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)
    _assert_columns(candidate, _TABLE, _COLUMNS)
    _assert_authoritative_roots(source, candidate, job_ids)
    _assert_empty_target(candidate)

    canonical_snapshot = _canonical_snapshot(candidate)
    jobs = _candidate_job_metadata(candidate)
    layout_by_artifact, provenance_by_artifact = _candidate_audits(candidate)
    artifacts = _candidate_artifacts(candidate, jobs)
    projections = _project_artifacts(
        artifacts,
        jobs,
        layout_by_artifact,
        provenance_by_artifact,
    )

    candidate.execute("SAVEPOINT v6_artifact_list_projection_rebuild")
    try:
        _insert_rows(candidate, projections)
        _verify_candidate(
            candidate=candidate,
            expected_rows=projections,
            canonical_snapshot=canonical_snapshot,
        )
        candidate.execute("RELEASE SAVEPOINT v6_artifact_list_projection_rebuild")
    except BaseException:
        candidate.execute("ROLLBACK TO SAVEPOINT v6_artifact_list_projection_rebuild")
        candidate.execute("RELEASE SAVEPOINT v6_artifact_list_projection_rebuild")
        raise

    return CandidateArtifactListProjectionsResult(
        rebuilt_artifact_list_projections=len(projections)
    )


def _assert_authoritative_roots(
    source: sqlite3.Connection,
    candidate: sqlite3.Connection,
    job_ids: JobIdMap,
) -> None:
    try:
        candidate_job_ids = build_job_id_map(source, candidate)
    except CandidateCopyError as error:
        raise CandidateArtifactListProjectionsError(
            "artifact projection rebuild requires hydrated candidate roots"
        ) from error
    if dict(candidate_job_ids.by_locator) != dict(job_ids.by_locator):
        raise CandidateArtifactListProjectionsError(
            "supplied JobIdMap does not match hydrated candidate roots"
        )

    current_locators = {
        (str(tenant_id), str(locator)): str(job_id)
        for tenant_id, locator, job_id in candidate.execute(
            """
            SELECT tenant_id, locator_value, job_id
            FROM job_locators
            WHERE locator_kind = 'posting_url'
              AND is_current = 1
              AND retired_at IS NULL
            """
        ).fetchall()
    }
    if (
        current_locators != dict(job_ids.by_locator)
        or _row_count(candidate, "job_locators") != len(current_locators)
    ):
        raise CandidateArtifactListProjectionsError(
            "artifact projection rebuild requires hydrated candidate root locators"
        )


def _assert_empty_target(candidate: sqlite3.Connection) -> None:
    if _row_count(candidate, _TABLE):
        raise CandidateArtifactListProjectionsError(
            "candidate artifact_list_projections must be empty"
        )


def _candidate_job_metadata(
    candidate: sqlite3.Connection,
) -> dict[tuple[str, str], _JobMetadata]:
    result: dict[tuple[str, str], _JobMetadata] = {}
    for tenant_id, job_id, title, company in candidate.execute(
        "SELECT tenant_id, job_id, title, company FROM jobs ORDER BY tenant_id, job_id"
    ).fetchall():
        tenant = _required_text(tenant_id, "candidate job tenant_id")
        stable_job_id = _required_text(job_id, "candidate job job_id")
        key = (tenant, stable_job_id)
        if key in result:
            raise CandidateArtifactListProjectionsError(
                "candidate jobs contains duplicate stable identity"
            )
        result[key] = _JobMetadata(
            title=title if isinstance(title, str) else "",
            employer=(
                company
                if isinstance(company, str) and company.strip()
                else "Unknown company"
            ),
        )
    return result


def _candidate_artifacts(
    candidate: sqlite3.Connection,
    jobs: Mapping[tuple[str, str], _JobMetadata],
) -> tuple[_Artifact, ...]:
    emitted: list[_Artifact] = []
    seen_paths: set[tuple[str, str, str, str]] = set()

    for row in candidate.execute(
        """
        SELECT a.tenant_id, a.job_id, a.generation, a.artifact_type,
               a.artifact_id, a.status, a.path, a.size_bytes, a.metadata_json,
               a.created_at
        FROM job_materials_artifacts AS a
        JOIN job_materials AS m
          ON m.tenant_id = a.tenant_id
         AND m.job_id = a.job_id
         AND m.generation = a.generation
        ORDER BY a.tenant_id, a.job_id, a.generation, a.artifact_type, a.artifact_id
        """
    ).fetchall():
        artifact = _material_artifact(row, jobs)
        if artifact is None:
            continue
        key = (
            artifact.tenant_id,
            artifact.job_id,
            artifact.artifact_type,
            artifact.path,
        )
        if key in seen_paths:
            continue
        seen_paths.add(key)
        emitted.append(artifact)

    for row in candidate.execute(
        """
        SELECT artifact_id, tenant_id, job_id, artifact_type, status, path,
               size_bytes, created_at
        FROM job_artifacts
        ORDER BY tenant_id, job_id, artifact_type, path, stage, artifact_id
        """
    ).fetchall():
        artifact = _generic_artifact(row, jobs)
        if artifact is None:
            continue
        key = (
            artifact.tenant_id,
            artifact.job_id,
            artifact.artifact_type,
            artifact.path,
        )
        if key in seen_paths:
            continue
        seen_paths.add(key)
        emitted.append(artifact)

    _assert_unique_artifact_ids(emitted)
    return tuple(emitted)


def _material_artifact(
    row: tuple[object, ...],
    jobs: Mapping[tuple[str, str], _JobMetadata],
) -> _Artifact | None:
    (
        tenant_id,
        job_id,
        generation,
        artifact_type,
        artifact_id,
        status,
        path,
        size_bytes,
        metadata_json,
        created_at,
    ) = row
    parsed_path = _path_or_none(path)
    if parsed_path is None:
        return None
    tenant, stable_job_id = _root(tenant_id, job_id, jobs)
    return _Artifact(
        artifact_id=_required_text(artifact_id, "material artifact_id"),
        tenant_id=tenant,
        job_id=stable_job_id,
        artifact_type=_required_text(artifact_type, "material artifact_type"),
        status=_required_text(status, "material status"),
        path=parsed_path,
        size_bytes=_optional_nonnegative_integer(size_bytes, "material size_bytes"),
        created_at=_required_text(created_at, "material created_at"),
        generation=_positive_integer(generation, "material generation"),
        metadata_json=_opaque_json(metadata_json, "material metadata_json"),
    )


def _generic_artifact(
    row: tuple[object, ...],
    jobs: Mapping[tuple[str, str], _JobMetadata],
) -> _Artifact | None:
    (
        artifact_id,
        tenant_id,
        job_id,
        artifact_type,
        status,
        path,
        size_bytes,
        created_at,
    ) = row
    parsed_path = _path_or_none(path)
    if parsed_path is None:
        return None
    tenant, stable_job_id = _root(tenant_id, job_id, jobs)
    if isinstance(artifact_id, bool) or not isinstance(artifact_id, int) or artifact_id < 1:
        raise CandidateArtifactListProjectionsError(
            "generic artifact_id must be a positive integer"
        )
    return _Artifact(
        artifact_id=str(artifact_id),
        tenant_id=tenant,
        job_id=stable_job_id,
        artifact_type=_required_text(artifact_type, "generic artifact_type"),
        status=_required_text(status, "generic status"),
        path=parsed_path,
        size_bytes=_optional_nonnegative_integer(size_bytes, "generic size_bytes"),
        created_at=_required_text(created_at, "generic created_at"),
        generation=None,
        metadata_json=None,
    )


def _candidate_audits(
    candidate: sqlite3.Connection,
) -> tuple[
    dict[tuple[str, str, str], str],
    dict[tuple[str, str, str], tuple[str, str | None, str | None]],
]:
    layout_rows: dict[tuple[str, str, str], list[dict[str, object]]] = {}
    for row in candidate.execute(
        """
        SELECT tenant_id, job_id, artifact_id, semantic_id, page_number,
               line_number, text_excerpt, left_pct, top_pct, width_pct, height_pct
        FROM job_material_layout_boxes
        ORDER BY tenant_id, job_id, artifact_id, page_number, box_index
        """
    ).fetchall():
        (
            tenant_id,
            job_id,
            artifact_id,
            semantic_id,
            page_number,
            line_number,
            text_excerpt,
            left_pct,
            top_pct,
            width_pct,
            height_pct,
        ) = row
        key = _audit_key(tenant_id, job_id, artifact_id, "layout box")
        layout_rows.setdefault(key, []).append(
            {
                "semanticId": _required_text(semantic_id, "layout semantic_id"),
                "pageNumber": _positive_integer(page_number, "layout page_number"),
                "lineNumber": _optional_nonnegative_integer(
                    line_number, "layout line_number"
                ),
                "textExcerpt": _required_text(text_excerpt, "layout text_excerpt"),
                "leftPct": _number(left_pct, "layout left_pct"),
                "topPct": _number(top_pct, "layout top_pct"),
                "widthPct": _number(width_pct, "layout width_pct"),
                "heightPct": _number(height_pct, "layout height_pct"),
            }
        )

    provenance_rows: dict[tuple[str, str, str], list[dict[str, object]]] = {}
    coverage_by_artifact: dict[tuple[str, str, str], str] = {}
    voice_by_artifact: dict[tuple[str, str, str], str] = {}
    for row in candidate.execute(
        """
        SELECT tenant_id, job_id, artifact_id, bullet_id, section, source_id,
               evidence_ids_json, requirement_ids_json, matched_keywords_json,
               transform_type, control, rationale, generated_text, coverage_json,
               voice_json
        FROM job_bullet_provenance
        ORDER BY tenant_id, job_id, artifact_id, generation, position, bullet_id
        """
    ).fetchall():
        (
            tenant_id,
            job_id,
            artifact_id,
            bullet_id,
            section,
            source_id,
            evidence_ids_json,
            requirement_ids_json,
            matched_keywords_json,
            transform_type,
            control,
            rationale,
            generated_text,
            coverage_json,
            voice_json,
        ) = row
        key = _audit_key(tenant_id, job_id, artifact_id, "bullet provenance")
        provenance_rows.setdefault(key, []).append(
            {
                "bullet_id": _required_text(bullet_id, "provenance bullet_id"),
                "section": _required_text(section, "provenance section"),
                "source_id": _optional_text(source_id, "provenance source_id"),
                "evidence_ids": _json_text_array(
                    evidence_ids_json, "provenance evidence_ids_json"
                ),
                "requirement_ids": _json_text_array(
                    requirement_ids_json, "provenance requirement_ids_json"
                ),
                "matched_keywords": _json_text_array(
                    matched_keywords_json, "provenance matched_keywords_json"
                ),
                "transform_type": _required_text(
                    transform_type, "provenance transform_type"
                ),
                "control": _required_text(control, "provenance control"),
                "rationale": _text_or_empty(rationale, "provenance rationale"),
                "generated_text": _required_text(
                    generated_text, "provenance generated_text"
                ),
            }
        )
        _record_first_nonblank_json(
            coverage_by_artifact, key, coverage_json, "provenance coverage_json"
        )
        _record_first_nonblank_json(
            voice_by_artifact, key, voice_json, "provenance voice_json"
        )

    layouts = {
        key: json.dumps(boxes, sort_keys=True) for key, boxes in layout_rows.items()
    }
    provenance = {
        key: (
            json.dumps(rows),
            coverage_by_artifact.get(key),
            voice_by_artifact.get(key),
        )
        for key, rows in provenance_rows.items()
    }
    return layouts, provenance


def _project_artifacts(
    artifacts: tuple[_Artifact, ...],
    jobs: Mapping[tuple[str, str], _JobMetadata],
    layout_by_artifact: Mapping[tuple[str, str, str], str],
    provenance_by_artifact: Mapping[
        tuple[str, str, str], tuple[str, str | None, str | None]
    ],
) -> tuple[tuple[object, ...], ...]:
    emitted = {
        (artifact.tenant_id, artifact.job_id, artifact.artifact_id) for artifact in artifacts
    }
    audit_keys = set(layout_by_artifact) | set(provenance_by_artifact)
    if not audit_keys.issubset(emitted):
        raise CandidateArtifactListProjectionsError(
            "candidate artifact audit rows must reference an emitted artifact root"
        )

    rows: list[tuple[object, ...]] = []
    for artifact in artifacts:
        key = (artifact.tenant_id, artifact.job_id, artifact.artifact_id)
        metadata = jobs[(artifact.tenant_id, artifact.job_id)]
        provenance, coverage, voice = provenance_by_artifact.get(
            key, (None, None, None)
        )
        rows.append(
            (
                artifact.artifact_id,
                artifact.tenant_id,
                artifact.job_id,
                metadata.title,
                metadata.employer,
                artifact.artifact_type,
                artifact.status,
                artifact.path,
                artifact.size_bytes,
                artifact.created_at,
                artifact.generation,
                artifact.metadata_json,
                layout_by_artifact.get(key),
                provenance,
                coverage,
                voice,
            )
        )
    return tuple(rows)


def _assert_unique_artifact_ids(artifacts: list[_Artifact]) -> None:
    seen: set[str] = set()
    for artifact in artifacts:
        if artifact.artifact_id in seen:
            raise CandidateArtifactListProjectionsError(
                "emitted artifact IDs must be globally unique"
            )
        seen.add(artifact.artifact_id)


def _insert_rows(
    candidate: sqlite3.Connection,
    rows: tuple[tuple[object, ...], ...],
) -> None:
    if not rows:
        return
    placeholders = ", ".join("?" for _ in _COLUMNS)
    candidate.executemany(
        f"INSERT INTO {_identifier(_TABLE)} ({_identifiers(_COLUMNS)}) "
        f"VALUES ({placeholders})",
        rows,
    )


def _verify_candidate(
    *,
    candidate: sqlite3.Connection,
    expected_rows: tuple[tuple[object, ...], ...],
    canonical_snapshot: tuple[tuple[str, tuple[tuple[object, ...], ...]], ...],
) -> None:
    candidate_rows = _rows(candidate, _TABLE, _COLUMNS)
    if candidate_rows != expected_rows:
        raise CandidateArtifactListProjectionsError(
            "candidate artifact rebuild changed projection rows"
        )
    if _row_count(candidate, _TABLE) != len(expected_rows):
        raise CandidateArtifactListProjectionsError(
            "candidate artifact rebuild changed projection row count"
        )
    if candidate.execute("PRAGMA foreign_key_check").fetchall():
        raise CandidateArtifactListProjectionsError(
            "candidate artifact rebuild left a foreign-key violation"
        )
    if _canonical_snapshot(candidate) != canonical_snapshot:
        raise CandidateArtifactListProjectionsError(
            "candidate artifact rebuild mutated canonical source rows"
        )
    assert_exact_manifest(candidate, EXACT_V7_MANIFEST)


def _canonical_snapshot(
    candidate: sqlite3.Connection,
) -> tuple[tuple[str, tuple[tuple[object, ...], ...]], ...]:
    return tuple(
        (table, _rows(candidate, table, _columns(candidate, table)))
        for table in _CANONICAL_TABLES
    )


def _audit_key(
    tenant_id: object,
    job_id: object,
    artifact_id: object,
    label: str,
) -> tuple[str, str, str]:
    return (
        _required_text(tenant_id, f"{label} tenant_id"),
        _required_text(job_id, f"{label} job_id"),
        _required_text(artifact_id, f"{label} artifact_id"),
    )


def _root(
    tenant_id: object,
    job_id: object,
    jobs: Mapping[tuple[str, str], _JobMetadata],
) -> tuple[str, str]:
    tenant = _required_text(tenant_id, "artifact tenant_id")
    stable_job_id = _required_text(job_id, "artifact job_id")
    if (tenant, stable_job_id) not in jobs:
        raise CandidateArtifactListProjectionsError(
            "candidate artifact does not reference a hydrated job root"
        )
    return tenant, stable_job_id


def _record_first_nonblank_json(
    output: dict[tuple[str, str, str], str],
    key: tuple[str, str, str],
    value: object,
    label: str,
) -> None:
    if key in output or value is None:
        return
    if not isinstance(value, str):
        raise CandidateArtifactListProjectionsError(f"malformed {label}")
    if value.strip():
        output[key] = value


def _json_text_array(value: object, label: str) -> list[str]:
    raw = _required_text(value, label)
    try:
        parsed = json.loads(raw, parse_constant=_reject_non_json_constant)
    except (json.JSONDecodeError, ValueError) as error:
        raise CandidateArtifactListProjectionsError(f"malformed {label}") from error
    if not isinstance(parsed, list) or not all(isinstance(item, str) for item in parsed):
        raise CandidateArtifactListProjectionsError(f"malformed {label}")
    return parsed


def _reject_non_json_constant(value: str) -> None:
    raise ValueError(f"non-JSON constant: {value}")


def _path_or_none(value: object) -> str | None:
    if not isinstance(value, str):
        raise CandidateArtifactListProjectionsError("malformed artifact path")
    path = value
    return path if path.strip() else None


def _opaque_json(value: object, label: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise CandidateArtifactListProjectionsError(f"malformed {label}")
    return value


def _required_text(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise CandidateArtifactListProjectionsError(f"malformed {label}")
    return value


def _text_or_empty(value: object, label: str) -> str:
    if not isinstance(value, str):
        raise CandidateArtifactListProjectionsError(f"malformed {label}")
    return value


def _optional_text(value: object, label: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise CandidateArtifactListProjectionsError(f"malformed {label}")
    return value


def _positive_integer(value: object, label: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise CandidateArtifactListProjectionsError(f"malformed {label}")
    return value


def _optional_nonnegative_integer(value: object, label: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise CandidateArtifactListProjectionsError(f"malformed {label}")
    return value


def _number(value: object, label: str) -> int | float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CandidateArtifactListProjectionsError(f"malformed {label}")
    return value


def _assert_columns(
    conn: sqlite3.Connection,
    table: str,
    expected: tuple[str, ...],
) -> None:
    columns = _columns(conn, table)
    if columns != expected:
        raise CandidateArtifactListProjectionsError(
            f"{table} columns do not match the admitted schema"
        )


def _columns(conn: sqlite3.Connection, table: str) -> tuple[str, ...]:
    columns = tuple(
        str(row[1])
        for row in conn.execute(f"PRAGMA table_info({_identifier(table)})").fetchall()
    )
    if not columns:
        raise CandidateArtifactListProjectionsError(f"missing required table: {table}")
    return columns


def _rows(
    conn: sqlite3.Connection,
    table: str,
    columns: tuple[str, ...],
) -> tuple[tuple[object, ...], ...]:
    return tuple(
        tuple(row)
        for row in conn.execute(
            f"SELECT {_identifiers(columns)} FROM {_identifier(table)} ORDER BY rowid"
        ).fetchall()
    )


def _row_count(conn: sqlite3.Connection, table: str) -> int:
    return int(conn.execute(f"SELECT COUNT(*) FROM {_identifier(table)}").fetchone()[0])


def _identifier(value: str) -> str:
    return f'"{value.replace(chr(34), chr(34) * 2)}"'


def _identifiers(values: tuple[str, ...]) -> str:
    return ", ".join(_identifier(value) for value in values)


__all__ = [
    "CandidateArtifactListProjectionsError",
    "CandidateArtifactListProjectionsResult",
    "rebuild_artifact_list_projections",
]
