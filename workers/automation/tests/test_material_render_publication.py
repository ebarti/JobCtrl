"""Owned SQLite and activity tests for concurrent synthetic PDF renders."""
from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl import database
from jobctrl.domain.identifiers import JobId
from jobctrl.domain.materials import Artifact, ArtifactType, RenderFormat
from jobctrl.materials.activities import RenderPdfActivityInput, render_pdf_activity

from .test_apply_regressions import (  # noqa: F401
    _email_facts, _insert_ready_job, _seed_current_apply_binding, launcher_module, owned_email_path,
)


def test_late_pdf_activity_preserves_first_accepted_render(tmp_path, monkeypatch):
    """A stale same-job activity must not replace the first accepted PDF."""
    from jobctrl.infrastructure import materials, profile
    from jobctrl.infrastructure.temporal import run_in_activity

    db_path = tmp_path / "jobs.db"
    conn = database.init_db(db_path)
    job_id = _insert_ready_job(conn)
    _seed_current_apply_binding(conn)
    conn.execute("UPDATE job_materials SET status='resume_approved' WHERE job_id=?", (job_id,))
    source = tmp_path / "cover.txt"
    source.write_text("Synthetic cover letter", encoding="utf-8")
    conn.execute(
        "INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) "
        "VALUES ('local',?,1,'cover_letter','cover-1','approved',?,'text','2026-01-01')", (job_id, str(source)),
    )
    conn.commit()
    original_get_connection = database.get_connection
    monkeypatch.setattr(database, "get_connection", lambda: original_get_connection(db_path))
    monkeypatch.setattr(profile, "get_profile_repository", lambda: SimpleNamespace(
        load_snapshot=lambda _tenant: SimpleNamespace(as_dict=lambda: {}),
    ))
    first_started, second_saved, release_first = (threading.Event() for _ in range(3))
    outcomes, errors, output_paths = {}, [], {}

    class Renderer:
        def render_cover_letter_to_pdf(self, *, output_path, created_at, **_kwargs):
            label = threading.current_thread().name
            output_paths[label] = Path(output_path)
            if label == "first":
                first_started.set()
                assert release_first.wait(5)
            Path(output_path).write_bytes(f"synthetic-{label}".encode())
            return Artifact.create(type=ArtifactType.COVER_LETTER_PDF, path=output_path,
                                   created_at=created_at, render_format=RenderFormat.HTML_PDF)

    async def run_blocking(thunk, **_kwargs):
        return thunk()

    monkeypatch.setattr(materials, "PlaywrightHtmlPdfAdapter", Renderer)
    monkeypatch.setattr(run_in_activity, "run_blocking_with_heartbeat", run_blocking)

    def run(label):
        try:
            outcomes[label] = asyncio.run(render_pdf_activity(RenderPdfActivityInput(tenant_id="local", job_id=JobId(job_id))))
        except BaseException as exc:
            errors.append(exc)
        finally:
            if label == "second":
                second_saved.set()
            database.close_connection(db_path)

    first = threading.Thread(target=run, args=("first",), name="first")
    second = threading.Thread(target=run, args=("second",), name="second")
    first.start()
    try:
        assert first_started.wait(5)
        second.start()
        assert second_saved.wait(5)
        assert errors == []
        with sqlite3.connect(db_path) as observer:
            accepted = observer.execute("SELECT artifact_id,path FROM job_materials_artifacts WHERE artifact_type='cover_letter_pdf'").fetchone()
        assert accepted is not None
        accepted_id, accepted_path = accepted
        assert Path(accepted_path).read_bytes() == b"synthetic-second"
        release_first.set()
        first.join(timeout=5)
        assert not first.is_alive()
        with sqlite3.connect(db_path) as observer:
            final = observer.execute("SELECT artifact_id,path FROM job_materials_artifacts WHERE artifact_type='cover_letter_pdf'").fetchone()
        assert final == (accepted_id, accepted_path)
        assert Path(accepted_path).read_bytes() == b"synthetic-second"
        assert errors == []
        assert output_paths["first"] != output_paths["second"]
        assert not output_paths["first"].exists()
        assert outcomes["first"].status == "error"
        assert outcomes["first"].error == "pdf_source_changed"
        assert outcomes["second"].status == "ok"
    finally:
        release_first.set()
        first.join(timeout=5)
        if second.ident is not None:
            second.join(timeout=5)
        database.close_connection(db_path)


