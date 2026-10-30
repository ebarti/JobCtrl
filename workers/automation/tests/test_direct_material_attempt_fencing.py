"""Mixed direct and Temporal material attempts retain their actual owner."""

import asyncio
import json
import threading
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from temporalio.exceptions import ApplicationError
from temporalio.testing import ActivityEnvironment

from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials.artifact_writer import LocalArtifactTextWriter
from jobctrl.materials import activities
from jobctrl.scoring import tailor
from jobctrl.state import record_job_event
from .test_artifact_determinations import JOB, JOB_ID
from .test_materials_use_cases import Renderer, ResumeModel, request, resume_case, source_profile
from .test_v7_tailor_runtime import _direct_with_connection_cleanup, _seed_job, batch_runtime  # noqa: F401


@pytest.mark.asyncio
@pytest.mark.parametrize("old_direct,new_direct", [(True, False), (False, True), (True, True)])
@pytest.mark.parametrize("old_fails", [True, False])
@pytest.mark.parametrize("finish_first", ["old", "new"])
async def test_mixed_tailor_attempts_preserve_successor(
    batch_runtime, monkeypatch, tmp_path, old_direct, new_direct, old_fails, finish_first,  # noqa: F811
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
                    if label == "old" and old_fails:
                        raise RuntimeError("synthetic old write failure")
                return super().write_text(path, text)

        case = resume_case(batch_runtime.connect(), ResumeModel(text=f"Synthetic {label}"), renderer=Renderer(), writer=Writer())
        case._analyze_use_case = SimpleNamespace(execute=lambda **_: SimpleNamespace(analysis=analysis))
        return case

    monkeypatch.setattr(tailor, "_build_use_case", build)
    monkeypatch.setattr(tailor, "_load_requirement_fit_report_for_job", lambda **_: None)
    payload = activities.TailorJobActivityInput(tenant_id="local", job_id=JOB_ID)
    env = ActivityEnvironment()
    env.info = replace(env.info, workflow_run_id="synthetic-workflow", attempt=1)

    def start(direct):
        if direct:
            return asyncio.create_task(asyncio.to_thread(_direct_with_connection_cleanup, tailor.tailor_job_by_id, JOB_ID, snapshot=snapshot, tenant_id=LOCAL_TENANT))
        return asyncio.create_task(env.run(activities.tailor_job_activity, payload))

    async def expect_old(task):
        if old_direct:
            outcome = await asyncio.wait_for(task, 10)
            assert outcome["status"] == "skipped" and outcome["reason"] == "materials_changed_during_tailoring"
            assert outcome["url"] == "https://example.test/owned"
        else:
            with pytest.raises(ApplicationError, match="no longer owns artifact persistence"):
                await asyncio.wait_for(task, 10)

    old = start(old_direct)
    new = None
    try:
        assert await asyncio.to_thread(ready["old"].wait, 8)
        new = start(new_direct)
        assert await asyncio.to_thread(ready["new"].wait, 8)
        release[finish_first].set()
        if finish_first == "old":
            await expect_old(old)
            assert not new.done()
            assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='tailor'", (str(JOB_ID),)).fetchone()[0] == "running"
            assert conn.execute("SELECT COUNT(*) FROM job_materials_artifacts WHERE job_id=? AND status='approved'", (str(JOB_ID),)).fetchone()[0] == 0
            release["new"].set()
        winner = await asyncio.wait_for(new, 10)
        assert (winner["status"] if new_direct else winner.status) == "approved"
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE job_id=? AND status='approved' ORDER BY artifact_type", (str(JOB_ID),)).fetchall()
        accepted = [tuple(row) for row in rows]
        files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows}
        assert any(b"Synthetic new" in data for data in files.values())
        if finish_first == "new":
            release["old"].set()
            await expect_old(old)
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE job_id=? AND status='approved' ORDER BY artifact_type", (str(JOB_ID),))] == accepted
        assert {path: path.read_bytes() for path in files} == files
        assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='tailor'", (str(JOB_ID),)).fetchone()[0] == "succeeded"
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE job_id=? AND stage='tailor' AND event_type='StageFailed'", (str(JOB_ID),)).fetchone()[0] == 0
    finally:
        for event in release.values():
            event.set()
        await asyncio.gather(*(task for task in (old, new) if task is not None), return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("old_direct,new_direct", [(True, False), (False, True), (True, True)])
@pytest.mark.parametrize("old_fails", [True, False])
@pytest.mark.parametrize("finish_first", ["old", "new"])
async def test_mixed_cover_attempts_preserve_successor(
    batch_runtime, monkeypatch, tmp_path, old_direct, new_direct, old_fails, finish_first,  # noqa: F811
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
                    if label == "old" and old_fails:
                        raise RuntimeError("synthetic old model failure")
                return super().chat_json(messages, response_schema=response_schema, **model_kwargs)

        kwargs["llm_port"] = Model()
        return original_build(**kwargs)

    monkeypatch.setattr(cover_letter, "_build_use_case", build)
    payload = activities.CoverLetterActivityInput(tenant_id=str(_TENANT_A), job_id=_JOB_ID)
    env = ActivityEnvironment()
    env.info = replace(env.info, workflow_run_id="synthetic-workflow", attempt=1)

    def start(direct):
        if direct:
            return asyncio.create_task(asyncio.to_thread(_direct_with_connection_cleanup, cover_letter.cover_letter_by_id, _JOB_ID, snapshot=_snapshot(_TENANT_A), tenant_id=_TENANT_A))
        return asyncio.create_task(env.run(activities.cover_letter_activity, payload))

    async def expect_old(task):
        if old_direct:
            outcome = await asyncio.wait_for(task, 10)
            assert outcome["status"] == "skipped" and outcome["reason"] == "materials_changed_during_cover"
            assert outcome["url"] == "https://jobs.example.test/roles/platform-engineer"
        else:
            with pytest.raises(ApplicationError, match="no longer owns artifact persistence"):
                await asyncio.wait_for(task, 10)

    old = start(old_direct)
    new = None
    try:
        assert await asyncio.to_thread(ready["old"].wait, 8)
        new = start(new_direct)
        assert await asyncio.to_thread(ready["new"].wait, 8)
        release[finish_first].set()
        if finish_first == "old":
            await expect_old(old)
            assert not new.done()
            assert conn.execute("SELECT state FROM job_stage_states WHERE tenant_id=? AND stage='cover'", (str(_TENANT_A),)).fetchone()[0] == "running"
            assert conn.execute("SELECT COUNT(*) FROM job_materials_artifacts WHERE tenant_id=? AND artifact_type IN ('cover_letter','cover_letter_pdf')", (str(_TENANT_A),)).fetchone()[0] == 0
            release["new"].set()
        winner = await asyncio.wait_for(new, 10)
        assert (winner["status"] if new_direct else winner.status) == "ok"
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE tenant_id=? AND status='approved' ORDER BY artifact_type", (str(_TENANT_A),)).fetchall()
        accepted = [tuple(row) for row in rows]
        assert {row["artifact_type"] for row in rows} == {"tailored_resume", "resume_pdf", "cover_letter", "cover_letter_pdf"}
        files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows if Path(row["path"]).exists()}
        if finish_first == "new":
            release["old"].set()
            await expect_old(old)
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE tenant_id=? AND status='approved' ORDER BY artifact_type", (str(_TENANT_A),))] == accepted
        assert {path: path.read_bytes() for path in files} == files
        assert conn.execute("SELECT state FROM job_stage_states WHERE tenant_id=? AND stage='cover'", (str(_TENANT_A),)).fetchone()[0] == "succeeded"
        assert conn.execute("SELECT COUNT(*) FROM job_events WHERE tenant_id=? AND stage='cover' AND event_type='StageFailed'", (str(_TENANT_A),)).fetchone()[0] == 0
    finally:
        for event in release.values():
            event.set()
        await asyncio.gather(*(task for task in (old, new) if task is not None), return_exceptions=True)


@pytest.mark.parametrize("stage", ["tailor", "cover"])
def test_direct_already_done_preserves_an_active_workflow_stage(
    batch_runtime, monkeypatch, tmp_path, stage,  # noqa: F811
):
    _assert_direct_reuse_preserves_active_stage(
        batch_runtime, monkeypatch, tmp_path, stage, workflow_id="active-workflow",
    )


@pytest.mark.parametrize("stage", ["tailor", "cover"])
def test_direct_already_done_preserves_an_active_direct_stage(
    batch_runtime, monkeypatch, tmp_path, stage,  # noqa: F811
):
    _assert_direct_reuse_preserves_active_stage(
        batch_runtime, monkeypatch, tmp_path, stage, workflow_id=None,
    )


def _assert_direct_reuse_preserves_active_stage(batch_runtime, monkeypatch, tmp_path, stage, *, workflow_id):
    from jobctrl import database
    from jobctrl.infrastructure.preparation_recovery import assert_material_activity_commit_allowed
    from jobctrl.scoring import cover_letter
    from .test_v7_cover_runtime import (
        _JOB_ID, _TENANT_A, _seed_approved_resume, _seed_eligible_score,
        _seed_stage_rows, _seed_target, _snapshot,
    )

    conn = batch_runtime.connect()
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_A)
    _seed_stage_rows(conn, tenant_id=_TENANT_A)
    if stage == "cover":
        path = tmp_path / "accepted-cover.txt"
        path.write_text("Synthetic accepted cover", encoding="utf-8")
        conn.execute(
            "INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) "
            "VALUES (?,?,1,'cover_letter','accepted-cover','approved',?,'text','2026-01-01')",
            (str(_TENANT_A), str(_JOB_ID), str(path)),
        )
    conn.execute(
        "UPDATE job_stage_states SET state='running',metadata_json=? WHERE tenant_id=? AND job_id=? AND stage=?",
        (json.dumps({"activityOwner": workflow_id} if workflow_id else {}), str(_TENANT_A), str(_JOB_ID), stage),
    )
    record_job_event(conn, _JOB_ID, stage, "StageStarted", tenant_id=_TENANT_A, payload={"materialAttemptId": "active"})
    conn.commit()
    scope = (str(_TENANT_A), str(_JOB_ID), stage)
    stage_sql = "SELECT * FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage=?"
    event_sql = "SELECT * FROM job_events WHERE tenant_id=? AND job_id=? AND stage=? ORDER BY event_id"
    stage_before = tuple(conn.execute(stage_sql, scope).fetchone())
    events_before = [tuple(row) for row in conn.execute(event_sql, scope)]
    materials_sql = "SELECT * FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? ORDER BY generation,artifact_type"
    materials_before = [tuple(row) for row in conn.execute(materials_sql, scope[:2])]
    paths = [Path(row[0]) for row in conn.execute(
        "SELECT path FROM job_materials_artifacts WHERE tenant_id=? AND job_id=?", scope[:2],
    )]
    for path in paths:
        if not path.exists():
            path.write_bytes(b"Synthetic accepted PDF bytes")
    bytes_before = {path: path.read_bytes() for path in paths}
    guard = dict(tenant_id=str(_TENANT_A), job_id=str(_JOB_ID), stage=stage,
                 workflow_id=workflow_id, attempt_id="active")
    assert_material_activity_commit_allowed(conn, **guard)
    config_path = tmp_path / "cover-config.json"
    config_path.write_text('{"cover_letter_generation":true}')
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(config_path))
    monkeypatch.setattr(database, "DB_PATH", Path(batch_runtime.db_path))
    monkeypatch.setattr(cover_letter, "get_connection", batch_runtime.connect)
    if stage == "tailor":
        result = tailor.tailor_job_by_id(_JOB_ID, snapshot=_snapshot(_TENANT_A), tenant_id=_TENANT_A)
    else:
        result = cover_letter.cover_letter_by_id(_JOB_ID, snapshot=_snapshot(_TENANT_A), tenant_id=_TENANT_A)
    assert result["status"] == "already_done"
    assert tuple(conn.execute(stage_sql, scope).fetchone()) == stage_before
    assert [tuple(row) for row in conn.execute(event_sql, scope)] == events_before
    assert [tuple(row) for row in conn.execute(materials_sql, scope[:2])] == materials_before
    assert {path: path.read_bytes() for path in paths} == bytes_before
    assert_material_activity_commit_allowed(conn, **guard)


