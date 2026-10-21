"""Explicit material requests survive automatic admission reconciliation."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from jobctrl.domain.tenant import LOCAL_TENANT
from jobctrl.pipeline import preparation
from tests.test_artifact_determinations import JOB_ID, connection
from tests.test_materials_use_cases import ResumeModel, canonical_scored_target, request, resume_case


def _stored_resume(conn):
    return conn.execute(
        "SELECT status, metadata_json FROM job_materials_artifacts "
        "WHERE tenant_id='local' AND job_id=? AND artifact_type='tailored_resume' "
        "ORDER BY generation DESC LIMIT 1", (str(JOB_ID),),
    ).fetchone()


def _sweep(conn, monkeypatch):
    monkeypatch.setattr(preparation, "get_connection", lambda: conn)
    return preparation.derive_preparation_targets(
        preparation.DerivePreparationTargetsInput(tenant_id=str(LOCAL_TENANT), min_score=7),
    )


@pytest.mark.parametrize("manual", [False, True])
def test_accepted_generation_records_request_and_survives_repeated_discovery_sweeps(tmp_path, monkeypatch, manual):
    with connection() as conn:
        inputs = request(tmp_path)
        inputs["job"] = canonical_scored_target(conn, 6)
        result = resume_case(conn, ResumeModel()).execute(**inputs, allow_low_fit_override=manual)
        assert result.status == "approved"
        assert result.materials.metadata["allow_low_fit_override"] is manual
        assert json.loads(_stored_resume(conn)["metadata_json"])["allow_low_fit_override"] is manual
        before_score = [tuple(r) for r in conn.execute("SELECT * FROM job_scores ORDER BY version")]
        for _ in range(2):
            targets = _sweep(conn, monkeypatch)
            assert JOB_ID not in {r.job_id for r in targets}, "Override does not admit new automatic work"
            assert _stored_resume(conn)["status"] == ("approved" if manual else "suppressed")
        assert Path(result.text_path).is_file()
        assert [tuple(r) for r in conn.execute("SELECT * FROM job_scores ORDER BY version")] == before_score


@pytest.mark.parametrize("flag,expected", [(True, "approved"), (False, "suppressed"), ("true", "suppressed"), (1, "suppressed"), (None, "suppressed")])
def test_only_literal_generation_bound_authorization_bypasses_the_floor(tmp_path, monkeypatch, flag, expected):
    with connection() as conn:
        inputs = request(tmp_path)
        inputs["job"] = canonical_scored_target(conn, 6)
        assert resume_case(conn, ResumeModel()).execute(**inputs).status == "approved"
        conn.execute("UPDATE job_materials_artifacts SET metadata_json=? WHERE artifact_type='tailored_resume'",
                     (json.dumps({"allow_low_fit_override": flag}),))
        conn.commit()
        _sweep(conn, monkeypatch)
        assert _stored_resume(conn)["status"] == expected


@pytest.mark.parametrize("change", ["hard_blocker", "missing_score", "new_automatic_generation", "other_tenant"])
def test_override_does_not_cross_authority_boundaries(tmp_path, monkeypatch, change):
    with connection() as conn:
        inputs = request(tmp_path)
        inputs["job"] = canonical_scored_target(conn, 6)
        assert resume_case(conn, ResumeModel()).execute(**inputs).status == "approved"
        conn.execute("UPDATE job_materials_artifacts SET metadata_json=? WHERE artifact_type='tailored_resume'",
                     ('{"allow_low_fit_override":true}',))
        if change == "hard_blocker":
            conn.execute("UPDATE job_scores SET breakdown_json=? WHERE version=2",
                         ('{"eligibility":{"status":"blocked","hard_blockers":["Explicit synthetic policy block"]}}',))
        elif change == "missing_score":
            conn.execute("DELETE FROM job_scores")
        elif change == "new_automatic_generation":
            conn.execute("UPDATE job_materials_artifacts SET status='superseded'")
            conn.execute("INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at,metadata_json) "
                         "SELECT tenant_id,job_id,2,status,created_at,updated_at,'{}' FROM job_materials WHERE generation=1")
            conn.execute("INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at,metadata_json) "
                         "SELECT tenant_id,job_id,2,artifact_type,'new-auto-artifact','approved',path,render_format,created_at,'{}' "
                         "FROM job_materials_artifacts WHERE generation=1 AND artifact_type='tailored_resume'")
        else:
            conn.execute("INSERT INTO jobs (tenant_id,job_id,url,discovered_at) "
                         "SELECT 'other',job_id,url,discovered_at FROM jobs")
            conn.execute("INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at,metadata_json) "
                         "SELECT 'other',job_id,generation,status,created_at,updated_at,metadata_json FROM job_materials")
            conn.execute("INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at,metadata_json) "
                         "SELECT 'other',job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at,metadata_json FROM job_materials_artifacts")
            conn.execute("UPDATE job_materials_artifacts SET metadata_json='{}' WHERE tenant_id='local'")
        conn.commit()
        _sweep(conn, monkeypatch)
        assert _stored_resume(conn)["status"] == "suppressed"
        if change == "other_tenant":
            assert conn.execute("SELECT status FROM job_materials_artifacts WHERE tenant_id='other'").fetchone()[0] == "approved"


@pytest.mark.parametrize("metadata", ['not-json', '[]'])
def test_invalid_metadata_cannot_authorize_retention(tmp_path, monkeypatch, metadata):
    with connection() as conn:
        inputs = request(tmp_path)
        inputs["job"] = canonical_scored_target(conn, 6)
        assert resume_case(conn, ResumeModel()).execute(**inputs).status == "approved"
        conn.execute("UPDATE job_materials_artifacts SET metadata_json=? WHERE artifact_type='tailored_resume'", (metadata,))
        conn.commit()
        _sweep(conn, monkeypatch)
        assert _stored_resume(conn)["status"] == "suppressed"


@pytest.mark.parametrize("replacement_quality", ["pass", "fail"])
def test_replacement_only_changes_the_accepted_generations_own_exception(tmp_path, monkeypatch, replacement_quality):
    from jobctrl.infrastructure.materials.sqlite_repository import SqliteMaterialsRepository

    with connection() as conn:
        inputs = request(tmp_path)
        inputs["job"] = canonical_scored_target(conn, 6)
        case = resume_case(conn, ResumeModel())
        original = case.execute(**inputs, allow_low_fit_override=True)
        assert original.status == "approved"
        replacement = resume_case(conn, ResumeModel(quality=replacement_quality, text="Synthetic replacement")).execute(
            **{**inputs, "retailor": True}, allow_low_fit_override=False,
        )
        accepted = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
        assert accepted is not None
        if replacement_quality == "pass":
            assert replacement.status == "approved"
            assert accepted.generation == 2
            assert accepted.metadata["allow_low_fit_override"] is False
            _sweep(conn, monkeypatch)
            assert SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID) is None
        else:
            assert replacement.status != "approved"
            assert accepted.generation == 1
            assert accepted.metadata["allow_low_fit_override"] is True
            for _ in range(2):
                _sweep(conn, monkeypatch)
                current = SqliteMaterialsRepository(conn).load_current_approved(LOCAL_TENANT, JOB_ID)
                assert current is not None and current.generation == 1
                assert current.tailored_resume.metadata["allow_low_fit_override"] is True
        assert Path(original.text_path).is_file()


def test_discovery_sweep_serializes_manual_publication_with_eligibility_read(tmp_path, monkeypatch):
    import sqlite3
    from concurrent.futures import ThreadPoolExecutor

    database_path = tmp_path / "race.db"
    with connection() as source, sqlite3.connect(database_path) as conn:
        conn.row_factory = sqlite3.Row
        source.backup(conn)
        inputs = request(tmp_path / "materials")
        inputs["job"] = canonical_scored_target(conn, 6)
        assert resume_case(conn, ResumeModel()).execute(**inputs).status == "approved"

        def publish_manual_generation():
            with sqlite3.connect(database_path, timeout=0.05) as writer:
                try:
                    writer.execute("BEGIN IMMEDIATE")
                    writer.execute("INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at,metadata_json) "
                                   "SELECT tenant_id,job_id,2,status,created_at,updated_at,'{\"allow_low_fit_override\":true}' "
                                   "FROM job_materials WHERE generation=1")
                    writer.execute("UPDATE job_materials_artifacts SET status='superseded' WHERE generation=1")
                    writer.execute("INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at,metadata_json) "
                                   "SELECT tenant_id,job_id,2,artifact_type,'manual-g2','approved',path,render_format,created_at,'{\"allow_low_fit_override\":true}' "
                                   "FROM job_materials_artifacts WHERE generation=1 AND artifact_type='tailored_resume'")
                except sqlite3.OperationalError as error:
                    assert "locked" in str(error)
                    return "locked"
            return "published"

        original = preparation._jobs_needing_artifact_suppression
        attempts = []
        with ThreadPoolExecutor(max_workers=1) as executor:
            def select_and_try_publish(*args, **kwargs):
                selected = original(*args, **kwargs)
                if selected:
                    status = executor.submit(publish_manual_generation).result(timeout=2)
                    attempts.append(status)
                    assert status == "locked", "Manual approval crossed the eligibility-to-suppression window"
                return selected

            monkeypatch.setattr(preparation, "_jobs_needing_artifact_suppression", select_and_try_publish)
            _sweep(conn, monkeypatch)
            assert attempts == ["locked"]
            assert executor.submit(publish_manual_generation).result(timeout=2) == "published"
            _sweep(conn, monkeypatch)
        assert _stored_resume(conn)["status"] == "approved"
        assert json.loads(_stored_resume(conn)["metadata_json"])["allow_low_fit_override"] is True


def test_failed_sweep_rolls_back_artifact_mutations_with_reconciliation(tmp_path, monkeypatch):
    with connection() as conn:
        inputs = request(tmp_path)
        inputs["job"] = canonical_scored_target(conn, 6)
        assert resume_case(conn, ResumeModel()).execute(**inputs).status == "approved"
        before = tuple(_stored_resume(conn))
        original = preparation._suppress_active_artifacts

        def mutate_then_fail(*args, **kwargs):
            assert original(*args, **kwargs) == 1
            raise RuntimeError("owned sweep failure")

        monkeypatch.setattr(preparation, "_suppress_active_artifacts", mutate_then_fail)
        with pytest.raises(RuntimeError, match="owned sweep failure"):
            _sweep(conn, monkeypatch)
        assert not conn.in_transaction
        assert tuple(_stored_resume(conn)) == before
