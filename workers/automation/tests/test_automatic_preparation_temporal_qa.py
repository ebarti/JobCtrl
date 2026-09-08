"""Operational recovery QA: real Temporal and canonical persistence, no providers."""

from __future__ import annotations

import asyncio
import json
import shutil
import threading
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from temporalio import activity
from temporalio.client import Client, WorkflowFailureError
from temporalio.exceptions import CancelledError
from temporalio.service import RPCError, RPCStatusCode
from temporalio.testing import WorkflowEnvironment
from temporalio.worker import Worker, UnsandboxedWorkflowRunner

from jobctrl import config, database
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.domain.scoring import ScoringCriteria
from jobctrl.domain.materials.use_cases import TailorResumeUseCase
from jobctrl.enrichment import detail
from jobctrl.enrichment.activities import enrich_activity, cancel_enrichment_cohort_activity
from jobctrl.infrastructure.preparation_recovery import (
    recover_preparation_state_activity,
    cancel_preparation_state_activity,
)
from jobctrl.infrastructure.scoring import SqliteScoreRepository, SqliteRequirementFitReportRepository
from jobctrl.infrastructure.materials import SqliteEmployerAnalysisRepository
from jobctrl.infrastructure.temporal.finalize import record_workflow_started, record_workflow_outcome
from jobctrl.infrastructure.temporal.run_in_activity import shutdown_activity_executors
from jobctrl.llm import check_spend_budget
from jobctrl.materials.activities import tailor_activity, cover_activity
from jobctrl.pipeline import automatic_preparation as recovery
from jobctrl.pipeline.workflow import JobPipelineWorkflow, JobPipelineWorkflowInput
from jobctrl.scoring import scorer, tailor
from jobctrl.scoring.activities import score_activity
from jobctrl.state import set_stage_state
from .temporal_env import local_env
from .test_automatic_preparation import _job, _stage
from .test_discover_reliability import _FakePlaywright, _long_description
from .test_v7_score_runtime import _StrongLlm, _profile_snapshot
from .test_scorer import _employer_analysis
from .politeness_helpers import offline_gateway

ACTIVITIES = [
    check_spend_budget,
    enrich_activity,
    score_activity,
    tailor_activity,
    cover_activity,
    cancel_enrichment_cohort_activity,
    recover_preparation_state_activity,
    cancel_preparation_state_activity,
    record_workflow_started,
    record_workflow_outcome,
]


@pytest.fixture
def world(tmp_path, monkeypatch):
    # All state and config belongs to a synthetic temporary sandbox.
    db_path = tmp_path / "jobctrl.db"
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    connection = database.init_db(db_path)
    original_start = WorkflowEnvironment.start_local
    monkeypatch.setattr(
        WorkflowEnvironment, "start_local", lambda: original_start(dev_server_existing_path=shutil.which("temporal"))
    )
    monkeypatch.setattr(detail, "sync_playwright", lambda: _FakePlaywright())
    monkeypatch.setattr(detail, "PolitenessGateway", offline_gateway)
    scrape_calls = []

    def synthetic_scrape(page, url, session=None):
        scrape_calls.append(url)
        return {
            "status": "ok",
            "tier_used": 1,
            "full_description": _long_description(),
            "application_url": "https://example.test/apply",
            "error": None,
            "elapsed": 0.01,
            "active_state": "active",
            "verification_method": "json_ld",
            "http_status": 200,
        }

    monkeypatch.setattr(detail, "scrape_detail_page", synthetic_scrape)
    llm = _StrongLlm()
    original_score = scorer.score_job_by_id

    def synthetic_score(job_id, **kwargs):
        return original_score(
            job_id,
            **kwargs,
            profile_snapshot=_profile_snapshot(LOCAL_TENANT),
            resume_text="Python platform engineer.",
            criteria=ScoringCriteria(),
            repository=SqliteScoreRepository(database.get_connection()),
            llm_port=llm,
            require_employer_analysis=False,
        )

    monkeypatch.setattr(scorer, "score_job_by_id", synthetic_score)
    yield SimpleNamespace(conn=connection, path=db_path, app=tmp_path, llm=llm, scrape_calls=scrape_calls)
    shutdown_activity_executors()
    database.close_connection(db_path)


def seed_for_stage(world, number, stage):
    from .test_v7_cover_runtime import _seed_eligible_score, _seed_approved_resume

    job_id = _job(world.conn, number=number, enriched=stage != "enrich")
    if stage == "enrich":
        world.conn.execute("UPDATE jobs SET site = 'RemoteOK' WHERE job_id=?", (str(job_id),))
        world.conn.execute(
            "INSERT INTO job_locators (tenant_id,job_id,locator_kind,locator_value,is_current,first_seen_at,last_seen_at) VALUES ('local',?,'posting_url',?,1,'2026-01-01','2026-01-01')",
            (str(job_id), f"https://example.test/jobs/{number}"),
        )
    if stage in {"tailor", "cover"}:
        _seed_eligible_score(world.conn, tenant_id=LOCAL_TENANT, job_id=job_id)
        set_stage_state(world.conn, job_id, "score", "succeeded", validate_transition=False)
    if stage == "cover":
        _seed_approved_resume(world.conn, world.app, tenant_id=LOCAL_TENANT, job_id=job_id)
        set_stage_state(world.conn, job_id, "tailor", "succeeded", validate_transition=False)
    world.conn.commit()
    return job_id


async def tick(client, world, queue):
    return await recovery.reconcile_automatic_preparation(
        client, task_queue=queue, expected_app_dir=str(world.app), expected_db_path=str(world.path)
    )


def worker(client, queue):
    return Worker(
        client,
        task_queue=queue,
        workflows=[JobPipelineWorkflow],
        activities=ACTIVITIES,
        workflow_runner=UnsandboxedWorkflowRunner(),
    )


def reserved_id(world, job_id, stage):
    return json.loads(_stage(world.conn, job_id, stage)["metadata_json"])["automaticPreparation"]["workflowId"]


async def wait_idle(client):
    for _ in range(100):
        if not [run async for run in client.list_workflows(query=recovery._ACTIVE_WORK)]:
            return
        await asyncio.sleep(0.1)
    raise AssertionError("Temporal visibility never became idle")


