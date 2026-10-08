"""Owned exact-v14 persistence, registered RPC, CLI and actual export boundaries."""

import base64
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.materials.locale_variants import LocaleCommand, NAMESPACE
from jobctrl.infrastructure.materials.locale_variants import LocaleVariants, contained, docx
from jobctrl.infrastructure.rpc.handlers import register_default_handlers
from jobctrl.infrastructure.rpc.server import JsonRpcServer
from jobctrl.domain.rpc.messages import JsonRpcRequest
from tests.test_locale_variants import JOB_ID, Model, setup_case


def review_command(history, **updates):
    return LocaleCommand(
        operation="review",
        jobId=JOB_ID,
        expectedRevision=history["revision"],
        variantId=history["variants"][-1]["variantId"],
        decision="accepted",
        terminology="confirmed",
        formatting="confirmed",
        **updates,
    )


def accept_case(tmp_path):
    owner, command, model, materials, path = setup_case(tmp_path)
    history = owner.generate(command)
    accepted = owner.review(review_command(history))
    return owner, command, model, materials, path, accepted


def test_real_chromium_four_export_claim_parity_reload_and_source_preservation(tmp_path):
    owner, command, _, _, path, history = accept_case(tmp_path)
    assert history["variants"][0]["status"] == "accepted"
    original = path.read_bytes()
    reloaded = LocaleVariants(owner.conn, app_dir=tmp_path).history(JOB_ID)
    assert reloaded == history
    variant = history["variants"][0]
    assert [row["kind"] for row in variant["reviews"]] == ["terminology", "formatting", "acceptance"]
    assert set(variant["exports"]) == {"text", "html", "pdf", "docx"}
    for fmt in variant["exports"]:
        result = owner.export(
            LocaleCommand(operation="export", jobId=JOB_ID, variantId=variant["variantId"], format=fmt)
        )
        assert base64.b64decode(result["data"]) == Path(variant["exports"][fmt]["path"]).read_bytes()
        assert variant["exports"][fmt]["lineIds"] == [row["line_id"] for row in variant["lines"]]
    assert path.read_bytes() == original
    assert owner.generate(command.model_copy(update={"expectedRevision": 2})) == history


@pytest.mark.parametrize("field", ["terminology", "formatting"])
def test_user_reviews_are_independent_and_mandatory(tmp_path, field):
    owner, command, _, _, path = setup_case(tmp_path)
    history = owner.generate(command)
    original = path.read_bytes()
    with pytest.raises(DeterminationFailure, match="independent_reviews_required"):
        owner.review(review_command(history).model_copy(update={field: "rejected"}))
    assert owner.history(JOB_ID) == history and path.read_bytes() == original


def test_failed_semantic_verdict_cannot_be_overridden_by_user(tmp_path):
    owner, command, _, _, _ = setup_case(tmp_path, Model(verdict="fail"))
    history = owner.generate(command)
    with pytest.raises(DeterminationFailure, match="independent_reviews_required"):
        owner.review(review_command(history))
    rejected = owner.review(review_command(history).model_copy(update={"decision": "rejected"}))
    assert rejected["variants"][0]["status"] == "rejected" and rejected["variants"][0]["exports"] == {}
    with pytest.raises(DeterminationFailure, match="terminal"):
        owner.review(review_command(rejected))


