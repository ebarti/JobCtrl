"""Per-job implicit preparation honors literal human work controls."""

import sqlite3

import pytest

from jobctrl.domain.tenant import TenantId
from jobctrl.infrastructure.migrations.schema_v15 import create_exact_v15_schema
from jobctrl.materials import activities
from jobctrl.scoring import tailor, cover_letter
from tests.test_automatic_preparation_temporal_qa import world as world
from tests.test_v7_tailor_runtime import _JOB_ID as TAILOR_JOB, _seed_job
from tests.test_v7_cover_runtime import (
    _JOB_ID as COVER_JOB,
    _seed_target,
    _seed_eligible_score,
    _seed_approved_resume,
    _seed_stage_rows,
)

TENANT = TenantId("tenant-a")


def seed(tmp_path, monkeypatch, stage):
    # This fixture tests cover generation after the user opts in.
    cover_config = tmp_path / "cover-settings.json"
    cover_config.write_text('{"cover_letter_generation":true}')
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(cover_config))
    monkeypatch.setattr("jobctrl.database.DB_PATH", tmp_path / "owned.db")
    monkeypatch.setattr("jobctrl.config.DB_PATH", tmp_path / "owned.db")
    monkeypatch.setattr("jobctrl.config.APP_DIR", tmp_path)
    conn = sqlite3.connect(tmp_path / "owned.db")
    conn.row_factory = sqlite3.Row
    create_exact_v15_schema(conn)
    if stage == "tailor":
        job_id = TAILOR_JOB
        _seed_job(conn, tenant_id=TENANT, job_id=job_id, url="https://example.test/owned", fit_score=7)
        monkeypatch.setattr(tailor, "get_connection", lambda: conn)
        monkeypatch.setattr(tailor, "TAILORED_DIR", tmp_path / "tailored")
    else:
        job_id = COVER_JOB
        _seed_target(conn, tenant_id=TENANT)
        _seed_eligible_score(conn, tenant_id=TENANT)
        _seed_approved_resume(conn, tmp_path, tenant_id=TENANT)
        _seed_stage_rows(conn, tenant_id=TENANT)
        monkeypatch.setattr(cover_letter, "get_connection", lambda: conn)
        monkeypatch.setattr(cover_letter, "COVER_LETTER_DIR", tmp_path / "letters")
    conn.execute(
        "UPDATE job_stage_states SET state='skipped',error_code=NULL,retryable=0 WHERE tenant_id=? AND job_id=? AND stage='apply'",
        (str(TENANT), str(job_id)),
    )
    conn.commit()
    return conn, job_id


@pytest.mark.parametrize("stage", ["tailor", "cover"])
def test_implicit_job_preparation_decline_stops_before_acquisition_or_generation(tmp_path, monkeypatch, stage):
    conn, job_id = seed(tmp_path, monkeypatch, stage)
    before = list(conn.execute("SELECT * FROM job_materials_artifacts"))
    acquired = []

    def forbidden_acquisition(*args, **kwargs):
        acquired.append(True)
        raise AssertionError("Implicit material work crossed the manual decline before acquisition")

    monkeypatch.setattr("jobctrl.enrichment.availability.require_preparation_available", forbidden_acquisition)
    payload_cls = activities.TailorJobActivityInput if stage == "tailor" else activities.CoverLetterActivityInput
    run = activities._tailor_one_job if stage == "tailor" else activities._cover_one_job
    outcome = run(payload_cls(tenant_id=str(TENANT), job_id=job_id))
    assert outcome["status"] == "skipped" and outcome["reason"] == "manual_apply_decline"
    assert acquired == []
    row = conn.execute(
        "SELECT state,error_code,retryable,attempt_count FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage=?",
        (str(TENANT), str(job_id), stage),
    ).fetchone()
    assert tuple(row) == ("skipped", "MANUAL_APPLY_DECLINED", 0, 0)
    assert list(conn.execute("SELECT * FROM job_materials_artifacts")) == before