async def history_types(client, workflow_id):
    history = await client.get_workflow_handle(workflow_id).fetch_history()
    return [
        event.activity_task_scheduled_event_attributes.activity_type.name
        for event in history.events
        if event.HasField("activity_task_scheduled_event_attributes")
    ]


@pytest.mark.asyncio
async def test_recovery_enrichment_advances_to_real_score_after_worker_replacement(world):
    job_id = _job(world.conn)
    from jobctrl.domain.enrichment import JobEnrichment, ExtractionTier, EnrichmentError
    from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository

    failed = (
        JobEnrichment.empty(tenant_id=LOCAL_TENANT, job_id=job_id, updated_at="2026-01-01T00:00:00+00:00")
        .start_attempt(extraction_tier=ExtractionTier.JSON_LD, started_at="2026-01-01T00:00:00+00:00")
        .fail_attempt(
            error=EnrichmentError(code="DETAIL_ERROR", message="synthetic provider failure", retryable=True),
            finished_at="2026-01-01T00:00:01+00:00",
        )
    )
    SqliteEnrichmentRepository(world.conn).save(failed)
    world.conn.execute("UPDATE jobs SET site = 'RemoteOK' WHERE job_id = ?", (str(job_id),))
    world.conn.execute(
        "INSERT INTO job_locators (tenant_id,job_id,locator_kind,locator_value,is_current,first_seen_at,last_seen_at) VALUES ('local',?,'posting_url',?,1,'2026-01-01','2026-01-01')",
        (str(job_id), "https://example.test/jobs/1"),
    )
    world.conn.commit()
    queue = f"qa-recovery-{uuid.uuid4()}"
    async with local_env() as env:
        assert await tick(env.client, world, queue) == 1
        first_id = reserved_id(world, job_id, "enrich")
        async with worker(env.client, queue) as first_worker:
            result = await asyncio.wait_for(env.client.get_workflow_handle(first_id).result(), 25)
            assert result["stages_completed"] == ["enrich"], result
        assert first_worker.is_shutdown
        assert _stage(world.conn, job_id)["state"] == "succeeded"
        assert len(world.scrape_calls) == 1
        assert _stage(world.conn, job_id)["attempt_count"] == 2
        assert len(SqliteEnrichmentRepository(world.conn).load(LOCAL_TENANT, job_id).attempts) == 2
        await wait_idle(env.client)
        fresh_client = await Client.connect(env.client.service_client.config.target_host)
        assert await tick(fresh_client, world, queue) == 1
        score_id = reserved_id(world, job_id, "score")
        async with worker(fresh_client, queue) as second_worker:
            result = await asyncio.wait_for(fresh_client.get_workflow_handle(score_id).result(), 25)
            assert result["stages_completed"] == ["score"], result
        assert second_worker.is_shutdown
        assert _stage(world.conn, job_id, "score")["state"] == "succeeded"
        assert [
            tuple(r)
            for r in world.conn.execute("SELECT version,fit_score FROM job_scores WHERE job_id=?", (str(job_id),))
        ] == [(1, 8)]
        assert world.llm.calls == 1
        assert await history_types(fresh_client, first_id) == [
            "record_workflow_started",
            "check_spend_budget",
            "enrich",
            "record_workflow_outcome",
        ]
        assert await history_types(fresh_client, score_id) == [
            "record_workflow_started",
            "check_spend_budget",
            "score",
            "record_workflow_outcome",
        ]
        runs = [run async for run in fresh_client.list_workflows()]
        assert len(runs) == 2
        assert {r.workflow_type for r in runs} == {"JobPipelineWorkflow"}


@pytest.mark.asyncio
async def test_real_start_ack_loss_and_two_workers_reuse_one_score(world):
    job_id = _job(world.conn, enriched=True)
    queue = f"qa-ack-{uuid.uuid4()}"
    async with local_env() as env:

        class LostAck:
            def __getattr__(self, name):
                return getattr(env.client, name)

            async def start_workflow(self, *args, **kwargs):
                await env.client.start_workflow(*args, **kwargs)
                raise RPCError("synthetic lost start acknowledgement", RPCStatusCode.UNAVAILABLE, b"")

        with pytest.raises(RPCError):
            await tick(LostAck(), world, queue)
        workflow_id = reserved_id(world, job_id, "score")
        fresh_client = await Client.connect(env.client.service_client.config.target_host)
        assert await tick(fresh_client, world, queue) == 0
        async with worker(env.client, queue), worker(fresh_client, queue):
            result = await asyncio.wait_for(env.client.get_workflow_handle(workflow_id).result(), 25)
            assert result["stages_completed"] == ["score"], result
        assert world.llm.calls == 1
        assert world.conn.execute("SELECT count(*) FROM job_scores WHERE job_id=?", (str(job_id),)).fetchone()[0] == 1
        assert (await history_types(env.client, workflow_id)).count("score") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["enrich", "score", "tailor", "cover"])
async def test_canceled_reservation_does_not_fall_back_to_unrelated_work(world, stage):
    job_id = seed_for_stage(world, 1, stage)
    batch = recovery.reserve_recovery_batch(world.conn)
    assert batch.stage == stage
    # An actual frozen cohort is serialized; cancellation occurs before execution.
    from jobctrl.pipeline.workflow import JobPipelineWorkflowInput

    workflow_id = batch.workflow_id
    set_stage_state(world.conn, job_id, batch.stage, "canceled", validate_transition=False, retryable=False)
    other_id = seed_for_stage(world, 2, stage)
    world.conn.commit()
    queue = f"qa-empty-{uuid.uuid4()}"
    async with local_env() as env:
        async with worker(env.client, queue):
            result = await env.client.execute_workflow(
                JobPipelineWorkflow.run,
                JobPipelineWorkflowInput(
                    tenant_id="local",
                    stages=[stage],
                    job_ids=(job_id,),
                    expected_app_dir=str(world.app),
                    expected_db_path=str(world.path),
                    automatic_recovery=True,
                ),
                id=workflow_id,
                task_queue=queue,
            )
            assert result.stages_completed == [stage], result
        assert _stage(world.conn, job_id, batch.stage)["state"] == "canceled"
        assert _stage(world.conn, other_id, stage)["state"] == ("failed" if stage == "enrich" else "pending")
        assert world.llm.calls == 0
        assert world.scrape_calls == []