@pytest.mark.parametrize("failure", ["renderer", "persistence", "concurrent_review", "source_drift", "profile_drift"])
def test_failed_replacement_preserves_accepted_locale_history_and_bytes(tmp_path, failure):
    owner, command, _, _, path, accepted = accept_case(tmp_path)
    old_manifest = accepted["variants"][0]["exports"]
    old_bytes = {fmt: Path(row["path"]).read_bytes() for fmt, row in old_manifest.items()}
    original = path.read_bytes()
    history = owner.generate(command.model_copy(update={"expectedRevision": 2, "targetLocale": "fr"}))
    saved = owner.history(JOB_ID)
    original_renderer = owner.renderer
    if failure == "renderer":

        def fail(*args):
            raise RuntimeError("owned renderer failure")

        owner.renderer = fail
    if failure == "persistence":
        owner.conn.execute(
            "CREATE TRIGGER fail_locale BEFORE UPDATE ON job_materials BEGIN SELECT RAISE(ABORT, 'owned write failure'); END"
        )
        owner.conn.commit()
    if failure == "source_drift":
        path.write_text("Changed source")
    if failure == "profile_drift":
        owner.conn.execute("UPDATE candidate_profiles SET version=version+1 WHERE tenant_id='local'")
        owner.conn.commit()
    if failure == "concurrent_review":

        def race(markup, destination):
            original_renderer(markup, destination)
            current = owner.history(JOB_ID)
            owner.review(review_command(current).model_copy(update={"decision": "rejected"}))

        owner.renderer = race
    with pytest.raises(Exception):
        owner.review(review_command(history))
    current = owner.history(JOB_ID)
    assert current["variants"][0] == accepted["variants"][0]
    for fmt, data in old_bytes.items():
        assert Path(old_manifest[fmt]["path"]).read_bytes() == data
    if failure != "source_drift":
        assert path.read_bytes() == original
    if failure not in {"concurrent_review"}:
        assert current == saved
    assert len(list((tmp_path / "locale-variants").glob("accepted-*"))) == 1


@pytest.mark.parametrize("failure", ["missing", "tampered"])
def test_export_failure_does_not_change_accepted_state(tmp_path, failure):
    owner, _, _, _, path, accepted = accept_case(tmp_path)
    export = Path(accepted["variants"][0]["exports"]["pdf"]["path"])
    if failure == "missing":
        export.unlink()
    else:
        export.write_bytes(b"tampered")
    original = path.read_bytes()
    with pytest.raises(DeterminationFailure):
        owner.export(
            LocaleCommand(
                operation="export", jobId=JOB_ID, variantId=accepted["variants"][0]["variantId"], format="pdf"
            )
        )
    assert owner.history(JOB_ID) == accepted and path.read_bytes() == original


def test_tampered_document_cannot_borrow_recorded_authority(tmp_path):
    owner, command, _, _, _ = setup_case(tmp_path)
    owner.generate(command)
    metadata = json.loads(owner.conn.execute("SELECT metadata_json FROM job_materials").fetchone()[0])
    metadata[NAMESPACE]["variants"][0]["lines"][0]["text"] = "Fabricated equivalence"
    owner.conn.execute("UPDATE job_materials SET metadata_json=?", (json.dumps(metadata),))
    owner.conn.commit()
    with pytest.raises(DeterminationFailure, match="locale_binding_invalid"):
        owner.history(JOB_ID)


@pytest.mark.parametrize(
    "fault", ["missing_reviews", "foreign_review_hash", "missing_export", "foreign_line_ids", "foreign_generation"]
)
def test_accepted_history_requires_recorded_reviews_and_export_source_joins(tmp_path, fault):
    owner, _, _, _, path, accepted = accept_case(tmp_path)
    original = path.read_bytes()
    retained = {fmt: Path(row["path"]).read_bytes() for fmt, row in accepted["variants"][0]["exports"].items()}
    metadata = json.loads(owner.conn.execute("SELECT metadata_json FROM job_materials").fetchone()[0])
    variant = metadata[NAMESPACE]["variants"][0]
    if fault == "missing_reviews":
        variant["reviews"] = []
    elif fault == "foreign_review_hash":
        variant["reviews"][0]["sourceHash"] = "foreign"
    elif fault == "missing_export":
        del variant["exports"]["docx"]
    elif fault == "foreign_line_ids":
        variant["exports"]["pdf"]["lineIds"] = ["foreign"]
    else:
        owner.conn.execute("UPDATE job_materials SET generation=generation+1")
    owner.conn.execute("UPDATE job_materials SET metadata_json=?", (json.dumps(metadata),))
    owner.conn.commit()
    with pytest.raises(DeterminationFailure, match="locale_(acceptance|binding)_invalid"):
        owner.history(JOB_ID)
    assert path.read_bytes() == original
    for fmt, data in retained.items():
        assert Path(accepted["variants"][0]["exports"][fmt]["path"]).read_bytes() == data


