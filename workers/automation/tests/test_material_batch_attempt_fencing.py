"""Synthetic activity entries for batch material retry ownership."""

import asyncio
import json
import threading
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from temporalio.testing import ActivityEnvironment

from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials.artifact_writer import LocalArtifactTextWriter
from jobctrl.materials import activities
from jobctrl.scoring import tailor
from jobctrl.state import record_job_event
from .test_artifact_determinations import JOB, JOB_ID
from .test_material_activity_recovery import _seed_owned_stage
from .test_materials_use_cases import Renderer, ResumeModel, request, resume_case, source_profile
from .test_v7_tailor_runtime import _seed_job, batch_runtime  # noqa: F401


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["selected", "current_policy", "unscoped"])
@pytest.mark.parametrize("workflow_owner", [None, "legacy-owner"])
async def test_batch_tailor_late_claim_preserves_newer_and_unrelated_jobs(
    batch_runtime, monkeypatch, tmp_path, route, workflow_owner,  # noqa: F811
):
    conn = batch_runtime.connect()
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=JOB_ID, url="https://example.test/owned")
    conn.execute("UPDATE job_enrichments SET full_description=? WHERE tenant_id='local' AND job_id=?", (JOB["full_description"], str(JOB_ID)))
    owner = workflow_owner or "same-run"
    unrelated = _seed_owned_stage(conn, 201, stage="tailor", workflow_id=owner)
    record_job_event(
        conn, canonical_job_id(unrelated), "tailor", "StageStarted",
        payload={"materialAttemptId": "other", "temporalRunId": "same-run",
                 "temporalActivityId": "other-activity", "temporalAttempt": 1},
    )
    conn.commit()
    unrelated_before = tuple(conn.execute("SELECT state,attempt_count,metadata_json FROM job_stage_states WHERE job_id=? AND stage='tailor'", (unrelated,)).fetchone())
    snapshot = ProfileSnapshot(LOCAL_TENANT, "default", 1, source_profile())
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository", lambda: SimpleNamespace(load_snapshot=lambda _: snapshot))
    analysis = request(tmp_path)["employer_analysis"]
    ready, release = threading.Event(), threading.Event()
    lock = threading.Lock()
    renderer_calls, case_calls = [], []

    def renderer():
        with lock:
            first = not renderer_calls
            renderer_calls.append(True)
        if first:
            ready.set()
            assert release.wait(10)
        return object()

    def build(**kwargs):
        with lock:
            label = "new" if not case_calls else "old"
            case_calls.append(label)
        case = resume_case(batch_runtime.connect(), ResumeModel(text=f"Synthetic {label}"), renderer=Renderer())
        case._analyze_use_case = SimpleNamespace(execute=lambda **_: SimpleNamespace(analysis=analysis))
        return case

    monkeypatch.setattr(tailor, "_build_pdf_renderer", renderer)
    monkeypatch.setattr(tailor, "_build_use_case", build)
    monkeypatch.setattr(tailor, "_load_requirement_fit_report_for_job", lambda **_: None)
    payload = activities.TailorActivityInput(
        tenant_id="local", job_ids=() if route == "unscoped" else (JOB_ID,),
        current_policy_only=route == "current_policy", workflow_id=workflow_owner,
    )
    old_env, new_env = ActivityEnvironment(), ActivityEnvironment()
    old_env.info = replace(old_env.info, workflow_run_id="same-run", attempt=1)
    new_env.info = replace(new_env.info, workflow_run_id="same-run", attempt=2)
    old = asyncio.create_task(old_env.run(activities.tailor_activity, payload))
    try:
        assert await asyncio.to_thread(ready.wait, 8)
        assert (await asyncio.wait_for(new_env.run(activities.tailor_activity, payload), 10)).status == "ok"
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE job_id=? AND status='approved' ORDER BY artifact_type", (str(JOB_ID),)).fetchall()
        accepted = [tuple(row) for row in rows]
        assert {row["artifact_type"] for row in rows} == {"tailored_resume", "resume_pdf"}
        files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows}
        release.set()
        assert (await asyncio.wait_for(old, 10)).status == "ok"
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE job_id=? AND status='approved' ORDER BY artifact_type", (str(JOB_ID),))] == accepted
        assert {path: path.read_bytes() for path in files} == files
        assert tuple(conn.execute("SELECT state,attempt_count,metadata_json FROM job_stage_states WHERE job_id=? AND stage='tailor'", (unrelated,)).fetchone()) == unrelated_before
        starts = conn.execute("SELECT payload_json FROM job_events WHERE job_id=? AND stage='tailor' AND event_type='StageStarted'", (str(JOB_ID),)).fetchall()
        assert len(starts) == 1
        event = json.loads(starts[0][0])
        assert event["temporalRunId"] == "same-run" and event["temporalAttempt"] == 2
    finally:
        release.set()
        await asyncio.gather(old, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["selected", "unscoped"])