@pytest.mark.asyncio
async def test_automatic_score_uses_one_activity_attempt_and_preserves_ceiling(world, monkeypatch):
    job_id = _job(world.conn, enriched=True)
    set_stage_state(
        world.conn,
        job_id,
        "score",
        "failed",
        attempt_count=4,
        max_attempts=5,
        retryable=True,
        error_code="LLM_TRANSIENT",
        validate_transition=False,
    )
    world.conn.execute(
        "UPDATE job_stage_states SET updated_at='2026-01-01T00:00:00+00:00' WHERE job_id=?", (str(job_id),)
    )
    world.conn.commit()
    calls = []

    def fail_provider(*args, **kwargs):
        calls.append(1)
        raise RuntimeError("synthetic temporary LLM outage")

    monkeypatch.setattr(world.llm, "chat_json", fail_provider)
    queue = f"qa-limit-{uuid.uuid4()}"
    async with local_env() as env:
        assert await tick(env.client, world, queue) == 1
        workflow_id = reserved_id(world, job_id, "score")
        async with worker(env.client, queue):
            result = await asyncio.wait_for(env.client.get_workflow_handle(workflow_id).result(), 25)
            assert result["stages_failed"] == ["score"], result
        state = _stage(world.conn, job_id, "score")
        assert state["state"] == "failed", state
        assert state["attempt_count"] == 5, state
        assert len(calls) == 1
        assert (await history_types(env.client, workflow_id)).count("score") == 1
        await wait_idle(env.client)
        world.conn.execute(
            "UPDATE job_stage_states SET updated_at='2026-01-01T00:00:00+00:00' WHERE job_id=?", (str(job_id),)
        )
        world.conn.commit()
        assert await tick(env.client, world, queue) == 0
        assert _stage(world.conn, job_id, "score")["attempt_count"] == 5


@pytest.mark.asyncio
@pytest.mark.parametrize("committed,provider_fails", [(False, False), (False, True), (True, False)])
async def test_true_cancel_of_automatic_score_fences_uncommitted_and_retains_committed(
    world, monkeypatch, committed, provider_fails
):
    job_id = _job(world.conn, enriched=True)
    started = threading.Event()
    release = threading.Event()
    returned = threading.Event()
    original_score = scorer.score_job_by_id
    original_chat = world.llm.chat_json

    def wait_then_chat(*args, **kwargs):
        started.set()
        assert release.wait(25)
        try:
            if provider_fails:
                raise RuntimeError("synthetic late provider failure")
            return original_chat(*args, **kwargs)
        finally:
            returned.set()

    def commit_then_wait(*args, **kwargs):
        result = original_score(*args, **kwargs)
        started.set()
        assert release.wait(25)
        returned.set()
        return result

    if committed:
        monkeypatch.setattr(scorer, "score_job_by_id", commit_then_wait)
    else:
        monkeypatch.setattr(world.llm, "chat_json", wait_then_chat)
    queue = f"qa-cancel-{uuid.uuid4()}"
    async with local_env() as env:
        assert await tick(env.client, world, queue) == 1
        workflow_id = reserved_id(world, job_id, "score")
        async with worker(env.client, queue):
            handle = env.client.get_workflow_handle(workflow_id)
            try:
                assert await asyncio.to_thread(started.wait, 10)
                await handle.cancel()
                with pytest.raises(WorkflowFailureError) as failure:
                    await asyncio.wait_for(handle.result(), 20)
                assert isinstance(failure.value.cause, CancelledError)
                state = _stage(world.conn, job_id, "score")
                assert state["state"] == ("succeeded" if committed else "canceled"), state
            finally:
                release.set()
            assert await asyncio.to_thread(returned.wait, 10)
        state = _stage(world.conn, job_id, "score")
        assert state["state"] == ("succeeded" if committed else "canceled"), state
        assert world.conn.execute("SELECT count(*) FROM job_scores WHERE job_id=?", (str(job_id),)).fetchone()[
            0
        ] == int(committed)
        assert (await history_types(env.client, workflow_id)).count("cancel_preparation_state") == 1


@pytest.mark.asyncio
async def test_recovery_generates_cover_and_preserves_accepted_resume(world, monkeypatch):
    from jobctrl.scoring import cover_letter
    from jobctrl.infrastructure.materials import SqliteMaterialsRepository
    from .test_v7_cover_runtime import _CoverLlm, _PdfRenderer, _seed_eligible_score, _seed_approved_resume

    job_id = _job(world.conn, enriched=True)
    _seed_eligible_score(world.conn, tenant_id=LOCAL_TENANT, job_id=job_id)
    _seed_approved_resume(world.conn, world.app, tenant_id=LOCAL_TENANT, job_id=job_id)
    set_stage_state(world.conn, job_id, "score", "succeeded", validate_transition=False)
    set_stage_state(world.conn, job_id, "tailor", "succeeded", validate_transition=False)
    world.conn.commit()
    before = SqliteMaterialsRepository(world.conn).load_current_approved(LOCAL_TENANT, job_id)
    assert before is not None and before.cover_letter is None
    llm = _CoverLlm()
    monkeypatch.setattr(cover_letter, "COVER_LETTER_DIR", world.app / "cover-letters")
    original_cover = cover_letter.cover_letter_by_id

    def cover_with_synthetic_provider(job_id, **kwargs):
        return original_cover(
            job_id, **kwargs, snapshot=_profile_snapshot(LOCAL_TENANT), llm_port=llm, pdf_renderer=_PdfRenderer()
        )

    monkeypatch.setattr(cover_letter, "cover_letter_by_id", cover_with_synthetic_provider)
    queue = f"qa-cover-{uuid.uuid4()}"
    async with local_env() as env:
        assert await tick(env.client, world, queue) == 1
        workflow_id = reserved_id(world, job_id, "cover")
        async with worker(env.client, queue):
            result = await asyncio.wait_for(env.client.get_workflow_handle(workflow_id).result(), 25)
            assert result["stages_completed"] == ["cover"], result
        state = _stage(world.conn, job_id, "cover")
        assert state["state"] == "succeeded", state
        saved = SqliteMaterialsRepository(world.conn).load_current_approved(LOCAL_TENANT, job_id)
        assert saved is not None and saved.cover_letter is not None and saved.cover_letter_pdf is not None
        assert saved.generation == before.generation
        assert saved.tailored_resume == before.tailored_resume
        assert saved.resume_pdf == before.resume_pdf
        assert llm.calls == 1
        await wait_idle(env.client)
        assert await tick(env.client, world, queue) == 0