@pytest.mark.parametrize("change", ["unchanged", "source_path", "source_bytes", "generation", "render_failure", "ambiguous_commit"])
def test_pdf_activity_revalidates_and_cleans_only_its_attempt(owned_email_path, monkeypatch, change):  # noqa: F811
    from jobctrl.infrastructure import materials, profile
    from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
    from jobctrl.infrastructure.temporal import run_in_activity

    state = owned_email_path
    source = state.db_path.parent / "cover.txt"
    source.write_text("Synthetic approved cover", encoding="utf-8")
    state.conn.execute("UPDATE job_materials SET status='resume_approved' WHERE job_id=?", (state.job_id,))
    state.conn.execute(
        "INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) "
        "VALUES ('local',?,1,'cover_letter','cover-1','approved',?,'text','2026-01-01')", (state.job_id, str(source)),
    )
    state.conn.commit()
    original_get_connection = database.get_connection
    monkeypatch.setattr(database, "get_connection", lambda: original_get_connection(state.db_path))
    monkeypatch.setattr(profile, "get_profile_repository", lambda: SimpleNamespace(
        load_snapshot=lambda _tenant: SimpleNamespace(as_dict=lambda: {}),
    ))
    attempted = []

    class Renderer:
        def render_cover_letter_to_pdf(self, *, output_path, created_at, **_kwargs):
            attempted.append(Path(output_path))
            Path(output_path).write_bytes(b"synthetic-render")
            if change == "render_failure":
                raise RuntimeError("synthetic render interrupted")
            if change == "source_bytes":
                source.write_text("New synthetic cover", encoding="utf-8")
            elif change == "source_path":
                replacement = source.with_name("new-cover.txt")
                replacement.write_text("New synthetic cover", encoding="utf-8")
                with sqlite3.connect(state.db_path) as writer:
                    writer.execute("UPDATE job_materials_artifacts SET path=? WHERE artifact_id='cover-1'", (str(replacement),))
            elif change == "generation":
                with sqlite3.connect(state.db_path) as writer:
                    writer.execute("INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at) "
                                   "SELECT tenant_id,job_id,2,status,created_at,updated_at FROM job_materials WHERE generation=1")
                    writer.execute("INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) "
                                   "SELECT tenant_id,job_id,2,artifact_type,artifact_id,status,path,render_format,created_at "
                                   "FROM job_materials_artifacts WHERE generation=1")
            return Artifact.create(type=ArtifactType.COVER_LETTER_PDF, path=output_path,
                                   created_at=created_at, render_format=RenderFormat.HTML_PDF)

    async def run_blocking(thunk, **_kwargs):
        return thunk()

    monkeypatch.setattr(materials, "PlaywrightHtmlPdfAdapter", Renderer)
    monkeypatch.setattr(run_in_activity, "run_blocking_with_heartbeat", run_blocking)
    if change == "ambiguous_commit":
        original_publish = SqliteMaterialsRepository.publish_rendered_pdf

        def lose_ack(repository, *args, **kwargs):
            assert original_publish(repository, *args, **kwargs) is not None
            raise RuntimeError("synthetic lost commit acknowledgement")

        monkeypatch.setattr(SqliteMaterialsRepository, "publish_rendered_pdf", lose_ack)
    output = asyncio.run(render_pdf_activity(RenderPdfActivityInput(tenant_id="local", job_id=JobId(state.job_id))))
    pdf = state.conn.execute("SELECT artifact_id,path FROM job_materials_artifacts WHERE artifact_type='cover_letter_pdf'").fetchone()
    assert len(attempted) == 1
    if change == "unchanged":
        assert output.status == "ok" and output.rendered == ("cover_letter_pdf",)
        assert pdf is not None and Path(pdf["path"]).read_bytes() == b"synthetic-render"
    elif change == "ambiguous_commit":
        assert output.status == "error" and output.error == "pdf_render_failed"
        assert pdf is not None and Path(pdf["path"]).read_bytes() == b"synthetic-render"
    else:
        assert output.status == "error"
        assert output.error == ("pdf_render_failed" if change == "render_failure" else "pdf_source_changed")
        assert pdf is None and not attempted[0].exists()
        if change == "source_bytes":
            assert source.read_text() == "New synthetic cover"
        if change == "source_path":
            assert state.conn.execute("SELECT path FROM job_materials_artifacts WHERE artifact_id='cover-1'").fetchone()[0] == str(source.with_name("new-cover.txt"))
        if change == "generation":
            assert state.conn.execute("SELECT MAX(generation) FROM job_materials WHERE job_id=?", (state.job_id,)).fetchone()[0] == 2


