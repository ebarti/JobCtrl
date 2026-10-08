"""Real exact-schema persistence and product dispatch in owned synthetic workspaces."""

from __future__ import annotations

import io
import json
import sqlite3
import uuid
import zipfile
from dataclasses import replace
from xml.etree import ElementTree as ET

import pytest
from typer.testing import CliRunner

from jobctrl.domain.determinations import DeterminationFailure, Source
from jobctrl.domain.materials.aggregate import MaterialsSetFactory
from jobctrl.domain.materials.claim_verification import ModelClaimVerifier
from jobctrl.domain.materials.entities import Artifact
from jobctrl.domain.materials.value_objects import ArtifactType, RenderFormat
from jobctrl.domain.ports.artifact_review import ValidationResult, JudgeVerdict
from jobctrl.domain.ports.claim_verification import ArtifactLine
from jobctrl.domain.profile.aggregate import Profile
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.events import get_default_publisher
from jobctrl.infrastructure.materials import SqliteMaterialsRepository
from jobctrl.infrastructure.materials.locale_variants import (
    digest,
    mutate_locale_variants,
    read_locale_state,
    locale_text,
)
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from tests.test_artifact_determinations import JOB_ID, PROFILE
from tests.test_locale_variants import LocaleModel, dependencies


@pytest.fixture
def owned(tmp_path):
    connection = sqlite3.connect(tmp_path / "jobctrl.db")
    connection.row_factory = sqlite3.Row
    create_exact_v14_schema(connection)
    connection.execute(
        "INSERT INTO jobs(tenant_id,job_id,url,title,company,discovered_at) VALUES('local',?,'https://example.test/owned','Synthetic','Synthetic','2026-10-08')",
        (JOB_ID,),
    )
    repo = SqliteProfileRepository(connection, publisher=get_default_publisher())
    repo.save(LOCAL_TENANT, Profile.from_dict(LOCAL_TENANT, PROFILE))
    model = LocaleModel()
    materials = MaterialsSetFactory.initial(tenant_id=LOCAL_TENANT, job_id=JOB_ID, created_at="2026-10-08")
    for kind, artifact_type, directory in (
        ("resume", ArtifactType.TAILORED_RESUME, "tailored_resumes"),
        ("cover_letter", ArtifactType.COVER_LETTER, "cover_letters"),
    ):
        root = tmp_path / directory
        root.mkdir()
        path = root / "owned.txt"
        path.write_text("Synthetic Person\nAuthored title\nAuthored employer\nCanonical source 42\n\nÉloï Synthetic\n")
        lines = [
            ArtifactLine(
                line_id=f"original:{i}", text=line, allowed_evidence_ids=["original"], allowed_requirement_ids=[]
            )
            for i, line in enumerate(path.read_text().splitlines())
            if line
        ]
        result, envelope = ModelClaimVerifier(**dependencies(connection, model)).verify(
            artifact_kind=kind,
            entity_id=str(JOB_ID),
            lines=lines,
            evidence=[Source(source_id="original", text=path.read_text())],
            requirements=[],
            rubric={},
        )
        metadata = {
            "accepted_text_sha256": digest(path.read_bytes()),
            "claim_verification_id": envelope.determination_id,
            "line_anchors": [
                {
                    "line_id": row.line_id,
                    "evidence_ids": ["original"],
                    "requirement_ids": [],
                    "transform_type": "verbatim",
                    "reason": "Recorded source",
                }
                for row in result.lines
            ],
        }
        artifact = Artifact.create(
            type=artifact_type,
            path=str(path),
            created_at="2026-10-08",
            render_format=RenderFormat.TEXT,
            metadata=metadata,
        )
        if kind == "resume":
            materials = materials.with_resume_attempt(
                artifact, validation=ValidationResult.success(), verdict=JudgeVerdict.passed(), updated_at="2026-10-08"
            )
        else:
            materials = materials.with_cover_letter(
                artifact, validation=ValidationResult.success(), updated_at="2026-10-08"
            )
    SqliteMaterialsRepository(connection).save(materials)
    connection.commit()
    yield connection, tmp_path, materials
    connection.close()