@pytest.mark.parametrize("finish_first", ["old", "new"])
async def test_batch_tailor_publication_fences_both_completion_orders(
    batch_runtime, monkeypatch, tmp_path, route, finish_first,  # noqa: F811
):
    conn = batch_runtime.connect()
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=JOB_ID, url="https://example.test/owned")
    conn.execute("UPDATE job_enrichments SET full_description=? WHERE tenant_id='local' AND job_id=?", (JOB["full_description"], str(JOB_ID)))
    conn.commit()
    snapshot = ProfileSnapshot(LOCAL_TENANT, "default", 1, source_profile())
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository", lambda: SimpleNamespace(load_snapshot=lambda _: snapshot))
    analysis = request(tmp_path)["employer_analysis"]
    ready = {label: threading.Event() for label in ("old", "new")}
    release = {label: threading.Event() for label in ("old", "new")}
    lock, sequence = threading.Lock(), []

    def build(**kwargs):
        with lock:
            label = "old" if not sequence else "new"
            sequence.append(label)

        class Writer(LocalArtifactTextWriter):
            def write_text(self, path, text):
                if path.name.endswith("_g1.txt"):
                    ready[label].set()
                    assert release[label].wait(10)
                return super().write_text(path, text)

        case = resume_case(batch_runtime.connect(), ResumeModel(text=f"Synthetic {label}"), renderer=Renderer(), writer=Writer())
        case._analyze_use_case = SimpleNamespace(execute=lambda **_: SimpleNamespace(analysis=analysis))
        return case

    monkeypatch.setattr(tailor, "_build_use_case", build)
    monkeypatch.setattr(tailor, "_load_requirement_fit_report_for_job", lambda **_: None)
    payload = activities.TailorActivityInput(tenant_id="local", job_ids=(JOB_ID,) if route == "selected" else ())
    old_env, new_env = ActivityEnvironment(), ActivityEnvironment()
    old_env.info = replace(old_env.info, workflow_run_id="same-run", attempt=1)
    new_env.info = replace(new_env.info, workflow_run_id="same-run", attempt=2)
    old = asyncio.create_task(old_env.run(activities.tailor_activity, payload))
    new = None
    try:
        assert await asyncio.to_thread(ready["old"].wait, 8)
        new = asyncio.create_task(new_env.run(activities.tailor_activity, payload))
        assert await asyncio.to_thread(ready["new"].wait, 8)
        release[finish_first].set()
        if finish_first == "old":
            assert (await asyncio.wait_for(old, 10)).status == "ok"
            assert not new.done()
            assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='tailor'", (str(JOB_ID),)).fetchone()[0] == "running"
            assert conn.execute("SELECT COUNT(*) FROM job_materials_artifacts WHERE job_id=? AND status='approved'", (str(JOB_ID),)).fetchone()[0] == 0
            release["new"].set()
        assert (await asyncio.wait_for(new, 10)).status == "ok"
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE job_id=? AND status='approved' ORDER BY artifact_type", (str(JOB_ID),)).fetchall()
        accepted = [tuple(row) for row in rows]
        files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows}
        assert any(b"Synthetic new" in data for data in files.values())
        if finish_first == "new":
            release["old"].set()
            assert (await asyncio.wait_for(old, 10)).status == "ok"
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE job_id=? AND status='approved' ORDER BY artifact_type", (str(JOB_ID),))] == accepted
        assert {path: path.read_bytes() for path in files} == files
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='tailor'", (str(JOB_ID),)).fetchone()[0] == "succeeded"
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE job_id=? AND stage='tailor' AND event_type='StageCompleted'", (str(JOB_ID),)).fetchone()[0] == 1
    finally:
        for event in release.values():
            event.set()
        await asyncio.gather(*(task for task in (old, new) if task is not None), return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["selected", "unscoped"])
