"""Cover opt-in controls plans, admission and durable state without model calls."""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from jobctrl import config
from jobctrl.domain.materials import Artifact, ArtifactType, RenderFormat, ValidationResult
from jobctrl.domain.preparation.work_items import PreparationWorkItemKind
from jobctrl.infrastructure.materials import SqliteMaterialsRepository
from jobctrl.infrastructure.materials.cover_letter_policy import (
    COVER_LETTER_DISABLED,
    configured_preparation_steps,
    reconcile_cover_letter_policy,
)
from jobctrl.pipeline import preparation
from jobctrl.preparation import workflow as prep_workflow
from jobctrl.scoring import cover_letter
from tests.test_preparation_manual_decline import seed, TENANT


@pytest.fixture
def owned(tmp_path, monkeypatch):
    conn, job_id = seed(tmp_path, monkeypatch, "cover")
    conn.execute("UPDATE job_stage_states SET state='pending',retryable=1 WHERE stage='apply'")
    conn.commit()
    path = tmp_path / "config.json"
    path.write_text("{}")
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(path))
    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    yield conn, job_id, path
    conn.close()


@pytest.mark.parametrize(
    "value,enabled", [(None, False), (False, False), (True, True), ("true", False), (1, False), ({}, False)]
)
def test_only_explicit_boolean_opt_in_enables_generation(owned, value, enabled):
    _, _, path = owned
    path.write_text(json.dumps({"cover_letter_generation": value}))
    assert config.get_cover_letter_generation_enabled() is enabled
    assert configured_preparation_steps(["score", "tailor", "cover", "pdf"]) == (
        ["score", "tailor", "cover", "pdf"] if enabled else ["score", "tailor", "pdf"]
    )


def test_disabled_runner_stops_before_acquisition_or_generation_and_preserves_resume(owned, monkeypatch):
    conn, job_id, _ = owned
    before = [tuple(row) for row in conn.execute("SELECT * FROM job_materials_artifacts")]

    def forbidden(*args, **kwargs):
        pytest.fail("disabled letter crossed model or availability acquisition")

    monkeypatch.setattr(cover_letter, "_build_use_case", forbidden)
    monkeypatch.setattr("jobctrl.enrichment.availability.require_preparation_available", forbidden)
    result = cover_letter.cover_letter_by_id(job_id, tenant_id=TENANT)
    assert result["reason"] == "cover_letter_generation_disabled"
    row = conn.execute("SELECT state,error_code,attempt_count FROM job_stage_states WHERE stage='cover'").fetchone()
    assert tuple(row) == ("skipped", COVER_LETTER_DISABLED, 0)
    assert [tuple(row) for row in conn.execute("SELECT * FROM job_materials_artifacts")] == before


def test_disablement_after_availability_is_rechecked_before_model_and_attempt(owned, monkeypatch):
    conn, job_id, path = owned
    path.write_text('{"cover_letter_generation":true}')

    def disable(*args, **kwargs):
        path.write_text('{"cover_letter_generation":false}')

    monkeypatch.setattr("jobctrl.enrichment.availability.require_preparation_available", disable)
    monkeypatch.setattr(
        cover_letter, "_build_use_case", lambda **kwargs: pytest.fail("model constructed after disablement")
    )
    result = cover_letter.cover_letter_by_id(job_id, tenant_id=TENANT)
    assert result["reason"] == "cover_letter_generation_disabled"
    assert conn.execute("SELECT attempt_count FROM job_stage_states WHERE stage='cover'").fetchone()[0] == 0


def test_enabling_releases_only_its_own_skip_and_preserves_manual_decline(owned):
    conn, job_id, path = owned
    reconcile_cover_letter_policy(conn, tenant_id=TENANT)
    path.write_text('{"cover_letter_generation":true}')
    conn.execute("UPDATE job_stage_states SET state='skipped',retryable=0 WHERE stage='apply'")
    conn.commit()
    reconcile_cover_letter_policy(conn, tenant_id=TENANT)
    assert (
        conn.execute("SELECT error_code FROM job_stage_states WHERE stage='cover'").fetchone()[0]
        == COVER_LETTER_DISABLED
    )
    conn.execute("UPDATE job_stage_states SET state='pending',retryable=1 WHERE stage='apply'")
    conn.commit()
    reconcile_cover_letter_policy(conn, tenant_id=TENANT)
    assert tuple(
        conn.execute("SELECT state,error_code,attempt_count FROM job_stage_states WHERE stage='cover'").fetchone()
    ) == ("pending", None, 0)