def test_pdf_publication_waits_for_email_intent_and_keeps_approved_files(owned_email_path, monkeypatch):  # noqa: F811
    from jobctrl.domain.materials.cover_letter_settings import RENDERER_VERSION, validate_settings
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure import materials, profile
    from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
    from jobctrl.infrastructure.temporal import run_in_activity

    state = owned_email_path
    text_path = state.db_path.parent / "cover.txt"
    text_path.write_text("Synthetic reviewed cover", encoding="utf-8")
    text_hash = hashlib.sha256(text_path.read_bytes()).hexdigest()
    settings = validate_settings(None)
    state.conn.execute("UPDATE job_materials SET status='resume_approved' WHERE job_id=?", (state.job_id,))
    state.conn.execute(
        "INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) "
        "VALUES ('local',?,1,'cover_letter','cover-1','approved',?,'text','2026-01-01')", (state.job_id, str(text_path)),
    )
    state.conn.commit()
    monkeypatch.setattr(launcher_module.config, "APP_DIR", state.db_path.parent)
    original_get_connection = database.get_connection
    monkeypatch.setattr(database, "get_connection", lambda: original_get_connection(state.db_path))
    monkeypatch.setattr(profile, "get_profile_repository", lambda: SimpleNamespace(
        load_snapshot=lambda _tenant: SimpleNamespace(as_dict=lambda: {}),
    ))
    slow_ready, release_slow, slow_written, publication_started, slow_done = (threading.Event() for _ in range(5))
    paths, outcomes, errors = {}, {}, []

    class Renderer:
        def render_cover_letter_to_pdf(self, *, output_path, created_at, **_kwargs):
            label = threading.current_thread().name
            paths[label] = Path(output_path)
            if label == "slow":
                slow_ready.set()
                assert release_slow.wait(5)
            data = f"%PDF-1.4\nsynthetic-{label}\n%%EOF".encode()
            Path(output_path).write_bytes(data)
            if label == "slow":
                slow_written.set()
            return Artifact.create(
                type=ArtifactType.COVER_LETTER_PDF, path=output_path, created_at=created_at, render_format=RenderFormat.HTML_PDF,
                metadata={"cover_letter_pdf_sha256": hashlib.sha256(data).hexdigest(), "cover_letter_text_sha256": text_hash,
                          "cover_letter_settings": settings, "cover_letter_renderer_version": RENDERER_VERSION},
            )

    async def run_blocking(thunk, **_kwargs):
        return thunk()

    monkeypatch.setattr(materials, "PlaywrightHtmlPdfAdapter", Renderer)
    monkeypatch.setattr(run_in_activity, "run_blocking_with_heartbeat", run_blocking)
    original_publish = SqliteMaterialsRepository.publish_rendered_pdf

    def track_publication(repository, *args, **kwargs):
        if threading.current_thread().name == "slow":
            publication_started.set()
        return original_publish(repository, *args, **kwargs)

    monkeypatch.setattr(SqliteMaterialsRepository, "publish_rendered_pdf", track_publication)

    def slow_render():
        try:
            outcomes["slow"] = asyncio.run(render_pdf_activity(RenderPdfActivityInput(tenant_id="local", job_id=JobId(state.job_id))))
        except BaseException as exc:
            errors.append(exc)
        finally:
            database.close_connection(state.db_path)
            slow_done.set()

    slow = threading.Thread(target=slow_render, name="slow")
    slow.start()
    try:
        assert slow_ready.wait(5)
        fast = asyncio.run(render_pdf_activity(RenderPdfActivityInput(tenant_id="local", job_id=JobId(state.job_id))))
        assert fast.status == "ok"
        pdf = state.conn.execute("SELECT artifact_id,path,metadata_json FROM job_materials_artifacts WHERE artifact_type='cover_letter_pdf'").fetchone()
        pdf_bytes = Path(pdf["path"]).read_bytes()
        pdf_hash = hashlib.sha256(pdf_bytes).hexdigest()
        source = {"tenantId": "local", "jobId": state.job_id, "artifactId": "cover-1", "generation": 1, "textSha256": text_hash}
        recorded = state.conn.execute("SELECT event_id,payload_json FROM job_events WHERE event_type='ApplyReviewDecisionRecorded'").fetchone()
        payload = json.loads(recorded["payload_json"])
        payload["coverLetterBinding"] = {"source": source, "pdfArtifactId": pdf["artifact_id"], "pdfSha256": pdf_hash,
                                         "settings": settings, "rendererVersion": RENDERER_VERSION}
        columns, joins = launcher_module._apply_candidate_select_parts()
        row = dict(state.conn.execute(f"SELECT {columns} FROM jobs {joins} WHERE jobs.job_id=?", (state.job_id,)).fetchone())
        binding = launcher_module._email_source_binding(state.conn, LOCAL_TENANT, state.job_id, row)
        payload["emailApprovalBinding"] = {
            "version": 1, "candidateSha256": launcher_module._email_candidate_digest(state.payload),
            "materialsSha256": launcher_module._email_materials_digest(binding),
            "postingUrlSha256": launcher_module._email_binding_digest([binding["posting_url"]]),
            "postingInputsSha256": launcher_module._email_posting_inputs_digest(binding),
        }
        state.conn.execute("UPDATE job_events SET payload_json=? WHERE event_id=?", (json.dumps(payload), recorded["event_id"]))
        state.conn.commit()
        original_hash = launcher_module._email_file_sha256

        def finish_render_during_intent(path):
            digest = original_hash(path)
            pending = state.conn.execute("SELECT count(*) FROM job_events WHERE event_type='ApplySubmitIntended'").fetchone()[0]
            if pending and str(path).endswith("resume.txt") and not release_slow.is_set():
                release_slow.set()
                assert slow_written.wait(5)
                assert publication_started.wait(5)
                assert not slow_done.is_set()
                with sqlite3.connect(state.db_path, timeout=0) as competing_writer:
                    with pytest.raises(sqlite3.OperationalError, match="locked"):
                        competing_writer.execute("UPDATE job_materials SET generation=generation WHERE job_id=?", (state.job_id,))
            return digest

        monkeypatch.setattr(launcher_module, "_email_file_sha256", finish_render_during_intent)
        assert state.execute().kind == "applied"
        assert slow_done.wait(5)
        assert errors == []
        assert outcomes["slow"].status == "error" and outcomes["slow"].error == "pdf_source_changed"
        assert paths["slow"] != Path(pdf["path"]) and not paths["slow"].exists()
        assert Path(pdf["path"]).read_bytes() == pdf_bytes
        assert state.conn.execute("SELECT artifact_id FROM job_materials_artifacts WHERE artifact_type='cover_letter_pdf'").fetchone()[0] == pdf["artifact_id"]
        assert _email_facts(state)["ApplySubmitIntended"] == state.sender_calls == 1
    finally:
        release_slow.set()
        slow.join(timeout=6)
        assert not slow.is_alive()


