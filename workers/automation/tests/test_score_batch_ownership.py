"""Batch Score must share the direct scorer's admission and publication fences."""

from __future__ import annotations

import asyncio
import sqlite3
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl.domain.scoring import ScoringCriteria
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost
from jobctrl.scoring import scorer
from jobctrl.scoring.activities import ScoreActivityInput, _run_selected_scores
from jobctrl.state import ensure_job_stage_rows, set_stage_state
from .test_scorer import (
    _ScriptedLlm,
    _job_id,
    _seed_pending_job_with_description,
    _stub_default_analyzer as _stub_default_analyzer,
    conn as conn,
    determination_ports as determination_ports,
    profile_snapshot as profile_snapshot,
)

_GOOD = dict(
    score=8, technical_fit=8, experience_fit=8, role_fit=8, keywords=["Python"], reasoning="Synthetic decision."
)
_FOREIGN = "https://example.test/owned"
_PEER = "https://example.test/independent"


def _seed(conn, url):
    _seed_pending_job_with_description(
        conn,
        url=url,
        title="Role " + url.rsplit("/", 1)[1],
        description="Need Python.",
        discovered_at="2026-10-23T00:00:00Z",
    )
    ensure_job_stage_rows(conn, _job_id(url), tenant_id=LOCAL_TENANT)
    conn.commit()


def _row(conn, url):
    return tuple(
        conn.execute(
            "SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='score'",
            (str(LOCAL_TENANT), str(_job_id(url))),
        ).fetchone()
    )


def _foreign(conn, url, state, *, reserved=False):
    meta = (
        {"automaticPreparation": {"workflowId": "reserved-workflow"}}
        if reserved
        else {"activityOwner": "successor-run"}
    )
    set_stage_state(
        conn,
        _job_id(url),
        "score",
        state,
        tenant_id=LOCAL_TENANT,
        attempt_count=2,
        metadata=meta,
        validate_transition=False,
    )
    conn.commit()


def _run(conn, monkeypatch, profile_snapshot, llm, **kwargs):
    monkeypatch.setattr(scorer, "get_connection", lambda: conn)
    return scorer.run_scoring(
        profile_snapshot=profile_snapshot,
        resume_text="Synthetic Python engineer.",
        criteria=ScoringCriteria(),
        llm_port=llm,
        require_employer_analysis=False,
        workflow_id="continuation-run",
        **kwargs,
    )


@pytest.mark.parametrize(
    "state,reserved", [("pending", False), ("queued", False), ("queued", True), ("running", False), ("canceled", False)]
)
@pytest.mark.parametrize("accepted", [False, True])
def test_global_sweep_preserves_owned_or_stopped_job_and_scores_peer(
    conn, monkeypatch, profile_snapshot, state, reserved, accepted
):
    _seed(conn, _FOREIGN)
    if accepted:
        assert _run(conn, monkeypatch, profile_snapshot, _ScriptedLlm(_GOOD))["scored"] == 1
    _foreign(conn, _FOREIGN, state, reserved=reserved)
    before = _row(conn, _FOREIGN)
    scores = [tuple(r) for r in conn.execute("SELECT * FROM job_scores WHERE job_id=?", (str(_job_id(_FOREIGN)),))]
    _seed(conn, _PEER)
    llm = _ScriptedLlm(_GOOD, _GOOD)
    result = _run(conn, monkeypatch, profile_snapshot, llm, rescore=accepted)
    assert _row(conn, _FOREIGN) == before
    assert [
        tuple(r) for r in conn.execute("SELECT * FROM job_scores WHERE job_id=?", (str(_job_id(_FOREIGN)),))
    ] == scores
    assert llm.calls == 1
    assert result["scored"] == 1 and result["errors"] == 0
    assert result["scoredJobIds"] == [str(_job_id(_PEER))]


