"""Real schema-14 persistence and product owners, using only the structural model port."""
import json
import sqlite3
import zipfile
from pathlib import Path
from unittest.mock import patch
from xml.etree import ElementTree

import pytest
from typer.testing import CliRunner

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.infrastructure.materials import locale_variants as locale
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from tests.test_locale_variants import LocaleModel, dependencies

JOB = "90000000-0000-4000-8000-000000000039"
TEXT = "Synthetic Name\nHistorical Title · Synthetic Employer · 2020\nDelivered 25%\nCredential Original"


@pytest.fixture
def owned(tmp_path):
    connection = sqlite3.connect(tmp_path / "owned.db")
    connection.row_factory = sqlite3.Row
    create_exact_v14_schema(connection)
    connection.execute("INSERT INTO jobs(tenant_id,job_id,url,title,company) VALUES('local',?,'https://example.test/owned','Owned job','Synthetic Employer')", (JOB,))
    connection.execute("INSERT INTO candidate_profiles(tenant_id,profile_id,version,personal_full_name,updated_at) VALUES('local','default',1,'Synthetic Name','2026-10-09')")
    connection.execute("INSERT INTO candidate_profile_experience_entries(tenant_id,profile_id,entry_id,position_index,title,company,date_range) VALUES('local','default','entry',0,'Historical Title','Synthetic Employer','2020')")
    connection.execute("INSERT INTO candidate_profile_experience_bullets VALUES('local','default','entry',0,'Delivered 25%')")
    connection.execute("INSERT INTO candidate_profile_education_entries(tenant_id,profile_id,entry_id,position_index,degree) VALUES('local','default','education',0,'Credential Original')")
    connection.execute("INSERT INTO job_materials(tenant_id,job_id,generation,status,created_at,updated_at) VALUES('local',?,1,'approved','2026-10-09','2026-10-09')", (JOB,))
    source = tmp_path / "accepted.txt"
    source.write_text(TEXT)
    for kind in ("tailored_resume", "cover_letter"):
        connection.execute("INSERT INTO job_materials_artifacts(tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at) VALUES('local',?,1,?,?,'approved',?,'text','2026-10-09')", (JOB, kind, kind, str(source)))
    connection.commit()
    yield connection, tmp_path, source
    connection.close()


def run(owned, request, model=None, **kwargs):
    connection, root, _ = owned
    return locale.operation(connection, tenant_id="local", job_id=JOB, root=root, request=request, dependencies=dependencies(connection, model or LocaleModel()), **kwargs)


def generate(owned, model=None, kind="tailored_resume", target="es"):
    return run(owned, dict(operation="generate", sourceArtifactId=kind, sourceLocale="en", targetLocale=target, expectedGeneration=1, expectedProfileVersion=1), model)["variants"][-1]