def run(owned, mutation, model=None, renderer=None):
    connection, root, _ = owned
    return mutate_locale_variants(
        connection,
        tenant_id="local",
        job_id=str(JOB_ID),
        app_dir=root,
        mutation=mutation,
        dependencies=dependencies(connection, model or LocaleModel()),
        renderer=renderer,
    )


def generate(owned, kind="resume", model=None, request_id=None, target_locale="es"):
    connection, _, _ = owned
    revision = read_locale_state(connection, tenant_id="local", job_id=str(JOB_ID))["revision"]
    return run(
        owned,
        dict(
            operation="generate",
            kind=kind,
            source_locale="en",
            target_locale=target_locale,
            expected_revision=revision,
            request_id=request_id or str(uuid.uuid4()),
        ),
        model,
    )


def accept(owned, state):
    variant = state["variants"][-1]
    for review in ("terminology", "formatting"):
        state = run(
            owned,
            dict(
                operation="review",
                variant_id=variant["variant_id"],
                expected_revision=state["revision"],
                expected_variant_revision=state["variants"][-1]["revision"],
                review_kind=review,
                decision="accepted",
            ),
        )
    return state


@pytest.mark.parametrize("kind", ["resume", "cover_letter"])
def test_generation_separate_reviews_and_three_structural_exports(owned, kind):
    connection, root, materials = owned
    original_bytes = {row.path: open(row.path, "rb").read() for row in materials.artifacts}
    state = generate(owned, kind)
    assert state["variants"][-1]["status"] == "candidate"
    assert len(state["variants"][-1]["determinations"]) == 4
    state = accept(owned, state)
    for export_format in ("text", "html", "docx"):
        variant = state["variants"][-1]
        state = run(
            owned,
            dict(
                operation="export",
                variant_id=variant["variant_id"],
                expected_revision=state["revision"],
                expected_variant_revision=variant["revision"],
                export_format=export_format,
            ),
        )
        record = state["variants"][-1]["exports"][-1]
        data = (
            root
            / "tailored_resumes"
            / "locale_variants"
            / (record["export_id"] + (".txt" if export_format == "text" else "." + export_format))
        ).read_bytes()
        assert digest(data) == record["sha256"]
        if export_format == "docx":
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                content = ET.fromstring(archive.read("word/document.xml"))
                assert [
                    row.text or ""
                    for row in content.iter("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t")
                ] == locale_text(variant).splitlines()
        elif export_format == "text":
            assert data.decode() == locale_text(variant)
        else:
            assert 'lang="es"' in data.decode() and "Éloï Synthetic" in data.decode()
    assert len(state["variants"][-1]["reviews"]) == 2
    assert {path: open(path, "rb").read() for path in original_bytes} == original_bytes
    connection.commit()
    assert read_locale_state(connection, tenant_id="local", job_id=str(JOB_ID)) == state


