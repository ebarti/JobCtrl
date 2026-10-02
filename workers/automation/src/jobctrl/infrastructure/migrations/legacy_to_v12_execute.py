"""Composite stopped-runtime migration from exact v6-v11 to exact v12."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections.abc import Sequence
from dataclasses import asdict
from pathlib import Path

from jobctrl.infrastructure.migrations.legacy_to_v11_execute import execute_legacy_to_v11_candidate
from jobctrl.infrastructure.migrations.v9_to_v10_execute import (
    _remove_created_candidate,
    _source_file_state,
)
from jobctrl.infrastructure.migrations.v11_to_v12_execute import (
    CandidateExecutionError,
    execute_v11_to_v12_candidate,
)
from jobctrl.infrastructure.migrations.v7_to_v8_execute import CandidateExecutionResult, _assert_paths, _fsync_directory


def execute_legacy_to_v12_candidate(
    source_path: Path | str,
    candidate_path: Path | str,
    *,
    source_version: int,
    migration_at: str | None = None,
) -> CandidateExecutionResult:
    """Build an exact-v11 intermediate and then the verified exact-v12 candidate."""
    source = Path(source_path)
    candidate = Path(candidate_path)
    if source_version == 11:
        return execute_v11_to_v12_candidate(source, candidate)
    intermediate = Path(f"{candidate}.exact-v11-intermediate")
    identity: tuple[int, int] | None = None
    candidate_identity: tuple[int, int] | None = None
    source_lock: sqlite3.Connection | None = None
    try:
        _assert_paths(source, candidate)
        source_files = _source_file_state(source)
        source_lock = sqlite3.connect(f"{source.resolve().as_uri()}?mode=rw", uri=True, timeout=0)
        source_lock.execute("BEGIN IMMEDIATE")
        if source_version in (6, 7, 8, 9, 10):
            execute_legacy_to_v11_candidate(
                source,
                intermediate,
                source_version=source_version,
                migration_at=migration_at,
            )
        else:
            raise CandidateExecutionError("legacy-to-v12 candidate migration failed")
        info = intermediate.lstat()
        identity = (info.st_dev, info.st_ino)
        result = execute_v11_to_v12_candidate(intermediate, candidate)
        info = candidate.lstat()
        candidate_identity = (info.st_dev, info.st_ino)
        _remove_created_candidate(intermediate, identity)
        source_lock.rollback()
        source_lock.close()
        source_lock = None
        if os.path.lexists(intermediate) or _source_file_state(source) != source_files:
            raise CandidateExecutionError("legacy-to-v12 candidate migration failed")
        _fsync_directory(candidate.parent)
        return result
    except BaseException as error:
        if source_lock is not None:
            source_lock.rollback()
            source_lock.close()
        if candidate_identity is not None:
            _remove_created_candidate(candidate, candidate_identity)
        if identity is not None:
            try:
                _remove_created_candidate(intermediate, identity)
            except OSError:
                pass
        if isinstance(error, Exception):
            raise CandidateExecutionError("legacy-to-v12 candidate migration failed") from None
        raise


def main(argv: Sequence[str] | None = None) -> int:
    """Run the launcher's private composite migration without leaking paths."""
    parser = _PrivateArgumentParser(add_help=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--source-version", required=True, type=int, choices=(6, 7, 8, 9, 10, 11))
    parser.add_argument("--migration-at")
    try:
        arguments = parser.parse_args(argv)
        result = execute_legacy_to_v12_candidate(
            arguments.source,
            arguments.candidate,
            source_version=arguments.source_version,
            migration_at=arguments.migration_at,
        )
    except CandidateExecutionError:
        print("legacy-to-v12 candidate migration failed", file=sys.stderr)
        return 1
    print(json.dumps(asdict(result), sort_keys=True, separators=(",", ":")))
    return 0


class _PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        raise CandidateExecutionError("legacy-to-v12 candidate migration failed")


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = ["execute_legacy_to_v12_candidate", "main"]