def test_global_sweep_rechecks_other_writer_at_locked_admission(conn, monkeypatch, profile_snapshot):
    from jobctrl.enrichment import availability

    _seed(conn, _FOREIGN)
    _seed(conn, _PEER)
    original = availability.require_fresh_active
    before = []

    def acquire(jid, **kwargs):
        result = original(jid, **kwargs)
        if jid == str(_job_id(_FOREIGN)) and not before:
            other = sqlite3.connect(conn.execute("PRAGMA database_list").fetchone()[2])
            other.row_factory = sqlite3.Row
            _foreign(other, _FOREIGN, "running")
            before.append(_row(other, _FOREIGN))
            other.close()
        return result

    monkeypatch.setattr(availability, "require_fresh_active", acquire)
    llm = _ScriptedLlm(_GOOD, _GOOD)
    result = _run(conn, monkeypatch, profile_snapshot, llm)
    assert before and _row(conn, _FOREIGN) == before[0]
    assert llm.calls == 1 and result["scored"] == 1 and result["errors"] == 0


def test_global_score_cannot_publish_or_terminalize_after_owner_changes(conn, monkeypatch, profile_snapshot):
    _seed(conn, _FOREIGN)
    _seed(conn, _PEER)
    before = []
    db_path = conn.execute("PRAGMA database_list").fetchone()[2]

    class ChangeOwner(_ScriptedLlm):
        def chat_json(self, messages, **kwargs):
            result = super().chat_json(messages, **kwargs)
            if not before:
                other = sqlite3.connect(db_path)
                other.row_factory = sqlite3.Row
                _foreign(other, _FOREIGN, "running")
                before.append(_row(other, _FOREIGN))
                other.close()
            return result

    llm = ChangeOwner(_GOOD, _GOOD)
    result = _run(conn, monkeypatch, profile_snapshot, llm, workers=1)
    assert before and _row(conn, _FOREIGN) == before[0]
    assert conn.execute("SELECT COUNT(*) FROM job_scores WHERE job_id=?", (str(_job_id(_FOREIGN)),)).fetchone()[0] == 0
    assert result["scored"] == 1 and result["errors"] == 0
    assert result["scoredJobIds"] == [str(_job_id(_PEER))]


@pytest.mark.parametrize("workers", [1, 3])
def test_selected_batch_skips_lost_owner_and_finishes_independent_jobs(monkeypatch, workers):
    ids = tuple(_job_id("https://example.test/selected/" + str(i)) for i in range(3))
    calls = []

    def score(jid, **kwargs):
        calls.append(jid)
        if jid == ids[0]:
            raise PreparationReservationLost("Synthetic successor acquired this row")
        return SimpleNamespace(ok=True, error=None, retained=False)

    monkeypatch.setattr(scorer, "score_job_by_id", score)
    monkeypatch.setattr(
        "jobctrl.pipeline.automatic_preparation.automatic_recovery_job_ids", lambda payload, stage: payload.job_ids
    )
    result = _run_selected_scores(
        ScoreActivityInput(
            tenant_id="local",
            job_ids=ids,
            workers=workers,
            workflow_id="old-run",
            recovery_workflow_id="reservation-workflow",
        )
    )
    assert set(calls) == set(ids)
    assert result["status"] == "ok" and result["errors"] == {}
    assert result["stages"][0]["scored"] == 2
    assert result["stages"][0]["skipped"] == 1
    assert result["stages"][0]["skippedJobIds"] == [str(ids[0])]


def test_selected_batch_does_not_hide_unrelated_exception(monkeypatch):
    jid = _job_id("https://example.test/structural-error")

    def fail(*args, **kwargs):
        raise ValueError("Synthetic structural failure")

    monkeypatch.setattr(scorer, "score_job_by_id", fail)
    monkeypatch.setattr(
        "jobctrl.pipeline.automatic_preparation.automatic_recovery_job_ids", lambda payload, stage: payload.job_ids
    )
    with pytest.raises(ValueError, match="Synthetic structural failure"):
        _run_selected_scores(ScoreActivityInput(tenant_id="local", job_ids=(jid,), workflow_id="old-run"))