@pytest.mark.parametrize("state", ["running", "succeeded", "failed", "blocked", "canceled", "skipped"])
def test_policy_changes_preserve_other_outcomes(owned, state):
    conn, _, path = owned
    conn.execute(
        "UPDATE job_stage_states SET state=?,error_code='OTHER_REASON',attempt_count=2 WHERE stage='cover'", (state,)
    )
    conn.commit()
    before = tuple(conn.execute("SELECT * FROM job_stage_states WHERE stage='cover'").fetchone())
    for enabled in (False, True):
        path.write_text(json.dumps({"cover_letter_generation": enabled}))
        reconcile_cover_letter_policy(conn, tenant_id=TENANT, release_reserved=True)
        assert tuple(conn.execute("SELECT * FROM job_stage_states WHERE stage='cover'").fetchone()) == before


def test_idle_recovery_releases_its_frozen_unstarted_cover_reservation(owned):
    conn, job_id, _ = owned
    workflow_id = "prepare-auto-local-cover-" + "a" * 24
    metadata = {
        "workflowId": workflow_id,
        "automaticPreparation": {"workflowId": workflow_id, "stage": "cover", "jobIds": [str(job_id)], "minScore": 7},
    }
    conn.execute(
        "UPDATE job_stage_states SET state='queued',metadata_json=? WHERE stage='cover'", (json.dumps(metadata),)
    )
    conn.commit()
    reconcile_cover_letter_policy(conn, tenant_id=TENANT)
    assert conn.execute("SELECT state FROM job_stage_states WHERE stage='cover'").fetchone()[0] == "queued"
    reconcile_cover_letter_policy(conn, tenant_id=TENANT, release_reserved=True)
    row = conn.execute("SELECT state,metadata_json,attempt_count FROM job_stage_states WHERE stage='cover'").fetchone()
    assert row["state"] == "skipped" and row["attempt_count"] == 0
    assert json.loads(row["metadata_json"])["releasedAutomaticPreparation"] == metadata["automaticPreparation"]
    assert "automaticPreparation" not in json.loads(row["metadata_json"])


@pytest.mark.parametrize("state", ["succeeded", "pending"])
def test_disablement_preserves_accepted_letter_and_terminalizes_unstarted_refresh(owned, tmp_path, state):
    conn, job_id, _ = owned
    repository = SqliteMaterialsRepository(conn)
    materials = repository.load_current_approved(TENANT, job_id)
    path = tmp_path / "accepted-letter.txt"
    path.write_text("Owned accepted synthetic text")
    repository.save(
        materials.with_cover_letter(
            Artifact.create(
                type=ArtifactType.COVER_LETTER,
                path=str(path),
                created_at="2026-01-01T00:00:00Z",
                render_format=RenderFormat.TEXT,
            ),
            validation=ValidationResult.success(),
            updated_at="2026-01-01T00:00:00Z",
        )
    )
    conn.execute("UPDATE job_stage_states SET state=? WHERE stage='cover'", (state,))
    conn.commit()
    before = [tuple(row) for row in conn.execute("SELECT * FROM job_materials_artifacts")]
    reconcile_cover_letter_policy(conn, tenant_id=TENANT)
    assert [tuple(row) for row in conn.execute("SELECT * FROM job_materials_artifacts")] == before
    assert path.read_text() == "Owned accepted synthetic text"
    assert conn.execute("SELECT state FROM job_stage_states WHERE stage='cover'").fetchone()[0] == (
        "succeeded" if state == "succeeded" else "skipped"
    )


def test_new_resume_only_plan_is_frozen_with_distinct_identity(owned):
    _, job_id, path = owned

    def build():
        return preparation.build_preparation_workflow_spec(
            tenant_id=TENANT,
            job_id=job_id,
            steps=["score", "tailor", "cover", "pdf"],
            kind=PreparationWorkItemKind.SCORE_JOB,
            target_version=1,
            source_event_id="owned-event",
        )

    off = build()
    assert off.args[0].steps == ["score", "tailor", "pdf"]
    path.write_text('{"cover_letter_generation":true}')
    on = build()
    assert on.args[0].steps == ["score", "tailor", "cover", "pdf"]
    assert off.workflow_id != on.workflow_id
    assert off.args[0].steps == ["score", "tailor", "pdf"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "reason,pdf_runs", [("cover_letter_generation_disabled", True), ("manual_apply_decline", False)]
)
async def test_optional_skip_allows_pdf_but_other_skips_keep_original_semantics(owned, monkeypatch, reason, pdf_runs):
    _, job_id, _ = owned
    called = []

    async def execute(fn, payload, **kwargs):
        called.append(fn.__name__)
        return SimpleNamespace(status="skipped" if fn.__name__ == "cover_letter_activity" else "ok", reason=reason)

    monkeypatch.setattr(prep_workflow.workflow, "execute_activity", execute)
    result = await prep_workflow.JobPreparationWorkflow()._execute_steps(
        prep_workflow.JobPreparationInput(
            tenant_id=str(TENANT),
            job_id=job_id,
            steps=["tailor", "cover", "pdf"],
            target_version="1",
            idempotency_key="preparation:owned",
        )
    )
    assert ("render_pdf_activity" in called) is pdf_runs
    assert result.steps_completed == (["tailor", "pdf"] if pdf_runs else ["tailor"])
    assert result.steps_skipped == ["cover"] and not result.steps_failed