@pytest.mark.parametrize(
    "fault", ["provider", "terms", "claims", "quality", "render", "source_bytes", "profile", "revision", "commit"]
)
def test_failed_refresh_preserves_original_and_accepted_locale_history(owned, fault, monkeypatch):
    connection, root, materials = owned
    state = accept(owned, generate(owned))
    before = json.loads(json.dumps(state["variants"]))
    source = root / "tailored_resumes" / "owned.txt"
    original = source.read_bytes()
    if fault == "provider":
        with pytest.raises(DeterminationFailure):
            generate(owned, model=LocaleModel(fault=RuntimeError("offline")), target_locale="fr")
    elif fault in {"terms", "claims", "quality"}:
        model = LocaleModel(**{{"claims": "verdict"}.get(fault, fault): "fail"})
        fresh = generate(owned, model=model, target_locale="fr")
        assert not fresh["variants"][-1]["gate_passed"]
        with pytest.raises(DeterminationFailure, match="locale_semantic_gate_failed"):
            accept(owned, fresh)
    elif fault == "render":

        def fail(*_args):
            raise OSError("render failed")

        with pytest.raises(DeterminationFailure, match="locale_export_failed"):
            run(
                owned,
                dict(
                    operation="export",
                    variant_id=before[0]["variant_id"],
                    expected_revision=state["revision"],
                    expected_variant_revision=before[0]["revision"],
                    export_format="pdf",
                ),
                renderer=fail,
            )
    elif fault == "source_bytes":
        source.write_text("Changed bytes")
        with pytest.raises(DeterminationFailure, match="source_bytes_changed"):
            generate(owned)
        source.write_bytes(original)
    elif fault == "profile":
        connection.execute("UPDATE candidate_profiles SET version=version+1")
        with pytest.raises(DeterminationFailure, match="stale_profile_version"):
            run(
                owned,
                dict(
                    operation="export",
                    variant_id=before[0]["variant_id"],
                    expected_revision=state["revision"],
                    expected_variant_revision=before[0]["revision"],
                    export_format="text",
                ),
            )
    elif fault == "revision":
        with pytest.raises(DeterminationFailure, match="stale_locale_revision"):
            run(
                owned,
                dict(
                    operation="generate",
                    kind="resume",
                    source_locale="en",
                    target_locale="fr",
                    expected_revision=0,
                    request_id=str(uuid.uuid4()),
                ),
            )
    else:
        from jobctrl.infrastructure.materials import locale_variants

        original_write = locale_variants._write

        def fail_once(conn, tenant, job, generation, operation):
            if not getattr(fail_once, "failed", False):
                fail_once.failed = True
                raise sqlite3.OperationalError("synthetic commit failure")
            return original_write(conn, tenant, job, generation, operation)

        monkeypatch.setattr(locale_variants, "_write", fail_once)
        with pytest.raises(DeterminationFailure, match="locale_generation_failed"):
            generate(owned)
    current = read_locale_state(connection, tenant_id="local", job_id=str(JOB_ID))
    assert current["variants"][0] == before[0]
    assert source.read_bytes() == original
    assert len(materials.artifacts) == 2


def test_duplicate_requests_are_idempotent_and_conflicting_payload_is_rejected(owned):
    request = str(uuid.uuid4())
    state = generate(owned, request_id=request)
    model = LocaleModel(fault=AssertionError("must not call model"))
    assert generate(owned, request_id=request, model=model) == state
    assert model.calls == []
    with pytest.raises(DeterminationFailure, match="request_id_conflict"):
        generate(owned, kind="cover_letter", request_id=request)


def test_stale_cover_pdf_aggregate_save_cannot_erase_locale_history(owned):
    connection, _, materials = owned
    stale = SqliteMaterialsRepository(connection).load(LOCAL_TENANT, JOB_ID)
    state = accept(owned, generate(owned))
    SqliteMaterialsRepository(connection).save(
        replace(stale, metadata={**stale.metadata, "companion_field": "preserved"})
    )
    assert read_locale_state(connection, tenant_id="local", job_id=str(JOB_ID)) == state
    assert SqliteMaterialsRepository(connection).load(LOCAL_TENANT, JOB_ID).metadata["companion_field"] == "preserved"


def test_source_and_profile_changes_during_provider_call_are_fenced(owned):
    connection, _, _ = owned
    model = LocaleModel()
    original = model.chat_json

    def change(messages, **kwargs):
        response = original(messages, **kwargs)
        connection.execute("UPDATE candidate_profiles SET version=version+1")
        connection.commit()
        return response

    model.chat_json = change
    with pytest.raises(DeterminationFailure, match="stale_profile_version"):
        generate(owned, model=model, target_locale="fr")
    assert read_locale_state(connection, tenant_id="local", job_id=str(JOB_ID))["variants"] == []


