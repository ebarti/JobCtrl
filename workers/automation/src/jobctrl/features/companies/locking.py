"""Cross-process refresh exclusion without holding SQLite locks across I/O."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
import fcntl
import os
from pathlib import Path
import stat

from jobctrl.features.companies.domain import failure


@asynccontextmanager
async def company_lock(workspace: Path, company_id: str, *, cancelled=lambda: False):
    directory = workspace / "company-refresh-locks"
    descriptor = None
    locked = False
    try:
        directory.mkdir(mode=0o700, exist_ok=True)
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise failure("briefing_lock_unavailable", 409)
        descriptor = os.open(directory / company_id, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
            raise failure("briefing_lock_unavailable", 409)
        while True:
            if cancelled():
                raise failure("briefing_cancelled", 409)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except BlockingIOError:
                await asyncio.sleep(0.05)
        yield
    except OSError:
        raise failure("briefing_lock_unavailable", 409) from None
    finally:
        if descriptor is not None:
            if locked:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)


class CompanyRefreshLocks:
    """Adapter for the application's per-company exclusion port."""

    def __init__(self, workspace: Path):
        self._workspace = workspace

    def hold(self, company_id: str, *, cancelled):
        return company_lock(self._workspace, company_id, cancelled=cancelled)