@pytest.mark.parametrize("stage", ["tailor", "cover"])
def test_decline_committed_after_availability_preflight_is_rechecked_under_admission_lock(tmp_path, monkeypatch, stage):
    conn, job_id = seed(tmp_path, monkeypatch, stage)
    conn.execute(
        "UPDATE job_stage_states SET state='pending',retryable=1 WHERE tenant_id=? AND job_id=? AND stage='apply'",
        (str(TENANT), str(job_id)),
    )
    conn.commit()
    acquisitions = []

    def decline_after_early_read(*args, **kwargs):
        with sqlite3.connect(tmp_path / "owned.db") as peer:
            peer.execute(
                "UPDATE job_stage_states SET state='skipped',error_code=NULL,retryable=0 WHERE tenant_id=? AND job_id=? AND stage='apply'",
                (str(TENANT), str(job_id)),
            )
        acquisitions.append(True)

    monkeypatch.setattr("jobctrl.enrichment.availability.require_preparation_available", decline_after_early_read)
    payload_cls = activities.TailorJobActivityInput if stage == "tailor" else activities.CoverLetterActivityInput
    run = activities._tailor_one_job if stage == "tailor" else activities._cover_one_job
    outcome = run(payload_cls(tenant_id=str(TENANT), job_id=job_id))
    assert outcome["status"] == "skipped" and outcome["reason"] == "manual_apply_decline"
    assert acquisitions == [True]
    assert (
        conn.execute(
            "SELECT attempt_count FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage=?",
            (str(TENANT), str(job_id), stage),
        ).fetchone()[0]
        == 0
    )
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE event_type='StageStarted' AND stage=?", (stage,)
        ).fetchone()[0]
        == 0
    )


@pytest.mark.parametrize(
    "state", ["succeeded", "running", "queued", "canceled", "exhausted", "skipped", "failed", "blocked"]
)
def test_implicit_sibling_preserves_admitted_owners_and_unrelated_stops(tmp_path, monkeypatch, state):
    import json
    from jobctrl.infrastructure.materials.manual_decline import material_request_declined

    conn, job_id = seed(tmp_path, monkeypatch, "tailor")
    conn.execute(
        "UPDATE job_stage_states SET state=?,error_code='OTHER_STOP',metadata_json=? WHERE tenant_id=? AND job_id=? AND stage='tailor'",
        (state, json.dumps({"workflowId": "foreign-owner", "explicitMaterialRequest": True}), str(TENANT), str(job_id)),
    )
    conn.commit()
    query = "SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='tailor'"
    before = tuple(conn.execute(query, (str(TENANT), str(job_id))).fetchone())
    assert material_request_declined(
        conn,
        tenant_id=TENANT,
        job_id=job_id,
        stage="tailor",
        explicit_material_request=False,
        workflow_id="implicit-sibling",
    )
    assert tuple(conn.execute(query, (str(TENANT), str(job_id))).fetchone()) == before


@pytest.mark.parametrize(
    "shape,declined",
    [("manual", True), ("policy", False), ("legacy", False), ("retryable", False), ("other_tenant", False)],
)
def test_only_exact_current_tenant_manual_control_vetoes(tmp_path, monkeypatch, shape, declined):
    from jobctrl.infrastructure.materials.manual_decline import material_request_declined

    conn, job_id = seed(tmp_path, monkeypatch, "tailor")
    if shape == "policy":
        conn.execute("UPDATE job_stage_states SET error_code='MIN_SCORE' WHERE stage='apply'")
    elif shape == "legacy":
        conn.execute("UPDATE job_stage_states SET state='pending' WHERE stage='apply'")
        conn.execute("UPDATE jobs SET apply_status='skipped'")
    elif shape == "retryable":
        conn.execute("UPDATE job_stage_states SET retryable=1 WHERE stage='apply'")
    elif shape == "other_tenant":
        conn.execute("UPDATE job_stage_states SET state='pending' WHERE stage='apply'")
        _seed_job(conn, tenant_id=TenantId("other"), job_id=job_id, url="https://example.test/other")
        conn.execute(
            "UPDATE job_stage_states SET state='skipped',error_code=NULL,retryable=0 WHERE tenant_id='other' AND stage='apply'"
        )
    conn.commit()
    assert (
        material_request_declined(
            conn, tenant_id=TENANT, job_id=job_id, stage="tailor", explicit_material_request=False
        )
        is declined
    )