@pytest.mark.asyncio
@pytest.mark.parametrize("enabled,legacy_plan", [(False, False), (False, True), (True, False)])
async def test_real_temporal_preparation_finishes_pdf_and_replays(owned, monkeypatch, enabled, legacy_plan):
    """Use a real worker/history, including the real disabled Cover admission."""
    import asyncio
    import uuid
    from temporalio import activity
    from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker
    from jobctrl import database
    from jobctrl.materials.activities import cover_letter_activity
    from tests.temporal_env import time_skipping_env
    from tests.test_workflow_job_preparation import _check_spend_budget

    conn, job_id, path = owned
    path.write_text(json.dumps({"cover_letter_generation": enabled}))
    # Production activity threads own their connection. Never share the fixture's
    # main-thread connection with a Temporal executor.
    monkeypatch.setattr(cover_letter, "get_connection", database.get_connection)
    monkeypatch.setattr(
        cover_letter, "_build_use_case", lambda **kwargs: pytest.fail("disabled letter invoked a model")
    )
    calls = []

    @activity.defn(name="record_workflow_started")
    async def record_started(_payload):
        return None

    @activity.defn(name="record_workflow_outcome")
    async def record_outcome(_payload):
        return None

    @activity.defn(name="tailor_job")
    async def tailor(_payload):
        calls.append("tailor")
        return {"status": "ok"}

    @activity.defn(name="cover_letter")
    async def enabled_cover(_payload):
        calls.append("cover")
        return {"status": "ok"}

    @activity.defn(name="render_pdf")
    async def pdf(_payload):
        calls.append("pdf")
        return {"status": "ok"}

    spec = preparation.build_preparation_workflow_spec(
        tenant_id=TENANT,
        job_id=job_id,
        steps=["tailor", "cover", "pdf"],
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=1,
        source_event_id="owned-temporal",
    )
    payload = spec.args[0]
    if legacy_plan:
        from dataclasses import replace

        payload = replace(payload, steps=["tailor", "cover", "pdf"])
    async with time_skipping_env() as env:
        queue = "cover-policy-" + uuid.uuid4().hex
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[prep_workflow.JobPreparationWorkflow],
            activities=[
                _check_spend_budget,
                record_started,
                record_outcome,
                tailor,
                pdf,
                enabled_cover if enabled else cover_letter_activity,
            ],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            handle = await env.client.start_workflow(
                prep_workflow.JobPreparationWorkflow.run,
                payload,
                id=queue,
                task_queue=queue,
            )
            result = await asyncio.wait_for(handle.result(), timeout=30)
            history = await handle.fetch_history()
        await Replayer(
            workflows=[prep_workflow.JobPreparationWorkflow], workflow_runner=UnsandboxedWorkflowRunner()
        ).replay_workflow(history)
    assert calls == (["tailor", "cover", "pdf"] if enabled else ["tailor", "pdf"])
    assert not result.steps_failed and not result.failure
    assert result.steps_completed == calls
    assert result.steps_skipped == (["cover"] if legacy_plan else [])
    scheduled = [
        event.activity_task_scheduled_event_attributes.activity_type.name
        for event in history.events
        if event.HasField("activity_task_scheduled_event_attributes")
    ]
    assert ("cover_letter" in scheduled) is (enabled or legacy_plan)
    assert "render_pdf" in scheduled
    if legacy_plan:
        row = conn.execute("SELECT state,error_code,attempt_count FROM job_stage_states WHERE stage='cover'").fetchone()
        assert tuple(row) == ("skipped", COVER_LETTER_DISABLED, 0)
