"""Canonical snapshot and preservation checks for browser export operations."""
import json
from pathlib import Path

import pytest

from jobctrl.domain.materials.editable_export import ExportFailure
from jobctrl.infrastructure.materials.accepted_export_api import operation
from tests.test_accepted_docx_export import JOB, owned as _owned, preservation_state

owned = _owned


def call(owned, request=None, **overrides):
    connection, root = owned
    return operation(connection, tenant_id="local", job_id=JOB, root=root,
                     request=request or {"operation": "history"}, **overrides)


def command(source, paper="A4"):
    return {"operation": "export", "sourceArtifactId": source["artifactId"],
            "expectedGeneration": source["generation"], "expectedSourceSha256": source["sha256"],
            "expectedMetadataSha256": source["metadataSha256"], "paper": paper}


@pytest.mark.parametrize("paper", ["A4", "Letter"])
def test_history_and_exports_bind_sources_without_paths_or_private_metadata(owned, paper):
    before = preservation_state(owned)
    snapshot = call(owned)
    assert len(snapshot["sources"]) == 2
    assert "private_prompt" not in json.dumps(snapshot)
    assert str(owned[1]) not in json.dumps(snapshot)
    for source in snapshot["sources"]:
        exported = call(owned, command(source, paper))
        receipt = exported["exports"][0]
        assert exported["exportedArtifactId"] == receipt["artifactId"]
        assert receipt["sourceSha256"] == source["sha256"]
        assert receipt["settings"]["paper"] == paper
        assert receipt["settings"]["locale"] == "fr-FR"
        assert "path" not in receipt
    assert len(call(owned)["exports"]) == 2
    assert preservation_state(owned) == before


@pytest.mark.parametrize("drift", ["bytes", "metadata", "status", "generation", "superseded"])
def test_selection_drift_refuses_new_export_and_preserves_retained_one(owned, drift):
    source = call(owned)["sources"][0]
    prior = call(owned, command(source))["exports"]
    connection, root = owned
    if drift == "bytes":
        (root / f'{source["kind"]}.txt').write_text("Concurrent accepted edit")
    elif drift == "metadata":
        connection.execute("UPDATE job_materials_artifacts SET metadata_json='{}' WHERE artifact_id=?", (source["artifactId"],))
    else:
        field, value = {"status": ("status", "rejected"), "generation": ("generation", 2),
                        "superseded": ("superseded_at", "2026-10-17")}[drift]
        connection.execute(f"UPDATE job_materials_artifacts SET {field}=? WHERE artifact_id=?", (value, source["artifactId"]))
    connection.commit()
    before = preservation_state(owned)
    with pytest.raises(ExportFailure, match="stale_|accepted_source_unavailable"):
        call(owned, command(source))
    assert call(owned)["exports"] == prior
    assert preservation_state(owned) == before
    assert len(list((root / "generated/material-exports").glob("*.docx"))) == 1


def test_missing_source_is_explicit_and_does_not_hide_retained_exports(owned):
    source = call(owned)["sources"][0]
    prior = call(owned, command(source))["exports"]
    (owned[1] / f'{source["kind"]}.txt').unlink()
    result = call(owned)
    assert result["sources"][0]["unavailableReason"] == "source_bytes_or_metadata_unavailable"
    assert result["sources"][0]["sha256"] is None
    assert result["exports"] == prior


@pytest.mark.parametrize("payload", [
    {"operation": "history", "path": "/private"}, {"operation": "export"},
    {"operation": "submit"}, {"operation": "history", "tenantId": "foreign"},
])
def test_invalid_browser_requests_do_not_mutate(owned, payload):
    before = preservation_state(owned)
    with pytest.raises(ExportFailure, match="invalid_export_request"):
        call(owned, payload)
    assert preservation_state(owned) == before
    assert not list(owned[1].rglob("*.docx"))


def test_job_and_tenant_must_match(owned):
    for tenant_id, job_id in [("foreign", JOB), ("local", "90000000-0000-4000-8000-000000009999")]:
        with pytest.raises(ExportFailure, match="job_not_found"):
            operation(owned[0], tenant_id=tenant_id, job_id=job_id, root=owned[1], request={"operation": "history"})


def test_rpc_requires_the_actual_runtime_before_opening_database(owned, monkeypatch):
    from jobctrl import config
    from jobctrl.infrastructure.rpc.handlers import accepted_material_exports
    from jobctrl.infrastructure.runtime_identity import RuntimeIdentityMismatch
    monkeypatch.setattr(config, "APP_DIR", owned[1])
    monkeypatch.setattr(config, "DB_PATH", owned[1] / "jobctrl.db")
    with pytest.raises(RuntimeIdentityMismatch):
        accepted_material_exports({"tenantId": "local", "jobId": JOB, "expectedAppDir": str(owned[1]),
                                   "expectedDbPath": str(Path(owned[1]) / "foreign.db"), "request": {"operation": "history"}})
