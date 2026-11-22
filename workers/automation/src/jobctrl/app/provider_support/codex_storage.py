"""Shared temporary provider state, protected by a process-owned OS lease.

Native clients import retained rollout metadata when opening a new SQLite home.
Clients in one process therefore share one temporary store per credential home.
The last client removes it after shutting down; a later process may reclaim an
abandoned store only after acquiring its otherwise exclusive owner lease.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import stat
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

_PREFIX = "jobctrl-codex-state-"
_MARKER = "owner.json"
_LEASE = "owner.lock"
_GUARD = threading.RLock()
_LOG = logging.getLogger(__name__)


def _private(path: Path, *, directory: bool) -> None:
    info = path.lstat()
    redirected = stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )
    expected = stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode)
    if redirected or not expected:
        raise ValueError("Provider storage must not redirect through a link or reparse point")
    if not directory and info.st_nlink != 1:
        raise ValueError("Provider lease and ownership records must not have other links")
    if os.name != "nt" and (
        info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != (0o700 if directory else 0o600)
    ):
        raise ValueError("Provider storage must be private to its owner")


def _lock(path: Path, *, create: bool = False) -> int:
    if not create:
        _private(path, directory=False)
    flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    if create:
        flags |= os.O_CREAT | os.O_EXCL
    descriptor = os.open(path, flags, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("Provider lease must be a regular single-link file")
        if create:
            os.write(descriptor, b"\0")
        os.lseek(descriptor, 0, os.SEEK_SET)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _owned(root: Path, home: Path) -> None:
    _private(root, directory=True)
    _private(root / _MARKER, directory=False)
    if (root / _MARKER).stat().st_size > 4096:
        raise ValueError("Provider ownership record is oversized")
    marker = json.loads((root / _MARKER).read_text(encoding="utf-8"))
    if marker != {"schemaVersion": 1, "providerHome": str(home)}:
        raise ValueError("Provider storage belongs to another home or version")
    if not {entry.name for entry in root.iterdir()} <= {_MARKER, _LEASE, "sqlite"}:
        raise ValueError("Provider storage contains unfamiliar files")
    if (root / "sqlite").exists() or (root / "sqlite").is_symlink():
        _private(root / "sqlite", directory=True)


def _remove(root: Path, descriptor: int) -> None:
    # Windows cannot unlink the open lease. The random directory is never reused;
    # competing stale-store reclaimers may only remove the same owned tree.
    if os.name == "nt":
        os.close(descriptor)
        shutil.rmtree(root, ignore_errors=False)
    else:
        try:
            shutil.rmtree(root)
        finally:
            os.close(descriptor)


def _reap_stale_storage(home: Path) -> None:
    for root in Path(tempfile.gettempdir()).glob(f"{_PREFIX}*"):
        descriptor = None
        try:
            _owned(root, home)
            descriptor = _lock(root / _LEASE)
            _owned(root, home)
        except (OSError, ValueError):
            if descriptor is not None:
                os.close(descriptor)
            continue
        try:
            _remove(root, descriptor)
        except FileNotFoundError:
            pass
        except OSError:
            _LOG.warning("Could not reclaim abandoned provider storage %s", root, exc_info=True)


@dataclass
class _Store:
    root: Path
    descriptor: int
    references: int = 0


_STORES: dict[tuple[int, Path], _Store] = {}


def _create(home: Path) -> _Store:
    _reap_stale_storage(home)
    root = Path(tempfile.mkdtemp(prefix=_PREFIX)).resolve()
    descriptor = None
    try:
        descriptor = _lock(root / _LEASE, create=True)
        marker_fd = os.open(root / _MARKER, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(marker_fd, "w", encoding="utf-8") as stream:
            json.dump({"schemaVersion": 1, "providerHome": str(home)}, stream)
        (root / "sqlite").mkdir(mode=0o700)
        return _Store(root, descriptor)
    except BaseException:
        if descriptor is not None:
            os.close(descriptor)
        shutil.rmtree(root)
        raise


@contextmanager
def shared_codex_storage(codex_home: Path) -> Iterator[Path]:
    """Lease temporary state until the last native client has fully closed."""
    home = codex_home.resolve(strict=True)
    key = (os.getpid(), home)
    with _GUARD:
        store = _STORES.get(key)
        if store is None:
            store = _create(home)
            _STORES[key] = store
        store.references += 1
    try:
        yield store.root / "sqlite"
    finally:
        with _GUARD:
            store.references -= 1
            if store.references == 0:
                del _STORES[key]
                _remove(store.root, store.descriptor)
