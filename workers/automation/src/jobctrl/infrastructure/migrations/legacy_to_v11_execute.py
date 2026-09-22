"""Composite stopped-runtime migration from exact v6-v10 to exact v11."""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Sequence
from dataclasses import asdict
from pathlib import Path

from jobctrl.infrastructure.migrations.legacy_to_v10_execute import execute_legacy_to_v10_candidate
from jobctrl.infrastructure.migrations.v9_to_v10_execute import (
    _remove_created_candidate,
    _source_file_state,
    execute_v9_to_v10_candidate,
)
from jobctrl.infrastructure.migrations.v10_to_v11_execute import (
    CandidateExecutionError,
    execute_v10_to_v11_candidate,
)
from jobctrl.infrastructure.migrations.v7_to_v8_execute import CandidateExecutionResult, _fsync_directory


def execute_legacy_to_v11_candidate(
    source_path: Path | str,
    candidate_path: Path | str,
    *,
    source_version: int,
    migration_at: str | None = None,
) -> CandidateExecutionResult:
    """Build an exact-v10 intermediate and then the verified exact-v11 candidate."""
    source = Path(source_path)
    candidate = Path(candidate_path)
    if source_version == 10:
        return execute_v10_to_v11_candidate(source, candidate)
    intermediate = Path(f"{candidate}.exact-v10-intermediate")
    identity: tuple[int, int] | None = None
    try:
        source_files = _source_file_state(source)
        if source_version in (6, 7, 8):
            execute_legacy_to_v10_candidate(
                source,
                intermediate,
                source_version=source_version,
                migration_at=migration_at,
            )
        elif source_version == 9 and migration_at is None:
            execute_v9_to_v10_candidate(source, intermediate)
        else:
            raise CandidateExecutionError("legacy-to-v11 candidate migration failed")
        info = intermediate.lstat()
        identity = (info.st_dev, info.st_ino)
        result = execute_v10_to_v11_candidate(intermediate, candidate)
        _remove_created_candidate(intermediate, identity)
        if os.path.lexists(intermediate) or _source_file_state(source) != source_files:
            raise CandidateExecutionError("legacy-to-v11 candidate migration failed")
        _fsync_directory(candidate.parent)
        return result
    except BaseException as error:
        if identity is not None:
            try:
                _remove_created_candidate(intermediate, identity)
            except OSError:
                pass
        if isinstance(error, Exception):
            raise CandidateExecutionError("legacy-to-v11 candidate migration failed") from None
        raise


def main(argv: Sequence[str] | None = None) -> int:
    """Run the launcher's private composite migration without leaking paths."""
    parser = _PrivateArgumentParser(add_help=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--source-version", required=True, type=int, choices=(6, 7, 8, 9, 10))
    parser.add_argument("--migration-at")
    try:
        arguments = parser.parse_args(argv)
        result = execute_legacy_to_v11_candidate(
            arguments.source,
            arguments.candidate,
            source_version=arguments.source_version,
            migration_at=arguments.migration_at,
        )
    except CandidateExecutionError:
        print("legacy-to-v11 candidate migration failed", file=sys.stderr)
        return 1
    print(json.dumps(asdict(result), sort_keys=True, separators=(",", ":")))
    return 0


class _PrivateArgumentParser(argparse.ArgumentParser):
    def error(self, _message: str) -> None:
        raise CandidateExecutionError("legacy-to-v11 candidate migration failed")


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = ["execute_legacy_to_v11_candidate", "main"]
