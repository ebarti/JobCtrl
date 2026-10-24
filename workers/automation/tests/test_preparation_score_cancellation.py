"""Direct per-job scoring must respect cancellation and successor ownership."""

from __future__ import annotations

import asyncio
from datetime import timedelta
import json
import threading
import uuid
from unittest.mock import patch

import pytest
from temporalio import workflow
from temporalio.client import WorkflowFailureError
from temporalio.testing import ActivityEnvironment
from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker

from jobctrl.database import get_connection, init_db
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.preparation_recovery import (
    CancelPreparationStateInput,
    PreparationReservationLost,
    cancel_preparation_state_activity,
    cancel_preparation_state_rows,
)
from jobctrl.infrastructure.temporal.finalize import record_workflow_outcome, record_workflow_started
from jobctrl.preparation.workflow import JobPreparationInput, JobPreparationWorkflow
from jobctrl.scoring.activities import ScoreJobActivityInput, score_job_activity
from jobctrl.scoring import scorer
from jobctrl.state import ensure_job_stage_rows, reset_job_stage, set_stage_state
from .temporal_env import time_skipping_env
from .test_v7_score_runtime import (
    _JOB_ID_A,
    _StrongLlm,
    _TENANT_A,
    _profile_snapshot,
    _seed_target,
    conn as conn,
)
from .test_workflow_job_preparation import _check_spend_budget

_PATCH = "preparation-score-cancellation-v1"


def _score(conn, llm, **kwargs):
    from jobctrl.domain.scoring import ScoringCriteria

    options = dict(
        tenant_id=_TENANT_A,
        profile_snapshot=_profile_snapshot(_TENANT_A),
        resume_text="Synthetic Python engineer.",
        criteria=ScoringCriteria(),
        llm_port=llm,
        require_employer_analysis=False,
        workflow_id="direct-owner",
    )
    options.update(kwargs)
    return scorer.score_job_by_id(_JOB_ID_A, **options)


@pytest.mark.parametrize("state", ["canceled", "pending", "queued", "running"])
def test_direct_cold_entry_cannot_reclaim_stopped_or_foreign_work(conn, state):
    _seed_target(conn, tenant_id=_TENANT_A, job_id=_JOB_ID_A)
    owner = "direct-owner" if state == "canceled" else "successor-owner"
    ensure_job_stage_rows(conn, _JOB_ID_A, tenant_id=_TENANT_A)
    set_stage_state(
        conn,
        _JOB_ID_A,
        "score",
        state,
        tenant_id=_TENANT_A,
        metadata={"activityOwner": owner},
        validate_transition=False,
    )
    conn.commit()
    before = tuple(
        conn.execute(
            "SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='score'",
            (str(_TENANT_A), str(_JOB_ID_A)),
        ).fetchone()
    )
    llm = _StrongLlm()
    with pytest.raises(PreparationReservationLost):
        _score(conn, llm)
    assert (
        tuple(
            conn.execute(
                "SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='score'",
                (str(_TENANT_A), str(_JOB_ID_A)),
            ).fetchone()
        )
        == before
    )
    assert llm.calls == 0 and conn.execute("SELECT COUNT(*) FROM job_scores").fetchone()[0] == 0


@pytest.mark.parametrize("state", ["canceled", "queued", "running"])
def test_direct_cache_entry_preserves_stopped_or_foreign_state(conn, state):
    _seed_target(conn, tenant_id=_TENANT_A, job_id=_JOB_ID_A)
    assert _score(conn, _StrongLlm()).ok
    score = tuple(conn.execute("SELECT * FROM job_scores").fetchone())
    set_stage_state(
        conn,
        _JOB_ID_A,
        "score",
        state,
        tenant_id=_TENANT_A,
        attempt_count=2,
        metadata={"activityOwner": "successor-owner"},
        validate_transition=False,
    )
    conn.commit()
    before = tuple(
        conn.execute(
            "SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='score'",
            (str(_TENANT_A), str(_JOB_ID_A)),
        ).fetchone()
    )
    llm = _StrongLlm()
    with pytest.raises(PreparationReservationLost):
        _score(conn, llm)
    assert (
        tuple(
            conn.execute(
                "SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='score'",
                (str(_TENANT_A), str(_JOB_ID_A)),
            ).fetchone()
        )
        == before
    )
    assert tuple(conn.execute("SELECT * FROM job_scores").fetchone()) == score and llm.calls == 0


def test_new_explicit_owner_can_reuse_cache_without_another_attempt_or_rescore(conn):
    _seed_target(conn, tenant_id=_TENANT_A, job_id=_JOB_ID_A)
    assert _score(conn, _StrongLlm()).ok
    llm = _StrongLlm()
    assert _score(conn, llm, workflow_id="next-explicit-owner").ok
    assert llm.calls == 0
    assert (
        conn.execute(
            "SELECT attempt_count FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='score'",
            (str(_TENANT_A), str(_JOB_ID_A)),
        ).fetchone()[0]
        == 1
    )
    result = _score(conn, llm, workflow_id="next-explicit-owner", rescore=True)
    assert result.ok and result.score.version == 2