def test_new_pdf_activity_before_intent_invalidates_the_old_email_approval(owned_email_path, monkeypatch):  # noqa: F811
    from jobctrl.infrastructure import materials, profile
    from jobctrl.infrastructure.temporal import run_in_activity

    state = owned_email_path
    state.conn.execute("UPDATE job_materials SET status='resume_approved' WHERE job_id=?", (state.job_id,))
    state.conn.commit()
    original_get_connection = database.get_connection
    monkeypatch.setattr(database, "get_connection", lambda: original_get_connection(state.db_path))
    monkeypatch.setattr(profile, "get_profile_repository", lambda: SimpleNamespace(
        load_snapshot=lambda _tenant: SimpleNamespace(as_dict=lambda: {}),
    ))

    class Renderer:
        def render_cover_letter_to_pdf(self, *, output_path, created_at, **_kwargs):
            Path(output_path).write_bytes(b"%PDF-1.4\nsynthetic\n%%EOF")
            return Artifact.create(type=ArtifactType.COVER_LETTER_PDF, path=output_path,
                                   created_at=created_at, render_format=RenderFormat.HTML_PDF)

    async def run_blocking(thunk, **_kwargs):
        return thunk()

    monkeypatch.setattr(materials, "PlaywrightHtmlPdfAdapter", Renderer)
    monkeypatch.setattr(run_in_activity, "run_blocking_with_heartbeat", run_blocking)

    def late_material():
        source = state.db_path.parent / "new-cover.txt"
        source.write_text("New synthetic cover", encoding="utf-8")
        with sqlite3.connect(state.db_path) as writer:
            writer.execute(
                "INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) "
                "VALUES ('local',?,1,'cover_letter','new-cover','approved',?,'text','2026-01-01')", (state.job_id, str(source)),
            )
        result = asyncio.run(render_pdf_activity(RenderPdfActivityInput(tenant_id="local", job_id=JobId(state.job_id))))
        assert result.status == "ok"

    state.late = late_material
    result = state.execute()
    assert result.kind == "failed" and result.error == "approval_stale_materials"
    assert _email_facts(state)["ApplySubmitIntended"] == state.sender_calls == 0
    assert state.conn.execute("SELECT count(*) FROM job_materials_artifacts WHERE artifact_type='cover_letter_pdf' AND status='approved'").fetchone()[0] == 1