@pytest.mark.parametrize("workflow_owner", [None, "legacy-owner"])
async def test_batch_cover_late_claim_preserves_newer_and_other_tenant(
    batch_runtime, monkeypatch, tmp_path, route, workflow_owner,  # noqa: F811
):
    from jobctrl import database
    from jobctrl.scoring import cover_letter
    from .test_v7_cover_runtime import (
        _CoverLlm, _JOB_ID, _PdfRenderer, _TENANT_A, _TENANT_B, _seed_approved_resume,
        _seed_eligible_score, _seed_stage_rows, _seed_target, _snapshot,
    )

    conn = batch_runtime.connect()
    for tenant in (_TENANT_A, _TENANT_B):
        _seed_target(conn, tenant_id=tenant)
        _seed_eligible_score(conn, tenant_id=tenant)
        _seed_approved_resume(conn, tmp_path, tenant_id=tenant)
        _seed_stage_rows(conn, tenant_id=tenant)
    config_path = tmp_path / "cover-config.json"
    config_path.write_text('{"cover_letter_generation":true}')
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(config_path))
    monkeypatch.setattr("jobctrl.llm.enforce_spend_budget", lambda **_: None)
    monkeypatch.setattr(database, "DB_PATH", Path(batch_runtime.db_path))
    monkeypatch.setattr(cover_letter, "get_connection", batch_runtime.connect)
    monkeypatch.setattr(cover_letter, "COVER_LETTER_DIR", tmp_path / "covers")
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository", lambda: SimpleNamespace(load_snapshot=lambda tenant: _snapshot(tenant)))
    original_build = cover_letter._build_use_case

    def build(**kwargs):
        kwargs["llm_port"] = _CoverLlm()
        return original_build(**kwargs)

    ready, release = threading.Event(), threading.Event()
    lock = threading.Lock()
    calls = []

    def renderer():
        with lock:
            first = not calls
            calls.append(True)
        if first:
            ready.set()
            assert release.wait(10)
        return _PdfRenderer()

    monkeypatch.setattr(cover_letter, "_build_use_case", build)
    monkeypatch.setattr(cover_letter, "_build_pdf_renderer", renderer)
    payload = activities.CoverActivityInput(
        tenant_id=str(_TENANT_A), job_ids=() if route == "unscoped" else (_JOB_ID,),
        workflow_id=workflow_owner,
    )
    old_env, new_env = ActivityEnvironment(), ActivityEnvironment()
    old_env.info = replace(old_env.info, workflow_run_id="same-run", attempt=1)
    new_env.info = replace(new_env.info, workflow_run_id="same-run", attempt=2)
    old = asyncio.create_task(old_env.run(activities.cover_activity, payload))
    try:
        assert await asyncio.to_thread(ready.wait, 8)
        assert (await asyncio.wait_for(new_env.run(activities.cover_activity, payload), 10)).status == "ok"
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE tenant_id=? AND status='approved' ORDER BY artifact_type", (str(_TENANT_A),)).fetchall()
        accepted = [tuple(row) for row in rows]
        assert {row["artifact_type"] for row in rows} == {"tailored_resume", "resume_pdf", "cover_letter", "cover_letter_pdf"}
        files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows if Path(row["path"]).exists()}
        release.set()
        assert (await asyncio.wait_for(old, 10)).status == "ok"
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE tenant_id=? AND status='approved' ORDER BY artifact_type", (str(_TENANT_A),))] == accepted
        assert {path: path.read_bytes() for path in files} == files
        assert conn.execute("SELECT COUNT(*) FROM job_materials_artifacts WHERE tenant_id=? AND artifact_type='cover_letter'", (str(_TENANT_B),)).fetchone()[0] == 0
        assert conn.execute("SELECT state FROM job_stage_states WHERE tenant_id=? AND stage='cover'", (str(_TENANT_B),)).fetchone()[0] == "pending"
        starts = conn.execute("SELECT payload_json FROM job_events WHERE tenant_id=? AND stage='cover' AND event_type='StageStarted'", (str(_TENANT_A),)).fetchall()
        assert len(starts) == 1
        event = json.loads(starts[0][0])
        assert event["temporalRunId"] == "same-run" and event["temporalAttempt"] == 2
    finally:
        release.set()
        await asyncio.gather(old, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("route", ["selected", "unscoped"])
@pytest.mark.parametrize("finish_first", ["old", "new"])
async def test_batch_cover_publication_fences_both_completion_orders(
    batch_runtime, monkeypatch, tmp_path, route, finish_first,  # noqa: F811
):
    from jobctrl import database
    from jobctrl.scoring import cover_letter
    from .test_v7_cover_runtime import (
        _CoverLlm, _JOB_ID, _PdfRenderer, _TENANT_A, _seed_approved_resume,
        _seed_eligible_score, _seed_stage_rows, _seed_target, _snapshot,
    )

    conn = batch_runtime.connect()
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_A)
    _seed_stage_rows(conn, tenant_id=_TENANT_A)
    config_path = tmp_path / "cover-config.json"
    config_path.write_text('{"cover_letter_generation":true}')
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(config_path))
    monkeypatch.setattr("jobctrl.llm.enforce_spend_budget", lambda **_: None)
    monkeypatch.setattr(database, "DB_PATH", Path(batch_runtime.db_path))
    monkeypatch.setattr(cover_letter, "get_connection", batch_runtime.connect)
    monkeypatch.setattr(cover_letter, "COVER_LETTER_DIR", tmp_path / "covers")
    monkeypatch.setattr(cover_letter, "_build_pdf_renderer", _PdfRenderer)
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository", lambda: SimpleNamespace(load_snapshot=lambda _: _snapshot(_TENANT_A)))
    ready = {label: threading.Event() for label in ("old", "new")}
    release = {label: threading.Event() for label in ("old", "new")}
    lock, sequence = threading.Lock(), []
    original_build = cover_letter._build_use_case

    def build(**kwargs):
        with lock:
            label = "old" if not sequence else "new"
            sequence.append(label)

        class Model(_CoverLlm):
            def chat_json(self, messages, *, response_schema, **model_kwargs):
                if response_schema["title"] == "GeneratedProseDraft":
                    ready[label].set()
                    assert release[label].wait(10)
                return super().chat_json(messages, response_schema=response_schema, **model_kwargs)

        kwargs["llm_port"] = Model()
        return original_build(**kwargs)

    monkeypatch.setattr(cover_letter, "_build_use_case", build)
    payload = activities.CoverActivityInput(tenant_id=str(_TENANT_A), job_ids=(_JOB_ID,) if route == "selected" else ())
    old_env, new_env = ActivityEnvironment(), ActivityEnvironment()
    old_env.info = replace(old_env.info, workflow_run_id="same-run", attempt=1)
    new_env.info = replace(new_env.info, workflow_run_id="same-run", attempt=2)
    old = asyncio.create_task(old_env.run(activities.cover_activity, payload))
    new = None
    try:
        assert await asyncio.to_thread(ready["old"].wait, 8)
        new = asyncio.create_task(new_env.run(activities.cover_activity, payload))
        assert await asyncio.to_thread(ready["new"].wait, 8)
        release[finish_first].set()
        if finish_first == "old":
            assert (await asyncio.wait_for(old, 10)).status == "ok"
            assert not new.done()
            assert conn.execute("SELECT state FROM job_stage_states WHERE tenant_id=? AND stage='cover'", (str(_TENANT_A),)).fetchone()[0] == "running"
            assert conn.execute("SELECT COUNT(*) FROM job_materials_artifacts WHERE tenant_id=? AND artifact_type IN ('cover_letter','cover_letter_pdf')", (str(_TENANT_A),)).fetchone()[0] == 0
            release["new"].set()
        assert (await asyncio.wait_for(new, 10)).status == "ok"
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE tenant_id=? AND status='approved' ORDER BY artifact_type", (str(_TENANT_A),)).fetchall()
        accepted = [tuple(row) for row in rows]
        assert {row["artifact_type"] for row in rows} == {"tailored_resume", "resume_pdf", "cover_letter", "cover_letter_pdf"}
        files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows if Path(row["path"]).exists()}
        if finish_first == "new":
            release["old"].set()
            assert (await asyncio.wait_for(old, 10)).status == "ok"
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE tenant_id=? AND status='approved' ORDER BY artifact_type", (str(_TENANT_A),))] == accepted
        assert {path: path.read_bytes() for path in files} == files
        assert conn.execute("SELECT state FROM job_stage_states WHERE tenant_id=? AND stage='cover'", (str(_TENANT_A),)).fetchone()[0] == "succeeded"
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE tenant_id=? AND stage='cover' AND event_type='StageCompleted'", (str(_TENANT_A),)).fetchone()[0] == 1
    finally:
        for event in release.values():
            event.set()
        await asyncio.gather(*(task for task in (old, new) if task is not None), return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("stage,route", [
    ("tailor", "selected"), ("tailor", "current_policy"), ("tailor", "unscoped"),
    ("cover", "selected"), ("cover", "unscoped"),
])
async def test_batch_retry_recovery_skips_newer_and_other_activity(
    batch_runtime, monkeypatch, stage, route,  # noqa: F811
):
    from jobctrl.pipeline import runner

    conn = batch_runtime.connect()
    env = ActivityEnvironment()
    env.info = replace(env.info, workflow_run_id="same-run", attempt=2)
    newer = _seed_owned_stage(conn, 211, stage=stage, workflow_id="legacy-owner")
    older = _seed_owned_stage(conn, 212, stage=stage, workflow_id="legacy-owner")
    other = _seed_owned_stage(conn, 213, stage=stage, workflow_id="legacy-owner")
    outside = _seed_owned_stage(conn, 214, stage=stage, workflow_id="legacy-owner")
    for job_id, activity_id, number in (
        (newer, env.info.activity_id, 3), (older, env.info.activity_id, 1),
        (other, "other-activity", 1), (outside, env.info.activity_id, 1),
    ):
        record_job_event(
            conn, canonical_job_id(job_id), stage, "StageStarted",
            payload={"materialAttemptId": job_id, "temporalRunId": "same-run",
                     "temporalActivityId": activity_id, "temporalAttempt": number},
        )
    conn.commit()
    selected = tuple(canonical_job_id(value) for value in (newer, older, other))
    seen = []

    def selected_runner(_payload, **kwargs):
        seen.append(kwargs["temporal_attempt"])
        return {"status": "ok", "elapsed": 0.0, "errors": {}, "stages": []}

    def unscoped_runner(_stage, _runner, kwargs, **_other):
        seen.append(kwargs["temporal_attempt"])
        return ({}, 0.0, "ok")

    if route == "unscoped":
        monkeypatch.setattr(runner, "_run_stage_observed", unscoped_runner)
    elif stage == "cover":
        monkeypatch.setattr(activities, "_run_selected_cover", selected_runner)
    elif route == "current_policy":
        monkeypatch.setattr(activities, "_run_current_policy_tailoring", selected_runner)
    else:
        monkeypatch.setattr(activities, "_run_selected_tailoring", selected_runner)

    common = dict(tenant_id="local", workflow_id="legacy-owner", job_ids=() if route == "unscoped" else selected,
                  limit=1 if route == "current_policy" else 0)
    payload = (activities.TailorActivityInput(**common, current_policy_only=route == "current_policy")
               if stage == "tailor" else activities.CoverActivityInput(**common))
    entry = activities.tailor_activity if stage == "tailor" else activities.cover_activity
    assert (await env.run(entry, payload)).status == "ok"
    states = dict(conn.execute("SELECT job_id,state FROM job_stage_states WHERE stage=?", (stage,)).fetchall())
    assert states[newer] == "running"
    assert states[older] == "failed"
    assert states[other] == "running"
    assert states[outside] == ("failed" if route == "unscoped" else "running")
    assert len(seen) == 1 and seen[0].number == 2 and seen[0].run_id == "same-run"


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["tailor", "cover"])
@pytest.mark.parametrize("workers", [1, 2])
async def test_selected_batch_continues_other_jobs_after_supersession(monkeypatch, stage, workers):
    from jobctrl.infrastructure.preparation_recovery import PreparationReservationLost
    from jobctrl.scoring import cover_letter

    superseded = canonical_job_id("00000000-0000-4000-8000-000000000221")
    sibling = canonical_job_id("00000000-0000-4000-8000-000000000222")
    seen = []

    def run_one(job_id, **kwargs):
        seen.append((job_id, kwargs["temporal_attempt"]))
        if job_id == superseded:
            raise PreparationReservationLost("synthetic superseded attempt")
        return {"status": "approved"} if stage == "tailor" else {"status": "ok", "generated": 1}

    monkeypatch.setattr(tailor if stage == "tailor" else cover_letter,
                        "tailor_job_by_id" if stage == "tailor" else "cover_letter_by_id", run_one)
    kwargs = dict(tenant_id="local", job_ids=(superseded, sibling), workers=workers)
    payload = activities.TailorActivityInput(**kwargs) if stage == "tailor" else activities.CoverActivityInput(**kwargs)
    env = ActivityEnvironment()
    env.info = replace(env.info, workflow_run_id="same-run", attempt=1)
    entry = activities.tailor_activity if stage == "tailor" else activities.cover_activity
    result = await env.run(entry, payload)
    assert result.status == "ok"
    assert {job_id for job_id, _ in seen} == {superseded, sibling}
    assert all(attempt.run_id == "same-run" and attempt.number == 1 for _, attempt in seen)
    assert result.stages[0]["skipped"] == 1
    assert result.stages[0]["approved" if stage == "tailor" else "generated"] == 1
