"""Process custody for one durable action; heartbeat expiry never steals it."""

from __future__ import annotations

import asyncio
import hashlib
import os
import stat
from pathlib import Path

from jobctrl.app.errors import AppError


class ExecutionCustody:
    def __init__(self, workspace: Path, run_id: str):
        directory = workspace / ".action-custody"
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode)
                or (os.name != "nt" and (info.st_uid != os.getuid() or info.st_mode & 0o077))):
            raise AppError("unsafe_action_custody", "Action custody requires a private directory.", 409)
        self.path = directory / (hashlib.sha256(run_id.encode()).hexdigest() + ".lock")
        try:
            self.descriptor = os.open(self.path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        except OSError:
            raise AppError("unsafe_action_custody", "The action custody file is unavailable.", 409) from None
        self.held = False
        os.set_inheritable(self.descriptor, False)
        info = os.fstat(self.descriptor)
        self.identity = (info.st_dev, info.st_ino)
        if not self._valid():
            os.close(self.descriptor)
            raise AppError("unsafe_action_custody", "The action custody file must be private and unchanged.", 409)

    def _valid(self):
        try:
            info, named = os.fstat(self.descriptor), self.path.lstat()
        except OSError:
            return False
        return (stat.S_ISREG(info.st_mode) and stat.S_ISREG(named.st_mode) and info.st_nlink == 1
                and (info.st_dev, info.st_ino) == self.identity == (named.st_dev, named.st_ino)
                and (os.name == "nt" or (info.st_uid == os.getuid() and not info.st_mode & 0o077)))

    @property
    def owned(self):
        return self.held and self._valid()

    def try_acquire(self):
        if not self._valid():
            raise AppError("action_custody_changed", "Action custody changed; inspect the retained run.", 409)
        if self.held:
            return True
        try:
            if os.name == "nt":
                import msvcrt
                os.lseek(self.descriptor, 0, os.SEEK_SET)
                msvcrt.locking(self.descriptor, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (BlockingIOError, PermissionError):
            return False
        self.held = True
        if not self._valid():
            raise AppError("action_custody_changed", "Action custody changed; inspect the retained run.", 409)
        return True

    async def acquire(self, cancelled):
        while not self.try_acquire():
            if cancelled():
                raise asyncio.CancelledError()
            await asyncio.sleep(0.1)

    def close(self):
        try:
            if self.held:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(self.descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(self.descriptor, msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(self.descriptor, fcntl.LOCK_UN)
        finally:
            self.held = False
            os.close(self.descriptor)