def test_duplicate_still_finishes_when_shared_donor_loses_ownership(conn, monkeypatch, profile_snapshot):
    for url, day in [(_FOREIGN, "23"), (_PEER, "22")]:
        _seed_pending_job_with_description(
            conn, url=url, title="Same role", description="Need Python.", discovered_at=f"2026-10-{day}T00:00:00Z"
        )
        ensure_job_stage_rows(conn, _job_id(url), tenant_id=LOCAL_TENANT)
    conn.commit()
    db_path = conn.execute("PRAGMA database_list").fetchone()[2]
    before = []

    class ChangeDonor(_ScriptedLlm):
        def chat_json(self, messages, **kwargs):
            result = super().chat_json(messages, **kwargs)
            if not before:
                other = sqlite3.connect(db_path)
                other.row_factory = sqlite3.Row
                _foreign(other, _FOREIGN, "running")
                before.append(_row(other, _FOREIGN))
                other.close()
            return result

    llm = ChangeDonor(_GOOD, _GOOD)
    result = _run(conn, monkeypatch, profile_snapshot, llm)
    assert _row(conn, _FOREIGN) == before[0]
    assert conn.execute("SELECT COUNT(*) FROM job_scores WHERE job_id=?", (str(_job_id(_FOREIGN)),)).fetchone()[0] == 0
    assert result["scored"] == 1 and result["errors"] == 0 and result["skipped"] == 1
    assert result["scoredJobIds"] == [str(_job_id(_PEER))]
    assert conn.execute(
        "SELECT state,attempt_count FROM job_stage_states WHERE job_id=? AND stage='score'", (str(_job_id(_PEER)),)
    ).fetchone()[:] == ("succeeded", 1)
    assert llm.calls == 2


def test_global_batch_still_reports_real_provider_failure_and_finishes_peer(conn, monkeypatch, profile_snapshot):
    _seed(conn, _FOREIGN)
    _seed(conn, _PEER)

    class ProviderFailure(_ScriptedLlm):
        def chat_json(self, messages, **kwargs):
            if self.calls == 0:
                self.calls += 1
                raise RuntimeError("Synthetic provider unavailable")
            return super().chat_json(messages, **kwargs)

    result = _run(conn, monkeypatch, profile_snapshot, ProviderFailure(_GOOD), workers=1)
    assert result["scored"] == 1 and result["errors"] == 1 and result["skipped"] == 0
    states = [r[0] for r in conn.execute("SELECT state FROM job_stage_states WHERE stage='score'")]
    assert states.count("succeeded") == 1 and sum(s in ("failed", "blocked") for s in states) == 1


def test_global_terminal_write_cannot_replace_successor_after_valid_publication(conn, monkeypatch, profile_snapshot):
    _seed(conn, _FOREIGN)
    before = []

    class Publisher:
        def publish(self, event):
            _foreign(conn, _FOREIGN, "running")
            before.append(_row(conn, _FOREIGN))

    result = _run(conn, monkeypatch, profile_snapshot, _ScriptedLlm(_GOOD), publisher=Publisher())
    assert before and _row(conn, _FOREIGN) == before[0]
    # The publication preceded the successor and remains accepted; only the stale
    # terminal write is denied. No accepted result is removed on handoff.
    assert conn.execute("SELECT COUNT(*) FROM job_scores").fetchone()[0] == 1
    assert result["scored"] == 0 and result["errors"] == 0 and result["skipped"] == 1


def test_selected_batch_reports_real_job_failure_while_retaining_other_results(monkeypatch):
    ids = tuple(_job_id("https://example.test/results/" + str(i)) for i in range(2))

    def score(jid, **kwargs):
        return SimpleNamespace(ok=jid != ids[0], error="Synthetic real failure" if jid == ids[0] else None, retained=False)

    monkeypatch.setattr(scorer, "score_job_by_id", score)
    monkeypatch.setattr(
        "jobctrl.pipeline.automatic_preparation.automatic_recovery_job_ids", lambda payload, stage: payload.job_ids
    )
    result = _run_selected_scores(
        ScoreActivityInput(tenant_id="local", job_ids=ids, workers=2, workflow_id="batch-run")
    )
    assert result["status"] == "failed" and result["errors"] == {str(ids[0]): "Synthetic real failure"}
    assert result["stages"][0]["scored"] == 1 and result["stages"][0]["skipped"] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["global", "selected", "global_failure"])
