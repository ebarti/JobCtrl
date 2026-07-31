"""Exact-v7 event-identity coverage for the projection refresh boundary."""

from __future__ import annotations

import json
import sqlite3

from jobctrl.domain.identifiers import JobId
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.events.watermark import SqliteEventWatermarkRepository
from jobctrl.infrastructure.migrations.schema_v7 import create_exact_v7_schema
from jobctrl.infrastructure.projections.projection_builder import (
    PROJECTION_NAME,
    ProjectionBuilder,
)
from jobctrl.state import record_job_event


_INERT_CONTEXT = {"userContext": "Attack vectors:\nPrompt injection"}
_SHARED_URL = "https://jobs.example.test/platform-engineer"
_LOCAL_JOB_ID = JobId("90000000-0000-4000-8000-000000000001")
_OTHER_JOB_ID = JobId("90000000-0000-4000-8000-000000000002")
_TIMESTAMP = "2026-07-31T12:00:00+00:00"


def _insert_job_with_materials(
    conn: sqlite3.Connection, tenant_id: TenantId, job_id: JobId
) -> None:
    conn.execute(
        """
        INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
        VALUES (?, ?, ?, 'Platform Engineer', 'Example', 'example', ?)
        """,
        (str(tenant_id), str(job_id), _SHARED_URL, _TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO job_enrichments (
            tenant_id, job_id, current_status, full_description, application_url, updated_at
        ) VALUES (?, ?, 'enriched', 'Build reliable systems.', ?, ?)
        """,
        (str(tenant_id), str(job_id), f"{_SHARED_URL}/apply", _TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO job_materials (
            tenant_id, job_id, generation, status, created_at, updated_at
        ) VALUES (?, ?, 1, 'approved', ?, ?)
        """,
        (str(tenant_id), str(job_id), _TIMESTAMP, _TIMESTAMP),
    )
    conn.execute(
        """
        INSERT INTO job_materials_artifacts (
            tenant_id, job_id, generation, artifact_type, artifact_id,
            status, path, render_format, created_at
        ) VALUES (?, ?, 1, 'tailored_resume', ?, 'approved', ?, 'text', ?)
        """,
        (
            str(tenant_id),
            str(job_id),
            f"{job_id}:tailored_resume",
            f"/tmp/{job_id}-tailored-resume.txt",
            _TIMESTAMP,
        ),
    )


def _record_apply_run(
    conn: sqlite3.Connection, tenant_id: TenantId, job_id: JobId, run_id: str
) -> None:
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplyRunStarted",
        tenant_id=tenant_id,
        occurred_at=_TIMESTAMP,
        payload={"run_id": run_id, "started_at": _TIMESTAMP, **_INERT_CONTEXT},
        publisher=InProcessEventBus(),
    )
    record_job_event(
        conn,
        job_id,
        "apply",
        "ApplicationSubmitted",
        tenant_id=tenant_id,
        occurred_at="2026-07-31T12:01:00+00:00",
        payload={
            "run_id": run_id,
            "finished_at": "2026-07-31T12:01:00+00:00",
            "duration_ms": 60_000,
            **_INERT_CONTEXT,
        },
        publisher=InProcessEventBus(),
    )


