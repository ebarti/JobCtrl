"""An owned material retry must not let its predecessor replace accepted bytes."""

from __future__ import annotations

import asyncio
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

from jobctrl.domain.profile.snapshot import ProfileSnapshot
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.materials.artifact_writer import LocalArtifactTextWriter
from jobctrl.scoring import tailor
from jobctrl.state import reset_job_stage

from .test_artifact_determinations import JOB, JOB_ID
from .test_materials_use_cases import Renderer, ResumeModel, request, resume_case, source_profile
from .test_v7_tailor_runtime import _seed_job, batch_runtime  # noqa: F401


@pytest.mark.asyncio
@pytest.mark.parametrize("finish_first", ["old", "new"])
async def test_direct_retry_preserves_successor_accepted_file(batch_runtime, monkeypatch, tmp_path, finish_first):  # noqa: F811
    conn = batch_runtime.connect()
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=JOB_ID, url="https://example.test/retry-owner")
    conn.execute("UPDATE job_enrichments SET full_description=? WHERE tenant_id='local' AND job_id=?",
                 (JOB["full_description"], str(JOB_ID)))
    conn.commit()
    snapshot = ProfileSnapshot(LOCAL_TENANT, "default", 1, source_profile())
    analysis = request(tmp_path)["employer_analysis"]
    monkeypatch.setattr("jobctrl.infrastructure.profile.get_profile_repository",
                        lambda: SimpleNamespace(load_snapshot=lambda _: snapshot))
    monkeypatch.setattr(tailor, "_load_requirement_fit_report_for_job", lambda **_: None)
    ready = {key: threading.Event() for key in ("old", "new")}
    release = {key: threading.Event() for key in ("old", "new")}
    sequence = []
    lock = threading.Lock()

    def build(**_kwargs):
        with lock:
            owner = "old" if not sequence else "new"
            sequence.append(owner)

        class HeldWriter(LocalArtifactTextWriter):
            def write_text(self, path, text):
                if path.name.endswith("_g1.txt"):
                    ready[owner].set()
                    if not release[owner].wait(15):
                        raise RuntimeError("synthetic material writer was not released")
                return super().write_text(path, text)

        case = resume_case(batch_runtime.connect(), ResumeModel(text=f"Synthetic {owner}"),
                           renderer=Renderer(), writer=HeldWriter())
        case._analyze_use_case = SimpleNamespace(execute=lambda **_: SimpleNamespace(analysis=analysis))
        return case

    monkeypatch.setattr(tailor, "_build_use_case", build)

    async def start():
        return await asyncio.to_thread(tailor.tailor_job_by_id, JOB_ID, snapshot=snapshot, tenant_id=LOCAL_TENANT)

    old = asyncio.create_task(start())
    new = None
    try:
        assert await asyncio.to_thread(ready["old"].wait, 12)
        reset_job_stage(conn, "https://example.test/retry-owner", "tailor", tenant_id=LOCAL_TENANT)
        new = asyncio.create_task(start())
        assert await asyncio.to_thread(ready["new"].wait, 12)
        if finish_first == "old":
            release["old"].set()
            stale = await asyncio.wait_for(old, 15)
            assert stale["status"] == "skipped" and stale["reason"] == "materials_changed_during_tailoring"
            assert not new.done()
        release["new"].set()
        result = await asyncio.wait_for(new, 15)
        assert result["status"] == "approved"
        row = conn.execute(
            "SELECT artifact_id,path FROM job_materials_artifacts WHERE tenant_id='local' AND job_id=? "
            "AND artifact_type='tailored_resume' AND status='approved'", (str(JOB_ID),),
        ).fetchone()
        assert row is not None
        accepted_path = Path(row["path"])
        accepted = accepted_path.read_bytes()
        assert b"Synthetic new" in accepted
        release["old"].set()
        stale = await asyncio.wait_for(old, 15)
        assert stale["status"] == "skipped" and stale["reason"] == "materials_changed_during_tailoring"
        assert tuple(conn.execute(
            "SELECT artifact_id,path FROM job_materials_artifacts WHERE tenant_id='local' AND job_id=? "
            "AND artifact_type='tailored_resume' AND status='approved'", (str(JOB_ID),),
        ).fetchone()) == tuple(row)
        assert accepted_path.read_bytes() == accepted
    finally:
        for event in release.values():
            event.set()
        await asyncio.gather(*(task for task in (old, new) if task is not None), return_exceptions=True)
