from __future__ import annotations

import hashlib
import json
import sqlite3
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V9_MANIFEST,
    EXACT_V10_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.schema_v9 import create_exact_v9_schema
from jobctrl.infrastructure.migrations.v9_to_v10_execute import (
    CandidateExecutionError,
    execute_v9_to_v10_candidate,
    main,
)

# Missing row, NULL, empty, conflicting, equal, shared and verbatim whitespace URLs.
_CASES = [
    ("local", "legacy", "legacy-url", None, False, "detail-time", "discovered-time"),
    ("local", "discovered", "other-url", None, False, "", "discovered-time"),
    ("local", "epoch", "epoch-url", None, False, None, None),
    ("local", "canonical", None, "canonical-url", True, None, None),
    ("local", "conflict", "old-url", "canonical-url", True, None, None),
    ("local", "null", "shared-url", None, True, None, None),
    ("local", "empty", "shared-url", "", True, None, None),
    ("local", "equal", "same-url", "same-url", True, None, None),
    ("local", "none", None, None, False, None, None),
    ("local", "blank", "", "", True, None, None),
    ("other", "legacy", "shared-url", "other-canonical", True, None, None),
    ("other", "verbatim", "  Mixed/%2f?b=2&a=1  ", None, False, None, None),
]


def _source(path: Path) -> None:
    with sqlite3.connect(path) as conn:
        create_exact_v9_schema(conn)
        conn.execute("PRAGMA foreign_keys=ON")
        for tenant, job, legacy, canonical, has_row, detail_at, discovered_at in _CASES:
            conn.execute(
                "INSERT INTO jobs(tenant_id,job_id,url,title,application_url,detail_scraped_at,discovered_at,apply_status) VALUES(?,?,?,?,?,?,?,?)",
                (tenant, job, f"https://post/{job}", "Synthetic title", legacy, detail_at, discovered_at, "pending"),
            )
            if has_row:
                conn.execute(
                    "INSERT INTO job_enrichments VALUES(?,?,'failed','retained body',?,'old-enriched','tier-original','[{\"error\":\"retained\"}]','updated-original')",
                    (tenant, job, canonical),
                )
        conn.execute(
            "INSERT INTO candidate_profiles(tenant_id,profile_id,updated_at,personal_full_name) VALUES('local','default','profile-time','Synthetic Person')"
        )
        conn.execute(
            "INSERT INTO candidate_profile_experience_entries(tenant_id,profile_id,entry_id,position_index,title,company,summary) VALUES('local','default','role',0,'Title','Synthetic','Preserve summary')"
        )
        conn.execute(
            "INSERT INTO job_events(event_id,tenant_id,job_id,identity_version,event_type,occurred_at,payload_json) VALUES(81,'local','legacy',7,'synthetic','event-time','{\"retained\":true}')"
        )
        conn.execute(
            "INSERT INTO job_events(event_id,tenant_id,identity_version,event_type,occurred_at) VALUES(100,'local',7,'deleted','time')"
        )
        conn.execute("DELETE FROM job_events WHERE event_id=100")
        conn.execute(
            "INSERT INTO job_artifacts(artifact_id,tenant_id,job_id,stage,artifact_type,path,created_at,metadata_json) VALUES(22,'local','legacy','tailor','resume','synthetic/path','artifact-time','{\"retained\":1}')"
        )
        conn.execute(
            "INSERT INTO job_list_projections(tenant_id,job_id,title,application_url,score_trace_json) VALUES('local','legacy','Projection title','historical-projection','{\"retain\":2}')"
        )