def test_cover_generation_and_pdf_activity_preserve_the_first_published_pdf(tmp_path, monkeypatch):
    from jobctrl import config
    from jobctrl.infrastructure import materials, profile
    from jobctrl.infrastructure.temporal import run_in_activity
    from jobctrl.scoring import cover_letter
    from .test_v7_cover_runtime import (
        _CoverLlm, _JOB_ID, _TENANT_A, _seed_approved_resume, _seed_eligible_score, _seed_target, _snapshot,
    )

    db_path = tmp_path / "jobs.db"
    conn = database.init_db(db_path)
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_A)
    config_path = tmp_path / "config.json"
    config_path.write_text('{"cover_letter_generation":true}')
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(config_path))
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setattr("jobctrl.llm.enforce_spend_budget", lambda **_kwargs: None)
    monkeypatch.setattr(cover_letter, "COVER_LETTER_DIR", tmp_path / "covers")
    original_get_connection = database.get_connection
    monkeypatch.setattr(database, "get_connection", lambda: original_get_connection(db_path))
    monkeypatch.setattr(cover_letter, "get_connection", lambda: original_get_connection(db_path))
    snapshot = _snapshot(_TENANT_A)
    monkeypatch.setattr(profile, "get_profile_repository", lambda: SimpleNamespace(load_snapshot=lambda _tenant: snapshot))
    ready, release = threading.Event(), threading.Event()
    paths, result, errors = {}, {}, []

    class Renderer:
        def __init__(self, label):
            self.label = label

        def render_cover_letter_to_pdf(self, *, output_path, created_at, **_kwargs):
            paths[self.label] = Path(output_path)
            if self.label == "generator":
                ready.set()
                assert release.wait(5)
            Path(output_path).write_bytes(f"synthetic-{self.label}".encode())
            return Artifact.create(type=ArtifactType.COVER_LETTER_PDF, path=output_path,
                                   created_at=created_at, render_format=RenderFormat.HTML_PDF)

    async def run_blocking(thunk, **_kwargs):
        return thunk()

    monkeypatch.setattr(materials, "PlaywrightHtmlPdfAdapter", lambda: Renderer("activity"))
    monkeypatch.setattr(run_in_activity, "run_blocking_with_heartbeat", run_blocking)

    def generate():
        try:
            result["generation"] = cover_letter.cover_letter_by_id(
                _JOB_ID, tenant_id=_TENANT_A, snapshot=snapshot, llm_port=_CoverLlm(), pdf_renderer=Renderer("generator"),
            )
        except BaseException as exc:
            errors.append(exc)
        finally:
            database.close_connection(db_path)

    worker = threading.Thread(target=generate)
    worker.start()
    try:
        assert ready.wait(5), errors
        activity = asyncio.run(render_pdf_activity(RenderPdfActivityInput(tenant_id=str(_TENANT_A), job_id=_JOB_ID)))
        assert activity.status == "ok"
        accepted = conn.execute("SELECT artifact_id,path FROM job_materials_artifacts WHERE artifact_type='cover_letter_pdf'").fetchone()
        assert Path(accepted["path"]).read_bytes() == b"synthetic-activity"
        release.set()
        worker.join(timeout=5)
        assert not worker.is_alive() and errors == []
        assert result["generation"]["status"] == "ok"
        final = conn.execute("SELECT artifact_id,path FROM job_materials_artifacts WHERE artifact_type='cover_letter_pdf'").fetchone()
        assert tuple(final) == tuple(accepted)
        assert Path(final["path"]).read_bytes() == b"synthetic-activity"
        assert paths["generator"] != paths["activity"] and not paths["generator"].exists()
    finally:
        release.set()
        worker.join(timeout=5)
        database.close_connection(db_path)


