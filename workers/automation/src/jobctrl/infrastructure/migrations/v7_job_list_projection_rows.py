"""Build complete v7 job-list rows from hydrated canonical candidate data."""

from __future__ import annotations

import sqlite3
import uuid

from jobctrl.infrastructure.migrations import v6_to_v7_job_detail_projections as detail
from jobctrl.infrastructure.projections import projection_builder
from jobctrl.infrastructure.projections.location_normalization import (
    normalize_job_location,
)

JOB_LIST_PROJECTIONS_TABLE = "job_list_projections"
JOB_LIST_PROJECTIONS_COLUMNS = (
    "tenant_id",
    "job_id",
    "title",
    "employer",
    "source",
    "strategy",
    "location",
    "salary",
    "application_url",
    "discovered_at",
    "description",
    "full_description",
    "fit_score",
    "fit_band",
    "compensation_summary_json",
    "score_breakdown_json",
    "score_keywords_json",
    "score_reasoning",
    "score_version",
    "scored_at",
    "score_criteria_json",
    "score_trace_json",
    "score_correction_json",
    "current_stage",
    "current_substage",
    "current_state",
    "current_error_code",
    "current_error_message",
    "current_next_action",
    "has_resume",
    "has_cover_letter",
    "has_pdf",
    "apply_status",
    "applied_at",
    "apply_mode",
    "resume_template_id",
    "resume_template_name",
    "tailoring_policy_version",
    "artifact_count",
    "deleted_at",
    "last_updated_at",
)

_MATERIAL_ARTIFACT_TYPES = (
    "tailored_resume",
    "cover_letter",
    "resume_pdf",
    "cover_letter_pdf",
)
_RESUME_METADATA_ARTIFACT_TYPES = (
    "tailored_resume",
    "tailored_resume_txt",
    "resume_pdf",
)


class CandidateJobListProjectionsError(RuntimeError):
    """Raised when a complete job-list row cannot be derived safely."""


def _projection_rows(
    candidate: sqlite3.Connection,
    migration_at: str,
) -> tuple[tuple[object, ...], ...]:
    """Serialize every complete v7 job-list row from canonical candidate rows.

    The candidate must already contain UUID roots and any upstream projection
    inputs (apply runs and artifacts).  The target ``job_list_projections``
    table, legacy URL caches, and mutable resume-template selection tables are
    intentionally never read.
    """
    timestamp = _required_text(migration_at, "migration_at")
    _assert_hydrated_roots(candidate)

    rows: list[tuple[object, ...]] = []
    for job in candidate.execute(
        """
        SELECT tenant_id, job_id, url, title, company, salary, description,
               location, site, strategy, discovered_at, full_description,
               application_url, apply_status, applied_at
        FROM jobs
        ORDER BY tenant_id, job_id
        """
    ).fetchall():
        (
            tenant_id,
            job_id,
            job_url,
            title,
            company,
            salary,
            description,
            location,
            site,
            strategy,
            discovered_at,
            full_description,
            application_url,
            legacy_apply_status,
            legacy_applied_at,
        ) = job
        tenant = _required_text(tenant_id, "candidate job tenant_id")
        stable_job_id = _required_uuid(job_id, "candidate job job_id")
        locator = _required_text(job_url, "candidate job url")
        enrichment = _enrichment(candidate, tenant, stable_job_id)
        selected_application_url = (
            enrichment[1]
            if enrichment[1] is not None
            else _optional_text(application_url)
        )
        selected_full_description = (
            enrichment[0]
            if enrichment[0] is not None
            else _text_or_empty(full_description)
        )
        score = detail._score_projection(candidate, tenant, stable_job_id)
        compensation_summary, _ = detail._compensation_projection(
            candidate,
            tenant,
            stable_job_id,
            salary,
        )
        material = _current_material(candidate, tenant, stable_job_id)
        current = _current_stage(
            candidate,
            tenant,
            stable_job_id,
            has_resume=material[0],
        )
        (
            has_resume,
            has_cover_letter,
            has_pdf,
            resume_template_id,
            resume_template_name,
            tailoring_policy_version,
        ) = material
        apply_status, applied_at, apply_mode = _apply_projection(
            candidate,
            tenant,
            stable_job_id,
            legacy_apply_status,
            legacy_applied_at,
        )
        rows.append(
            (
                tenant,
                stable_job_id,
                _text_or_default(title, "Untitled"),
                _text_or_default(company, projection_builder._company_name(
                    _text_or_empty(site), selected_application_url or locator
                )),
                _text_or_default(site, "unknown"),
                _text_or_empty(strategy),
                normalize_job_location(_text_or_empty(location)),
                _text_or_empty(salary),
                selected_application_url,
                _optional_text(discovered_at),
                _text_or_empty(description),
                selected_full_description,
                score["fit_score"],
                _latest_requirement_fit_band(candidate, tenant, stable_job_id),
                compensation_summary,
                score["breakdown_json"],
                score["keywords_json"],
                score["reasoning"],
                score["version"],
                score["scored_at"],
                score["criteria_json"],
                score["trace_json"],
                score["correction_json"],
                *current,
                has_resume,
                has_cover_letter,
                has_pdf,
                apply_status,
                applied_at,
                apply_mode,
                resume_template_id,
                resume_template_name,
                tailoring_policy_version,
                _artifact_count(candidate, tenant, stable_job_id),
                _active_deleted_at(candidate, tenant, stable_job_id),
                timestamp,
            )
        )

    if any(len(row) != len(JOB_LIST_PROJECTIONS_COLUMNS) for row in rows):
        raise CandidateJobListProjectionsError(
            "job-list projection serializer must emit every v7 column"
        )
    return tuple(rows)


