"""Transport the accepted eligibility decision without another material dispatch."""
from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch
import uuid

import pytest
from temporalio import activity, workflow
from temporalio.converter import DataConverter
from temporalio.testing import ActivityEnvironment
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker

from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.scoring.use_cases import ScoreJobOutcome
from jobctrl.domain.scoring.value_objects import EligibilityAssessment, ScoreBreakdown
from jobctrl.llm import SpendBudgetStatus
from jobctrl.preparation import workflow as prep
from jobctrl.preparation.workflow import JobPreparationInput, JobPreparationWorkflow
from jobctrl.scoring.activities import ScoreJobActivityInput, ScoreJobActivityOutput, score_job_activity
from .temporal_env import time_skipping_env
from .test_automatic_preparation_temporal_qa import seed_for_stage, world as world

_JOB_ID = canonical_job_id("10000000-0000-4000-8000-000000000001")
_PATCH = "preparation-score-material-block-v1"


def _input(steps, **kwargs):
    return JobPreparationInput(tenant_id="local", job_id=_JOB_ID, steps=steps,
                               target_version="1", idempotency_key="synthetic", **kwargs)


@pytest.mark.asyncio
@pytest.mark.parametrize("eligibility,expected", [
    (EligibilityAssessment(status="blocked"), True),
    (EligibilityAssessment(status="eligible", hard_blockers=("Synthetic accepted constraint",)), True),
    (EligibilityAssessment(status="eligible"), False),
    (EligibilityAssessment(status="warning", warnings=("Synthetic uncertainty",)), False),
    (EligibilityAssessment(), False),
    (None, False),
])
async def test_score_activity_transports_existing_domain_predicate(monkeypatch, eligibility, expected):
    score = None if eligibility is None else SimpleNamespace(
        version=7, breakdown=ScoreBreakdown(eligibility=eligibility),
    )
    calls = []

    def accepted(job_id, **kwargs):
        calls.append((job_id, kwargs))
        return ScoreJobOutcome(ok=True, score=score)

    monkeypatch.setattr("jobctrl.scoring.scorer.score_job_by_id", accepted)
    result = await ActivityEnvironment().run(
        score_job_activity, ScoreJobActivityInput(tenant_id="local", job_id=_JOB_ID),
    )
    encoded = await DataConverter.default.encode([result])
    decoded, = await DataConverter.default.decode(encoded, [ScoreJobActivityOutput])
    assert decoded == result
    assert decoded.status == "ok"
    assert decoded.score_version == (7 if score else None)
    assert decoded.material_preparation_blocked is expected
    assert len(calls) == 1 and calls[0][0] == _JOB_ID


@pytest.mark.asyncio
async def test_legacy_score_activity_payload_defaults_to_unblocked():
    encoded = await DataConverter.default.encode([{"status": "ok", "score_version": 3}])
    decoded, = await DataConverter.default.decode(encoded, [ScoreJobActivityOutput])
    assert decoded.material_preparation_blocked is False
    assert decoded.score_version == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("steps,skipped", [
    (["score", "tailor", "cover", "pdf"], "tailor"),
    (["score", "cover", "pdf"], "cover"),
])
@pytest.mark.parametrize("override", [False, True])
async def test_known_hard_block_finishes_without_material_dispatch(monkeypatch, steps, skipped, override):
    calls = []

    async def execute(activity_fn, _payload, **_kwargs):
        calls.append(activity_fn.__name__)
        return ScoreJobActivityOutput(status="ok", score_version=1, material_preparation_blocked=True)

    monkeypatch.setattr(prep.workflow, "execute_activity", execute)
    monkeypatch.setattr(prep.workflow, "patched", lambda marker: marker == _PATCH)
    result = await JobPreparationWorkflow()._execute_steps(_input(steps, allow_low_fit_override=override))
    assert result.steps_completed == ["score"]
    assert result.steps_skipped == [skipped]
    assert result.steps_failed == [] and result.failure is None
    assert calls == ["score_job_activity"]