@pytest.mark.asyncio
async def test_automatic_tailor_reaches_generation_and_preserves_exact_selection(world, monkeypatch):
    from jobctrl.scoring import tailor
    from .test_v7_cover_runtime import _seed_eligible_score

    job_id = _job(world.conn, enriched=True)
    _seed_eligible_score(world.conn, tenant_id=LOCAL_TENANT, job_id=job_id)
    set_stage_state(world.conn, job_id, "score", "succeeded", validate_transition=False)
    world.conn.commit()
    calls = []

    def stop_at_generation(job, *args, **kwargs):
        calls.append(job["job_id"])
        kwargs["commit_guard"]()
        raise RuntimeError("synthetic generation provider unavailable")

    monkeypatch.setattr(tailor, "_tailor_one_job", stop_at_generation)
    monkeypatch.setattr(tailor, "TAILORED_DIR", world.app / "tailored")
    original_tailor = tailor.tailor_job_by_id

    def tailor_with_synthetic_inputs(job_id, **kwargs):
        return original_tailor(job_id, **kwargs, snapshot=_profile_snapshot(LOCAL_TENANT), pdf_renderer=object())

    monkeypatch.setattr(tailor, "tailor_job_by_id", tailor_with_synthetic_inputs)
    queue = f"qa-tailor-{uuid.uuid4()}"
    async with local_env() as env:
        assert await tick(env.client, world, queue) == 1
        workflow_id = reserved_id(world, job_id, "tailor")
        async with worker(env.client, queue):
            result = await asyncio.wait_for(env.client.get_workflow_handle(workflow_id).result(), 25)
            assert result["stages_completed"] == ["tailor"], result
        assert calls == [str(job_id)]
        state = _stage(world.conn, job_id, "tailor")
        assert state["state"] == "failed", state
        assert state["attempt_count"] == 1, state
        await wait_idle(env.client)
        assert await tick(env.client, world, queue) == 0


