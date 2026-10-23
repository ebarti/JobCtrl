"""Literal manual declines fence automatic material work, without model judgments."""
from __future__ import annotations

import asyncio
import json
import sqlite3
import uuid
from types import SimpleNamespace

import pytest

from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.preparation_recovery import (
    PreparationReservationLost, claim_preparation_reservation, owns_preparation_reservation,
)
from jobctrl.pipeline import automatic_preparation as recovery
from jobctrl.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput
from jobctrl.state import ensure_job_stage_rows, set_stage_state
from tests.test_automatic_preparation import _stage
from tests.test_automatic_preparation_temporal_qa import (
    seed_for_stage, worker, world as world,
)
from tests.temporal_env import local_env


def _decline(conn, job_id, tenant="local"):
    # Exact current canonical fields from the manual mark-skipped write; it
    # deliberately preserves metadata that may belong to a previous policy.
    conn.execute(
        "UPDATE job_stage_states SET state='skipped', error_code=NULL, error_message=NULL, retryable=0 "
        "WHERE tenant_id=? AND job_id=? AND stage='apply'", (tenant, str(job_id)),
    )
    conn.commit()


def _payload(batch):
    return SimpleNamespace(recovery_workflow_id=batch.workflow_id, job_ids=batch.job_ids,
                           min_score=batch.min_score, tenant_id="local")


@pytest.mark.parametrize("stage", ["tailor", "cover"])
def test_manual_decline_excludes_new_automatic_materials_and_preserves_peer_and_accepted_work(world, stage):
    declined = seed_for_stage(world, 1, stage)
    peer = seed_for_stage(world, 2, stage)
    accepted_before = list(world.conn.execute("SELECT * FROM job_materials_artifacts"))
    attempts = _stage(world.conn, declined, stage)["attempt_count"]
    _decline(world.conn, declined)
    batch = recovery.reserve_recovery_batch(world.conn)
    assert batch.stage == stage and batch.job_ids == (peer,)
    assert _stage(world.conn, declined, stage)["attempt_count"] == attempts
    assert _stage(world.conn, declined, "apply")["state"] == "skipped"
    assert list(world.conn.execute("SELECT * FROM job_materials_artifacts")) == accepted_before
    assert world.llm.calls == 0


@pytest.mark.parametrize("shape,declined", [
    ("canonical", True), ("old_policy_metadata", True), ("policy", False),
    ("legacy", False), ("other_tenant", False), ("retryable_skip", False),
])
def test_only_current_canonical_manual_decline_controls_automatic_admission(world, shape, declined):
    job_id = seed_for_stage(world, 1, "tailor")
    if shape in {"old_policy_metadata", "policy"}:
        set_stage_state(world.conn, job_id, "apply", "skipped", error_code="MIN_SCORE", retryable=False,
                        metadata={"reason": "score_below_threshold"}, validate_transition=False)
        world.conn.commit()
    if shape in {"canonical", "old_policy_metadata"}:
        _decline(world.conn, job_id)
    elif shape == "legacy":
        world.conn.execute("UPDATE jobs SET apply_status='skipped' WHERE job_id=?", (str(job_id),))
    elif shape == "other_tenant":
        world.conn.execute(
            "INSERT INTO jobs (tenant_id,job_id,url,title,discovered_at) VALUES ('other',?,'https://example.test/other','Owned','2026-01-01')",
            (str(job_id),),
        )
        ensure_job_stage_rows(world.conn, job_id, tenant_id=TenantId("other"))
        _decline(world.conn, job_id, "other")
    elif shape == "retryable_skip":
        set_stage_state(world.conn, job_id, "apply", "skipped", retryable=True, validate_transition=False)
    world.conn.commit()
    batch = recovery.reserve_recovery_batch(world.conn)
    assert (batch is None) == declined
    if batch:
        assert batch.job_ids == (job_id,)
    else:
        set_stage_state(world.conn, job_id, "apply", "pending", retryable=True, validate_transition=False)
        world.conn.commit()
        assert recovery.reserve_recovery_batch(world.conn).job_ids == (job_id,)


@pytest.mark.parametrize("stage", ["tailor", "cover"])
@pytest.mark.parametrize("all_declined", [False, True])
def test_declined_frozen_reservations_release_only_unstarted_ownership_without_stalling_peers(world, stage, all_declined):
    first = seed_for_stage(world, 1, stage)
    second = seed_for_stage(world, 2, stage)
    original = recovery.reserve_recovery_batch(world.conn)
    assert original.job_ids == (first, second)
    _decline(world.conn, first)
    if all_declined:
        _decline(world.conn, second)
        other = seed_for_stage(world, 3, stage)
    resumed = recovery.reserve_recovery_batch(world.conn)
    if all_declined:
        assert resumed.job_ids == (other,) and resumed.workflow_id != original.workflow_id
    else:
        assert resumed == original  # Surviving rows retain the complete original frozen cohort.
        assert recovery.automatic_recovery_job_ids(_payload(original), stage) == (second,)
    released = _stage(world.conn, first, stage)
    assert released["state"] == "pending" and released["attempt_count"] == 0
    metadata = json.loads(released["metadata_json"])
    assert "automaticPreparation" not in metadata
    assert metadata["releasedAutomaticPreparation"]["workflowId"] == original.workflow_id
    assert _stage(world.conn, first, "apply")["state"] == "skipped"
    assert world.llm.calls == 0