@pytest.mark.parametrize("change", ["new_cover", "resume_bytes"])
def test_cover_generation_preserves_newer_materials_and_ownership(tmp_path, monkeypatch, change):
    from jobctrl import config
    from jobctrl.scoring import cover_letter
    from .test_v7_cover_runtime import (
        _CoverLlm, _JOB_ID, _PdfRenderer, _TENANT_A, _seed_approved_resume, _seed_eligible_score, _seed_stage_rows, _seed_target, _snapshot,
    )

    db_path = tmp_path / "jobs.db"
    conn = database.init_db(db_path)
    _seed_target(conn, tenant_id=_TENANT_A)
    _seed_eligible_score(conn, tenant_id=_TENANT_A)
    _seed_approved_resume(conn, tmp_path, tenant_id=_TENANT_A)
    _seed_stage_rows(conn, tenant_id=_TENANT_A)
    config_path = tmp_path / "config.json"
    config_path.write_text('{"cover_letter_generation":true}')
    monkeypatch.setenv("JOBCTRL_CONFIG_PATH", str(config_path))
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", db_path)
    monkeypatch.setattr(database, "DB_PATH", db_path)
    monkeypatch.setattr("jobctrl.llm.enforce_spend_budget", lambda **_kwargs: None)
    monkeypatch.setattr(cover_letter, "COVER_LETTER_DIR", tmp_path / "covers")
    original_get_connection = database.get_connection
    monkeypatch.setattr(database, "get_connection", lambda: original_get_connection(db_path))
    monkeypatch.setattr(cover_letter, "get_connection", lambda: original_get_connection(db_path))
    snapshot = _snapshot(_TENANT_A)
    ready, release = threading.Event(), threading.Event()
    results, errors = {}, []

    class SlowModel(_CoverLlm):
        def chat_json(self, messages, *, response_schema, **kwargs):
            if response_schema["title"] == "GeneratedProseDraft":
                ready.set()
                assert release.wait(5)
            return super().chat_json(messages, response_schema=response_schema, **kwargs)

    def generate(label, llm):
        try:
            results[label] = cover_letter.cover_letter_by_id(
                _JOB_ID, tenant_id=_TENANT_A, snapshot=snapshot, llm_port=llm, pdf_renderer=_PdfRenderer(),
            )
        except BaseException as exc:
            errors.append(exc)
        finally:
            if label == "slow":
                database.close_connection(db_path)

    slow = threading.Thread(target=generate, args=("slow", SlowModel()))
    slow.start()
    try:
        assert ready.wait(5), errors
        if change == "new_cover":
            generate("fast", _CoverLlm())
            assert not errors and results["fast"]["status"] == "ok", (errors, results)
        else:
            resume = conn.execute("SELECT path FROM job_materials_artifacts WHERE artifact_type='tailored_resume'").fetchone()[0]
            Path(resume).write_text("Synthetic edited resume", encoding="utf-8")
        rows = conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type").fetchall()
        accepted = [tuple(row) for row in rows]
        files = {Path(row["path"]): Path(row["path"]).read_bytes() for row in rows if Path(row["path"]).exists()}
        release.set()
        slow.join(timeout=5)
        assert not slow.is_alive() and not errors
        assert [tuple(row) for row in conn.execute("SELECT artifact_type,artifact_id,path FROM job_materials_artifacts WHERE status='approved' ORDER BY artifact_type")] == accepted
        assert {path: path.read_bytes() for path in files} == files
        assert results["slow"]["reason"] == "materials_changed_during_cover"
        stage = conn.execute("SELECT state,attempt_count FROM job_stage_states WHERE stage='cover'").fetchone()
        assert tuple(stage) == (("succeeded", 1) if change == "new_cover" else ("stale", 0))
    finally:
        release.set()
        slow.join(timeout=5)
        database.close_connection(db_path)


