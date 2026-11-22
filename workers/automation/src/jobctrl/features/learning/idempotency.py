"""Cross-process ownership for an exact Learning request identity."""

from contextlib import contextmanager
import fcntl
import hashlib
import os
import stat

from jobctrl.app.errors import AppError


def operation_id(key):
    if not isinstance(key, str) or not key.strip() or len(key) > 200:
        raise AppError("invalid_idempotency_key", "Use a nonempty idempotency key of at most 200 characters.")
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


@contextmanager
def request_lock(workspace, identity):
    root = workspace / ".learning-request-locks"
    fd = None
    try:
        root.mkdir(mode=0o700, exist_ok=True)
        info = root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise AppError("learning_request_lock_unavailable", "The learning request cannot be safely resumed.", 503)
        fd = os.open(root / identity, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
            raise AppError("learning_request_lock_unavailable", "The learning request cannot be safely resumed.", 503)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AppError("learning_request_in_progress", "This learning request is still running; retry the same request.", 409) from None
    except OSError:
        if fd is not None:
            os.close(fd)
        raise AppError("learning_request_lock_unavailable", "The learning request cannot be safely resumed.", 503) from None
    except BaseException:
        if fd is not None:
            os.close(fd)
        raise
    try:
        yield
    finally:
        os.close(fd)