@pytest.mark.asyncio
async def test_terminated_owner_does_not_stall_saved_jobs_after_restart(world):
    job_id = _job(world.conn, enriched=True)
    queue = f"qa-orphan-{uuid.uuid4()}"
    started = asyncio.Event()

    @activity.defn(name="score")
    async def crash_checkpoint(payload):
        started.set()
        await asyncio.Event().wait()

    async with local_env() as env:
        assert await tick(env.client, world, queue) == 1
        old_id = reserved_id(world, job_id, "score")
        old_activities = [a for a in ACTIVITIES if a is not score_activity] + [crash_checkpoint]
        async with Worker(
            env.client,
            task_queue=queue,
            workflows=[JobPipelineWorkflow],
            activities=old_activities,
            workflow_runner=UnsandboxedWorkflowRunner(),
        ):
            await asyncio.wait_for(started.wait(), 10)
            handle = env.client.get_workflow_handle(old_id)
            description = await handle.describe()
            # Exact owned checkpoint left by a killed scoring process after its
            # queued-to-running commit. Started projection came from real worker.
            set_stage_state(
                world.conn,
                job_id,
                "score",
                "running",
                attempt_count=2,
                max_attempts=5,
                started_at="2026-01-01T00:00:00+00:00",
                validate_transition=False,
                metadata={
                    "workflowId": old_id,
                    "temporalRunId": description.run_id,
                    "activityOwner": description.run_id,
                    "automaticRecovery": True,
                    "rescore": False,
                    "priorScoreVersion": 0,
                },
            )
            world.conn.commit()
            await handle.terminate("synthetic stopped predecessor")
        other_id = _job(world.conn, number=2, enriched=True)
        await wait_idle(env.client)
        fresh = await Client.connect(env.client.service_client.config.target_host)
        assert await tick(fresh, world, queue) == 1
        settled = _stage(world.conn, job_id, "score")
        assert settled["state"] == "failed", settled
        assert settled["attempt_count"] == 3, settled
        next_id = reserved_id(world, other_id, "score")
        async with worker(fresh, queue):
            result = await asyncio.wait_for(fresh.get_workflow_handle(next_id).result(), 25)
            assert result["stages_completed"] == ["score"], result
        assert _stage(world.conn, other_id, "score")["state"] == "succeeded"
        assert world.llm.calls == 1
        assert world.conn.execute("SELECT count(*) FROM job_scores WHERE job_id=?", (str(job_id),)).fetchone()[0] == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "committed,prior_attempts,cancellation_fenced",
    [(False, 1, False), (False, 4, False), (True, 1, False), (False, 1, True)],
)
async def test_terminated_enrichment_releases_exact_owner_and_fences_late_provider(
    world, monkeypatch, committed, prior_attempts, cancellation_fenced
):
    from jobctrl.domain.enrichment import JobEnrichment, ExtractionTier, EnrichmentError, StaleEnrichmentExecutionLease
    from jobctrl.enrichment import activities as enrichment_activities
    from jobctrl.infrastructure.enrichment import SqliteEnrichmentRepository
    from jobctrl.infrastructure.enrichment.execution_lease import (
        fence_enrichment_execution_lease,
        claim_enrichment_execution_lease_for_run,
    )

    job_id = seed_for_stage(world, 1, "enrich")
    aggregate = JobEnrichment.empty(tenant_id=LOCAL_TENANT, job_id=job_id, updated_at="2026-01-01T00:00:00+00:00")
    for _ in range(prior_attempts):
        if aggregate.is_failed:
            aggregate = aggregate.reset(reset_at="2026-01-01T00:00:00+00:00")
        aggregate = aggregate.start_attempt(
            extraction_tier=ExtractionTier.JSON_LD, started_at="2026-01-01T00:00:00+00:00"
        ).fail_attempt(
            error=EnrichmentError(code="DETAIL_ERROR", message="synthetic prior outage", retryable=True),
            finished_at="2026-01-01T00:00:01+00:00",
        )
    SqliteEnrichmentRepository(world.conn).save(aggregate)
    set_stage_state(
        world.conn,
        job_id,
        "enrich",
        "failed",
        attempt_count=prior_attempts,
        max_attempts=5,
        retryable=True,
        validate_transition=False,
    )
    world.conn.execute(
        "UPDATE job_stage_states SET updated_at='2026-01-01T00:00:00+00:00' WHERE job_id=?", (str(job_id),)
    )
    world.conn.commit()

    started = threading.Event()
    release = threading.Event()
    finished = threading.Event()
    leases = []
    original_claim = enrichment_activities._claim_activity_enrichment_lease
    original_run = enrichment_activities._run_selected_enrichment
    original_scrape = detail.scrape_detail_page

    def observe_claim(*args, **kwargs):
        lease = original_claim(*args, **kwargs)
        leases.append(lease)
        return lease

    def late_provider(*args, **kwargs):
        started.set()
        assert release.wait(25)
        return original_scrape(*args, **kwargs)

    def observe_run(*args, **kwargs):
        try:
            result = original_run(*args, **kwargs)
            if committed:
                started.set()
                assert release.wait(25)
            return result
        finally:
            finished.set()

    monkeypatch.setattr(enrichment_activities, "_claim_activity_enrichment_lease", observe_claim)
    monkeypatch.setattr(enrichment_activities, "_run_selected_enrichment", observe_run)
    if not committed:
        monkeypatch.setattr(detail, "scrape_detail_page", late_provider)
    queue = f"qa-enrich-orphan-{uuid.uuid4()}"
    async with local_env() as env:
        assert await tick(env.client, world, queue) == 1
        old_id = reserved_id(world, job_id, "enrich")
        async with worker(env.client, queue):
            try:
                assert await asyncio.to_thread(started.wait, 10)
                handle = env.client.get_workflow_handle(old_id)
                description = await handle.describe()
                if committed:
                    # An accepted aggregate is canonical even if a killed worker
                    # left its old stage ownership projection incomplete.
                    saved_before = SqliteEnrichmentRepository(world.conn).load(LOCAL_TENANT, job_id)
                    assert saved_before.is_enriched
                    set_stage_state(
                        world.conn,
                        job_id,
                        "enrich",
                        "running",
                        attempt_count=prior_attempts,
                        max_attempts=5,
                        validate_transition=False,
                        metadata={"workflowId": old_id, "temporalRunId": description.run_id},
                    )
                    world.conn.commit()
                else:
                    assert _stage(world.conn, job_id, "enrich")["state"] == "running"
                if cancellation_fenced:
                    # Cancellation committed its exact lease, then lost its
                    # process before stage settlement and Temporal terminated.
                    claim_enrichment_execution_lease_for_run(
                        world.conn,
                        tenant_id=LOCAL_TENANT,
                        workflow_id=old_id,
                        run_id=description.run_id,
                        owner_token=f"cancellation:{old_id}:{description.run_id}",
                        activity_phase=3,
                        activity_attempt=1,
                    )
                    assert _stage(world.conn, job_id, "enrich")["state"] == "running"
                await handle.terminate("synthetic predecessor process stopped")
                await wait_idle(env.client)
                next_job = job_id if committed else _job(world.conn, number=2, enriched=True)
                fresh = await Client.connect(env.client.service_client.config.target_host)
                assert await tick(fresh, world, queue) == 1
                recovered = _stage(world.conn, job_id, "enrich")
                expected = (
                    "canceled"
                    if cancellation_fenced
                    else ("succeeded" if committed else ("exhausted" if prior_attempts == 4 else "failed"))
                )
                expected_attempts = prior_attempts if cancellation_fenced else prior_attempts + 1
                assert recovered["state"] == expected, recovered
                assert recovered["attempt_count"] == expected_attempts, recovered
                saved = SqliteEnrichmentRepository(world.conn).load(LOCAL_TENANT, job_id)
                assert saved.attempt_count == expected_attempts
                if committed:
                    assert saved == saved_before
                elif cancellation_fenced:
                    assert saved.full_description is None
                else:
                    assert saved.is_failed and saved.full_description is None
                    assert saved.last_attempt.error.code == "ENRICH_ACTIVITY_OWNER_STOPPED"
                assert len(leases) == 1 and leases[0] is not None
                with pytest.raises(StaleEnrichmentExecutionLease):
                    fence_enrichment_execution_lease(world.conn, leases[0])
                world.conn.rollback()
                next_id = reserved_id(world, next_job, "score")
                result = await asyncio.wait_for(fresh.get_workflow_handle(next_id).result(), 20)
                assert result["stages_completed"] == ["score"], result
                assert world.llm.calls == 1
            finally:
                release.set()
            assert await asyncio.to_thread(finished.wait, 10)
        settled = _stage(world.conn, job_id, "enrich")
        assert settled["state"] == expected and settled["attempt_count"] == expected_attempts
        after_late_response = SqliteEnrichmentRepository(world.conn).load(LOCAL_TENANT, job_id)
        assert after_late_response == saved
        if not committed:
            assert (
                world.conn.execute("SELECT count(*) FROM job_scores WHERE job_id=?", (str(job_id),)).fetchone()[0] == 0
            )


ORIGINAL_SCORE = scorer.score_job_by_id
ORIGINAL_TAILOR = tailor.tailor_job_by_id
ORIGINAL_TAILOR_FACTORY = tailor._build_use_case


class RequirementLlm(_StrongLlm):
    def chat_json(self, *args, **kwargs):
        payload = super().chat_json(*args, **kwargs)
        payload["requirement_assessments"] = [
            {
                "requirement_id": "req-python-platform",
                "requirement_text": "Own Python platform reliability.",
                "tier": "must_have",
                "weight": 0.9,
                "job_evidence_span": "Need Python.",
                "fit": {"kind": "matched", "evidence_ids": ["platform"]},
            }
        ]
        return payload