def test_full_transfer_preserves_all_other_columns_references_and_sequences(tmp_path: Path) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    before = source.read_bytes()
    result = execute_v9_to_v10_candidate(source, candidate)
    assert source.read_bytes() == before
    assert result.user_version == 10 and result.status == "ready"
    assert result.source_data_digest == result.candidate_data_digest
    assert result.candidate_sha256 == hashlib.sha256(candidate.read_bytes()).hexdigest()
    assert result.job_count == len(_CASES) and result.table_count == 118
    assert candidate.stat().st_mode & 0o777 == 0o600
    with sqlite3.connect(source) as old, sqlite3.connect(candidate) as new:
        assert_exact_manifest(old, EXACT_V9_MANIFEST)
        assert_exact_manifest(new, EXACT_V10_MANIFEST)
        # Independent expected policy, including exact lifecycle and all unspecified defaults.
        expected_aliases = set()
        for tenant, job, legacy, canonical, has_row, detail_at, discovered_at in _CASES:
            for value in (legacy, canonical):
                if value is not None and value != "":
                    expected_aliases.add((tenant, job, value))
            row = new.execute("SELECT * FROM job_enrichments WHERE tenant_id=? AND job_id=?", (tenant, job)).fetchone()
            if has_row:
                expected = list(
                    old.execute(
                        "SELECT * FROM job_enrichments WHERE tenant_id=? AND job_id=?", (tenant, job)
                    ).fetchone()
                )
                if canonical in (None, "") and legacy not in (None, ""):
                    expected[4] = legacy
                assert row == tuple(expected)
            elif legacy not in (None, ""):
                assert row == (
                    tenant,
                    job,
                    "pending",
                    None,
                    legacy,
                    None,
                    None,
                    "[]",
                    detail_at or discovered_at or "1970-01-01T00:00:00+00:00",
                )
            else:
                assert row is None
        assert set(new.execute("SELECT * FROM job_application_locators")) == expected_aliases
        tables = [
            r[0]
            for r in old.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_stat%'")
        ]
        for table in tables:
            if table == "job_enrichments":
                continue  # Every complete row checked above.
            columns = [
                r[1]
                for r in old.execute(f'PRAGMA table_info("{table}")')
                if not (table == "jobs" and r[1] == "application_url")
            ]
            selected = ",".join(f'"{c}"' for c in columns)
            sql = f'SELECT {selected} FROM "{table}" ORDER BY {selected}'
            assert old.execute(sql).fetchall() == new.execute(sql).fetchall(), table
        assert new.execute("PRAGMA foreign_key_check").fetchall() == []
        assert new.execute("PRAGMA integrity_check").fetchone() == ("ok",)
        new.execute("PRAGMA foreign_keys=ON")
        new.execute("DELETE FROM jobs WHERE tenant_id='local' AND job_id='legacy'")
        assert new.execute(
            "SELECT COUNT(*) FROM job_application_locators WHERE tenant_id='local' AND job_id='legacy'"
        ).fetchone() == (0,)
        assert (
            new.execute(
                "SELECT COUNT(*) FROM job_application_locators WHERE tenant_id='other' AND job_id='legacy'"
            ).fetchone()[0]
            > 0
        )


@pytest.mark.parametrize(
    "sql",
    [
        "UPDATE jobs SET title='corruption' WHERE job_id='legacy'",
        "DELETE FROM job_application_locators WHERE application_url='old-url'",
        "INSERT INTO job_application_locators VALUES('local','legacy','invented-url')",
        "UPDATE job_enrichments SET current_status='succeeded' WHERE job_id='epoch'",
        "UPDATE job_enrichments SET application_url='wrong' WHERE job_id='conflict'",
        "UPDATE job_enrichments SET attempts_json='[]' WHERE job_id='empty'",
        "UPDATE job_artifacts SET path='corrupted'",
        "UPDATE job_events SET payload_json='{}'",
        "UPDATE candidate_profiles SET personal_full_name='corrupted'",
        "UPDATE sqlite_sequence SET seq=999 WHERE name='job_events'",
        "DELETE FROM job_list_projections",
    ],
)
def test_expected_negative_corruption_is_rejected_and_owned_candidate_removed(tmp_path: Path, sql: str) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    before = source.read_bytes()

    def corrupt() -> None:
        with sqlite3.connect(candidate) as conn:
            conn.execute(sql)

    with pytest.raises(CandidateExecutionError, match="v9-to-v10 candidate migration failed"):
        execute_v9_to_v10_candidate(source, candidate, _after_stamp=corrupt)
    assert source.read_bytes() == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.db"]