def test_foreign_source_paths_and_symlinks_are_refused(tmp_path):
    external = tmp_path.parent / "outside.txt"
    external.write_text("owned synthetic outside file")
    with pytest.raises(DeterminationFailure):
        contained(tmp_path, external)
    tmp_path.mkdir(exist_ok=True)
    link = tmp_path / "link.txt"
    link.symlink_to(external)
    with pytest.raises(DeterminationFailure):
        contained(tmp_path, link)
    external.unlink()


def test_docx_xml_escapes_without_changing_claims():
    import io
    import zipfile
    from xml.etree import ElementTree

    with zipfile.ZipFile(io.BytesIO(docx(["A & B < C"]))) as archive:
        document = ElementTree.fromstring(archive.read("word/document.xml"))
        assert (
            next(document.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")).text == "A & B < C"
        )


def test_registered_rpc_and_cli_use_same_durable_contract(tmp_path, monkeypatch):
    from jobctrl import config
    from jobctrl.cli import app

    owner, command, model, _, path = setup_case(tmp_path)
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "jobctrl.db")

    async def canceler(*args):
        raise AssertionError("no workflows")

    server = JsonRpcServer()
    register_default_handlers(server, canceler=canceler)

    def deps(connection, **kwargs):
        from jobctrl.infrastructure.determinations import SqliteDeterminationRepository

        return {**owner.dependencies, "repository": SqliteDeterminationRepository(connection)}

    with patch("jobctrl.infrastructure.materials.locale_variants.determination_dependencies", deps):
        response = server.dispatch(
            JsonRpcRequest(
                jsonrpc="2.0",
                method="material_locale_variants",
                params={
                    **command.model_dump(exclude_none=True),
                    "tenantId": "local",
                    "expectedAppDir": str(tmp_path),
                    "expectedDbPath": str(tmp_path / "jobctrl.db"),
                },
                id=1,
            )
        )
        assert response.error is None
        history = response.result
        runner = CliRunner()
        listed = runner.invoke(app, ["locale-variants", JOB_ID])
        assert listed.exit_code == 0, listed.output
        assert json.loads(listed.stdout) == history
        variant_id = history["variants"][0]["variantId"]
        reviewed = runner.invoke(
            app,
            [
                "locale-variants",
                JOB_ID,
                "--operation",
                "review",
                "--expected-revision",
                "1",
                "--variant-id",
                variant_id,
                "--terminology",
                "confirmed",
                "--formatting",
                "confirmed",
                "--decision",
                "accepted",
            ],
        )
        assert reviewed.exit_code == 0, reviewed.output
        output = tmp_path / "owned-download.docx"
        exported = runner.invoke(
            app,
            [
                "locale-variants",
                JOB_ID,
                "--operation",
                "export",
                "--variant-id",
                variant_id,
                "--format",
                "docx",
                "--output",
                str(output),
            ],
        )
        assert exported.exit_code == 0, exported.output
        repeated = runner.invoke(
            app,
            [
                "locale-variants",
                JOB_ID,
                "--operation",
                "export",
                "--variant-id",
                variant_id,
                "--format",
                "docx",
                "--output",
                str(output),
            ],
        )
        assert repeated.exit_code == 1
        assert path.read_text().startswith("Synthetic Person")
        assert len(model.calls) == 4


def test_rpc_rejects_different_workspace_before_model(tmp_path, monkeypatch):
    from jobctrl import config

    owner, command, model, _, _ = setup_case(tmp_path)
    monkeypatch.setattr(config, "APP_DIR", tmp_path)
    monkeypatch.setattr(config, "DB_PATH", tmp_path / "jobctrl.db")
    from jobctrl.infrastructure.rpc.handlers import material_locale_variants

    with pytest.raises(Exception, match="runtime mismatch"):
        material_locale_variants(
            {**command.model_dump(), "expectedAppDir": str(tmp_path), "expectedDbPath": str(tmp_path / "foreign.db")}
        )
    assert model.calls == [] and owner.history(JOB_ID)["variants"] == []