def _assert_hydrated_roots(candidate: sqlite3.Connection) -> None:
    jobs: dict[tuple[str, str], str] = {}
    for tenant_id, job_id, url in candidate.execute(
        "SELECT tenant_id, job_id, url FROM jobs ORDER BY tenant_id, job_id"
    ).fetchall():
        tenant = _required_text(tenant_id, "candidate job tenant_id")
        stable_job_id = _required_uuid(job_id, "candidate job job_id")
        locator = _required_text(url, "candidate job url")
        key = (tenant, locator)
        if key in jobs:
            raise CandidateJobListProjectionsError(
                "candidate job roots must have unique posting locators"
            )
        jobs[key] = stable_job_id
    locators = {
        (_required_text(tenant_id, "candidate locator tenant_id"), _required_text(locator, "candidate locator value")): _required_uuid(job_id, "candidate locator job_id")
        for tenant_id, job_id, locator in candidate.execute(
            """
            SELECT tenant_id, job_id, locator_value
            FROM job_locators
            WHERE locator_kind = 'posting_url'
              AND is_current = 1
              AND retired_at IS NULL
            """
        ).fetchall()
    }
    if jobs != locators or _row_count(candidate, "job_locators") != len(locators):
        raise CandidateJobListProjectionsError(
            "job-list row serializer requires exactly one hydrated root locator per job"
        )


def _enrichment(
    candidate: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
) -> tuple[str | None, str | None]:
    row = candidate.execute(
        """
        SELECT full_description, application_url
        FROM job_enrichments
        WHERE tenant_id = ? AND job_id = ?
        """,
        (tenant_id, job_id),
    ).fetchone()
    if row is None:
        return None, None
    return _optional_text(row[0]), _optional_text(row[1])


def _latest_requirement_fit_band(
    candidate: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
) -> str | None:
    row = candidate.execute(
        """
        SELECT fit_band
        FROM job_requirement_fit_reports
        WHERE tenant_id = ? AND job_id = ?
        ORDER BY score_version DESC
        LIMIT 1
        """,
        (tenant_id, job_id),
    ).fetchone()
    if row is None:
        return None
    return projection_builder._fit_band(_optional_text(row[0]))


def _current_stage(
    candidate: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
    *,
    has_resume: bool,
) -> tuple[str, str, str, str | None, str | None, str | None]:
    stages = detail._stages(candidate, tenant_id, job_id)
    first_actionable = next(
        (stage for stage in stages if stage["state"] not in {"succeeded", "skipped"}),
        stages[-1] if stages else None,
    )
    if first_actionable is None:
        return "discover", "discover", "pending", None, None, None
    return (
        projection_builder._job_list_stage(
            str(first_actionable["stage"]), has_resume=has_resume
        ),
        str(first_actionable["stage"]),
        str(first_actionable["state"]),
        _optional_text(first_actionable["error_code"]),
        _optional_text(first_actionable["error_message"]),
        _optional_text(first_actionable["next_action"]),
    )


def _current_material(
    candidate: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
) -> tuple[object, ...]:
    row = candidate.execute(
        """
        SELECT MAX(generation)
        FROM job_materials_artifacts
        WHERE tenant_id = ? AND job_id = ?
          AND status = 'approved'
          AND artifact_type IN (?, ?, ?, ?)
        """,
        (tenant_id, job_id, *_MATERIAL_ARTIFACT_TYPES),
    ).fetchone()
    if row is None or row[0] is None:
        return False, False, False, None, None, None
    generation = _positive_integer(row[0], "approved material generation")
    artifacts = candidate.execute(
        """
        SELECT artifact_type, path, metadata_json, created_at, artifact_id
        FROM job_materials_artifacts
        WHERE tenant_id = ? AND job_id = ? AND generation = ?
          AND status = 'approved'
        ORDER BY CASE artifact_type
                   WHEN 'tailored_resume' THEN 0
                   WHEN 'tailored_resume_txt' THEN 1
                   WHEN 'resume_pdf' THEN 2
                   ELSE 3
                 END,
                 created_at DESC,
                 artifact_id DESC
        """,
        (tenant_id, job_id, generation),
    ).fetchall()
    approved = {
        str(artifact_type): _optional_text(path)
        for artifact_type, path, _metadata_json, _created_at, _artifact_id in artifacts
    }
    metadata_jsons = [
        _optional_text(metadata_json)
        for artifact_type, _path, metadata_json, _created_at, _artifact_id in artifacts
        if str(artifact_type) in _RESUME_METADATA_ARTIFACT_TYPES
    ]
    material = candidate.execute(
        """
        SELECT metadata_json
        FROM job_materials
        WHERE tenant_id = ? AND job_id = ? AND generation = ?
        """,
        (tenant_id, job_id, generation),
    ).fetchone()
    if material is not None:
        metadata_jsons.append(_optional_text(material[0]))
    analytics = projection_builder._merge_material_analytics(metadata_jsons)
    return (
        bool(approved.get("tailored_resume")),
        bool(approved.get("cover_letter")),
        bool(approved.get("resume_pdf") or approved.get("cover_letter_pdf")),
        analytics["resume_template_id"],
        analytics["resume_template_name"],
        analytics["tailoring_policy_version"],
    )