def test_unbound_legacy_sources_are_explicit(owned):
    connection, _, _ = owned
    connection.execute(
        "UPDATE job_materials_artifacts SET metadata_json=json_remove(metadata_json,'$.accepted_text_sha256')"
    )
    with pytest.raises(DeterminationFailure, match="source_byte_binding_unavailable"):
        generate(owned)


def test_actual_cli_inspection_and_rpc_dispatch(owned, monkeypatch):
    connection, root, _ = owned
    from jobctrl import cli, config, database
    from tests.rpc_contract_probe import build_server
    from jobctrl.infrastructure.materials import locale_variants

    monkeypatch.setattr(config, "APP_DIR", root)
    monkeypatch.setattr(config, "DB_PATH", root / "jobctrl.db")
    # Real DB handles and default handler registry, structural model only.
    monkeypatch.setattr(database, "init_db", lambda *args, **kwargs: sqlite_connection(root / "jobctrl.db"))
    monkeypatch.setattr(
        locale_variants, "determination_dependencies", lambda conn, **kwargs: dependencies(conn, LocaleModel())
    )
    connection.commit()
    output = io.StringIO()
    request = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "material_locale_variants",
        "params": {
            "tenantId": "local",
            "expectedAppDir": str(root),
            "expectedDbPath": str(root / "jobctrl.db"),
            "jobId": str(JOB_ID),
            "mutation": {
                "operation": "generate",
                "kind": "cover_letter",
                "source_locale": "en",
                "target_locale": "es",
                "expected_revision": 0,
                "request_id": str(uuid.uuid4()),
            },
        },
    }
    build_server().serve(stdin=io.StringIO(json.dumps(request) + "\n"), stdout=output)
    response = json.loads(output.getvalue())
    assert "error" not in response, response
    assert response["result"]["variants"][0]["kind"] == "cover_letter"
    result = CliRunner().invoke(cli.app, ["locale-variants", "inspect", str(JOB_ID)])
    assert result.exit_code == 0, result.output
    assert json.loads(result.stdout)["variants"] == response["result"]["variants"]
    request["params"]["expectedDbPath"] = str(root / "foreign.db")
    output = io.StringIO()
    build_server().serve(stdin=io.StringIO(json.dumps(request) + "\n"), stdout=output)
    assert json.loads(output.getvalue())["error"]


def sqlite_connection(path):
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    return connection


def prepare_api_fixture(root):
    """Executable owned fixture, consumed by the API's real-Python feature cases."""
    from pathlib import Path

    fixture = owned.__wrapped__(Path(root))
    connection, _, materials = next(fixture)
    connection.commit()
    result = {
        "job_id": str(JOB_ID),
        "source_artifacts": [
            {"id": row.artifact_id, "path": row.path, "sha256": digest(open(row.path, "rb").read())}
            for row in materials.artifacts
        ],
    }
    try:
        next(fixture)
    except StopIteration:
        pass
    return result


def serve_product_probe():
    """Only the model is doubled; registered handlers, runtime, persistence and rendering are real."""
    from unittest.mock import patch
    from jobctrl.infrastructure.materials import locale_variants
    from tests.rpc_contract_probe import build_server

    with patch.object(
        locale_variants,
        "determination_dependencies",
        side_effect=lambda conn, **kwargs: dependencies(conn, LocaleModel()),
    ):
        build_server().serve()