def test_cover_letter_locale_accepts_four_exports_without_replacing_resume(tmp_path):
    from jobctrl.domain.materials import Artifact, ArtifactType, RenderFormat, ValidationResult
    from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository

    owner, command, _, materials, path = setup_case(tmp_path)
    original = path.read_bytes()
    letter = tmp_path / "letter.txt"
    letter.write_text("Synthetic Person\nOwned descriptive letter 42\n")
    artifact = Artifact.create(
        type=ArtifactType.COVER_LETTER, path=str(letter), created_at="2026-10-08", render_format=RenderFormat.TEXT
    )
    materials = materials.with_cover_letter(artifact, validation=ValidationResult.success(), updated_at="2026-10-08")
    SqliteMaterialsRepository(owner.conn).save(materials)
    owner.conn.commit()
    history = owner.generate(command.model_copy(update={"artifactId": artifact.artifact_id}))
    assert history["variants"][0]["binding"]["kind"] == "cover_letter"
    accepted = owner.review(review_command(history))
    assert set(accepted["variants"][0]["exports"]) == {"text", "html", "pdf", "docx"}
    assert path.read_bytes() == original
    assert letter.read_text() == "Synthetic Person\nOwned descriptive letter 42\n"


def test_accepted_locale_remains_downloadable_after_source_superseded(tmp_path):
    owner, _, _, _, _, accepted = accept_case(tmp_path)
    owner.conn.execute(
        "UPDATE job_materials_artifacts SET status='superseded',superseded_at='2026-10-09' WHERE tenant_id='local'"
    )
    owner.conn.commit()
    result = owner.export(
        LocaleCommand(operation="export", jobId=JOB_ID, variantId=accepted["variants"][0]["variantId"], format="text")
    )
    assert result["hash"] == accepted["variants"][0]["exports"]["text"]["hash"]
    assert owner.history(JOB_ID)["variants"] == accepted["variants"]


def test_actual_pdf_with_changed_claim_fails_before_acceptance(tmp_path):
    owner, command, _, _, path = setup_case(tmp_path)
    history = owner.generate(command)
    original = path.read_bytes()
    render = owner.renderer
    owner.renderer = lambda markup, output: render(markup.replace("42", "43"), output)
    with pytest.raises(DeterminationFailure, match="export_parity_invalid"):
        owner.review(review_command(history))
    assert owner.history(JOB_ID) == history and path.read_bytes() == original
    assert list((tmp_path / "locale-variants").iterdir()) == []


def test_new_materials_generation_keeps_old_locale_records_once(tmp_path):
    from jobctrl.domain.materials import (
        Artifact,
        ArtifactType,
        MaterialsSetFactory,
        RenderFormat,
        JudgeVerdict,
        ValidationResult,
    )
    from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository

    owner, command, _, materials, _, accepted = accept_case(tmp_path)
    old, fresh = MaterialsSetFactory.next_generation(materials, created_at="2026-10-09")
    path = tmp_path / "new-source.txt"
    path.write_text("Synthetic Person\nOwned new description 42\n")
    artifact = Artifact.create(
        type=ArtifactType.TAILORED_RESUME, path=str(path), created_at="2026-10-09", render_format=RenderFormat.TEXT
    )
    fresh = fresh.with_resume_attempt(
        artifact, validation=ValidationResult.success(), verdict=JudgeVerdict.passed(), updated_at="2026-10-09"
    )
    repository = SqliteMaterialsRepository(owner.conn)
    repository.save(old)
    repository.save(fresh)
    owner.conn.commit()
    history = owner.history(JOB_ID)
    assert history["revision"] == 2 and history["variants"] == accepted["variants"]
    result = owner.generate(command.model_copy(update={"artifactId": artifact.artifact_id, "expectedRevision": 2}))
    assert result["revision"] == 3 and len(result["variants"]) == 2
    assert result["variants"][0] == accepted["variants"][0]
    assert result["variants"][1]["binding"]["generation"] == 2
