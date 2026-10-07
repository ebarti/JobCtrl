"""Storage provenance, exact schema and purge mechanics with synthetic records."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.domain.determinations import DeterminationEnvelope
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V12_MANIFEST,
    EXACT_V13_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.schema_v12 import create_exact_v12_schema
from jobctrl.infrastructure.migrations.schema_v13 import create_exact_v13_schema, upgrade_exact_v12_schema_to_v13


def test_cutover_preserves_accepted_artifact_bytes_and_authored_metadata(tmp_path: Path) -> None:
    source = tmp_path / "accepted.txt"
    contents = b"Owned synthetic accepted artifact\n"
    source.write_bytes(contents)
    connection = sqlite3.connect(":memory:")
    create_exact_v12_schema(connection)
    job_id = "10000000-0000-4000-8000-000000000001"
    connection.execute(
        "INSERT INTO jobs (tenant_id,job_id,url) VALUES ('local',?,'https://example.org/owned')", (job_id,)
    )
    connection.execute(
        "INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at) VALUES ('local',?,1,'resume_approved','2026-10-07','2026-10-07')",
        (job_id,),
    )
    metadata = {
        "owner_note": "Keep this accepted version",
        "quality_checks": {"passed": True},
        "annotated_changes": ["legacy heuristic"],
    }
    connection.execute(
        "INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,size_bytes,metadata_json,created_at) VALUES ('local',?,1,'tailored_resume','owned-artifact','approved',?,'text',?,?,'2026-10-07')",
        (job_id, str(source), len(contents), json.dumps(metadata)),
    )
    before = connection.execute(
        "SELECT job_id,generation,artifact_type,artifact_id,status,path,size_bytes,created_at FROM job_materials_artifacts"
    ).fetchone()
    connection.commit()
    upgrade_exact_v12_schema_to_v13(connection)
    assert source.read_bytes() == contents
    assert (
        connection.execute(
            "SELECT job_id,generation,artifact_type,artifact_id,status,path,size_bytes,created_at FROM job_materials_artifacts"
        ).fetchone()
        == before
    )
    assert json.loads(connection.execute("SELECT metadata_json FROM job_materials_artifacts").fetchone()[0]) == {
        "owner_note": "Keep this accepted version"
    }
    connection.close()


def test_exact_v13_and_durable_tenant_bound_envelopes(tmp_path: Path) -> None:
    path = tmp_path / "owned.sqlite"
    connection = sqlite3.connect(path)
    create_exact_v13_schema(connection)
    assert_exact_manifest(connection, EXACT_V13_MANIFEST)
    repository = SqliteDeterminationRepository(connection)
    envelope = DeterminationEnvelope(
        determination_id="a" * 64,
        tenant_id="synthetic",
        entity_id="synthetic:1",
        kind="test",
        schema_version="1",
        prompt_version="1",
        provider="fake",
        model="fake",
        lane="profile",
        input_fingerprint="a" * 64,
        created_at="2026-10-06T00:00:00Z",
        result={"verdict": "model-selected"},
    )
    repository.save(envelope)
    connection.commit()
    connection.close()
    reopened = sqlite3.connect(path)
    repository = SqliteDeterminationRepository(reopened)
    assert repository.find("synthetic", "a" * 64) == envelope
    assert repository.find("foreign", "a" * 64) is None
    assert_exact_manifest(reopened, EXACT_V13_MANIFEST)
    reopened.close()


def test_upgrade_invalidates_system_written_confirmation_and_preserves_authored_evidence() -> None:
    connection = sqlite3.connect(":memory:")
    create_exact_v12_schema(connection)
    for index, evidence_id, source, action, confidence in [
        (0, "entry_bullet_1", "synthetic source", "synthetic source", 0.8),
        (1, "authored", "authored source", "independent action", 0.9),
    ]:
        connection.execute(
            "INSERT INTO candidate_profile_achievement_evidence (tenant_id,profile_id,entry_id,evidence_index,evidence_id,source_text,action,outcome,seniority_signal,evidence_strength,claim_confidence,user_confirmed) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "synthetic",
                "profile",
                "entry",
                index,
                evidence_id,
                source,
                action,
                source,
                "old inference",
                "supported",
                confidence,
                1,
            ),
        )
    connection.commit()
    upgrade_exact_v12_schema_to_v13(connection)
    assert_exact_manifest(connection, EXACT_V13_MANIFEST)
    assert "seniority_signal" not in {
        row[1] for row in connection.execute("PRAGMA table_info(candidate_profile_achievement_evidence)")
    }
    derived, authored = connection.execute(
        "SELECT evidence_id,source_text,action,evidence_strength,claim_confidence,user_confirmed FROM candidate_profile_achievement_evidence ORDER BY evidence_index"
    ).fetchall()
    assert derived == ("entry_bullet_1", "synthetic source", "synthetic source", "draft", 0, 0)
    assert authored == ("authored", "authored source", "independent action", "supported", 0.9, 1)


def test_failed_upgrade_is_atomic(monkeypatch) -> None:
    import jobctrl.infrastructure.migrations.schema_v13 as schema

    connection = sqlite3.connect(":memory:")
    create_exact_v12_schema(connection)
    before = connection.execute("SELECT name,sql FROM sqlite_master ORDER BY name").fetchall()
    monkeypatch.setattr(schema, "_statements", lambda: ("CREATE TABLE partial (id TEXT);", "invalid SQL;"))
    with pytest.raises(sqlite3.Error):
        upgrade_exact_v12_schema_to_v13(connection)
    assert connection.execute("PRAGMA user_version").fetchone()[0] == 12
    assert connection.execute("SELECT name,sql FROM sqlite_master ORDER BY name").fetchall() == before
    assert_exact_manifest(connection, EXACT_V12_MANIFEST)


def test_taxonomy_resource_matches_contracts_authority() -> None:
    root = Path(__file__).resolve().parents[3]
    authority = json.loads((root / "packages/contracts/src/semantic-taxonomy.v1.json").read_text())
    resource = json.loads((root / "workers/automation/src/jobctrl/assets/determinations/taxonomy.v1.json").read_text())
    assert resource == authority