@pytest.mark.asyncio
@pytest.mark.parametrize("output", [
    {"status": "ok"},
    {"status": "ok", "material_preparation_blocked": False},
    {"status": "ok", "material_preparation_blocked": "true"},
    {"status": "ok", "material_preparation_blocked": 1},
    SimpleNamespace(status="ok"),
    SimpleNamespace(status="ok", material_preparation_blocked=False),
])
async def test_eligible_legacy_or_malformed_flag_retains_material_guards(monkeypatch, output):
    monkeypatch.setattr(prep.workflow, "patched", lambda _marker: True)
    calls = []

    async def execute(activity_fn, _payload, **_kwargs):
        calls.append(activity_fn.__name__)
        return output if len(calls) == 1 else {"status": "not_eligible"}

    monkeypatch.setattr(prep.workflow, "execute_activity", execute)
    result = await JobPreparationWorkflow()._execute_steps(_input(["score", "tailor", "cover", "pdf"]))
    assert result.steps_completed == ["score"] and result.steps_skipped == ["tailor"]
    assert calls == ["score_job_activity", "tailor_job_activity"]


@pytest.mark.asyncio
@pytest.mark.parametrize("steps", [["score"], ["pdf"], ["score", "pdf"], ["tailor", "cover", "pdf"]])
async def test_score_only_export_and_explicit_material_paths_stay_unchanged(monkeypatch, steps):
    monkeypatch.setattr(prep.workflow, "patched", lambda _marker: True)
    calls = []

    async def execute(activity_fn, _payload, **_kwargs):
        calls.append(activity_fn.__name__)
        return ScoreJobActivityOutput(status="ok", score_version=1, material_preparation_blocked=True)

    monkeypatch.setattr(prep.workflow, "execute_activity", execute)
    result = await JobPreparationWorkflow()._execute_steps(_input(steps, allow_low_fit_override=True))
    assert result.steps_completed == steps and result.steps_skipped == []
    assert len(calls) == len(steps)


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy,flag", [(True, True), (True, None), (False, True)])
async def test_old_and_new_command_histories_replay(monkeypatch, legacy, flag):
    names = []

    @activity.defn(name="record_workflow_started")
    async def started(_payload):
        return None

    @activity.defn(name="record_workflow_outcome")
    async def finished(_payload):
        return None

    @activity.defn(name="check_spend_budget")
    async def spend(_payload):
        return SpendBudgetStatus(day="2026-10-22", input_tokens=0, output_tokens=0, estimated_usd=0.0,
                                 daily_budget_usd=0.0, lane="scoring", lane_input_tokens=0,
                                 lane_output_tokens=0, lane_token_limit=0, lane_exceeded=False,
                                 global_exceeded=False, exceeded=False)

    @activity.defn(name="score_job")
    async def score(_payload):
        names.append("score")
        result = {"status": "ok", "score_version": 1}
        if flag is not None:
            result["material_preparation_blocked"] = flag
        return result

    @activity.defn(name="tailor_job")
    async def tailor(_payload):
        names.append("tailor")
        return {"status": "not_eligible"}

    original = workflow.patched

    def old_history(marker):
        return False if legacy and marker == _PATCH else original(marker)

    async with time_skipping_env() as env:
        queue = "score-block-replay-" + uuid.uuid4().hex
        with patch("temporalio.workflow.patched", side_effect=old_history):
            async with Worker(env.client, task_queue=queue, workflows=[JobPreparationWorkflow],
                              activities=[started, finished, spend, score, tailor],
                              workflow_runner=UnsandboxedWorkflowRunner()):
                handle = await env.client.start_workflow(
                    JobPreparationWorkflow.run, _input(["score", "tailor", "cover", "pdf"]),
                    id=queue, task_queue=queue,
                )
                result = await handle.result()
                history = await handle.fetch_history()
        assert result.steps_completed == ["score"] and result.steps_skipped == ["tailor"]
        assert names == (["score", "tailor"] if legacy else ["score"])
        scheduled = [e.activity_task_scheduled_event_attributes.activity_type.name
                     for e in history.events if e.HasField("activity_task_scheduled_event_attributes")]
        assert scheduled == (["score_job", "tailor_job"] if legacy else ["score_job"])
        await Replayer(workflows=[JobPreparationWorkflow],
                       workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(history)


@pytest.mark.asyncio
@pytest.mark.parametrize("intervening_change", ["newer_eligible", "profile_changed", "posting_changed"])
async def test_delayed_blocked_score_preserves_newer_or_stale_canonical_state(world, monkeypatch, intervening_change):
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.scoring import SqliteScoreRepository
    from jobctrl.pipeline.preparation import _derive_targets
    from jobctrl.state import reconcile_score_eligibility_blockers, set_stage_state

    job_id = seed_for_stage(world, 1, "tailor")
    seed_for_stage(world, 2, "cover")  # A peer's accepted material must survive.
    repository = SqliteScoreRepository(world.conn)
    initial = repository.load(LOCAL_TENANT, job_id)
    blocked = replace(initial, version=2, breakdown=replace(
        initial.breakdown, eligibility=EligibilityAssessment(status="blocked"),
    ))
    repository.save(blocked)
    reconcile_score_eligibility_blockers(world.conn, tenant_id=LOCAL_TENANT, job_id=job_id,
                                        eligibility_status="blocked", hard_blockers=[])
    world.conn.commit()
    before = {}
    tables = ("job_scores", "job_score_staleness", "job_stage_states", "job_materials_artifacts")

    def snapshot():
        return {table: [tuple(row) for row in world.conn.execute(f"SELECT * FROM {table}")]
                for table in tables}

    async def score_returns_after_concurrent_writer(_activity_fn, _payload, **_kwargs):
        if intervening_change == "newer_eligible":
            repository.save(replace(initial, version=3))
            reconcile_score_eligibility_blockers(world.conn, tenant_id=LOCAL_TENANT, job_id=job_id,
                                                eligibility_status="eligible", hard_blockers=[])
        else:
            set_stage_state(world.conn, job_id, "score", "stale", validate_transition=False)
            world.conn.execute(
                "INSERT INTO job_score_staleness "
                "(tenant_id,job_id,stale_reason,old_policy_version,new_policy_version,marked_at) "
                "VALUES ('local',?,?,1,2,'2026-10-22T00:00:00Z')", (str(job_id), intervening_change),
            )
        world.conn.commit()
        before.update(snapshot())
        return ScoreJobActivityOutput(status="ok", score_version=blocked.version, material_preparation_blocked=True)

    monkeypatch.setattr(prep.workflow, "execute_activity", score_returns_after_concurrent_writer)
    monkeypatch.setattr(prep.workflow, "patched", lambda marker: marker == _PATCH)
    result = await JobPreparationWorkflow()._execute_steps(JobPreparationInput(
        tenant_id="local", job_id=job_id, steps=["score", "tailor", "cover", "pdf"],
        target_version="1", idempotency_key="old-score-execution",
    ))
    assert result.steps_completed == ["score"] and result.steps_skipped == ["tailor"]
    assert snapshot() == before
    latest = repository.load(LOCAL_TENANT, job_id)
    assert latest.version == (3 if intervening_change == "newer_eligible" else 2)
    targets = _derive_targets(world.conn, tenant_id=LOCAL_TENANT, min_score=7)
    target = [candidate for candidate in targets if candidate.job_id == job_id]
    if intervening_change == "newer_eligible":
        assert len(target) == 1
        assert target[0].steps == ["tailor", "cover", "pdf"]
    else:
        assert target == []
        assert world.conn.execute(
            "SELECT COUNT(*) FROM job_score_staleness WHERE job_id=? AND resolved=0", (str(job_id),),
        ).fetchone()[0] == 1
    assert world.llm.calls == 0