def test_stale_settlement_never_claims_a_successor_with_the_same_start_time(owned_email_path):  # noqa: F811
    from jobctrl.scoring.material_lifecycle import settle_stale_material_attempt
    from jobctrl.state import record_job_event, set_stage_state

    state = owned_email_path
    set_stage_state(state.conn, state.job_id, "cover", "running", started_at="same-time", attempt_count=2,
                    validate_transition=False)
    for token in ("older", "successor"):
        record_job_event(state.conn, state.job_id, "cover", "StageStarted", payload={"materialAttemptId": token})
    state.conn.commit()
    kwargs = dict(tenant_id="local", job_id=state.job_id, stage="cover", started_at="same-time",
                  prior_attempts=2, workflow_id=None, reason="materials_changed_during_cover")
    assert not settle_stale_material_attempt(state.conn, attempt_id="older", **kwargs)
    assert tuple(state.conn.execute("SELECT state,attempt_count FROM job_stage_states WHERE stage='cover'").fetchone()) == ("running", 2)
    assert settle_stale_material_attempt(state.conn, attempt_id="successor", **kwargs)
    assert not settle_stale_material_attempt(state.conn, attempt_id="successor", **kwargs)
    assert tuple(state.conn.execute("SELECT state,attempt_count FROM job_stage_states WHERE stage='cover'").fetchone()) == ("stale", 2)
    assert state.conn.execute("SELECT count(*) FROM job_events WHERE event_type='StageStale'").fetchone()[0] == 1


def test_resume_pdf_render_preserves_universal_newline_matching(owned_email_path, monkeypatch):  # noqa: F811
    from jobctrl.domain.materials import use_cases
    from jobctrl.domain.tenant import LOCAL_TENANT
    from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository

    state = owned_email_path
    source_path = state.db_path.parent / "resume.txt"
    source_path.write_bytes(b"Synthetic\r\nresume\r\n")
    state.conn.execute("UPDATE job_materials SET status='resume_approved' WHERE job_id=?", (state.job_id,))
    state.conn.execute("DELETE FROM job_materials_artifacts WHERE artifact_type='resume_pdf'")
    state.conn.commit()

    class Assembler:
        def assemble_resume_text(self, *_args):
            return "Synthetic\nresume\n"

    class Renderer:
        def render_resume_to_pdf(self, *, output_path, created_at, **_kwargs):
            Path(output_path).write_bytes(b"synthetic-pdf")
            return Artifact.create(type=ArtifactType.RESUME_PDF, path=output_path,
                                   created_at=created_at, render_format=RenderFormat.HTML_PDF)

    monkeypatch.setattr(use_cases, "ResumeAssembler", Assembler)
    outcome = use_cases.RenderPdfUseCase(
        repository=SqliteMaterialsRepository(state.conn), resume_renderer=Renderer(), cover_letter_renderer=Renderer(),
    ).execute(job_id=JobId(state.job_id), tenant_id=LOCAL_TENANT, tailored_payload={}, profile_dict={})
    assert outcome.status == "ok" and outcome.rendered == (ArtifactType.RESUME_PDF,)
    assert Path(outcome.materials.resume_pdf.path).read_bytes() == b"synthetic-pdf"
