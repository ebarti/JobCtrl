"""Private composite executor for stopped-runtime v6/v7/v8-to-v10 cutovers."""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from collections.abc import Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Final

from jobctrl.infrastructure.migrations.legacy_to_v9_execute import execute_legacy_to_v9_candidate
from jobctrl.infrastructure.migrations.v7_to_v8_execute import (
    CandidateExecutionResult,
    _fsync_directory,
)
from jobctrl.infrastructure.migrations.v8_to_v9_execute import (
    execute_v8_to_v9_candidate,
)

from jobctrl.infrastructure.migrations.v9_to_v10_execute import (
    execute_v9_to_v10_candidate,
    _remove_created_candidate,
    _source_file_state,
)

_GENERIC_FAILURE: Final = "legacy-to-v10 candidate migration failed"


class CandidateExecutionError(RuntimeError):
    """Raised when an isolated v10 candidate cannot be built from v6, v7 or v8."""


def execute_legacy_to_v10_candidate(
    source_path: Path | str,
    candidate_path: Path | str,
    *,
    source_version: int,
    migration_at: str | None = None,
) -> CandidateExecutionResult:
    """Build exact v9 privately, then transfer URLs into v10 without installation."""

    source = Path(source_path)
    candidate = Path(candidate_path)
    intermediate = _intermediate_candidate_path(candidate)
    result: CandidateExecutionResult | None = None
    intermediate_identity: tuple[int, int] | None = None
    candidate_identity: tuple[int, int] | None = None
    try:
        _assert_candidate_path(candidate)
        _assert_candidate_path(intermediate)
        source_files = _source_file_state(source)
        if source_version in (6, 7):
            execute_legacy_to_v9_candidate(
                source,
                intermediate,
                source_version=source_version,
                migration_at=migration_at,
            )
        elif source_version == 8 and migration_at is None:
            execute_v8_to_v9_candidate(source, intermediate)
        else:
            raise CandidateExecutionError(_GENERIC_FAILURE)
        info = intermediate.lstat()
        intermediate_identity = (info.st_dev, info.st_ino)
        result = execute_v9_to_v10_candidate(intermediate, candidate)
        info = candidate.lstat()
        candidate_identity = (info.st_dev, info.st_ino)
        _remove_created_candidate(intermediate, intermediate_identity)
        if intermediate.exists() or _source_file_state(source) != source_files:
            raise CandidateExecutionError(_GENERIC_FAILURE)
        _fsync_directory(candidate.parent)
        return result
    except BaseException as error:
        # A cleanup failure must not prevent removing the final candidate.
        for path, identity in ((intermediate, intermediate_identity), (candidate, candidate_identity)):
            if identity is not None:
                try:
                    _remove_created_candidate(path, identity)
                except OSError:
                    pass
        if isinstance(error, Exception):
            raise CandidateExecutionError(_GENERIC_FAILURE) from None
        raise


def _assert_candidate_path(candidate: Path) -> None:
    try:
        parent = candidate.parent.stat()
    except OSError:
        raise CandidateExecutionError(_GENERIC_FAILURE) from None
    if not stat.S_ISDIR(parent.st_mode):
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if os.path.lexists(candidate) or any(
        os.path.lexists(f"{candidate}{suffix}") for suffix in ("-journal", "-shm", "-wal")
    ):
        raise CandidateExecutionError(_GENERIC_FAILURE)


def _intermediate_candidate_path(candidate: Path) -> Path:
    return Path(f"{candidate}.exact-v9-intermediate")


def main(argv: Sequence[str] | None = None) -> int:
    """Run the authenticated launcher's private composite migration."""

    parser = _PrivateArgumentParser(add_help=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--source-version", required=True, type=int, choices=(6, 7, 8))
    parser.add_argument("--migration-at")
    try:
        arguments = parser.parse_args(argv)
        result = execute_legacy_to_v10_candidate(
            arguments.source,
            arguments.candidate,
            source_version=arguments.source_version,
            migration_at=arguments.migration_at,
        )
    except CandidateExecutionError:
        print(_GENERIC_FAILURE, file=sys.stderr)
        return 1
    print(json.dumps(asdict(result), sort_keys=True, separators=(",", ":")))
    return 0


class _PrivateArgumentParser(argparse.ArgumentParser):
    """Argument parser that never echoes private transition paths."""

    def error(self, _message: str) -> None:
        raise CandidateExecutionError(_GENERIC_FAILURE)


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "CandidateExecutionError",
    "execute_legacy_to_v10_candidate",
    "main",
]
