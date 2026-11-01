"""Approved material reuse does not finish another live material execution."""

import json
from dataclasses import replace
from pathlib import Path

import pytest
from temporalio.testing import ActivityEnvironment

from jobctrl.infrastructure.preparation_recovery import assert_material_activity_commit_allowed
from jobctrl.materials import activities
from jobctrl.scoring import cover_letter, tailor
from jobctrl.state import record_job_event
from .test_v7_cover_runtime import (
    _JOB_ID, _TENANT_A, _seed_approved_resume, _seed_eligible_score,
    _seed_stage_rows, _seed_target,
)
from .test_v7_tailor_runtime import batch_runtime  # noqa: F401


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["tailor", "cover"])
@pytest.mark.parametrize("owner", ["other_workflow", "other_activity", "direct", "current"])
async def test_approved_material_replay_preserves_current_publication_authority(
    batch_runtime, monkeypatch, tmp_path, stage, owner,  # noqa: F811
):
    conn = batch_runtime.connect()
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_A)
    _seed_stage_rows(conn, tenant_id=_TENANT_A)
    if stage == "cover":
        path = tmp_path / "approved-cover.txt"
        path.write_text("Synthetic approved cover", encoding="utf-8")
        conn.execute(
            "INSERT INTO job_materials_artifacts "
            "(tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) "
            "VALUES (?,?,1,'cover_letter','approved-cover','approved',?,'text','2026-01-01')",
            (str(_TENANT_A), str(_JOB_ID), str(path)),
        )
    resume_id = conn.execute(
        "SELECT artifact_id FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? "
        "AND artifact_type='tailored_resume'", (str(_TENANT_A), str(_JOB_ID)),
    ).fetchone()[0]
    conn.execute(
        "INSERT INTO job_bullet_provenance "
        "(tenant_id,job_id,generation,bullet_id,artifact_id,section,source_id,"
        "transform_type,control,rationale,generated_text,created_at) "
        "VALUES (?,?,1,'synthetic-bullet',?,'experience','synthetic-source',"
        "'reframe','rephrase_allowed','Synthetic provenance','Synthetic accepted claim','2026-01-01')",
        (str(_TENANT_A), str(_JOB_ID), resume_id),
    )

    env = ActivityEnvironment()
    # A's delayed retry follows a different live execution. The positive control
    # enters the same approved-material path without the retry pre-reconciler.
    env.info = replace(env.info, workflow_run_id="workflow-A", attempt=1 if owner == "current" else 2)
    record_job_event(
        conn, _JOB_ID, stage, "StageStarted", tenant_id=_TENANT_A,
        payload={"materialAttemptId": "old-A", "temporalRunId": "workflow-A",
                 "temporalActivityId": env.info.activity_id, "temporalAttempt": 1},
    )
    current_workflow = "workflow-B" if owner == "other_workflow" else None if owner == "direct" else "workflow-A"
    current_activity = "activity-B" if owner in {"other_workflow", "other_activity"} else env.info.activity_id
    current_token = "current-A" if owner == "current" else "current-B"
    conn.execute(
        "UPDATE job_stage_states SET state='running',metadata_json=? "
        "WHERE tenant_id=? AND job_id=? AND stage=?",
        (json.dumps({
            **({"activityOwner": current_workflow} if current_workflow else {}),
            "attemptCountBasis": "completed", "retailor": owner != "current", "priorApprovedGeneration": 1,
        }), str(_TENANT_A), str(_JOB_ID), stage),
    )
    record_job_event(
        conn, _JOB_ID, stage, "StageStarted", tenant_id=_TENANT_A,
        payload={"materialAttemptId": current_token, **({
            "temporalRunId": current_workflow, "temporalActivityId": current_activity, "temporalAttempt": 1,
        } if current_workflow else {})},
    )
    conn.commit()
    scope = (str(_TENANT_A), str(_JOB_ID))
    stage_sql = "SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage=?"
    event_sql = "SELECT * FROM job_events WHERE tenant_id=? AND job_id=? AND stage=? ORDER BY event_id"
    stage_before = tuple(conn.execute(stage_sql, (*scope, stage)).fetchone())
    events_before = [tuple(row) for row in conn.execute(event_sql, (*scope, stage))]
    material_queries = (
        "SELECT * FROM job_materials WHERE tenant_id=? AND job_id=? ORDER BY generation",
        "SELECT * FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? ORDER BY generation,artifact_type",
        "SELECT * FROM job_bullet_provenance WHERE tenant_id=? AND job_id=? ORDER BY generation,bullet_id",
    )
    materials_before = [[tuple(row) for row in conn.execute(query, scope)] for query in material_queries]
    paths = [Path(row[0]) for row in conn.execute(
        "SELECT path FROM job_materials_artifacts WHERE tenant_id=? AND job_id=?", scope,
    )]
    for path in paths:
        if not path.exists():
            path.write_bytes(b"Synthetic approved PDF bytes")
    bytes_before = {path: path.read_bytes() for path in paths}
    config_path = tmp_path / "cover-config.json"
    config_path.write_text('{"cover_letter_generation":true}', encoding="utf-8")
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(config_path))

    async def inline(blocking, **_):
        return blocking()

    def unexpected_generation(**_):
        pytest.fail("Approved-material reuse must not invoke generation")

    monkeypatch.setattr("jobctrl.infrastructure.temporal.run_in_activity.run_blocking_with_heartbeat", inline)
    monkeypatch.setattr(tailor, "_build_use_case", unexpected_generation)
    monkeypatch.setattr(cover_letter, "_build_use_case", unexpected_generation)
    payload = (activities.TailorJobActivityInput if stage == "tailor" else activities.CoverLetterActivityInput)(
        tenant_id=str(_TENANT_A), job_id=_JOB_ID,
    )
    runner = activities.tailor_job_activity if stage == "tailor" else activities.cover_letter_activity
    result = await env.run(runner, payload)
    assert result.status == "already_done"
    assert [[tuple(row) for row in conn.execute(query, scope)] for query in material_queries] == materials_before
    assert {path: path.read_bytes() for path in paths} == bytes_before
    if owner == "current":
        assert conn.execute(stage_sql, (*scope, stage)).fetchone()["state"] == "succeeded"
        assert len(list(conn.execute(event_sql, (*scope, stage)))) == len(events_before) + 1
    else:
        assert tuple(conn.execute(stage_sql, (*scope, stage)).fetchone()) == stage_before
        assert [tuple(row) for row in conn.execute(event_sql, (*scope, stage))] == events_before
        # B still has the exact authority used by the real publication writer.
        assert_material_activity_commit_allowed(
            conn, tenant_id=str(_TENANT_A), job_id=str(_JOB_ID), stage=stage,
            workflow_id=current_workflow, attempt_id=current_token,
        )
        with pytest.raises(RuntimeError, match="no longer owns artifact persistence"):
            assert_material_activity_commit_allowed(
                conn, tenant_id=str(_TENANT_A), job_id=str(_JOB_ID), stage=stage,
                workflow_id="workflow-A", attempt_id="old-A",
            )
