"""Base copies use real profile/material stores and no model dependencies."""

from copy import deepcopy
from pathlib import Path

import pytest

from jobctrl import config
from jobctrl.domain.materials.use_cases import MaterialsChangedDuringGeneration
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import LOCAL_TENANT, TenantId
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.materials import SqliteBulletProvenanceRepository, SqliteMaterialsRepository
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from jobctrl.scoring import tailor
from tests.test_artifact_determinations import JOB_ID, connection
from tests.test_materials_use_cases import Renderer, source_profile
from tests.test_v7_tailor_runtime import _seed_job
from jobctrl.domain.identifiers import canonical_job_id
from jobctrl.domain.materials.baseline import baseline_provenance


@pytest.fixture
def baseline_runtime(tmp_path, monkeypatch):
    conn = connection()
    profile = source_profile()
    resume = profile["resume"]
    resume["experience_entries"][0]["bullets"] = [f"Authored achievement {i}." for i in range(6)]
    resume["tailoring_rules"]["max_experience_bullets"] = 1
    resume["education_entries"] = [
        {"id": "required-school", "institution": "Synthetic University", "degree": "Degree One"},
        {"id": "optional-school", "institution": "Other University", "degree": "Degree Two"},
    ]
    resume["tailoring_rules"]["required_education_entry_ids"] = ["required-school"]
    profiles = SqliteProfileRepository(conn, publisher=InProcessEventBus())
    snapshot = profiles.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, profile))
    monkeypatch.setattr(tailor, "get_connection", lambda: conn)
    monkeypatch.setattr(tailor, "TAILORED_DIR", tmp_path / "materials")
    monkeypatch.setattr(config, "get_resume_tailoring_enabled", lambda: False)
    monkeypatch.setattr(tailor, "_build_use_case", lambda **_: pytest.fail("baseline acquired model services"))
    monkeypatch.setattr(tailor, "get_llm_adapter", lambda **_: pytest.fail("baseline acquired an LLM"))
    monkeypatch.setattr(tailor, "_build_voice_port", lambda **_: pytest.fail("baseline acquired voice"))
    renderer = Renderer()
    monkeypatch.setattr(tailor, "_build_pdf_renderer", lambda: renderer)

    def run(*, retailor=False, pdf_renderer=None):
        return tailor._tailor_one_job(
            {"job_id": str(JOB_ID), "url": "https://example.test/baseline", "title": "Synthetic role"},
            "",
            profiles.load_snapshot(LOCAL_TENANT),
            "normal",
            retailor=retailor,
            pdf_renderer=pdf_renderer,
        )

    yield conn, profiles, snapshot, run
    conn.close()


@pytest.mark.parametrize("saved,enabled", [(None, True), (True, True), (False, False), (0, True), ("false", True)])
def test_only_saved_boolean_false_disables_tailoring(monkeypatch, saved, enabled):
    monkeypatch.setattr(config, "_config_setting", lambda _key: saved)
    assert config.get_resume_tailoring_enabled() is enabled


def test_direct_source_ids_preserve_opaque_entry_ids_and_contact_precedence():
    profile = source_profile()
    profile["resume"]["experience_entries"][0]["id"] = "opaque#role:id"
    profile["personal"].update(website_url="https://example.test/site", portfolio_url="https://example.test/unused")
    rows = {row.bullet_id: row for row in baseline_provenance(profile)}
    assert rows["experience:opaque#role:id:title"].evidence_ids == ("experience:opaque#role:id:title",)
    assert rows["experience:opaque#role:id#0"].evidence_ids == ("experience:opaque#role:id:source:0",)
    assert "personal:website_url" in rows["personal:contact"].evidence_ids
    assert "personal:portfolio_url" not in rows["personal:contact"].evidence_ids


def test_base_copy_preserves_full_authored_resume_and_records_real_origin(baseline_runtime):
    conn, profiles, snapshot, run = baseline_runtime
    before = snapshot.as_dict()
    result = run()
    assert result["status"] == "approved"
    text = Path(result["path"]).read_text()
    for index in range(6):
        assert f"Authored achievement {index}." in text
    assert "Degree One" in text and "Degree Two" in text
    assert profiles.load_snapshot(LOCAL_TENANT).as_dict() == before
    materials = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
    origin = materials.tailored_resume.metadata["base_profile_copy"]
    assert origin["profile_version"] == snapshot.version
    assert origin["profile_id"] == snapshot.profile_id
    assert not origin["modified"]
    assert materials.resume_pdf.metadata["base_profile_copy"] == origin
    assert materials.resume_pdf.metadata["source_artifact_id"] == materials.tailored_resume.artifact_id
    assert materials.last_verdict is None
    assert conn.execute("SELECT COUNT(*) FROM semantic_determinations").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM tailoring_policies").fetchone()[0] == 0
    provenance = SqliteBulletProvenanceRepository(conn).load(LOCAL_TENANT, JOB_ID)
    assert provenance.artifact_id == materials.tailored_resume.artifact_id
    assert (
        len([row for row in provenance.bullets if row.bullet_id.startswith("experience:") and "#" in row.bullet_id])
        == 6
    )
    assert all(
        row.transform_type.value == "verbatim" and row.control.value == "base_profile_copy"
        for row in provenance.bullets
    )
    assert all(not row.requirement_ids and not row.matched_keywords for row in provenance.bullets)
    assert provenance.coverage is None and provenance.voice is None


