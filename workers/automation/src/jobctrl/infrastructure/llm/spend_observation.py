"""Fail-closed receipts for observations whose ledger commit is uncertain.

The SQLite ledger remains the spend authority. A private, locked receipt is
created before provider work and removed only after a confirmed ledger write
or an orderly exit without observed usage. A receipt left by an interrupted or
failed write is *not* replayed: the additive ledger cannot identify an already
committed observation.
"""

from __future__ import annotations

import errno
import json
import os
import stat
import uuid
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Iterator


class SpendAccountingUnresolved(RuntimeError):
    """Observed spend cannot be reported as a complete total or safely retried."""


def _directory() -> Path:
    from jobctrl.database import DB_PATH

    path = Path(DB_PATH)
    return path.parent / f".{path.name}.llm-spend-pending"


def _sync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _lock(fd: int, *, blocking: bool) -> None:
    if os.name == "nt":
        import msvcrt

        os.lseek(fd, 0, os.SEEK_SET)
        msvcrt.locking(fd, msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
    else:
        import fcntl

        fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))


def _open_file(path: Path, *, create: bool = False, exclusive: bool = False) -> int:
    flags = os.O_RDWR | getattr(os, "O_NOFOLLOW", 0)
    if create:
        flags |= os.O_CREAT
    if exclusive:
        flags |= os.O_EXCL
    fd = os.open(path, flags, 0o600)
    try:
        info = os.fstat(fd)
        entry = path.lstat()
        if (
            not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
            or not stat.S_ISREG(entry.st_mode) or (info.st_dev, info.st_ino) != (entry.st_dev, entry.st_ino)
        ):
            raise SpendAccountingUnresolved("LLM spend receipt is not a private regular file.")
        return fd
    except BaseException:
        os.close(fd)
        raise


def _ensure_directory() -> Path:
    root = _directory()
    try:
        root.mkdir(mode=0o700)
        _sync_directory(root.parent)
    except FileExistsError:
        pass
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or (os.name != "nt" and (
        info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077
    )):
        raise SpendAccountingUnresolved("LLM spend receipt directory is not private.")
    return root


@contextmanager
def _gate(root: Path) -> Iterator[None]:
    fd = _open_file(root / "lock", create=True)
    try:
        if os.fstat(fd).st_size == 0:
            os.write(fd, b"\0")
            os.fsync(fd)
        _lock(fd, blocking=True)
        yield
    finally:
        os.close(fd)


def _append(fd: int, value: dict) -> None:
    data = (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode()
    os.lseek(fd, 0, os.SEEK_END)
    while data:
        written = os.write(fd, data)
        if written <= 0:
            raise OSError("Could not write LLM spend receipt")
        data = data[written:]
    os.fsync(fd)


def _require_resolved_locked(root: Path) -> None:
    """Check peers while holding the same gate used to publish receipts."""
    try:
        for path in root.iterdir():
            if path.name == "lock":
                continue
            fd = _open_file(path)
            try:
                try:
                    _lock(fd, blocking=False)
                except OSError as error:
                    if error.errno in {errno.EACCES, errno.EAGAIN, errno.EDEADLK}:
                        continue
                    raise
                raise SpendAccountingUnresolved(
                    "LLM spend accounting is unresolved; inspect the retained receipt before further model calls."
                )
            finally:
                os.close(fd)
    except SpendAccountingUnresolved:
        raise
    except OSError as error:
        raise SpendAccountingUnresolved("Could not verify LLM spend accounting.") from error


class SpendObservation:
    def __init__(self, *, day: str, lane: str, provider: str | None, model: str) -> None:
        root = _ensure_directory()
        path = root / f"{uuid.uuid4().hex}.jsonl"
        fd = -1
        with _gate(root):
            _require_resolved_locked(root)
            try:
                fd = _open_file(path, create=True, exclusive=True)
                if os.name == "nt":
                    # The CRT locks an existing byte; JSON accepts this prefix.
                    os.write(fd, b" ")
                _lock(fd, blocking=False)
                _append(fd, {"version": 1, "day": day, "lane": lane, "provider": provider, "model": model})
                _sync_directory(root)
            except BaseException:
                if fd >= 0:
                    os.close(fd)
                try:
                    path.unlink(missing_ok=True)
                    _sync_directory(root)
                except OSError:
                    pass
                raise
        self._root, self._path, self._fd = root, path, fd

    def observed(self, *, day: str, input_tokens: int | None, output_tokens: int | None,
                 estimated_usd: float | None = None) -> None:
        _append(self._fd, {"day": day, "input_tokens": input_tokens, "output_tokens": output_tokens,
                          "estimated_usd": estimated_usd})

    def ambiguous(self, reports: list[dict], *, day: str) -> None:
        _append(self._fd, {"day": day, "ambiguous_reports": reports})

    def close(self, *, unresolved: bool) -> None:
        fd = self._fd
        try:
            with _gate(self._root):
                if unresolved:
                    # Release the peer lock before releasing the gate. A new
                    # receipt must never see an already-failed owner as active.
                    os.close(fd)
                    fd = -1
                    return
                # Windows cannot remove an open locked file; the gate prevents
                # readers from mistaking the close/unlink interval for a failure.
                if os.name == "nt":
                    os.close(fd)
                    fd = -1
                self._path.unlink()
                if fd >= 0:
                    os.close(fd)
                    fd = -1
                _sync_directory(self._root)
        finally:
            if fd >= 0:
                os.close(fd)


def require_resolved_spend() -> None:
    """Refuse abandoned receipts while allowing genuinely in-flight calls."""
    root = _directory()
    try:
        root.lstat()
    except FileNotFoundError:
        return
    except OSError as error:
        raise SpendAccountingUnresolved("Could not verify LLM spend accounting.") from error
    root = _ensure_directory()
    try:
        with _gate(root):
            _require_resolved_locked(root)
    except SpendAccountingUnresolved:
        raise
    except OSError as error:
        raise SpendAccountingUnresolved("Could not verify LLM spend accounting.") from error


@contextmanager
def complete_spend_snapshot() -> Iterator[None]:
    """Fence reporting against both active and abandoned receipts."""
    with ExitStack() as stack:
        try:
            root = _ensure_directory()
            stack.enter_context(_gate(root))
            pending = any(path.name != "lock" for path in root.iterdir())
        except OSError as error:
            raise SpendAccountingUnresolved("Could not verify LLM spend accounting.") from error
        if pending:
            raise SpendAccountingUnresolved("LLM spend accounting is pending or unresolved.")
        yield