@pytest.mark.parametrize("kind", ["resume", "cover_letter"])
def test_real_pdf_export_reads_same_accepted_claims(owned, kind):
    from pathlib import Path
    from pypdf import PdfReader

    state = accept(owned, generate(owned, kind))
    variant = state["variants"][-1]
    state = run(
        owned,
        dict(
            operation="export",
            variant_id=variant["variant_id"],
            expected_revision=state["revision"],
            expected_variant_revision=variant["revision"],
            export_format="pdf",
        ),
    )
    record = state["variants"][-1]["exports"][-1]
    assert Path(record["path"]).read_bytes().startswith(b"%PDF")
    assert " ".join("\n".join(page.extract_text() for page in PdfReader(record["path"]).pages).split()) == " ".join(
        locale_text(variant).split()
    )


def test_unchanged_sources_reuse_recorded_authority_with_zero_new_calls(owned):
    first = generate(owned)
    model = LocaleModel(fault=AssertionError("cached sources must not spend"))
    second = generate(owned, model=model)
    assert model.calls == []
    assert first["variants"][0]["variant_id"] != second["variants"][-1]["variant_id"]
    assert first["variants"][0]["determinations"] == second["variants"][-1]["determinations"]


@pytest.mark.parametrize("fault", ["write", "commit", "html_content", "docx_content", "pdf_content"])
def test_failed_export_retains_accepted_bytes_and_registered_history(owned, monkeypatch, fault):
    from pathlib import Path
    from jobctrl.infrastructure.materials import locale_variants

    state = accept(owned, generate(owned))
    variant = state["variants"][-1]
    state = run(
        owned,
        dict(
            operation="export",
            variant_id=variant["variant_id"],
            expected_revision=state["revision"],
            expected_variant_revision=variant["revision"],
            export_format="text",
        ),
    )
    before = json.loads(json.dumps(state["variants"]))
    accepted = Path(before[0]["exports"][0]["path"])
    data = accepted.read_bytes()
    export_format = "text"
    renderer = None
    if fault == "write":
        original_open = Path.open

        def fail_open(path, mode="r", *args, **kwargs):
            if path.parent.name == "locale_variants" and mode == "xb":
                raise OSError("owned synthetic write failure")
            return original_open(path, mode, *args, **kwargs)

        monkeypatch.setattr(Path, "open", fail_open)
    elif fault == "commit":
        original_write = locale_variants._write

        def fail_once(*args):
            if not getattr(fail_once, "failed", False):
                fail_once.failed = True
                raise sqlite3.OperationalError("owned synthetic registration failure")
            return original_write(*args)

        monkeypatch.setattr(locale_variants, "_write", fail_once)
    elif fault == "html_content":
        export_format = "html"
        monkeypatch.setattr(
            locale_variants, "locale_html", lambda row: "<html><body><p>Omitted claims</p></body></html>"
        )
    elif fault == "docx_content":
        export_format = "docx"
        monkeypatch.setattr(locale_variants, "locale_docx", lambda row: b"invalid zip")
    else:
        export_format = "pdf"

        def renderer(content, path):
            from jobctrl.infrastructure.materials.playwright_html_pdf import _render_pdf_playwright

            _render_pdf_playwright("<html><body>Different claims</body></html>", path)

    with pytest.raises(DeterminationFailure):
        run(
            owned,
            dict(
                operation="export",
                variant_id=variant["variant_id"],
                expected_revision=state["revision"],
                expected_variant_revision=variant["revision"],
                export_format=export_format,
            ),
            renderer=renderer,
        )
    current = read_locale_state(owned[0], tenant_id="local", job_id=str(JOB_ID))
    assert current["variants"] == before
    assert current["failures"][-1]["operation"] == "export"
    assert accepted.read_bytes() == data
    assert list(accepted.parent.iterdir()) == [accepted]