@pytest.mark.parametrize("stage", ["tailor", "cover"])
def test_late_manual_decline_fences_locked_automatic_claim_and_leaves_foreground_contract(world, stage):
    job_id = seed_for_stage(world, 1, stage)
    batch = recovery.reserve_recovery_batch(world.conn)
    assert recovery.automatic_recovery_job_ids(_payload(batch), stage) == (job_id,)
    before = _stage(world.conn, job_id, stage)
    # An independent writer commits after the actual batch filter, before claim.
    with sqlite3.connect(world.path) as peer:
        _decline(peer, job_id)
    with pytest.raises(PreparationReservationLost):
        with claim_preparation_reservation(
            world.conn, tenant_id=LOCAL_TENANT, job_id=job_id, stage=stage,
            workflow_id=batch.workflow_id, cancel_event=None,
        ):
            pytest.fail("declined automatic work crossed its locked admission")
    assert _stage(world.conn, job_id, stage) == before
    assert not world.conn.in_transaction
    assert not owns_preparation_reservation(world.conn, tenant_id=LOCAL_TENANT, job_id=job_id,
                                           stage=stage, workflow_id=batch.workflow_id)
    with claim_preparation_reservation(
        world.conn, tenant_id=LOCAL_TENANT, job_id=job_id, stage=stage, workflow_id=None, cancel_event=None,
    ):
        pass  # Explicit foreground admission keeps its existing prerequisites.
    assert world.llm.calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["tailor", "cover"])
async def test_dispatched_declined_cohort_cannot_fall_back_to_unrelated_jobs(world, stage):
    job_id = seed_for_stage(world, 1, stage)
    batch = recovery.reserve_recovery_batch(world.conn)
    _decline(world.conn, job_id)
    peer = seed_for_stage(world, 2, stage)
    queue = f"qa-declined-{uuid.uuid4()}"
    async with local_env() as env:
        async with worker(env.client, queue):
            result = await asyncio.wait_for(env.client.execute_workflow(
                JobPipelineWorkflow.run,
                JobPipelineWorkflowInput(tenant_id="local", stages=[stage], job_ids=(job_id,),
                    expected_app_dir=str(world.app), expected_db_path=str(world.path), automatic_recovery=True),
                id=batch.workflow_id, task_queue=queue,
            ), 25)
        assert result.stages_completed == [stage]
    assert _stage(world.conn, job_id, stage)["attempt_count"] == 0
    assert _stage(world.conn, peer, stage)["state"] == "pending"
    assert world.llm.calls == 0 and world.scrape_calls == []


@pytest.mark.parametrize("stage", ["enrich", "score"])
def test_manual_application_decline_does_not_change_nonmaterial_recovery(world, stage):
    job_id = seed_for_stage(world, 1, stage)
    _decline(world.conn, job_id)
    batch = recovery.reserve_recovery_batch(world.conn)
    assert batch.stage == stage and batch.job_ids == (job_id,)


@pytest.mark.asyncio
async def test_decline_after_real_filter_skips_only_that_tailor_and_continues_peer(world, monkeypatch):
    from jobctrl.scoring import tailor
    from tests.test_v7_score_runtime import _profile_snapshot
    from tests.test_automatic_preparation_temporal_qa import tick, reserved_id

    declined = seed_for_stage(world, 1, "tailor")
    peer = seed_for_stage(world, 2, "tailor")
    original_filter = recovery.automatic_recovery_job_ids
    original_tailor = tailor.tailor_job_by_id
    calls = []

    def decline_after_filter(payload, stage):
        selected = original_filter(payload, stage)
        with sqlite3.connect(world.path) as writer:
            _decline(writer, declined)
        assert selected == (declined, peer)
        return selected

    def stop_at_generation(job, *args, **kwargs):
        calls.append(str(job["job_id"]))
        kwargs["commit_guard"]()
        raise RuntimeError("synthetic provider unavailable")

    def with_inputs(job_id, **kwargs):
        return original_tailor(job_id, **kwargs, snapshot=_profile_snapshot(LOCAL_TENANT), pdf_renderer=object())

    monkeypatch.setattr(recovery, "automatic_recovery_job_ids", decline_after_filter)
    monkeypatch.setattr(tailor, "_tailor_one_job", stop_at_generation)
    monkeypatch.setattr(tailor, "tailor_job_by_id", with_inputs)
    monkeypatch.setattr(tailor, "TAILORED_DIR", world.app / "tailored")
    queue = f"qa-decline-race-{uuid.uuid4()}"
    async with local_env() as env:
        assert await tick(env.client, world, queue) == 2
        workflow_id = reserved_id(world, peer, "tailor")
        async with worker(env.client, queue):
            await asyncio.wait_for(env.client.get_workflow_handle(workflow_id).result(), 25)
    assert calls == [str(peer)]
    assert _stage(world.conn, declined, "tailor")["attempt_count"] == 0
    assert _stage(world.conn, peer, "tailor")["attempt_count"] == 1
    assert _stage(world.conn, declined, "apply")["state"] == "skipped"
