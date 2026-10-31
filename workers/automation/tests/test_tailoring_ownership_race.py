"""A displaced tailoring activity cannot overwrite accepted artifact bytes."""
import asyncio
import json
import sqlite3
import threading
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from temporalio.testing import ActivityEnvironment
from temporalio.exceptions import ApplicationError

from jobctrl.database import close_thread_connections
from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials.artifact_writer import LocalArtifactTextWriter
from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
from jobctrl.materials import activities
from jobctrl.materials.activities import TailorJobActivityInput
from jobctrl.scoring import tailor
from .test_artifact_determinations import JOB, JOB_ID
from .test_materials_use_cases import Renderer, ResumeModel, request, resume_case, source_profile
from .test_v7_tailor_runtime import _direct_with_connection_cleanup, _seed_job, batch_runtime  # noqa: F401


def _assert_writer_available(db_path):
    with sqlite3.connect(db_path, timeout=0) as probe:
        probe.execute("BEGIN IMMEDIATE")
        probe.rollback()


@pytest.mark.asyncio
@pytest.mark.parametrize("finish_first", ["old", "new"])
async def test_same_workflow_retry_only_successor_can_publish(batch_runtime, monkeypatch, tmp_path, finish_first):  # noqa: F811
    conn = batch_runtime.connect()
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=JOB_ID, url="https://example.test/owned")
    conn.execute("UPDATE job_enrichments SET full_description=? WHERE tenant_id='local' AND job_id=?", (JOB["full_description"], str(JOB_ID)))
    conn.commit()
    snapshot = ProfileSnapshot(LOCAL_TENANT, "default", 1, source_profile())
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository", lambda: SimpleNamespace(load_snapshot=lambda _: snapshot))
    analysis = request(tmp_path)["employer_analysis"]
    ready = {label: threading.Event() for label in ("old", "new")}
    release = {label: threading.Event() for label in ("old", "new")}
    sequence = []
    factory_lock = threading.Lock()

    def build(**kwargs):
        with factory_lock:
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
    payload = TailorJobActivityInput(tenant_id="local", job_id=JOB_ID)
    old_env, new_env = ActivityEnvironment(), ActivityEnvironment()
    old_env.info = replace(old_env.info, workflow_run_id="same-workflow", attempt=1)
    new_env.info = replace(new_env.info, workflow_run_id="same-workflow", attempt=2)
    old = asyncio.create_task(old_env.run(activities.tailor_job_activity, payload))
    new = None
    try:
        assert await asyncio.to_thread(ready["old"].wait, 8)
        new = asyncio.create_task(new_env.run(activities.tailor_job_activity, payload))
        assert await asyncio.to_thread(ready["new"].wait, 8)
        starts = conn.execute("SELECT payload_json FROM job_events WHERE stage='tailor' AND event_type='StageStarted' ORDER BY event_id").fetchall()
        assert len(starts) == 2
        assert json.loads(starts[0][0])["materialAttemptId"] != json.loads(starts[1][0])["materialAttemptId"]
        release[finish_first].set()
        if finish_first == "old":
            with pytest.raises(ApplicationError, match="no longer owns artifact persistence"):
                await asyncio.wait_for(old, 10)
            assert not new.done()
            assert conn.execute("SELECT state FROM job_stage_states WHERE stage='tailor'").fetchone()[0] == "running"
            assert conn.execute("SELECT COUNT(*) FROM job_materials_artifacts WHERE status='approved'").fetchone()[0] == 0
            release["new"].set()
        assert (await asyncio.wait_for(new, 10)).status == "approved"
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type").fetchall()
        accepted_rows = [tuple(row) for row in rows]
        assert {row["artifact_type"] for row in rows} == {"tailored_resume", "resume_pdf"}
        files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows}
        assert any(b"Synthetic new" in data for data in files.values())
        if finish_first == "new":
            release["old"].set()
            with pytest.raises(ApplicationError, match="no longer owns artifact persistence"):
                await asyncio.wait_for(old, 10)
        assert conn.execute("SELECT state FROM job_stage_states WHERE stage='tailor'").fetchone()[0] == "succeeded"
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type")] == accepted_rows
        assert {path: path.read_bytes() for path in files} == files
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE stage='tailor' AND event_type='StageCompleted'").fetchone()[0] == 1
    finally:
        for event in release.values():
            event.set()
        await asyncio.gather(*(task for task in (old, new) if task is not None), return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("old_direct", [False, True])
async def test_late_tailor_claim_cannot_replace_successor(batch_runtime, monkeypatch, tmp_path, old_direct):  # noqa: F811
    conn = batch_runtime.connect()
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=JOB_ID, url="https://example.test/owned")
    conn.execute("UPDATE job_enrichments SET full_description=? WHERE tenant_id='local' AND job_id=?", (JOB["full_description"], str(JOB_ID)))
    conn.commit()
    snapshot = ProfileSnapshot(LOCAL_TENANT, "default", 1, source_profile())
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository", lambda: SimpleNamespace(load_snapshot=lambda _: snapshot))
    analysis = request(tmp_path)["employer_analysis"]
    ready, release = threading.Event(), threading.Event()
    factory_lock = threading.Lock()
    renderer_calls, case_calls = [], []

    def renderer():
        with factory_lock:
            first = not renderer_calls
            renderer_calls.append(True)
        if first:
            ready.set()
            assert release.wait(10)
        return object()

    def build(**kwargs):
        with factory_lock:
            label = "new" if not case_calls else "old"
            case_calls.append(label)
        case = resume_case(batch_runtime.connect(), ResumeModel(text=f"Synthetic {label}"), renderer=Renderer())
        case._analyze_use_case = SimpleNamespace(execute=lambda **_: SimpleNamespace(analysis=analysis))
        return case

    monkeypatch.setattr(tailor, "_build_pdf_renderer", renderer)
    monkeypatch.setattr(tailor, "_build_use_case", build)
    monkeypatch.setattr(tailor, "_load_requirement_fit_report_for_job", lambda **_: None)
    payload = TailorJobActivityInput(tenant_id="local", job_id=JOB_ID)
    old_env, new_env = ActivityEnvironment(), ActivityEnvironment()
    old_env.info = replace(old_env.info, workflow_run_id="same-workflow", attempt=1)
    new_env.info = replace(new_env.info, workflow_run_id="same-workflow", attempt=2)
    old = (asyncio.create_task(asyncio.to_thread(_direct_with_connection_cleanup, tailor.tailor_job_by_id, JOB_ID, snapshot=snapshot, tenant_id=LOCAL_TENANT))
           if old_direct else asyncio.create_task(old_env.run(activities.tailor_job_activity, payload)))
    try:
        assert await asyncio.to_thread(ready.wait, 8)
        assert (await asyncio.wait_for(new_env.run(activities.tailor_job_activity, payload), 10)).status == "approved"
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type").fetchall()
        accepted = [tuple(row) for row in rows]
        files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows}
        release.set()
        if old_direct:
            assert (await asyncio.wait_for(old, 10))["status"] == "skipped"
        else:
            with pytest.raises(ApplicationError, match="no longer owns artifact persistence"):
                await asyncio.wait_for(old, 10)
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type")] == accepted
        assert {path: path.read_bytes() for path in files} == files
        assert conn.execute("SELECT state FROM job_stage_states WHERE stage='tailor'").fetchone()[0] == "succeeded"
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE stage='tailor' AND event_type='StageStarted'").fetchone()[0] == 1
    finally:
        release.set()
        await asyncio.gather(old, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("finish_first", ["old", "new"])
async def test_same_workflow_cover_retry_only_successor_can_publish(batch_runtime, monkeypatch, tmp_path, finish_first):  # noqa: F811
    from jobctrl.scoring import cover_letter
    from jobctrl import database
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
    factory_lock = threading.Lock()
    sequence = []
    original_build = cover_letter._build_use_case

    def build(**kwargs):
        with factory_lock:
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
    payload = activities.CoverLetterActivityInput(tenant_id=str(_TENANT_A), job_id=_JOB_ID)
    old_env, new_env = ActivityEnvironment(), ActivityEnvironment()
    old_env.info = replace(old_env.info, workflow_run_id="same-workflow", attempt=1)
    new_env.info = replace(new_env.info, workflow_run_id="same-workflow", attempt=2)
    old = asyncio.create_task(old_env.run(activities.cover_letter_activity, payload))
    new = None
    try:
        assert await asyncio.to_thread(ready["old"].wait, 8)
        _assert_writer_available(batch_runtime.db_path)
        assert (str(_TENANT_A), "StageStarted", True, True) in batch_runtime.projection_events
        new = asyncio.create_task(new_env.run(activities.cover_letter_activity, payload))
        assert await asyncio.to_thread(ready["new"].wait, 8)
        starts = conn.execute("SELECT payload_json FROM job_events WHERE stage='cover' AND event_type='StageStarted' ORDER BY event_id").fetchall()
        assert len(starts) == 2
        assert json.loads(starts[0][0])["materialAttemptId"] != json.loads(starts[1][0])["materialAttemptId"]
        release[finish_first].set()
        if finish_first == "old":
            with pytest.raises(ApplicationError, match="no longer owns artifact persistence"):
                await asyncio.wait_for(old, 10)
            assert not new.done()
            assert conn.execute("SELECT state FROM job_stage_states WHERE stage='cover'").fetchone()[0] == "running"
            assert conn.execute("SELECT COUNT(*) FROM job_materials_artifacts WHERE artifact_type IN ('cover_letter','cover_letter_pdf')").fetchone()[0] == 0
            release["new"].set()
        assert (await asyncio.wait_for(new, 10)).status == "ok"
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type").fetchall()
        accepted_rows = [tuple(row) for row in rows]
        assert {row["artifact_type"] for row in rows} == {"tailored_resume", "resume_pdf", "cover_letter", "cover_letter_pdf"}
        files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows if Path(row["path"]).exists()}
        if finish_first == "new":
            release["old"].set()
            with pytest.raises(ApplicationError, match="no longer owns artifact persistence"):
                await asyncio.wait_for(old, 10)
        assert conn.execute("SELECT state FROM job_stage_states WHERE stage='cover'").fetchone()[0] == "succeeded"
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type")] == accepted_rows
        assert {path: path.read_bytes() for path in files} == files
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE stage='cover' AND event_type='StageCompleted'").fetchone()[0] == 1
        assert (str(_TENANT_A), "StageCompleted", True, True) in batch_runtime.projection_events
    finally:
        for event in release.values():
            event.set()
        await asyncio.gather(*(task for task in (old, new) if task is not None), return_exceptions=True)


