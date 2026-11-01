"""Synthetic local composition, exact file content and accepted binding fences."""

import json
from dataclasses import FrozenInstanceError
from pathlib import Path
from types import SimpleNamespace

import pytest

from jobctrl import config
from jobctrl.apply.launcher import _latest_apply_review_decision, _apply_candidate_select_parts
from jobctrl.domain.materials.services import ResumeAssembler
from jobctrl.domain.materials.use_cases import TailoringLlmPolicy
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.scoring.value_objects import RequirementFitReport
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.materials import SqliteMaterialsRepository, SqliteBulletProvenanceRepository
from jobctrl.infrastructure.materials.artifact_writer import LocalArtifactTextWriter
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobctrl.scoring import tailor
from tests.test_artifact_determinations import JOB_ID, connection, ports
from tests.test_materials_use_cases import ResumeModel, Renderer, request, resume_case, source_profile


class RecordingAssembler(ResumeAssembler):
    def __init__(self):
        self.evaluated = []

    def assemble_resume_text(self, *args, **kwargs):
        text = super().assemble_resume_text(*args, **kwargs) + "\n\n"
        self.evaluated.append(text)
        return text


def test_injected_writer_receives_exact_evaluated_text_without_local_io(tmp_path):
    class MemoryWriter:
        def __init__(self):
            self.files = {}

        def write_text(self, path, text):
            self.files[path] = text
            return len(text.encode("utf-8"))

    writer, assembler = MemoryWriter(), RecordingAssembler()
    destination = tmp_path / "not-created"
    with connection() as conn:
        outcome = resume_case(
            conn, ResumeModel(text="Synthetic résumé café"), writer=writer, assembler=assembler,
        ).execute(**request(destination))
        assert outcome.status == "approved"
        assert len(assembler.evaluated) == 1
        path = Path(outcome.text_path)
        assert writer.files[path] == assembler.evaluated[0]
        assert outcome.materials.tailored_resume.size_bytes == len(writer.files[path].encode("utf-8"))
        assert json.loads(writer.files[path.with_name(path.stem + "_REPORT.json")])["status"] == "approved"
        assert not destination.exists()


@pytest.fixture
def local_path(tmp_path, monkeypatch):
    conn = connection()
    profiles = SqliteProfileRepository(conn, publisher=InProcessEventBus())
    snapshot = profiles.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, source_profile()))
    inputs = request(tmp_path)
    fit = RequirementFitReport(
        job_id=str(JOB_ID), score_version=1, employer_analysis_generation=1,
        profile_snapshot_version=snapshot.version, scoring_policy_version=1,
        formula_version="synthetic", fit_band="plausible", confidence="medium",
    )
    monkeypatch.setattr(tailor, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor, "TAILORED_DIR", tmp_path / "tailored_resumes")
    monkeypatch.setattr(tailor, "_build_voice_port", lambda: None)
    monkeypatch.setattr(config, "get_tailoring_generator_models", lambda: ("codex:synthetic",))
    monkeypatch.setattr(config, "get_tailoring_judge_model", lambda: "codex:quality")

    def build(model, **overrides):
        verifier, judge = ports(conn, model)
        # Canonical interpreter and paid review services use explicit fake model
        # decisions; composition, files, policies, registration and UoW stay real.
        interpreter = resume_case(conn, model)._job_interpreter
        return tailor._build_use_case(
            llm_port=model, claim_verifier=verifier, quality_judge=judge,
            job_interpreter=interpreter, preflight=lambda: None,
            analyze_use_case=SimpleNamespace(execute=lambda **_: SimpleNamespace(analysis=inputs["employer_analysis"])),
            requirement_fit_repository=SimpleNamespace(load=lambda *_: fit, save=lambda *_: None),
            **{"pdf_renderer": Renderer(), **overrides},
        )

    def run(case, *, retailor=False):
        return tailor._tailor_one_job(
            {**inputs["job"], "url": "https://example.test/owned"}, "", snapshot, "normal",
            use_case=case, retailor=retailor,
        )

    yield conn, snapshot, build, run
    conn.close()


def test_local_composition_freezes_config_and_registers_exact_generation(local_path, monkeypatch):
    conn, _snapshot, build, run = local_path
    assembler = RecordingAssembler()
    case = build(ResumeModel(text="Synthetic résumé café"), assembler=assembler)

    def changed_config():
        pytest.fail("configuration was read after composition")

    monkeypatch.setattr(config, "get_tailoring_generator_models", changed_config)
    monkeypatch.setattr(config, "get_tailoring_judge_model", changed_config)
    result = run(case)
    assert result["status"] == "approved"
    path = Path(result["path"])
    assert path.name.endswith("_g1.txt")
    assert len(assembler.evaluated) == 1
    assert path.read_bytes() == assembler.evaluated[0].encode("utf-8")
    report = json.loads(path.with_name(path.stem + "_REPORT.json").read_text())
    assert report["candidate_models"] == ["codex:synthetic"]
    assert report["judge_model"] == "codex:quality"
    assert path.with_name(path.stem + "_JOB.txt").read_text().endswith("Canonical posting")
    current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current.tailored_resume.path == str(path)
    assert current.tailored_resume.size_bytes == len(path.read_bytes())
    assert current.resume_pdf.path == result["pdf_path"]
    assert current.resume_pdf.metadata["source_artifact_id"] == current.tailored_resume.artifact_id
    provenance = SqliteBulletProvenanceRepository(conn).load(LOCAL_TENANT, JOB_ID)
    assert provenance.artifact_id == current.tailored_resume.artifact_id
    assert any(row.generated_text == "Synthetic résumé café" for row in provenance.bullets)
    assert conn.execute("SELECT COUNT(*) FROM artifact_line_anchors").fetchone()[0] > 0
    policy = conn.execute("SELECT generator_settings_json FROM tailoring_policies").fetchone()
    assert json.loads(policy[0])["candidate_models"] == ["codex:synthetic"]