class CanonicalAnalysis:
    def execute(self, *, job, tenant_id=LOCAL_TENANT, **kwargs):
        analysis = SqliteEmployerAnalysisRepository(database.get_connection()).load(tenant_id, job["job_id"])
        assert analysis is not None
        return SimpleNamespace(analysis=analysis)


@pytest.fixture
def evidence_world(world, monkeypatch):
    llm = RequirementLlm()
    generation_calls = []

    def score_with_synthetic_provider(job_id, **kwargs):
        # Keep production default repositories and require_employer_analysis=True.
        return ORIGINAL_SCORE(
            job_id,
            **kwargs,
            profile_snapshot=_profile_snapshot(LOCAL_TENANT),
            resume_text="Python platform engineer.",
            criteria=ScoringCriteria(),
            llm_port=llm,
            analyze_use_case=CanonicalAnalysis(),
        )

    def tailor_with_synthetic_profile(job_id, **kwargs):
        return ORIGINAL_TAILOR(
            job_id,
            **kwargs,
            snapshot=_profile_snapshot(LOCAL_TENANT),
            pdf_renderer=object(),
        )

    def factory(**kwargs):
        return ORIGINAL_TAILOR_FACTORY(
            **kwargs,
            llm_port=llm,
            analyze_use_case=CanonicalAnalysis(),
            voice=object(),
        )

    def stop_at_generation(self, **kwargs):
        kwargs["execution_guard"]()
        report = kwargs["requirement_fit_report"]
        assert report is not None
        assert report.employer_analysis_generation == kwargs["employer_analysis"].generation
        assert report.assessments[0].requirement_id == "req-python-platform"
        assert report.assessments[0].fit.kind == "matched"
        generation_calls.append((str(report.job_id), report.score_version))
        raise RuntimeError("QA_GENERATION_BOUNDARY_REACHED")

    monkeypatch.setattr(scorer, "score_job_by_id", score_with_synthetic_provider)
    monkeypatch.setattr(tailor, "tailor_job_by_id", tailor_with_synthetic_profile)
    monkeypatch.setattr(tailor, "_build_use_case", factory)
    monkeypatch.setattr(tailor, "TAILORED_DIR", world.app / "tailored")
    monkeypatch.setattr(TailorResumeUseCase, "_run_attempts", stop_at_generation)
    world.llm = llm
    world.generation_calls = generation_calls
    return world


def seed(world, number=1):
    job_id = _job(world.conn, number=number, enriched=True)
    world.conn.execute("UPDATE job_enrichments SET full_description='Need Python.' WHERE job_id=?", (str(job_id),))
    world.conn.commit()
    analysis = _employer_analysis(
        f"https://example.test/jobs/{number}",
        job_id=job_id,
        title="Role",
        description="Need Python.",
    )
    SqliteEmployerAnalysisRepository(world.conn).save(analysis)
    return job_id


def verify_report(world, job_id, version=1):
    score = SqliteScoreRepository(world.conn).load(LOCAL_TENANT, job_id)
    report = SqliteRequirementFitReportRepository(world.conn).load(LOCAL_TENANT, job_id, score_version=version)
    assert score is not None and score.version == version
    assert score.trace.resolution_reason == "requirement_fit_report"
    assert report is not None, "Canonical requirement report missing after owned Score"
    assert report.score_version == score.version
    assert report.profile_snapshot_version == score.trace.profile_snapshot_version
    assert report.resolved_fit_score == score.fit_score
    assert report.resolved_fit_score.value == 10
    assert report.employer_analysis_generation == 1
    assert report.assessments[0].fit.kind == "matched"
    assert report.assessments[0].requirement_id == "req-python-platform"
    assert (
        world.conn.execute(
            "SELECT count(*) FROM job_requirement_fit_items WHERE job_id=? AND score_version=?", (str(job_id), version)
        ).fetchone()[0]
        == 1
    )
    return report


@pytest.mark.parametrize(
    "condition",
    [
        "coherent",
        "missing_report",
        "missing_items",
        "old_score",
        "analysis_mismatch",
        "profile_mismatch",
        "canceled",
        "exhausted",
        "nonretryable",
        "at_limit",
        "other_blocker",
    ],
)
def test_requirement_fit_unblock_requires_current_evidence_and_retry_permission(evidence_world, condition):
    from jobctrl.state import reconcile_dependency_blockers

    world = evidence_world
    job_id = seed(world)
    assert scorer.score_job_by_id(job_id).ok
    verify_report(world, job_id)
    set_stage_state(
        world.conn,
        job_id,
        "tailor",
        condition if condition in {"canceled", "exhausted"} else "blocked",
        attempt_count=4 if condition == "at_limit" else 2,
        max_attempts=4,
        retryable=condition != "nonretryable",
        error_code="OTHER_CONDITION" if condition == "other_blocker" else "REQUIREMENT_FIT_MISSING",
        blocked_by=["score"],
        validate_transition=False,
    )
    if condition in {"missing_report", "missing_items"}:
        world.conn.execute("DELETE FROM job_requirement_fit_items WHERE job_id=?", (str(job_id),))
    if condition == "missing_report":
        world.conn.execute("DELETE FROM job_requirement_fit_reports WHERE job_id=?", (str(job_id),))
    if condition == "old_score":
        repository = SqliteScoreRepository(world.conn)
        score = repository.load(LOCAL_TENANT, job_id)
        assert score is not None
        repository.save(
            score.next_version(
                fit_score=score.fit_score,
                breakdown=score.breakdown,
                matched_keywords=score.matched_keywords,
                scored_at=score.scored_at,
            )
        )
    if condition == "analysis_mismatch":
        world.conn.execute(
            "UPDATE job_requirement_fit_reports SET employer_analysis_generation=2 WHERE job_id=?", (str(job_id),)
        )
    if condition == "profile_mismatch":
        world.conn.execute(
            "UPDATE job_requirement_fit_reports SET profile_snapshot_version=2 WHERE job_id=?", (str(job_id),)
        )
    world.conn.commit()
    before = _stage(world.conn, job_id, "tailor")

    changed = reconcile_dependency_blockers(world.conn, job_id=job_id, completed_stage="score")
    world.conn.commit()

    after = _stage(world.conn, job_id, "tailor")
    assert changed == int(condition == "coherent")
    assert after["attempt_count"] == before["attempt_count"]
    assert after["max_attempts"] == before["max_attempts"]
    if condition == "coherent":
        assert after["state"] == "pending"
        assert after["error_code"] is None
        assert reconcile_dependency_blockers(world.conn, job_id=job_id, completed_stage="score") == 0
    else:
        assert after == before