@pytest.mark.parametrize("selector", ["recovery", "discovery"])
def test_apply_reset_reopens_only_cause_owned_skips_before_real_automatic_selection(world, selector):
    from jobctrl.infrastructure.materials.manual_decline import material_request_declined
    from jobctrl.pipeline import automatic_preparation as recovery, preparation
    from tests.test_automatic_preparation_temporal_qa import seed_for_stage
    from jobctrl.domain.tenant import LOCAL_TENANT

    job_id = seed_for_stage(world, 1, "tailor")
    world.conn.execute(
        "UPDATE job_stage_states SET state='skipped',error_code=NULL,retryable=0 WHERE job_id=? AND stage='apply'",
        (str(job_id),),
    )
    world.conn.commit()
    assert material_request_declined(
        world.conn, tenant_id=LOCAL_TENANT, job_id=job_id, stage="tailor", explicit_material_request=False
    )
    world.conn.execute(
        "UPDATE job_stage_states SET state='pending',error_code=NULL,retryable=1 WHERE job_id=? AND stage='apply'",
        (str(job_id),),
    )
    world.conn.commit()
    if selector == "recovery":
        from datetime import datetime, timedelta, timezone

        batch = recovery.reserve_recovery_batch(world.conn, now=datetime.now(timezone.utc) + timedelta(seconds=61))
        assert batch.stage == "tailor" and batch.job_ids == (job_id,)
    else:
        targets = preparation.derive_preparation_targets(preparation.DerivePreparationTargetsInput())
        assert [t.job_id for t in targets] == [job_id]
    rows = world.conn.execute(
        "SELECT stage,state,error_code FROM job_stage_states WHERE job_id=? AND stage IN ('tailor','cover')",
        (str(job_id),),
    ).fetchall()
    assert all(r[1] in ("pending", "queued") and r[2] is None for r in rows)
    assert world.llm.calls == 0


def test_explicit_cover_request_releases_only_its_cause_and_runs_normal_reviews(tmp_path, monkeypatch):
    from jobctrl.infrastructure.materials.manual_decline import material_request_declined
    from jobctrl.infrastructure.materials import SqliteMaterialsRepository
    from tests.test_v7_cover_runtime import _CoverLlm, _PdfRenderer, _snapshot

    conn, job_id = seed(tmp_path, monkeypatch, "cover")
    assert material_request_declined(
        conn, tenant_id=TENANT, job_id=job_id, stage="cover", explicit_material_request=False
    )
    llm = _CoverLlm()
    result = cover_letter.cover_letter_by_id(
        job_id,
        tenant_id=TENANT,
        explicit_material_request=True,
        snapshot=_snapshot(TENANT),
        repository=SqliteMaterialsRepository(conn),
        llm_port=llm,
        pdf_renderer=_PdfRenderer(),
    )
    assert result["status"] == "ok" and llm.calls == 1
    assert (
        conn.execute(
            "SELECT state FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='apply'",
            (str(TENANT), str(job_id)),
        ).fetchone()[0]
        == "skipped"
    )
    assert (
        conn.execute(
            "SELECT state FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='cover'",
            (str(TENANT), str(job_id)),
        ).fetchone()[0]
        == "succeeded"
    )


@pytest.mark.parametrize("value", [None, 1, "true"])
def test_intent_flags_require_literal_booleans(value):
    from jobctrl.preparation.workflow import JobPreparationInput
    from jobctrl.domain.preparation import PreparationWorkItemKind, make_preparation_idempotency_key

    for cls in (activities.TailorJobActivityInput, activities.CoverLetterActivityInput):
        with pytest.raises(ValueError, match="must be a boolean"):
            cls(tenant_id=str(TENANT), job_id=TAILOR_JOB, explicit_material_request=value)
    with pytest.raises(ValueError, match="must be a boolean"):
        JobPreparationInput(
            tenant_id=str(TENANT),
            job_id=TAILOR_JOB,
            steps=["tailor"],
            target_version="1",
            idempotency_key="owned",
            explicit_material_request=value,
        )
    with pytest.raises(ValueError, match="must be a boolean"):
        make_preparation_idempotency_key(
            tenant_id=TENANT,
            job_id=TAILOR_JOB,
            kind=PreparationWorkItemKind.TAILOR_RESUME,
            target_version=1,
            explicit_material_request=value,
        )