def test_resolved_model_policy_is_immutable_and_detaches_input_list():
    models = ["codex:synthetic"]
    policy = TailoringLlmPolicy(candidate_models=models)
    models.append("codex:changed")
    assert policy.effective_candidate_models == ("codex:synthetic",)
    with pytest.raises(FrozenInstanceError):
        policy.judge_model = "codex:changed"


@pytest.mark.parametrize("failure", ["write", "validation", "fields", "pdf", "provenance"])
def test_failed_local_refresh_preserves_accepted_bytes_provenance_and_approval(local_path, monkeypatch, failure):
    conn, snapshot, build, run = local_path
    accepted = run(build(ResumeModel()))["materials"]
    files = {Path(a.path): Path(a.path).read_bytes() for a in accepted.artifacts}
    provenance_before = tuple(tuple(row) for row in conn.execute("SELECT * FROM job_bullet_provenance"))
    anchors_before = tuple(tuple(row) for row in conn.execute("SELECT * FROM artifact_line_anchors"))
    conn.execute(
        "INSERT INTO application_review_decisions "
        "(tenant_id,decision_id,job_id,decision,decided_at,materials_generation,profile_version,application_url) "
        "VALUES ('local','owned-approval',?,'approve_submit','2026-10-17',?,?,?)",
        (str(JOB_ID), accepted.generation, snapshot.version, "https://example.test/owned"),
    )
    conn.commit()
    approval_before = _latest_apply_review_decision(conn, tenant_id="local", job_id=str(JOB_ID))
    model = ResumeModel(text="Replacement candidate", verdict="fail" if failure == "validation" else "pass")
    if failure == "fields":
        model.mutate = lambda payload: payload["experience_updates"][0].update(id="foreign")
    case = build(model, pdf_renderer=Renderer(fail=failure == "pdf"))
    if failure == "write":
        # Fail the replacement's own path without predicting its attempt ID.
        original_write = LocalArtifactTextWriter.write_text

        def refuse_replacement(self, path, text):
            if path.name.endswith("_g2.txt"):
                raise IsADirectoryError("synthetic replacement-path refusal")
            return original_write(self, path, text)

        monkeypatch.setattr(LocalArtifactTextWriter, "write_text", refuse_replacement)
    if failure == "provenance":
        def fail_provenance(*_):
            raise RuntimeError("synthetic provenance failure")
        monkeypatch.setattr(SqliteBulletProvenanceRepository, "save", fail_provenance)
    if failure == "write":
        with pytest.raises(IsADirectoryError):
            run(case, retailor=True)
    elif failure == "provenance":
        with pytest.raises(RuntimeError, match="synthetic provenance failure"):
            run(case, retailor=True)
    else:
        failed = run(case, retailor=True)
        assert failed["status"] in {"failed_validation", "error"}
        assert not failed["materials"].is_resume_approved
        inspection = Path(failed["path"])
        assert inspection.name.endswith("_g2.txt")
        assert inspection.exists()
        if failure == "fields":
            text = inspection.read_text()
            assert text.startswith("Rejected resume candidate\n")
            payload = json.loads(text.split("\n", 1)[1])
            assert payload["parsed_json"]["experience_updates"][0]["id"] == "foreign"
            assert payload["validator"]["errors"]
    current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current.tailored_resume.artifact_id == accepted.tailored_resume.artifact_id
    assert current.resume_pdf.artifact_id == accepted.resume_pdf.artifact_id
    assert {path: path.read_bytes() for path in files} == files
    assert tuple(tuple(row) for row in conn.execute("SELECT * FROM job_bullet_provenance")) == provenance_before
    assert tuple(tuple(row) for row in conn.execute(
        "SELECT * FROM artifact_line_anchors WHERE generation=?", (accepted.generation,),
    )) == anchors_before
    assert _latest_apply_review_decision(conn, tenant_id="local", job_id=str(JOB_ID)) == approval_before
    columns, joins = _apply_candidate_select_parts()
    binding = conn.execute(f"SELECT {columns} FROM jobs {joins} WHERE jobs.job_id=?", (str(JOB_ID),)).fetchone()
    assert binding["materials_generation"] == approval_before["materials_generation"]
    assert binding["resume_pdf_artifact_id"] == accepted.resume_pdf.artifact_id


@pytest.mark.parametrize("suffix", ["_JOB.txt", "_REPORT.json"])
def test_diagnostic_write_failure_keeps_registered_acceptance(local_path, monkeypatch, suffix):
    conn, _snapshot, build, run = local_path
    write = LocalArtifactTextWriter.write_text

    def fail_sidecar(self, path, text):
        if path.name.endswith(suffix):
            raise OSError("synthetic diagnostic write failure")
        return write(self, path, text)

    monkeypatch.setattr(LocalArtifactTextWriter, "write_text", fail_sidecar)
    result = run(build(ResumeModel()))
    assert result["status"] == "approved"
    current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current.tailored_resume.path == result["path"]
    assert Path(result["path"]).is_file()
    assert SqliteBulletProvenanceRepository(conn).load(LOCAL_TENANT, JOB_ID).artifact_id == current.tailored_resume.artifact_id