def test_direct_tailor_keeps_legacy_caller_transaction_compatibility(batch_runtime, monkeypatch, tmp_path):  # noqa: F811
    conn = batch_runtime.connect()
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=JOB_ID, url="https://example.test/owned")
    conn.execute("UPDATE job_enrichments SET full_description=? WHERE tenant_id='local' AND job_id=?", (JOB["full_description"], str(JOB_ID)))
    conn.commit()
    conn.execute("BEGIN")
    conn.execute("UPDATE jobs SET title='Synthetic changed title' WHERE job_id=?", (str(JOB_ID),))
    monkeypatch.setattr(tailor, "_tailor_one_job", lambda job, *_args, **_kwargs: {"status": "approved", "url": job["url"]})
    snapshot = ProfileSnapshot(LOCAL_TENANT, "default", 1, source_profile())
    result = tailor.tailor_job_by_id(JOB_ID, snapshot=snapshot, tenant_id=LOCAL_TENANT)
    assert result["status"] == "approved"
    assert conn.execute("SELECT state FROM job_stage_states WHERE job_id=? AND stage='tailor'", (str(JOB_ID),)).fetchone()[0] == "succeeded"


def test_direct_cover_already_done_accepts_a_caller_transaction(batch_runtime, monkeypatch, tmp_path):  # noqa: F811
    from jobctrl.scoring import cover_letter
    from .test_v7_cover_runtime import (
        _JOB_ID, _TENANT_A, _seed_approved_resume, _seed_eligible_score,
        _seed_stage_rows, _seed_target, _snapshot,
    )

    conn = batch_runtime.connect()
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_A)
    _seed_stage_rows(conn, tenant_id=_TENANT_A)
    path = tmp_path / "accepted-cover.txt"
    path.write_text("Synthetic accepted cover", encoding="utf-8")
    conn.execute(
        "INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) "
        "VALUES (?,?,1,'cover_letter','accepted-cover','approved',?,'text','2026-01-01')",
        (str(_TENANT_A), str(_JOB_ID), str(path)),
    )
    conn.commit()
    config_path = tmp_path / "cover-config.json"
    config_path.write_text('{"cover_letter_generation":true}')
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(config_path))
    monkeypatch.setattr(cover_letter, "get_connection", batch_runtime.connect)
    conn.execute("BEGIN")
    conn.execute("UPDATE jobs SET title='Synthetic changed title' WHERE tenant_id=? AND job_id=?", (str(_TENANT_A), str(_JOB_ID)))
    result = cover_letter.cover_letter_by_id(_JOB_ID, snapshot=_snapshot(_TENANT_A), tenant_id=_TENANT_A)
    assert result["status"] == "already_done"
    assert conn.execute("SELECT state FROM job_stage_states WHERE tenant_id=? AND job_id=? AND stage='cover'", (str(_TENANT_A), str(_JOB_ID))).fetchone()[0] == "succeeded"