async def test_actual_score_workflow_preserves_ownership_and_replays(conn, monkeypatch, profile_snapshot, mode):
    import uuid
    from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker
    from jobctrl import database
    from jobctrl.infrastructure.temporal.finalize import record_workflow_started, record_workflow_outcome
    from jobctrl.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput
    from jobctrl.infrastructure.preparation_recovery import recover_preparation_state_activity
    from jobctrl.scoring.activities import score_activity
    from .temporal_env import time_skipping_env
    from .test_workflow_job_preparation import _check_spend_budget

    selected = mode == "selected"
    provider_failure = mode == "global_failure"
    path = conn.execute("PRAGMA database_list").fetchone()[2]
    monkeypatch.setattr(database, "DB_PATH", Path(path))
    _seed(conn, _FOREIGN)
    _seed(conn, _PEER)
    _foreign(conn, _FOREIGN, "running")
    if provider_failure:
        _seed(conn, "https://example.test/another-independent")
    before = _row(conn, _FOREIGN)
    queue = "score-ownership-" + uuid.uuid4().hex
    wid = "score-ownership-workflow-" + uuid.uuid4().hex
    if selected:

        def revoked_or_peer(jid, **kwargs):
            if jid == _job_id(_FOREIGN):
                raise PreparationReservationLost("Synthetic successor already owns job")
            return SimpleNamespace(ok=True, error=None, retained=False)

        monkeypatch.setattr(scorer, "score_job_by_id", revoked_or_peer)
    else:
        real_global_score = scorer.run_scoring

        class OneProviderFailure(_ScriptedLlm):
            def chat_json(self, messages, **kwargs):
                if self.calls == 0:
                    self.calls += 1
                    raise RuntimeError("Synthetic provider unavailable")
                return super().chat_json(messages, **kwargs)

        def global_score(**kwargs):
            return real_global_score(
                profile_snapshot=profile_snapshot,
                resume_text="Synthetic Python engineer.",
                criteria=ScoringCriteria(),
                llm_port=OneProviderFailure(_GOOD) if provider_failure else _ScriptedLlm(_GOOD),
                require_employer_analysis=False,
                **kwargs,
            )

        monkeypatch.setattr(scorer, "run_scoring", global_score)
    async with time_skipping_env() as env:
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[JobPipelineWorkflow],
            activities=[
                score_activity,
                _check_spend_budget,
                record_workflow_started,
                record_workflow_outcome,
                recover_preparation_state_activity,
            ],
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            handle = await env.client.start_workflow(
                JobPipelineWorkflow.run,
                JobPipelineWorkflowInput(
                    tenant_id="local",
                    stages=["score"],
                    workers=2,
                    job_ids=(_job_id(_FOREIGN), _job_id(_PEER)) if selected else (),
                ),
                id=wid,
                task_queue=queue,
            )
            result = await asyncio.wait_for(handle.result(), timeout=20)
            history = await handle.fetch_history()
            if provider_failure:
                assert result.stages_failed == ["score"] and result.error_code is not None
            else:
                assert result.stages_completed == ["score"] and not result.stages_failed and result.error_code is None
        await Replayer(workflows=[JobPipelineWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(
            history
        )
    assert _row(conn, _FOREIGN) == before
    failures = [
        e
        for e in history.events
        if e.HasField("activity_task_failed_event_attributes")
        or e.HasField("activity_task_timed_out_event_attributes")
        or e.HasField("workflow_task_failed_event_attributes")
    ]
    if provider_failure:
        assert failures
        assert not any(e.HasField("workflow_task_failed_event_attributes") for e in failures)
    else:
        assert failures == []
    starts = [
        e.activity_task_started_event_attributes
        for e in history.events
        if e.HasField("activity_task_started_event_attributes")
    ]
    assert starts
    if not provider_failure:
        assert all(e.attempt == 1 and not e.HasField("last_failure") for e in starts)
    else:
        assert max(e.attempt for e in starts) <= 3
    if not selected:
        assert conn.execute("SELECT COUNT(*) FROM job_scores").fetchone()[0] == 1


@pytest.mark.parametrize("detail", ["Synthetic real failure", "semantic_determination:source_schema_violation"])
def test_global_pipeline_does_not_report_success_when_score_jobs_failed(monkeypatch, detail):
    from jobctrl.pipeline.runner import _run_score
    from jobctrl.domain.errors import LlmTransientError
    from jobctrl.domain.determinations import DeterminationFailure

    monkeypatch.setattr(
        scorer,
        "run_scoring",
        lambda **kwargs: dict(
            scored=1,
            errors=1,
            elapsed=0.0,
            distribution=[],
            scoredJobIds=[str(_job_id(_PEER))],
            errorDetails={str(_job_id(_FOREIGN)): detail},
        ),
    )
    if detail.startswith("semantic_determination:"):
        with pytest.raises(DeterminationFailure, match="source_schema_violation"):
            _run_score(workflow_id="pipeline-run")
    else:
        with pytest.raises(LlmTransientError, match="1 scoring error"):
            _run_score(workflow_id="pipeline-run")


@pytest.mark.parametrize("entry", ["global", "selected"])
@pytest.mark.parametrize("accepted", [False, True])
@pytest.mark.parametrize("provider_failure", [False, True])
def test_cooperative_batch_cancellation_preserves_accepted_results(
    conn, monkeypatch, profile_snapshot, entry, accepted, provider_failure
):
    from jobctrl.domain.errors import LlmTransientError
    from jobctrl.pipeline.runner import _run_score

    _seed(conn, _FOREIGN)
    if accepted:
        assert _run(conn, monkeypatch, profile_snapshot, _ScriptedLlm(_GOOD))["scored"] == 1
    baseline = [tuple(row) for row in conn.execute("SELECT * FROM job_scores")]
    baseline_events = conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE event_type IN ('StageCompleted','StageFailed')"
    ).fetchone()[0]
    canceled = threading.Event()

    class StopAfterInference(_ScriptedLlm):
        def chat_json(self, messages, **kwargs):
            result = super().chat_json(messages, **kwargs)
            canceled.set()
            if provider_failure:
                raise RuntimeError("Synthetic failure after cancellation")
            return result

    llm = StopAfterInference(_GOOD)
    options = dict(profile_snapshot=profile_snapshot, resume_text="Synthetic Python engineer.",
                   criteria=ScoringCriteria(), llm_port=llm, require_employer_analysis=False)
    monkeypatch.setattr(scorer, "get_connection", lambda: conn)
    if entry == "global":
        real = scorer.run_scoring
        monkeypatch.setattr(scorer, "run_scoring", lambda **kwargs: real(**kwargs, **options))
        def call():
            return _run_score(workflow_id="canceled-refresh-run", cancel_event=canceled, rescore=accepted)
    else:
        real = scorer.score_job_by_id
        monkeypatch.setattr(scorer, "score_job_by_id", lambda jid, **kwargs: real(jid, **kwargs, **options))
        def call():
            return _run_selected_scores(
                ScoreActivityInput(tenant_id="local", job_ids=(_job_id(_FOREIGN),),
                                   workflow_id="canceled-refresh-run", rescore=accepted),
                cancel_event=canceled,
            )
    with pytest.raises(LlmTransientError, match="canceled"):
        call()
    assert canceled.is_set()
    assert [tuple(row) for row in conn.execute("SELECT * FROM job_scores")] == baseline
    assert conn.execute(
        "SELECT COUNT(*) FROM job_events WHERE event_type IN ('StageCompleted','StageFailed')"
    ).fetchone()[0] == baseline_events