@pytest.mark.parametrize("suffix", ["", "-wal", "-shm", "-journal"])
def test_existing_destination_or_sidecar_is_never_deleted(tmp_path: Path, suffix: str) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    protected = Path(f"{candidate}{suffix}")
    protected.write_bytes(b"preexisting")
    before = source.read_bytes()
    with pytest.raises(CandidateExecutionError):
        execute_v9_to_v10_candidate(source, candidate)
    assert protected.read_bytes() == b"preexisting"
    assert source.read_bytes() == before


def test_symlink_destination_is_preserved(tmp_path: Path) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    candidate.symlink_to(source)
    before = source.read_bytes()
    with pytest.raises(CandidateExecutionError):
        execute_v9_to_v10_candidate(source, candidate)
    assert candidate.is_symlink() and source.read_bytes() == before


def test_stamp_fault_and_malformed_source_fail_closed(tmp_path: Path) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    before = source.read_bytes()

    def fail() -> None:
        raise RuntimeError("synthetic crash")

    with pytest.raises(CandidateExecutionError):
        execute_v9_to_v10_candidate(source, candidate, _after_stamp=fail)
    assert not candidate.exists() and source.read_bytes() == before
    with sqlite3.connect(source) as conn:
        conn.execute("CREATE TABLE injected(value TEXT)")
    before = source.read_bytes()
    with pytest.raises(CandidateExecutionError):
        execute_v9_to_v10_candidate(source, candidate)
    assert not candidate.exists() and source.read_bytes() == before


def test_private_cli_has_bounded_receipt_and_generic_errors(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    assert main(["--source", str(source), "--candidate", str(candidate)]) == 0
    receipt = json.loads(capsys.readouterr().out)
    assert receipt["user_version"] == 10 and len(receipt) == 8
    assert main(["--source", str(source), "--candidate", str(candidate)]) == 1
    assert capsys.readouterr().err == "v9-to-v10 candidate migration failed\n"


@pytest.mark.parametrize("operation", ["_fsync_regular_file", "_fsync_directory"])
def test_fsync_failure_rejects_and_removes_candidate(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    from jobctrl.infrastructure.migrations import v9_to_v10_execute as migration

    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    before = source.read_bytes()

    def fail(_path: Path) -> None:
        raise OSError("synthetic fsync failure")

    monkeypatch.setattr(migration, operation, fail)
    with pytest.raises(CandidateExecutionError):
        execute_v9_to_v10_candidate(source, candidate)
    assert source.read_bytes() == before
    assert sorted(p.name for p in tmp_path.iterdir()) == ["source.db"]


def test_external_source_legacy_url_change_cannot_pass_retained_digest(tmp_path: Path) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)

    def mutate_source() -> None:
        with sqlite3.connect(source) as conn:
            conn.execute("UPDATE jobs SET application_url='external-change' WHERE job_id='legacy'")

    with pytest.raises(CandidateExecutionError):
        execute_v9_to_v10_candidate(source, candidate, _after_stamp=mutate_source)
    assert not candidate.exists()
    # Only the deliberately injected external mutation persists; v9 stays usable.
    with sqlite3.connect(source) as conn:
        assert_exact_manifest(conn, EXACT_V9_MANIFEST)
        assert conn.execute(
            "SELECT application_url FROM jobs WHERE tenant_id='local' AND job_id='legacy'"
        ).fetchone() == ("external-change",)


def test_replaced_candidate_and_its_sidecars_are_not_removed(tmp_path: Path) -> None:
    source, candidate = tmp_path / "source.db", tmp_path / "candidate.db"
    _source(source)
    before = source.read_bytes()

    def replace() -> None:
        candidate.rename(tmp_path / "owned-displaced.db")
        candidate.write_bytes(b"other owner")
        Path(f"{candidate}-wal").write_bytes(b"other owner sidecar")

    with pytest.raises(CandidateExecutionError):
        execute_v9_to_v10_candidate(source, candidate, _after_stamp=replace)
    assert source.read_bytes() == before
    assert candidate.read_bytes() == b"other owner"
    assert Path(f"{candidate}-wal").read_bytes() == b"other owner sidecar"