@pytest.mark.parametrize("stop", ["cancel", "reset", "successor"])
@pytest.mark.parametrize("result", ["success", "failure"])
def test_late_direct_score_cannot_publish_over_a_stop_or_successor(conn, stop, result):
    _seed_target(conn, tenant_id=_TENANT_A, job_id=_JOB_ID_A)
    stopped = []

    class HeldModel(_StrongLlm):
        def chat_json(self, messages, **kwargs):
            if not stopped:
                if stop == "cancel":
                    cancel_preparation_state_rows(
                        conn,
                        CancelPreparationStateInput(
                            tenant_id=str(_TENANT_A),
                            workflow_id="direct-owner",
                            stage="score",
                            job_ids=(str(_JOB_ID_A),),
                        ),
                    )
                elif stop == "reset":
                    reset_job_stage(conn, str(_JOB_ID_A), "score", tenant_id=_TENANT_A)
                else:
                    set_stage_state(
                        conn,
                        _JOB_ID_A,
                        "score",
                        "running",
                        tenant_id=_TENANT_A,
                        metadata={"activityOwner": "successor"},
                        validate_transition=False,
                    )
                    conn.commit()
                stopped.extend(
                    tuple(row)
                    for row in conn.execute(
                        "SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='score'",
                        (str(_TENANT_A), str(_JOB_ID_A)),
                    )
                )
            if result == "failure":
                raise RuntimeError("Synthetic model failure after ownership changed")
            return super().chat_json(messages, **kwargs)

    with pytest.raises(PreparationReservationLost):
        _score(conn, HeldModel())
    assert [
        tuple(row)
        for row in conn.execute(
            "SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='score'",
            (str(_TENANT_A), str(_JOB_ID_A)),
        )
    ] == stopped
    assert conn.execute("SELECT COUNT(*) FROM job_scores").fetchone()[0] == 0
    assert (
        conn.execute("SELECT COUNT(*) FROM job_events WHERE event_type IN ('StageCompleted','StageFailed')").fetchone()[
            0
        ]
        == 0
    )


def test_direct_owned_success_still_persists_score_and_attempt(conn):
    _seed_target(conn, tenant_id=_TENANT_A, job_id=_JOB_ID_A)
    outcome = _score(conn, _StrongLlm())
    assert outcome.ok and outcome.score.version == 1
    row = conn.execute(
        "SELECT state,attempt_count,metadata_json FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='score'",
        (str(_TENANT_A), str(_JOB_ID_A)),
    ).fetchone()
    assert tuple(row[:2]) == ("succeeded", 1)
    assert json.loads(row[2])["activityOwner"] == "direct-owner"


def test_late_analysis_failure_reports_owner_loss_and_preserves_cancellation(conn):
    from jobctrl.domain.scoring import ScoringCriteria

    _seed_target(conn, tenant_id=_TENANT_A, job_id=_JOB_ID_A)

    class FailedAnalysis:
        def execute(self, **kwargs):
            cancel_preparation_state_rows(
                conn,
                CancelPreparationStateInput(
                    tenant_id=str(_TENANT_A),
                    workflow_id="direct-owner",
                    stage="score",
                    job_ids=(str(_JOB_ID_A),),
                ),
            )
            raise RuntimeError("Synthetic analysis failure after cancellation")

    with pytest.raises(PreparationReservationLost):
        scorer.score_job_by_id(
            _JOB_ID_A,
            tenant_id=_TENANT_A,
            profile_snapshot=_profile_snapshot(_TENANT_A),
            resume_text="Synthetic engineer.",
            criteria=ScoringCriteria(),
            llm_port=_StrongLlm(),
            analyze_use_case=FailedAnalysis(),
            workflow_id="direct-owner",
        )
    row = conn.execute(
        "SELECT state,attempt_count FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='score'",
        (str(_TENANT_A), str(_JOB_ID_A)),
    ).fetchone()
    assert tuple(row) == ("canceled", 0)


@pytest.mark.asyncio
async def test_direct_score_activity_sets_its_cooperative_event_on_cancellation(monkeypatch):
    entered = threading.Event()
    stopped = threading.Event()

    def score(_payload, *, workflow_id=None, cancel_event=None):
        entered.set()
        assert cancel_event is not None
        assert cancel_event.wait(5), "activity cancellation did not reach its scoring thread"
        stopped.set()
        return {"status": "ok", "score_version": 1}

    monkeypatch.setattr("jobctrl.scoring.activities._score_one_job", score)
    env = ActivityEnvironment()
    task = asyncio.create_task(env.run(score_job_activity, ScoreJobActivityInput(tenant_id="local", job_id=_JOB_ID_A)))
    try:
        async with asyncio.timeout(5):
            while not entered.is_set():
                await asyncio.sleep(0.01)
        env.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert stopped.is_set()
    finally:
        if not task.done():
            task.cancel()