def test_explicit_identity_is_distinct_and_automatic_identity_is_byte_compatible():
    import hashlib
    import json
    from jobctrl.domain.preparation import PreparationWorkItemKind, make_preparation_idempotency_key

    args = dict(
        tenant_id=TENANT,
        job_id=TAILOR_JOB,
        kind=PreparationWorkItemKind.TAILOR_RESUME,
        target_version=3,
        source_event_id="owned-source",
    )
    legacy = {
        "tenant_id": str(TENANT),
        "job_id": str(TAILOR_JOB),
        "kind": "tailor_resume",
        "target_version": 3,
        "source_event_id": "owned-source",
    }
    expected = (
        "preparation:" + hashlib.sha256(json.dumps(legacy, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    )
    assert (
        make_preparation_idempotency_key(**args)
        == make_preparation_idempotency_key(**args, explicit_material_request=False)
        == expected
    )
    assert make_preparation_idempotency_key(**args, explicit_material_request=True) != expected


@pytest.mark.parametrize("stage", ["tailor", "cover"])
def test_decline_after_setup_is_rechecked_before_final_stage_started(tmp_path, monkeypatch, stage):
    from tests.test_v7_cover_runtime import _CoverLlm, _PdfRenderer, _snapshot
    from tests.test_v7_tailor_runtime import _snapshot as tailor_snapshot

    conn, job_id = seed(tmp_path, monkeypatch, stage)
    conn.execute("UPDATE job_stage_states SET state='pending',retryable=1 WHERE stage='apply'")
    conn.commit()
    monkeypatch.setattr("jobctrl.enrichment.availability.require_preparation_available", lambda *a, **k: None)
    setup = []

    def late_decline():
        with sqlite3.connect(tmp_path / "owned.db") as peer:
            peer.execute(
                "UPDATE job_stage_states SET state='skipped',error_code=NULL,retryable=0 WHERE tenant_id=? AND job_id=? AND stage='apply'",
                (str(TENANT), str(job_id)),
            )
        setup.append(True)
        return _PdfRenderer()

    if stage == "cover":
        monkeypatch.setattr(cover_letter, "_build_pdf_renderer", late_decline)
        llm = _CoverLlm()
        result = cover_letter.cover_letter_by_id(
            job_id, tenant_id=TENANT, snapshot=_snapshot(TENANT), llm_port=llm, explicit_material_request=False
        )
        assert llm.calls == 0
    else:
        monkeypatch.setattr(tailor, "_build_pdf_renderer", late_decline)
        monkeypatch.setattr(tailor, "_build_llm_policy", lambda **kwargs: object())
        monkeypatch.setattr(
            tailor, "_tailor_one_job", lambda *a, **k: pytest.fail("generation admitted after a late decline")
        )
        result = tailor.tailor_job_by_id(
            job_id, tenant_id=TENANT, snapshot=tailor_snapshot(TENANT), explicit_material_request=False
        )
    assert setup == [True]
    assert result["status"] == "skipped" and result["reason"] == "manual_apply_decline"
    assert conn.execute("SELECT attempt_count FROM job_stage_states WHERE stage=?", (stage,)).fetchone()[0] == 0
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE event_type='StageStarted' AND stage=?", (stage,)
        ).fetchone()[0]
        == 0
    )


