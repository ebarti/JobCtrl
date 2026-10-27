"""Owned exact-schema authority/cutover/recovery cases, never semantic grading."""

from __future__ import annotations

import importlib
import sqlite3
from pathlib import Path

import pytest

from jobctrl.domain.determinations import DeterminationFailure
from jobctrl.domain.profile.canonical_sources import profile_sources
from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.infrastructure.events.in_process_bus import InProcessEventBus
from jobctrl.infrastructure.migrations.legacy_to_v15_execute import execute_legacy_to_v15_candidate
from jobctrl.infrastructure.migrations.schema_v12 import create_exact_v12_schema
from jobctrl.infrastructure.migrations.schema_v13 import upgrade_exact_v12_schema_to_v13
from jobctrl.infrastructure.profile.legacy_evidence import (
    LegacyEvidenceReviewError, decide_review, evidence_rows, prepare_review, record_legacy_inventory,
)
from jobctrl.infrastructure.profile.sqlite_repository import SqliteProfileRepository
from tests.v6_migration_fixture import create_shipped_v6_database


def seed_evidence(conn: sqlite3.Connection) -> list[dict]:
    conn.execute("INSERT INTO candidate_profiles (tenant_id,profile_id,personal_full_name,updated_at) VALUES ('local','default','Synthetic Reviewer','2026-10-20T00:00:00Z')")
    conn.execute("INSERT INTO candidate_profile_experience_entries (tenant_id,profile_id,entry_id,position_index,title,company) VALUES ('local','default','role',0,'Engineer','Synthetic Employer')")
    # Explicit construction histories: the first is independently authored; the
    # second is the historical materializing writer's fields (0b61aef78^,
    # _legacy_bullet_achievement_evidence), with its inferred confirmation.
    # Production must not attempt to distinguish these by their value shapes.
    for index, ident, text, scope, metrics, confirmed, strength, confidence in [
        (0, "role_bullet_1", "Authored exact text\n", "Authored  scope\t", '["35%", "200 people"]', 1, "supported", .8),
        (1, "role_bullet_2", "Shipped 3 systems.", "Engineer Synthetic Employer", '["3"]', 1, "supported", .8),
        (2, "independent-control", "Other source", "Independent scope", '["8"]', 1, "verified", .95),
        (3, "unconfirmed-control", "Unconfirmed source", "Draft scope", "[]", 0, "draft", 0),
    ]:
        conn.execute("INSERT INTO candidate_profile_achievement_evidence (tenant_id,profile_id,entry_id,evidence_index,evidence_id,source_text,scope,action,metrics_json,outcome,evidence_strength,claim_confidence,user_confirmed) VALUES ('local','default','role',?,?,?,?,?,?,?,?,?,?)",
                     (index, ident, text, scope, text, metrics, text, strength, confidence, confirmed))
    conn.commit()
    return evidence_rows(conn)


def _snapshot(conn):
    conn.row_factory = sqlite3.Row
    return SqliteProfileRepository(conn, publisher=InProcessEventBus()).load_snapshot(LOCAL_TENANT).as_dict()


def test_authored_collision_and_system_derived_cells_survive_and_require_explicit_review():
    conn = sqlite3.connect(":memory:")
    create_exact_v12_schema(conn)
    before = seed_evidence(conn)
    upgrade_exact_v12_schema_to_v13(conn)
    assert evidence_rows(conn) == [{key: value for key, value in row.items() if key != "seniority_signal"} for row in before]
    pending = prepare_review(conn, tenant_id="local", profile_id="default")
    assert [item["original"] for item in pending] == before[:3]
    assert all(item["status"] == "pending_review" for item in pending)
    with pytest.raises(DeterminationFailure, match="legacy_evidence_review_required"):
        profile_sources(_snapshot(conn))
    conn.row_factory = None
    original_history = conn.execute("SELECT * FROM job_events WHERE event_type='LegacyEvidenceReviewRecorded'").fetchall()
    record_legacy_inventory(conn, before)
    conn.commit()
    assert conn.execute("SELECT * FROM job_events WHERE event_type='LegacyEvidenceReviewRecorded'").fetchall() == original_history
    for ident, decision in [("role_bullet_1", "confirm"), ("role_bullet_2", "reject"), ("independent-control", "confirm")]:
        item = next(item for item in prepare_review(conn, tenant_id="local", profile_id="default") if item["current"]["evidence_id"] == ident)
        decide_review(conn, tenant_id="local", profile_id="default", entry_id="role", evidence_id=ident, token=item["token"], decision=decision)
        with pytest.raises(LegacyEvidenceReviewError):
            decide_review(conn, tenant_id="local", profile_id="default", entry_id="role", evidence_id=ident, token=item["token"], decision=decision)
    sources = {source.source_id for source in profile_sources(_snapshot(conn))}
    assert "role_bullet_1" in sources and "independent-control" in sources
    assert "role_bullet_2" not in sources and "unconfirmed-control" not in sources


