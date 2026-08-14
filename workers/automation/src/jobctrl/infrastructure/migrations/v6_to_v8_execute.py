"""Private file-to-file executor for the stopped-runtime v6-to-v8 cutover."""

from __future__ import annotations

import argparse
import json
import os
import stat
import sys
from collections.abc import Callable, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Final

from jobctrl.infrastructure.migrations.v6_to_v7_execute import (
    execute_v6_to_v7_candidate,
)
from jobctrl.infrastructure.migrations.v7_to_v8_execute import (
    CandidateExecutionResult,
    execute_v7_to_v8_candidate,
)

_GENERIC_FAILURE: Final = "v6-to-v8 candidate migration failed"


class CandidateExecutionError(RuntimeError):
    """Raised when an isolated v8 candidate cannot be built from v6."""


def execute_v6_to_v8_candidate(
    source_path: Path | str,
    candidate_path: Path | str,
    *,
    migration_at: str,
    job_id_factory: Callable[[], str] | None = None,
    _after_v8_stamp: Callable[[], None] | None = None,
) -> CandidateExecutionResult:
    """Build exact v7 privately, then add v8 without installing either file.

    The native lifecycle owns the source paired backup and final installation.
    The intermediate exact-v7 file lives in an owner-private directory beside
    the final candidate and is removed before this function returns.
    """

    source = Path(source_path)
    candidate = Path(candidate_path)
    intermediate = _intermediate_candidate_path(candidate)
    result: CandidateExecutionResult | None = None
    intermediate_ready = False
    try:
        _assert_candidate_path(candidate)
        _assert_candidate_path(intermediate)
        execute_v6_to_v7_candidate(
            source,
            intermediate,
            migration_at=migration_at,
            job_id_factory=job_id_factory,
        )
        intermediate_ready = True
        result = execute_v7_to_v8_candidate(
            intermediate,
            candidate,
            _after_stamp=_after_v8_stamp,
        )
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
    return Path(f"{candidate}.exact-v7-intermediate")


def _remove_candidate(candidate: Path, *, ignore_errors: bool = False) -> None:
    paths = (candidate, *(Path(f"{candidate}{suffix}") for suffix in ("-journal", "-shm", "-wal")))
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
    parser.add_argument("--migration-at", required=True)
    try:
        arguments = parser.parse_args(argv)
        result = execute_v6_to_v8_candidate(
            arguments.source,
            arguments.candidate,
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
    "execute_v6_to_v8_candidate",
    "main",
]
