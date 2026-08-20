"""Private composite executor for stopped-runtime v6/v7-to-v9 cutovers."""

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

from jobctrl.infrastructure.migrations.v6_to_v8_execute import (
    execute_v6_to_v8_candidate,
)
from jobctrl.infrastructure.migrations.v7_to_v8_execute import (
    CandidateExecutionResult,
    execute_v7_to_v8_candidate,
)
from jobctrl.infrastructure.migrations.v8_to_v9_execute import (
    execute_v8_to_v9_candidate,
)

_GENERIC_FAILURE: Final = "legacy-to-v9 candidate migration failed"


class CandidateExecutionError(RuntimeError):
    """Raised when an isolated v9 candidate cannot be built from v6 or v7."""


def execute_legacy_to_v9_candidate(
    source_path: Path | str,
    candidate_path: Path | str,
    *,
    source_version: int,
    migration_at: str | None = None,
) -> CandidateExecutionResult:
    """Build exact v8 privately, then add v9 without installing either file."""

    source = Path(source_path)
    candidate = Path(candidate_path)
    intermediate = _intermediate_candidate_path(candidate)
    result: CandidateExecutionResult | None = None
    intermediate_ready = False
    try:
        _assert_candidate_path(candidate)
        _assert_candidate_path(intermediate)
        if source_version == 6:
            if not migration_at:
                raise CandidateExecutionError(_GENERIC_FAILURE)
            execute_v6_to_v8_candidate(
                source,
                intermediate,
                migration_at=migration_at,
            )
        elif source_version == 7:
            if migration_at is not None:
                raise CandidateExecutionError(_GENERIC_FAILURE)
            execute_v7_to_v8_candidate(source, intermediate)
        else:
            raise CandidateExecutionError(_GENERIC_FAILURE)
        intermediate_ready = True
        result = execute_v8_to_v9_candidate(intermediate, candidate)
        try:
            _remove_candidate(intermediate)
        except OSError:
            _remove_candidate(candidate, ignore_errors=True)
            raise CandidateExecutionError(_GENERIC_FAILURE) from None
        return result
    except BaseException as error:
        if intermediate_ready:
            _remove_candidate(intermediate, ignore_errors=True)
        if result is not None:
            _remove_candidate(candidate, ignore_errors=True)
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
        os.path.lexists(f"{candidate}{suffix}")
        for suffix in ("-journal", "-shm", "-wal")
    ):
        raise CandidateExecutionError(_GENERIC_FAILURE)


def _intermediate_candidate_path(candidate: Path) -> Path:
    return Path(f"{candidate}.exact-v8-intermediate")


def _remove_candidate(candidate: Path, *, ignore_errors: bool = False) -> None:
    paths = (
        candidate,
        *(Path(f"{candidate}{suffix}") for suffix in ("-journal", "-shm", "-wal")),
        Path(f"{candidate}.exact-v7-intermediate"),
    )
    for path in paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            if not ignore_errors:
                raise


def main(argv: Sequence[str] | None = None) -> int:
    """Run the authenticated launcher's private composite migration."""

    parser = _PrivateArgumentParser(add_help=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--source-version", required=True, type=int, choices=(6, 7))
    parser.add_argument("--migration-at")
    try:
        arguments = parser.parse_args(argv)
        result = execute_legacy_to_v9_candidate(
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
    "execute_legacy_to_v9_candidate",
    "main",
]