@pytest.mark.parametrize("version", range(6, 13))
def test_all_applicable_supported_cutovers_preserve_original_cells(tmp_path: Path, version: int):
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    if version == 6:
        create_shipped_v6_database(source)
    with sqlite3.connect(source) as conn:
        if version != 6:
            module = importlib.import_module(f"jobctrl.infrastructure.migrations.schema_v{version}")
            getattr(module, f"create_exact_v{version}_schema")(conn)
        if version != 6:
            conn.execute("INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local','11111111-1111-4111-8111-111111111111','https://synthetic.invalid/owned','Synthetic job')")
        original = seed_evidence(conn)
    before = source.read_bytes()
    execute_legacy_to_v15_candidate(source, candidate, source_version=version, migration_at="2026-10-27T00:00:00Z" if version == 6 else None)
    assert source.read_bytes() == before
    with sqlite3.connect(candidate) as conn:
        assert evidence_rows(conn) == [{key: value for key, value in row.items() if key != "seniority_signal"} for row in original]
        assert len(prepare_review(conn, tenant_id="local", profile_id="default")) == 3
    assert sorted(path.name for path in tmp_path.iterdir()) == ["candidate.db", "source.db"]


def test_failed_cutover_preserves_source_and_every_confirmation_cell(monkeypatch):
    from jobctrl.infrastructure.migrations import schema_v13

    conn = sqlite3.connect(":memory:")
    create_exact_v12_schema(conn)
    original = seed_evidence(conn)
    monkeypatch.setattr(schema_v13, "record_legacy_inventory", None, raising=False)
    from jobctrl.infrastructure.profile import legacy_evidence

    def fail(*_args):
        raise RuntimeError("owned injected inventory failure")

    monkeypatch.setattr(legacy_evidence, "record_legacy_inventory", fail)
    with pytest.raises(RuntimeError):
        upgrade_exact_v12_schema_to_v13(conn)
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 12
    assert evidence_rows(conn) == original


@pytest.mark.parametrize("mutation", ["source", "confirmation", "profile_version", "delete"])
def test_review_refuses_stale_or_conflicting_current_state(mutation):
    conn = sqlite3.connect(":memory:")
    create_exact_v12_schema(conn)
    seed_evidence(conn)
    upgrade_exact_v12_schema_to_v13(conn)
    item = prepare_review(conn, tenant_id="local", profile_id="default")[0]
    sql = {"source": "UPDATE candidate_profile_achievement_evidence SET scope='newer authored edit' WHERE evidence_index=0",
           "confirmation": "UPDATE candidate_profile_achievement_evidence SET user_confirmed=0 WHERE evidence_index=0",
           "profile_version": "UPDATE candidate_profiles SET version=version+1",
           "delete": "DELETE FROM candidate_profile_achievement_evidence WHERE evidence_index=0"}[mutation]
    conn.execute(sql)
    conn.commit()
    before = evidence_rows(conn)
    with pytest.raises(LegacyEvidenceReviewError):
        decide_review(conn, tenant_id="local", profile_id="default", entry_id="role", evidence_id="role_bullet_1", token=item["token"], decision="confirm")
    assert evidence_rows(conn) == before
    if mutation == "source":
        item = prepare_review(conn, tenant_id="local", profile_id="default")[0]
        with pytest.raises(LegacyEvidenceReviewError, match="conflict"):
            decide_review(conn, tenant_id="local", profile_id="default", entry_id="role", evidence_id="role_bullet_1", token=item["token"], decision="confirm")


def test_real_material_refresh_preserves_accepted_id_bytes_and_anchors_when_review_required(tmp_path):
    from tests.test_materials_use_cases import ResumeModel, connection, request, resume_case
    from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository
    from tests.test_artifact_determinations import JOB_ID

    conn = connection()
    accepted = resume_case(conn, ResumeModel()).execute(**request(tmp_path))
    before = Path(accepted.materials.tailored_resume.path).read_bytes()
    anchors = conn.execute("SELECT * FROM artifact_line_anchors").fetchall()
    seed_evidence(conn)
    record_legacy_inventory(conn, evidence_rows(conn))
    conn.commit()
    profile = _snapshot(conn)
    model = ResumeModel()
    with pytest.raises(DeterminationFailure, match="legacy_evidence_review_required"):
        resume_case(conn, model).execute(**request(tmp_path, retailor=True, profile=profile))
    current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
    assert current.tailored_resume.artifact_id == accepted.materials.tailored_resume.artifact_id
    assert Path(current.tailored_resume.path).read_bytes() == before
    assert [tuple(row) for row in conn.execute("SELECT * FROM artifact_line_anchors")] == [tuple(row) for row in anchors]
    assert model.generations == 0


def test_malformed_legacy_confirmation_is_unknown_and_damaged_inventory_cannot_grant_authority():
    conn = sqlite3.connect(":memory:")
    create_exact_v12_schema(conn)
    seed_evidence(conn)
    conn.execute("UPDATE candidate_profile_achievement_evidence SET user_confirmed=2 WHERE evidence_index=0")
    conn.commit()
    upgrade_exact_v12_schema_to_v13(conn)
    assert len(prepare_review(conn, tenant_id="local", profile_id="default")) == 3
    conn.execute("UPDATE job_events SET payload_json=json_set(payload_json,'$.result.status','unconfirmed') WHERE entity_ref=?", ('["default","role","role_bullet_1"]',))
    with pytest.raises(LegacyEvidenceReviewError, match="invalid_history"):
        prepare_review(conn, tenant_id="local", profile_id="default")