def _apply_projection(
    candidate: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
    legacy_apply_status: object,
    legacy_applied_at: object,
) -> tuple[str | None, str | None, str | None]:
    run = candidate.execute(
        """
        SELECT status, finished_at, dry_run
        FROM apply_run_projections
        WHERE tenant_id = ? AND job_id = ?
        ORDER BY started_at DESC, run_id DESC
        LIMIT 1
        """,
        (tenant_id, job_id),
    ).fetchone()
    run_status = _optional_text(run[0]) if run is not None else None
    run_finished_at = _optional_text(run[1]) if run is not None else None
    dry_run = bool(run[2]) if run is not None else False
    legacy_status = _optional_text(legacy_apply_status)
    legacy_at = _optional_text(legacy_applied_at)
    apply_status = projection_builder._derive_apply_status(run_status, legacy_status)
    applied_at = run_finished_at if run_status == "succeeded" else legacy_at
    if run_status == "succeeded" and not dry_run:
        return apply_status, applied_at, "automated_live"
    if not (legacy_at or legacy_status == "applied"):
        return apply_status, applied_at, None
    manually_marked = candidate.execute(
        """
        SELECT 1 FROM job_events
        WHERE tenant_id = ? AND job_id = ?
          AND event_type = 'ApplicationManuallyMarked'
        LIMIT 1
        """,
        (tenant_id, job_id),
    ).fetchone()
    if manually_marked is not None:
        return apply_status, applied_at, "manual_marked"
    externally_confirmed = candidate.execute(
        """
        SELECT 1 FROM application_outcomes
        WHERE tenant_id = ? AND job_id = ?
          AND kind = 'applied_confirmation'
        LIMIT 1
        """,
        (tenant_id, job_id),
    ).fetchone()
    return (
        apply_status,
        applied_at,
        "external_confirmed" if externally_confirmed is not None else "manual_marked",
    )


def _artifact_count(candidate: sqlite3.Connection, tenant_id: str, job_id: str) -> int:
    return int(
        candidate.execute(
            """
            SELECT COUNT(*) FROM artifact_list_projections
            WHERE tenant_id = ? AND job_id = ? AND status != 'suppressed'
            """,
            (tenant_id, job_id),
        ).fetchone()[0]
    )


def _active_deleted_at(
    candidate: sqlite3.Connection,
    tenant_id: str,
    job_id: str,
) -> str | None:
    row = candidate.execute(
        """
        SELECT deleted_at
        FROM jobctrl_deleted_jobs
        WHERE tenant_id = ? AND job_id = ?
          AND (restored_at IS NULL OR julianday(restored_at) <= julianday(deleted_at))
        """,
        (tenant_id, job_id),
    ).fetchone()
    return _optional_text(row[0]) if row is not None else None


def _required_uuid(value: object, field: str) -> str:
    text = _required_text(value, field).lower()
    try:
        parsed = uuid.UUID(text)
    except ValueError as error:
        raise CandidateJobListProjectionsError(
            f"{field} must be a canonical UUID"
        ) from error
    if str(parsed) != text:
        raise CandidateJobListProjectionsError(
            f"{field} must be a canonical UUID"
        )
    return text


def _positive_integer(value: object, field: str) -> int:
    if isinstance(value, bool):
        raise CandidateJobListProjectionsError(f"{field} must be a positive integer")
    try:
        parsed = int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as error:
        raise CandidateJobListProjectionsError(
            f"{field} must be a positive integer"
        ) from error
    if parsed < 1:
        raise CandidateJobListProjectionsError(f"{field} must be a positive integer")
    return parsed


def _row_count(candidate: sqlite3.Connection, table: str) -> int:
    return int(candidate.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0])


def _required_text(value: object, field: str) -> str:
    text = _optional_text(value)
    if text is None:
        raise CandidateJobListProjectionsError(f"{field} must be non-empty text")
    return text


def _optional_text(value: object) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _text_or_empty(value: object) -> str:
    return "" if value is None else str(value)


def _text_or_default(value: object, default: str) -> str:
    text = _text_or_empty(value)
    return text or default


__all__ = [
    "CandidateJobListProjectionsError",
    "JOB_LIST_PROJECTIONS_COLUMNS",
    "JOB_LIST_PROJECTIONS_TABLE",
]
