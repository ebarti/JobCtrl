"""Compensation refresh core shared by RPC, CLI, and Temporal activity."""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from jobctrl.database import get_connection
from jobctrl.infrastructure.compensation import (
    SqliteMarketCompensationRepository,
    SqlitePostedCompensationRepository,
    load_default_reported_compensation_observations,
    posted_compensation_source_from_job,
)
from jobctrl.infrastructure.projections.projection_builder import ProjectionBuilder

log = logging.getLogger(__name__)


def refresh_compensation_facts(
    *,
    tenant_id: str,
    job_url: str | None = None,
    limit: int = 0,
    observations_json_path: str | None = None,
    include_euro_top_tech: bool = True,
    euro_top_tech_max_pages: int = 10,
) -> dict[str, Any]:
    conn = get_connection()
    refreshed_at = datetime.now(timezone.utc).isoformat()
    posted_repository = SqlitePostedCompensationRepository(conn)
    if job_url:
        row = conn.execute(
            "SELECT url, salary, full_description, description FROM jobs WHERE url = ?",
            (job_url,),
        ).fetchone()
        if row is None:
            raise ValueError(f"unknown jobUrl: {job_url}")
        source_text, source_field = posted_compensation_source_from_job(row)
        posted_repository.parse_and_save_job_salary(
            job_url,
            source_text,
            tenant_id=tenant_id,
            source_field=source_field,
            parsed_at=refreshed_at,
        )
        posted_count = 1
    else:
        posted_count = posted_repository.backfill_from_legacy_jobs(
            tenant_id=tenant_id,
            parsed_at=refreshed_at,
        )

    observation_file = Path(observations_json_path) if observations_json_path else None
    if observation_file is not None and not observation_file.exists():
        raise ValueError(f"observationsJsonPath does not exist: {observation_file}")
    compensation_run_id = f"compensation:{refreshed_at}"
    try:
        source_load = load_default_reported_compensation_observations(
            local_observations_path=observation_file,
            include_eurotoptech=include_euro_top_tech,
            eurotoptech_max_pages=euro_top_tech_max_pages,
            recorder_conn=conn,
            run_id=compensation_run_id,
        )
    except Exception as exc:  # noqa: BLE001 - refresh should degrade to local evidence
        log.warning("Reported compensation sources could not be fully loaded: %s", exc)
        source_load = load_default_reported_compensation_observations(
            local_observations_path=observation_file,
            include_eurotoptech=False,
            eurotoptech_max_pages=euro_top_tech_max_pages,
            recorder_conn=conn,
            run_id=compensation_run_id,
        )

    observations = source_load.observations
    estimate_count = SqliteMarketCompensationRepository(conn).backfill_from_jobs(
        observations,
        tenant_id=tenant_id,
        estimated_at=refreshed_at,
        limit=1 if job_url else limit,
        job_url=job_url,
    )

    ProjectionBuilder(conn_factory=get_connection).refresh()
    return {
        "ok": True,
        "status": "succeeded",
        "jobUrl": job_url,
        "postedFactsRefreshed": posted_count,
        "reportedObservationsLoaded": len(observations),
        "localReportedObservationsLoaded": source_load.local_count,
        "licensedReportedObservationsLoaded": source_load.licensed_count,
        "levelsFyiObservationsLoaded": source_load.levels_fyi_count,
        "glassdoorObservationsLoaded": source_load.glassdoor_count,
        "euroTopTechObservationsLoaded": source_load.euro_top_tech_count,
        "estimatesRefreshed": estimate_count,
        "marketRefreshSkipped": False,
        "tenantId": tenant_id,
    }