@pytest.mark.asyncio
async def test_cover_retry_preserves_committed_text_and_fences_old_pdf(batch_runtime, monkeypatch, tmp_path):  # noqa: F811
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
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository", lambda: SimpleNamespace(load_snapshot=lambda _: _snapshot(_TENANT_A)))
    original_build = cover_letter._build_use_case

    def build(**kwargs):
        kwargs["llm_port"] = _CoverLlm()
        return original_build(**kwargs)

    ready, release = threading.Event(), threading.Event()

    class PdfRenderer(_PdfRenderer):
        def render_cover_letter_to_pdf(self, **kwargs):
            ready.set()
            assert release.wait(10)
            return super().render_cover_letter_to_pdf(**kwargs)

    monkeypatch.setattr(cover_letter, "_build_use_case", build)
    monkeypatch.setattr(cover_letter, "_build_pdf_renderer", PdfRenderer)
    payload = activities.CoverLetterActivityInput(tenant_id=str(_TENANT_A), job_id=_JOB_ID)
    old_env, new_env = ActivityEnvironment(), ActivityEnvironment()
    old_env.info = replace(old_env.info, workflow_run_id="same-workflow", attempt=1)
    new_env.info = replace(new_env.info, workflow_run_id="same-workflow", attempt=2)
    old = asyncio.create_task(old_env.run(activities.cover_letter_activity, payload))
    try:
        assert await asyncio.to_thread(ready.wait, 8)
        _assert_writer_available(batch_runtime.db_path)
        assert (str(_TENANT_A), "StageStarted", True, True) in batch_runtime.projection_events
        accepted = conn.execute("SELECT artifact_id,path FROM job_materials_artifacts WHERE artifact_type='cover_letter'").fetchone()
        accepted_row = tuple(accepted)
        text = Path(accepted["path"]).read_bytes()
        result = await asyncio.wait_for(new_env.run(activities.cover_letter_activity, payload), 10)
        assert result.status == "already_done"
        assert conn.execute("SELECT state FROM job_stage_states WHERE stage='cover'").fetchone()[0] == "succeeded"
        assert (str(_TENANT_A), "StageCompleted", True, True) in batch_runtime.projection_events
        release.set()
        with pytest.raises(ApplicationError, match="no longer owns artifact persistence"):
            await asyncio.wait_for(old, 10)
        assert tuple(conn.execute("SELECT artifact_id,path FROM job_materials_artifacts WHERE artifact_type='cover_letter'").fetchone()) == accepted_row
        assert Path(accepted["path"]).read_bytes() == text
        assert conn.execute("SELECT COUNT(*) FROM job_materials_artifacts WHERE artifact_type='cover_letter_pdf'").fetchone()[0] == 0
        assert conn.execute("SELECT state FROM job_stage_states WHERE stage='cover'").fetchone()[0] == "succeeded"
    finally:
        release.set()
        await asyncio.gather(old, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("old_direct", [False, True])
async def test_late_cover_claim_cannot_replace_successor(batch_runtime, monkeypatch, tmp_path, old_direct):  # noqa: F811
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
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository", lambda: SimpleNamespace(load_snapshot=lambda _: _snapshot(_TENANT_A)))
    original_build = cover_letter._build_use_case

    def build(**kwargs):
        kwargs["llm_port"] = _CoverLlm()
        return original_build(**kwargs)

    ready, release = threading.Event(), threading.Event()
    factory_lock = threading.Lock()
    calls = []

    def renderer():
        with factory_lock:
            first = not calls
            calls.append(True)
        if first:
            ready.set()
            assert release.wait(10)
        return _PdfRenderer()

    monkeypatch.setattr(cover_letter, "_build_use_case", build)
    monkeypatch.setattr(cover_letter, "_build_pdf_renderer", renderer)
    payload = activities.CoverLetterActivityInput(tenant_id=str(_TENANT_A), job_id=_JOB_ID)
    old_env, new_env = ActivityEnvironment(), ActivityEnvironment()
    old_env.info = replace(old_env.info, workflow_run_id="same-workflow", attempt=1)
    new_env.info = replace(new_env.info, workflow_run_id="same-workflow", attempt=2)
    old = (asyncio.create_task(asyncio.to_thread(_direct_with_connection_cleanup, cover_letter.cover_letter_by_id, _JOB_ID, snapshot=_snapshot(_TENANT_A), tenant_id=_TENANT_A))
           if old_direct else asyncio.create_task(old_env.run(activities.cover_letter_activity, payload)))
    try:
        assert await asyncio.to_thread(ready.wait, 8)
        assert (await asyncio.wait_for(new_env.run(activities.cover_letter_activity, payload), 10)).status == "ok"
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type").fetchall()
        accepted = [tuple(row) for row in rows]
        files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows if Path(row["path"]).exists()}
        release.set()
        if old_direct:
            assert (await asyncio.wait_for(old, 10))["status"] == "skipped"
        else:
            with pytest.raises(ApplicationError, match="no longer owns artifact persistence"):
                await asyncio.wait_for(old, 10)
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type")] == accepted
        assert {path: path.read_bytes() for path in files} == files
        assert conn.execute("SELECT state FROM job_stage_states WHERE stage='cover'").fetchone()[0] == "succeeded"
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE stage='cover' AND event_type='StageStarted'").fetchone()[0] == 1
    finally:
        release.set()
        await asyncio.gather(old, return_exceptions=True)