def test_refresh_scopes_exact_v7_source_events_by_tenant() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(conn)

    record_job_event(
        conn,
        None,
        "discover",
        "DiscoveryRunStarted",
        tenant_id=TenantId("other"),
        payload={
            "run_id": "other-run",
            "source_ids": ["greenhouse:other"],
            **_INERT_CONTEXT,
        },
        publisher=InProcessEventBus(),
    )
    record_job_event(
        conn,
        None,
        "discover",
        "DiscoveryRunStarted",
        tenant_id=LOCAL_TENANT,
        payload={
            "run_id": "local-run",
            "source_ids": ["greenhouse:local"],
            **_INERT_CONTEXT,
        },
        publisher=InProcessEventBus(),
    )
    conn.commit()

    assert ProjectionBuilder(conn_factory=lambda: conn).refresh() == 0

    local_stats = conn.execute(
        "SELECT source_id FROM source_quality_stats WHERE tenant_id = ?",
        (str(LOCAL_TENANT),),
    ).fetchall()
    payload = json.loads(
        conn.execute(
            "SELECT payload_json FROM job_events WHERE tenant_id = ?",
            (str(LOCAL_TENANT),),
        ).fetchone()[0]
    )

    assert [row[0] for row in local_stats] == ["greenhouse:local"]
    assert payload["userContext"] == "Attack vectors:\nPrompt injection"
    assert SqliteEventWatermarkRepository(conn).get(PROJECTION_NAME) == 2

    other_builder = ProjectionBuilder(
        conn_factory=lambda: conn,
        tenant_id=TenantId("other"),
    )
    assert other_builder.refresh() == 0
    assert SqliteEventWatermarkRepository(conn).get(
        f"{PROJECTION_NAME}:other"
    ) == 1


def test_refresh_projects_exact_job_artifacts_and_apply_runs_by_tenant_job_id() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(conn)
    other_tenant = TenantId("other")
    _insert_job_with_materials(conn, LOCAL_TENANT, _LOCAL_JOB_ID)
    _insert_job_with_materials(conn, other_tenant, _OTHER_JOB_ID)
    _record_apply_run(conn, other_tenant, _OTHER_JOB_ID, "other-apply")
    _record_apply_run(conn, LOCAL_TENANT, _LOCAL_JOB_ID, "local-apply")
    conn.commit()

    assert ProjectionBuilder(conn_factory=lambda: conn).refresh() == 1

    local_job = conn.execute(
        """
        SELECT job_id, employer, source, has_resume, apply_status
        FROM job_list_projections
        WHERE tenant_id = ?
        """,
        (str(LOCAL_TENANT),),
    ).fetchall()
    local_artifacts = conn.execute(
        """
        SELECT job_id, local_path
        FROM artifact_list_projections
        WHERE tenant_id = ?
        """,
        (str(LOCAL_TENANT),),
    ).fetchall()
    local_apply_run = conn.execute(
        """
        SELECT run_id, job_id, job_employer, status, result
        FROM apply_run_projections
        WHERE tenant_id = ?
        """,
        (str(LOCAL_TENANT),),
    ).fetchall()

    assert [tuple(row) for row in local_job] == [
        (str(_LOCAL_JOB_ID), "Example", "example", 1, "applied")
    ]
    assert [tuple(row) for row in local_artifacts] == [
        (str(_LOCAL_JOB_ID), f"/tmp/{_LOCAL_JOB_ID}-tailored-resume.txt")
    ]
    assert [tuple(row) for row in local_apply_run] == [
        ("local-apply", str(_LOCAL_JOB_ID), "Example", "succeeded", "applied")
    ]


def test_refresh_never_invents_pdf_artifacts_from_registered_text_paths() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(conn)
    _insert_job_with_materials(conn, LOCAL_TENANT, _LOCAL_JOB_ID)
    conn.execute(
        """
        UPDATE job_materials_artifacts
        SET artifact_type = 'tailored_resume_txt',
            artifact_id = ?
        WHERE tenant_id = ? AND job_id = ?
        """,
        (
            f"{_LOCAL_JOB_ID}:tailored_resume_txt",
            str(LOCAL_TENANT),
            str(_LOCAL_JOB_ID),
        ),
    )
    _record_apply_run(conn, LOCAL_TENANT, _LOCAL_JOB_ID, "local-apply")
    conn.commit()

    assert ProjectionBuilder(conn_factory=lambda: conn).refresh() == 1

    artifacts = conn.execute(
        """
        SELECT artifact_id, artifact_type, local_path
        FROM artifact_list_projections
        WHERE tenant_id = ? AND job_id = ?
        ORDER BY artifact_id
        """,
        (str(LOCAL_TENANT), str(_LOCAL_JOB_ID)),
    ).fetchall()

    assert [tuple(row) for row in artifacts] == [
        (
            f"{_LOCAL_JOB_ID}:tailored_resume_txt",
            "tailored_resume_txt",
            f"/tmp/{_LOCAL_JOB_ID}-tailored-resume.txt",
        )
    ]