def review(owned, snapshot, dimension="terminology", decision="accepted"):
    return run(owned, dict(operation="review", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"], dimension=dimension, decision=decision, note="Owned review"))["variants"][-1]


def accept(owned, snapshot):
    return run(owned, dict(operation="accept", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"]))["variants"][-1]


def accepted(owned):
    snapshot = generate(owned)
    snapshot = review(owned, snapshot)
    snapshot = review(owned, snapshot, "formatting")
    return accept(owned, snapshot)


@pytest.mark.parametrize("kind", ["tailored_resume", "cover_letter"])
def test_source_line_snapshot_and_independent_acceptance(owned, kind):
    snapshot = generate(owned, kind=kind)
    assert snapshot["source"]["kind"] == kind
    assert snapshot["text"] == TEXT
    assert snapshot["translationId"] and snapshot["verificationId"]
    with pytest.raises(DeterminationFailure, match="independent_reviews_required"):
        accept(owned, snapshot)
    snapshot = review(owned, snapshot)
    with pytest.raises(DeterminationFailure, match="independent_reviews_required"):
        accept(owned, snapshot)
    snapshot = review(owned, snapshot, "formatting", "rejected")
    with pytest.raises(DeterminationFailure, match="independent_reviews_required"):
        accept(owned, snapshot)
    snapshot = review(owned, snapshot, "formatting")
    snapshot = accept(owned, snapshot)
    assert snapshot["accepted"] and snapshot["acceptanceHistory"][0]["decision"] == "accepted"
    assert owned[2].read_text() == TEXT


@pytest.mark.parametrize("format", ["txt", "html", "docx"])
def test_exports_one_accepted_snapshot(owned, format):
    snapshot = accepted(owned)
    result = run(owned, dict(operation="export", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"], format=format))
    ref = result["variants"][-1]["exports"][-1]
    row = owned[0].execute("SELECT path FROM job_artifacts WHERE artifact_id=?", (ref["artifactId"],)).fetchone()
    path = Path(row[0])
    assert ref["textSha256"] == snapshot["textSha256"] and locale.digest(path.read_bytes()) == ref["sha256"]
    if format == "txt":
        assert path.read_text() == TEXT
    elif format == "html":
        assert 'lang="es"' in path.read_text() and "Credential Original" in path.read_text()
    else:
        with zipfile.ZipFile(path) as archive:
            root = ElementTree.fromstring(archive.read("word/document.xml"))
            assert [node.text for node in root.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")] == TEXT.splitlines()


@pytest.mark.parametrize("change", ["source", "profile", "status", "generation"])
def test_source_drift_preserves_prior_acceptance(owned, change):
    snapshot = accepted(owned)
    previous = locale.history(owned[0], tenant_id="local", job_id=JOB)
    if change == "source":
        owned[2].write_text("Changed source")
    elif change == "profile":
        owned[0].execute("UPDATE candidate_profiles SET version=2")
    elif change == "status":
        owned[0].execute("UPDATE job_materials_artifacts SET status='superseded'")
    else:
        owned[0].execute("UPDATE job_materials_artifacts SET generation=2")
    owned[0].commit()
    with pytest.raises(DeterminationFailure):
        run(owned, dict(operation="export", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"], format="txt"))
    assert locale.history(owned[0], tenant_id="local", job_id=JOB)["variants"] == previous["variants"]


def test_revision_fence_and_failed_model_preserve_accepted_history(owned):
    snapshot = accepted(owned)
    prior = locale.history(owned[0], tenant_id="local", job_id=JOB)
    with pytest.raises(DeterminationFailure, match="stale_locale_revision"):
        run(owned, dict(operation="reject", revisionId=snapshot["revisionId"], expectedVersion=1))
    with pytest.raises(DeterminationFailure, match="malformed_json"):
        generate(owned, LocaleModel(fault=json.JSONDecodeError("owned", "", 0)), target="fr")
    assert locale.history(owned[0], tenant_id="local", job_id=JOB) == prior
    assert owned[2].read_text() == TEXT


@pytest.mark.parametrize("kind", ["missing_term", "ambiguous_credential"])
def test_explicit_findings_block_acceptance_without_equivalence(owned, kind):
    finding = {"kind": kind, "line_id": "source:3", "source": {"source_id": "source:3", "quote": "Credential Original", "exact_values": []}, "detail": "Explicit unresolved credential or term"}
    snapshot = generate(owned, LocaleModel(verdict="fail", findings=[finding]))
    assert snapshot["findings"][0]["kind"] == kind
    snapshot = review(owned, snapshot)
    snapshot = review(owned, snapshot, "formatting")
    with pytest.raises(DeterminationFailure, match="locale_verification_failed"):
        accept(owned, snapshot)
    assert owned[2].read_text() == TEXT


def test_cached_generation_reuses_revision_and_provider_calls(owned):
    model = LocaleModel()
    first = generate(owned, model)
    assert generate(owned, model) == first
    assert len(model.calls) == 2


def test_source_changes_during_model_call_are_fenced(owned):
    model = LocaleModel(on_call=lambda: owned[2].write_text("Concurrent change"))
    with pytest.raises(DeterminationFailure, match="stale_locale_source"):
        generate(owned, model)
    assert locale.history(owned[0], tenant_id="local", job_id=JOB)["variants"] == []


@pytest.mark.parametrize("format", ["txt", "html", "pdf", "docx"])
def test_failed_export_retains_prior_bytes_and_histories(owned, format):
    snapshot = accepted(owned)
    result = run(owned, dict(operation="export", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"], format="txt"))
    snapshot = result["variants"][-1]
    paths = [Path(row[0]) for row in owned[0].execute("SELECT path FROM job_artifacts")]
    before = {str(path): path.read_bytes() for path in paths}
    def fail(*args):
        raise OSError("owned failure")
    with patch.object(locale, "write_exclusive", side_effect=fail), pytest.raises(DeterminationFailure if format == "pdf" else OSError):
        run(owned, dict(operation="export", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"], format=format), pdf_renderer=fail)
    assert locale.history(owned[0], tenant_id="local", job_id=JOB) == result
    assert all(Path(path).read_bytes() == value for path, value in before.items())


def test_failed_persistence_retains_source_and_accepted_revision(owned):
    accepted(owned)
    prior = locale.history(owned[0], tenant_id="local", job_id=JOB)
    with patch.object(locale, "save_revision", side_effect=sqlite3.OperationalError("owned failure")), pytest.raises(sqlite3.OperationalError):
        generate(owned, target="fr")
    assert locale.history(owned[0], tenant_id="local", job_id=JOB) == prior
    assert owned[2].read_text() == TEXT


def test_authority_removal_blocks_acceptance(owned):
    snapshot = generate(owned)
    snapshot = review(owned, snapshot)
    snapshot = review(owned, snapshot, "formatting")
    owned[0].execute("DELETE FROM semantic_entity_bindings")
    owned[0].commit()
    with pytest.raises(DeterminationFailure, match="locale_authority_invalid"):
        accept(owned, snapshot)


def test_registered_rpc_and_cli_share_native_owner(owned):
    from jobctrl.infrastructure.rpc.handlers import material_locale_variants
    from jobctrl.cli import app
    from jobctrl import config, database
    params = {"tenantId": "local", "jobId": JOB, "expectedAppDir": str(owned[1]), "expectedDbPath": str(owned[1] / "owned.db"),
              "request": dict(operation="generate", sourceArtifactId="tailored_resume", sourceLocale="en", targetLocale="es", expectedGeneration=1, expectedProfileVersion=1)}
    deps = dependencies(owned[0], LocaleModel())
    with patch("jobctrl.infrastructure.rpc.handlers.assert_expected_runtime"), patch.object(database, "init_db", return_value=owned[0]), patch.object(locale, "determination_dependencies", return_value=deps), patch.object(locale, "operation", wraps=locale.operation) as owner:
        # Keep the fixture connection alive; the handler correctly closes its own connection in production.
        conn = sqlite3.connect(owned[1] / "owned.db")
        conn.row_factory = sqlite3.Row
        with patch.object(database, "init_db", return_value=conn):
            params["request"] = {"operation": "history"}
            assert material_locale_variants(params)["sources"]
        assert owner.call_count == 1
    with patch.object(config, "APP_DIR", owned[1]), patch.object(database, "init_db", side_effect=lambda: sqlite3.connect(owned[1] / "owned.db")):
        result = CliRunner().invoke(app, ["material-locale", JOB])
        assert result.exit_code == 0, result.output
        assert json.loads(result.stdout)["profileVersion"] == 1


def test_unsupported_pair_is_durable_and_never_becomes_authority(owned):
    prior = accepted(owned)
    model = LocaleModel()
    snapshot = generate(owned, model, target="xx")
    assert snapshot["findings"][0]["kind"] == "unsupported_language"
    assert snapshot["translationId"] is None and model.calls == []
    assert locale.history(owned[0], tenant_id="local", job_id=JOB)["variants"][0] == prior
    assert owned[2].read_text() == TEXT


def test_rejected_acceptance_is_terminal(owned):
    snapshot = generate(owned)
    snapshot = review(owned, snapshot)
    snapshot = review(owned, snapshot, "formatting")
    snapshot = run(owned, dict(operation="reject", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"]))["variants"][-1]
    with pytest.raises(DeterminationFailure, match="rejected_locale_revision"):
        accept(owned, snapshot)


def test_corrupt_staged_text_export_does_not_publish(owned):
    snapshot = accepted(owned)
    with patch.object(locale, "write_exclusive", side_effect=lambda path, data: path.write_bytes(b"Corrupt output")), pytest.raises(DeterminationFailure, match="export_validation_failed"):
        run(owned, dict(operation="export", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"], format="txt"))
    assert locale.history(owned[0], tenant_id="local", job_id=JOB)["variants"][-1] == snapshot


def test_review_persistence_failure_preserves_accepted_content_and_history(owned):
    prior = accepted(owned)
    snapshot = generate(owned, target="fr")
    before = locale.history(owned[0], tenant_id="local", job_id=JOB)
    with patch.object(locale, "update", side_effect=sqlite3.OperationalError("Owned write failure")), pytest.raises(sqlite3.OperationalError):
        review(owned, snapshot)
    assert locale.history(owned[0], tenant_id="local", job_id=JOB) == before
    assert before["variants"][0] == prior


def test_real_pdf_renderer_preserves_unicode_and_protected_values(owned):
    owned[2].write_text(TEXT + "\nDescripción sintética · català · 25%")
    snapshot = accepted(owned)
    result = run(owned, dict(operation="export", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"], format="pdf"))
    ref = result["variants"][-1]["exports"][-1]
    from pypdf import PdfReader
    path = Path(owned[0].execute("SELECT path FROM job_artifacts WHERE artifact_id=?", (ref["artifactId"],)).fetchone()[0])
    extracted = "\n".join(page.extract_text() for page in PdfReader(path).pages)
    assert "Descripción sintética" in extracted and "Credential Original" in extracted


def test_native_registered_rpc_generation_review_acceptance_and_exports(owned):
    from jobctrl import config, database
    from jobctrl.domain.rpc.messages import JsonRpcRequest
    from tests.rpc_contract_probe import build_server
    model = LocaleModel()
    with patch.object(config, "APP_DIR", owned[1]), patch.object(config, "DB_PATH", owned[1] / "owned.db"), patch.object(database, "DB_PATH", owned[1] / "owned.db"), patch.object(locale, "determination_dependencies", side_effect=lambda connection, **kwargs: dependencies(connection, model)):
        server = build_server()
        def dispatch(request):
            response = server.dispatch(JsonRpcRequest.from_dict({"jsonrpc": "2.0", "id": 1, "method": "material_locale_variants", "params": {
                "tenantId": "local", "jobId": JOB, "expectedAppDir": str(owned[1]), "expectedDbPath": str(owned[1] / "owned.db"), "request": request,
            }}))
            assert response.error is None, response.error
            return response.result
        snapshot = dispatch(dict(operation="generate", sourceArtifactId="tailored_resume", sourceLocale="en", targetLocale="es", expectedGeneration=1, expectedProfileVersion=1))["variants"][-1]
        for dimension in ("terminology", "formatting"):
            snapshot = dispatch(dict(operation="review", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"], dimension=dimension, decision="accepted", note="Native RPC review"))["variants"][-1]
        snapshot = dispatch(dict(operation="accept", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"]))["variants"][-1]
        for format in ("txt", "html", "docx"):
            snapshot = dispatch(dict(operation="export", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"], format=format))["variants"][-1]
        assert snapshot["accepted"] and len(snapshot["exports"]) == 3 and len(model.calls) == 2
        assert owned[2].read_text() == TEXT


def test_cli_generates_reviews_accepts_and_exports_through_native_storage(owned):
    from jobctrl import config, database
    from jobctrl.cli import app
    model = LocaleModel()
    runner = CliRunner()
    with patch.object(config, "APP_DIR", owned[1]), patch.object(database, "DB_PATH", owned[1] / "owned.db"), patch.object(locale, "determination_dependencies", side_effect=lambda connection, **kwargs: dependencies(connection, model)):
        def invoke(arguments):
            result = runner.invoke(app, ["material-locale", JOB, *arguments])
            assert result.exit_code == 0, result.output
            return json.loads(result.stdout)["variants"][-1]
        snapshot = invoke(["--operation", "generate", "--source-artifact-id", "cover_letter"])
        for dimension in ("terminology", "formatting"):
            snapshot = invoke(["--operation", "review", "--revision-id", snapshot["revisionId"], "--expected-version", str(snapshot["version"]), "--dimension", dimension])
        snapshot = invoke(["--operation", "accept", "--revision-id", snapshot["revisionId"], "--expected-version", str(snapshot["version"])])
        snapshot = invoke(["--operation", "export", "--revision-id", snapshot["revisionId"], "--expected-version", str(snapshot["version"]), "--format", "docx"])
        assert snapshot["accepted"] and snapshot["exports"][-1]["format"] == "docx"
        assert len(model.calls) == 2 and owned[2].read_text() == TEXT


def test_foreign_runtime_is_rejected_before_model_or_registry_write(owned):
    from jobctrl import config
    from jobctrl.infrastructure.rpc.handlers import material_locale_variants
    from jobctrl.infrastructure.runtime_identity import RuntimeIdentityMismatch
    model = LocaleModel()
    with patch.object(config, "APP_DIR", owned[1]), patch.object(config, "DB_PATH", owned[1] / "owned.db"), patch.object(locale, "determination_dependencies", side_effect=lambda connection, **kwargs: dependencies(connection, model)):
        with pytest.raises(RuntimeIdentityMismatch):
            material_locale_variants({"tenantId": "local", "jobId": JOB, "expectedAppDir": str(owned[1]), "expectedDbPath": str(owned[1] / "foreign.db"), "request": {"operation": "history"}})
    assert model.calls == [] and locale.history(owned[0], tenant_id="local", job_id=JOB)["variants"] == []


def test_two_concurrent_requests_reuse_determinations_and_one_revision(owned):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier
    barrier = Barrier(2)
    model = LocaleModel()
    request = dict(operation="generate", sourceArtifactId="tailored_resume", sourceLocale="en", targetLocale="es", expectedGeneration=1, expectedProfileVersion=1)
    def worker():
        connection = sqlite3.connect(owned[1] / "owned.db", timeout=10)
        connection.row_factory = sqlite3.Row
        barrier.wait()
        try:
            return locale.operation(connection, tenant_id="local", job_id=JOB, root=owned[1], request=request, dependencies=dependencies(connection, model))
        finally:
            connection.close()
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: worker(), range(2)))
    assert results[0]["variants"] == results[1]["variants"]
    assert len(model.calls) == 2 and len(results[0]["variants"]) == 1


def test_altered_locale_binding_cannot_transplant_semantic_authority(owned):
    snapshot = generate(owned)
    snapshot = review(owned, snapshot)
    snapshot = review(owned, snapshot, "formatting")
    row = owned[0].execute("SELECT artifact_id,metadata_json FROM job_artifacts WHERE artifact_type='locale_revision'").fetchone()
    value = json.loads(row[1])
    value["targetLocale"] = "fr"
    owned[0].execute("UPDATE job_artifacts SET metadata_json=? WHERE artifact_id=?", (json.dumps(value), row[0]))
    owned[0].commit()
    with pytest.raises(DeterminationFailure, match="locale_authority_invalid"):
        accept(owned, snapshot)
    assert owned[2].read_text() == TEXT


def test_missing_authority_is_visible_without_erasing_accepted_snapshot(owned):
    snapshot = accepted(owned)
    owned[0].execute("DELETE FROM semantic_entity_bindings")
    owned[0].commit()
    view = locale.history(owned[0], tenant_id="local", job_id=JOB)["variants"][-1]
    assert view["accepted"] and view["text"] == snapshot["text"] and view["authorityStatus"] == "unavailable"
    with pytest.raises(DeterminationFailure, match="locale_authority_invalid"):
        run(owned, dict(operation="export", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"], format="txt"))


def test_application_password_is_never_in_prompt_or_locale_snapshot(owned):
    sentinel = "Synthetic credential excluded from material sources"
    owned[0].execute("UPDATE candidate_profiles SET personal_password=?", (sentinel,))
    owned[0].commit()
    model = LocaleModel()
    snapshot = generate(owned, model)
    assert sentinel not in json.dumps(model.calls)
    assert sentinel not in json.dumps(snapshot)


def test_malformed_recorded_authority_keeps_accepted_history_inspectable(owned):
    snapshot = accepted(owned)
    owned[0].execute("UPDATE semantic_determinations SET envelope_json='{}' WHERE kind='material_locale_translation'")
    owned[0].commit()
    view = locale.history(owned[0], tenant_id="local", job_id=JOB)["variants"][-1]
    assert view == {**snapshot, "authorityStatus": "unavailable"}
    with pytest.raises(DeterminationFailure, match="schema_violation"):
        run(owned, dict(operation="export", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"], format="txt"))
    assert owned[2].read_text() == TEXT


def test_ambiguous_source_id_is_rejected_before_model(owned):
    owned[0].execute("UPDATE job_materials_artifacts SET artifact_id='tailored_resume'")
    owned[0].commit()
    model = LocaleModel()
    with pytest.raises(DeterminationFailure, match="accepted_source_unavailable"):
        generate(owned, model)
    assert model.calls == [] and owned[2].read_text() == TEXT


def test_new_model_binding_cannot_overwrite_prior_accepted_authority(owned):
    prior = accepted(owned)
    deps = dependencies(owned[0], LocaleModel())
    deps["provider"] = "another-synthetic-provider"
    result = locale.operation(owned[0], tenant_id="local", job_id=JOB, root=owned[1], request=dict(operation="generate", sourceArtifactId="tailored_resume", sourceLocale="en", targetLocale="es", expectedGeneration=1, expectedProfileVersion=1), dependencies=deps)
    assert len(result["variants"]) == 2 and all(row["authorityStatus"] == "recorded" for row in result["variants"])
    exported = run(owned, dict(operation="export", revisionId=prior["revisionId"], expectedVersion=prior["version"], format="txt"))
    assert exported["variants"][0]["exports"][-1]["textSha256"] == prior["textSha256"]


def test_regeneration_after_rejection_retains_history_without_spending_again(owned):
    model = LocaleModel()
    first = generate(owned, model)
    rejected = run(owned, dict(operation="reject", revisionId=first["revisionId"], expectedVersion=first["version"]))["variants"][-1]
    second = generate(owned, model)
    assert second["revisionId"] != rejected["revisionId"] and second["translationId"] == rejected["translationId"]
    assert locale.history(owned[0], tenant_id="local", job_id=JOB)["variants"][0] == rejected
    assert len(model.calls) == 2


def test_symlink_source_is_rejected_before_spending(owned):
    linked = owned[1] / "linked.txt"
    linked.symlink_to(owned[2])
    owned[0].execute("UPDATE job_materials_artifacts SET path=? WHERE artifact_type='tailored_resume'", (str(linked),))
    owned[0].commit()
    model = LocaleModel()
    with pytest.raises(DeterminationFailure, match="artifact_path_outside_workspace"):
        generate(owned, model)
    assert model.calls == [] and owned[2].read_text() == TEXT


@pytest.mark.parametrize("field", ["revisionId", "textSha256"])
def test_foreign_review_binding_cannot_authorize_acceptance(owned, field):
    snapshot = review(owned, review(owned, generate(owned)), "formatting")
    row_id, stored = locale.current_revision(owned[0], "local", JOB, snapshot["revisionId"])
    stored["reviews"][-1][field] = "foreign"
    owned[0].execute("UPDATE job_artifacts SET metadata_json=? WHERE artifact_id=?", (json.dumps(stored), row_id))
    owned[0].commit()
    with pytest.raises(DeterminationFailure, match="independent_reviews_required"):
        accept(owned, snapshot)
    assert owned[2].read_text() == TEXT


def test_accepted_flag_without_recorded_acceptance_cannot_export(owned):
    snapshot = accepted(owned)
    row_id, stored = locale.current_revision(owned[0], "local", JOB, snapshot["revisionId"])
    stored["acceptanceHistory"] = []
    owned[0].execute("UPDATE job_artifacts SET metadata_json=? WHERE artifact_id=?", (json.dumps(stored), row_id))
    owned[0].commit()
    with pytest.raises(DeterminationFailure, match="accepted_locale_required"):
        run(owned, dict(operation="export", revisionId=snapshot["revisionId"], expectedVersion=snapshot["version"], format="txt"))
    assert not list((owned[1] / "generated" / "locale-variants").glob("*.docx"))
    assert owned[2].read_text() == TEXT


def native_model_rpc_server():
    """Owned API integration subprocess: replace only the locale model dependency port."""
    import os
    from jobctrl.infrastructure.rpc.handlers import register_default_handlers
    from jobctrl.infrastructure.rpc.server import JsonRpcServer
    root = Path(os.environ["JOBCTRL_DIR"]).resolve(strict=True)
    if not (root / ".locale-variants-test").is_file():
        raise RuntimeError("Locale RPC double requires an owned synthetic workspace marker")
    model = LocaleModel()
    locale.determination_dependencies = lambda connection, **kwargs: dependencies(connection, model)
    server = JsonRpcServer()
    register_default_handlers(server, canceler=lambda *_args, **_kwargs: None)
    server.serve()


if __name__ == "__main__":
    native_model_rpc_server()