@pytest.mark.asyncio
async def test_lost_tailor_owner_preserves_successor_files(batch_runtime, monkeypatch, tmp_path):  # noqa: F811
    conn = batch_runtime.connect()
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=JOB_ID, url="https://example.test/owned")
    conn.execute("UPDATE job_enrichments SET full_description=? WHERE tenant_id='local' AND job_id=?", (JOB["full_description"], str(JOB_ID)))
    conn.commit()
    snapshot = ProfileSnapshot(LOCAL_TENANT, "default", 1, source_profile())
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository", lambda: SimpleNamespace(load_snapshot=lambda _: snapshot))
    analysis = request(tmp_path)["employer_analysis"]
    first_started, release = threading.Event(), threading.Event()
    factory_lock = threading.Lock()
    sequence = []
    attempted_paths = {}

    def build(**kwargs):
        with factory_lock:
            label = "slow" if not sequence else "fast"
            sequence.append(label)

        class Writer(LocalArtifactTextWriter):
            def write_text(self, path, text):
                if path.name.endswith("_g1.txt"):
                    attempted_paths[label] = path
                    if label == "slow":
                        first_started.set()
                        assert release.wait(5)
                return super().write_text(path, text)

        case = resume_case(batch_runtime.connect(), ResumeModel(text=f"Synthetic {label}"),
                           renderer=Renderer(), writer=Writer())
        case._analyze_use_case = SimpleNamespace(execute=lambda **_: SimpleNamespace(analysis=analysis))
        return case

    monkeypatch.setattr(tailor, "_build_use_case", build)
    monkeypatch.setattr(tailor, "_load_requirement_fit_report_for_job", lambda **_: None)
    payload = TailorJobActivityInput(tenant_id="local", job_id=JOB_ID)
    first_env, second_env = ActivityEnvironment(), ActivityEnvironment()
    first_env.info = replace(first_env.info, workflow_run_id="synthetic-slow")
    second_env.info = replace(second_env.info, workflow_run_id="synthetic-fast")
    first = asyncio.create_task(first_env.run(activities.tailor_job_activity, payload))
    try:
        assert await asyncio.to_thread(first_started.wait, 5)
        second = await asyncio.wait_for(second_env.run(activities.tailor_job_activity, payload), 10)
        assert second.status == "approved"
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type").fetchall()
        assert {row["artifact_type"] for row in rows} == {"tailored_resume", "resume_pdf"}
        accepted_rows = [tuple(row) for row in rows]
        accepted_files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows}
        release.set()
        with pytest.raises(ApplicationError, match="no longer owns artifact persistence"):
            await asyncio.wait_for(first, 10)
        assert attempted_paths["slow"] != attempted_paths["fast"]
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type")] == accepted_rows
        assert {path: path.read_bytes() for path in accepted_files} == accepted_files
    finally:
        release.set()
        if not first.done():
            first.cancel()
            await asyncio.gather(first, return_exceptions=True)