@pytest.mark.parametrize("method", ["tailor_job", "retailor_job", "rescore_job"])
def test_rpc_factory_freezes_intent_from_action_and_separates_automatic_identity(tmp_path, monkeypatch, method):
    from jobctrl.domain.preparation import PreparationWorkItemKind
    from jobctrl.infrastructure.rpc import handlers
    from jobctrl.pipeline.preparation import build_preparation_workflow_spec

    conn, job_id = seed(tmp_path, monkeypatch, "tailor")
    monkeypatch.setattr(handlers, "get_connection", lambda: conn)
    spec = getattr(handlers, method)({"tenantId": str(TENANT), "jobId": str(job_id), "explicitMaterialRequest": False})
    (payload,) = spec.args
    assert payload.explicit_material_request is (method != "rescore_job")
    assert payload.retailor is (method == "retailor_job")
    if method != "rescore_job":
        automatic = build_preparation_workflow_spec(
            tenant_id=TENANT,
            job_id=job_id,
            steps=payload.steps,
            kind=PreparationWorkItemKind.TAILOR_RESUME,
            target_version=int(payload.target_version),
            source_event_id=handlers.latest_source_event_id(conn, tenant_id=TENANT, job_id=job_id),
        )
        assert automatic.args[0].explicit_material_request is False
        assert spec.workflow_id != automatic.workflow_id


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "cls,fields",
    [
        (activities.TailorJobActivityInput, {}),
        (activities.CoverLetterActivityInput, {}),
    ],
)
async def test_legacy_activity_inputs_decode_to_implicit(cls, fields):
    from temporalio.converter import DataConverter

    encoded = await DataConverter.default.encode([dict(tenant_id=str(TENANT), job_id=str(TAILOR_JOB), **fields)])
    (decoded,) = await DataConverter.default.decode(encoded, [cls])
    assert decoded.explicit_material_request is False


@pytest.mark.asyncio
@pytest.mark.parametrize("legacy,explicit", [(True, False), (False, False), (False, True)])
async def test_legacy_and_new_real_histories_replay_with_frozen_material_intent(legacy, explicit):
    from dataclasses import asdict
    from unittest.mock import patch
    import uuid
    from temporalio import activity, workflow
    from temporalio.worker import Replayer, UnsandboxedWorkflowRunner, Worker
    from jobctrl.llm import SpendBudgetStatus
    from jobctrl.preparation.workflow import JobPreparationInput, JobPreparationWorkflow
    from tests.temporal_env import time_skipping_env

    observed = []

    @activity.defn(name="record_workflow_started")
    async def started(_payload):
        return None

    @activity.defn(name="record_workflow_outcome")
    async def finished(_payload):
        return None

    @activity.defn(name="check_spend_budget")
    async def spend(_payload):
        return SpendBudgetStatus(
            day="2026-10-22",
            input_tokens=0,
            output_tokens=0,
            estimated_usd=0.0,
            daily_budget_usd=0.0,
            lane="scoring",
            lane_input_tokens=0,
            lane_output_tokens=0,
            lane_token_limit=0,
            lane_exceeded=False,
            global_exceeded=False,
            exceeded=False,
        )

    @activity.defn(name="tailor_job")
    async def tailor_activity(payload):
        observed.append(("tailor", payload.get("explicit_material_request")))
        return {"status": "approved"}

    @activity.defn(name="cover_letter")
    async def cover_activity(payload):
        observed.append(("cover", payload.get("explicit_material_request")))
        return {"status": "ok"}

    original = workflow.execute_activity

    def without_new_activity_field(fn, payload, **kwargs):
        if fn.__name__ in {"tailor_job_activity", "cover_letter_activity"}:
            payload = asdict(payload)
            payload.pop("explicit_material_request")
        return original(fn, payload, **kwargs)

    payload = asdict(
        JobPreparationInput(
            tenant_id=str(TENANT),
            job_id=TAILOR_JOB,
            steps=["tailor", "cover"],
            target_version="1",
            idempotency_key="owned",
            explicit_material_request=explicit,
        )
    )
    if legacy:
        payload.pop("explicit_material_request")
    async with time_skipping_env() as env:
        queue = "manual-decline-replay-" + uuid.uuid4().hex
        with patch("temporalio.workflow.execute_activity", new=without_new_activity_field if legacy else original):
            async with Worker(
                env.client,
                task_queue=queue,
                workflows=[JobPreparationWorkflow],
                activities=[started, finished, spend, tailor_activity, cover_activity],
                workflow_runner=UnsandboxedWorkflowRunner(),
            ):
                handle = await env.client.start_workflow(
                    JobPreparationWorkflow.run, payload, id=queue, task_queue=queue
                )
                result = await handle.result()
                history = await handle.fetch_history()
        assert result.steps_completed == ["tailor", "cover"] and result.steps_failed == []
        assert observed == [("tailor", None if legacy else explicit), ("cover", None if legacy else explicit)]
        await Replayer(workflows=[JobPreparationWorkflow], workflow_runner=UnsandboxedWorkflowRunner()).replay_workflow(
            history
        )


