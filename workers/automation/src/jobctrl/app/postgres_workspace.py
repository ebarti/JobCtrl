"""Private workspace binding and explicit local PostgreSQL endpoint selection."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import os
import stat
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from typing import TypedDict
from uuid import UUID

from sqlalchemy.engine import URL, make_url
from sqlalchemy.exc import ArgumentError

from .errors import AppError

MARKER = '.jobctrl-postgres-identity'


class Marker(TypedDict):
    workspace_id: str
    database_id: str
    cluster_id: str
    database_oid: int
    pending_target: str | None


def endpoint(value: str | None) -> URL:
    value = value if value is not None else os.environ.get('JOBCTRL_DATABASE_URL')
    if not value:
        raise AppError('database_url_required', 'Select the local PostgreSQL database for this workspace.', 503)
    try:
        url = make_url(value)
        if url.drivername not in {'postgresql', 'postgresql+psycopg'} or not url.database:
            raise ValueError
        if url.database in {'postgres', 'template0', 'template1'}:
            raise ValueError
        query: dict[str, str] = {}
        for key, item in url.query.items():
            if key not in {'host', 'port', 'sslmode', 'connect_timeout', 'hostaddr'} or not isinstance(item, str):
                raise ValueError
            query[key] = item
        port = url.port or int(query.get('port', 5432))
        if not 0 < port < 65536 or (url.port is not None and 'port' in query):
            raise ValueError
        if url.host:
            if 'host' in query or ',' in url.host:
                raise ValueError
            address = ipaddress.ip_address('127.0.0.1' if url.host == 'localhost' else url.host)
            if not address.is_loopback or query.get('hostaddr', str(address)) != str(address):
                raise ValueError
            # libpq's hostaddr overrides host, including values from the process
            # environment. Pin the exact loopback address for all URL consumers.
            query['hostaddr'] = str(address)
        elif (not Path(query.get('host', '')).is_absolute() or ',' in query['host']
              or 'hostaddr' in query or os.environ.get('PGHOSTADDR')):
            raise ValueError
        if os.environ.get('PGSERVICE') or os.environ.get('PGSERVICEFILE'):
            raise ValueError
        query.setdefault('connect_timeout', '5')
        return url.set(drivername='postgresql+psycopg', query=query)
    except (ArgumentError, TypeError, ValueError, UnicodeError):
        raise AppError('invalid_database_url', 'Select one explicit local PostgreSQL endpoint and workspace database.', 409) from None


def pending_target(url: URL, database_oid: int, *, staging: bool) -> str:
    # The unpublished marker permits retry of only the original destination.
    # Never store credentials, including in a fingerprint of the connection URL.
    location = [url.query.get('host', url.query.get('hostaddr')), str(url.port or url.query.get('port', 5432)), url.database, database_oid, staging]
    return hashlib.sha256(json.dumps(location).encode()).hexdigest()


def has_source(workspace: Path) -> bool:
    return any(os.path.lexists(workspace / name) for name in ('jobctrl.db', 'jobctrl.db-wal', 'jobctrl.db-shm', 'jobctrl.db-journal'))


def workspace_path(workspace: Path | str, *, create: bool) -> Path:
    root = Path(workspace).expanduser()
    if root.is_symlink() or (root.exists() and not root.is_dir()):
        raise AppError('unsafe_workspace', 'The workspace must be a real directory.', 409)
    if create:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    return root.resolve()


def _private_descriptor(path: Path, *, create=False) -> int:
    flags = os.O_RDWR | os.O_CREAT if create else os.O_RDONLY
    fd = os.open(path, flags | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0), 0o600)
    try:
        info = os.fstat(fd)
        named = path.lstat()
        if (not stat.S_ISREG(info.st_mode) or not stat.S_ISREG(named.st_mode) or info.st_nlink != 1
                or (info.st_dev, info.st_ino) != (named.st_dev, named.st_ino)
                or (os.name != 'nt' and (info.st_uid != os.getuid() or info.st_mode & 0o077))):
            raise OSError('Unsafe workspace file')
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_marker(workspace: Path) -> Marker | None:
    try:
        with os.fdopen(_private_descriptor(workspace / MARKER), 'rb') as stream:
            marker = json.loads(stream.read(2049))
            if stream.read(1):
                raise ValueError
        if set(marker) != {'workspace_id', 'database_id', 'cluster_id', 'database_oid', 'pending_target'}:
            raise ValueError
        for key in ('workspace_id', 'database_id'):
            if str(UUID(marker[key])) != marker[key]:
                raise ValueError
        cluster_id = marker['cluster_id']
        if (not isinstance(cluster_id, str) or not 1 <= len(cluster_id) <= 20 or not cluster_id.isascii()
                or not cluster_id.isdecimal() or cluster_id != str(int(cluster_id)) or not 0 < int(cluster_id) < 2**64):
            raise ValueError
        if type(marker['database_oid']) is not int or not 0 < marker['database_oid'] < 2**32:
            raise ValueError
        if marker['pending_target'] is not None and (not isinstance(marker['pending_target'], str) or len(marker['pending_target']) != 64):
            raise ValueError
        return marker
    except FileNotFoundError:
        return None
    except (OSError, ValueError, TypeError, AttributeError):
        raise AppError('unsafe_database_identity', 'The workspace database identity must be a valid private file.', 409) from None


def verify_physical(marker: Marker, system_id: str | int, database_oid: int):
    if marker['cluster_id'] != str(system_id) or marker['database_oid'] != database_oid:
        raise AppError(
            'workspace_restore_mismatch',
            'This workspace is bound to another PostgreSQL database. Use the original database or the verified JobCtrl recovery path.',
            409,
        )


def write_marker(workspace: Path, marker: Marker) -> None:
    fd, name = tempfile.mkstemp(prefix='.jobctrl-pg-binding-', dir=workspace)
    stage = Path(name)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(json.dumps(marker, sort_keys=True).encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(stage, workspace / MARKER)
        if os.name != 'nt':
            directory = os.open(workspace, os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        stage.unlink(missing_ok=True)


@contextmanager
def initialization_lock(workspace: Path):
    try:
        fd = _private_descriptor(workspace / '.jobctrl-database.lock', create=True)
    except OSError:
        raise AppError('unsafe_database_lock', 'The workspace initializer lock must be a private regular file.', 409) from None
    try:
        deadline = time.monotonic() + 30
        while True:
            try:
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise AppError('database_initializer_busy', 'Another process is initializing this workspace.', 409) from None
                time.sleep(0.05)
        yield
    finally:
        os.close(fd)