def test_refresh_uses_explicit_unknown_when_canonical_company_is_absent() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(conn)
    _insert_job_with_materials(conn, LOCAL_TENANT, _LOCAL_JOB_ID)
    conn.execute(
        """
        UPDATE jobs
        SET company = NULL,
            site = 'greenhouse',
            url = 'https://boards.greenhouse.io/url-derived-company/jobs/42'
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(_LOCAL_JOB_ID)),
    )
    conn.execute(
        """
        UPDATE job_enrichments
        SET application_url = 'https://jobs.lever.co/application-derived-company/42'
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(_LOCAL_JOB_ID)),
    )
    _record_apply_run(conn, LOCAL_TENANT, _LOCAL_JOB_ID, "local-apply")
    conn.commit()

    assert ProjectionBuilder(conn_factory=lambda: conn).refresh() == 1

    job_row = conn.execute(
        """
        SELECT employer, source
        FROM job_list_projections
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(_LOCAL_JOB_ID)),
    ).fetchone()
    apply_row = conn.execute(
        """
        SELECT job_employer
        FROM apply_run_projections
        WHERE tenant_id = ? AND job_id = ?
        """,
        (str(LOCAL_TENANT), str(_LOCAL_JOB_ID)),
    ).fetchone()

    assert tuple(job_row) == ("Unknown company", "greenhouse")
    assert tuple(apply_row) == ("Unknown company",)


def test_refresh_scopes_exact_workflow_and_pipeline_events_by_tenant() -> None:
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    create_exact_v7_schema(conn)
    other_tenant = TenantId("other")

    for tenant_id, workflow_id, temporal_run_id in (
        (other_tenant, "other-workflow", "other-run"),
        (LOCAL_TENANT, "local-workflow", "local-run"),
    ):
        record_job_event(
            conn,
            None,
            "workflow",
            "WorkflowStarted",
            tenant_id=tenant_id,
            occurred_at=_TIMESTAMP,
            payload={
                "workflowId": workflow_id,
                "workflowType": "DiscoverWorkflow",
                "temporalRunId": temporal_run_id,
                "startedAt": _TIMESTAMP,
                **_INERT_CONTEXT,
            },
            publisher=InProcessEventBus(),
        )
        record_job_event(
            conn,
            None,
            "workflow",
            "PipelineStepQueued",
            tenant_id=tenant_id,
            occurred_at=_TIMESTAMP,
            payload={
                "execution": {
                    "tenantId": str(tenant_id),
                    "workflowId": workflow_id,
                    "temporalRunId": temporal_run_id,
                },
                "stepKind": "source_family",
                "itemKey": "family:example",
                "attempt": 1,
                "queuedAt": _TIMESTAMP,
                **_INERT_CONTEXT,
            },
            publisher=InProcessEventBus(),
        )
    conn.commit()

    assert ProjectionBuilder(conn_factory=lambda: conn).refresh() == 0

    local_workflows = conn.execute(
        "SELECT workflow_id FROM workflow_run_projections WHERE tenant_id = ?",
        (str(LOCAL_TENANT),),
    ).fetchall()
    local_steps = conn.execute(
        """
        SELECT discover_workflow_id, discover_run_id
        FROM pipeline_step_projections
        WHERE tenant_id = ?
        """,
        (str(LOCAL_TENANT),),
    ).fetchall()

    assert [tuple(row) for row in local_workflows] == [("local-workflow",)]
    assert [tuple(row) for row in local_steps] == [("local-workflow", "local-run")]