@pytest.mark.parametrize("change", ["profile", "source", "review", "companion_metadata"])
def test_independent_writer_during_model_call_preserves_newer_state(owned, change):
    connection, root, _ = owned
    state = accept(owned, generate(owned))
    connection.commit()
    other = sqlite_connection(root / "jobctrl.db")
    before = state["variants"][0]
    model = LocaleModel()
    original = model.chat_json
    changed = False

    def concurrent(messages, **kwargs):
        nonlocal changed
        response = original(messages, **kwargs)
        if not changed:
            changed = True
            if change == "profile":
                other.execute("UPDATE candidate_profiles SET version=version+1")
            elif change == "source":
                source_id = other.execute(
                    "SELECT artifact_id FROM job_materials_artifacts WHERE artifact_type='tailored_resume'"
                ).fetchone()[0]
                other.execute(
                    "UPDATE job_materials_artifacts SET artifact_id=artifact_id || '-replacement' WHERE artifact_type='tailored_resume'"
                )
                other.execute(
                    "UPDATE semantic_entity_bindings SET entity_id=entity_id || '-replacement' WHERE entity_kind='artifact' AND entity_id=?",
                    (source_id,),
                )
            elif change == "review":
                from jobctrl.infrastructure.materials.locale_variants import _failure

                _failure(other, "local", str(JOB_ID), 1, "review", "owned_concurrent_operation")
            else:
                other.execute(
                    "UPDATE job_materials SET metadata_json=json_set(metadata_json,'$.companion_field','newer')"
                )
            other.commit()
        return response

    model.chat_json = concurrent
    try:
        if change == "companion_metadata":
            generate(owned, model=model, target_locale="fr")
            assert (
                json.loads(connection.execute("SELECT metadata_json FROM job_materials").fetchone()[0])[
                    "companion_field"
                ]
                == "newer"
            )
        else:
            with pytest.raises(
                DeterminationFailure,
                match={"profile": "stale_profile_version", "source": "stale_source", "review": "stale_locale_revision"}[
                    change
                ],
            ):
                generate(owned, model=model, target_locale="fr")
        assert read_locale_state(connection, tenant_id="local", job_id=str(JOB_ID))["variants"][0] == before
    finally:
        other.close()


def test_two_review_writers_cannot_overwrite_the_newer_acceptance(owned):
    connection, root, _ = owned
    state = generate(owned)
    connection.commit()
    second = sqlite_connection(root / "jobctrl.db")
    variant = state["variants"][0]
    request = dict(
        operation="review",
        variant_id=variant["variant_id"],
        expected_revision=state["revision"],
        expected_variant_revision=1,
        review_kind="terminology",
        decision="accepted",
    )
    reviewed = run(owned, request)
    connection.commit()
    try:
        with pytest.raises(DeterminationFailure, match="stale_locale_revision"):
            mutate_locale_variants(
                second,
                tenant_id="local",
                job_id=str(JOB_ID),
                app_dir=root,
                mutation={**request, "decision": "rejected"},
            )
        second.commit()
        current = read_locale_state(connection, tenant_id="local", job_id=str(JOB_ID))
        assert current["variants"] == reviewed["variants"]
        assert current["failures"][-1]["operation"] == "review"
    finally:
        second.close()


@pytest.mark.parametrize("tamper", ["missing_authority", "foreign_authority", "document"])
def test_acceptance_joins_recorded_authority_instead_of_trusting_metadata(owned, tamper):
    connection, _, _ = owned
    state = generate(owned)
    metadata = json.loads(connection.execute("SELECT metadata_json FROM job_materials").fetchone()[0])
    candidate = metadata["locale_variants_v1"]["variants"][0]
    if tamper == "missing_authority":
        connection.execute("DELETE FROM semantic_determinations WHERE kind='material_locale_terminology'")
    elif tamper == "foreign_authority":
        candidate["semantic_entity_id"] = "foreign"
    else:
        candidate["lines"][0]["text"] = "Extra unaccepted claim"
    connection.execute("UPDATE job_materials SET metadata_json=?", (json.dumps(metadata),))
    with pytest.raises(DeterminationFailure, match="locale_(determination|document)_binding_invalid"):
        accept(owned, state)
    current = read_locale_state(connection, tenant_id="local", job_id=str(JOB_ID))
    assert current["variants"][0]["status"] == "candidate"
    assert current["variants"][0]["reviews"] == []