def test_two_jobs_receive_independent_copies(baseline_runtime):
    conn, profiles, _snapshot, run = baseline_runtime
    first = run()["materials"]
    other_id = canonical_job_id("90000000-0000-4000-8000-000000000057")
    _seed_job(conn, tenant_id=LOCAL_TENANT, job_id=other_id, url="https://example.test/other-copy")
    second = tailor.tailor_job_by_id(other_id, snapshot=profiles.load_snapshot(LOCAL_TENANT))["materials"]
    assert first.tailored_resume.artifact_id != second.tailored_resume.artifact_id
    assert first.tailored_resume.path != second.tailored_resume.path
    assert first.resume_pdf.path != second.resume_pdf.path
    assert Path(first.tailored_resume.path).read_bytes() == Path(second.tailored_resume.path).read_bytes()
    assert SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID) == first


def test_foreign_profile_snapshot_is_refused_before_rendering(baseline_runtime):
    conn, _profiles, snapshot, _run = baseline_runtime
    from dataclasses import replace

    foreign = replace(snapshot, tenant_id=TenantId("other-tenant"))
    with pytest.raises(ValueError, match="baseline_profile_tenant_mismatch"):
        tailor._tailor_one_job(
            {"job_id": str(JOB_ID), "url": "https://example.test/owned", "title": "Owned"}, "", foreign, "normal"
        )
    assert SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID) is None


def test_repeat_retains_independent_accepted_copy_after_profile_change(baseline_runtime):
    conn, profiles, snapshot, run = baseline_runtime
    first = run()
    accepted = first["materials"]
    before = {a.path: Path(a.path).read_bytes() for a in accepted.artifacts}
    profile = deepcopy(snapshot.as_dict())
    profile["resume"]["experience_entries"][0]["bullets"][0] = "Later profile change."
    profiles.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, profile))
    second = run()
    assert second["status"] == "already_done"
    assert second["materials"].generation == accepted.generation
    assert {a.path: Path(a.path).read_bytes() for a in accepted.artifacts} == before
    assert SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID) == accepted


@pytest.mark.parametrize("failure", ["render", "profile", "source", "provenance"])
def test_failed_refresh_preserves_accepted_files_rows_and_sources(baseline_runtime, monkeypatch, failure):
    conn, profiles, snapshot, run = baseline_runtime
    accepted = run()["materials"]
    before = {a.path: Path(a.path).read_bytes() for a in accepted.artifacts}
    rows_before = tuple(tuple(row) for row in conn.execute("SELECT * FROM job_bullet_provenance"))

    class FailingRenderer(Renderer):
        def render_resume_to_pdf(self, **kwargs):
            if failure == "render":
                raise OSError("synthetic render failure")
            artifact = super().render_resume_to_pdf(**kwargs)
            if failure == "profile":
                profile = snapshot.as_dict()
                profile["resume"]["experience_entries"][0]["bullets"][0] = "Changed during rendering."
                profiles.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, profile))
            if failure == "source":
                Path(kwargs["output_path"]).with_suffix(".txt").write_text("Unrelated bytes")
            return artifact

    if failure == "provenance":
        monkeypatch.setattr(
            SqliteBulletProvenanceRepository,
            "save",
            lambda *_: (_ for _ in ()).throw(RuntimeError("synthetic write failure")),
        )
    with pytest.raises((OSError, RuntimeError, MaterialsChangedDuringGeneration)):
        run(retailor=True, pdf_renderer=FailingRenderer())
    assert SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID) == accepted
    assert {a.path: Path(a.path).read_bytes() for a in accepted.artifacts} == before
    assert tuple(tuple(row) for row in conn.execute("SELECT * FROM job_bullet_provenance")) == rows_before


def test_stale_overlapping_preparation_cannot_replace_the_winner(baseline_runtime):
    conn, _profiles, _snapshot, run = baseline_runtime
    winner = []

    class OverlappingRenderer(Renderer):
        def render_resume_to_pdf(self, **kwargs):
            winner.append(run()["materials"])
            return super().render_resume_to_pdf(**kwargs)

    with pytest.raises(MaterialsChangedDuringGeneration):
        run(pdf_renderer=OverlappingRenderer())
    assert SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID) == winner[0]
    assert all(Path(a.path).exists() for a in winner[0].artifacts)


@pytest.mark.parametrize("fit_score,expected", [(8, "approved"), (5, "skipped")])
def test_normal_job_entry_keeps_score_eligibility_and_prepares_baseline(baseline_runtime, fit_score, expected):
    conn, profiles, _snapshot, _run = baseline_runtime
    job_id = canonical_job_id("90000000-0000-4000-8000-000000000056")
    _seed_job(
        conn, tenant_id=LOCAL_TENANT, job_id=job_id, url="https://example.test/newly-ingested", fit_score=fit_score
    )
    before = tuple(conn.execute("SELECT * FROM job_scores WHERE job_id=?", (str(job_id),)).fetchone())
    result = tailor.tailor_job_by_id(job_id, snapshot=profiles.load_snapshot(LOCAL_TENANT))
    assert result["status"] == expected
    assert tuple(conn.execute("SELECT * FROM job_scores WHERE job_id=?", (str(job_id),)).fetchone()) == before
    if expected == "approved":
        assert result["materials"].tailored_resume.metadata["preparation_mode"] == "baseline_copy"
        assert (
            conn.execute(
                "SELECT state FROM job_stage_states WHERE job_id=? AND stage='tailor'", (str(job_id),)
            ).fetchone()[0]
            == "succeeded"
        )