def test_same_generation_tailor_revalidates_before_publication(batch_runtime, tmp_path):  # noqa: F811
    conn = batch_runtime.connect()
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=JOB_ID, url="https://example.test/owned")
    conn.execute(
        "INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at,metadata_json) "
        "VALUES ('local',?,1,'resume_in_progress','t0','t0',?)",
        (str(JOB_ID), json.dumps({"__jobctrl_materials_lineage_id": "12345678123456781234567812345678"})),
    )
    conn.commit()
    waiting, release, finished = (threading.Event() for _ in range(3))
    outcomes, failures = {}, {}

    def run(label):
        class Writer(LocalArtifactTextWriter):
            def write_text(self, path, text):
                if label == "slow" and path.name.endswith("_g1.txt"):
                    waiting.set()
                    assert release.wait(5)
                return super().write_text(path, text)

        try:
            case = resume_case(batch_runtime.connect(), ResumeModel(text=f"Synthetic {label}"),
                               renderer=Renderer(), writer=Writer())
            outcomes[label] = case.execute(**request(tmp_path))
        except Exception as exc:
            failures[label] = exc
        finally:
            close_thread_connections()
            if label == "fast":
                finished.set()

    slow = threading.Thread(target=run, args=("slow",))
    fast = threading.Thread(target=run, args=("fast",))
    slow.start()
    try:
        assert waiting.wait(5)
        fast.start()
        assert finished.wait(5)
        assert "fast" not in failures and outcomes["fast"].status == "approved"
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type").fetchall()
        accepted = [tuple(row) for row in rows]
        files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows}
        release.set()
        slow.join(timeout=5)
        assert not slow.is_alive()
        assert "slow" in failures and "materials_changed_during_tailoring" in str(failures["slow"])
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type")] == accepted
        assert {path: path.read_bytes() for path in files} == files
    finally:
        release.set()
        slow.join(timeout=5)
        if fast.ident is not None:
            fast.join(timeout=5)


def test_direct_sqlite_tailor_serializes_validation_and_save_without_injected_unit(batch_runtime, tmp_path):  # noqa: F811
    conn = batch_runtime.connect()
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=JOB_ID, url="https://example.test/owned")
    observed = []

    class Repository(SqliteMaterialsRepository):
        def save(self, materials):
            with sqlite3.connect(batch_runtime.db_path, timeout=0) as writer:
                try:
                    writer.execute("UPDATE jobs SET title=title WHERE tenant_id='local' AND job_id=?", (str(JOB_ID),))
                except sqlite3.OperationalError as exc:
                    assert "locked" in str(exc)
                    observed.append("blocked")
                else:
                    writer.rollback()
                    observed.append("admitted")
            return super().save(materials)

    case = resume_case(conn, ResumeModel(), renderer=Renderer(), repository=Repository(conn))
    # Exercise the public direct-composition path without the optional UoW.
    case._unit_of_work = None
    assert case.execute(**request(tmp_path)).status == "approved"
    assert observed == ["blocked"]
