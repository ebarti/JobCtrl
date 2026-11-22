"""Publish a private project boundary for the generated Codex workspace.

Both Codex and the kit stop project-config discovery at this empty Git root.
The representation uses no Git executable and contains no commit or user data.
The process lock and directory rename keep concurrent SDK factories from seeing
partially initialized metadata. Unknown existing metadata is never replaced.
"""
from __future__ import annotations

import os
import shutil
import stat
import tempfile
from contextlib import contextmanager
from pathlib import Path

_FILES = {
    "HEAD": b"ref: refs/heads/jobctrl-runtime\n",
    "config": b"[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
}
_CHILDREN = {
    "": {"HEAD", "config", "objects", "refs"},
    "objects": set(),
    "refs": {"heads", "tags"},
    "refs/heads": set(),
    "refs/tags": set(),
}


def _redirects(info: os.stat_result) -> bool:
    # Directory junctions retain S_IFDIR on Windows. Python 3.11 supports the
    # reparse attribute even though Path.is_junction() requires Python 3.12.
    return stat.S_ISLNK(info.st_mode) or bool(
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    )


def reject_codex_path_redirection(path: Path) -> None:
    """Refuse redirected existing paths before auth enrollment or chmod."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if _redirects(info):
        raise RuntimeError("Codex workspace boundary must not redirect through a link or reparse point")


def _private_directory(path: Path) -> None:
    info = path.lstat()
    if _redirects(info) or not stat.S_ISDIR(info.st_mode):
        raise RuntimeError("Codex workspace boundary must be a regular directory")
    if os.name != "nt" and stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError("Codex workspace boundary must be private")


def _validate(root: Path) -> None:
    for relative, children in _CHILDREN.items():
        directory = root / relative
        _private_directory(directory)
        if {entry.name for entry in directory.iterdir()} != children:
            raise RuntimeError("Codex workspace has unfamiliar or incomplete Git metadata")
    for name, expected in _FILES.items():
        path = root / name
        info = path.lstat()
        if _redirects(info) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError("Codex workspace Git metadata must be a regular private file")
        if os.name != "nt" and stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeError("Codex workspace Git metadata must be private")
        if path.read_bytes() != expected:
            raise RuntimeError("Codex workspace has unfamiliar Git metadata")


@contextmanager
def _initialization_lock(workspace: Path):
    path = workspace / ".jobctrl-git.lock"
    reject_codex_path_redirection(path)
    if path.exists() or path.is_symlink():
        if not stat.S_ISREG(path.lstat().st_mode):
            raise RuntimeError("Codex workspace initialization lock is unsafe")
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    locked = False
    try:
        info = os.fstat(descriptor)
        if _redirects(info) or not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise RuntimeError("Codex workspace initialization lock is unsafe")
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            os.fchmod(descriptor, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX)
        locked = True
        yield
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


def ensure_codex_workspace_root(codex_home: Path, workspace: Path) -> None:
    """Create once or verify the exact generated root; preserve foreign state."""
    _private_directory(codex_home)
    _private_directory(workspace)
    if workspace.resolve().parent != codex_home.resolve():
        raise RuntimeError("Codex workspace must remain inside its isolated home")
    root = workspace / ".git"
    with _initialization_lock(workspace):
        reject_codex_path_redirection(root)
        if root.exists() or root.is_symlink():
            _validate(root)
            return
        staging = Path(tempfile.mkdtemp(prefix=".jobctrl-git-", dir=workspace))
        try:
            for relative in ("objects", "refs", "refs/heads", "refs/tags"):
                (staging / relative).mkdir(mode=0o700)
            for name, contents in _FILES.items():
                descriptor = os.open(staging / name, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "wb") as output:
                    output.write(contents)
            _validate(staging)
            # Cooperating initializers hold the same OS lock. Never publish over
            # metadata left by a different owner or a previous partial setup.
            if root.exists() or root.is_symlink():
                _validate(root)
            else:
                staging.rename(root)
            _validate(root)
        finally:
            if staging.exists():
                shutil.rmtree(staging)
