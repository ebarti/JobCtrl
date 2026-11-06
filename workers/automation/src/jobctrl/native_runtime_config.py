"""Workspace paths and atomic private browser-choice JSON; no business settings.

Application settings belong to app.settings. This small native adapter retains
only browser executable/profile-copy metadata in its existing local JSON file.
"""

from __future__ import annotations

import json
import os
import stat
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path


class ConfigFileError(RuntimeError):
    """The native metadata file cannot be read or replaced safely."""


def workspace_path(explicit: Path | str | None = None) -> Path:
    selected = Path(explicit) if explicit is not None else Path(os.environ.get("JOBCTRL_DIR", "~/.jobctrl"))
    return selected.expanduser().absolute()


def get_config_path(*, app_dir: Path | None = None) -> Path:
    return workspace_path(app_dir) / "config.json"


def get_env_path(*, app_dir: Path | None = None) -> Path:
    from jobctrl.runtime import owned_env_path
    return owned_env_path(app_dir=workspace_path(app_dir))


def _private(descriptor: int, path: Path):
    info, named = os.fstat(descriptor), path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)
            or (os.name != "nt" and (info.st_uid != os.getuid() or info.st_mode & 0o077))):
        raise ConfigFileError("Native metadata must be an owner-private regular file.")
    return info


def _strict_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("Duplicate metadata field")
        value[key] = item
    return value


def load_config_file(*, path: Path | str | None = None, app_dir: Path | None = None, strict=False) -> dict:
    if path is not None and app_dir is not None:
        raise ValueError("path and app_dir are mutually exclusive")
    target = Path(path).expanduser() if path is not None else get_config_path(app_dir=app_dir)
    try:
        descriptor = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            _private(descriptor, target)
            with os.fdopen(descriptor, "r", encoding="utf-8", closefd=False) as stream:
                encoded = stream.read(1024 * 1024 + 1)
            if len(encoded.encode()) > 1024 * 1024:
                raise ValueError("Native metadata exceeds its size limit")
            value = json.loads(encoded, object_pairs_hook=_strict_object)
            if not isinstance(value, dict):
                raise ValueError("Native metadata must be an object")
            return value
        finally:
            os.close(descriptor)
    except FileNotFoundError:
        return {}
    except (OSError, UnicodeError, ValueError, ConfigFileError):
        if strict:
            raise ConfigFileError("Native browser metadata cannot be read safely.") from None
        return {}


@contextmanager
def edit_config_file(*, app_dir: Path):
    root = workspace_path(app_dir)
    if root.is_symlink():
        raise ConfigFileError("Native metadata workspace cannot be a symlink.")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = root / "config.json"
    lock = root / ".browser-capabilities.lock"
    descriptor = os.open(lock, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    locked = False
    try:
        _private(descriptor, lock)
        if os.name == "nt" and os.fstat(descriptor).st_size == 0:
            os.write(descriptor, b"\0")
            os.fsync(descriptor)
        deadline = time.monotonic() + 30
        while not locked:
            try:
                if os.name == "nt":
                    import msvcrt
                    os.lseek(descriptor, 0, os.SEEK_SET)
                    msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
            except OSError:
                if time.monotonic() >= deadline:
                    raise ConfigFileError("Another process is updating browser choices.") from None
                time.sleep(.02)
        _private(descriptor, lock)
        value = load_config_file(path=target, strict=True)
        yield value
        fd, name = tempfile.mkstemp(prefix=".browser-choices-", dir=root)
        temporary = Path(name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(value, stream, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            if target.exists() or target.is_symlink():
                current = os.open(target, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
                try:
                    _private(current, target)
                finally:
                    os.close(current)
            os.replace(temporary, target)
            if os.name != "nt":
                directory = os.open(root, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            temporary.unlink(missing_ok=True)
    except OSError:
        raise ConfigFileError("Native browser choices could not be changed safely.") from None
    finally:
        if locked:
            if os.name == "nt":
                import msvcrt
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)