async def run_auto(client, world, queue, job_id, stage):
    await wait_idle(client)
    assert await tick(client, world, queue) == 1
    workflow_id = reserved_id(world, job_id, stage)
    async with worker(client, queue):
        result = await asyncio.wait_for(client.get_workflow_handle(workflow_id).result(), 25)
    assert result["stages_completed"] == [stage], result
    kinds = await history_types(client, workflow_id)
    assert kinds == ["record_workflow_started", "check_spend_budget", stage, "record_workflow_outcome"]
    return workflow_id


def assert_generation(world, job_id, version):
    state = _stage(world.conn, job_id, "tailor")
    assert world.generation_calls == [(str(job_id), version)], state
    assert state["state"] == "failed", state
    assert state["error_code"] != "REQUIREMENT_FIT_MISSING", state
    assert state["error_message"] == "Tailoring ended with status error", state


@pytest.mark.asyncio
async def test_owned_score_persists_report_and_automatic_tailor_consumes_it(evidence_world):
    world = evidence_world
    job_id = seed(world)
    queue = f"qa-evidence-{uuid.uuid4()}"
    async with local_env() as env:
        await run_auto(env.client, world, queue, job_id, "score")
        verify_report(world, job_id)
        assert _stage(world.conn, job_id, "score")["state"] == "succeeded"
        await run_auto(env.client, world, queue, job_id, "tailor")
        assert_generation(world, job_id, 1)
        assert world.llm.calls == 1
        assert len([run async for run in env.client.list_workflows()]) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("continuation", ["automatic", "normal"])
async def test_exact_normal_rescore_repairs_historical_missing_report(evidence_world, continuation):
    world = evidence_world
    job_id = seed(world)
    other_id = seed(world, 2)
    # Preserve a canceled unrelated row to prove selected rescore is bounded.
    from jobctrl.state import set_stage_state

    set_stage_state(world.conn, other_id, "score", "canceled", retryable=False, validate_transition=False)
    world.conn.commit()
    queue = f"qa-remediation-{uuid.uuid4()}"
    async with local_env() as env:
        await run_auto(env.client, world, queue, job_id, "score")
        verify_report(world, job_id)
        before = tuple(world.conn.execute("SELECT * FROM job_scores WHERE job_id=?", (str(job_id),)).fetchone())
        # Recreate the confirmed historic product defect using only synthetic rows.
        world.conn.execute("DELETE FROM job_requirement_fit_items WHERE job_id=?", (str(job_id),))
        world.conn.execute("DELETE FROM job_requirement_fit_reports WHERE job_id=?", (str(job_id),))
        world.conn.commit()
        await run_auto(env.client, world, queue, job_id, "tailor")
        blocked = _stage(world.conn, job_id, "tailor")
        assert blocked["error_code"] == "REQUIREMENT_FIT_MISSING", blocked
        assert world.generation_calls == []
        await wait_idle(env.client)
        rescore_id = f"qa-normal-rescore-{uuid.uuid4()}"
        async with worker(env.client, queue):
            result = await asyncio.wait_for(
                env.client.execute_workflow(
                    JobPipelineWorkflow.run,
                    JobPipelineWorkflowInput(
                        tenant_id="local",
                        stages=["score"],
                        job_ids=(job_id,),
                        rescore=True,
                        expected_app_dir=str(world.app),
                        expected_db_path=str(world.path),
                    ),
                    id=rescore_id,
                    task_queue=queue,
                ),
                25,
            )
        assert result.stages_completed == ["score"], result
        verify_report(world, job_id, 2)
        assert (
            tuple(
                world.conn.execute("SELECT * FROM job_scores WHERE job_id=? AND version=1", (str(job_id),)).fetchone()
            )
            == before
        )
        assert world.conn.execute("SELECT count(*) FROM job_scores WHERE job_id=?", (str(job_id),)).fetchone()[0] == 2
        assert world.conn.execute("SELECT count(*) FROM job_scores WHERE job_id=?", (str(other_id),)).fetchone()[0] == 0
        assert _stage(world.conn, other_id, "score")["state"] == "canceled"
        assert await history_types(env.client, rescore_id) == [
            "record_workflow_started",
            "check_spend_budget",
            "score",
            "record_workflow_outcome",
        ]
        assert _stage(world.conn, job_id, "tailor")["attempt_count"] == blocked["attempt_count"]
        if continuation == "automatic":
            repaired = _stage(world.conn, job_id, "tailor")
            assert repaired["state"] == "pending"
            await wait_idle(env.client)
            assert await tick(env.client, world, queue) == 0
            updated = datetime.fromisoformat(repaired["updated_at"].replace("Z", "+00:00"))
            cooldown = min(1800, 60 * (2 ** repaired["attempt_count"]))
            remaining = cooldown - (datetime.now(timezone.utc) - updated).total_seconds()
            await asyncio.sleep(max(0, remaining) + 0.2)
            await run_auto(env.client, world, queue, job_id, "tailor")
        else:
            await wait_idle(env.client)
            tailor_id = f"qa-normal-tailor-{uuid.uuid4()}"
            async with worker(env.client, queue):
                result = await asyncio.wait_for(
                    env.client.execute_workflow(
                        JobPipelineWorkflow.run,
                        JobPipelineWorkflowInput(
                            tenant_id="local",
                            stages=["tailor"],
                            job_ids=(job_id,),
                            expected_app_dir=str(world.app),
                            expected_db_path=str(world.path),
                        ),
                        id=tailor_id,
                        task_queue=queue,
                    ),
                    25,
                )
            assert result.stages_completed == ["tailor"], result
            assert await history_types(env.client, tailor_id) == [
                "record_workflow_started",
                "check_spend_budget",
                "tailor",
                "record_workflow_outcome",
            ]
        assert_generation(world, job_id, 2)
        assert world.llm.calls == 2
        assert len([run async for run in env.client.list_workflows()]) == 4