@pytest.mark.asyncio
async def test_high_scored_implicit_workflow_stops_tailor_and_does_not_dispatch_cover_or_pdf(tmp_path, monkeypatch):
    from jobctrl.preparation import workflow as prep
    from jobctrl.preparation.workflow import JobPreparationInput, JobPreparationWorkflow

    conn, job_id = seed(tmp_path, monkeypatch, "tailor")
    dispatched = []

    async def execute(fn, payload, **kwargs):
        dispatched.append(fn.__name__)
        if fn.__name__ == "score_job_activity":
            return {"status": "ok", "material_preparation_blocked": False, "score_version": 1}
        assert fn.__name__ == "tailor_job_activity"
        return activities._tailor_one_job(payload)

    monkeypatch.setattr(prep.workflow, "execute_activity", execute)
    monkeypatch.setattr(prep.workflow, "patched", lambda marker: True)
    result = await JobPreparationWorkflow()._execute_steps(
        JobPreparationInput(
            tenant_id=str(TENANT),
            job_id=job_id,
            steps=["score", "tailor", "cover", "pdf"],
            target_version="1",
            idempotency_key="owned",
        )
    )
    assert result.steps_completed == ["score"] and result.steps_skipped == ["tailor"]
    assert result.steps_failed == [] and result.failure is None
    assert dispatched == ["score_job_activity", "tailor_job_activity"]
    assert (
        conn.execute(
            "SELECT COUNT(*) FROM job_events WHERE event_type='StageStarted' AND stage IN ('tailor','cover')"
        ).fetchone()[0]
        == 0
    )


@pytest.mark.parametrize("stage", ["tailor", "cover"])
def test_manual_decline_does_not_require_an_existing_material_stage_row(tmp_path, monkeypatch, stage):
    conn, job_id = seed(tmp_path, monkeypatch, stage)
    conn.execute(
        "DELETE FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage=?", (str(TENANT), str(job_id), stage)
    )
    conn.commit()
    monkeypatch.setattr(
        "jobctrl.enrichment.availability.require_preparation_available",
        lambda *a, **k: pytest.fail("missing material row hid canonical Apply skip"),
    )
    payload_cls = activities.TailorJobActivityInput if stage == "tailor" else activities.CoverLetterActivityInput
    run = activities._tailor_one_job if stage == "tailor" else activities._cover_one_job
    result = run(payload_cls(tenant_id=str(TENANT), job_id=job_id))
    assert result["status"] == "skipped" and result["reason"] == "manual_apply_decline"
    row = conn.execute(
        "SELECT state,error_code,attempt_count FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage=?",
        (str(TENANT), str(job_id), stage),
    ).fetchone()
    assert tuple(row) == ("skipped", "MANUAL_APPLY_DECLINED", 0)


@pytest.mark.parametrize("stage", ["tailor", "cover"])
def test_recovery_activity_carries_implicit_intent_to_the_canonical_runner(world, monkeypatch, stage):
    from jobctrl.pipeline import automatic_preparation as recovery
    from tests.test_automatic_preparation_temporal_qa import seed_for_stage

    job_id = seed_for_stage(world, 1, stage)
    batch = recovery.reserve_recovery_batch(world.conn)
    seen = []

    def runner(owned_job_id, **kwargs):
        seen.append(owned_job_id)
        assert kwargs.get("explicit_material_request") is False
        return {"status": "skipped", "reason": "manual_apply_decline"}

    monkeypatch.setattr(
        tailor if stage == "tailor" else cover_letter,
        "tailor_job_by_id" if stage == "tailor" else "cover_letter_by_id",
        runner,
    )
    cls = activities.TailorActivityInput if stage == "tailor" else activities.CoverActivityInput
    run = activities._run_selected_tailoring if stage == "tailor" else activities._run_selected_cover
    result = run(cls(tenant_id="local", job_ids=(job_id,), recovery_workflow_id=batch.workflow_id))
    assert seen == [job_id] and result["status"] == "ok"
