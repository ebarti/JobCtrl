"""Private file-to-file executor for the stopped-runtime v6-to-v7 cutover."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import stat
import sys
from collections.abc import Callable, Sequence
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Final, Literal

from jobctrl.database import close_connection, open_exact_v7_database
from jobctrl.infrastructure.migrations.schema_manifest import EXACT_V7_MANIFEST
from jobctrl.infrastructure.migrations.v6_to_v7_candidate import (
    populate_v7_candidate,
)
from jobctrl.infrastructure.migrations.v6_to_v7_verify import (
    verify_and_stamp_v7_candidate,
)

_RESULT_SCHEMA_VERSION: Final = 1
_GENERIC_FAILURE: Final = "v6-to-v7 candidate execution failed"


class CandidateExecutionError(RuntimeError):
    """Raised when a sealed v7 candidate cannot be produced safely."""


@dataclass(frozen=True)
class CandidateExecutionResult:
    """Bounded receipt for one closed and fsynced exact-v7 candidate."""

    schema_version: Literal[1]
    status: Literal["ready"]
    user_version: Literal[7]
    source_digest: str
    candidate_logical_digest: str
    candidate_sha256: str
    job_count: int
    table_count: int


def execute_v6_to_v7_candidate(
    source_path: Path | str,
    candidate_path: Path | str,
    *,
    migration_at: str,
    job_id_factory: Callable[[], str] | None = None,
    _after_stamp: Callable[[], None] | None = None,
) -> CandidateExecutionResult:
    """Build an exact-v7 file from a standalone v6 paired-backup member.

    This function never replaces the live database. The authenticated native
    lifecycle owns quiescence, paired backup verification, installation, and
    rollback.
    """

    source = Path(source_path)
    candidate = Path(candidate_path)
    source_connection: sqlite3.Connection | None = None
    candidate_connection: sqlite3.Connection | None = None
    created_identity: tuple[int, int] | None = None
    try:
        _assert_paths(source, candidate)
        descriptor = os.open(
            candidate,
            os.O_CREAT | os.O_EXCL | os.O_WRONLY,
            0o600,
        )
        try:
            os.fchmod(descriptor, 0o600)
            created = os.fstat(descriptor)
            created_identity = (created.st_dev, created.st_ino)
        finally:
            os.close(descriptor)

        source_connection = sqlite3.connect(
            f"{source.resolve().as_uri()}?mode=ro",
            uri=True,
        )
        source_connection.execute("PRAGMA foreign_keys = ON")
        candidate_connection = sqlite3.connect(candidate)
        candidate_connection.execute("PRAGMA foreign_keys = ON")

        population = populate_v7_candidate(
            source_connection,
            candidate_connection,
            migration_at=migration_at,
            job_id_factory=job_id_factory,
        )
        verification = verify_and_stamp_v7_candidate(
            source_connection,
            candidate_connection,
            population,
            _after_stamp=_after_stamp,
        )
        candidate_connection.commit()
        candidate_connection.close()
        candidate_connection = None
        source_connection.close()
        source_connection = None

        reopened = open_exact_v7_database(candidate)
        try:
            if int(reopened.execute("PRAGMA user_version").fetchone()[0]) != EXACT_V7_MANIFEST.version:
                raise CandidateExecutionError(_GENERIC_FAILURE)
        finally:
            close_connection(candidate)

        _fsync_regular_file(candidate)
        _fsync_directory(candidate.parent)
        return CandidateExecutionResult(
            schema_version=_RESULT_SCHEMA_VERSION,
            status="ready",
            user_version=EXACT_V7_MANIFEST.version,
            source_digest=population.source_digest,
            candidate_logical_digest=population.candidate_digest,
            candidate_sha256=_sha256_file(candidate),
            job_count=verification.job_count,
            table_count=EXACT_V7_MANIFEST.table_count,
        )
    except BaseException as error:
        if candidate_connection is not None:
            candidate_connection.close()
        if source_connection is not None:
            source_connection.close()
        close_connection(candidate)
        if created_identity is not None:
            _remove_created_candidate(candidate, created_identity)
        if isinstance(error, Exception):
            raise CandidateExecutionError(_GENERIC_FAILURE) from None
        raise


def _assert_paths(source: Path, candidate: Path) -> None:
    source_stat = source.lstat()
    if not stat.S_ISREG(source_stat.st_mode):
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if os.path.abspath(source) == os.path.abspath(candidate):
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if os.path.lexists(candidate):
        raise CandidateExecutionError(_GENERIC_FAILURE)
    if any(os.path.lexists(f"{candidate}{suffix}") for suffix in ("-journal", "-shm", "-wal")):
        raise CandidateExecutionError(_GENERIC_FAILURE)
    parent_stat = candidate.parent.stat()
    if not stat.S_ISDIR(parent_stat.st_mode):
        raise CandidateExecutionError(_GENERIC_FAILURE)


def _remove_created_candidate(
    candidate: Path,
    created_identity: tuple[int, int],
) -> None:
    try:
        current = candidate.lstat()
    except FileNotFoundError:
        current = None
    if current is not None and (current.st_dev, current.st_ino) == created_identity:
        candidate.unlink()
    for suffix in ("-journal", "-shm", "-wal"):
        Path(f"{candidate}{suffix}").unlink(missing_ok=True)


def _fsync_regular_file(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            raise CandidateExecutionError(_GENERIC_FAILURE)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main(argv: Sequence[str] | None = None) -> int:
    """Run the authenticated launcher's private migration subprocess."""

    parser = _PrivateArgumentParser(add_help=False)
    parser.add_argument("--source", required=True)
    parser.add_argument("--candidate", required=True)
    parser.add_argument("--migration-at", required=True)
    try:
        arguments = parser.parse_args(argv)
        result = execute_v6_to_v7_candidate(
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
    """Arg parser that never echoes private transition arguments."""

    def error(self, _message: str) -> None:
        raise CandidateExecutionError(_GENERIC_FAILURE)


if __name__ == "__main__":
    raise SystemExit(main())


__all__ = [
    "CandidateExecutionError",
    "CandidateExecutionResult",
    "execute_v6_to_v7_candidate",
    "main",
]