@pytest.mark.asyncio
@pytest.mark.parametrize("committed", [False, True])
async def test_cancel_fences_uncommitted_report_and_retains_committed_pair(evidence_world, monkeypatch, committed):
    world = evidence_world
    job_id = seed(world)
    started, release, returned = threading.Event(), threading.Event(), threading.Event()
    original_chat, original_score = world.llm.chat_json, scorer.score_job_by_id

    def delayed_chat(*args, **kwargs):
        started.set()
        assert release.wait(25)
        try:
            return original_chat(*args, **kwargs)
        finally:
            returned.set()

    def delayed_ack(*args, **kwargs):
        result = original_score(*args, **kwargs)
        started.set()
        assert release.wait(25)
        returned.set()
        return result

    if committed:
        monkeypatch.setattr(scorer, "score_job_by_id", delayed_ack)
    else:
        monkeypatch.setattr(world.llm, "chat_json", delayed_chat)
    queue = f"qa-cancel-evidence-{uuid.uuid4()}"
    async with local_env() as env:
        assert await tick(env.client, world, queue) == 1
        workflow_id = reserved_id(world, job_id, "score")
        async with worker(env.client, queue):
            handle = env.client.get_workflow_handle(workflow_id)
            try:
                assert await asyncio.to_thread(started.wait, 10)
                await handle.cancel()
                with pytest.raises(WorkflowFailureError) as failure:
                    await asyncio.wait_for(handle.result(), 20)
                assert isinstance(failure.value.cause, CancelledError)
            finally:
                release.set()
            assert await asyncio.to_thread(returned.wait, 10)
        assert _stage(world.conn, job_id, "score")["state"] == ("succeeded" if committed else "canceled")
        for table in ("job_scores", "job_requirement_fit_reports", "job_requirement_fit_items"):
            assert world.conn.execute(f"SELECT count(*) FROM {table} WHERE job_id=?", (str(job_id),)).fetchone()[
                0
            ] == int(committed)
        if committed:
            verify_report(world, job_id)
        assert (await history_types(env.client, workflow_id)).count("cancel_preparation_state") == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["score", "tailor"])
async def test_revoked_job_after_batch_filter_does_not_strand_other_jobs(world, monkeypatch, stage):
    revoked = seed_for_stage(world, 1, stage)
    other = seed_for_stage(world, 2, stage)
    original_filter = recovery.automatic_recovery_job_ids

    def revoke_after_filter(payload, selected_stage):
        selected = original_filter(payload, selected_stage)
        conn = database.get_connection()
        set_stage_state(conn, revoked, stage, "canceled", validate_transition=False)
        conn.commit()
        assert selected == (revoked, other)
        return selected

    monkeypatch.setattr(recovery, "automatic_recovery_job_ids", revoke_after_filter)
    if stage == "tailor":
        def stop_at_generation(job, *args, **kwargs):
            kwargs["commit_guard"]()
            raise RuntimeError("synthetic generation provider unavailable")

        monkeypatch.setattr(tailor, "_tailor_one_job", stop_at_generation)
        monkeypatch.setattr(tailor, "TAILORED_DIR", world.app / "tailored")
        original_tailor = tailor.tailor_job_by_id

        def tailor_with_inputs(job_id, **kwargs):
            return original_tailor(job_id, **kwargs, snapshot=_profile_snapshot(LOCAL_TENANT), pdf_renderer=object())

        monkeypatch.setattr(tailor, "tailor_job_by_id", tailor_with_inputs)
    queue = f"qa-revoked-{uuid.uuid4()}"
    async with local_env() as env:
        assert await tick(env.client, world, queue) == 2
        workflow_id = reserved_id(world, other, stage)
        async with worker(env.client, queue):
            await asyncio.wait_for(env.client.get_workflow_handle(workflow_id).result(), 25)
        assert _stage(world.conn, revoked, stage)["state"] == "canceled"
        assert _stage(world.conn, other, stage)["state"] == ("succeeded" if stage == "score" else "failed")
        assert _stage(world.conn, other, stage)["attempt_count"] == 1
        await wait_idle(env.client)
        await recovery._reconcile_stopped_activity_owners(env.client, world.conn)
        await recovery._reconcile_interrupted_reservations(env.client, world.conn)
        assert _stage(world.conn, other, stage)["error_code"] != "PREPARATION_RECOVERY_STOPPED"


@pytest.mark.asyncio
async def test_real_enrichment_batch_failure_before_first_claim_stops_recovery(world, monkeypatch):
    from jobctrl.domain.errors import TransientNetworkError

    job_id = seed_for_stage(world, 1, "enrich")

    def fail_site_before_claim(*args, **kwargs):
        raise TransientNetworkError("synthetic network outage before the first job claim")

    monkeypatch.setattr(detail, "scrape_site_batch", fail_site_before_claim)
    queue = f"qa-enrich-preflight-{uuid.uuid4()}"
    async with local_env() as env:
        assert await tick(env.client, world, queue) == 1
        workflow_id = reserved_id(world, job_id, "enrich")
        async with worker(env.client, queue):
            await asyncio.wait_for(env.client.get_workflow_handle(workflow_id).result(), 25)
        await wait_idle(env.client)
        for _ in range(3):
            world.conn.execute("UPDATE job_stage_states SET updated_at='2026-01-01T00:00:00Z'")
            world.conn.commit()
            assert await tick(env.client, world, queue) == 0
        row = _stage(world.conn, job_id, "enrich")
        assert row["state"] == "blocked"
        assert row["error_code"] == "PREPARATION_RECOVERY_STOPPED"
        assert row["attempt_count"] == 1
        executions = [run async for run in env.client.list_workflows()]
        assert len(executions) == 1
