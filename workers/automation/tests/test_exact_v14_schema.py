"""Native cutover preserves authored data and captured postings, without inference."""

import json
import sqlite3

import pytest

from jobctrl.domain.determinations import DeterminationEnvelope
from jobctrl.infrastructure.determinations import SqliteDeterminationRepository
from jobctrl.infrastructure.migrations.schema_manifest import EXACT_V14_MANIFEST, assert_exact_manifest
from jobctrl.infrastructure.migrations.schema_v13 import create_exact_v13_schema
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
from jobctrl.infrastructure.migrations.v13_to_v14_execute import CandidateExecutionError, execute_v13_to_v14_candidate
from jobctrl.infrastructure.migrations.v14_activation import SourceChangedError, activate, bind_source


def source_database(path):
    conn = sqlite3.connect(path)
    create_exact_v13_schema(conn)
    conn.execute(
        "INSERT INTO candidate_profiles(tenant_id,profile_id,version,experience_target_role,updated_at) VALUES('local','default',7,'Saved authored target','2026-10-07')"
    )
    repository = SqliteDeterminationRepository(conn)
    for ident, kind in (("a" * 64, "search_preferences"), ("b" * 64, "posting_triage")):
        repository.save(
            DeterminationEnvelope(
                determination_id=ident,
                tenant_id="local",
                entity_id="owned",
                kind=kind,
                schema_version="1",
                prompt_version="old-owned-contract",
                provider="synthetic",
                model="synthetic",
                lane="discovery",
                input_fingerprint=ident,
                created_at="2026-10-07",
                result={"verdict": "explicit old model decision"},
            )
        )
    listing = dict(
        listing_id="owned-listing",
        source_id="owned-board",
        url="https://example.test/owned",
        title="Synthetic title",
        company="Synthetic employer",
        location="Synthetic location",
        remote=None,
    )
    posting = json.dumps({"owned_raw_capture": "Preserve this exact stored payload"})
    conn.execute(
        "INSERT INTO posting_triage(tenant_id,listing_id,snapshot_fingerprint,target_fingerprint,source_id,listing_json,posting_json,status,reason_code,preferences_determination_id,determination_id,created_at) VALUES('local',?,?,?,?,?,?,'admit','compatible',?,?,?)",
        (
            listing["listing_id"],
            "c" * 64,
            "d" * 64,
            listing["source_id"],
            json.dumps(listing),
            posting,
            "a" * 64,
            "b" * 64,
            "2026-10-07",
        ),
    )
    conn.commit()
    before = conn.execute("SELECT * FROM candidate_profiles").fetchall()
    history = conn.execute("SELECT * FROM semantic_determinations ORDER BY determination_id").fetchall()
    conn.close()
    return listing, posting, before, history


def test_exact_v14_fresh_creation_matches_runtime_manifest():
    conn = sqlite3.connect(":memory:")
    create_exact_v14_schema(conn)
    assert_exact_manifest(conn, EXACT_V14_MANIFEST)
    conn.close()


def test_native_cutover_preserves_authored_cells_history_and_unconsumed_capture(tmp_path):
    source, candidate, live, receipt = (
        tmp_path / name for name in ("source.db", "candidate.db", "live.db", "binding.json")
    )
    listing, posting, profile, history = source_database(source)
    original = source.read_bytes()
    accepted = tmp_path / "accepted-material.txt"
    accepted.write_bytes(b"Owned accepted artifact bytes")
    result = execute_v13_to_v14_candidate(source, candidate)
    assert result.user_version == 14 and source.read_bytes() == original
    live.write_bytes(original)
    bind_source(source, live, candidate, receipt)
    activate(live, candidate, receipt)
    conn = sqlite3.connect(live)
    assert_exact_manifest(conn, EXACT_V14_MANIFEST)
    assert conn.execute("SELECT * FROM candidate_profiles").fetchall() == profile
    assert conn.execute("SELECT * FROM semantic_determinations ORDER BY determination_id").fetchall() == history
    row = conn.execute(
        "SELECT listing_json,posting_json,status,consumed_at,determination_id FROM posting_triage"
    ).fetchone()
    snapshot = json.loads(row[0])
    assert snapshot == {"listing": listing, "target_sources": [], "profile_version": None}
    assert row[1:] == (posting, "superseded", None, None)
    assert accepted.read_bytes() == b"Owned accepted artifact bytes"
    assert source.read_bytes() == original
    conn.close()


def test_invalid_candidate_and_source_drift_fail_without_overwriting(tmp_path):
    source, candidate, live, receipt = (
        tmp_path / name for name in ("source.db", "candidate.db", "live.db", "binding.json")
    )
    source_database(source)
    original = source.read_bytes()

    def corrupt_candidate():
        conn = sqlite3.connect(candidate)
        conn.execute("UPDATE candidate_profiles SET experience_target_role='Unexpected candidate mutation'")
        conn.commit()
        conn.close()

    with pytest.raises(CandidateExecutionError):
        execute_v13_to_v14_candidate(source, candidate, _after_stamp=corrupt_candidate)
    assert source.read_bytes() == original and not candidate.exists()
    execute_v13_to_v14_candidate(source, candidate)
    live.write_bytes(original)
    bind_source(source, live, candidate, receipt)
    conn = sqlite3.connect(live)
    conn.execute("UPDATE candidate_profiles SET experience_target_role='Later owner save'")
    conn.commit()
    conn.close()
    changed = live.read_bytes()
    with pytest.raises(SourceChangedError):
        activate(live, candidate, receipt)
    assert live.read_bytes() == changed and candidate.exists()