@pytest.mark.asyncio
async def test_direct_activity_owner_loss_is_skipped_without_retrying(monkeypatch):
    calls = []

    def revoked(*args, **kwargs):
        calls.append(True)
        raise PreparationReservationLost("Synthetic ownership revoked")

    monkeypatch.setattr(scorer, "score_job_by_id", revoked)
    result = await ActivityEnvironment().run(
        score_job_activity, ScoreJobActivityInput(tenant_id="local", job_id=_JOB_ID_A)
    )
    assert result.status == "skipped" and result.score_version is None
    assert calls == [True]


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy", [True, False])
async def test_real_score_cancel_histories_terminalize_owned_state_and_replay(monkeypatch, tmp_path, legacy):
    import jobctrl.database as database

    db = tmp_path / "score-cancel.db"
    monkeypatch.setattr(database, "DB_PATH", db)
    conn = init_db(db)
    _seed_target(conn, tenant_id=LOCAL_TENANT, job_id=_JOB_ID_A)
    config = tmp_path / "config.json"
    config.write_text(json.dumps({"daily_budget_usd": 0.0}))
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(config))
    started = threading.Event()
    released = threading.Event()
    force_release = threading.Event()
    from jobctrl.infrastructure.temporal import run_in_activity

    original_blocking = run_in_activity.run_blocking_with_heartbeat

    async def fast_heartbeat(fn, **kwargs):
        return await original_blocking(fn, poll_interval=0.05, **kwargs)

    monkeypatch.setattr(run_in_activity, "run_blocking_with_heartbeat", fast_heartbeat)

    def held(_payload, *, workflow_id=None, cancel_event=None):
        c = get_connection()
        ensure_job_stage_rows(c, _JOB_ID_A, tenant_id=LOCAL_TENANT)
        set_stage_state(
            c,
            _JOB_ID_A,
            "score",
            "running",
            tenant_id=LOCAL_TENANT,
            metadata={"activityOwner": workflow_id, "priorScoreVersion": 0, "rescore": False},
            validate_transition=False,
        )
        c.commit()
        started.set()
        assert cancel_event is not None
        while not cancel_event.is_set() and not force_release.wait(0.01):
            pass
        released.set()
        return {"status": "ok", "score_version": None}

    monkeypatch.setattr("jobctrl.scoring.activities._score_one_job", held)
    original = workflow.patched

    def old(marker):
        return False if legacy and marker == _PATCH else original(marker)

    queue = "score-cancel-" + uuid.uuid4().hex
    async with time_skipping_env() as env:
        with patch("temporalio.workflow.patched", side_effect=old):
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPreparationWorkflow],
                activities=[
                    _check_spend_budget,
                    record_workflow_started,
                    record_workflow_outcome,
                    score_job_activity,
                    cancel_preparation_state_activity,
                ],
                max_heartbeat_throttle_interval=timedelta(milliseconds=50),
                default_heartbeat_throttle_interval=timedelta(milliseconds=50),
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    JobPreparationWorkflow.run,
                    JobPreparationInput(
                        tenant_id="local",
                        job_id=_JOB_ID_A,
                        steps=["score", "tailor", "cover", "pdf"],
                        target_version="synthetic",
                        idempotency_key=queue,
                    ),
                    id=queue,
                    task_queue=queue,
                )
                async with asyncio.timeout(10):
                    while not started.is_set():
                        await asyncio.sleep(0.01)
                await handle.cancel()
                with pytest.raises(WorkflowFailureError):
                    await asyncio.wait_for(handle.result(), 10)
                if legacy:
                    force_release.set()
                async with asyncio.timeout(5):
                    while not released.is_set():
                        await asyncio.sleep(0.01)
                history = await handle.fetch_history()
        await Replayer(workflows=[JobPreparationWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(
            history
        )
    state = conn.execute(
        "SELECT state,error_code,attempt_count FROM job_stage_states WHERE tenant_id='local' AND job_id=? AND stage='score'",
        (str(_JOB_ID_A),),
    ).fetchone()
    assert tuple(state) == (("running", None, 0) if legacy else ("canceled", "WORKFLOW_CANCELED", 0))
    assert (
        conn.execute("SELECT status FROM workflow_run_projections WHERE workflow_id=?", (queue,)).fetchone()[0]
        == "canceled"
    )
    scheduled = [
        e.activity_task_scheduled_event_attributes.activity_type.name
        for e in history.events
        if e.HasField("activity_task_scheduled_event_attributes")
    ]
    assert not any(name in scheduled for name in ("tailor_job", "cover_letter", "render_pdf"))
