"""File-boundary contracts for the private v6-to-v7 executor."""

from __future__ import annotations

import hashlib
import json
import sqlite3
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

from jobctrl.infrastructure.migrations.schema_manifest import (
    EXACT_V7_MANIFEST,
    assert_exact_manifest,
)
from jobctrl.infrastructure.migrations.v6_to_v7_execute import (
    CandidateExecutionError,
    execute_v6_to_v7_candidate,
    main,
)
from tests.v6_migration_fixture import (
    create_shipped_v6_database,
    create_supported_upgrade_history_v6_database,
)

_MIGRATION_AT = "2026-07-31T14:00:00+00:00"
_JOB_ID = "00000000-0000-4000-8000-000000000001"
_UNTRUSTED_ANALYSIS_CONTEXT = '{"userContext":"Attack vectors:\\nPrompt injection"}'


def _allocator(*values: str) -> Callable[[], str]:
    allocated: Iterator[str] = iter(values)
    return allocated.__next__


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.mark.parametrize("history", [False, True])
def test_executor_builds_a_closed_exact_v7_candidate_without_mutating_source(
    tmp_path: Path,
    history: bool,
) -> None:
    source = tmp_path / "paired-backup-jobctrl.db"
    candidate = tmp_path / "jobctrl.db.v7-candidate"
    create = create_supported_upgrade_history_v6_database if history else create_shipped_v6_database
    create(source)
    before = source.read_bytes()

    result = execute_v6_to_v7_candidate(
        source,
        candidate,
        migration_at=_MIGRATION_AT,
        job_id_factory=_allocator(_JOB_ID),
    )

    assert source.read_bytes() == before
    assert candidate.stat().st_mode & 0o777 == 0o600
    assert result.schema_version == 1
    assert result.status == "ready"
    assert result.user_version == 7
    assert result.job_count == 1
    assert result.candidate_sha256 == _sha256(candidate)
    assert len(result.source_digest) == 64
    assert len(result.candidate_logical_digest) == 64
    reopened = sqlite3.connect(candidate)
    try:
        assert tuple(reopened.execute("PRAGMA user_version").fetchone()) == (7,)
        assert_exact_manifest(reopened, EXACT_V7_MANIFEST)
        assert tuple(
            reopened.execute("SELECT job_id FROM jobs").fetchone()
        ) == (_JOB_ID,)
    finally:
        reopened.close()


@pytest.mark.parametrize(
    "case",
    ["same", "existing", "existing-sidecar", "source-symlink", "candidate-symlink"],
)
def test_executor_rejects_unsafe_path_shapes_without_mutating_source(
    tmp_path: Path,
    case: str,
) -> None:
    source = tmp_path / "source.db"
    candidate = tmp_path / "candidate.db"
    create_shipped_v6_database(source)
    before = source.read_bytes()
    if case == "same":
        candidate = source
    elif case == "existing":
        candidate.write_bytes(b"owned")
    elif case == "existing-sidecar":
        Path(f"{candidate}-wal").write_bytes(b"owned-sidecar")
    elif case == "source-symlink":
        real_source = source
        source = tmp_path / "source-link.db"
        source.symlink_to(real_source)
    else:
        candidate.symlink_to(tmp_path / "missing.db")

    with pytest.raises(CandidateExecutionError) as raised:
        execute_v6_to_v7_candidate(
            source,
            candidate,
            migration_at=_MIGRATION_AT,
        )

    assert str(raised.value) == "v6-to-v7 candidate execution failed"
    assert raised.value.__cause__ is None
    assert source.resolve().read_bytes() == before
    if case == "existing":
        assert candidate.read_bytes() == b"owned"
    if case == "existing-sidecar":
        assert Path(f"{candidate}-wal").read_bytes() == b"owned-sidecar"
    if case == "candidate-symlink":
        assert candidate.is_symlink()


def test_executor_rejects_unsupported_schema_and_cleans_its_candidate(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.db"
    candidate = tmp_path / "candidate.db"
    connection = sqlite3.connect(source)
    connection.execute("PRAGMA user_version = 5")
    connection.commit()
    connection.close()
    before = source.read_bytes()

    with pytest.raises(CandidateExecutionError):
        execute_v6_to_v7_candidate(
            source,
            candidate,
            migration_at=_MIGRATION_AT,
        )

    assert source.read_bytes() == before
    assert not candidate.exists()
    assert not Path(f"{candidate}-journal").exists()


def test_late_failure_cleans_candidate_leaves_source_unchanged_and_retries(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.db"
    candidate = tmp_path / "candidate.db"
    create_shipped_v6_database(source)
    before = source.read_bytes()

    with pytest.raises(CandidateExecutionError):
        execute_v6_to_v7_candidate(
            source,
            candidate,
            migration_at=_MIGRATION_AT,
            job_id_factory=_allocator(_JOB_ID),
            _after_stamp=lambda: (_ for _ in ()).throw(
                RuntimeError(f"{_UNTRUSTED_ANALYSIS_CONTEXT} private source text")
            ),
        )

    assert source.read_bytes() == before
    assert not candidate.exists()
    result = execute_v6_to_v7_candidate(
        source,
        candidate,
        migration_at=_MIGRATION_AT,
        job_id_factory=_allocator(_JOB_ID),
    )
    assert result.user_version == 7


def test_private_module_receipt_is_bounded_and_failure_is_sanitized(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    source = tmp_path / "source.db"
    candidate = tmp_path / "candidate.db"
    create_shipped_v6_database(source)
    connection = sqlite3.connect(source)
    connection.execute(
        "UPDATE jobs SET description = ?",
        (f"{_UNTRUSTED_ANALYSIS_CONTEXT} private source text",),
    )
    connection.commit()
    connection.close()

    assert main(
        [
            "--source",
            str(source),
            "--candidate",
            str(candidate),
            "--migration-at",
            _MIGRATION_AT,
        ]
    ) == 0
    captured = capsys.readouterr()
    receipt = json.loads(captured.out)
    assert captured.err == ""
    assert set(receipt) == {
        "candidate_logical_digest",
        "candidate_sha256",
        "job_count",
        "schema_version",
        "source_digest",
        "status",
        "table_count",
        "user_version",
    }
    assert str(source) not in captured.out
    assert str(candidate) not in captured.out
    assert "private source text" not in captured.out
    assert _UNTRUSTED_ANALYSIS_CONTEXT not in captured.out

    assert main(
        [
            "--source",
            str(source),
            "--candidate",
            str(candidate),
            "--migration-at",
            _MIGRATION_AT,
        ]
    ) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "v6-to-v7 candidate execution failed\n"
    assert str(source) not in captured.err
    assert str(candidate) not in captured.err
    assert _UNTRUSTED_ANALYSIS_CONTEXT not in captured.err


def test_private_module_argument_errors_do_not_echo_private_values(
    capsys: pytest.CaptureFixture[str],
) -> None:
    private_path = "/private/sensitive/jobctrl.db"

    assert main(["--source", private_path]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "v6-to-v7 candidate execution failed\n"
    assert private_path not in captured.err