def test_refused_refresh_keeps_original_and_previously_accepted_locale(owned):
    state = accept(owned, generate(owned))
    before = state["variants"][0]

    def refuse(result):
        citation = result["lines"][0]["source"]
        result.update(
            supported=False,
            lines=[],
            concerns=[{"kind": "unsupported_locale", "source": citation, "explanation": "Explicit structural refusal"}],
        )

    current = generate(owned, target_locale="xx", model=LocaleModel(mutate=refuse))
    assert current["variants"][0] == before
    assert current["variants"][-1]["status"] == "refused"
    assert current["variants"][-1]["concerns"][0]["kind"] == "unsupported_locale"
    with pytest.raises(DeterminationFailure, match="stale_locale_review"):
        accept(owned, current)


@pytest.mark.parametrize("kind", ["resume", "cover_letter"])
def test_actual_cli_generation_review_export_and_reload(owned, monkeypatch, kind):
    from jobctrl import cli, config, database
    from jobctrl.infrastructure.materials import locale_variants

    connection, root, _ = owned
    monkeypatch.setattr(config, "APP_DIR", root)
    monkeypatch.setattr(config, "DB_PATH", root / "jobctrl.db")
    monkeypatch.setattr(database, "init_db", lambda *args, **kwargs: sqlite_connection(root / "jobctrl.db"))
    monkeypatch.setattr(
        locale_variants, "determination_dependencies", lambda conn, **kwargs: dependencies(conn, LocaleModel())
    )
    connection.commit()
    runner = CliRunner()

    def command(args):
        output = runner.invoke(cli.app, ["locale-variants", *args])
        assert output.exit_code == 0, output.output
        return json.loads(output.stdout)

    state = command(
        ["generate", str(JOB_ID), kind, "en", "es", "--expected-revision", "0", "--request-id", str(uuid.uuid4())]
    )
    variant = state["variants"][-1]
    for review in ("terminology", "formatting"):
        state = command(
            [
                "review",
                str(JOB_ID),
                variant["variant_id"],
                review,
                "accepted",
                "--expected-revision",
                str(state["revision"]),
                "--expected-variant-revision",
                str(state["variants"][-1]["revision"]),
            ]
        )
    for export_format in ("text", "html", "pdf", "docx"):
        state = command(
            [
                "export",
                str(JOB_ID),
                variant["variant_id"],
                export_format,
                "--expected-revision",
                str(state["revision"]),
                "--expected-variant-revision",
                str(state["variants"][-1]["revision"]),
            ]
        )
    assert command(["inspect", str(JOB_ID)]) == state
    assert len(state["variants"][-1]["exports"]) == 4


@pytest.mark.parametrize("export_format", ["text", "pdf"])
def test_export_id_collision_never_overwrites_or_deletes_accepted_bytes(owned, monkeypatch, export_format):
    from pathlib import Path
    from jobctrl.infrastructure.materials import locale_variants

    state = accept(owned, generate(owned))
    variant = state["variants"][0]
    mutation = dict(
        operation="export",
        variant_id=variant["variant_id"],
        expected_revision=state["revision"],
        expected_variant_revision=variant["revision"],
        export_format=export_format,
    )
    state = run(owned, mutation)
    before = json.loads(json.dumps(state["variants"]))
    record = before[0]["exports"][0]
    path = Path(record["path"])
    original = path.read_bytes()
    monkeypatch.setattr(locale_variants.uuid, "uuid4", lambda: uuid.UUID(record["export_id"]))
    with pytest.raises(DeterminationFailure, match="locale_export_failed"):
        run(owned, {**mutation, "expected_revision": state["revision"]})
    assert path.read_bytes() == original
    assert read_locale_state(owned[0], tenant_id="local", job_id=str(JOB_ID))["variants"] == before
